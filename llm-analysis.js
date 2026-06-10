// LLM-powered analysis using OpenAI.
// Sends aggregated project/session stats only, not conversation content.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOST_HOME || os.homedir();
const CACHE_FILE = path.join(HOME, '.agent-optimization', 'llm-cache.json');

function loadProjectEnv() {
  const envPath = path.join(MODULE_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadProjectEnv();

export const ANALYSIS_MODEL =
  (process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini').trim() ||
  'gpt-5.4-mini';
const MAX_CONCURRENT = 4;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const OPENAI_RESPONSES_URL =
  (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '') +
  '/v1/responses';

export const SUPPORTED_FINDING_IDS = [
  'context-bloat',
  'cache-inefficiency',
  'overpowered-model',
  'output-heavy',
  'reasoning-waste',
  'fragmented-sessions',
];

const FINDING_ID_ALIASES = {
  context_bloat: 'context-bloat',
  cache_inefficiency: 'cache-inefficiency',
  cache_misuse: 'cache-inefficiency',
  cache_rewrite: 'cache-inefficiency',
  overpowered_model: 'overpowered-model',
  premium_model: 'overpowered-model',
  output_heavy: 'output-heavy',
  verbose_output: 'output-heavy',
  reasoning_waste: 'reasoning-waste',
  fragmented_sessions: 'fragmented-sessions',
};

const FINDING_SCHEMA = {
  type: 'array',
  minItems: 0,
  maxItems: 4,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title', 'severity', 'summary', 'impact', 'recommendation'],
    properties: {
      id: { type: 'string', enum: SUPPORTED_FINDING_IDS },
      title: { type: 'string', maxLength: 80 },
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      summary: { type: 'string', maxLength: 320 },
      impact: { type: 'string', maxLength: 160 },
      recommendation: { type: 'string', maxLength: 260 },
    },
  },
};

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
  return `${ANALYSIS_MODEL}|${proj.sessionCount}|${Math.round((proj.total || 0) / 1e6)}|${c.toFixed(1)}`;
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
Use ONLY these exact id values:
  - context-bloat
  - cache-inefficiency
  - overpowered-model
  - output-heavy
  - reasoning-waste
  - fragmented-sessions
Each object:
{"id":"one exact id from the list","title":"max 8 words","severity":"high|medium|low","summary":"1-2 sentences on observed pattern","impact":"specific $ estimate","recommendation":"one concrete action"}
No markdown, no explanation. Just the JSON array.`;
}

// ---------- OpenAI Responses API call ----------

export function buildOpenAIRequest(prompt, model = ANALYSIS_MODEL) {
  return {
    model,
    input: prompt,
    store: false,
    max_output_tokens: 1200,
    instructions:
      'Return only JSON that matches the schema. Use the provided finding ids exactly.',
    text: {
      format: {
        type: 'json_schema',
        name: 'optimization_findings',
        strict: true,
        schema: FINDING_SCHEMA,
      },
    },
  };
}

export function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text.trim();
    }
  }
  return '';
}

async function runOpenAI(prompt) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildOpenAIRequest(prompt)),
    signal: AbortSignal.timeout(60_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(detail.slice(0, 240));
  }

  return responseText(payload);
}

export function extractImpactCost(impact) {
  const match = String(impact || '').match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function normalizeFindingId(id) {
  const raw = String(id || '').trim();
  const key = raw.toLowerCase().replace(/\s+/g, '-');
  const aliasKey = key.replace(/-/g, '_');
  return FINDING_ID_ALIASES[aliasKey] || key;
}

export function normalizeLLMFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const id = normalizeFindingId(finding.id);
  if (!SUPPORTED_FINDING_IDS.includes(id)) return null;

  const severity = String(finding.severity || 'low').toLowerCase();
  const wastedCost = extractImpactCost(finding.impact);
  return {
    id,
    title: String(finding.title || id).slice(0, 100),
    severity: ['high', 'medium', 'low'].includes(severity) ? severity : 'low',
    summary: String(finding.summary || '').slice(0, 500),
    impact: String(finding.impact || '').slice(0, 240),
    recommendation: String(finding.recommendation || '').slice(0, 500),
    examples: [],
    metric: { wastedCost },
  };
}

function parseFindings(raw) {
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed?.findings;
    if (Array.isArray(arr)) {
      return arr.map(normalizeLLMFinding).filter(Boolean).slice(0, 4);
    }
  } catch {}
  // Strip possible markdown code fence
  const m = raw.match(/\[[\s\S]*?\]/);
  if (m) {
    try { return JSON.parse(m[0]).map(normalizeLLMFinding).filter(Boolean).slice(0, 4); } catch {}
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

  const raw = await runOpenAI(buildPrompt(proj, sessions));
  const findings = parseFindings(raw);
  llmCache[cacheKey] = { findings, ts: new Date().toISOString() };
  saveCache();
  return { findings, fromCache: false };
}

// ---------- Concurrent runner ----------

export async function runLLMAnalysis(projects, sessionsByProject) {
  const results = {};
  const meta = {
    enabled: !!(process.env.OPENAI_API_KEY || '').trim(),
    model: ANALYSIS_MODEL,
    done: 0,
    cached: 0,
    errors: 0,
  };
  results.__meta = meta;

  if (!meta.enabled) {
    console.log(`  [llm] skipped — OPENAI_API_KEY is not set (model ${ANALYSIS_MODEL})`);
    return results;
  }

  const queue = [...projects];

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
        if (r.fromCache) meta.cached++;
        else meta.done++;
      } catch (e) {
        console.error(`  [llm] ${proj.projectLabel || proj.project}: ${e.message}`);
        results[proj.project] = { findings: [], error: e.message };
        meta.errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  console.log(`  [llm] ${ANALYSIS_MODEL} — ${meta.done} new · ${meta.cached} cached · ${meta.errors} errors`);
  return results;
}
