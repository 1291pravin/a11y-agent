// A11y Agent SPA. Hash routing, polls /api/state, renders 7 screens.
// No framework, no build step.

'use strict';

let S = null;            // latest server state
let selectedTask = null; // task id shown in the log pane
let token = localStorage.getItem('a11yAgentToken') || ''; // M5 admin token
let batchResult = null;  // last CSV batch response, rendered on the onboard screen

let draft = null;        // in-progress journey in the editor (survives the poll)
let runnerH = null;      // last GET /api/runner/health payload
let runnerHAt = 0;       // when we last fetched runner health (throttle)

// Mirror of server/journey-model.mjs STEP_TYPES; the SPA has no build step so it
// cannot import, and the two lists must stay in sync.
const STEP_TYPES = ['goto', 'click', 'fill', 'hover', 'waitFor', 'snapshot'];

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
    maybeFetchRunnerHealth();
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
  for (const j of (S.journeys || [])) next[`jrun:${j.id}`] = j.runState === 'running' ? 'running' : 'idle';

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
    if (kind === 'jrun') {
      const j = (S.journeys || []).find((x) => x.id === id);
      if (value === 'running') msgs.push(`Journey ${j?.name || id} run started`);
      else {
        const lr = j?.lastRun;
        msgs.push(lr && !lr.ok
          ? `Journey ${j?.name || id} run failed: ${lr.error || ''}`
          : `Journey ${j?.name || id} run complete${lr?.diff ? `: ${lr.diff.new.length} new, ${lr.diff.fixed.length} fixed` : ''}`);
      }
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

// Quick-scan sites are often http:// (localhost, preview builds), so strip
// either scheme rather than just https.
function hostOf(url) { return String(url || '').replace(/^https?:\/\//, ''); }

// The runner is a separate process, so its health is not in /api/state. Fetch it
// lazily while a view that needs it is on screen, cache it, and re-render when it
// lands. Throttled so it does not fire on every 3s poll.
async function maybeFetchRunnerHealth() {
  const v = route().view;
  if (v !== 'journeys' && v !== 'journey' && v !== 'settings') return;
  if (Date.now() - runnerHAt < 9000) return;
  runnerHAt = Date.now();
  try {
    const res = await fetch('/api/runner/health');
    runnerH = await res.json();
  } catch (err) {
    runnerH = { ok: false, error: err.message };
  }
  render();
}

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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
    a.classList.toggle('on', v === r.view
      || (v === 'sites' && r.view === 'site')
      || (v === 'journeys' && r.view === 'journey'));
  });
  const views = {
    dashboard: viewDashboard,
    sites: viewSites,
    site: viewSite,
    journeys: viewJourneys,
    journey: viewJourney,
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

window.addEventListener('hashchange', () => {
  render(true);
  // Landing on a journeys/settings view should show fresh runner health, not a
  // value cached from minutes ago on another screen.
  runnerHAt = 0;
  maybeFetchRunnerHealth();
});

// ── screens ─────────────────────────────────────────────────────────────────

function viewDashboard() {
  const covered = S.sites.filter((x) => x.flows.length).length;
  const violations = S.sites.reduce((n, x) => n + (x.total || 0), 0);
  const openPrs = S.prs.filter((p) => p.state === 'open').length;
  const running = S.tasks.filter((t) => ['queued', 'working', 'verifying'].includes(t.state)).length;
  // Only sites that have actually been scored count toward the average, so an
  // unscanned site does not drag the portfolio number down.
  const scored = S.sites.filter((x) => x.score && x.flows.length);
  const avgScore = scored.length
    ? Math.round(scored.reduce((n, x) => n + x.score.score, 0) / scored.length)
    : null;
  const order = { critical: 0, fixing: 1, onboarding: 2, healthy: 3 };
  const sites = [...S.sites].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  return `
    <div class="topline"><h1>Portfolio</h1>
      <a class="btn" href="#/onboard">+ Onboard site</a></div>
    <div class="cards">
      ${kpi(covered + '<small>/' + S.sites.length + '</small>', 'Sites covered')}
      ${kpi(avgScore == null ? '-' : `${avgScore}<small>/100</small>`, 'Avg a11y score')}
      ${kpi(violations, 'Open violations')}
      ${kpi(openPrs, 'Fix PRs open')}
      ${kpi(running, 'Agent tasks running')}
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Site</th><th>Status</th><th>Critical</th><th>Total</th><th>Trend</th><th>Last run</th></tr></thead>
      <tbody>${sites.map((x) => `
        <tr class="click" data-go="#/site/${x.id}">
          <td>${esc(hostOf(x.url))}</td>
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
          <td>${esc(hostOf(x.url))}</td>
          <td class="mono">${x.repo ? esc(x.repo) : '<span style="color:var(--ink-faint)">-</span>'}</td>
          <td class="mono">${x.suiteId ? esc(x.suiteId) : '<span class="chip good">quick</span>'}</td>
          <td>${esc(x.framework)}</td>
          <td>${siteChip(x)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function viewSite(r) {
  const site = S.sites.find((x) => x.id === r.id);
  if (!site) return `<div class="empty">Site not found.</div>`;
  if (r.sub === 'proposed') return viewProposed(site);
  const causes = S.causes.filter((c) => c.siteId === site.id);
  const urlFlows = site.flows.filter((f) => f.type === 'URL').length;
  const clickFlows = site.flows.filter((f) => f.type === 'Click-state').length;
  const skipped = site.flows.filter((f) => f.type === 'Skipped').length;

  const scanning = site.scanState === 'running';

  return `
    <div class="crumb"><a href="#/sites">Sites</a> / ${esc(hostOf(site.url))}</div>
    <div class="topline">
      <h1>${esc(hostOf(site.url))} ${site.suiteId
        ? `<span class="chip acc">Suite ${esc(site.suiteId)}</span>`
        : `<span class="chip acc">Quick scan</span>`} ${siteChip(site)} ${site.score ? scoreChip(site.score) : ''}</h1>
      <span><button class="btn ghost" data-act="scan" data-id="${site.id}"${scanning ? ' disabled aria-busy="true"' : ''}>${
        scanning ? '<span class="spin"></span>Scanning&hellip;' : 'Run tests'
      }</button></span>
    </div>
    ${scanProgress(site)}
    ${discoverProgress(site)}
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
      <thead><tr><th>Root cause</th><th>Rule</th><th>Instances</th><th>AQA locator</th><th>Action</th></tr></thead>
      <tbody>${causes.length ? causes.map((c) => `
        <tr>
          <td>${esc(c.title)}</td>
          <td><span class="chip ${c.severity === 'critical' ? 'crit' : 'warn'}">${esc(c.rule)}</span></td>
          <td class="tnum">${c.instances} &middot; ${esc(c.pages[0] === 'all pages' ? 'all pages' : c.pages.length + ' pages')}</td>
          <td class="mono">${causeLocatorCell(c)}</td>
          <td>${causeAction(c)}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty">No open violations.</td></tr>`}
      </tbody>
    </table></div>
    ${siteJourneys(site)}`;
}

// Discovery has real stages we can name honestly (inspect -> propose ->
// validate), but no percentage, so the bar stays indeterminate like the others.
const DISCOVER_STAGES = {
  inspecting: 'Loading the page and reading its structure',
  proposing: 'Proposing journeys',
  validating: 'Validating selectors in a real browser',
};

function discoverProgress(site) {
  const d = site.discover;
  if (!d || d.state !== 'running') return '';
  const elapsed = d.startedAt ? fmtDuration(Date.now() - d.startedAt) : null;
  return `
    <div class="panel scanbox">
      <div class="sb-top">
        <span class="sb-title"><span class="spin"></span>${esc(DISCOVER_STAGES[d.stage] || 'Discovering journeys')}</span>
        <span class="sb-meta">${elapsed ? `elapsed ${esc(elapsed)}` : ''}</span>
      </div>
      <div class="prog indet" role="progressbar" aria-label="Discovering journeys, duration unknown"><i></i></div>
      <div class="sb-note">A real browser is inspecting ${esc(hostOf(site.url))}${d.focus?.length ? `, focused on ${esc(d.focus.join(', '))}` : ''}. Nothing is saved until you review the proposals.</div>
    </div>`;
}

// Review screen for discovered journeys. Everything here is a proposal: nothing
// has been written to the site until it is accepted.
function viewProposed(site) {
  const d = site.discover || {};
  const proposals = d.proposals || [];
  const running = d.state === 'running';
  const hasIntent = Boolean(site.intent || d.intent);

  return `
    <div class="crumb"><a href="#/sites">Sites</a> / <a href="#/site/${site.id}">${esc(hostOf(site.url))}</a> / Proposed journeys</div>
    <div class="topline">
      <h1>Proposed journeys${proposals.length ? ` <span class="chip acc">${proposals.length} suggested</span>` : ''}</h1>
      <span>
        <a class="btn ghost small" href="#/journey/new" style="margin-right:6px">+ Add manually</a>
        <button class="btn" data-act="acceptproposals" data-id="${site.id}"${running || !proposals.length ? ' disabled' : ''}>Approve &amp; scan</button>
      </span>
    </div>
    ${discoverProgress(site)}
    ${d.error ? `<div class="err" style="margin:-4px 0 12px">Discovery failed: ${esc(d.error)}</div>` : ''}
    ${hasIntent ? `<div class="intent-echo"><div class="intent-echo-l">Read from your intent</div><div class="intent-echo-b">${esc(site.intent || d.intent || '')}</div></div>` : ''}
    ${!running && !proposals.length ? `
      <div class="empty">No proposals yet.
        <button class="btn small" data-act="discover" data-id="${site.id}" style="margin-left:8px">Discover journeys</button>
      </div>`
    : `
      <div class="hint" style="margin:-4px 0 12px">An agent inspected ${esc(hostOf(site.url))} and suggested these. Untick anything you do not want, then approve. Approval kicks off a scan on every included journey.</div>
      <div class="proposal-grid">
        ${proposals.map((p, i) => proposalCard(p, i)).join('')}
      </div>`}`;
}

// One journey proposal as a card: header + screenshot strip + step preview +
// include-in-batch checkbox. The screenshots come from the runner's dry-run
// (M7) and let a reviewer skim what the journey actually visits rather than
// squinting at selectors.
function proposalCard(p, i) {
  const dr = p.dryRun;
  const failed = dr?.ok === false;
  const pending = !dr;
  const status = pending ? '<span class="chip idle">pending</span>'
    : failed ? `<span class="chip crit" title="${esc(dr.error || '')}">selector failed</span>`
    : '<span class="chip good">passed dry-run</span>';
  const shots = (dr?.steps || []).slice(0, 8);
  const stepLabels = (p.steps || []).map((s, idx) => stepLabel(s, idx));
  return `
    <div class="proposal-card${failed ? ' failed' : ''}">
      <div class="prophead">
        <div>
          <div class="propname">${esc(p.name)}${p.source ? ` <span class="autob">${esc(p.source)}</span>` : ''}</div>
          <div class="propmeta">${(p.steps || []).length} step(s) · ${dr ? `${dr.steps?.filter((s) => s.status === 'ok').length || 0}/${dr.steps?.length || 0} passed` : 'dry-run pending'}${p.focus ? ` · ${esc(p.focus)}` : ''}</div>
        </div>
        <div>${status}</div>
      </div>
      ${shots.length ? `<div class="shotstrip">${shots.map((s, idx) => shotThumb(s, idx, stepLabels[idx])).join('')}</div>` : ''}
      <div class="stepprev-line">${esc(stepPreview(p.steps))}</div>
      <div class="propfoot">
        <label class="proplbl"><input type="checkbox" class="prop-pick" data-idx="${i}"${dr?.ok !== false ? ' checked' : ''} aria-label="Include ${esc(p.name)}"> Include</label>
        <span class="propfoot-r">
          <a class="btn ghost small" href="#/journey/new" title="Add manually">Edit</a>
        </span>
      </div>
    </div>`;
}

function shotThumb(step, idx, label) {
  if (!step.screenshot) {
    // Failed / skipped steps have no thumbnail; render a placeholder that
    // matches the shape so the strip stays aligned across cards.
    const cls = step.status === 'skipped' ? 'shotph skipped' : 'shotph';
    return `<div class="${cls}" aria-label="Step ${idx + 1}: ${esc(step.type)} (${esc(step.status || 'n/a')})"><span class="steplbl">${idx + 1}. ${esc(step.type)}</span></div>`;
  }
  return `
    <div class="shotthumb" title="${esc(label || step.type)}">
      <img src="${esc(step.screenshot)}" alt="Step ${idx + 1}: ${esc(label || step.type)}" loading="lazy">
      <span class="steplbl">${idx + 1}. ${esc(label || step.type)}</span>
    </div>`;
}

function stepLabel(step, idx) {
  if (step.type === 'goto') return `goto ${shortUrl(step.url)}`;
  if (step.type === 'snapshot') return step.label || 'snapshot';
  if (step.selector) return `${step.type} ${step.selector.slice(0, 24)}`;
  return step.type;
}

// One-line human summary of a step list, so the review table shows what a
// journey actually does without opening the editor.
function stepPreview(steps = []) {
  return steps.map((s) => {
    if (s.type === 'goto') return `goto ${shortUrl(s.url)}`;
    if (s.type === 'fill') return `fill ${s.selector}`;
    if (s.type === 'snapshot') return `snapshot "${s.label}"${s.context ? ` in ${s.context}` : ''}`;
    if (s.selector) return `${s.type} ${s.selector}`;
    if (s.networkIdle) return 'waitFor networkIdle';
    if (s.ms) return `waitFor ${s.ms}ms`;
    return s.type;
  }).join('  →  ');
}

function shortUrl(u) {
  const s = String(u || '');
  try { return new URL(s).pathname || '/'; } catch { return s; }
}

// Journeys scoped to this site, shown below the suite coverage. Journeys are the
// evaluate-path supplement to the site's AQA suite (cart/menu/login flows).
function siteJourneys(site) {
  const journeys = (S.journeys || []).filter((j) => j.siteId === site.id);
  return `
    <div class="topline" style="margin:26px 0 10px">
      <h2 style="margin:0">Journeys</h2>
      <span>
        ${(site.discover?.proposals || []).length ? `<a class="btn small" href="#/site/${site.id}/proposed" style="margin-right:6px">Review ${site.discover.proposals.length} proposed</a>` : ''}
        <button class="btn ghost small" data-act="discover" data-id="${site.id}"${site.discover?.state === 'running' ? ' disabled aria-busy="true"' : ''} style="margin-right:6px">${(site.discover?.proposals || []).length || site.discover?.finishedAt ? 'Re-discover' : 'Discover journeys'}</button>
        <a class="btn ghost small" href="#/journey/new">+ New journey</a>
      </span>
    </div>
    ${journeys.length ? `
      <div class="tbl-wrap"><table>
        <thead><tr><th>Journey</th><th>Steps</th><th>Last run</th><th>Result</th><th>Action</th></tr></thead>
        <tbody>${journeys.map((j) => {
          const running = j.runState === 'running';
          const lr = j.lastRun;
          const last = running ? '<span class="chip run">running</span>' : lr ? esc(fmtAgo(lr.at)) : 'never';
          const result = lr && !lr.ok ? '<span class="chip crit">failed</span>'
            : lr && lr.diff ? (lr.diff.new.length ? `<span class="chip crit">${lr.diff.new.length} new</span>` : '<span class="chip good">clean</span>')
            : '<span class="chip idle">not run</span>';
          return `<tr>
            <td><a href="#/journey/${j.id}">${esc(j.name)}</a></td>
            <td class="tnum">${(j.steps || []).length}</td>
            <td>${last}</td>
            <td>${result}</td>
            <td><button class="btn small" data-act="runjourney" data-id="${j.id}"${running ? ' disabled aria-busy="true"' : ''}>Run</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`
    : `<div class="empty">No journeys for this site yet. <a href="#/journey/new">Add one</a> to score a cart, menu, or login flow.</div>`}`;
}

// Two doors in. The suite path ("full") is the original contract; the quick path
// needs only a URL because evaluate scores a DOM we captured ourselves, and it
// leads straight into journey discovery.
function viewOnboard(r) {
  if (r.id === 'quick') return viewOnboardQuick();
  if (r.id === 'full') return viewOnboardFull();
  return `
    <div class="crumb"><a href="#/sites">Sites</a> / New</div>
    <div class="topline"><h1>Onboard a site</h1></div>
    <div class="choose">
      <div class="pathcard rec">
        <div class="pc-top"><div class="pc-ico">&#9733;</div><div><div class="pc-sub">Recommended</div><h3>Full audit + auto-fix</h3></div></div>
        <p>Connect your AQA suite. We scan every flow, map issues to your repo, and let a Cursor agent open fix PRs.</p>
        <ul><li>Needs an AQA <b>suite + test ID</b></li><li>Covers the whole suite</li><li>Auto-fix &rarr; PR &rarr; verify</li></ul>
        <a class="btn" href="#/onboard/full">Set up full audit</a>
      </div>
      <div class="pathcard alt">
        <div class="pc-top"><div class="pc-ico">&#9889;</div><div><div class="pc-sub">Quick</div><h3>Quick scan</h3></div></div>
        <p>Just paste a URL. We drive a real browser, propose journeys for you, and score the captured pages &mdash; no suite setup in the AQA hub.</p>
        <ul><li>Only a <b>URL</b> needed</li><li>Reaches localhost &amp; login-gated pages</li><li>Repo optional (unlocks auto-fix)</li></ul>
        <a class="btn ghost" href="#/onboard/quick">Run a quick scan</a>
      </div>
    </div>`;
}

function viewOnboardQuick() {
  return `
    <div class="crumb"><a href="#/onboard">Onboard</a> / Quick scan</div>
    <div class="topline"><h1>Quick scan <span class="chip good">no suite needed</span></h1></div>
    <form class="form" id="quick-form" style="max-width:720px">
      <div class="jrow2">
        <div class="field"><label for="q-url">Website URL</label>
          <input id="q-url" name="url" placeholder="https://fr.florga.com" autocomplete="off"></div>
        <div class="field"><label for="q-ruleset">Ruleset</label>
          <select id="q-ruleset" name="rulesetId">
            <option value="wcag21_needfix_1">WCAG 2.1 AA (auto only)</option>
            <option value="wcag21">WCAG 2.1 AA (full)</option>
            <option value="wcag22_needfix_1">WCAG 2.2 AA (auto only)</option>
            <option value="wcag22">WCAG 2.2 AA (full)</option>
          </select></div>
      </div>
      <div class="field"><label for="q-repopath">Local repo folder <span class="lblx">optional - lets the agent read your code for better selectors, and maps issues to files</span></label>
        <input id="q-repopath" name="repoPath" placeholder="C:\\repos\\storefront" autocomplete="off" spellcheck="false">
        <div class="hint">Absolute path to the repo on this machine.</div></div>
      <div class="field"><label for="q-repo">GitHub repo <span class="lblx">optional - owner/name, only used to open fix PRs</span></label>
        <input id="q-repo" name="repo" placeholder="florga/storefront" autocomplete="off"></div>

      <div class="field">
        <label for="q-intent">Tell us about the site <span class="lblx">optional but recommended — what it does, who uses it, biggest a11y worries</span></label>
        <textarea id="q-intent" name="intent" rows="4" placeholder="Example: Cosmetics e-commerce in FR/EN. Biggest worry is the 3-step checkout and the cookie banner. Users are mostly 45+ so contrast and font sizing matter. Cover: home, PDP, add-to-cart, checkout, account login. Skip the blog." style="width:100%;min-height:110px;resize:vertical;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);line-height:1.5"></textarea>
        <div class="hint">The agent reads this alongside your site &amp; repo. Free-form is fine — the more context, the fewer wrong journeys we propose.</div>
      </div>

      <details style="margin:2px 0 6px">
        <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--accent)">Dev server for local verification (optional, unlocks Local Verifier)</summary>
        <div style="border-left:2px solid var(--line);margin-top:10px;padding:4px 0 4px 14px">
          <div class="jrow2">
            <div class="field"><label for="q-ds-install">Install command</label>
              <input id="q-ds-install" name="devServer.installCmd" placeholder="pnpm install --frozen-lockfile" autocomplete="off" spellcheck="false"></div>
            <div class="field"><label for="q-ds-start">Start command</label>
              <input id="q-ds-start" name="devServer.startCmd" placeholder="pnpm dev" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="jrow2">
            <div class="field"><label for="q-ds-url">Preview URL</label>
              <input id="q-ds-url" name="devServer.previewUrl" placeholder="http://localhost:3000" autocomplete="off" spellcheck="false"></div>
            <div class="field"><label for="q-ds-health">Health path <span class="lblx">optional</span></label>
              <input id="q-ds-health" name="devServer.healthPath" placeholder="/" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="hint">When set, the Local Verifier (roadmap M10) will spin the dev server on each PR branch and re-run the affected journey against it before we flag the PR as ready to merge.</div>
        </div>
      </details>

      <div class="err" id="quick-err" role="alert"></div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
        <a class="btn ghost" href="#/onboard">Back</a>
        <button class="btn" type="submit">Analyze &amp; propose journeys</button>
      </div>
    </form>`;
}

function viewOnboardFull() {
  return `
    <div class="crumb"><a href="#/onboard">Onboard</a> / Full audit</div>
    <div class="topline"><h1>Full audit setup <span class="chip acc">Recommended</span></h1></div>
    <form class="form" id="onboard-form">
      <div class="field">
        <label for="f-url">Website URL</label>
        <input id="f-url" name="url" placeholder="https://shop.example.com" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-repopath">Local repo folder <span class="lblx">read for source mapping and better journey selectors</span></label>
        <input id="f-repopath" name="repoPath" placeholder="C:\\repos\\shop-frontend" autocomplete="off" spellcheck="false">
        <div class="hint">Absolute path to the repo on this machine.</div>
      </div>
      <div class="field">
        <label for="f-repo">GitHub repo (owner/name) <span class="lblx">used to open fix PRs</span></label>
        <input id="f-repo" name="repo" placeholder="acme/shop-frontend" autocomplete="off">
      </div>
      <div class="jrow2">
        <div class="field">
          <label for="f-suite">AQA suite ID</label>
          <input id="f-suite" name="suiteId" placeholder="TS35353" autocomplete="off">
        </div>
        <div class="field">
          <label for="f-test">AQA test ID <span class="lblx">needed to scan</span></label>
          <input id="f-test" name="testId" placeholder="T90210" autocomplete="off">
        </div>
      </div>
      <div class="hint">Suite and test must already exist in AQA - the public API cannot create them.</div>
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
          <td>Set <span class="mono">CURSOR_API_KEY</span> for cloud agents. <span class="mono">CURSOR_MODE=auto|cloud|cli</span> controls local CLI fallback (needs <span class="mono">agent</span> + site <span class="mono">repoPath</span>). Mode: <span class="mono">${esc(S.mode.cursorMode || 'auto')}</span>${S.mode.cursorCli ? ' · CLI ready' : ''}.</td></tr>
        <tr><td>Journey runner (Playwright)</td>
          <td>${runnerChip()}</td>
          <td>Separate process on <span class="mono">RUNNER_URL</span>; start with <span class="mono">npm run runner</span>. ${runnerH && !runnerH.ok ? esc(runnerH.error || 'unreachable') : runnerH?.runner ? 'Browser ' + esc(runnerH.runner.browser || 'chromium') + ', AQA ' + esc(runnerH.runner.aqa || '?') : 'Checking&hellip;'}</td></tr>
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

// ── journeys ────────────────────────────────────────────────────────────────

function viewJourneys() {
  const journeys = S.journeys || [];
  return `
    <div class="topline"><h1>Journeys</h1>
      <a class="btn" href="#/journey/new">+ New journey</a></div>
    ${runnerHealthStrip()}
    ${journeys.length ? `
      <div class="tbl-wrap"><table>
        <thead><tr><th>Journey</th><th>Site</th><th>Steps</th><th>Last run</th><th>Score</th><th>Result</th><th>Action</th></tr></thead>
        <tbody>${journeys.map(journeyRow).join('')}</tbody>
      </table></div>`
    : `<div class="empty">No journeys yet. A journey walks a real browser through a flow (cart, menu, login) and scores each snapshot.<br><a href="#/journey/new">Create your first journey</a>.</div>`}`;
}

function journeyRow(j) {
  const site = S.sites.find((x) => x.id === j.siteId);
  const running = j.runState === 'running';
  const lr = j.lastRun;
  const last = running
    ? '<span class="chip run"><span class="spin"></span> running</span>'
    : lr ? esc(fmtAgo(lr.at)) : 'never';
  let result = '<span class="chip idle">not run</span>';
  if (lr && !lr.ok) result = '<span class="chip crit">failed</span>';
  else if (lr && lr.unscored) result = '<span class="chip acc">walked</span>';
  else if (lr && lr.diff) result = lr.diff.new.length
    ? `<span class="chip crit">${lr.diff.new.length} new</span>`
    : `<span class="chip good">clean</span>`;
  return `
    <tr>
      <td><a href="#/journey/${j.id}">${esc(j.name)}</a></td>
      <td>${esc(hostOf(site?.url))}</td>
      <td class="tnum">${(j.steps || []).length}</td>
      <td>${last}</td>
      <td>${lr?.score ? scoreChip(lr.score) : '<span style="color:var(--ink-faint)">-</span>'}</td>
      <td>${result}</td>
      <td><button class="btn small" data-act="runjourney" data-id="${j.id}"${running ? ' disabled aria-busy="true"' : ''}>Run</button></td>
    </tr>`;
}

// Green when the runner is up with real AQA, amber in demo mode, red when the
// separate runner process is unreachable - journeys cannot run without it.
function runnerHealthStrip() {
  const h = runnerH;
  if (!h) return `<div class="panel jhealth idle"><span class="jh-l"><span class="dot" style="background:var(--ink-faint)"></span>Checking runner&hellip;</span></div>`;
  let cls, color, label, detail;
  if (!h.ok) {
    cls = 'crit'; color = 'var(--crit)';
    label = 'Runner offline';
    detail = `Start it with <span class="mono">npm run runner</span>. ${esc(h.error || '')}`;
  } else {
    const r = h.runner || {};
    if (r.aqa === 'real') {
      cls = 'good'; color = 'var(--good)';
      label = 'Runner ready';
      detail = `Browser ${esc(r.browser || 'chromium')} &middot; queue ${esc(String(r.queued ?? 0))}`;
    } else {
      cls = 'warn'; color = 'var(--warn)';
      label = 'Runner online &middot; AQA in demo mode';
      detail = 'Runs score against demo data. Set <span class="mono">AQA_TEAMSLUG</span> + <span class="mono">AQA_API_KEY</span> and restart for real scoring.';
    }
  }
  return `
    <div class="panel jhealth ${cls}" style="border-left-color:${color}">
      <span class="jh-l"><span class="dot" style="background:${color}"></span>${label}</span>
      <span class="jh-d">${detail}</span>
    </div>`;
}

function viewJourney(r) {
  if (r.id === 'new' || r.sub === 'edit') return viewJourneyEditor(r);
  if (r.sub === 'report') return viewJourneyReport(r);
  return viewJourneyDetail(r);
}

// Our score, not AQA's: colour bands match the grade thresholds in aqa-sync.
function scoreChip(sc) {
  if (!sc) return '<span class="chip idle">no score</span>';
  const cls = sc.score >= 75 ? 'good' : sc.score >= 60 ? 'warn' : 'crit';
  return `<span class="chip ${cls}">score ${sc.score}</span>`;
}

function scoreRing(sc) {
  const pct = Math.max(0, Math.min(100, sc.score));
  const color = pct >= 75 ? 'var(--good)' : pct >= 60 ? 'var(--warn)' : 'var(--crit)';
  return `
    <div class="ring" style="background:conic-gradient(${color} 0 ${pct}%, var(--surface-2) ${pct}% 100%)">
      <div class="ring-in"><div><div class="ring-sc">${pct}</div><div class="ring-g">Grade ${esc(sc.grade)}</div></div></div>
    </div>`;
}

function viewJourneyReport(r) {
  const j = (S.journeys || []).find((x) => x.id === r.id);
  if (!j) return `<div class="empty">Journey not found. <a href="#/journeys">Back to journeys</a>.</div>`;
  const site = S.sites.find((x) => x.id === j.siteId);
  const causes = S.causes.filter((c) => c.journeyId === j.id && c.status !== 'fixed');
  const lr = j.lastRun;
  const sc = lr?.score;

  if (!lr) {
    return `
      <div class="crumb"><a href="#/journeys">Journeys</a> / <a href="#/journey/${j.id}">${esc(j.name)}</a> / Report</div>
      <div class="topline"><h1>Accessibility report</h1></div>
      <div class="empty">This journey has not been run yet, so there is nothing to report.
        <button class="btn small" data-act="runjourney" data-id="${j.id}" style="margin-left:8px">Run journey</button>
      </div>`;
  }

  const deltaText = lr.prevScore != null && sc
    ? (sc.score === lr.prevScore ? 'no change vs last run'
      : `${sc.score > lr.prevScore ? '+' : ''}${sc.score - lr.prevScore} vs last run`)
    : 'no previous run to compare';

  return `
    <div class="crumb"><a href="#/journeys">Journeys</a> / <a href="#/journey/${j.id}">${esc(j.name)}</a> / Report</div>
    <div class="topline">
      <h1>Accessibility report</h1>
      <span>
        <button class="btn ghost small" data-act="exportjourney" data-id="${j.id}" style="margin-right:6px">Export .md</button>
        <button class="btn" data-act="runjourney" data-id="${j.id}"${j.runState === 'running' ? ' disabled aria-busy="true"' : ''}>Re-run</button>
      </span>
    </div>
    ${!lr.ok ? `<div class="err" style="margin:-4px 0 12px">Last run failed: ${esc(lr.error || 'unknown error')}. Figures below are from the last successful run, if any.</div>` : ''}
    ${sc ? `
      <div class="panel scorehero">
        ${scoreRing(sc)}
        <div class="sx">
          <h3>${esc(j.name)} &middot; ${esc(hostOf(site?.url))}</h3>
          <div class="m">${sc.instances} fix-required instance(s) across ${sc.causes} root cause(s) &middot; ${sc.units} snapshot(s) scored &middot; ${esc(deltaText)}.</div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <span class="chip crit">${sc.counts.critical} critical</span>
            <span class="chip warn">${sc.counts.serious} serious</span>
            <span class="chip idle">${sc.counts.minor} minor</span>
            ${lr.diff ? `<span class="chip good">${lr.diff.fixed.length} fixed since last run</span>` : ''}
          </div>
          <div class="hint" style="margin-top:8px">Manual-review findings are excluded: this counts only what a developer can fix in code.</div>
        </div>
      </div>` : ''}

    <h2>What is failing &amp; where</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Root cause</th><th>Rule</th><th>Severity</th><th>Where</th><th>Instances</th><th>AQA locator</th></tr></thead>
      <tbody>${causes.length ? causes.map((c) => `
        <tr>
          <td>${esc(c.title)}</td>
          <td>${esc(c.rule)}</td>
          <td><span class="chip ${c.severity === 'critical' ? 'crit' : c.severity === 'serious' ? 'warn' : 'idle'}">${esc(c.severity)}</span></td>
          <td>${esc((c.pages || []).join(', ') || '-')}</td>
          <td class="tnum">${c.instances}</td>
          <td class="mono">${causeLocatorCell(c)}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">No open fix-required violations on this journey.</td></tr>`}
      </tbody>
    </table></div>

    <h2>Coverage</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Snapshot</th><th>Context</th><th>Status</th><th>Fix-required</th><th>Manual</th><th>ms</th></tr></thead>
      <tbody>${(lr.snapshots || []).length ? lr.snapshots.map((sn) => `
        <tr>
          <td>${esc(sn.label)}</td>
          <td class="mono">${sn.context ? esc(sn.context) : '-'}</td>
          <td>${stepStatusChip(sn.status)}</td>
          <td class="tnum">${sn.issues}</td>
          <td class="tnum">${sn.manualIssues ? `<span title="Manual-review findings: reported, never scored">${sn.manualIssues}</span>` : '-'}</td>
          <td class="tnum">${sn.ms != null ? sn.ms : '-'}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">No snapshots captured.</td></tr>`}
      </tbody>
    </table></div>`;
}

function viewJourneyDetail(r) {
  const j = (S.journeys || []).find((x) => x.id === r.id);
  if (!j) return `<div class="empty">Journey not found. <a href="#/journeys">Back to journeys</a>.</div>`;
  const site = S.sites.find((x) => x.id === j.siteId);
  const causes = S.causes.filter((c) => c.journeyId === j.id);
  const running = j.runState === 'running';
  const lr = j.lastRun;
  const snaps = lr?.snapshots || [];
  const violations = causes.reduce((n, c) => n + c.instances, 0);

  return `
    <div class="crumb"><a href="#/journeys">Journeys</a> / ${esc(j.name)}</div>
    <div class="topline">
      <h1>${esc(j.name)} <span class="chip acc">${esc(j.rulesetId)}</span> ${lr?.score ? scoreChip(lr.score) : ''}${running ? ' <span class="chip run">running</span>' : ''}</h1>
      <span>
        ${lr ? `<a class="btn ghost small" href="#/journey/${j.id}/report" style="margin-right:6px">Full report</a>` : ''}
        <a class="btn ghost small" href="#/journey/${j.id}/edit" style="margin-right:6px">Edit</a>
        <button class="btn ghost small" data-act="deletejourney" data-id="${j.id}" style="margin-right:6px">Delete</button>
        <button class="btn" data-act="runjourney" data-id="${j.id}"${running ? ' disabled aria-busy="true"' : ''}>${running ? '<span class="spin"></span>Running&hellip;' : 'Run journey'}</button>
      </span>
    </div>
    ${journeyRunProgress(j)}
    ${lr && !lr.ok && !running ? `<div class="err" style="margin:-4px 0 12px">Last run failed: ${esc(lr.error || 'unknown error')}</div>` : ''}
    ${lr && lr.unscored && !running ? `<div class="jhealth warn" style="border-left-color:var(--warn);margin:-4px 0 14px"><span class="jh-l"><span class="dot" style="background:var(--warn)"></span>Walked, not scored</span><span class="jh-d">The browser walked all ${(lr.steps || []).length} steps, but scoring needs AQA credentials. Set <span class="mono">AQA_TEAMSLUG</span> + <span class="mono">AQA_API_KEY</span> and re-run for a score and violations.</span></div>` : ''}
    ${lr && lr.ok && lr.diff && !running ? `<div class="hint" style="margin:-4px 0 12px">Last run ${esc(fmtAgo(lr.at))} &middot; ${esc(fmtDuration(lr.ms || 0))} &middot; ${lr.diff.new.length} new, ${lr.diff.fixed.length} fixed, ${lr.diff.persisting.length} persisting</div>` : ''}
    <div class="cards">
      ${kpi(lr?.score ? `${lr.score.score}<small>/100</small>` : (lr?.unscored ? '<small>unscored</small>' : '-'), 'A11y score')}
      ${kpi((j.steps || []).length, 'Steps')}
      ${kpi(snaps.length, 'Snapshots')}
      ${kpi(violations, 'Open violations')}
      ${kpi(lr?.ms ? fmtDuration(lr.ms) : '-', 'Last duration')}
    </div>

    <h2>Steps</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Type</th><th>Target</th><th>Status</th><th>ms</th></tr></thead>
      <tbody>${lr && (lr.steps || []).length ? lr.steps.map((st) => `
        <tr>
          <td>${st.index + 1}</td>
          <td><span class="tag2">${esc(st.type)}</span></td>
          <td class="mono">${esc(stepTarget(j.steps?.[st.index]))}</td>
          <td>${stepStatusChip(st.status)}</td>
          <td class="tnum">${st.ms != null ? st.ms : '-'}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty">Not run yet. Press "Run journey" to walk the flow and score it.</td></tr>`}
      </tbody>
    </table></div>

    <h2>Snapshots</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Label</th><th>Context</th><th>Status</th><th>Fix-required</th><th>Manual</th><th>ms</th></tr></thead>
      <tbody>${snaps.length ? snaps.map((sn) => `
        <tr>
          <td>${esc(sn.label)}</td>
          <td class="mono">${sn.context ? esc(sn.context) : '-'}</td>
          <td>${stepStatusChip(sn.status)}</td>
          <td class="tnum">${sn.issues}</td>
          <td class="tnum">${sn.manualIssues ? `<span title="Manual-review findings: reported, never scored">${sn.manualIssues}</span>` : '-'}</td>
          <td class="tnum">${sn.ms != null ? sn.ms : '-'}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">No snapshots recorded.</td></tr>`}
      </tbody>
    </table></div>

    <h2>Violations by root cause (${violations} instances, ${causes.length} causes)</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Root cause</th><th>Rule</th><th>Instances</th><th>AQA locator</th><th>Action</th></tr></thead>
      <tbody>${causes.length ? causes.map((c) => `
        <tr>
          <td>${esc(c.title)}</td>
          <td><span class="chip ${c.severity === 'critical' ? 'crit' : 'warn'}">${esc(c.rule)}</span></td>
          <td class="tnum">${c.instances} &middot; ${esc(c.pages[0] === 'all pages' ? 'all pages' : c.pages.length + ' pages')}</td>
          <td class="mono">${causeLocatorCell(c)}</td>
          <td>${causeAction(c)}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty">No open violations.</td></tr>`}
      </tbody>
    </table></div>`;
}

// AQA reports no completion percentage for a journey either, so this is
// deliberately indeterminate - same rationale as scanProgress.
function journeyRunProgress(j) {
  if (j.runState !== 'running') return '';
  return `
    <div class="panel scanbox">
      <div class="sb-top">
        <span class="sb-title"><span class="spin"></span>Running journey&hellip;</span>
        <span class="sb-meta">walking steps &amp; scoring snapshots</span>
      </div>
      <div class="prog indet" role="progressbar" aria-label="Journey run in progress, duration unknown"><i></i></div>
      <div class="sb-note">Driving a browser through ${(j.steps || []).length} steps. Results replace the tables below when the run lands. Leaving this page does not stop the run.</div>
    </div>`;
}

function stepTarget(s) {
  if (!s) return '';
  if (s.type === 'goto') return s.url || '';
  if (s.type === 'fill') return `${s.selector} = ${s.value}`;
  if (s.selector) return s.selector;
  if (s.networkIdle) return 'networkIdle';
  if (s.ms) return `${s.ms}ms`;
  if (s.type === 'snapshot') return s.label || '';
  return '';
}

function stepStatusChip(status) {
  const map = { ok: ['good', 'ok'], skipped: ['idle', 'skipped'], error: ['crit', 'failed'] };
  const [cls, label] = map[status] || ['idle', status || '-'];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

// ── journey editor (fallback for hand-building / editing proposed steps) ──────

function ensureDraft(r) {
  const forKey = r.id === 'new' ? 'new' : r.id;
  if (draft && draft.for === forKey) return;
  if (r.id === 'new') {
    // Start URL provides the opening navigation (the model injects a leading
    // goto from it), so a new journey begins with just the snapshot to score.
    draft = {
      for: 'new', id: null,
      siteId: S.sites[0]?.id || '',
      name: '', rulesetId: 'wcag21_needfix_1', startUrl: '', vw: 1440, vh: 900,
      steps: [{ type: 'snapshot', label: '' }],
    };
    return;
  }
  const j = (S.journeys || []).find((x) => x.id === r.id);
  draft = j ? {
    for: j.id, id: j.id,
    siteId: j.siteId,
    name: j.name, rulesetId: j.rulesetId, startUrl: j.startUrl,
    vw: j.viewport?.width || 1440, vh: j.viewport?.height || 900,
    steps: (j.steps || []).map((s) => ({ ...s })),
  } : {
    for: forKey, id: null, siteId: S.sites[0]?.id || '',
    name: '', rulesetId: '', startUrl: '', vw: 1440, vh: 900, steps: [],
  };
}

function viewJourneyEditor(r) {
  ensureDraft(r);
  return `
    <div id="journey-editor">
      <div class="crumb"><a href="#/journeys">Journeys</a> / ${draft.id ? 'Edit' : 'New'}</div>
      <div class="topline"><h1>${draft.id ? 'Edit journey' : 'New journey'}</h1></div>
      <div class="form" style="max-width:680px">
        <div class="jrow2">
          <div class="field"><label for="journey-name">Name</label><input id="journey-name" data-jfield="name" value="${esc(draft.name)}" placeholder="Checkout flow"></div>
          <div class="field"><label>Site</label><select data-jfield="siteId">${S.sites.map((s) => `<option value="${s.id}"${s.id === draft.siteId ? ' selected' : ''}>${esc(hostOf(s.url))}</option>`).join('')}</select></div>
        </div>
        <div class="jrow2">
          <div class="field"><label for="journey-ruleset">Ruleset ID</label><input id="journey-ruleset" data-jfield="rulesetId" value="${esc(draft.rulesetId)}" placeholder="wcag21_needfix_1" aria-describedby="journey-ruleset-hint"></div>
          <div class="hint" id="journey-ruleset-hint">Pack id v2 is sent automatically (AQA_RULESET_PACK_ID).</div>
          <div class="field"><label for="journey-start-url">Start URL</label><input id="journey-start-url" data-jfield="startUrl" value="${esc(draft.startUrl)}" placeholder="https://example.com/cart"></div>
        </div>
        <h2>Steps <span class="hint" style="display:inline">(at least one snapshot required)</span></h2>
        ${draft.steps.map(stepEditorRow).join('')}
        <div class="addbar">${STEP_TYPES.map((t) => `<button type="button" class="btn small ghost" data-addstep="${t}">+ ${t}</button>`).join('')}</div>
        <div class="err" id="journey-err" role="alert"></div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px">
          <a class="btn ghost" href="#/journeys">Cancel</a>
          <button class="btn" type="button" id="journey-save">Save journey</button>
        </div>
      </div>
    </div>`;
}

function stepEditorRow(s, i) {
  return `
    <div class="step-row">
      <div class="sr-head">
        <span class="sr-idx">${i + 1}</span>
        <div class="sr-grow"><select data-sidx="${i}" data-sfield="type">${STEP_TYPES.map((t) => `<option${t === s.type ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="sr-tools">
          <button type="button" class="iconbtn" data-idx="${i}" data-move="up" aria-label="Move step up"${i === 0 ? ' disabled' : ''}>&uarr;</button>
          <button type="button" class="iconbtn" data-idx="${i}" data-move="down" aria-label="Move step down"${i === draft.steps.length - 1 ? ' disabled' : ''}>&darr;</button>
          <button type="button" class="iconbtn danger" data-removestep="${i}" aria-label="Remove step">&times;</button>
        </div>
      </div>
      ${stepEditorFields(s, i)}
    </div>`;
}

function stepEditorFields(s, i) {
  const fld = (label, field, val, ph) => `<div class="field"><label>${label}</label><input data-sidx="${i}" data-sfield="${field}" value="${esc(val ?? '')}" placeholder="${ph || ''}"></div>`;
  const opt = () => `<label class="optcheck"><input type="checkbox" data-sidx="${i}" data-sfield="optional"${s.optional ? ' checked' : ''}> optional (skip if missing)</label>`;
  switch (s.type) {
    case 'goto':
      return `<div class="srf one">${fld('URL', 'url', s.url, '/cart or https://…')}</div>`;
    case 'click':
    case 'hover':
      return `<div class="srf one">${fld('Selector', 'selector', s.selector, 'button.checkout')}</div>${opt()}`;
    case 'fill':
      return `<div class="srf">${fld('Selector', 'selector', s.selector, '#email')}${fld('Value', 'value', s.value, 'a@b.co')}</div>${opt()}`;
    case 'waitFor':
      return `<div class="srf">${fld('Selector', 'selector', s.selector, '.results')}${fld('Timeout ms', 'ms', s.ms, '1000')}</div>
        <label class="optcheck"><input type="checkbox" data-sidx="${i}" data-sfield="networkIdle"${s.networkIdle ? ' checked' : ''}> wait for network idle</label>
        <div class="hint">Set exactly one: a selector, network idle, or a millisecond wait.</div>`;
    case 'snapshot':
      return `<div class="srf">${fld('Label (required)', 'label', s.label, 'Checkout form')}${fld('Context selector', 'context', s.context, 'main#checkout')}</div>
        <div class="srf">${fld('Ruleset override', 'rulesetId', s.rulesetId, 'inherit journey ruleset')}<label class="optcheck" style="align-self:center"><input type="checkbox" data-sidx="${i}" data-sfield="manual"${s.manual ? ' checked' : ''}> include manual-review checks</label></div>`;
    default:
      return '';
  }
}

function bindEditor() {
  const root = document.getElementById('journey-editor');
  if (!root) return;

  root.querySelectorAll('[data-jfield]').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { draft[el.dataset.jfield] = el.value; });
  });

  root.querySelectorAll('[data-sidx]').forEach((el) => {
    const i = Number(el.dataset.sidx);
    const field = el.dataset.sfield;
    if (el.type === 'checkbox') {
      el.addEventListener('change', () => { draft.steps[i][field] = el.checked; });
    } else if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => { draft.steps[i][field] = el.value; render(); });
    } else {
      el.addEventListener('input', () => { draft.steps[i][field] = el.value; });
    }
  });

  root.querySelectorAll('[data-addstep]').forEach((el) =>
    el.addEventListener('click', () => { addStep(el.dataset.addstep); render(); }));
  root.querySelectorAll('[data-move]').forEach((el) =>
    el.addEventListener('click', () => { moveStep(Number(el.dataset.idx), el.dataset.move); render(); }));
  root.querySelectorAll('[data-removestep]').forEach((el) =>
    el.addEventListener('click', () => { draft.steps.splice(Number(el.dataset.removestep), 1); render(); }));

  const save = document.getElementById('journey-save');
  if (save) save.addEventListener('click', saveJourney);
}

function addStep(type) {
  const blanks = {
    goto: { type: 'goto', url: '' },
    click: { type: 'click', selector: '' },
    fill: { type: 'fill', selector: '', value: '' },
    hover: { type: 'hover', selector: '' },
    waitFor: { type: 'waitFor', selector: '' },
    snapshot: { type: 'snapshot', label: '' },
  };
  draft.steps.push({ ...(blanks[type] || { type }) });
}

function moveStep(i, dir) {
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= draft.steps.length) return;
  [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
}

// The server validates authoritatively; this cleans stale per-type fields (e.g.
// a selector left behind after switching a step to networkIdle) so an edit does
// not carry contradictory values into validateJourney.
function cleanStep(s) {
  const o = { type: s.type };
  if (s.optional) o.optional = true;
  if (s.type === 'goto') o.url = (s.url || '').trim();
  else if (s.type === 'click' || s.type === 'hover') o.selector = (s.selector || '').trim();
  else if (s.type === 'fill') { o.selector = (s.selector || '').trim(); o.value = s.value || ''; }
  else if (s.type === 'waitFor') {
    if (s.networkIdle) o.networkIdle = true;
    else if (s.ms) o.ms = Number(s.ms);
    else o.selector = (s.selector || '').trim();
  } else if (s.type === 'snapshot') {
    o.label = (s.label || '').trim();
    if (s.context) o.context = s.context;
    if (s.rulesetId) o.rulesetId = s.rulesetId;
    if (s.manual) o.manual = true;
  }
  return o;
}

async function saveJourney() {
  const errBox = document.getElementById('journey-err');
  errBox.textContent = '';
  const localErrors = [];
  if (!draft.name.trim()) localErrors.push('name is required');
  if (!draft.rulesetId.trim()) localErrors.push('ruleset ID is required');
  if (!draft.startUrl.trim()) localErrors.push('start URL is required');
  if (!draft.steps.some((s) => s.type === 'snapshot')) localErrors.push('at least one snapshot step is required');
  if (localErrors.length) { errBox.textContent = localErrors.join('; '); return; }

  const payload = {
    siteId: draft.siteId,
    name: draft.name.trim(),
    rulesetId: draft.rulesetId.trim(),
    startUrl: draft.startUrl.trim(),
    viewport: { width: Number(draft.vw) || 1440, height: Number(draft.vh) || 900 },
    steps: draft.steps.map(cleanStep),
  };
  const save = document.getElementById('journey-save');
  save.disabled = true;
  try {
    const saved = draft.id
      ? await api('POST', `/api/journeys/${draft.id}`, payload)
      : await api('POST', '/api/journeys', payload);
    draft = null;
    await refresh();
    toast('ok', 'Journey saved', payload.name);
    location.hash = `#/journey/${saved.id}`;
  } catch (err) {
    errBox.textContent = err.message;
    save.disabled = false;
  }
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
  if (mode === 'real') return `<span class="chip good">connected</span>`;
  if (mode === 'cli-ready') return `<span class="chip good">cli ready</span>`;
  return `<span class="chip warn">demo</span>`;
}

function runnerChip() {
  const h = runnerH;
  if (!h) return `<span class="chip idle">checking&hellip;</span>`;
  if (!h.ok) return `<span class="chip crit">offline</span>`;
  return h.runner?.aqa === 'real'
    ? `<span class="chip good">ready</span>`
    : `<span class="chip warn">demo</span>`;
}

function causeLocatorCell(c) {
  const loc = formatCauseLocator(c);
  return loc
    ? esc(loc)
    : '<span style="color:var(--ink-faint)" title="AQA did not provide a selector for this group">—</span>';
}

// Mirror of server/aqa-sync.mjs formatCauseLocator (SPA has no imports).
function formatCauseLocator(c) {
  const sel = c?.selector && c.selector !== 'unknown' ? c.selector : '';
  const tag = c?.tagName ? String(c.tagName).toLowerCase() : '';
  if (tag && sel) return `${tag} · ${sel}`;
  if (sel) return sel;
  if (tag) return tag;
  return '';
}

function causeAction(c) {
  const site = S.sites.find((x) => x.id === c.siteId);
  // A fix task needs a repo to land in. Offering the button on an audit-only
  // (quick-scan) site would just produce a 400, so offer the report instead and
  // say why.
  if (c.status === 'open' && site?.repo)
    return `<button class="btn small" data-act="dispatch" data-id="${c.id}">Dispatch fix task</button>`;
  if (c.status === 'open')
    return `<button class="btn ghost small" data-act="export" data-id="${c.id}" title="Downloads fix-report.md for this site (no GitHub repo for auto-fix)">Export report</button>`;
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
      <div class="topline" style="margin-bottom:4px">
        <b>${esc(t.title)}</b>
        ${t.state === 'failed' ? `<button class="btn small" data-act="retry" data-id="${esc(t.id)}" title="Re-launch the Cursor agent">Retry</button>` : ''}
      </div>
      <div class="m">${esc(site ? hostOf(site.url) : '')} &middot; ${esc(t.file || 'unmapped')}</div>
      ${t.state === 'working' ? `<span class="cursor-tag">&#9670; ${t.agent} agent</span>` : ''}
      ${t.state === 'failed' ? `<span class="chip crit">failed</span>` : ''}
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
  runjourney: 'Starting&hellip;',
  deletejourney: 'Deleting&hellip;',
};
const ACT_FAIL = {
  exportjourney: 'Could not export report',
  discover: 'Could not start discovery',
  acceptproposals: 'Could not accept journeys',
  dispatch: 'Could not dispatch fix task',
  scan: 'Could not start scan',
  merged: 'Could not record merge',
  export: 'Could not export report',
  runjourney: 'Could not start journey run',
  deletejourney: 'Could not delete journey',
};

function bindActions() {
  bindEditor();

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
        if (act === 'retry') {
          await api('POST', `/api/tasks/${id}/retry`);
          toast('ok', 'Task re-queued', 'The Cursor agent is launching again.');
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
        if (act === 'runjourney') {
          await api('POST', `/api/journeys/${id}/run`);
          toast('ok', 'Journey run started', 'Progress shows on the journey page.');
        }
        if (act === 'exportjourney') {
          const a = document.createElement('a');
          a.href = `/api/journeys/${encodeURIComponent(id)}/report`;
          a.download = `a11y-report-${id}.md`;
          a.click();
          toast('ok', 'Report downloading', `a11y-report-${id}.md`);
        }
        if (act === 'discover') {
          await api('POST', `/api/sites/${id}/discover`, { focus: [] });
          toast('ok', 'Discovering journeys', 'An agent is inspecting the site. Nothing is saved until you review.');
          location.hash = `#/site/${id}/proposed`;
        }
        if (act === 'acceptproposals') {
          const picks = [...document.querySelectorAll('.prop-pick')]
            .filter((c) => c.checked).map((c) => Number(c.dataset.idx));
          if (!picks.length) { throw new Error('Select at least one journey to accept.'); }
          const r = await api('POST', `/api/sites/${id}/journeys/accept`, { accept: picks });
          toast('ok', `${r.created} journey(s) accepted`, r.skipped?.length ? `${r.skipped.length} skipped (duplicate or invalid).` : 'Run them from the Journeys screen.');
          location.hash = '#/journeys';
        }
        if (act === 'deletejourney') {
          if (!window.confirm('Delete this journey? Open causes it found are removed; any with a task or PR are kept.')) {
            el.disabled = false; el.removeAttribute('aria-busy'); el.innerHTML = label; return;
          }
          await api('DELETE', `/api/journeys/${id}`);
          toast('ok', 'Journey deleted');
          location.hash = '#/journeys';
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

  // Quick scan: create the site on the evaluate path, then immediately kick off
  // journey discovery and drop the user on the review screen. The free-form
  // intent replaces the old focus checkbox chips - it is what the Journey
  // Designer LLM primarily reads, with focus chips as secondary hints.
  const quick = document.getElementById('quick-form');
  if (quick) quick.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('quick-err');
    errBox.textContent = '';
    const raw = Object.fromEntries(new FormData(quick));
    if (!raw.url) { errBox.textContent = 'Enter a website URL.'; return; }

    // Peel out the devServer.* fields into a nested object so the API can
    // receive them as one block (matches the shape makeSite() normalizes).
    const devServer = {};
    const data = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('devServer.')) devServer[k.slice('devServer.'.length)] = v;
      else data[k] = v;
    }
    const hasDevServer = Object.values(devServer).some((v) => String(v || '').trim());
    const intent = String(data.intent || '').trim();

    const btn = quick.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spin"></span>Starting&hellip;';
    try {
      const site = await api('POST', '/api/sites', {
        ...data,
        mode: 'quick',
        intent,
        devServer: hasDevServer ? devServer : null,
      });
      await api('POST', `/api/sites/${site.id}/discover`, { intent });
      await refresh();
      location.hash = `#/site/${site.id}/proposed`;
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Analyze & propose journeys';
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
