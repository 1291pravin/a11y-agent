// A11y Agent SPA. Hash routing, polls /api/state, renders 7 screens.
// No framework, no build step.

'use strict';

let S = null;            // latest server state
let selectedTask = null; // task id shown in the log pane
let token = localStorage.getItem('a11yAgentToken') || ''; // M5 admin token
let batchResult = null;  // last CSV batch response, rendered on the onboard screen

let booted = false;      // first successful fetch has landed (skeleton until then)
let lastGoodAt = null;   // timestamp of the newest state we hold
let pollMs = 3000;       // current poll interval; backs off while disconnected
let pollTimer = null;
let announced = {};      // transition signatures already read out, so the
                         // announcer fires on change rather than every tick

const POLL_BASE_MS = 3000;
const POLL_MAX_MS = 30000;

const main = document.getElementById('main');
const announcer = document.getElementById('announcer');
const connBanner = document.getElementById('conn-banner');

// ── data ────────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S = await res.json();
    booted = true;
    lastGoodAt = Date.now();
    pollMs = POLL_BASE_MS;
    setConnected(true);
    // Hidden until populated: an empty .chip still paints as a stray pill next
    // to the product name during the skeleton.
    const badge = document.getElementById('mode-badge');
    badge.textContent = S.mode.aqa === 'real' || S.mode.cursor === 'real' ? 'live' : 'demo';
    badge.hidden = false;
    const resetBtn = document.getElementById('demo-reset');
    if (resetBtn) resetBtn.textContent = S.mode.aqa === 'real' ? 'Sync from AQA' : 'Reset demo data';
    render();
    announceTransitions();
  } catch (err) {
    // A dropped poll must not wipe the screen: keep the last good state on
    // display, label it stale in the banner, and back off so a downed server
    // is not hammered every 3s.
    pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    setConnected(false, err.message);
    if (!booted) {
      main.innerHTML = `<div class="empty">Cannot reach the server.<br>Retrying in ${Math.round(pollMs / 1000)}s.</div>`;
      main.setAttribute('aria-busy', 'false');
    }
  }
}

// Self-scheduling poll: interval varies with connection health, and a hidden
// tab stops polling entirely until it is looked at again.
function scheduleNext() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(tick, pollMs);
}

async function tick() {
  await refresh();
  scheduleNext();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(pollTimer); return; }
  pollMs = POLL_BASE_MS;
  tick();
});

function setConnected(ok, reason) {
  if (ok) {
    connBanner.hidden = true;
    document.body.classList.remove('has-banner');
    return;
  }
  const stamp = lastGoodAt ? new Date(lastGoodAt).toLocaleTimeString() : null;
  connBanner.hidden = false;
  document.body.classList.add('has-banner');
  connBanner.textContent = stamp
    ? `Lost contact with the server (${reason}). Retrying in ${Math.round(pollMs / 1000)}s. Showing data from ${stamp}.`
    : `Cannot reach the server (${reason}). Retrying in ${Math.round(pollMs / 1000)}s.`;
}

// Announce state changes once, on transition. Announcing every poll would make
// the live region unusable with a screen reader.
function announceTransitions() {
  if (!S) return;
  const next = {};
  for (const site of S.sites) {
    next[`scan:${site.id}`] = site.scanState === 'running' ? 'running' : 'idle';
  }
  for (const t of S.tasks) next[`task:${t.id}`] = t.state;

  const msgs = [];
  for (const [key, value] of Object.entries(next)) {
    const prev = announced[key];
    if (prev === undefined || prev === value) continue;
    const [kind, id] = key.split(':');
    if (kind === 'scan' && value === 'idle') {
      const site = S.sites.find((x) => x.id === id);
      const d = site?.lastDiff;
      msgs.push(site?.scanError
        ? `Scan failed for ${hostOf(site.url)}: ${site.scanError}`
        : `Scan complete for ${hostOf(site?.url)}${d ? `: ${d.new.length} new, ${d.fixed.length} fixed` : ''}`);
    }
    if (kind === 'scan' && value === 'running') {
      msgs.push(`Scan started for ${hostOf(S.sites.find((x) => x.id === id)?.url)}`);
    }
    if (kind === 'task') {
      const t = S.tasks.find((x) => x.id === id);
      msgs.push(`Task ${t?.title || id} is now ${value}`);
    }
  }
  announced = next;
  if (msgs.length) announcer.textContent = msgs.join('. ');
}

async function api(method, path, body, opts = {}) {
  const doFetch = () => fetch(path, {
    method,
    headers: {
      'content-type': opts.raw ? 'text/csv' : 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)),
  });
  let res = await doFetch();
  if (res.status === 401) {
    // Admin auth is on and the stored token is missing/stale: ask once, retry.
    const entered = await askForToken();
    if (entered) {
      token = entered;
      localStorage.setItem('a11yAgentToken', token);
      res = await doFetch();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── feedback primitives ─────────────────────────────────────────────────────

const toastHost = document.getElementById('toasts');

// Errors persist until dismissed; confirmations time out. Both are reachable
// by keyboard and carry the right role for assistive tech.
function toast(kind, title, message) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `
    <div class="tx"><b>${esc(title)}</b>${message ? `<span class="tm">${esc(message)}</span>` : ''}</div>
    <button class="tclose" type="button" aria-label="Dismiss">&times;</button>`;
  el.querySelector('.tclose').addEventListener('click', () => el.remove());
  toastHost.appendChild(el);
  if (kind !== 'err') setTimeout(() => el.remove(), 6000);
}

// Replaces window.prompt() for credential entry. Resolves to the trimmed token
// or null if dismissed; restores focus to wherever the user was.
function askForToken() {
  const dialog = document.getElementById('token-dialog');
  const input = document.getElementById('token-input');
  const errBox = document.getElementById('token-err');
  const save = document.getElementById('token-save');
  const cancel = document.getElementById('token-cancel');
  const returnFocus = document.activeElement;

  return new Promise((resolve) => {
    function close(value) {
      dialog.hidden = true;
      errBox.textContent = '';
      input.value = '';
      document.removeEventListener('keydown', onKey);
      if (returnFocus && returnFocus.focus) returnFocus.focus();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && document.activeElement === input) onSave();
    }
    function onSave() {
      const v = input.value.trim();
      if (!v) { errBox.textContent = 'Enter the token, or cancel.'; input.focus(); return; }
      close(v);
    }
    save.onclick = onSave;
    cancel.onclick = () => close(null);
    document.addEventListener('keydown', onKey);
    dialog.hidden = false;
    input.focus();
  });
}

function hostOf(url) { return String(url || '').replace('https://', ''); }

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ── routing ─────────────────────────────────────────────────────────────────

function route() {
  const hash = location.hash || '#/dashboard';
  const parts = hash.slice(2).split('/');
  return { view: parts[0] || 'dashboard', id: parts[1] || null, sub: parts[2] || null };
}

function render(force) {
  if (!S) { renderSkeleton(); return; }
  // The 3s poll re-renders the whole main pane; skip it while the user is
  // typing in a form field so onboard/CSV input is not wiped mid-edit.
  // Navigation (hashchange) always renders.
  const ae = document.activeElement;
  if (force !== true && ae && main.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
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

  // Wholesale innerHTML replacement destroys focus and scroll position. Capture
  // both, swap, then put them back - otherwise the poll silently steals focus
  // from a keyboard user every 3 seconds.
  const restore = captureFocus();
  const scrollY = window.scrollY;
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = (views[r.view] || viewDashboard)(r);
  main.setAttribute('aria-busy', 'false');
  bindActions();
  restore();
  if (force !== true && window.scrollY !== scrollY) window.scrollTo(0, scrollY);
}

// Identify the focused element by a stable signature rather than a node
// reference, since the node itself is destroyed by the re-render.
function captureFocus() {
  const ae = document.activeElement;
  if (!ae || !main.contains(ae)) return () => {};
  const sig = ae.id
    ? `#${CSS.escape(ae.id)}`
    : ae.dataset.act
      ? `[data-act="${ae.dataset.act}"]${ae.dataset.id ? `[data-id="${ae.dataset.id}"]` : ''}`
      : ae.dataset.task
        ? `[data-task="${ae.dataset.task}"]`
        : null;
  if (!sig) return () => {};
  return () => {
    const next = main.querySelector(sig);
    if (next && next !== document.activeElement) next.focus({ preventScroll: true });
  };
}

// Shown until the first state lands, so the app never presents a blank pane.
// Mirrors the dashboard layout so the swap is not a jolt.
function renderSkeleton() {
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = `
    <div class="topline"><div class="sk" style="width:180px;height:26px"></div></div>
    <div class="cards">
      ${'<div class="kpi"><div class="sk" style="width:52px;height:26px"></div><div class="sk" style="width:88px;height:9px"></div></div>'.repeat(4)}
    </div>
    <div class="tbl-wrap" style="padding:18px">
      <div class="sk" style="width:100%"></div>
      <div class="sk" style="width:82%"></div>
      <div class="sk" style="width:90%"></div>
      <div class="sk" style="width:68%"></div>
    </div>
    <span class="sr-only">Loading dashboard</span>`;
}

window.addEventListener('hashchange', () => render(true));

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

  const scanning = site.scanState === 'running';

  return `
    <div class="crumb"><a href="#/sites">Sites</a> / ${esc(site.url.replace('https://', ''))}</div>
    <div class="topline">
      <h1>${esc(site.url.replace('https://', ''))} <span class="chip acc">Suite ${esc(site.suiteId)}</span> ${siteChip(site)}</h1>
      <span><button class="btn ghost" data-act="scan" data-id="${site.id}"${scanning ? ' disabled aria-busy="true"' : ''}>${
        scanning ? '<span class="spin"></span>Scanning&hellip;' : 'Run tests'
      }</button></span>
    </div>
    ${scanProgress(site)}
    ${site.scanError && !scanning ? `<div class="err" style="margin:-4px 0 12px">Last scan failed: ${esc(site.scanError)}</div>` : ''}
    ${site.lastDiff && !scanning ? `<div class="hint" style="margin:-4px 0 12px">Last scan: ${esc(String(site.lastDiff.new.length))} new, ${esc(String(site.lastDiff.fixed.length))} fixed, ${esc(String(site.lastDiff.persisting.length))} persisting</div>` : ''}
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
    </form>
    <h2>Batch onboard (CSV)</h2>
    <div class="form">
      <div class="field">
        <label for="batch-csv">CSV rows</label>
        <textarea id="batch-csv" rows="6" style="width:100%;resize:vertical" placeholder="url,repo,suiteId&#10;https://shop.example.com,acme/shop-frontend,TS35353"></textarea>
        <div class="hint">Header row required: url,repo,suiteId - optional columns: testId,repoPath,framework (any order). Rows whose url or suite already exist are skipped.</div>
      </div>
      <div class="err" id="batch-err" role="alert"></div>
      <div id="batch-result" class="hint" aria-live="polite">${batchResultHtml()}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn" type="button" id="batch-submit">Onboard batch</button>
      </div>
    </div>`;
}

function viewTasks() {
  const cols = [
    ['queued', 'Queued'], ['working', 'Working'], ['verifying', 'Verifying'], ['done', 'Done'],
  ];
  const failed = S.tasks.filter((t) => t.state === 'failed');
  const reopened = S.tasks.filter((t) => t.state === 'reopened');
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
    ${reopened.length ? `<h2>Reopened <span class="chip warn">fix did not clear</span></h2>${reopened.map((t) => taskCard(t, sel)).join('')}` : ''}
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
          <span>
            ${p.state === 'open' ? `<button class="btn small" data-act="merged" data-id="${esc(String(p.num))}" title="Merged on GitHub? Trigger the verification re-run">Mark merged</button> ` : ''}
            ${prChip(p)}
          </span>
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
            <p>${prVerification(p)}</p>
          </div>
        </div>
      </div>`;
    }).join('') : `<div class="empty">No PRs yet. Tasks open PRs as they complete.</div>`}`;
}

function prChip(p) {
  const map = {
    open: ['run', 'awaiting review'],
    'merged-verifying': ['run', 'verifying fix'],
    'merged-verified': ['good', 'merged &amp; verified'],
    'merged-unverified': ['crit', 'fix did not clear'],
  };
  const [cls, label] = map[p.state] || ['idle', esc(p.state)];
  return `<span class="chip ${cls}">${label}</span>`;
}

function prVerification(p) {
  if (p.state === 'merged-verifying') return 'Merge detected - AQA re-run in progress&hellip;';
  if (p.verification.actual === null) return 'Runs automatically after merge. If violations persist, the task reopens.';
  return p.state === 'merged-verified'
    ? `Re-run result: <span class="chip good">${p.verification.actual} cleared</span>`
    : `Re-run result: <span class="chip crit">${p.verification.actual} cleared - task reopened</span>`;
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
        <tr><td>Admin auth</td>
          <td><span class="chip ${S.mode.auth ? 'good' : 'idle'}">${S.mode.auth ? 'enabled' : 'disabled'}</span></td>
          <td>Set <span class="mono">ADMIN_TOKEN</span> to require a bearer token on all write actions (reads stay open).</td></tr>
        <tr><td>Scheduled scans</td>
          <td><span class="chip ${S.mode.schedule ? 'good' : 'idle'}">${S.mode.schedule ? 'enabled' : 'disabled'}</span></td>
          <td>Set <span class="mono">SCHEDULE_ENABLED=1</span> with real AQA for staggered weekly scans (each site gets a stable Mon-Thu 01:00-05:00 UTC slot).</td></tr>
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

// AQA reports no completion percentage, so this is deliberately indeterminate.
// What it CAN state truthfully: which stage, how long so far, the run id, and
// when the orchestrator will give up. That is more useful than a fake bar.
const SCAN_STAGES = {
  starting: 'Requesting a run from AQA',
  polling: 'Waiting for AQA to finish the run',
  collecting: 'Collecting issues and regrouping causes',
};

function scanProgress(site) {
  if (site.scanState !== 'running') return '';
  const started = site.scanStartedAt;
  const elapsed = started ? fmtDuration(Date.now() - started) : null;
  const budget = site.scanDeadlineAt && started
    ? fmtDuration(site.scanDeadlineAt - started)
    : null;
  // "elapsed 12s · timeout 10m" reads as a budget; "gives up after" reads as
  // a threat and looks absurd next to the 4s demo deadline.
  const stage = SCAN_STAGES[site.scanStage] || 'Scan in progress';

  return `
    <div class="panel scanbox">
      <div class="sb-top">
        <span class="sb-title"><span class="spin"></span>${esc(stage)}</span>
        <span class="sb-meta">${elapsed ? `elapsed ${esc(elapsed)}` : ''}${budget ? ` &middot; timeout ${esc(budget)}` : ''}</span>
      </div>
      <div class="prog indet" role="progressbar" aria-label="Scan progress, duration unknown"><i></i></div>
      <div class="sb-note">
        ${site.scanRunId ? `Run <span class="mono">${esc(site.scanRunId)}</span>. ` : ''}Results replace the tables below when the run lands. Leaving this page does not stop the scan.
      </div>
    </div>`;
}

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
    return `<button class="btn ghost small" data-act="export" data-id="${c.id}" title="Downloads fix-report.md covering all unmapped open causes for this site">Export report</button>`;
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
      ${t.state === 'reopened' ? `<span class="chip warn">reopened</span>` : ''}
      ${t.pr ? `<div class="m" style="margin-top:4px">PR #${esc(String(t.pr.num))}</div>` : ''}
    </div>`;
}

function batchResultHtml() {
  if (!batchResult) return '';
  const r = batchResult;
  return `Created ${esc(String(r.created))}, skipped ${esc(String(r.skipped))} (already onboarded)`
    + (r.errors?.length ? `<br>${r.errors.map((e) => `Line ${esc(String(e.line))}: ${esc(e.error)}`).join('<br>')}` : '');
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

// Busy labels say what is happening, not that something is happening.
const ACT_BUSY = {
  dispatch: 'Dispatching&hellip;',
  scan: 'Starting&hellip;',
  merged: 'Recording&hellip;',
};
const ACT_FAIL = {
  dispatch: 'Could not dispatch fix task',
  scan: 'Could not start scan',
  merged: 'Could not record merge',
  export: 'Could not export report',
};

function bindActions() {
  document.querySelectorAll('[data-go]').forEach((el) =>
    el.addEventListener('click', () => { location.hash = el.dataset.go; }));

  document.querySelectorAll('[data-task]').forEach((el) =>
    el.addEventListener('click', () => { selectedTask = el.dataset.task; render(); }));

  document.querySelectorAll('[data-act]').forEach((el) =>
    el.addEventListener('click', async () => {
      const { act, id } = el.dataset;
      const label = el.innerHTML;
      // Immediate local feedback for the gap between click and the next poll.
      // Longer-lived busy states (a running scan) are derived from server state
      // in the view functions, so they survive the re-render this triggers.
      el.disabled = true;
      el.setAttribute('aria-busy', 'true');
      if (ACT_BUSY[act]) el.innerHTML = `<span class="spin"></span>${ACT_BUSY[act]}`;
      try {
        if (act === 'dispatch') {
          await api('POST', `/api/causes/${id}/dispatch`);
          toast('ok', 'Fix task dispatched', 'Track it on the Tasks board.');
        }
        if (act === 'scan') {
          const r = await api('POST', `/api/sites/${id}/scan`);
          toast('ok', 'Scan started', r.mode === 'real'
            ? 'AQA is running the suite. Progress is shown above the tables.'
            : 'Demo scan running.');
        }
        if (act === 'merged') {
          await api('POST', `/api/prs/${encodeURIComponent(id)}/merged`);
          toast('ok', 'Merge recorded', 'Verification re-run started.');
        }
        if (act === 'export') {
          const cause = S.causes.find((c) => c.id === id);
          if (cause) {
            const a = document.createElement('a');
            a.href = `/api/sites/${encodeURIComponent(cause.siteId)}/fix-report`;
            a.download = `fix-report-${cause.siteId}.md`;
            a.click();
            toast('ok', 'Report downloading', `fix-report-${cause.siteId}.md`);
          }
        }
        await refresh();
      } catch (err) {
        toast('err', ACT_FAIL[act] || 'Action failed', err.message);
        el.disabled = false;
        el.removeAttribute('aria-busy');
        el.innerHTML = label;
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

  const batch = document.getElementById('batch-submit');
  if (batch) batch.addEventListener('click', async () => {
    const errBox = document.getElementById('batch-err');
    const csv = document.getElementById('batch-csv').value;
    errBox.textContent = '';
    if (!csv.trim()) { errBox.textContent = 'Paste CSV rows first.'; return; }
    batch.disabled = true;
    try {
      batchResult = await api('POST', '/api/sites/batch', csv, { raw: true });
      await refresh();
      const resultBox = document.getElementById('batch-result');
      if (resultBox) resultBox.innerHTML = batchResultHtml();
    } catch (err) {
      errBox.textContent = err.message;
    } finally {
      batch.disabled = false;
    }
  });

  const reset = document.getElementById('demo-reset');
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = '1';
    reset.addEventListener('click', async () => {
      const real = S?.mode?.aqa === 'real';
      const path = real ? '/api/fleet/sync' : '/api/demo/reset';
      const label = reset.textContent;
      reset.disabled = true;
      reset.setAttribute('aria-busy', 'true');
      reset.textContent = real ? 'Syncing…' : 'Resetting…';
      try {
        await api('POST', path);
        selectedTask = null;
        await refresh();
        toast('ok', real ? 'Fleet synced from AQA' : 'Demo data reset');
      } catch (err) {
        toast('err', real ? 'Sync failed' : 'Reset failed', err.message);
      } finally {
        reset.disabled = false;
        reset.removeAttribute('aria-busy');
        reset.textContent = label;
      }
    });
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

renderSkeleton();
tick();
