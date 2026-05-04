import fs from 'fs';
import path from 'path';

const SHEET_DESCRIPTIONS = {
  Summary: 'Export metadata and top-level token/cost totals.',
  Sessions: 'One row per Claude Code or Codex session.',
  Projects: 'Project-level rollups derived from all sessions.',
  'Daily Usage': 'Daily source-level token and cost rollups.',
  'Analysis Projects': 'Project-level optimization analysis blocks.',
  Findings: 'Flattened analysis findings and applied state.',
  'Finding Examples': 'Example sessions attached to each analysis finding.',
  'Applied Actions': 'Suggestions marked applied and their realized savings state.',
  'Context Files': 'CLAUDE.md and AGENTS.md inventory used by charts.',
  'Wire Stats': 'Dashboard WebSocket delta traffic telemetry.',
  Dictionary: 'Workbook sheet guide.',
};

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreate', 'reasoning', 'total'];
const COST_KEYS = ['input', 'output', 'cacheRead', 'cacheCreate', 'total'];

function normalizeProjectKey(project) {
  return (project || 'unknown').replace(/\/+/g, '/').replace(/\/$/, '');
}

function deriveProjectLabel(rawPath) {
  if (!rawPath || rawPath === 'unknown') return rawPath || 'unknown';
  const p = rawPath.replace(/\/+/g, '/');
  const wtMatch = p.match(/^(.+?)\/claude\/worktrees\/([^/]+)\/([^/]+)\/[0-9a-f]{6,}$/);
  if (wtMatch) {
    const root = wtMatch[1].split('/').filter(Boolean).slice(-2).join('-');
    const branch = `${wtMatch[2]}-${wtMatch[3]}`;
    return `${root}  [${branch}]`;
  }
  return p.split('/').filter(Boolean).pop() || p;
}

function n(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function isoDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d;
}

function jsonValue(value) {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function makeExportFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `agent-optimization-export-${stamp}.xlsx`;
}

export function buildProjects(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    const key = normalizeProjectKey(s.project);
    if (!map.has(key)) {
      map.set(key, {
        project: key,
        projectLabel: s.projectLabel || deriveProjectLabel(key),
        sources: new Set(),
        models: new Set(),
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoning: 0,
        total: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        firstTs: null,
        lastTs: null,
        sizeBytes: 0,
      });
    }
    const p = map.get(key);
    p.sessions++;
    if (s.source) p.sources.add(s.source);
    if (s.model) p.models.add(s.model);
    for (const key of TOKEN_KEYS) p[key] += n(s[key]);
    for (const key of COST_KEYS) p.cost[key] += n(s.cost?.[key]);
    p.sizeBytes += n(s.sizeBytes);
    if (s.firstTs && (!p.firstTs || s.firstTs < p.firstTs)) p.firstTs = s.firstTs;
    if (s.lastTs && (!p.lastTs || s.lastTs > p.lastTs)) p.lastTs = s.lastTs;
  }
  return [...map.values()].sort((a, b) => b.cost.total - a.cost.total);
}

export function buildDailyUsage(sessions) {
  const map = new Map();
  for (const s of sessions || []) {
    const ts = s.lastTs || s.firstTs || (s.mtime ? new Date(s.mtime).toISOString() : null);
    const day = ts ? String(ts).slice(0, 10) : 'unknown';
    const source = s.source || 'unknown';
    const key = `${day}::${source}`;
    if (!map.has(key)) {
      map.set(key, {
        date: day,
        source,
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoning: 0,
        total: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
      });
    }
    const row = map.get(key);
    row.sessions++;
    for (const key of TOKEN_KEYS) row[key] += n(s[key]);
    for (const key of COST_KEYS) row.cost[key] += n(s.cost?.[key]);
  }
  return [...map.values()].sort((a, b) => {
    const d = String(a.date).localeCompare(String(b.date));
    return d || String(a.source).localeCompare(String(b.source));
  });
}

export function collectContextFiles(home, sessions, fsImpl = fs) {
  const seen = new Set();
  const results = [];

  const addFile = (full, label, type, source) => {
    if (seen.has(full)) return;
    try {
      const stat = fsImpl.statSync(full);
      if (!stat.isFile()) return;
      seen.add(full);
      const content = fsImpl.readFileSync(full, 'utf8');
      results.push({
        path: full,
        label,
        bytes: stat.size,
        lines: content.split('\n').length,
        type,
        source,
      });
    } catch {}
  };

  const scanDir = (dir, label) => {
    addFile(path.join(dir, 'CLAUDE.md'), label, 'CLAUDE.md', 'claude');
    addFile(path.join(dir, '.claude', 'CLAUDE.md'), label, 'CLAUDE.md', 'claude');
    addFile(path.join(dir, 'AGENTS.md'), label, 'AGENTS.md', 'codex');
    addFile(path.join(dir, '.codex', 'AGENTS.md'), label, 'AGENTS.md', 'codex');
  };

  scanDir(home, 'Global (~)');
  scanDir(path.join(home, '.claude'), 'Global Claude (~/.claude)');
  scanDir(path.join(home, '.codex'), 'Global Codex (~/.codex)');

  const roots = [path.join(home, 'Desktop'), path.join(home, 'Documents'), home];
  for (const root of roots) {
    try {
      for (const entry of fsImpl.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = path.join(root, entry.name);
        scanDir(dir, entry.name);
        try {
          for (const sub of fsImpl.readdirSync(dir, { withFileTypes: true })) {
            if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
            scanDir(path.join(dir, sub.name), `${entry.name}/${sub.name}`);
          }
        } catch {}
      }
    } catch {}
  }

  for (const s of sessions || []) {
    const p = s.project;
    if (!p || p === 'unknown') continue;
    try {
      if (fsImpl.existsSync(p)) scanDir(p, s.projectLabel || path.basename(p));
    } catch {}
  }

  results.sort((a, b) => b.bytes - a.bytes);
  return {
    claude: results.filter(r => r.source === 'claude'),
    codex: results.filter(r => r.source === 'codex'),
    all: results,
  };
}

const col = (header, key, type = 'text', width = 18) => ({ header, key, type, width });
const metricCol = (header, key, type = 'integer') => col(header, key, type, 14);
const costCol = (header, key) => col(header, key, 'currency', 14);

function summaryRows({ cache, analysis, applied, contextFiles, wireStats, home, generatedAt }) {
  const totals = cache?.summary?.totals || {};
  const claude = cache?.summary?.claude || {};
  const codex = cache?.summary?.codex || {};
  const appliedEntries = Object.values(applied || {});
  const ctxCount = (contextFiles?.all || []).length;
  return [
    { section: 'Export', metric: 'Generated at', value: generatedAt, notes: 'Local dashboard export timestamp.' },
    { section: 'Export', metric: 'Home scanned', value: home || '', notes: 'Session roots are resolved from this home directory.' },
    { section: 'Sessions', metric: 'Total sessions', value: n(totals.sessions), notes: '' },
    { section: 'Sessions', metric: 'Total tokens', value: n(totals.total), notes: '' },
    { section: 'Cost', metric: 'Total estimated USD', value: n(totals.cost?.total), notes: 'Based on pricing.js model rates.' },
    { section: 'Claude Code', metric: 'Sessions', value: n(claude.sessions), notes: `${n(claude.total).toLocaleString()} tokens` },
    { section: 'Claude Code', metric: 'Estimated USD', value: n(claude.cost?.total), notes: '' },
    { section: 'Codex', metric: 'Sessions', value: n(codex.sessions), notes: `${n(codex.total).toLocaleString()} tokens` },
    { section: 'Codex', metric: 'Estimated USD', value: n(codex.cost?.total), notes: '' },
    { section: 'Analysis', metric: 'Generated at', value: analysis?.generatedAt ? isoDate(analysis.generatedAt) : '', notes: analysis?.llmPowered ? 'LLM-powered report' : 'Heuristic or unavailable report' },
    { section: 'Analysis', metric: 'Model', value: analysis?.llmModel || '', notes: analysis?.llmProvider || '' },
    { section: 'Analysis', metric: 'Estimated waste USD', value: n(analysis?.summary?.totalWasted), notes: `${n(analysis?.summary?.projects)} projects analyzed` },
    { section: 'Applied', metric: 'Applied suggestions', value: appliedEntries.length, notes: '' },
    { section: 'Context', metric: 'Context files', value: ctxCount, notes: `${n(contextFiles?.claude?.length)} Claude · ${n(contextFiles?.codex?.length)} Codex` },
    { section: 'Wire', metric: 'Patch updates sent', value: n(wireStats?.patchSent), notes: `${n(wireStats?.savedPct) * 100}% saved vs full payloads` },
  ];
}

function sessionRows(sessions) {
  return (sessions || []).map(s => ({
    source: s.source || '',
    sessionId: s.id || '',
    sessionName: s.name || '',
    projectLabel: s.projectLabel || deriveProjectLabel(s.project),
    project: normalizeProjectKey(s.project),
    file: s.file || '',
    model: s.model || '',
    input: n(s.input),
    output: n(s.output),
    cacheRead: n(s.cacheRead),
    cacheCreate: n(s.cacheCreate),
    reasoning: n(s.reasoning),
    total: n(s.total),
    costInput: n(s.cost?.input),
    costOutput: n(s.cost?.output),
    costCacheRead: n(s.cost?.cacheRead),
    costCacheCreate: n(s.cost?.cacheCreate),
    costTotal: n(s.cost?.total),
    pricingLabel: s.cost?.rates?.label || s.model || '',
    pricingFallback: yesNo(s.cost?.fallback),
    rateInput: n(s.cost?.rates?.input),
    rateOutput: n(s.cost?.rates?.output),
    rateCacheRead: n(s.cost?.rates?.cacheRead),
    rateCacheCreate: n(s.cost?.rates?.cacheCreate),
    messages: n(s.messages),
    firstTs: isoDate(s.firstTs),
    lastTs: isoDate(s.lastTs),
    fileMtime: s.mtime ? new Date(s.mtime) : '',
    sizeBytes: n(s.sizeBytes),
  }));
}

function projectRows(projects) {
  return (projects || []).map(p => ({
    projectLabel: p.projectLabel || deriveProjectLabel(p.project),
    project: p.project,
    sources: [...(p.sources || [])].join(', '),
    models: [...(p.models || [])].join(', '),
    sessions: n(p.sessions),
    input: n(p.input),
    output: n(p.output),
    cacheRead: n(p.cacheRead),
    cacheCreate: n(p.cacheCreate),
    reasoning: n(p.reasoning),
    total: n(p.total),
    costInput: n(p.cost?.input),
    costOutput: n(p.cost?.output),
    costCacheRead: n(p.cost?.cacheRead),
    costCacheCreate: n(p.cost?.cacheCreate),
    costTotal: n(p.cost?.total),
    firstTs: isoDate(p.firstTs),
    lastTs: isoDate(p.lastTs),
    sizeBytes: n(p.sizeBytes),
  }));
}

function analysisProjectRows(analysis) {
  return (analysis?.projects || []).map(p => ({
    projectLabel: p.projectLabel || deriveProjectLabel(p.project),
    project: p.project,
    sources: (p.sources || []).join(', '),
    sessions: n(p.sessionCount),
    totalCost: n(p.totalCost),
    wastedCost: n(p.wastedCost),
    wastePct: n(p.totalCost) > 0 ? n(p.wastedCost) / n(p.totalCost) : 0,
    findings: n(p.findings?.length),
    llmModel: p.llmModel || '',
    llmAnalyzed: yesNo(p.llmAnalyzed),
    llmCached: yesNo(p.llmCached),
    modelMix: (p.modelMix || [])
      .map(m => `${m.model} (${n(m.sessions)} sessions, ${n(m.tokens)} tokens, $${n(m.cost).toFixed(4)})`)
      .join('; '),
  }));
}

function findingRows(analysis) {
  const rows = [];
  for (const p of analysis?.projects || []) {
    for (const f of p.findings || []) {
      rows.push({
        projectLabel: p.projectLabel || deriveProjectLabel(p.project),
        project: p.project,
        findingId: f.id || '',
        title: f.title || '',
        severity: f.severity || '',
        summary: f.summary || '',
        impact: f.impact || '',
        recommendation: f.recommendation || '',
        metricWastedCost: n(f.metric?.wastedCost),
        metricSavings: n(f.metric?.savings),
        metricCost: n(f.metric?.cost),
        metricTokens: n(f.metric?.tokens),
        metricCount: n(f.metric?.count),
        applied: yesNo(f.applied),
        appliedAt: isoDate(f.applied?.appliedAt),
        baselineCost: n(f.applied?.baselineCost),
        realizedSavedCost: n(f.applied?.realizedSavedCost),
        resolved: yesNo(f.applied?.resolved),
      });
    }
  }
  return rows;
}

function findingExampleRows(analysis) {
  const rows = [];
  for (const p of analysis?.projects || []) {
    for (const f of p.findings || []) {
      for (const ex of f.examples || []) {
        rows.push({
          projectLabel: p.projectLabel || deriveProjectLabel(p.project),
          project: p.project,
          findingId: f.id || '',
          sessionId: ex.sessionId || '',
          sessionName: ex.sessionName || '',
          model: ex.model || '',
          lastTs: isoDate(ex.lastTs),
          ratio: ex.ratio || '',
          outputShare: ex.outputShare || '',
          cacheCreate: n(ex.cacheCreate),
          cacheRead: n(ex.cacheRead),
          output: n(ex.output),
          reasoning: n(ex.reasoning),
          total: n(ex.total),
          messages: n(ex.messages),
          wastedCost: n(ex.wastedCost),
          savings: n(ex.savings),
          cacheReadCost: n(ex.cacheReadCost),
          outputCost: n(ex.outputCost),
          cost: n(ex.cost),
          exampleJson: jsonValue(ex),
        });
      }
    }
  }
  return rows;
}

function appliedRows(applied) {
  return Object.values(applied || {}).map(a => ({
    project: a.project || '',
    findingId: a.findingId || '',
    appliedAt: isoDate(a.appliedAt),
    actuated: yesNo(a.actuated),
    baselineTitle: a.baseline?.title || '',
    baselineWastedCost: n(a.baseline?.wastedCost),
    baselineSeverity: a.baseline?.severity || '',
    baselineSessionIds: (a.baseline?.sessionIds || []).join(', '),
    realizedSavedCost: n(a.realized?.savedCost),
    baselineCost: n(a.realized?.baselineCost),
    currentCost: n(a.realized?.currentCost),
    lastChecked: isoDate(a.realized?.lastChecked),
    resolved: yesNo(a.realized?.resolved),
    actuationJson: jsonValue(a.actuation),
  })).sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
}

function contextRows(contextFiles) {
  return (contextFiles?.all || []).map(f => ({
    source: f.source || '',
    type: f.type || '',
    label: f.label || '',
    path: f.path || '',
    bytes: n(f.bytes),
    lines: n(f.lines),
  }));
}

function wireRows(wireStats) {
  return [{
    patchSent: n(wireStats?.patchSent),
    fullSent: n(wireStats?.fullSent),
    patchBytes: n(wireStats?.patchBytes),
    wouldHaveBeenBytes: n(wireStats?.wouldHaveBeenBytes),
    initBytes: n(wireStats?.initBytes),
    savedBytes: n(wireStats?.savedBytes),
    savedPct: n(wireStats?.savedPct),
    uptimeSec: n(wireStats?.uptimeSec),
  }];
}

function dictionaryRows(sheets) {
  return sheets.map(sheet => ({
    sheet: sheet.name,
    rows: sheet.rows.length,
    columns: sheet.columns.length,
    description: SHEET_DESCRIPTIONS[sheet.name] || '',
  }));
}

export function buildExportModel({
  cache,
  analysis,
  applied = {},
  contextFiles = { all: [], claude: [], codex: [] },
  wireStats = {},
  home = '',
  generatedAt = new Date(),
} = {}) {
  const sessions = cache?.sessions || [];
  const projects = buildProjects(sessions);
  const dailyUsage = buildDailyUsage(sessions);
  const sheets = [
    {
      name: 'Summary',
      columns: [
        col('Section', 'section', 'text', 16),
        col('Metric', 'metric', 'text', 24),
        col('Value', 'value', 'auto', 24),
        col('Notes', 'notes', 'wrap', 56),
      ],
      rows: summaryRows({ cache, analysis, applied, contextFiles, wireStats, home, generatedAt }),
    },
    {
      name: 'Sessions',
      columns: [
        col('Source', 'source', 'text', 10),
        col('Session ID', 'sessionId', 'text', 36),
        col('Session Name', 'sessionName', 'wrap', 42),
        col('Project Label', 'projectLabel', 'text', 28),
        col('Project Path', 'project', 'wrap', 52),
        col('File', 'file', 'wrap', 52),
        col('Model', 'model', 'text', 22),
        metricCol('Input', 'input'),
        metricCol('Output', 'output'),
        metricCol('Cache Read', 'cacheRead'),
        metricCol('Cache Write', 'cacheCreate'),
        metricCol('Reasoning', 'reasoning'),
        metricCol('Total', 'total'),
        costCol('Cost Input', 'costInput'),
        costCol('Cost Output', 'costOutput'),
        costCol('Cost Cache Read', 'costCacheRead'),
        costCol('Cost Cache Write', 'costCacheCreate'),
        costCol('Cost Total', 'costTotal'),
        col('Pricing Label', 'pricingLabel', 'text', 24),
        col('Fallback Pricing', 'pricingFallback', 'text', 14),
        costCol('Rate Input / 1M', 'rateInput'),
        costCol('Rate Output / 1M', 'rateOutput'),
        costCol('Rate Cache Read / 1M', 'rateCacheRead'),
        costCol('Rate Cache Write / 1M', 'rateCacheCreate'),
        metricCol('Messages', 'messages'),
        col('First Activity', 'firstTs', 'date', 20),
        col('Last Activity', 'lastTs', 'date', 20),
        col('File Modified', 'fileMtime', 'date', 20),
        metricCol('Size Bytes', 'sizeBytes'),
      ],
      rows: sessionRows(sessions),
    },
    {
      name: 'Projects',
      columns: [
        col('Project Label', 'projectLabel', 'text', 28),
        col('Project Path', 'project', 'wrap', 54),
        col('Sources', 'sources', 'text', 16),
        col('Models', 'models', 'wrap', 42),
        metricCol('Sessions', 'sessions'),
        metricCol('Input', 'input'),
        metricCol('Output', 'output'),
        metricCol('Cache Read', 'cacheRead'),
        metricCol('Cache Write', 'cacheCreate'),
        metricCol('Reasoning', 'reasoning'),
        metricCol('Total', 'total'),
        costCol('Cost Input', 'costInput'),
        costCol('Cost Output', 'costOutput'),
        costCol('Cost Cache Read', 'costCacheRead'),
        costCol('Cost Cache Write', 'costCacheCreate'),
        costCol('Cost Total', 'costTotal'),
        col('First Activity', 'firstTs', 'date', 20),
        col('Last Activity', 'lastTs', 'date', 20),
        metricCol('Size Bytes', 'sizeBytes'),
      ],
      rows: projectRows(projects),
    },
    {
      name: 'Daily Usage',
      columns: [
        col('Date', 'date', 'text', 14),
        col('Source', 'source', 'text', 10),
        metricCol('Sessions', 'sessions'),
        metricCol('Input', 'input'),
        metricCol('Output', 'output'),
        metricCol('Cache Read', 'cacheRead'),
        metricCol('Cache Write', 'cacheCreate'),
        metricCol('Reasoning', 'reasoning'),
        metricCol('Total', 'total'),
        costCol('Cost Input', 'costInput'),
        costCol('Cost Output', 'costOutput'),
        costCol('Cost Cache Read', 'costCacheRead'),
        costCol('Cost Cache Write', 'costCacheCreate'),
        costCol('Cost Total', 'costTotal'),
      ],
      rows: dailyUsage.map(d => ({
        ...d,
        costInput: n(d.cost?.input),
        costOutput: n(d.cost?.output),
        costCacheRead: n(d.cost?.cacheRead),
        costCacheCreate: n(d.cost?.cacheCreate),
        costTotal: n(d.cost?.total),
      })),
    },
    {
      name: 'Analysis Projects',
      columns: [
        col('Project Label', 'projectLabel', 'text', 28),
        col('Project Path', 'project', 'wrap', 54),
        col('Sources', 'sources', 'text', 16),
        metricCol('Sessions', 'sessions'),
        costCol('Total Cost', 'totalCost'),
        costCol('Wasted Cost', 'wastedCost'),
        col('Waste %', 'wastePct', 'percent', 12),
        metricCol('Findings', 'findings'),
        col('LLM Model', 'llmModel', 'text', 22),
        col('LLM Analyzed', 'llmAnalyzed', 'text', 14),
        col('LLM Cached', 'llmCached', 'text', 12),
        col('Model Mix', 'modelMix', 'wrap', 64),
      ],
      rows: analysisProjectRows(analysis),
    },
    {
      name: 'Findings',
      columns: [
        col('Project Label', 'projectLabel', 'text', 28),
        col('Project Path', 'project', 'wrap', 54),
        col('Finding ID', 'findingId', 'text', 22),
        col('Title', 'title', 'wrap', 34),
        col('Severity', 'severity', 'text', 12),
        col('Summary', 'summary', 'wrap', 58),
        col('Impact', 'impact', 'wrap', 42),
        col('Recommendation', 'recommendation', 'wrap', 64),
        costCol('Metric Wasted Cost', 'metricWastedCost'),
        costCol('Metric Savings', 'metricSavings'),
        costCol('Metric Cost', 'metricCost'),
        metricCol('Metric Tokens', 'metricTokens'),
        metricCol('Metric Count', 'metricCount'),
        col('Applied', 'applied', 'text', 10),
        col('Applied At', 'appliedAt', 'date', 20),
        costCol('Baseline Cost', 'baselineCost'),
        costCol('Realized Saved', 'realizedSavedCost'),
        col('Resolved', 'resolved', 'text', 10),
      ],
      rows: findingRows(analysis),
    },
    {
      name: 'Finding Examples',
      columns: [
        col('Project Label', 'projectLabel', 'text', 28),
        col('Project Path', 'project', 'wrap', 54),
        col('Finding ID', 'findingId', 'text', 22),
        col('Session ID', 'sessionId', 'text', 36),
        col('Session Name', 'sessionName', 'wrap', 42),
        col('Model', 'model', 'text', 22),
        col('Last Activity', 'lastTs', 'date', 20),
        col('Ratio', 'ratio', 'text', 12),
        col('Output Share', 'outputShare', 'text', 14),
        metricCol('Cache Write', 'cacheCreate'),
        metricCol('Cache Read', 'cacheRead'),
        metricCol('Output', 'output'),
        metricCol('Reasoning', 'reasoning'),
        metricCol('Total', 'total'),
        metricCol('Messages', 'messages'),
        costCol('Wasted Cost', 'wastedCost'),
        costCol('Savings', 'savings'),
        costCol('Cache Read Cost', 'cacheReadCost'),
        costCol('Output Cost', 'outputCost'),
        costCol('Cost', 'cost'),
        col('Example JSON', 'exampleJson', 'wrap', 70),
      ],
      rows: findingExampleRows(analysis),
    },
    {
      name: 'Applied Actions',
      columns: [
        col('Project Path', 'project', 'wrap', 54),
        col('Finding ID', 'findingId', 'text', 22),
        col('Applied At', 'appliedAt', 'date', 20),
        col('Actuated', 'actuated', 'text', 10),
        col('Baseline Title', 'baselineTitle', 'wrap', 34),
        costCol('Baseline Wasted Cost', 'baselineWastedCost'),
        col('Baseline Severity', 'baselineSeverity', 'text', 14),
        col('Baseline Session IDs', 'baselineSessionIds', 'wrap', 54),
        costCol('Realized Saved', 'realizedSavedCost'),
        costCol('Baseline Cost', 'baselineCost'),
        costCol('Current Cost', 'currentCost'),
        col('Last Checked', 'lastChecked', 'date', 20),
        col('Resolved', 'resolved', 'text', 10),
        col('Actuation JSON', 'actuationJson', 'wrap', 70),
      ],
      rows: appliedRows(applied),
    },
    {
      name: 'Context Files',
      columns: [
        col('Source', 'source', 'text', 10),
        col('Type', 'type', 'text', 14),
        col('Label', 'label', 'text', 30),
        col('Path', 'path', 'wrap', 62),
        metricCol('Bytes', 'bytes'),
        metricCol('Lines', 'lines'),
      ],
      rows: contextRows(contextFiles),
    },
    {
      name: 'Wire Stats',
      columns: [
        metricCol('Patch Sent', 'patchSent'),
        metricCol('Full Sent', 'fullSent'),
        metricCol('Patch Bytes', 'patchBytes'),
        metricCol('Would Have Been Bytes', 'wouldHaveBeenBytes'),
        metricCol('Init Bytes', 'initBytes'),
        metricCol('Saved Bytes', 'savedBytes'),
        col('Saved %', 'savedPct', 'percent', 12),
        metricCol('Uptime Sec', 'uptimeSec'),
      ],
      rows: wireRows(wireStats),
    },
  ];

  sheets.push({
    name: 'Dictionary',
    columns: [
      col('Sheet', 'sheet', 'text', 22),
      metricCol('Rows', 'rows'),
      metricCol('Columns', 'columns'),
      col('Description', 'description', 'wrap', 62),
    ],
    rows: dictionaryRows(sheets),
  });

  return { sheets };
}

function sanitizeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').trim() || 'Sheet';
  base = base.slice(0, 31);
  let out = base;
  let i = 2;
  while (used.has(out)) {
    const suffix = ` ${i++}`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(out);
  return out;
}

function columnName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function excelDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() / 86400000 + 25569;
}

function styleFor(type, value) {
  if (type === 'integer') return 2;
  if (type === 'currency') return 3;
  if (type === 'percent') return 4;
  if (type === 'date') return 5;
  if (type === 'wrap') return 6;
  if (type === 'auto' && typeof value === 'number') return Number.isInteger(value) ? 2 : 3;
  if (type === 'auto' && value instanceof Date) return 5;
  return 0;
}

function cellXml(ref, value, type, style) {
  if (value === undefined || value === null || value === '') {
    return style ? `<c r="${ref}" s="${style}"/>` : '';
  }

  if (type === 'date' || value instanceof Date) {
    const serial = excelDate(value);
    if (serial !== null) return `<c r="${ref}" s="${style || 5}"><v>${serial}</v></c>`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  }

  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"${style ? ` s="${style}"` : ''}><v>${value ? 1 : 0}</v></c>`;
  }

  const text = xmlEscape(value);
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const widthXml = columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`
  ).join('');
  const header = `<row r="1">${columns.map((c, i) =>
    cellXml(`${columnName(i)}1`, c.header, 'text', 1)
  ).join('')}</row>`;
  const body = rows.map((row, rowIdx) => {
    const r = rowIdx + 2;
    const cells = columns.map((c, colIdx) => {
      const value = typeof c.value === 'function' ? c.value(row) : row[c.key];
      const style = styleFor(c.type, value);
      return cellXml(`${columnName(colIdx)}${r}`, value, c.type, style);
    }).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');

  const lastCol = columnName(Math.max(columns.length - 1, 0));
  const lastRow = Math.max(rows.length + 1, 1);
  const filter = rows.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${widthXml}</cols>
  <sheetData>${header}${body}</sheetData>
  ${filter}
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="$#,##0.0000"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
    <numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF111827"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right><top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function workbookXml(sheetNames) {
  const sheetXml = sheetNames.map((name, i) =>
    `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="false"/>
  <sheets>${sheetXml}</sheets>
</workbook>`;
}

function workbookRels(sheetCount) {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function contentTypes(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function coreProps(generatedAt) {
  const iso = (generatedAt instanceof Date ? generatedAt : new Date(generatedAt)).toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Agent Optimization Export</dc:title>
  <dc:creator>Agent Optimization</dc:creator>
  <cp:lastModifiedBy>Agent Optimization</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>`;
}

function appProps(sheetNames) {
  const names = sheetNames.map(name => `<vt:lpstr>${xmlEscape(name)}</vt:lpstr>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Agent Optimization</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${names}</vt:vector></TitlesOfParts>
  <Company></Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0300</AppVersion>
</Properties>`;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries, date = new Date()) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime(date);

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function buildExcelExport(input = {}) {
  const generatedAt = input.generatedAt || new Date();
  const model = buildExportModel({ ...input, generatedAt });
  const usedNames = new Set();
  const sheets = model.sheets.map(sheet => ({
    ...sheet,
    safeName: sanitizeSheetName(sheet.name, usedNames),
  }));
  const sheetNames = sheets.map(s => s.safeName);
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes(sheets.length) },
    { name: '_rels/.rels', data: rootRels() },
    { name: 'docProps/core.xml', data: coreProps(generatedAt) },
    { name: 'docProps/app.xml', data: appProps(sheetNames) },
    { name: 'xl/workbook.xml', data: workbookXml(sheetNames) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets.length) },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sheet),
    })),
  ];
  return createZip(entries, generatedAt);
}
