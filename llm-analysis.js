// LLM-powered analysis using Claude Code's OAuth session.
// Shells out to the bundled claude.exe binary — no API key required.
// Uses the same Max subscription auth as the CLI.

import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = process.env.HOST_HOME || os.homedir();
const CACHE_FILE = path.join(HOME, '.agent-optimization', 'llm-cache.json');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONCURRENT = 4;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// Resolve bundled claude binary
const require = createRequire(import.meta.url);
const CLAUDE_BIN = (() => {
  try {
    return require.resolve('@anthropic-ai/claude-code/bin/claude.exe');
  } catch {
    return process.env.CLAUDE_BIN || 'claude';
  }
})();

// ---------- File-based cache ----------

let llmCache = {};
function loadCache() {
  try { llmCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { llmCache = {}; }
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(llmCache, null, 2));
  } catch {}
}
loadCache();

function projectFingerprint(proj) {
  const c = proj.cost?.total || 0;
  return `${proj.sessionCount}|${Math.round((proj.total || 0) / 1e6)}|${c.toFixed(1)}`;
}

// ---------- Prompt ----------

const fmtM = n => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
};
const money = n => '$' + (Number(n) || 0).toFixed(2);
const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '0%';

function buildPrompt(proj, sessions) {
  const total = proj.total || 0;
  const cost  = proj.cost?.total || 0;
  const cr    = proj.cacheRead || 0;
  const cw    = proj.cacheCreate || 0;
  const out   = proj.output || 0;
  const inp   = proj.input || 0;
  const hitRatio = cw > 0 ? (cr / cw).toFixed(1) : 'N/A';

  const mix = Object.entries(
    sessions.reduce((m, s) => {
      const k = s.model || 'unknown';
      if (!m[k]) m[k] = { n: 0, cost: 0, total: 0 };
      m[k].n++; m[k].cost += s.cost?.total || 0; m[k].total += s.total || 0;
      return m;
    }, {})
  )
    .sort((a, b) => b[1].cost - a[1].cost).slice(0, 4)
    .map(([model, d]) => `  - ${model}: ${d.n} sessions | ${fmtM(d.total)} tok | ${money(d.cost)} (${pct(d.cost, cost)})`)
    .join('\n');

  const topSessions = [...sessions]
    .sort((a, b) => (b.cost?.total || 0) - (a.cost?.total || 0)).slice(0, 5)
    .map((s, i) => {
      const sc = s.cost?.total || 0;
      const outPct = s.total > 0 ? ((s.output || 0) / s.total * 100).toFixed(1) : '0';
      const cr2 = (s.cacheCreate || 0) > 0 ? ((s.cacheRead || 0) / (s.cacheCreate || 1)).toFixed(1) + 'x' : 'no cache';
      return `  ${i + 1}. "${(s.name || 'unnamed').slice(0, 55)}" | ${s.model || '?'} | ${money(sc)} | out:${outPct}% | cache:${cr2}`;
    }).join('\n');

  const dates = sessions.map(s => s.firstTs || s.lastTs).filter(Boolean).sort();
  const dateRange = dates.length >= 2
    ? `${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}`
    : (dates[0]?.slice(0, 10) || 'unknown');

  return `Analyze token usage patterns for an AI-assisted dev project. Find real waste — not theoretical issues.

Project: ${proj.projectLabel || proj.project}
Period: ${dateRange} | Sessions: ${proj.sessionCount} | Total cost: ${money(cost)}
Sources: ${[...new Set(sessions.map(s => s.source))].join(', ')}

Models:
${mix || '  unknown'}

Token breakdown:
  Cache read:  ${fmtM(cr).padStart(7)} | ${money(proj.cost?.cacheRead)} (${pct(cr, total)})
  Cache write: ${fmtM(cw).padStart(7)} | ${money(proj.cost?.cacheCreate)} (${pct(cw, total)})
  Output:      ${fmtM(out).padStart(7)} | ${money(proj.cost?.output)} (${pct(out, total)})
  Input:       ${fmtM(inp).padStart(7)} | ${money(proj.cost?.input)} (${pct(inp, total)})

Key ratios:
  Cache hit ratio: ${hitRatio}x  (healthy >5x, excellent >20x)
  Output share: ${pct(out, total)}  (healthy 0.5–8%)
  Avg cost/session: ${money(cost / Math.max(proj.sessionCount, 1))}

Top sessions by cost:
${topSessions || '  none'}

Return ONLY a JSON array (0–4 findings). Empty array [] if usage looks healthy.
Each object:
{"id":"snake_case","title":"max 8 words","severity":"high|medium|low","summary":"1-2 sentences on observed pattern","impact":"specific $ estimate","recommendation":"one concrete action"}
No markdown, no explanation. Just the JSON array.`;
}

// ---------- Claude CLI call ----------

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      '--print',
      '--model', MODEL,
      '--output-format', 'text',
    ], {
      env: { ...process.env, HOME },
      timeout: 60_000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.stdin.write(prompt);
    child.stdin.end();
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.slice(0, 200) || `exit ${code}`));
    });
    child.on('error', reject);
  });
}

function parseFindings(raw) {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch {}
  // Strip possible markdown code fence
  const m = raw.match(/\[[\s\S]*?\]/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return [];
}

// ---------- Per-project ----------

async function analyzeProjectWithLLM(proj, sessions) {
  const fp = projectFingerprint(proj);
  const cacheKey = `${proj.project}::${fp}`;
  const cached = llmCache[cacheKey];
  if (cached && Date.now() - new Date(cached.ts).getTime() < CACHE_TTL_MS) {
    return { findings: cached.findings, fromCache: true };
  }

  const raw = await runClaude(buildPrompt(proj, sessions));
  const findings = parseFindings(raw);
  llmCache[cacheKey] = { findings, ts: new Date().toISOString() };
  saveCache();
  return { findings, fromCache: false };
}

// ---------- Concurrent runner ----------

export async function runLLMAnalysis(projects, sessionsByProject) {
  const results = {};
  const queue = [...projects];
  let done = 0, cached = 0, errors = 0;

  async function worker() {
    while (queue.length) {
      const proj = queue.shift();
      if (!proj) break;
      const sessions = sessionsByProject.get(proj.project) || [];
      if (!sessions.length || (proj.totalCost || 0) < 0.10) {
        results[proj.project] = { findings: [], skipped: true };
        continue;
      }
      try {
        const r = await analyzeProjectWithLLM(proj, sessions);
        results[proj.project] = r;
        if (r.fromCache) cached++;
        else done++;
      } catch (e) {
        console.error(`  [llm] ${proj.projectLabel || proj.project}: ${e.message}`);
        results[proj.project] = { findings: [], error: e.message };
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  console.log(`  [llm] done — ${done} new · ${cached} cached · ${errors} errors`);
  return results;
}
