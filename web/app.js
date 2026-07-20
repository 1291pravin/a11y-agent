// A11y Agent SPA. Hash routing, polls /api/state, renders 7 screens.
// No framework, no build step.

'use strict';

let S = null;            // latest server state
let selectedTask = null; // task id shown in the log pane

const main = document.getElementById('main');

// ── data ────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const res = await fetch('/api/state');
    S = await res.json();
    document.getElementById('mode-badge').textContent =
      S.mode.aqa === 'real' || S.mode.cursor === 'real' ? 'live' : 'demo';
    const resetBtn = document.getElementById('demo-reset');
    if (resetBtn) resetBtn.textContent = S.mode.aqa === 'real' ? 'Sync from AQA' : 'Reset demo data';
    render();
  } catch (err) {
    main.innerHTML = `<div class="empty">Server unreachable: ${esc(err.message)}</div>`;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── routing ─────────────────────────────────────────────────────────────────

function route() {
  const hash = location.hash || '#/dashboard';
  const parts = hash.slice(2).split('/');
  return { view: parts[0] || 'dashboard', id: parts[1] || null, sub: parts[2] || null };
}

function render() {
  if (!S) return;
  const r = route();
  document.querySelectorAll('#nav a').forEach((a) => {
    const v = a.dataset.view;
    a.classList.toggle('on', v === r.view || (v === 'sites' && r.view === 'site'));
  });
  const views = {
    dashboard: viewDashboard,
    sites: viewSites,
    site: viewSite,
    onboard: viewOnboard,
    tasks: viewTasks,
    prs: viewPrs,
    settings: viewSettings,
  };
  main.innerHTML = (views[r.view] || viewDashboard)(r);
  bindActions();
}

window.addEventListener('hashchange', render);

// ── screens ─────────────────────────────────────────────────────────────────

function viewDashboard() {
  const covered = S.sites.filter((x) => x.flows.length).length;
  const violations = S.sites.reduce((n, x) => n + (x.total || 0), 0);
  const openPrs = S.prs.filter((p) => p.state === 'open').length;
  const running = S.tasks.filter((t) => ['queued', 'working', 'verifying'].includes(t.state)).length;
  const order = { critical: 0, fixing: 1, onboarding: 2, healthy: 3 };
  const sites = [...S.sites].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  return `
    <div class="topline"><h1>Portfolio</h1>
      <a class="btn" href="#/onboard">+ Onboard site</a></div>
    <div class="cards">
      ${kpi(covered + '<small>/' + S.sites.length + '</small>', 'Sites covered')}
      ${kpi(violations, 'Open violations')}
      ${kpi(openPrs, 'Fix PRs open')}
      ${kpi(running, 'Agent tasks running')}
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Site</th><th>Status</th><th>Critical</th><th>Total</th><th>Trend</th><th>Last run</th></tr></thead>
      <tbody>${sites.map((x) => `
        <tr class="click" data-go="#/site/${x.id}">
          <td>${esc(x.url.replace('https://', ''))}</td>
          <td>${siteChip(x)}</td>
          <td class="tnum">${x.critical ?? '-'}</td>
          <td class="tnum">${x.total ?? '-'}</td>
          <td>${trendBar(x.trend)}</td>
          <td class="tnum">${esc(x.lastRun || '-')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function viewSites() {
  return `
    <div class="topline"><h1>Sites</h1><a class="btn" href="#/onboard">+ Onboard site</a></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Site</th><th>Repo</th><th>Suite</th><th>Framework</th><th>Status</th></tr></thead>
      <tbody>${S.sites.map((x) => `
        <tr class="click" data-go="#/site/${x.id}">
          <td>${esc(x.url.replace('https://', ''))}</td>
          <td class="mono">${esc(x.repo)}</td>
          <td class="mono">${esc(x.suiteId)}</td>
          <td>${esc(x.framework)}</td>
          <td>${siteChip(x)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function viewSite(r) {
  const site = S.sites.find((x) => x.id === r.id);
  if (!site) return `<div class="empty">Site not found.</div>`;
  const causes = S.causes.filter((c) => c.siteId === site.id);
  const urlFlows = site.flows.filter((f) => f.type === 'URL').length;
  const clickFlows = site.flows.filter((f) => f.type === 'Click-state').length;
  const skipped = site.flows.filter((f) => f.type === 'Skipped').length;

  return `
    <div class="crumb"><a href="#/sites">Sites</a> / ${esc(site.url.replace('https://', ''))}</div>
    <div class="topline">
      <h1>${esc(site.url.replace('https://', ''))} <span class="chip acc">Suite ${esc(site.suiteId)}</span> ${siteChip(site)}</h1>
      <span><button class="btn ghost" data-act="scan" data-id="${site.id}">Run tests</button></span>
    </div>
    <div class="cards">
      ${kpi(urlFlows, 'URL flows')}
      ${kpi(clickFlows, 'Click-state flows')}
      ${kpi(site.total ?? 0, 'Open violations')}
      ${kpi(skipped, 'Skipped routes')}
    </div>

    <h2>Coverage &amp; last run</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Flow</th><th>Type</th><th>Status</th><th>Violations</th><th>Delta</th></tr></thead>
      <tbody>${site.flows.length ? site.flows.map((f) => `
        <tr>
          <td>${esc(f.name)}</td><td>${esc(f.type)}</td>
          <td>${flowChip(f)}</td>
          <td class="tnum">${f.violations ?? '-'}</td>
          <td class="tnum ${String(f.delta).startsWith('+') ? 'up-delta' : String(f.delta).startsWith('-') ? 'down-delta' : ''}">${esc(String(f.delta ?? ''))}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty">No flows provisioned yet. Real provisioning lands in M1; demo sites come pre-seeded.</td></tr>`}
      </tbody>
    </table></div>

    <h2>Violations by root cause (${causes.reduce((n, c) => n + c.instances, 0)} instances, ${causes.length} causes)</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Root cause</th><th>Rule</th><th>Instances</th><th>Mapped to</th><th>Action</th></tr></thead>
      <tbody>${causes.length ? causes.map((c) => `
        <tr>
          <td>${esc(c.title)}</td>
          <td><span class="chip ${c.severity === 'critical' ? 'crit' : 'warn'}">${esc(c.rule)}</span></td>
          <td class="tnum">${c.instances} &middot; ${esc(c.pages[0] === 'all pages' ? 'all pages' : c.pages.length + ' pages')}</td>
          <td class="mono">${c.mappedFile ? esc(c.mappedFile) : '<span style="color:var(--ink-faint)">unmapped - vendor/CMS</span>'}</td>
          <td>${causeAction(c)}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty">No open violations.</td></tr>`}
      </tbody>
    </table></div>`;
}

function viewOnboard() {
  return `
    <div class="crumb"><a href="#/sites">Sites</a> / New</div>
    <div class="topline"><h1>Onboard a site</h1></div>
    <form class="form" id="onboard-form">
      <div class="field">
        <label for="f-url">Website URL</label>
        <input id="f-url" name="url" placeholder="https://shop.example.com" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-repo">Repository (owner/name)</label>
        <input id="f-repo" name="repo" placeholder="acme/shop-frontend" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-suite">AQA suite ID</label>
        <input id="f-suite" name="suiteId" placeholder="TS35353" autocomplete="off">
        <div class="hint">Suite must already exist in AQA - the public API cannot create suites.</div>
      </div>
      <div class="err" id="onboard-err" role="alert"></div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">
        <a class="btn ghost" href="#/sites">Cancel</a>
        <button class="btn" type="submit">Onboard</button>
      </div>
    </form>`;
}

function viewTasks() {
  const cols = [
    ['queued', 'Queued'], ['working', 'Working'], ['verifying', 'Verifying'], ['done', 'Done'],
  ];
  const failed = S.tasks.filter((t) => t.state === 'failed');
  const sel = S.tasks.find((t) => t.id === selectedTask) || S.tasks.find((t) => t.state === 'working') || S.tasks[0];
  const running = S.tasks.filter((t) => ['queued', 'working', 'verifying'].includes(t.state)).length;

  return `
    <div class="topline"><h1>Fix tasks</h1>
      <span class="chip run">${running} active</span></div>
    <div class="kanban-wrap"><div class="kanban">
      ${cols.map(([state, label]) => {
        const list = S.tasks.filter((t) => t.state === state);
        return `<div class="kcol"><h5>${label} <span>${list.length}</span></h5>
          ${list.map((t) => taskCard(t, sel)).join('') || ''}
        </div>`;
      }).join('')}
    </div></div>
    ${failed.length ? `<h2>Failed</h2>${failed.map((t) => taskCard(t, sel)).join('')}` : ''}
    ${sel ? `
      <h2>Task ${esc(sel.id)} - activity</h2>
      <div class="log">${sel.log.map(esc).join('\n')}</div>` : `<div class="empty">No tasks yet. Dispatch one from a site's violations table.</div>`}`;
}

function viewPrs() {
  return `
    <div class="topline"><h1>Pull requests</h1></div>
    ${S.prs.length ? S.prs.map((p) => {
      const site = S.sites.find((x) => x.id === p.siteId);
      return `
      <div class="panel" style="margin-bottom:14px">
        <div class="topline" style="margin-bottom:10px">
          <strong>#${esc(p.num)} ${esc(p.title)}</strong>
          <span class="chip ${p.state === 'open' ? 'run' : 'good'}">${p.state === 'open' ? 'awaiting review' : 'merged &amp; verified'}</span>
        </div>
        <div class="split">
          <div>
            <h6>Violation evidence &middot; ${esc(p.rule || '')}</h6>
            <p>${p.instances} instances &middot; pages: ${esc((p.pages || []).join(', '))}</p>
            <p><code>${esc(p.evidence || '')}</code></p>
            <p>Site: ${esc(site ? site.url : '')} &middot; file: <code>${esc(p.file || '')}</code></p>
          </div>
          <div>
            <h6>Verification</h6>
            <p>Expected delta: <span class="chip good">${p.verification.expected} violations</span></p>
            <p>${p.verification.actual !== null
              ? `Re-run result: <span class="chip good">${p.verification.actual} cleared</span>`
              : 'Runs automatically after merge. If violations persist, the task reopens.'}</p>
          </div>
        </div>
      </div>`;
    }).join('') : `<div class="empty">No PRs yet. Tasks open PRs as they complete.</div>`}`;
}

function viewSettings() {
  const p = S.settings.policies;
  return `
    <div class="topline"><h1>Settings</h1></div>
    <h2>Connections</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Service</th><th>Mode</th><th>Notes</th></tr></thead>
      <tbody>
        <tr><td>AQA (UsableNet)</td>
          <td>${modeChip(S.mode.aqa)}</td>
          <td>Set <span class="mono">AQA_TEAMSLUG</span> + <span class="mono">AQA_API_KEY</span> env vars and restart for real mode.</td></tr>
        <tr><td>Cursor Background Agents</td>
          <td>${modeChip(S.mode.cursor)}</td>
          <td>Set <span class="mono">CURSOR_API_KEY</span> env var and restart for real mode.</td></tr>
        <tr><td>GitHub</td>
          <td><span class="chip idle">via cursor</span></td>
          <td>PRs are opened by Cursor agents; direct GitHub App integration lands in M4.</td></tr>
        <tr><td>Notifications</td>
          <td><span class="chip ${S.settings.notifications.channel ? 'good' : 'idle'}">${S.settings.notifications.channel ? 'set' : 'not set'}</span></td>
          <td>${esc(S.settings.notifications.channel || 'No channel configured (M5).')}</td></tr>
      </tbody>
    </table></div>
    <h2>Default policies (per-site override lands in M3)</h2>
    <div class="tbl-wrap"><table><tbody>
      <tr><td>Plan auto-approval</td><td>${esc(p.planAutoApprove)}</td></tr>
      <tr><td>Fix task dispatch</td><td>${esc(p.fixDispatch)}</td></tr>
      <tr><td>PR merge</td><td>${esc(p.prMerge)}</td></tr>
      <tr><td>Run cadence</td><td>${esc(p.runCadence)}</td></tr>
    </tbody></table></div>`;
}

// ── fragments ───────────────────────────────────────────────────────────────

function kpi(v, l, d) {
  return `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
}

function siteChip(x) {
  const map = {
    critical: ['crit', `${x.critical} critical`],
    fixing: ['run', 'fixes in progress'],
    healthy: ['good', 'healthy'],
    onboarding: ['idle', 'onboarding'],
  };
  const [cls, label] = map[x.status] || ['idle', x.status];
  return `<span class="chip ${cls}">${label}</span>`;
}

function flowChip(f) {
  const map = {
    critical: ['crit', 'critical'],
    issues: ['good', 'pass w/ issues'],
    skipped: ['idle', 'auth-gated'],
  };
  const [cls, label] = map[f.status] || ['idle', f.status];
  return `<span class="chip ${cls}">${label}</span>`;
}

function modeChip(mode) {
  return mode === 'real'
    ? `<span class="chip good">connected</span>`
    : `<span class="chip warn">demo</span>`;
}

function causeAction(c) {
  if (c.status === 'open' && c.mappedFile)
    return `<button class="btn small" data-act="dispatch" data-id="${c.id}">Dispatch fix task</button>`;
  if (c.status === 'open')
    return `<button class="btn ghost small" data-act="export" data-id="${c.id}">Export report</button>`;
  if (c.status === 'task') {
    const t = S.tasks.find((x) => x.causeId === c.id);
    return `<span class="chip run">task ${t ? t.state : 'running'}</span>`;
  }
  if (c.status === 'pr') {
    const t = S.tasks.find((x) => x.causeId === c.id);
    return `<span class="chip good">PR #${t?.pr?.num || '?'} open</span>`;
  }
  if (c.status === 'fixed') return `<span class="chip good">fixed &amp; verified</span>`;
  return '';
}

function taskCard(t, sel) {
  const site = S.sites.find((x) => x.id === t.siteId);
  return `
    <div class="kcard ${t.state === 'working' ? 'active' : ''} ${sel && sel.id === t.id ? 'sel' : ''}" data-task="${t.id}">
      <b>${esc(t.title)}</b>
      <div class="m">${esc(site ? site.url.replace('https://', '') : '')} &middot; ${esc(t.file || 'unmapped')}</div>
      ${t.state === 'working' ? `<span class="cursor-tag">&#9670; ${t.agent} agent</span>` : ''}
      ${t.pr ? `<div class="m" style="margin-top:4px">PR #${esc(String(t.pr.num))}</div>` : ''}
    </div>`;
}

function trendBar(trend) {
  if (!trend || !trend.length) return '-';
  const max = Math.max(...trend, 1);
  const pct = Math.round((trend[trend.length - 1] / max) * 100);
  return `<div class="bar"><i style="width:${pct}%"></i></div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── actions ─────────────────────────────────────────────────────────────────

function bindActions() {
  document.querySelectorAll('[data-go]').forEach((el) =>
    el.addEventListener('click', () => { location.hash = el.dataset.go; }));

  document.querySelectorAll('[data-task]').forEach((el) =>
    el.addEventListener('click', () => { selectedTask = el.dataset.task; render(); }));

  document.querySelectorAll('[data-act]').forEach((el) =>
    el.addEventListener('click', async () => {
      const { act, id } = el.dataset;
      el.disabled = true;
      try {
        if (act === 'dispatch') await api('POST', `/api/causes/${id}/dispatch`);
        if (act === 'scan') await api('POST', `/api/sites/${id}/scan`);
        if (act === 'export') alert('Report export lands in M3. For now: cause details are in /api/state.');
        await refresh();
      } catch (err) {
        alert(err.message);
        el.disabled = false;
      }
    }));

  const form = document.getElementById('onboard-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('onboard-err');
    const data = Object.fromEntries(new FormData(form));
    try {
      const site = await api('POST', '/api/sites', data);
      await refresh();
      location.hash = `#/site/${site.id}`;
    } catch (err) {
      errBox.textContent = err.message;
    }
  });

  const reset = document.getElementById('demo-reset');
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = '1';
    reset.addEventListener('click', async () => {
      const path = S?.mode?.aqa === 'real' ? '/api/fleet/sync' : '/api/demo/reset';
      await api('POST', path);
      selectedTask = null;
      await refresh();
    });
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

refresh();
setInterval(refresh, 3000);
