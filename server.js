import express from 'express';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createServer } from 'http';
import { computeCost } from './pricing.js';
import { runAnalysis } from './analysis.js';
import { runLLMAnalysis } from './llm-analysis.js';
import { previewActuator, commitActuator } from './actuators.js';
import { buildExcelExport, collectContextFiles, makeExportFilename } from './excel-export.js';

// HOST_HOME is set by Docker to the mounted home dir path.
// Falls back to os.homedir() for local dev.
const HOME = process.env.HOST_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const PORT = Number(process.env.PORT || 4317);

// ---------- Parsers ----------

// Derive a human-readable project label from a (possibly mangled) path.
// Handles Claude Code worktree paths like:
//   /Users/.../openclaw/manager/claude/worktrees/dazzling/germain/3d3bc4
// → "openclaw-manager  [dazzling-germain]"
function deriveProjectLabel(rawPath) {
  if (!rawPath || rawPath === 'unknown') return rawPath || 'unknown';
  const p = rawPath.replace(/\/+/g, '/');
  const wtMatch = p.match(/^(.+?)\/claude\/worktrees\/([^/]+)\/([^/]+)\/[0-9a-f]{6,}$/);
  if (wtMatch) {
    const root = wtMatch[1].split('/').filter(Boolean).slice(-2).join('-');
    const branch = `${wtMatch[2]}-${wtMatch[3]}`;
    return `${root}  [${branch}]`;
  }
  // Regular path — last meaningful segment
  return p.split('/').filter(Boolean).pop() || p;
}

function deriveName(text) {
  if (!text) return null;
  // Strip leading instruction wrappers and decorative markdown
  let t = String(text)
    .replace(/<[^>]+>/g, ' ')          // strip XML-ish tags
    .replace(/```[\s\S]*?```/g, ' ')   // strip code fences
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
  // Remove leading markdown headers like "# AGENTS.md instructions ..."
  t = t.replace(/^#+\s*/, '');
  if (t.length > 100) t = t.slice(0, 97).trim() + '…';
  return t || null;
}

function looksLikeInstructions(text) {
  if (!text) return true;
  const s = String(text).slice(0, 500);
  return /AGENTS\.md|<INSTRUCTIONS>|<system-reminder>|<command-name>|<command-message>|<command-args>/i.test(s);
}

function parseClaudeSession(file) {
  const stat = fs.statSync(file);
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  let firstTs = null, lastTs = null, msgCount = 0, model = null;
  let name = null;
  let projectDir = path.basename(path.dirname(file));
  // Decode project dir: "-Users-foo-bar" -> "/Users/foo/bar"
  const decodedProject = projectDir.replace(/^-/, '/').replace(/-/g, '/');
  const sessionId = path.basename(file, '.jsonl');

  try {
    const data = fs.readFileSync(file, 'utf8');
    const lines = data.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp;
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }
        const msg = obj.message;
        if (msg && typeof msg === 'object') {
          msgCount++;
          if (msg.model) model = msg.model;
          const u = msg.usage;
          if (u) {
            input += u.input_tokens || 0;
            output += u.output_tokens || 0;
            cacheRead += u.cache_read_input_tokens || 0;
            cacheCreate += u.cache_creation_input_tokens || 0;
          }
          if (!name && msg.role === 'user') {
            let text = null;
            if (typeof msg.content === 'string') text = msg.content;
            else if (Array.isArray(msg.content)) {
              const txt = msg.content.find(c => c.type === 'text');
              if (txt) text = txt.text;
            }
            if (text && !looksLikeInstructions(text)) name = deriveName(text);
          }
        }
      } catch {}
    }
  } catch {
    return null;
  }

  const cost = computeCost({ input, output, cacheRead, cacheCreate }, model);
  return {
    source: 'claude',
    id: sessionId,
    name: name || `session ${sessionId.slice(0, 8)}`,
    project: decodedProject,
    projectLabel: deriveProjectLabel(decodedProject),
    file,
    model,
    input, output, cacheRead, cacheCreate,
    total: input + output + cacheRead + cacheCreate,
    cost,
    messages: msgCount,
    firstTs, lastTs,
    mtime: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

function parseCodexSession(file) {
  const stat = fs.statSync(file);
  let firstTs = null, lastTs = null;
  let project = null, sessionId = null, model = null;
  let name = null;
  let total = { input: 0, cachedInput: 0, output: 0, reasoning: 0, totalTokens: 0 };
  let last = null;
  let usagePoints = 0;

  try {
    const data = fs.readFileSync(file, 'utf8');
    const lines = data.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp;
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }
        if (obj.type === 'session_meta') {
          const p = obj.payload || {};
          project = p.cwd || project;
          sessionId = p.id || sessionId;
        }
        if (obj.type === 'turn_context' && obj.payload?.model) {
          model = obj.payload.model;
        }
        if (!name && obj.type === 'response_item') {
          const p = obj.payload;
          if (p?.type === 'message' && p?.role === 'user' && Array.isArray(p.content)) {
            const txt = p.content.find(c => c.type === 'input_text');
            if (txt && !looksLikeInstructions(txt.text)) name = deriveName(txt.text);
          }
        }
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload.info) {
          const tt = obj.payload.info.total_token_usage;
          if (tt) {
            total = {
              input: tt.input_tokens || 0,
              cachedInput: tt.cached_input_tokens || 0,
              output: tt.output_tokens || 0,
              reasoning: tt.reasoning_output_tokens || 0,
              totalTokens: tt.total_tokens || 0,
            };
            usagePoints++;
          }
          last = obj.payload.info.last_token_usage || last;
        }
      } catch {}
    }
  } catch {
    return null;
  }

  const freshInput = Math.max(0, total.input - total.cachedInput);
  const cost = computeCost({
    input: freshInput,
    output: total.output,
    cacheRead: total.cachedInput,
    cacheCreate: 0,
  }, model);
  const finalId = sessionId || path.basename(file, '.jsonl');
  const finalProject = project || 'unknown';
  return {
    source: 'codex',
    id: finalId,
    name: name || `session ${finalId.slice(0, 8)}`,
    project: finalProject,
    projectLabel: deriveProjectLabel(finalProject),
    file,
    model,
    input: freshInput,
    output: total.output,
    cacheRead: total.cachedInput,
    cacheCreate: 0,
    reasoning: total.reasoning,
    total: total.totalTokens,
    cost,
    messages: usagePoints,
    firstTs, lastTs,
    mtime: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

function listJsonlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

// Per-file parse cache: avoids re-reading unchanged files.
// Key = absolute path, value = { mtime, sizeBytes, session }.
const parseCache = new Map();

function scanAll() {
  const files = [
    ...listJsonlFiles(CLAUDE_DIR).map(f => ({ f, src: 'claude' })),
    ...listJsonlFiles(CODEX_DIR).map(f => ({ f, src: 'codex' })),
  ];
  const activeFiles = new Set(files.map(x => x.f));
  const sessions = [];
  let reparsed = 0, reused = 0;

  for (const { f, src } of files) {
    try {
      const stat = fs.statSync(f);
      const cached = parseCache.get(f);
      if (cached && cached.mtime === stat.mtimeMs && cached.sizeBytes === stat.size) {
        if (cached.session) sessions.push(cached.session);
        reused++;
      } else {
        const s = src === 'claude' ? parseClaudeSession(f) : parseCodexSession(f);
        parseCache.set(f, { mtime: stat.mtimeMs, sizeBytes: stat.size, session: s });
        if (s) sessions.push(s);
        reparsed++;
      }
    } catch {
      parseCache.delete(f);
    }
  }

  // Evict deleted files
  for (const key of parseCache.keys()) {
    if (!activeFiles.has(key)) parseCache.delete(key);
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  if (reparsed > 0) {
    console.log(`  [scan] ${reparsed} reparsed · ${reused} from cache · ${parseCache.size} total`);
  }
  return sessions;
}

function summarize(sessions) {
  const sum = (s, key) => s.reduce((a, x) => a + (x[key] || 0), 0);
  const sumCost = (s, key) => s.reduce((a, x) => a + ((x.cost && x.cost[key]) || 0), 0);
  const aggregate = (arr) => ({
    sessions: arr.length,
    input: sum(arr, 'input'),
    output: sum(arr, 'output'),
    cacheRead: sum(arr, 'cacheRead'),
    cacheCreate: sum(arr, 'cacheCreate'),
    total: sum(arr, 'total'),
    cost: {
      input: sumCost(arr, 'input'),
      output: sumCost(arr, 'output'),
      cacheRead: sumCost(arr, 'cacheRead'),
      cacheCreate: sumCost(arr, 'cacheCreate'),
      total: sumCost(arr, 'total'),
    },
  });
  return {
    totals: aggregate(sessions),
    claude: aggregate(sessions.filter(s => s.source === 'claude')),
    codex: aggregate(sessions.filter(s => s.source === 'codex')),
  };
}

// ---------- Server ----------

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

let cache = { sessions: [], summary: null, ts: 0 };
let cacheVersion = 0;

// Lightweight fingerprint for change detection — bytes saved on the wire.
function sessionSig(s) {
  return `${s.mtime}|${s.sizeBytes}|${s.total}`;
}

function refresh() {
  const sessions = scanAll();
  cache = {
    sessions,
    summary: summarize(sessions),
    ts: Date.now(),
  };
  cacheVersion++;
  return cache;
}

// Bandwidth telemetry — surfaced in the footer.
const wireStats = {
  fullSent: 0,
  patchSent: 0,
  fullBytes: 0,
  patchBytes: 0,
  start: Date.now(),
};

let lastSessionsBySig = new Map(); // sessionId -> sig (for last broadcast)

function buildCachePatch() {
  const next = new Map();
  const added = [];
  const updated = [];
  for (const s of cache.sessions) {
    const sig = sessionSig(s);
    next.set(s.id, sig);
    const prev = lastSessionsBySig.get(s.id);
    if (!prev) added.push(s);
    else if (prev !== sig) updated.push(s);
  }
  const removed = [];
  for (const id of lastSessionsBySig.keys()) {
    if (!next.has(id)) removed.push(id);
  }
  lastSessionsBySig = next;
  return { added, updated, removed };
}

refresh();
for (const s of cache.sessions) lastSessionsBySig.set(s.id, sessionSig(s));

app.use(express.static('public'));

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/api/data', (req, res) => {
  res.json(cache);
});

app.get('/api/refresh', (req, res) => {
  res.json(refresh());
});

// ---------- Analysis (scheduled every 2h) ----------

const ANALYSIS_DIR = path.join(HOME, '.agent-optimization');
const ANALYSIS_LATEST = path.join(ANALYSIS_DIR, 'analysis-latest.json');
const APPLIED_FILE = path.join(ANALYSIS_DIR, 'applied.json');
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

let analysisCache = null;
let applied = {}; // key: `${project}::${findingId}` -> { appliedAt, baseline, realized }

function appliedKey(project, findingId) { return `${project}::${findingId}`; }

function loadApplied() {
  try {
    if (fs.existsSync(APPLIED_FILE)) {
      applied = JSON.parse(fs.readFileSync(APPLIED_FILE, 'utf8'));
    }
  } catch { applied = {}; }
}
function saveApplied() {
  ensureAnalysisDir();
  fs.writeFileSync(APPLIED_FILE, JSON.stringify(applied, null, 2));
}

function ensureAnalysisDir() {
  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}

function loadPersistedAnalysis() {
  try {
    if (fs.existsSync(ANALYSIS_LATEST)) {
      analysisCache = JSON.parse(fs.readFileSync(ANALYSIS_LATEST, 'utf8'));
    }
  } catch {}
}

function saveAnalysis(report) {
  ensureAnalysisDir();
  fs.writeFileSync(ANALYSIS_LATEST, JSON.stringify(report, null, 2));
  // Keep history
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(ANALYSIS_DIR, `analysis-${stamp}.json`), JSON.stringify(report));
}

function reconcileApplied(report) {
  // For each applied finding: compute realized savings vs the baseline by
  // comparing the current wasted cost for that project+finding.
  const realizedEvents = [];
  for (const [key, entry] of Object.entries(applied)) {
    const { project, findingId } = (() => {
      const idx = key.indexOf('::');
      return { project: key.slice(0, idx), findingId: key.slice(idx + 2) };
    })();
    const proj = report.projects.find(p => p.project === project);
    const current = proj?.findings.find(f => f.id === findingId);
    const currentWasted =
      current?.metric?.wastedCost ?? current?.metric?.savings ?? current?.metric?.cost ?? 0;
    const baseline = entry.baseline.wastedCost || 0;
    const saved = Math.max(0, baseline - currentWasted);
    const prevSaved = entry.realized?.savedCost || 0;

    entry.realized = {
      savedCost: saved,
      baselineCost: baseline,
      currentCost: currentWasted,
      lastChecked: report.generatedAt,
    };
    if (current) {
      entry.realized.currentExamples = current.examples?.length || 0;
      entry.realized.severity = current.severity;
    } else {
      entry.realized.resolved = true;
    }

    if (saved - prevSaved > 0.01) {
      realizedEvents.push({
        project,
        findingId,
        previousSavedCost: prevSaved,
        savedCost: saved,
        delta: saved - prevSaved,
        baselineCost: baseline,
        currentCost: currentWasted,
        resolved: !current,
      });
    }

    // Also annotate the report so UI can show "Applied" state per finding
    if (current) {
      current.applied = {
        appliedAt: entry.appliedAt,
        baselineCost: baseline,
        realizedSavedCost: saved,
        resolved: false,
      };
    } else if (proj) {
      // Finding no longer present in this project — synthesize a "resolved" entry
      proj.findings.push({
        id: findingId,
        title: entry.baseline.title || findingId,
        severity: 'low',
        summary: 'Previously flagged. No longer triggering on the latest scan.',
        impact: 'Resolved.',
        recommendation: 'Keep doing what you changed.',
        examples: [],
        metric: { wastedCost: 0 },
        applied: {
          appliedAt: entry.appliedAt,
          baselineCost: baseline,
          realizedSavedCost: saved,
          resolved: true,
        },
      });
    }
  }
  saveApplied();
  return realizedEvents;
}

// Hash a project block so we only ship changed projects on update.
function projectFingerprint(p) {
  const f = p.findings.map(x => `${x.id}:${x.severity}:${(x.metric?.wastedCost ?? x.metric?.savings ?? x.metric?.cost ?? 0).toFixed(4)}:${x.applied?.appliedAt || ''}:${x.applied?.realizedSavedCost?.toFixed(4) || ''}`).join('|');
  return `${p.sessionCount}|${p.totalCost.toFixed(4)}|${p.wastedCost.toFixed(4)}|${f}`;
}

let lastProjectFingerprints = new Map();

function buildAnalysisPatch(report) {
  const next = new Map();
  const changed = [];
  for (const p of report.projects) {
    const fp = projectFingerprint(p);
    next.set(p.project, fp);
    if (lastProjectFingerprints.get(p.project) !== fp) changed.push(p);
  }
  const removed = [];
  for (const k of lastProjectFingerprints.keys()) {
    if (!next.has(k)) removed.push(k);
  }
  lastProjectFingerprints = next;
  return { changed, removed };
}

async function generateAnalysis() {
  // cache.sessions is kept current by the file watcher — no full re-scan needed.
  const report = runAnalysis(cache.sessions);
  report.nextRunAt = new Date(Date.now() + TWO_HOURS_MS).toISOString();

  // LLM enrichment — replace heuristic findings with GPT analysis when configured.
  // Sends aggregated stats only; falls back to heuristics when OPENAI_API_KEY is absent.
  {
    const sessionsByProject = new Map();
    for (const s of cache.sessions) {
      const key = (s.project || 'unknown').replace(/\/+/g, '/').replace(/\/$/, '');
      if (!sessionsByProject.has(key)) sessionsByProject.set(key, []);
      sessionsByProject.get(key).push(s);
    }
    const llmResults = await runLLMAnalysis(report.projects, sessionsByProject);
    const llmMeta = llmResults.__meta || {};
    let llmProjectCount = 0;
    for (const proj of report.projects) {
      const r = llmResults[proj.project];
      if (r && !r.skipped && !r.error && r.findings?.length >= 0) {
        proj.findings = r.findings;
        proj.llmAnalyzed = !r.fromCache;
        proj.llmCached = !!r.fromCache;
        proj.llmModel = llmMeta.model;
        llmProjectCount++;
        // Recalculate wastedCost from normalized LLM finding metrics.
        proj.wastedCost = proj.findings.reduce((a, f) => {
          return a + (f.metric?.wastedCost ?? f.metric?.savings ?? f.metric?.cost ?? 0);
        }, 0);
      }
    }
    report.projects.sort((a, b) => b.wastedCost - a.wastedCost);
    report.llmPowered = !!llmMeta.enabled && llmProjectCount > 0;
    report.llmProvider = llmMeta.enabled ? 'openai' : null;
    report.llmModel = llmMeta.model;
  }

  const realized = reconcileApplied(report);
  report.applied = applied;
  analysisCache = report;
  saveAnalysis(report);

  // Send a delta to existing clients, full to nothing — clients pull /api/analysis on first view.
  const { changed, removed } = buildAnalysisPatch(report);
  if (changed.length || removed.length) {
    const msg = {
      type: 'analysis-patch',
      generatedAt: report.generatedAt,
      nextRunAt: report.nextRunAt,
      summary: report.summary,
      applied: report.applied,
      changedProjects: changed,
      removedProjects: removed,
    };
    const payload = JSON.stringify(msg);
    wireStats.patchSent++;
    wireStats.patchBytes += payload.length;
    const fullSize = JSON.stringify({ type: 'analysis', analysis: report }).length;
    wireStats.fullBytes += fullSize;
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }
  if (realized.length) {
    const payload2 = JSON.stringify({ type: 'savings-realized', events: realized });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload2);
    }
  }
  return report;
}

app.get('/api/analysis', (req, res) => {
  if (!analysisCache) generateAnalysis();
  res.json(analysisCache);
});

app.post('/api/analysis/run', async (req, res) => {
  res.json(await generateAnalysis());
});

app.use(express.json());

// In-memory plans created by /preview, keyed by token, awaiting /apply confirm.
const pendingPlans = new Map();
function newToken() {
  return 'plan_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function findFindingProject(project, findingId) {
  const proj = analysisCache?.projects.find(p => p.project === project);
  const finding = proj?.findings.find(f => f.id === findingId);
  return { proj, finding };
}

function getProjectSessions(project) {
  return cache.sessions.filter(s => {
    const k = (s.project || '').replace(/\/+/g, '/').replace(/\/$/, '');
    return k === project;
  });
}

// Step 1: dry-run preview
app.post('/api/analysis/preview', (req, res) => {
  const { project, findingId } = req.body || {};
  if (!project || !findingId) return res.status(400).json({ error: 'missing project or findingId' });
  const { finding } = findFindingProject(project, findingId);
  if (!finding) return res.status(404).json({ error: 'finding not found' });

  const sessions = getProjectSessions(project);
  let plan;
  try {
    plan = previewActuator(findingId, project, sessions);
  } catch (e) {
    return res.status(500).json({ error: 'preview failed', detail: String(e) });
  }

  const baseWasted =
    finding.metric?.wastedCost ?? finding.metric?.savings ?? finding.metric?.cost ?? 0;

  if (!plan.actionable) {
    return res.json({
      actionable: false,
      behavioral: !!plan.behavioral,
      reason: plan.reason,
      finding: { id: findingId, title: finding.title },
      projectedSavings: baseWasted,
    });
  }

  // Strip _commit fn before sending; keep on server in pendingPlans
  const token = newToken();
  pendingPlans.set(token, { plan, project, findingId, finding, baseWasted, createdAt: Date.now() });
  // Garbage-collect plans older than 10 min
  for (const [k, v] of pendingPlans) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) pendingPlans.delete(k);
  }
  res.json({
    actionable: true,
    token,
    finding: { id: findingId, title: finding.title },
    summary: plan.summary,
    changes: plan.changes,
    projectedSavings: baseWasted,
  });
});

// Step 2: actually apply (requires preview token)
app.post('/api/analysis/apply', (req, res) => {
  const { token, project: bodyProject, findingId: bodyFinding } = req.body || {};

  let project, findingId, finding, baseWasted, plan;
  if (token) {
    const pending = pendingPlans.get(token);
    if (!pending) return res.status(404).json({ error: 'plan expired or not found' });
    ({ project, findingId, finding, baseWasted, plan } = pending);
    pendingPlans.delete(token);
  } else {
    // Token-less = behavioral apply (tracking only)
    project = bodyProject;
    findingId = bodyFinding;
    if (!project || !findingId) return res.status(400).json({ error: 'missing project or findingId' });
    const f = findFindingProject(project, findingId);
    finding = f.finding;
    if (!finding) return res.status(404).json({ error: 'finding not found' });
    baseWasted =
      finding.metric?.wastedCost ?? finding.metric?.savings ?? finding.metric?.cost ?? 0;
    plan = null;
  }

  let commitResult = null;
  if (plan) {
    try {
      commitResult = commitActuator(plan);
    } catch (e) {
      return res.status(500).json({ error: 'commit failed', detail: String(e) });
    }
  }

  const key = appliedKey(project, findingId);
  applied[key] = {
    appliedAt: new Date().toISOString(),
    project,
    findingId,
    actuated: !!plan,
    actuation: commitResult,
    baseline: {
      title: finding.title,
      wastedCost: baseWasted,
      sessionIds: (finding.examples || []).map(e => e.sessionId).filter(Boolean),
      severity: finding.severity,
    },
    realized: { savedCost: 0, baselineCost: baseWasted, currentCost: baseWasted, lastChecked: null },
  };
  saveApplied();
  finding.applied = {
    appliedAt: applied[key].appliedAt,
    baselineCost: baseWasted,
    realizedSavedCost: 0,
    resolved: false,
    actuated: !!plan,
  };

  res.json({
    ok: true,
    actuated: !!plan,
    actuation: commitResult,
    projectedSavings: baseWasted,
    appliedAt: applied[key].appliedAt,
    finding: { id: findingId, title: finding.title },
  });
});

app.post('/api/analysis/unapply', (req, res) => {
  const { project, findingId } = req.body || {};
  delete applied[appliedKey(project, findingId)];
  saveApplied();
  res.json({ ok: true });
});

app.get('/api/analysis/applied', (req, res) => {
  res.json(applied);
});

// -------- Charts data --------

app.get('/api/charts/usage', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const now = new Date();
  const buckets = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets[key] = {
      date: key,
      claude: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, cost: 0, sessions: 0 },
      codex:  { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, cost: 0, sessions: 0 },
    };
  }
  for (const s of cache.sessions) {
    const ts = s.lastTs || s.firstTs;
    if (!ts) continue;
    const key = ts.slice(0, 10);
    if (!buckets[key]) continue;
    const b = buckets[key][s.source];
    if (!b) continue;
    b.input     += s.input     || 0;
    b.output    += s.output    || 0;
    b.cacheRead += s.cacheRead || 0;
    b.cacheCreate += s.cacheCreate || 0;
    b.total     += s.total     || 0;
    b.cost      += s.cost?.total || 0;
    b.sessions  += 1;
  }
  const sorted = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
  res.json({ days: sorted });
});

app.get('/api/charts/context-files', (req, res) => {
  const contextFiles = collectContextFiles(HOME, cache.sessions);
  res.json({
    claude: contextFiles.claude,
    codex: contextFiles.codex,
  });
});

function wireStatsSnapshot() {
  const sentBytes = wireStats.fullSent === 0 ? wireStats.patchBytes :
    /* fullSent represents init payloads to clients, patchBytes is delta traffic */
    wireStats.patchBytes + (wireStats.fullSent > 1 ? 0 : 0);
  return {
    patchSent: wireStats.patchSent,
    fullSent: wireStats.fullSent,
    patchBytes: wireStats.patchBytes,
    wouldHaveBeenBytes: wireStats.fullBytes,
    initBytes: wireStats.fullSent ? Math.round(wireStats.fullBytes / Math.max(wireStats.fullSent, 1)) : 0,
    savedBytes: Math.max(0, wireStats.fullBytes - wireStats.patchBytes),
    savedPct: wireStats.fullBytes > 0 ? (1 - wireStats.patchBytes / wireStats.fullBytes) : 0,
    uptimeSec: Math.round((Date.now() - wireStats.start) / 1000),
    sentBytes,
  };
}

app.get('/api/wirestats', (req, res) => {
  res.json(wireStatsSnapshot());
});

app.get('/api/export.xlsx', (req, res) => {
  try {
    refresh();
    const generatedAt = new Date();
    const report = analysisCache || runAnalysis(cache.sessions);
    const buffer = buildExcelExport({
      cache,
      analysis: report,
      applied,
      contextFiles: collectContextFiles(HOME, cache.sessions),
      wireStats: wireStatsSnapshot(),
      home: HOME,
      generatedAt,
    });
    const filename = makeExportFilename(generatedAt);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (e) {
    console.error('[export] failed', e);
    res.status(500).json({ error: 'export failed', detail: String(e) });
  }
});

loadApplied();
loadPersistedAnalysis();
// Run on startup if older than 2h or missing
const lastRun = analysisCache ? new Date(analysisCache.generatedAt).getTime() : 0;
if (Date.now() - lastRun > TWO_HOURS_MS) {
  generateAnalysis();
} else {
  console.log(`  Analysis: using cached report from ${analysisCache.generatedAt}`);
}
setInterval(generateAnalysis, TWO_HOURS_MS);

function broadcast() {
  refresh();
  const { added, updated, removed } = buildCachePatch();
  if (added.length === 0 && updated.length === 0 && removed.length === 0) return;
  const msg = {
    type: 'cache-patch',
    version: cacheVersion,
    ts: cache.ts,
    summary: cache.summary, // small (~few KB) — always included so client doesn't recompute
    added, updated, removed,
  };
  const payload = JSON.stringify(msg);
  wireStats.patchSent++;
  wireStats.patchBytes += payload.length;
  // For comparison: what a full broadcast would have cost
  const fullSize = JSON.stringify({ type: 'update', cache }).length;
  wireStats.fullBytes += fullSize;
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on('connection', (ws) => {
  const payload = JSON.stringify({ type: 'init', cache, version: cacheVersion });
  wireStats.fullSent++;
  wireStats.fullBytes += payload.length;
  ws.send(payload);
});

// Watch both dirs
let debounce;
const debounced = () => {
  clearTimeout(debounce);
  debounce = setTimeout(broadcast, 800);
};

// Docker on Mac doesn't propagate inotify events through the FUSE layer,
// so we fall back to polling when USE_POLLING=true (set in docker-compose).
const usePolling = process.env.USE_POLLING === 'true';
const watcher = chokidar.watch([CLAUDE_DIR, CODEX_DIR], {
  ignoreInitial: true,
  persistent: true,
  usePolling,
  interval: usePolling ? 3000 : undefined,
  awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 300 },
});
watcher.on('add', debounced).on('change', debounced).on('unlink', debounced);

httpServer.listen(PORT, () => {
  console.log(`\n  ✦ Agent Optimization Dashboard`);
  console.log(`  ✦ http://localhost:${PORT}\n`);
  console.log(`  Watching:`);
  console.log(`    Claude: ${CLAUDE_DIR}`);
  console.log(`    Codex:  ${CODEX_DIR}\n`);
});
