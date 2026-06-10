// Real actuators per finding. Each one returns a structured action plan
// (preview) and can then commit the change with a backup. Behavioral findings
// (output-heavy, fragmented-sessions, cache-inefficiency) are explicitly
// non-actionable from a tool perspective; we return { behavioral: true }.

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const BACKUP_ROOT = path.join(HOME, '.agent-optimization', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { recursive: true });
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = filePath.replace(/[\/\\]/g, '_');
  const dest = path.join(BACKUP_ROOT, `${stamp}__${safeName}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

function diffStats(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  return {
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(after, 'utf8'),
    linesBefore: beforeLines.length,
    linesAfter: afterLines.length,
    bytesDelta: Buffer.byteLength(before, 'utf8') - Buffer.byteLength(after, 'utf8'),
    linesDelta: beforeLines.length - afterLines.length,
  };
}

// ---------- Context bloat: trim CLAUDE.md / AGENTS.md ----------

function findContextFiles(projectPath) {
  const candidates = [
    path.join(projectPath, 'CLAUDE.md'),
    path.join(projectPath, 'AGENTS.md'),
    path.join(projectPath, '.claude', 'CLAUDE.md'),
    path.join(projectPath, '.codex', 'AGENTS.md'),
  ];
  return candidates.filter(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
    catch { return false; }
  });
}

function trimContextFile(content) {
  let out = content;

  // 1. Collapse 3+ blank lines → 2
  out = out.replace(/\n{4,}/g, '\n\n\n');

  // 2. Remove trailing whitespace per line
  out = out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');

  // 3. Drop empty headers (e.g. "## Section\n\n## Next" with no body)
  out = out.replace(/^(#{1,6}[^\n]+)\n+(?=#{1,6}\s)/gm, '');

  // 4. Drop lines that are only HTML-style noise comments (<!-- ... -->) standalone
  out = out.split('\n').filter(l => !/^\s*<!--\s*[A-Z_-]+\s*-->\s*$/.test(l)).join('\n');

  // 5. Collapse runs of "----" or "====" decorative dividers (any 3+ same char)
  out = out.replace(/^([-=*_])\1{20,}$/gm, '');

  // 6. Final: strip leading/trailing blank lines
  out = out.replace(/^\n+/, '').replace(/\n+$/, '\n');

  return out;
}

function previewContextBloat(projectPath) {
  const files = findContextFiles(projectPath);
  if (!files.length) {
    return {
      actionable: false,
      reason: 'No CLAUDE.md / AGENTS.md found in this project. Context likely lives in user-level files (~/.claude/CLAUDE.md). Trimming those affects every project — too risky to auto-apply.',
    };
  }
  const changes = [];
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = trimContextFile(before);
    if (before === after) continue;
    changes.push({ file: f, before, after, ...diffStats(before, after) });
  }
  if (!changes.length) {
    return {
      actionable: false,
      reason: 'Context files are already minimal — no safe trimming heuristic matched.',
    };
  }
  const totalBytes = changes.reduce((a, c) => a + c.bytesDelta, 0);
  return {
    actionable: true,
    summary: `Trim ${changes.length} context file${changes.length === 1 ? '' : 's'} · ~${totalBytes} bytes removed`,
    changes: changes.map(c => ({
      file: c.file,
      bytesBefore: c.bytesBefore,
      bytesAfter: c.bytesAfter,
      bytesDelta: c.bytesDelta,
      linesBefore: c.linesBefore,
      linesAfter: c.linesAfter,
      linesDelta: c.linesDelta,
      preview: extractDiffSnippet(c.before, c.after),
    })),
    _commit: () => {
      const written = [];
      for (const c of changes) {
        const backup = backupFile(c.file);
        fs.writeFileSync(c.file, c.after);
        written.push({ file: c.file, backup });
      }
      return { written };
    },
  };
}

function extractDiffSnippet(before, after) {
  // First 2 lines that differ — for UI hint only
  const a = before.split('\n');
  const b = after.split('\n');
  const removed = [];
  let i = 0, j = 0;
  while (i < a.length && removed.length < 4) {
    if (a[i] !== b[j]) {
      if (b[j] === undefined || a.indexOf(b[j], i) > i) {
        removed.push('- ' + a[i].slice(0, 80));
        i++;
      } else { i++; j++; }
    } else { i++; j++; }
  }
  return removed.join('\n') || '(whitespace / formatting cleanup)';
}

// ---------- Overpowered model: pin cheaper model in project settings ----------

function previewOverpoweredModel(projectPath, sessions) {
  // Choose target tier based on what was actually flagged. Default to Sonnet.
  const flagged = sessions.filter(s =>
    (/opus|^o1$/i.test(s.model || '') || (/gpt-5/i.test(s.model || '') && !/mini/i.test(s.model || ''))) &&
    (s.output || 0) < 2000 && (s.total || 0) < 100_000
  );
  if (!flagged.length) {
    return { actionable: false, reason: 'No flagged sessions found in this project right now.' };
  }
  const isClaude = flagged.some(s => /opus/i.test(s.model || ''));
  const targetModel = isClaude ? 'claude-sonnet-4-5' : 'gpt-4o-mini';
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch { existing = {}; }
  }
  const before = JSON.stringify(existing, null, 2);
  const proposed = { ...existing, model: targetModel };
  const after = JSON.stringify(proposed, null, 2);
  if (before === after) {
    return { actionable: false, reason: `Project already pinned to ${targetModel}.` };
  }

  return {
    actionable: true,
    summary: `Pin project model to ${targetModel} via .claude/settings.local.json`,
    changes: [{
      file: settingsPath,
      bytesBefore: Buffer.byteLength(before),
      bytesAfter: Buffer.byteLength(after),
      bytesDelta: Buffer.byteLength(before) - Buffer.byteLength(after),
      preview: `+ "model": "${targetModel}"`,
    }],
    _commit: () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const backup = fs.existsSync(settingsPath) ? backupFile(settingsPath) : null;
      fs.writeFileSync(settingsPath, after + '\n');
      return { written: [{ file: settingsPath, backup }] };
    },
  };
}

// ---------- Reasoning waste: lower Codex reasoning effort ----------

function previewReasoningWaste() {
  const codexConfig = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(codexConfig)) {
    return { actionable: false, reason: 'No ~/.codex/config.toml — Codex not configured here.' };
  }
  const before = fs.readFileSync(codexConfig, 'utf8');
  let after = before;

  if (/^\s*model_reasoning_effort\s*=\s*"(low|minimal)"/m.test(before)) {
    return { actionable: false, reason: 'Reasoning effort is already low/minimal.' };
  }

  if (/^\s*model_reasoning_effort\s*=/m.test(before)) {
    after = before.replace(/^\s*model_reasoning_effort\s*=.*$/m, 'model_reasoning_effort = "low"');
  } else {
    // Insert at top of [model] block, or append a standalone line
    const hasModelBlock = /^\[model\]/m.test(before);
    if (hasModelBlock) {
      after = before.replace(/^\[model\]\s*\n/m, '[model]\nmodel_reasoning_effort = "low"\n');
    } else {
      after = before.trimEnd() + '\n\nmodel_reasoning_effort = "low"\n';
    }
  }

  if (before === after) {
    return { actionable: false, reason: 'No safe location to insert the reasoning effort directive.' };
  }
  return {
    actionable: true,
    summary: 'Set Codex model_reasoning_effort = "low" in ~/.codex/config.toml',
    changes: [{
      file: codexConfig,
      ...diffStats(before, after),
      preview: '+ model_reasoning_effort = "low"',
    }],
    _commit: () => {
      const backup = backupFile(codexConfig);
      fs.writeFileSync(codexConfig, after);
      return { written: [{ file: codexConfig, backup }] };
    },
  };
}

// ---------- Behavioral findings (no auto-apply) ----------

function behavioral(reason) {
  return { actionable: false, behavioral: true, reason };
}

// ---------- Public API ----------

export function previewActuator(findingId, project, sessions) {
  switch (findingId) {
    case 'context-bloat':
      return previewContextBloat(project);
    case 'overpowered-model':
      return previewOverpoweredModel(project, sessions);
    case 'reasoning-waste':
      return previewReasoningWaste();
    case 'cache-inefficiency':
      return behavioral('Cache hit ratio depends on how you keep the session alive — no file we can edit will fix it. Tracking only.');
    case 'output-heavy':
      return behavioral('Output verbosity comes from prompts, not configuration. Tracking only.');
    case 'fragmented-sessions':
      return behavioral('Fragmenting comes from CLI usage patterns. Tracking only.');
    default:
      return behavioral('This LLM recommendation is advisory and has no safe file-level automation yet. Tracking only.');
  }
}

export function commitActuator(plan) {
  if (!plan?._commit) throw new Error('No commit function on plan');
  return plan._commit();
}
