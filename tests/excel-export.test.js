import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExcelExport,
  buildExportModel,
  buildProjects,
  makeExportFilename,
} from '../excel-export.js';

const sampleSessions = [
  {
    source: 'claude',
    id: 'claude-1',
    name: 'Trim context files',
    project: '/Users/example/Desktop/app',
    projectLabel: 'app',
    file: '/Users/example/.claude/projects/app/claude-1.jsonl',
    model: 'claude-3-5-sonnet',
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheCreate: 300,
    total: 3800,
    cost: {
      input: 0.003,
      output: 0.0075,
      cacheRead: 0.0006,
      cacheCreate: 0.001125,
      total: 0.012225,
      rates: { label: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
    },
    messages: 4,
    firstTs: '2026-05-01T10:00:00.000Z',
    lastTs: '2026-05-01T10:10:00.000Z',
    mtime: Date.parse('2026-05-01T10:11:00.000Z'),
    sizeBytes: 4096,
  },
  {
    source: 'codex',
    id: 'codex-1',
    name: 'Add export endpoint',
    project: '/Users/example/Desktop/app',
    projectLabel: 'app',
    file: '/Users/example/.codex/sessions/codex-1.jsonl',
    model: 'gpt-5.4-mini',
    input: 800,
    output: 1200,
    cacheRead: 400,
    cacheCreate: 0,
    reasoning: 900,
    total: 3300,
    cost: {
      input: 0.00012,
      output: 0.00072,
      cacheRead: 0.00003,
      cacheCreate: 0,
      total: 0.00087,
      rates: { label: 'gpt-5.4-mini', input: 0.15, output: 0.6, cacheRead: 0.075, cacheCreate: 0 },
    },
    messages: 2,
    firstTs: '2026-05-02T12:00:00.000Z',
    lastTs: '2026-05-02T12:20:00.000Z',
    mtime: Date.parse('2026-05-02T12:21:00.000Z'),
    sizeBytes: 2048,
  },
];

const sampleCache = {
  sessions: sampleSessions,
  summary: {
    totals: {
      sessions: 2,
      input: 1800,
      output: 1700,
      cacheRead: 2400,
      cacheCreate: 300,
      total: 7100,
      cost: { input: 0.00312, output: 0.00822, cacheRead: 0.00063, cacheCreate: 0.001125, total: 0.013095 },
    },
    claude: {
      sessions: 1,
      total: 3800,
      cost: { total: 0.012225 },
    },
    codex: {
      sessions: 1,
      total: 3300,
      cost: { total: 0.00087 },
    },
  },
  ts: Date.parse('2026-05-02T12:30:00.000Z'),
};

const sampleAnalysis = {
  generatedAt: '2026-05-02T13:00:00.000Z',
  llmPowered: true,
  llmProvider: 'openai',
  llmModel: 'gpt-5.4-mini',
  summary: { projects: 1, totalWasted: 0.25 },
  projects: [
    {
      project: '/Users/example/Desktop/app',
      projectLabel: 'app',
      sources: ['claude', 'codex'],
      sessionCount: 2,
      totalCost: 0.013095,
      wastedCost: 0.25,
      llmAnalyzed: true,
      llmCached: false,
      llmModel: 'gpt-5.4-mini',
      modelMix: [{ model: 'gpt-5.4-mini', sessions: 1, tokens: 3300, cost: 0.00087 }],
      findings: [
        {
          id: 'context-bloat',
          title: 'Large context',
          severity: 'medium',
          summary: 'Context is larger than needed.',
          impact: 'About $0.25 can be saved.',
          recommendation: 'Trim context.',
          metric: { wastedCost: 0.25, count: 1 },
          examples: [{ sessionId: 'claude-1', sessionName: 'Trim context files', model: 'claude-3-5-sonnet', cacheRead: 2000, output: 500 }],
        },
      ],
    },
  ],
};

test('buildProjects aggregates session tokens and costs', () => {
  const [project] = buildProjects(sampleSessions);

  assert.equal(project.project, '/Users/example/Desktop/app');
  assert.equal(project.sessions, 2);
  assert.equal(project.total, 7100);
  assert.equal(project.reasoning, 900);
  assert.equal(project.cost.total.toFixed(6), '0.013095');
  assert.deepEqual([...project.sources].sort(), ['claude', 'codex']);
});

test('buildExportModel includes all workbook sheets with flattened rows', () => {
  const model = buildExportModel({
    cache: sampleCache,
    analysis: sampleAnalysis,
    contextFiles: { all: [], claude: [], codex: [] },
    wireStats: { patchSent: 2, savedPct: 0.9 },
    generatedAt: new Date('2026-05-02T13:30:00.000Z'),
  });

  const byName = new Map(model.sheets.map(sheet => [sheet.name, sheet]));
  assert.equal(byName.get('Sessions').rows.length, 2);
  assert.equal(byName.get('Projects').rows[0].costTotal.toFixed(6), '0.013095');
  assert.equal(byName.get('Findings').rows[0].findingId, 'context-bloat');
  assert.equal(byName.get('Finding Examples').rows[0].sessionId, 'claude-1');
  assert.equal(byName.get('Dictionary').rows.length, model.sheets.length - 1);
});

test('buildExcelExport returns an xlsx zip package with workbook sheets', () => {
  const buffer = buildExcelExport({
    cache: sampleCache,
    analysis: sampleAnalysis,
    contextFiles: { all: [], claude: [], codex: [] },
    wireStats: { patchSent: 2, savedPct: 0.9 },
    generatedAt: new Date('2026-05-02T13:30:00.000Z'),
  });

  assert.equal(buffer.subarray(0, 2).toString('utf8'), 'PK');
  const text = buffer.toString('utf8');
  assert.match(text, /xl\/workbook\.xml/);
  assert.match(text, /Sessions/);
  assert.match(text, /Finding Examples/);
  assert.match(text, /Agent Optimization Export/);
});

test('makeExportFilename is stable and Excel-friendly', () => {
  assert.equal(
    makeExportFilename(new Date('2026-05-02T13:30:00.000Z')),
    'agent-optimization-export-202605021330.xlsx',
  );
});
