// Heuristic analyzer. Looks at parsed sessions and flags wasteful patterns
// per-project. Runs every 2 hours from server.js.

import { getRates, computeCost } from './pricing.js';

const SEVERITY_ORDER = { critical: 3, high: 2, medium: 1, low: 0 };

// ---------- Helpers ----------

const tier = (model) => {
  if (!model) return 'unknown';
  if (/opus|gpt-5|^o1$/i.test(model)) return 'premium';
  if (/sonnet|gpt-4o$|gpt-4\.1$|^o3$/i.test(model)) return 'mid';
  if (/haiku|mini/i.test(model)) return 'cheap';
  return 'mid';
};

const sessionEffectiveCost = (s) => (s.cost && s.cost.total) || 0;

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// ---------- Per-project finding generators ----------

function findCacheInefficiency(sessions) {
  // Sessions where cache_creation >> cache_read — context is being rewritten
  // every turn instead of reused. Only meaningful for Claude (cacheCreate > 0).
  const out = [];
  for (const s of sessions) {
    if (s.source !== 'claude') continue;
    const created = s.cacheCreate || 0;
    const read = s.cacheRead || 0;
    if (created < 50_000) continue; // ignore trivial
    const ratio = read / Math.max(created, 1);
    if (ratio < 1.5) {
      // Should ideally be 5–20x. Below 1.5 means cache is barely paying for itself.
      const wastedCost = (s.cost?.cacheCreate || 0) * 0.7;
      out.push({
        session: s,
        ratio,
        cacheCreate: created,
        cacheRead: read,
        wastedCost,
      });
    }
  }
  return out.sort((a, b) => b.wastedCost - a.wastedCost);
}

function findExpensiveTinyTasks(sessions) {
  // Premium-tier sessions that did very little work — Sonnet/Haiku would have sufficed.
  const out = [];
  for (const s of sessions) {
    if (tier(s.model) !== 'premium') continue;
    const work = s.output || 0;
    // "Tiny": <2K output tokens AND <100K total tokens
    if (work < 2000 && (s.total || 0) < 100_000) {
      // Estimate savings if same work were done on Sonnet-tier
      const cheapRates = getRates('claude-3-5-sonnet');
      const cheapCost = computeCost(
        { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate },
        'claude-3-5-sonnet'
      );
      const savings = (s.cost?.total || 0) - cheapCost.total;
      if (savings > 0.01) {
        out.push({ session: s, output: work, total: s.total, savings, suggestion: cheapRates.label });
      }
    }
  }
  return out.sort((a, b) => b.savings - a.savings);
}

function findOutputHeavySessions(sessions) {
  // Output share unusually high — usually means the model is regenerating
  // boilerplate or being asked for verbose work it shouldn't produce.
  const out = [];
  for (const s of sessions) {
    const total = s.total || 0;
    if (total < 20_000) continue;
    const outShare = (s.output || 0) / total;
    if (outShare > 0.25) {
      out.push({
        session: s,
        outputShare: outShare,
        outputCost: s.cost?.output || 0,
      });
    }
  }
  return out.sort((a, b) => b.outputCost - a.outputCost);
}

function findContextBloat(sessions) {
  // Huge cache_read with tiny output — model is loading massive context but
  // producing very little. Either context isn't being trimmed or session
  // should be split.
  const out = [];
  for (const s of sessions) {
    const cr = s.cacheRead || 0;
    const op = s.output || 0;
    if (cr < 500_000) continue;
    const ratio = op / Math.max(cr, 1);
    if (ratio < 0.005) {
      // Output is less than 0.5% of cache read => context is huge but largely unused.
      out.push({
        session: s,
        cacheRead: cr,
        output: op,
        ratio,
        cacheReadCost: s.cost?.cacheRead || 0,
      });
    }
  }
  return out.sort((a, b) => b.cacheReadCost - a.cacheReadCost);
}

function findReasoningWaste(sessions) {
  // Codex: reasoning_output_tokens disproportionately large vs visible output.
  const out = [];
  for (const s of sessions) {
    if (s.source !== 'codex') continue;
    const reasoning = s.reasoning || 0;
    const op = s.output || 0;
    if (reasoning < 30_000) continue;
    if (reasoning > op * 4 && op > 0) {
      out.push({
        session: s,
        reasoning,
        output: op,
        ratio: reasoning / op,
      });
    }
  }
  return out.sort((a, b) => b.reasoning - a.reasoning);
}

function findFragmentedSessions(projectSessions) {
  // Many short sessions (<10K tokens, <5 messages) within the same project
  // suggest restarting too often and losing cached context.
  const tiny = projectSessions.filter(s => (s.total || 0) < 10_000 && (s.messages || 0) < 5);
  if (tiny.length < 5) return null;
  const wastedSetupCost = tiny.reduce((a, s) => a + (s.cost?.cacheCreate || 0), 0);
  return {
    count: tiny.length,
    examples: tiny.slice(0, 3),
    wastedSetupCost,
  };
}

function pickModelMix(sessions) {
  const map = {};
  for (const s of sessions) {
    const m = s.model || 'unknown';
    if (!map[m]) map[m] = { model: m, sessions: 0, tokens: 0, cost: 0, tier: tier(m) };
    map[m].sessions++;
    map[m].tokens += s.total || 0;
    map[m].cost += s.cost?.total || 0;
  }
  return Object.values(map).sort((a, b) => b.cost - a.cost);
}

// ---------- Aggregator ----------

function analyzeProject(projectKey, sessions) {
  const findings = [];
  const totalCost = sessions.reduce((a, s) => a + sessionEffectiveCost(s), 0);

  // --- 1. Cache inefficiency ---
  const cacheBad = findCacheInefficiency(sessions);
  if (cacheBad.length) {
    const wasted = cacheBad.reduce((a, x) => a + x.wastedCost, 0);
    findings.push({
      id: 'cache-inefficiency',
      title: 'Cache being rewritten instead of reused',
      severity: wasted > 5 ? 'high' : wasted > 1 ? 'medium' : 'low',
      summary: `${cacheBad.length} session${cacheBad.length === 1 ? '' : 's'} created ≥50K cache tokens but read back <1.5× the amount. Caching is paying setup cost without amortizing it.`,
      impact: `≈ ${money(wasted)} likely wasted on cache writes that weren't reused enough.`,
      recommendation: 'Avoid restarting Claude Code mid-task; long-lived sessions amortize the cache write. Pin the system prompt and stable context once, then let read hits accumulate.',
      examples: cacheBad.slice(0, 3).map(x => ({
        sessionId: x.session.id, sessionName: x.session.name,
        model: x.session.model,
        ratio: x.ratio.toFixed(2) + '×',
        cacheCreate: x.cacheCreate,
        cacheRead: x.cacheRead,
        wastedCost: x.wastedCost,
        lastTs: x.session.lastTs,
      })),
      metric: { wastedCost: wasted, count: cacheBad.length },
    });
  }

  // --- 2. Premium-tier on tiny tasks ---
  const expensive = findExpensiveTinyTasks(sessions);
  if (expensive.length) {
    const savings = expensive.reduce((a, x) => a + x.savings, 0);
    findings.push({
      id: 'overpowered-model',
      title: 'Premium model used for trivial work',
      severity: savings > 5 ? 'high' : savings > 1 ? 'medium' : 'low',
      summary: `${expensive.length} short session${expensive.length === 1 ? '' : 's'} on Opus/o1-tier produced under 2K output. A mid-tier model would have sufficed.`,
      impact: `≈ ${money(savings)} saveable by routing these to Sonnet-tier or smaller.`,
      recommendation: 'Use Sonnet/4o for short turns and one-shot prompts. Reserve Opus/o1 for deep refactors, multi-file reasoning, and long planning sessions.',
      examples: expensive.slice(0, 3).map(x => ({
        sessionId: x.session.id, sessionName: x.session.name,
        model: x.session.model,
        output: x.output,
        total: x.total,
        savings: x.savings,
        lastTs: x.session.lastTs,
      })),
      metric: { savings, count: expensive.length },
    });
  }

  // --- 3. Context bloat (huge cache read, tiny output) ---
  const bloat = findContextBloat(sessions);
  if (bloat.length) {
    const cost = bloat.reduce((a, x) => a + x.cacheReadCost, 0);
    findings.push({
      id: 'context-bloat',
      title: 'Massive context loaded for very little work',
      severity: cost > 10 ? 'high' : cost > 2 ? 'medium' : 'low',
      summary: `${bloat.length} session${bloat.length === 1 ? '' : 's'} loaded ≥500K cache-read tokens but produced <0.5% of that as output.`,
      impact: `≈ ${money(cost)} spent on cache reads where most context was unused.`,
      recommendation: 'Trim CLAUDE.md / AGENTS.md size, remove unused subagents from the loaded set, and clear stale tool results between phases. Use /compact in Claude Code or start a fresh session for unrelated tasks.',
      examples: bloat.slice(0, 3).map(x => ({
        sessionId: x.session.id, sessionName: x.session.name,
        model: x.session.model,
        cacheRead: x.cacheRead,
        output: x.output,
        cacheReadCost: x.cacheReadCost,
        lastTs: x.session.lastTs,
      })),
      metric: { cost, count: bloat.length },
    });
  }

  // --- 4. Output-heavy sessions ---
  const heavy = findOutputHeavySessions(sessions);
  if (heavy.length) {
    const cost = heavy.reduce((a, x) => a + x.outputCost, 0);
    findings.push({
      id: 'output-heavy',
      title: 'Disproportionate output generation',
      severity: cost > 5 ? 'medium' : 'low',
      summary: `${heavy.length} session${heavy.length === 1 ? '' : 's'} where output was >25% of total tokens — verbose or repeated regeneration.`,
      impact: `≈ ${money(cost)} on output tokens, the most expensive bucket.`,
      recommendation: 'Ask for diffs/patches instead of full files, request "no explanation" when the action speaks for itself, and avoid asking the model to repeat its plan after every step.',
      examples: heavy.slice(0, 3).map(x => ({
        sessionId: x.session.id, sessionName: x.session.name,
        model: x.session.model,
        outputShare: (x.outputShare * 100).toFixed(1) + '%',
        outputCost: x.outputCost,
        lastTs: x.session.lastTs,
      })),
      metric: { cost, count: heavy.length },
    });
  }

  // --- 5. Codex reasoning waste ---
  const reasoning = findReasoningWaste(sessions);
  if (reasoning.length) {
    const tokens = reasoning.reduce((a, x) => a + x.reasoning, 0);
    findings.push({
      id: 'reasoning-waste',
      title: 'Codex reasoning tokens overshooting useful output',
      severity: tokens > 500_000 ? 'medium' : 'low',
      summary: `${reasoning.length} Codex session${reasoning.length === 1 ? '' : 's'} where reasoning output is ≥4× the visible output.`,
      impact: `≈ ${fmtTok(tokens)} reasoning tokens produced for very little visible answer.`,
      recommendation: 'Lower the reasoning effort for routine asks (use a cheaper model or "minimal" reasoning). Reserve high-reasoning runs for genuinely hard problems.',
      examples: reasoning.slice(0, 3).map(x => ({
        sessionId: x.session.id, sessionName: x.session.name,
        model: x.session.model,
        reasoning: x.reasoning,
        output: x.output,
        ratio: x.ratio.toFixed(1) + '×',
        lastTs: x.session.lastTs,
      })),
      metric: { tokens, count: reasoning.length },
    });
  }

  // --- 6. Fragmented sessions ---
  const frag = findFragmentedSessions(sessions);
  if (frag) {
    findings.push({
      id: 'fragmented-sessions',
      title: 'Too many tiny sessions in one project',
      severity: frag.count > 15 ? 'medium' : 'low',
      summary: `${frag.count} sessions in this project finished under 10K tokens with <5 messages.`,
      impact: `≈ ${money(frag.wastedSetupCost)} spent on cache-write setup that never paid back.`,
      recommendation: 'Keep one long-lived session per task. Use /clear instead of restarting the CLI; this preserves cache. Spinning up a new session for every quick question pays the setup cost each time.',
      examples: frag.examples.map(s => ({
        sessionId: s.id, sessionName: s.name,
        model: s.model,
        total: s.total,
        messages: s.messages,
        cost: s.cost?.total || 0,
        lastTs: s.lastTs,
      })),
      metric: { count: frag.count, wastedSetupCost: frag.wastedSetupCost },
    });
  }

  // --- Wrap up project block ---
  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

  const wastedCost = findings.reduce((a, f) => {
    return a + (f.metric?.wastedCost || f.metric?.savings || f.metric?.cost || 0);
  }, 0);

  const sources = [...new Set(sessions.map(s => s.source).filter(Boolean))];
  return {
    project: projectKey,
    projectLabel: sessions[0]?.projectLabel || projectKey.split('/').filter(Boolean).pop() || projectKey,
    sources,
    sessionCount: sessions.length,
    totalCost,
    wastedCost: Math.min(wastedCost, totalCost),
    findings,
    modelMix: pickModelMix(sessions),
  };
}

// ---------- Public ----------

// runAnalysis builds heuristic project blocks synchronously.
// Server calls runLLMEnrichment afterwards (async) to replace findings with LLM output.

export function runAnalysis(sessions) {
  const byProject = new Map();
  for (const s of sessions) {
    const key = (s.project || 'unknown').replace(/\/+/g, '/').replace(/\/$/, '');
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(s);
  }

  const projects = [];
  for (const [key, list] of byProject) {
    projects.push(analyzeProject(key, list));
  }
  projects.sort((a, b) => b.wastedCost - a.wastedCost);

  // Roll-ups
  const totalCost = projects.reduce((a, p) => a + p.totalCost, 0);
  const totalWasted = projects.reduce((a, p) => a + p.wastedCost, 0);
  const findingCounts = {};
  for (const p of projects) {
    for (const f of p.findings) {
      findingCounts[f.id] = (findingCounts[f.id] || 0) + 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      projects: projects.length,
      sessions: sessions.length,
      totalCost,
      totalWasted,
      wastePct: totalCost > 0 ? (totalWasted / totalCost) : 0,
      findingCounts,
    },
    projects,
  };
}

// ---------- Formatting helpers (used in summary strings) ----------

function money(n) {
  n = Number(n) || 0;
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  if (n > 0) return '<$0.01';
  return '$0';
}
function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toString();
}
