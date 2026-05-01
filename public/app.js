const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
};

const fmtFull = (n) => (Number(n) || 0).toLocaleString();

const fmtUSD = (n) => {
  n = Number(n) || 0;
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 10) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  if (n > 0) return '<$0.01';
  return '$0.00';
};
const fmtUSDFull = (n) => '$' + (Number(n) || 0).toFixed(4);

const fmtRel = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
};

const COLORS = {
  input: { from: '#34d399', to: '#10b981' },
  output: { from: '#fbbf24', to: '#f97316' },
  cacheRead: { from: '#22d3ee', to: '#3b82f6' },
  cacheCreate: { from: '#fb7185', to: '#e11d48' },
};

let currentFilter = 'all';
let currentCache = null;

function setKpiCost(elId, usd) {
  const el = document.getElementById(elId);
  if (!el) return;
  let costEl = el.parentElement.querySelector('.kpi-cost');
  if (!costEl) {
    costEl = document.createElement('div');
    costEl.className = 'kpi-cost';
    el.parentElement.insertBefore(costEl, el.nextSibling);
  }
  costEl.textContent = fmtUSD(usd);
  costEl.title = fmtUSDFull(usd);
}

function setKPIs(s) {
  const t = s.totals;
  const c = t.cost || {};
  document.getElementById('kpi-total').textContent = fmt(t.total);
  document.getElementById('kpi-total').title = fmtFull(t.total);
  document.getElementById('kpi-input').textContent = fmt(t.input);
  document.getElementById('kpi-input').title = fmtFull(t.input);
  document.getElementById('kpi-output').textContent = fmt(t.output);
  document.getElementById('kpi-output').title = fmtFull(t.output);
  document.getElementById('kpi-cacheread').textContent = fmt(t.cacheRead);
  document.getElementById('kpi-cacheread').title = fmtFull(t.cacheRead);
  document.getElementById('kpi-cachecreate').textContent = fmt(t.cacheCreate);
  document.getElementById('kpi-cachecreate').title = fmtFull(t.cacheCreate);
  document.getElementById('kpi-sessions').textContent = t.sessions;

  setKpiCost('kpi-total', c.total);
  setKpiCost('kpi-input', c.input);
  setKpiCost('kpi-output', c.output);
  setKpiCost('kpi-cacheread', c.cacheRead);
  setKpiCost('kpi-cachecreate', c.cacheCreate);
}

function renderAgentBars(agentKey, data) {
  const cost = data.cost || {};
  const totals = [
    { key: 'input', label: 'Input', val: data.input, usd: cost.input },
    { key: 'output', label: 'Output', val: data.output, usd: cost.output },
    { key: 'cacheRead', label: 'Cache Read', val: data.cacheRead, usd: cost.cacheRead },
    { key: 'cacheCreate', label: 'Cache Write', val: data.cacheCreate || 0, usd: cost.cacheCreate },
  ];
  const max = Math.max(1, ...totals.map(x => x.val));
  const wrap = document.getElementById(agentKey + '-bars');
  wrap.innerHTML = totals.map(t => {
    const pct = (t.val / max) * 100;
    const c = COLORS[t.key];
    return `
      <div class="bar-row">
        <span class="lbl">${t.label}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%; --c-from:${c.from}; --c-to:${c.to};"></div>
        </div>
        <div class="val-stack">
          <span class="val" title="${fmtFull(t.val)}">${fmt(t.val)}</span>
          <span class="usd" title="${fmtUSDFull(t.usd)}">${fmtUSD(t.usd)}</span>
        </div>
      </div>`;
  }).join('');
  document.getElementById(agentKey + '-sessions').textContent = data.sessions;
  const badge = document.getElementById(agentKey + '-total');
  badge.innerHTML = `${fmt(data.total)} <span class="badge-usd">${fmtUSD(cost.total)}</span>`;
  badge.title = `${fmtFull(data.total)} tokens · ${fmtUSDFull(cost.total)}`;
}

function renderCompositionInto(barEl, legendEl, t) {
  const cost = t.cost || {};
  const segs = [
    { key: 'cacheRead', label: 'Cache Read', val: t.cacheRead, usd: cost.cacheRead, color: COLORS.cacheRead },
    { key: 'input', label: 'Input', val: t.input, usd: cost.input, color: COLORS.input },
    { key: 'output', label: 'Output', val: t.output, usd: cost.output, color: COLORS.output },
    { key: 'cacheCreate', label: 'Cache Write', val: t.cacheCreate, usd: cost.cacheCreate, color: COLORS.cacheCreate },
  ];
  const total = segs.reduce((a, x) => a + x.val, 0) || 1;
  barEl.innerHTML = segs.map(s => {
    const pct = (s.val / total) * 100;
    if (pct < 0.1) return '';
    return `<div class="seg" style="flex:${s.val}; background:linear-gradient(135deg, ${s.color.from}, ${s.color.to});" title="${s.label}: ${fmtFull(s.val)} tokens · ${fmtUSDFull(s.usd)} (${pct.toFixed(1)}%)">${pct > 5 ? pct.toFixed(1) + '%' : ''}</div>`;
  }).join('');

  legendEl.innerHTML = segs.map(s => `
    <div class="legend-item">
      <span class="legend-dot" style="background:linear-gradient(135deg, ${s.color.from}, ${s.color.to});"></span>
      <span>${s.label}</span>
      <strong style="color: var(--text); font-family: 'JetBrains Mono', monospace;">${fmt(s.val)}</strong>
      <span class="legend-usd">${fmtUSD(s.usd)}</span>
      <span style="color: var(--text-mute);">(${((s.val / total) * 100).toFixed(1)}%)</span>
    </div>
  `).join('');
}

function renderComposition(t) {
  renderCompositionInto(
    document.getElementById('composition-bar'),
    document.getElementById('legend'),
    t
  );
}

function renderTable(sessions) {
  const filtered = currentFilter === 'all' ? sessions : sessions.filter(s => s.source === currentFilter);
  const tbody = document.getElementById('sessions-body');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:32px; color:var(--text-mute);">No sessions found</td></tr>';
    return;
  }
  const cellTok = (val, usd) => `<td class="num" title="${fmtFull(val)} tokens · ${fmtUSDFull(usd)}">
      <div class="num-stack"><span>${fmt(val)}</span><span class="usd-sub">${fmtUSD(usd)}</span></div>
    </td>`;
  tbody.innerHTML = filtered.slice(0, 100).map(s => {
    const proj = s.project.length > 50 ? '…' + s.project.slice(-47) : s.project;
    const c = s.cost || {};
    return `
      <tr>
        <td><span class="src-pill ${s.source}">${s.source}</span></td>
        <td><span class="proj-cell" title="${s.project}">${proj}</span></td>
        <td><span class="model-cell" title="${c.fallback ? 'fallback pricing' : 'priced'}">${s.model || '—'}${c.fallback ? ' <span class="fb">≈</span>' : ''}</span></td>
        ${cellTok(s.input, c.input)}
        ${cellTok(s.output, c.output)}
        ${cellTok(s.cacheRead, c.cacheRead)}
        ${cellTok(s.cacheCreate || 0, c.cacheCreate)}
        <td class="num" style="font-weight:600;" title="${fmtFull(s.total)} tokens · ${fmtUSDFull(c.total)}">
          <div class="num-stack"><span>${fmt(s.total)}</span><span class="usd-sub usd-total">${fmtUSD(c.total)}</span></div>
        </td>
        <td class="time-cell" title="${s.lastTs || ''}">${fmtRel(s.lastTs)}</td>
      </tr>`;
  }).join('');
}

function render(cache, animate = false) {
  if (!cache || !cache.summary) return;
  currentCache = cache;
  setKPIs(cache.summary);
  renderAgentBars('claude', cache.summary.claude);
  renderAgentBars('codex', { ...cache.summary.codex, cacheCreate: 0 });
  renderComposition(cache.summary.totals);
  renderTable(cache.sessions);

  const date = new Date(cache.ts);
  document.getElementById('last-update').textContent =
    date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (animate) {
    document.querySelectorAll('.kpi').forEach(k => {
      k.classList.remove('flash');
      void k.offsetWidth;
      k.classList.add('flash');
    });
  }

  // Re-render projects view if currently shown
  const hash = location.hash || '#/';
  if (hash.startsWith('#/projects')) {
    const m = hash.match(/^#\/projects\/(.+)$/);
    if (m) renderProjectDetail(decodeURIComponent(m[1]));
    else renderProjectsList(buildProjects(cache.sessions));
  }
}

document.querySelectorAll('.chip[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    if (currentCache) renderTable(currentCache.sessions);
  });
});

// ===== Projects view =====

let projectFilter = 'all';

function projectKey(s) {
  // Normalize path: collapse double slashes, strip trailing slash
  return (s.project || 'unknown').replace(/\/+/g, '/').replace(/\/$/, '');
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

function buildProjects(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = projectKey(s);
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: s.projectLabel || deriveProjectLabel(key),
        path: key,
        sessions: [],
        sources: new Set(),
        models: new Set(),
        input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
        lastTs: null,
      });
    }
    const p = map.get(key);
    p.sessions.push(s);
    p.sources.add(s.source);
    if (s.model) p.models.add(s.model);
    p.input += s.input || 0;
    p.output += s.output || 0;
    p.cacheRead += s.cacheRead || 0;
    p.cacheCreate += s.cacheCreate || 0;
    p.total += s.total || 0;
    if (s.cost) {
      p.cost.input += s.cost.input || 0;
      p.cost.output += s.cost.output || 0;
      p.cost.cacheRead += s.cost.cacheRead || 0;
      p.cost.cacheCreate += s.cost.cacheCreate || 0;
      p.cost.total += s.cost.total || 0;
    }
    if (s.lastTs && (!p.lastTs || s.lastTs > p.lastTs)) p.lastTs = s.lastTs;
  }
  return [...map.values()].sort((a, b) => b.cost.total - a.cost.total);
}

function renderProjectsList(projects) {
  const filtered = projectFilter === 'all'
    ? projects
    : projects.filter(p => p.sources.has(projectFilter));
  const grid = document.getElementById('projects-grid');
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1; text-align:center; color:var(--text-mute);">No projects found</div>';
    return;
  }
  grid.innerHTML = filtered.map(p => {
    const segs = [
      { val: p.cacheRead, color: COLORS.cacheRead },
      { val: p.input, color: COLORS.input },
      { val: p.output, color: COLORS.output },
      { val: p.cacheCreate, color: COLORS.cacheCreate },
    ];
    const total = segs.reduce((a, x) => a + x.val, 0) || 1;
    const segHtml = segs.map(s => s.val > 0 ? `<div class="seg" style="flex:${s.val}; background:linear-gradient(135deg, ${s.color.from}, ${s.color.to});"></div>` : '').join('');
    const sources = [...(p.sources || [])].map(s => `<span class="meta-pill ${s}">${s}</span>`).join('');
    const initial = (p.name || 'P').charAt(0).toUpperCase();
    return `
      <a class="project-card" href="#/projects/${encodeURIComponent(p.key)}">
        <div class="project-card-head">
          <div class="proj-icon">${initial}</div>
          <div style="flex:1; min-width:0;">
            <h3 title="${p.name}">${p.name}</h3>
            <div class="proj-path" title="${p.path}">${p.path}</div>
          </div>
        </div>
        <div class="project-card-meta">
          ${sources}
          <span class="meta-pill">${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}</span>
          <span class="meta-pill">${fmtRel(p.lastTs)}</span>
        </div>
        <div class="project-card-total">
          <div>
            <div class="num" title="${fmtFull(p.total)} tokens">${fmt(p.total)}</div>
            <div class="lbl">total tokens</div>
          </div>
          <div style="text-align:right;">
            <div class="num" title="${fmtUSDFull(p.cost.total)}">${fmtUSD(p.cost.total)}</div>
            <div class="lbl">est. cost</div>
          </div>
        </div>
        <div class="project-card-bar">${segHtml}</div>
        <div class="project-card-stats">
          <div class="stat"><span class="stat-lbl">Input</span><span class="stat-val" title="${fmtFull(p.input)} tokens · ${fmtUSDFull(p.cost.input)}">${fmt(p.input)}</span><span class="stat-usd">${fmtUSD(p.cost.input)}</span></div>
          <div class="stat"><span class="stat-lbl">Output</span><span class="stat-val" title="${fmtFull(p.output)} tokens · ${fmtUSDFull(p.cost.output)}">${fmt(p.output)}</span><span class="stat-usd">${fmtUSD(p.cost.output)}</span></div>
          <div class="stat"><span class="stat-lbl">Cache R</span><span class="stat-val" title="${fmtFull(p.cacheRead)} tokens · ${fmtUSDFull(p.cost.cacheRead)}">${fmt(p.cacheRead)}</span><span class="stat-usd">${fmtUSD(p.cost.cacheRead)}</span></div>
          <div class="stat"><span class="stat-lbl">Cache W</span><span class="stat-val" title="${fmtFull(p.cacheCreate)} tokens · ${fmtUSDFull(p.cost.cacheCreate)}">${fmt(p.cacheCreate)}</span><span class="stat-usd">${fmtUSD(p.cost.cacheCreate)}</span></div>
        </div>
      </a>`;
  }).join('');
}

function renderProjectDetail(key) {
  if (!currentCache) return;
  const projects = buildProjects(currentCache.sessions);
  const p = projects.find(pr => pr.key === key);
  if (!p) {
    document.getElementById('projects-list-wrap').hidden = false;
    document.getElementById('project-detail').hidden = true;
    return;
  }
  document.getElementById('projects-list-wrap').hidden = true;
  const detail = document.getElementById('project-detail');
  detail.hidden = false;

  document.getElementById('pd-icon').textContent = (p.name || 'P').charAt(0).toUpperCase();
  document.getElementById('pd-name').textContent = p.name;
  document.getElementById('pd-path').textContent = p.path;
  document.getElementById('pd-sessions').textContent = p.sessions.length;
  document.getElementById('pd-total').innerHTML = `${fmt(p.total)} <span class="hero-usd">${fmtUSD(p.cost.total)}</span>`;
  document.getElementById('pd-total').title = `${fmtFull(p.total)} tokens · ${fmtUSDFull(p.cost.total)}`;

  const setPdKpi = (id, tok, usd) => {
    document.getElementById(id).textContent = fmt(tok);
    document.getElementById(id).title = `${fmtFull(tok)} tokens · ${fmtUSDFull(usd)}`;
  };
  setPdKpi('pd-input', p.input, p.cost.input);
  setPdKpi('pd-output', p.output, p.cost.output);
  setPdKpi('pd-cacheread', p.cacheRead, p.cost.cacheRead);
  setPdKpi('pd-cachecreate', p.cacheCreate, p.cost.cacheCreate);
  setKpiCost('pd-input', p.cost.input);
  setKpiCost('pd-output', p.cost.output);
  setKpiCost('pd-cacheread', p.cost.cacheRead);
  setKpiCost('pd-cachecreate', p.cost.cacheCreate);

  renderCompositionInto(
    document.getElementById('pd-composition'),
    document.getElementById('pd-legend'),
    p
  );

  // sessions table
  const sessions = [...p.sessions].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  document.getElementById('pd-session-count').textContent =
    `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ordered by latest activity`;
  const tbody = document.getElementById('pd-sessions-body');
  const cellTok = (val, usd) => `<td class="num" title="${fmtFull(val)} tokens · ${fmtUSDFull(usd)}">
      <div class="num-stack"><span>${fmt(val)}</span><span class="usd-sub">${fmtUSD(usd)}</span></div>
    </td>`;
  tbody.innerHTML = sessions.map(s => {
    const c = s.cost || {};
    const displayName = escapeHtml(s.name || s.id || '—');
    return `
      <tr>
        <td><span class="src-pill ${s.source}">${s.source}</span></td>
        <td><span class="session-name" title="${escapeHtml(s.id)}">${displayName}</span></td>
        <td><span class="model-cell" title="${c.fallback ? 'fallback pricing' : 'priced'}">${s.model || '—'}${c.fallback ? ' <span class="fb">≈</span>' : ''}</span></td>
        ${cellTok(s.input, c.input)}
        ${cellTok(s.output, c.output)}
        ${cellTok(s.cacheRead, c.cacheRead)}
        ${cellTok(s.cacheCreate || 0, c.cacheCreate)}
        <td class="num" style="font-weight:600;" title="${fmtFull(s.total)} tokens · ${fmtUSDFull(c.total)}">
          <div class="num-stack"><span>${fmt(s.total)}</span><span class="usd-sub usd-total">${fmtUSD(c.total)}</span></div>
        </td>
        <td class="time-cell" title="${s.firstTs || ''}">${fmtRel(s.firstTs)}</td>
        <td class="time-cell" title="${s.lastTs || ''}">${fmtRel(s.lastTs)}</td>
      </tr>`;
  }).join('');
}

// ===== Analysis view =====

let analysisCache = null;
let analysisSourceFilter = 'all';

const FINDING_LABELS = {
  'context-bloat': 'Context bloat',
  'cache-inefficiency': 'Cache misuse',
  'overpowered-model': 'Overpowered model',
  'output-heavy': 'Output-heavy',
  'reasoning-waste': 'Reasoning waste',
  'fragmented-sessions': 'Fragmented sessions',
};

function renderAnalysis(report) {
  if (!report) return;
  analysisCache = report;
  const s = report.summary;
  document.getElementById('ana-projects').textContent = s.projects;
  document.getElementById('ana-sessions').textContent = s.sessions;
  document.getElementById('ana-spend').textContent = fmtUSD(s.totalCost);
  document.getElementById('ana-spend').title = fmtUSDFull(s.totalCost);
  document.getElementById('ana-waste').textContent = fmtUSD(s.totalWasted);
  document.getElementById('ana-waste').title = fmtUSDFull(s.totalWasted);
  document.getElementById('ana-waste-pct').textContent =
    `${(s.wastePct * 100).toFixed(1)}% of total spend`;

  document.getElementById('ana-last').textContent = fmtRel(report.generatedAt);
  document.getElementById('ana-last').title = report.generatedAt;
  updateNextRunCountdown();

  // LLM / heuristic badge
  document.getElementById('llm-badge').hidden = !report.llmPowered;
  document.getElementById('heuristic-badge').hidden = !!report.llmPowered;

  // Tags
  document.getElementById('ana-tags').innerHTML = Object.entries(s.findingCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `<span class="ana-tag">${FINDING_LABELS[id] || id} <strong>${n}</strong></span>`)
    .join('') || '<span class="ana-tag">No findings yet</span>';

  // Project list
  const wrap = document.getElementById('ana-project-list');
  if (!report.projects.length) {
    wrap.innerHTML = '<div class="ana-empty">No projects scanned yet.</div>';
    return;
  }
  const withFindings = report.projects.filter(p => p.findings.length > 0);
  const visible = analysisSourceFilter === 'all'
    ? withFindings
    : withFindings.filter(p => (p.sources || []).includes(analysisSourceFilter));
  if (!visible.length) {
    wrap.innerHTML = '<div class="ana-empty">All clear — no wasteful patterns detected across your projects. 🎉</div>';
    return;
  }
  // Update tab count
  const countEl = document.getElementById('ana-tab-count');
  if (countEl) countEl.textContent = `${visible.length} project${visible.length === 1 ? '' : 's'}`;

  wrap.innerHTML = visible.length
    ? visible.map((p, idx) => renderAnaProject(p, idx === 0)).join('')
    : `<div class="ana-empty">No ${analysisSourceFilter === 'all' ? '' : analysisSourceFilter + ' '}projects with findings.</div>`;

  // Toggle behavior
  wrap.querySelectorAll('.ana-proj-head').forEach(h => {
    h.addEventListener('click', () => {
      const proj = h.parentElement;
      if (proj.hasAttribute('open')) proj.removeAttribute('open');
      else proj.setAttribute('open', '');
    });
  });
}

function renderAnaProject(p, openFirst) {
  const name = p.projectLabel || deriveProjectLabel(p.project);
  const initial = name.replace(/\s+\[.*$/, '').trim().charAt(0).toUpperCase();
  const srcPills = (p.sources || []).map(s =>
    `<span class="ana-src-pill ${s}">${s}</span>`
  ).join('');
  const llmTag = (p.llmAnalyzed || p.llmCached)
    ? `<span class="llm-tag">${p.llmCached ? '✦ cached' : '✦ haiku'}</span>` : '';
  const wastePct = p.totalCost > 0 ? (p.wastedCost / p.totalCost * 100) : 0;
  const findingsHtml = p.findings.map(f => renderFinding(f, p.project)).join('');
  const modelMix = p.modelMix.slice(0, 6).map(m => `
    <span class="model-mix-item ${m.tier}" title="${fmtFull(m.tokens)} tokens · ${fmtUSDFull(m.cost)}">
      <span class="mm-tier"></span>
      <span style="font-family:'JetBrains Mono',monospace;">${m.model}</span>
      <span style="color:var(--text-mute);">${m.sessions}s</span>
      <span style="color:#34d399;font-weight:600;">${fmtUSD(m.cost)}</span>
    </span>
  `).join('');
  return `
    <div class="ana-project" ${openFirst ? 'open' : ''}>
      <div class="ana-proj-head">
        <div class="proj-icon">${initial}</div>
        <div class="ana-proj-meta">
          <h3>${name} <span class="ana-src-pills">${srcPills}</span>${llmTag}</h3>
          <div class="path" title="${p.project}">${p.project}</div>
        </div>
        <div class="ana-proj-stats">
          <div class="ana-proj-stat">
            <span class="stat-lbl">Sessions</span>
            <span class="stat-val">${p.sessionCount}</span>
          </div>
          <div class="ana-proj-stat">
            <span class="stat-lbl">Spent</span>
            <span class="stat-val" title="${fmtUSDFull(p.totalCost)}">${fmtUSD(p.totalCost)}</span>
          </div>
          <div class="ana-proj-stat waste">
            <span class="stat-lbl">Wasted</span>
            <span class="stat-val" title="${fmtUSDFull(p.wastedCost)}">${fmtUSD(p.wastedCost)} <span style="color:var(--text-mute); font-weight:500; font-size:11px;">(${wastePct.toFixed(0)}%)</span></span>
          </div>
          <div class="ana-proj-stat">
            <span class="stat-lbl">Findings</span>
            <span class="stat-val">${p.findings.length}</span>
          </div>
        </div>
        <span class="ana-proj-toggle">▾</span>
      </div>
      <div class="ana-proj-body">
        ${modelMix ? `<div class="model-mix">${modelMix}</div>` : ''}
        <div class="findings-list">${findingsHtml}</div>
      </div>
    </div>
  `;
}

// Approximate $/token rate to convert savings into a token equivalent
function approxTokensFromCost(usd) {
  // Use a blended Sonnet-ish rate ~$3 / 1M = $0.000003 per token
  // Inverted for display only.
  return Math.round((Number(usd) || 0) / 0.000003);
}

function renderFinding(f, projectKey) {
  const examples = (f.examples || []).map(ex => {
    const parts = [];
    const display = ex.sessionName || `session ${(ex.sessionId || '').slice(0, 8)}`;
    parts.push(`<span class="ex-id" title="${escapeHtml(ex.sessionId || '')}">${escapeHtml(display)}</span>`);
    if (ex.model) parts.push(`<span class="ex-key">model</span><span class="ex-val">${ex.model}</span>`);
    if (ex.ratio !== undefined) parts.push(`<span class="ex-key">ratio</span><span class="ex-val">${ex.ratio}</span>`);
    if (ex.cacheCreate !== undefined) parts.push(`<span class="ex-key">cache W</span><span class="ex-val">${fmt(ex.cacheCreate)}</span>`);
    if (ex.cacheRead !== undefined && f.id !== 'context-bloat') parts.push(`<span class="ex-key">cache R</span><span class="ex-val">${fmt(ex.cacheRead)}</span>`);
    if (ex.output !== undefined && (f.id === 'context-bloat' || f.id === 'reasoning-waste')) parts.push(`<span class="ex-key">output</span><span class="ex-val">${fmt(ex.output)}</span>`);
    if (ex.cacheRead !== undefined && f.id === 'context-bloat') parts.push(`<span class="ex-key">cache R</span><span class="ex-val">${fmt(ex.cacheRead)}</span>`);
    if (ex.outputShare !== undefined) parts.push(`<span class="ex-key">output share</span><span class="ex-val">${ex.outputShare}</span>`);
    if (ex.reasoning !== undefined) parts.push(`<span class="ex-key">reasoning</span><span class="ex-val">${fmt(ex.reasoning)}</span>`);
    if (ex.total !== undefined && f.id === 'overpowered-model') parts.push(`<span class="ex-key">total</span><span class="ex-val">${fmt(ex.total)}</span>`);
    if (ex.messages !== undefined) parts.push(`<span class="ex-key">msgs</span><span class="ex-val">${ex.messages}</span>`);

    const costNum = ex.wastedCost ?? ex.savings ?? ex.cacheReadCost ?? ex.outputCost ?? ex.cost;
    if (costNum !== undefined) parts.push(`<span class="ex-cost">${fmtUSD(costNum)}</span>`);
    if (ex.lastTs) parts.push(`<span class="ex-key" style="margin-left:8px;">${fmtRel(ex.lastTs)}</span>`);
    return `<div class="finding-example">${parts.join(' ')}</div>`;
  }).join('');

  const ap = f.applied;
  const isApplied = !!ap;
  const isResolved = ap?.resolved;
  const realized = ap?.realizedSavedCost || 0;

  let actionHtml;
  if (isResolved) {
    actionHtml = `<span class="applied-pill resolved">✓ Resolved · ${fmtUSD(realized)} saved</span>`;
  } else if (isApplied) {
    actionHtml = `
      <span class="applied-pill">✓ Applied ${fmtRel(ap.appliedAt)}</span>
      <button class="btn-apply" style="background:rgba(255,255,255,0.06); color:var(--text-dim); box-shadow:none;" data-action="unapply" data-project="${encodeURIComponent(projectKey)}" data-finding="${f.id}">Undo</button>`;
  } else {
    actionHtml = `<button class="btn-apply" data-action="apply" data-project="${encodeURIComponent(projectKey)}" data-finding="${f.id}">Apply suggestion →</button>`;
  }

  let banner = '';
  if (isApplied && realized > 0.005) {
    banner = `<div class="realized-banner">📉 Since applied: <strong>${fmtUSD(realized)}</strong> saved · was costing <span class="mono">${fmtUSD(ap.baselineCost)}</span></div>`;
  } else if (isApplied && !isResolved) {
    banner = `<div class="realized-banner">⏳ Tracking: baseline <strong>${fmtUSD(ap.baselineCost)}</strong>. Savings will appear after the next analysis run picks up new sessions.</div>`;
  }

  return `
    <div class="finding" data-sev="${f.severity}" data-applied="${isApplied}">
      <div class="finding-head">
        <span class="sev-pill">${f.severity}</span>
        <span class="finding-title">${f.title}</span>
      </div>
      <div class="finding-summary">${f.summary}</div>
      <div class="finding-impact">${f.impact}</div>
      <div class="finding-rec">${f.recommendation}</div>
      <div class="finding-actions">${actionHtml}</div>
      ${banner}
      ${examples ? `<div class="finding-examples-title" style="margin-top:12px;">Sample sessions</div>${examples}` : ''}
    </div>
  `;
}

function updateNextRunCountdown() {
  if (!analysisCache?.nextRunAt) return;
  const ms = new Date(analysisCache.nextRunAt).getTime() - Date.now();
  const el = document.getElementById('ana-next');
  if (!el) return;
  if (ms <= 0) {
    el.textContent = 'any moment';
    return;
  }
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  el.textContent = h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}
setInterval(updateNextRunCountdown, 30_000);

// ----- Wire stats poller (shows bandwidth savings) -----

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}
async function refreshWireStats() {
  try {
    const r = await fetch('/api/wirestats');
    const s = await r.json();
    const el = document.getElementById('wire-stats');
    if (!el) return;
    if (s.patchSent === 0) {
      el.innerHTML = `delta: <strong>idle</strong> · waiting for first update`;
      return;
    }
    el.innerHTML = `delta: <strong>${fmtBytes(s.patchBytes)}</strong> sent over ${s.patchSent} update${s.patchSent === 1 ? '' : 's'} · would have been <span class="raw">${fmtBytes(s.wouldHaveBeenBytes)}</span> · <span class="saved">saved ${(s.savedPct * 100).toFixed(1)}%</span>`;
  } catch {}
}
refreshWireStats();
setInterval(refreshWireStats, 5000);

// ----- Modal & toast helpers -----

function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-content').innerHTML = html;
  overlay.hidden = false;
}
function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
}
document.addEventListener('click', (e) => {
  if (e.target?.id === 'modal-close' || e.target?.id === 'modal-overlay' || e.target?.dataset?.close === 'modal') {
    closeModal();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function showToast({ title, body, durationMs = 6000 }) {
  const stack = document.getElementById('toast-stack');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<div class="toast-title">${title}</div><div class="toast-body">${body}</div>`;
  stack.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 350);
  }, durationMs);
}

const RECOMMENDATION_CHECKLISTS = {
  'context-bloat': [
    'Trim CLAUDE.md / AGENTS.md to essentials',
    'Drop unused subagents from the loaded set',
    'Use /compact between unrelated phases',
    'Start a fresh session for new tasks',
  ],
  'cache-inefficiency': [
    'Keep one long-lived session per task',
    'Pin stable system prompt and rarely-changing context once',
    'Avoid editing files at the top of the prompt mid-task',
  ],
  'overpowered-model': [
    'Use Sonnet/4o-mini for short turns and one-shots',
    'Reserve Opus / o1 for deep multi-file work',
    'Switch model per-task with /model when supported',
  ],
  'output-heavy': [
    'Ask for diffs/patches instead of full files',
    'Add "no explanation" when the change is self-evident',
    'Avoid repeating the plan after every step',
  ],
  'reasoning-waste': [
    'Lower reasoning effort for routine queries',
    'Pick a smaller model for boilerplate work',
    'Reserve high-reasoning models for genuinely hard problems',
  ],
  'fragmented-sessions': [
    'Use /clear instead of restarting the CLI',
    'Stay in one session per feature',
    'Batch quick questions into the same session',
  ],
};

function showPreviewModal(preview, project, findingId) {
  if (!preview.actionable) {
    // Behavioral or non-actionable — clear messaging + offer "track only"
    const checklist = (RECOMMENDATION_CHECKLISTS[findingId] || []).map(x => `<div>· ${x}</div>`).join('');
    showModal(`
      <div class="modal-celebrate" style="text-align:left;">
        <div style="text-align:center;">
          <span class="emoji">${preview.behavioral ? '🧭' : '🤔'}</span>
          <h2 style="text-align:center;">${preview.behavioral ? 'Behavioral change required' : "Can't auto-apply this"}</h2>
        </div>
        <p class="subtitle" style="text-align:center;">${preview.reason}</p>
        ${checklist ? `<div class="modal-checklist"><strong>What to actually do</strong>${checklist}</div>` : ''}
        <p class="subtitle" style="text-align:center;">You can still mark this as "applied" so we'll track whether your behavior change reduces waste over the next runs.</p>
        <div style="display:flex; gap:10px; justify-content:center;">
          <button class="modal-cta" data-action="track-only" data-project="${encodeURIComponent(project)}" data-finding="${findingId}">Track from now</button>
          <button class="modal-cta" style="background:rgba(255,255,255,0.06); color:var(--text);" data-close="modal">Cancel</button>
        </div>
      </div>
    `);
    return;
  }

  // Actionable — show the diff/changes and let user confirm
  const changesHtml = preview.changes.map(c => `
    <div class="diff-block">
      <div class="diff-file">${c.file}</div>
      <div class="diff-stats">
        <span>${c.bytesBefore} → ${c.bytesAfter} bytes</span>
        <span class="diff-delta">${c.bytesDelta > 0 ? '−' : '+'}${Math.abs(c.bytesDelta)} B</span>
      </div>
      <pre class="diff-preview">${escapeHtml(c.preview || '')}</pre>
    </div>
  `).join('');
  showModal(`
    <div class="modal-celebrate" style="text-align:left;">
      <div style="text-align:center;">
        <span class="emoji">🛠️</span>
        <h2 style="text-align:center;">Review the change</h2>
        <p class="subtitle" style="text-align:center;">${preview.summary}</p>
        <div class="savings-cap">Projected savings</div>
        <div class="savings-bigfig">${fmtUSD(preview.projectedSavings)}</div>
      </div>
      <div class="diff-list">${changesHtml}</div>
      <p class="subtitle" style="text-align:center; font-size: 11px; margin: 14px 0;">A timestamped backup of every file is created at <code>~/.agent-optimization/backups/</code> before writing.</p>
      <div style="display:flex; gap:10px; justify-content:center;">
        <button class="modal-cta" data-action="commit" data-token="${preview.token}">Apply change</button>
        <button class="modal-cta" style="background:rgba(255,255,255,0.06); color:var(--text);" data-close="modal">Cancel</button>
      </div>
    </div>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
}

function showAppliedModal({ findingTitle, findingId, projectedSavings, actuated, actuation }) {
  const tokens = approxTokensFromCost(projectedSavings);
  const wroteFiles = actuated && actuation?.written?.length
    ? `<div class="modal-checklist"><strong>Files written</strong>${actuation.written.map(w => `<div style="font-family:'JetBrains Mono',monospace; font-size:11px;">✓ ${w.file}${w.backup ? ` <span style="color:var(--text-mute);">→ backup ${w.backup.split('/').pop()}</span>` : ''}</div>`).join('')}</div>`
    : '';
  const checklist = !actuated && (RECOMMENDATION_CHECKLISTS[findingId] || []).length
    ? `<div class="modal-checklist"><strong>Things only you can change</strong>${RECOMMENDATION_CHECKLISTS[findingId].map(x => `<div>· ${x}</div>`).join('')}</div>`
    : '';
  showModal(`
    <div class="modal-celebrate">
      <span class="emoji">${actuated ? '✅' : '🎯'}</span>
      <h2>${actuated ? 'Change applied' : 'Tracking enabled'}</h2>
      <p class="subtitle"><strong>${findingTitle}</strong> ${actuated ? 'has been auto-applied. Files updated.' : 'is now being tracked. Future runs will measure savings.'}</p>
      <div class="savings-cap">${actuated ? 'Projected savings' : 'Potential savings'}</div>
      <div class="savings-bigfig">${fmtUSD(projectedSavings)}</div>
      <div class="savings-stats">
        <div class="savings-stat"><div class="lbl">Equivalent tokens</div><div class="val">${fmt(tokens)}</div></div>
        <div class="savings-stat"><div class="lbl">Re-check in</div><div class="val" id="modal-next">—</div></div>
      </div>
      ${wroteFiles}
      ${checklist}
      <button class="modal-cta" data-close="modal">Got it</button>
    </div>
  `);
  if (analysisCache?.nextRunAt) {
    const ms = new Date(analysisCache.nextRunAt).getTime() - Date.now();
    const mins = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const el = document.getElementById('modal-next');
    if (el) el.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
}

function showSavingsRealizedModal(events) {
  const totalSaved = events.reduce((a, e) => a + (e.delta || 0), 0);
  const tokens = approxTokensFromCost(totalSaved);
  const lines = events.slice(0, 5).map(ev => {
    const projShort = ev.project.split('/').filter(Boolean).pop() || ev.project;
    return `<div>· <strong style="color:var(--text);">${projShort}</strong> · ${ev.findingId} · <span style="color:#34d399; font-family:'JetBrains Mono', monospace;">+${fmtUSD(ev.delta)} ${ev.resolved ? '· resolved' : ''}</span></div>`;
  }).join('');
  showModal(`
    <div class="modal-celebrate">
      <span class="emoji">💰</span>
      <h2>Savings realized!</h2>
      <p class="subtitle">Your applied suggestions reduced waste in the latest analysis.</p>
      <div class="savings-cap">Realized this run</div>
      <div class="savings-bigfig">${fmtUSD(totalSaved)}</div>
      <div class="savings-stats">
        <div class="savings-stat"><div class="lbl">Equivalent tokens</div><div class="val">${fmt(tokens)}</div></div>
        <div class="savings-stat"><div class="lbl">Findings improved</div><div class="val">${events.length}</div></div>
      </div>
      <div class="modal-checklist"><strong>Where it came from</strong>${lines}</div>
      <button class="modal-cta" data-close="modal">Nice</button>
    </div>
  `);
}

document.addEventListener('click', async (e) => {
  if (e.target?.id === 'ana-rerun') {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      const r = await fetch('/api/analysis/run', { method: 'POST' });
      const data = await r.json();
      renderAnalysis(data);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run now';
    }
    return;
  }
  // Modal "track from now" or "commit" handlers
  if (e.target?.dataset?.action === 'track-only') {
    const project = decodeURIComponent(e.target.dataset.project);
    const findingId = e.target.dataset.finding;
    const r = await fetch('/api/analysis/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, findingId }), // no token = behavioral apply
    });
    const data = await r.json();
    if (data.ok) {
      showAppliedModal({
        findingTitle: data.finding.title,
        findingId,
        projectedSavings: data.projectedSavings,
        actuated: false,
      });
      const r2 = await fetch('/api/analysis');
      renderAnalysis(await r2.json());
    }
    return;
  }
  if (e.target?.dataset?.action === 'commit') {
    const token = e.target.dataset.token;
    e.target.disabled = true;
    e.target.textContent = 'Applying…';
    const r = await fetch('/api/analysis/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await r.json();
    if (data.ok) {
      showAppliedModal({
        findingTitle: data.finding.title,
        findingId: data.finding.id,
        projectedSavings: data.projectedSavings,
        actuated: data.actuated,
        actuation: data.actuation,
      });
      const r2 = await fetch('/api/analysis');
      renderAnalysis(await r2.json());
    }
    return;
  }

  const btn = e.target?.closest('button.btn-apply');
  if (!btn) return;
  const project = decodeURIComponent(btn.dataset.project);
  const findingId = btn.dataset.finding;
  const action = btn.dataset.action;
  if (action === 'apply') {
    btn.disabled = true;
    btn.textContent = 'Previewing…';
    try {
      const r = await fetch('/api/analysis/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, findingId }),
      });
      const preview = await r.json();
      showPreviewModal(preview, project, findingId);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply suggestion →';
    }
  } else if (action === 'unapply') {
    await fetch('/api/analysis/unapply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, findingId }),
    });
    const r2 = await fetch('/api/analysis');
    renderAnalysis(await r2.json());
  }
});

document.addEventListener('click', (e) => {
  const tab = e.target?.closest('.ana-tab');
  if (!tab || !tab.dataset.asrc) return;
  document.querySelectorAll('.ana-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  analysisSourceFilter = tab.dataset.asrc;
  if (analysisCache) renderAnalysis(analysisCache);
});

document.querySelectorAll('.chip[data-pfilter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-pfilter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    projectFilter = btn.dataset.pfilter;
    if (currentCache) renderProjectsList(buildProjects(currentCache.sessions));
  });
});

// ===== Routing =====

function route() {
  const hash = location.hash || '#/';
  const overview = document.getElementById('view-overview');
  const projectsView = document.getElementById('view-projects');
  const analysisView = document.getElementById('view-analysis');
  const listWrap = document.getElementById('projects-list-wrap');
  const detail = document.getElementById('project-detail');

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

  overview.hidden = true;
  projectsView.hidden = true;
  analysisView.hidden = true;
  document.getElementById('view-charts').hidden = true;

  if (hash.startsWith('#/projects')) {
    projectsView.hidden = false;
    document.querySelector('.tab[data-route="projects"]').classList.add('active');
    const m = hash.match(/^#\/projects\/(.+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      listWrap.hidden = true;
      detail.hidden = false;
      renderProjectDetail(key);
    } else {
      listWrap.hidden = false;
      detail.hidden = true;
      if (currentCache) renderProjectsList(buildProjects(currentCache.sessions));
    }
  } else if (hash.startsWith('#/analysis')) {
    analysisView.hidden = false;
    document.querySelector('.tab[data-route="analysis"]').classList.add('active');
    if (!analysisCache) {
      fetch('/api/analysis').then(r => r.json()).then(renderAnalysis);
    } else {
      renderAnalysis(analysisCache);
    }
  } else if (hash.startsWith('#/charts')) {
    document.getElementById('view-charts').hidden = false;
    document.querySelector('.tab[data-route="charts"]').classList.add('active');
    loadCharts();
  } else {
    overview.hidden = false;
    document.querySelector('.tab[data-route="overview"]').classList.add('active');
  }
}
window.addEventListener('hashchange', route);

// ----- Patch appliers (delta updates) -----

function applyCachePatch(msg) {
  if (!currentCache) return;
  const byId = new Map(currentCache.sessions.map(s => [s.id, s]));
  for (const s of msg.added || []) byId.set(s.id, s);
  for (const s of msg.updated || []) byId.set(s.id, s);
  for (const id of msg.removed || []) byId.delete(id);
  const sessions = [...byId.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const next = { sessions, summary: msg.summary, ts: msg.ts };
  // Console telemetry — quick visibility into how skinny the patches are
  const changed = (msg.added?.length || 0) + (msg.updated?.length || 0) + (msg.removed?.length || 0);
  console.debug(`[delta] cache-patch v${msg.version}: ${changed} session(s) changed`);
  render(next, true);
}

function applyAnalysisPatch(msg) {
  if (!analysisCache) {
    // Patch arrived before we ever loaded the report — pull full once.
    fetch('/api/analysis').then(r => r.json()).then(renderAnalysis);
    return;
  }
  const byKey = new Map(analysisCache.projects.map(p => [p.project, p]));
  for (const p of msg.changedProjects || []) byKey.set(p.project, p);
  for (const k of msg.removedProjects || []) byKey.delete(k);
  const projects = [...byKey.values()].sort((a, b) => b.wastedCost - a.wastedCost);
  const next = {
    ...analysisCache,
    generatedAt: msg.generatedAt,
    nextRunAt: msg.nextRunAt,
    summary: msg.summary,
    applied: msg.applied,
    projects,
  };
  console.debug(`[delta] analysis-patch: ${msg.changedProjects?.length || 0} project(s) changed`);
  renderAnalysis(next);
}

// WebSocket connection
function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');

  ws.onopen = () => {
    dot.className = 'dot live';
    text.textContent = 'live';
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        render(msg.cache, false);
      } else if (msg.type === 'cache-patch') {
        applyCachePatch(msg);
      } else if (msg.type === 'analysis') {
        renderAnalysis(msg.analysis);
      } else if (msg.type === 'analysis-patch') {
        applyAnalysisPatch(msg);
      } else if (msg.type === 'savings-realized') {
        const events = msg.events || [];
        if (events.length) {
          const totalSaved = events.reduce((a, x) => a + (x.delta || 0), 0);
          showToast({
            title: 'Savings realized',
            body: `<span class="toast-amount">+${fmtUSD(totalSaved)}</span> from ${events.length} applied suggestion${events.length === 1 ? '' : 's'}. <a href="#/analysis" style="color:#22d3ee;">View details</a>`,
            durationMs: 9000,
          });
          // Auto-show celebration modal if user is on the analysis page
          if ((location.hash || '').startsWith('#/analysis')) {
            showSavingsRealizedModal(events);
          }
        }
      }
    } catch {}
  };
  ws.onclose = () => {
    dot.className = 'dot dead';
    text.textContent = 'reconnecting…';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// ===== Charts page =====

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 500 },
  plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
};

const CHART_COLORS = {
  claude: { bar: 'rgba(245,158,11,0.85)', border: '#f59e0b' },
  codex:  { bar: 'rgba(34,211,238,0.85)', border: '#22d3ee' },
};

let usageChart = null;
let claudeCtxChart = null;
let codexCtxChart = null;
let usageDays = 1;
let usageMetric = 'total';

function chartAxisColor() { return 'rgba(255,255,255,0.25)'; }
function chartGridColor() { return 'rgba(255,255,255,0.07)'; }
function chartTextColor() { return '#9a9ab0'; }

function buildUsageChart(days) {
  const canvas = document.getElementById('chart-usage');
  if (!canvas) return;
  fetch(`/api/charts/usage?days=${days}`)
    .then(r => r.json())
    .then(({ days: data }) => {
      const labels = data.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
      });
      const claudeVals = data.map(d => usageMetric === 'cost' ? +(d.claude.cost.toFixed(4)) : d.claude.total);
      const codexVals  = data.map(d => usageMetric === 'cost' ? +(d.codex.cost.toFixed(4))  : d.codex.total);

      const axisLabel = usageMetric === 'cost' ? 'USD ($)' : 'Tokens';
      const tickFmt = usageMetric === 'cost'
        ? v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'K' : v.toFixed(2))
        : v => v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v;

      const tooltipFmt = usageMetric === 'cost'
        ? v => '$' + Number(v).toFixed(4)
        : v => Number(v).toLocaleString() + ' tokens';

      if (usageChart) usageChart.destroy();
      usageChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Claude Code',
              data: claudeVals,
              backgroundColor: CHART_COLORS.claude.bar,
              borderColor: CHART_COLORS.claude.border,
              borderWidth: 1,
              borderRadius: 5,
            },
            {
              label: 'Codex',
              data: codexVals,
              backgroundColor: CHART_COLORS.codex.bar,
              borderColor: CHART_COLORS.codex.border,
              borderWidth: 1,
              borderRadius: 5,
            },
          ],
        },
        options: {
          ...CHART_DEFAULTS,
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: 'rgba(15,15,30,0.95)',
              borderColor: 'rgba(167,139,250,0.3)',
              borderWidth: 1,
              titleColor: '#e8e8f0',
              bodyColor: '#9a9ab0',
              callbacks: { label: ctx => ` ${ctx.dataset.label}: ${tooltipFmt(ctx.parsed.y)}` },
            },
          },
          scales: {
            x: {
              ticks: { color: chartTextColor(), font: { family: "'JetBrains Mono'" } },
              grid: { color: chartGridColor() },
            },
            y: {
              title: { display: true, text: axisLabel, color: chartTextColor() },
              ticks: { color: chartTextColor(), font: { family: "'JetBrains Mono'" }, callback: tickFmt },
              grid: { color: chartGridColor() },
            },
          },
        },
      });
    });
}

function buildContextChart(canvasId, emptyId, files, color) {
  const canvas = document.getElementById(canvasId);
  const emptyEl = document.getElementById(emptyId);
  if (!canvas) return;
  if (!files.length) {
    canvas.parentElement.hidden = true;
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  canvas.parentElement.hidden = false;
  if (emptyEl) emptyEl.hidden = true;

  // Limit to top 20 by bytes
  const top = files.slice(0, 20);
  const labels = top.map(f => f.label.length > 28 ? f.label.slice(0, 26) + '…' : f.label);
  const values = top.map(f => f.bytes);
  const colors = top.map(f => color + (f.type === 'CLAUDE.md' ? 'dd' : '99'));

  // Dynamic height
  canvas.parentElement.style.height = Math.max(200, top.length * 34) + 'px';

  const prev = canvasId === 'chart-claude-ctx' ? claudeCtxChart : codexCtxChart;
  if (prev) prev.destroy();

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Size (bytes)',
        data: values,
        backgroundColor: top.map(f =>
          f.type === 'CLAUDE.md' ? 'rgba(245,158,11,0.8)' : 'rgba(34,211,238,0.8)'
        ),
        borderColor: top.map(f => f.type === 'CLAUDE.md' ? '#f59e0b' : '#22d3ee'),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,15,30,0.95)',
          borderColor: 'rgba(167,139,250,0.3)',
          borderWidth: 1,
          titleColor: '#e8e8f0',
          bodyColor: '#9a9ab0',
          callbacks: {
            label: ctx => {
              const f = top[ctx.dataIndex];
              return ` ${f.bytes >= 1024 ? (f.bytes/1024).toFixed(1)+' KB' : f.bytes+' B'} · ${f.lines} lines · ${f.type}`;
            },
            title: ctxArr => top[ctxArr[0].dataIndex]?.label || '',
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: chartTextColor(),
            font: { family: "'JetBrains Mono'" },
            callback: v => v >= 1024 ? (v/1024).toFixed(0)+'KB' : v+'B',
          },
          grid: { color: chartGridColor() },
        },
        y: {
          ticks: { color: chartTextColor(), font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
  if (canvasId === 'chart-claude-ctx') claudeCtxChart = chart;
  else codexCtxChart = chart;
}

async function loadCharts() {
  buildUsageChart(usageDays);
  const r = await fetch('/api/charts/context-files');
  const { claude, codex } = await r.json();
  buildContextChart('chart-claude-ctx', 'chart-claude-ctx-empty', claude, '#f59e0b');
  buildContextChart('chart-codex-ctx',  'chart-codex-ctx-empty',  codex,  '#22d3ee');
}

document.getElementById('usage-range')?.addEventListener('click', e => {
  const btn = e.target.closest('.ctrl-btn');
  if (!btn || !btn.dataset.days) return;
  document.querySelectorAll('#usage-range .ctrl-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  usageDays = parseInt(btn.dataset.days);
  buildUsageChart(usageDays);
});

document.getElementById('usage-metric')?.addEventListener('click', e => {
  const btn = e.target.closest('.ctrl-btn');
  if (!btn || !btn.dataset.metric) return;
  document.querySelectorAll('#usage-metric .ctrl-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  usageMetric = btn.dataset.metric;
  buildUsageChart(usageDays);
});

// Initial fetch + live socket
fetch('/api/data').then(r => r.json()).then(c => { render(c); route(); });
connect();
route();

// Refresh relative timestamps every 30s
setInterval(() => {
  if (currentCache) renderTable(currentCache.sessions);
}, 30_000);
