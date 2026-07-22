# A11y Agent - Build Plan and Verification Guide

Control plane for accessibility SDLC across a fleet of sites. Input per site: website URL,
repo, AQA (UsableNet) suite. The system provisions AQA coverage, runs tests, collects
violations, groups them by root cause, dispatches fix tasks to Cursor Background Agents,
tracks the resulting PRs, and verifies fixes with an AQA re-run after merge.

Companion design docs:

- Build plan report (phases, decisions, risks): https://claude.ai/code/artifact/0f038b77-e40d-4a6b-8dc9-08af9a48d6da
- Screen designs (7 screens): https://claude.ai/code/artifact/d5f423e3-9fd7-42b3-acde-a285f55e6ef4
- Foundation repo (AQA API client, PageCapture automation): https://github.com/1291pravin/aqa-usablenet-helper

## Architecture

```
Webapp (vanilla JS, no build step)
   |
Orchestrator API (Node 20, zero deps, server/)
   |-- AQA worker        integrations/aqa.mjs      provision, run, collect (real or demo)
   |-- Cursor client     integrations/cursor.mjs   Background Agents API -> fix PRs (real or demo)
   |-- State store       server/store.mjs          SQLite (node:sqlite, Node 22.5+) or JSON file fallback
```

Design rules carried over from the foundation repo:

1. The model plans and triages; deterministic scripts execute. Nothing LLM-generated
   calls the AQA API free-hand.
2. Every mutation is idempotent and logged.
3. One fix task per ROOT CAUSE, never per violation instance.
4. PR merge is always human. The agent proposes and verifies; a person approves.
5. Zero runtime npm deps. `git pull` + `npm start` must work on any Node 20+ machine.

## Milestones

### M0 - Scaffold + demo mode  [THIS COMMIT]

Runnable control plane with all 7 screens, backed by a JSON store and a simulated
agent loop. No external credentials needed. This is what the office pulls and tests.

- [x] Zero-dep HTTP server, static webapp, REST API
- [x] JSON state store with demo seed (3 sites, violations, root causes)
- [x] 7 screens: Dashboard, Sites, Site detail, Violations triage, Tasks board, PRs, Settings
- [x] Task lifecycle state machine: queued -> working -> verifying -> done / failed
- [x] Demo agent simulation: dispatched tasks progress automatically with scripted logs
- [x] Cursor Background Agents client (real calls when CURSOR_API_KEY set; demo otherwise)
- [x] AQA client skeleton ported from aqa-usablenet-helper (real calls when AQA_* set)

### M1 - Real AQA results loop  [DONE]

- [x] Wire run/results endpoints (tests.run, runs.get, runs.flows, runs.issues) and
      validate response shapes against a real AQA account (testGet/runFlows/runFlowIssues
      validated by the office; testRun/runGet are designed defensively - status|state
      field, finished/completed/done vs error/failed, case-insensitive - and still need
      one confirmation pass against a live run)
- [x] `scan` action triggers real runs, polls, writes violations into the store
      (poll every AQA_POLL_MS, default 10 s, up to 10 min; shared hydration in
      server/aqa-sync.mjs; matched causes keep id/status/mappedFile across rescans)
- [x] Run diffing: new / fixed / persisting root causes, stored as `site.lastDiff`
      and summarized on the site detail screen

### M2 - Real Cursor dispatch  [DONE]

- [x] Verify Background Agents API contract against office Cursor org (v1 contract
      validated against the office org; the client targets /v1 with composer-2.5 -
      POST /agents, GET /agents/{id}, GET /agents/{id}/runs/{runId})
- [x] Dispatch builds the prompt from violation evidence + mapped file
- [x] Webhook or poll to track agent completion -> PR number into the store
      (poll every CURSOR_POLL_MS with a CURSOR_POLL_DEADLINE_MS cap, PR record
      mirrors the demo shape, polling resumes across restarts)

### M3 - Root-cause mapper  [DONE]

- [x] Selector-to-source index built during repo scout (server/mapper.mjs:
      sites take an optional `repoPath` to a local clone; hydration indexes
      class/id/data-testid/aria-label/component tokens and maps each cause to
      a file:line; POST /api/sites/:id/remap rebuilds the index on demand)
- [x] Grouping heuristics (same rule + same selector pattern = one cause;
      selectors are normalized - :nth-child/:nth-of-type and trailing "> *"
      chains stripped - so one component across pages groups once)
- [x] Unmapped causes export as fix-report.md instead of dispatching
      (GET /api/sites/:id/fix-report, markdown download with per-rule
      suggested actions; wired to the "Export report" button)

### M4 - Verification loop  [DONE]

- [x] GitHub webhook on merge -> re-run affected AQA tests -> record delta
      (POST /api/webhooks/github accepts pull_request events, matches PR number
      + repository.full_name against tracked PRs, verifies X-Hub-Signature-256
      when GITHUB_WEBHOOK_SECRET is set; POST /api/prs/:num/merged is the manual
      fallback wired to the "Mark merged" button. Real mode awaits a full AQA
      rescan; the delta lands in pr.verification.actual)
- [x] Failed verification reopens the task with the re-run attached
      (cause still present after the re-run -> task.state "reopened" with the
      remaining count + lastDiff summary in its log, pr.state
      "merged-unverified", cause back to "open" so it can be re-dispatched)

Behavior change: demo tasks no longer auto-complete. Both demo and real tasks
park at "verifying" once the PR is open and finish only through merge intake
(webhook or Mark merged), so demo now exercises the same verification code as
real mode.

### M5 - Fleet hardening  [DONE]

- [x] SQLite store (pragmatic scope: node:sqlite when available - Node 22.5+ -
      with the same in-memory state object and debounced save writing a
      single-row `state(id, json)` table; data/state.db or STATE_DB. Node 20
      and STATE_FILE/STORE_BACKEND=json keep the JSON file store. An existing
      state.json is imported once and renamed to state.json.migrated)
- [x] Auth (pragmatic scope: one shared ADMIN_TOKEN required as
      `authorization: Bearer <token>` on every non-GET /api/* route; GETs stay
      open read-only and the GitHub webhook keeps its own HMAC auth. A single
      shared token is deliberate M5 scope - per-user accounts and roles are
      out of scope; "multi-user" here means many read-only viewers plus
      token-holding operators)
- [x] Batch onboarding (POST /api/sites/batch takes raw CSV - header row
      url,repo,suiteId with optional testId,repoPath,framework in any order;
      duplicate url/suite rows are skipped, bad rows are collected as
      per-line errors without aborting; CSV section on the onboard screen)
- [x] Staggered scheduling (SCHEDULE_ENABLED=1 + real AQA: each site hashes
      to a stable weekly slot Mon-Thu 01:00-05:00 UTC, surfaced as
      site.schedule; a 10-min tick kicks due scans - one at a time, at most
      once per 6 days per site - and logs each to the activity feed)
- [x] Rate-limit budget (global sliding-window limiter inside the AQA client:
      AQA_MAX_RPM per AQA_RATE_WINDOW_MS, default 60/min, covering polling
      and retries; exhausted callers wait for a free slot)

### Evaluate path - journeys + runner  [BACKEND DONE, UNVERIFIED AGAINST A LIVE KEY]

The suite path above is remote: AQA's infrastructure fetches the page, so it can only
reach what is publicly routable. AQA also exposes a stateless endpoint that scores a
DOM snapshot you supply, which inverts who fetches the page - our browser navigates,
and only the resulting DOM travels. Same rule engine, so the results are directly
comparable to a suite run.

This SUPPLEMENTS the suite path and never replaces it. The AQA suite stays the
compliance system of record; a site may have a `suiteId`, a journey, or both. A
journey run only ever writes causes tagged with its own `journeyId`.

- [x] `evaluate()` in the AQA client (POST /a11y/tests/evaluate, form-encoded,
      through the same `req()` helper so auth, 429/5xx retry and the `AQA_MAX_RPM`
      budget all apply)
- [x] Journey model: an ordered step list per site, `goto | click | fill | hover |
      waitFor | snapshot`; snapshot steps carry a label plus optional `rulesetId`
      and `context` overrides; any step may be `optional: true`. Persisted through
      store.mjs on both backends, CRUD under /api/journeys with the ADMIN_TOKEN rule
- [x] Runner (runner/): a SEPARATE process that owns Chromium, walks the steps,
      injects the vendor analyzer, calls `_aqaProcessDOM()` at each snapshot and
      POSTs to evaluate. The control plane reaches it over HTTP at `RUNNER_URL`, so
      server/ and integrations/ keep design rule 5 (zero runtime deps) and Playwright
      stays a devDependency
- [x] Adapter: evaluate issues are fed through the EXISTING `groupIssues()` /
      `mergeCauses()` / `diffCauses()`, with the snapshot label standing in for
      `flowName`. Reshaping lives in one function (`evaluateIssuesToRaw`)
- [ ] Confirmed against a live AQA key - see the checklist below. Until that is
      run, treat this path as unproven: the mock was written from the vendored spec,
      so a spec that misdescribes the API produces a mock that reproduces the same
      misreading with the tests still passing

## How to run (office test)

```sh
git clone https://github.com/1291pravin/a11y-agent
cd a11y-agent
npm start          # demo mode is automatic when no credentials are set
# open http://localhost:4173
```

Optional real-mode env (all are read at startup; missing = demo mode for that integration):

```sh
AQA_TEAMSLUG=...        # UsableNet team slug
AQA_API_KEY=...         # sent as x-team header
CURSOR_API_KEY=...      # Cursor Background Agents API
PORT=4173               # default 4173
```

## Verification checklist (M0)

Run through this after `npm start`. Each item maps to a screen or API.

Server:

- [ ] `curl localhost:4173/api/health` returns `{"ok":true,...}` with mode flags
      (aqa: "demo"|"real", cursor: "demo"|"real")
- [ ] `curl localhost:4173/api/state` returns sites, causes, tasks, prs, settings

Dashboard (screen 2):

- [ ] KPI cards show totals consistent with the sites table below them
- [ ] Sites sorted by attention: critical first, healthy last

Onboard (screen 1):

- [ ] Submitting URL + repo + suite adds a site and navigates to it
- [ ] Missing field shows inline error, does not submit

Site detail (screen 3):

- [ ] Flows table lists URL and click-state flows with last-run status
- [ ] "Run tests" button triggers a scan; in demo mode violations appear in ~2s

Violations triage (screen 4):

- [ ] Violations grouped by root cause with instance counts and mapped file
- [ ] "Dispatch fix task" creates a task, chip changes to TASK RUNNING
- [ ] Unmapped cause shows "Export report" instead of dispatch

Tasks board (screen 5):

- [ ] Dispatched task appears in Queued, then auto-advances Working -> Verifying -> Done
      in demo mode (~5s per stage)
- [ ] Selecting a task shows its live log
- [ ] Done tasks show violations-cleared count

PRs (screen 6):

- [ ] Task reaching Working opens a demo PR entry with evidence + diff
- [ ] Verification panel shows expected delta; after Done it shows the cleared count

Settings (screen 7):

- [ ] Shows connection status per integration (demo/real) with masked keys
- [ ] Policy defaults render and persist after edit + reload

## Verification checklist (M1)

Needs real mode: AQA_TEAMSLUG + AQA_API_KEY set, FLEET_SITES with a `testId` per site.
Optional env: `AQA_BASE` repoints the client (tests use a local mock), `AQA_POLL_MS`
sets the poll cadence in ms (default 10000).

- [ ] `curl localhost:4173/api/health` shows `"aqa":"real"`
- [ ] `curl localhost:4173/api/state` lists your site with its `testId`
- [ ] `curl -X POST localhost:4173/api/sites/<siteId>/scan` returns 202
      `{"ok":true,"mode":"real"}`
- [ ] While the run is in flight, `/api/state` shows `"scanState":"running"` on the
      site, and a second `curl -X POST .../scan` returns 409
- [ ] `curl -X POST localhost:4173/api/sites/<siteWithoutTestId>/scan` returns 400
- [ ] When the run finishes (polled every 10 s, up to 10 min): flow violations and
      root causes refresh, `scanState` clears, and `site.lastDiff` holds
      `{new, fixed, persisting, at}` with `{title, ruleId, instances}` entries
- [ ] Causes that persist across the rescan keep their id/status/mappedFile
      (check a cause with a dispatched task stays in "task")
- [ ] Site detail screen shows "Last scan: N new, M fixed, K persisting" under the title
- [ ] If the run fails or times out, `scanState` clears and the activity feed logs
      the error
- [ ] Demo mode unchanged: without AQA creds, scan returns 202 `{"mode":"demo"}`
- [ ] `node --test` passes (includes tests/m1.test.mjs, which drives the whole
      pipeline against a mock AQA server via AQA_BASE)

## Verification checklist (M2)

Needs real mode: CURSOR_API_KEY set. Optional env: `CURSOR_BASE` repoints the
client (tests use a local mock), `CURSOR_POLL_MS` sets the poll cadence in ms
(default 15000), `CURSOR_POLL_DEADLINE_MS` caps how long a run is polled
(default 30 min).

- [ ] `curl localhost:4173/api/health` shows `"cursor":"real"`
- [ ] Dispatching a mapped cause returns 201 with `"agent":"cursor"`; the task
      log shows the agent + run ids and the task moves to Working
- [ ] When the run reports FINISHED with a PR: task moves to Verifying with
      `pr.num`/`pr.url`, a PR record appears in `/api/state` `prs` (state
      "open", negative `verification.expected`), and the cause status becomes
      "pr"
- [ ] When the run reports FINISHED without a PR: task stays in Verifying with
      no PR record; the task log flags the missing PR for a human
- [ ] Restarting the server resumes polling for in-flight cursor tasks
      (task log shows "resuming poll"); queued cursor tasks without an agentId
      are failed with "orphaned by restart - re-dispatch"
- [ ] A run that never turns terminal fails at the poll deadline; 10 consecutive
      poll errors fail the task with the last error in the log
- [ ] Demo mode unchanged: without CURSOR_API_KEY, dispatch still runs the
      scripted demo simulation
- [ ] `node --test` passes (includes tests/m2.test.mjs, which drives dispatch
      against a mock Cursor server via CURSOR_BASE)

## Verification checklist (M3)

Mapping needs a site with a `repoPath` pointing at a local clone of its
frontend repo (set it in the onboard POST body or as `repoPath` in a
FLEET_SITES entry). The fix-report works in any mode.

- [ ] `curl -OJ localhost:4173/api/sites/site-demo/fix-report` downloads
      `fix-report-site-demo.md` (text/markdown) listing only unmapped open
      causes, each with a "Suggested action" line
- [ ] The "Export report" button on an unmapped cause downloads the same file
- [ ] `curl -X POST localhost:4173/api/sites/site-demo/remap` returns 400
      (no repoPath on the demo site)
- [ ] Onboard a site with `"repoPath": "C:/path/to/clone"`, then
      `curl -X POST localhost:4173/api/sites/<siteId>/remap` returns 200
      `{"mapped":N,"unmapped":M}` and mapped causes show a file:line in the
      triage screen with a "Dispatch fix task" button
- [ ] After a rescan, causes mapped in the previous round keep their
      mappedFile (mergeCauses never overwrites a surviving mapping)
- [ ] `node --test` passes (includes tests/m3.test.mjs: normalizeSelector and
      mapper unit tests against a fixture repo, plus the fix-report endpoint)

## Verification checklist (M4)

Works in demo mode (no credentials). Real mode additionally re-runs the site's
AQA test before settling the verdict. Optional env: `GITHUB_WEBHOOK_SECRET`
requires signed webhook deliveries; `DEMO_VERIFY_FAIL=1` forces the demo re-run
to report the violation persisting.

- [ ] Dispatch a fix task; the task advances to Verifying with an open PR and
      PARKS there (no auto-done) - the PR card shows a "Mark merged" button
- [ ] `curl -X POST localhost:4173/api/prs/<num>/merged` returns 202
      `{"ok":true,"verifying":true}`; the PR chip flips to "verifying fix",
      then the task moves to Done, the PR to "merged & verified" with
      `verification.actual` filled, and the cause to "fixed & verified"
- [ ] A second POST to the same PR returns 409
- [ ] Webhook path (after demo reset + a fresh dispatch):

  ```sh
  curl -X POST localhost:4173/api/webhooks/github \
    -H 'content-type: application/json' \
    -d '{"action":"closed","pull_request":{"number":881,"merged":true},"repository":{"full_name":"acme/demo"}}'
  ```

  returns 202 `{"ok":true,"verifying":true}` and drives the same completion.
  A closed-without-merge event, an unknown PR number, or a repo that matches
  no tracked site all return 202 `{"ok":true,"ignored":true}`
- [ ] With `GITHUB_WEBHOOK_SECRET` set: a delivery without a valid
      `X-Hub-Signature-256` returns 401; a correctly signed one is processed.
      Without the secret, startup logs an "unauthenticated webhook" activity note
- [ ] With `DEMO_VERIFY_FAIL=1`: after the merge the task moves to REOPENED
      (log shows the remaining instance count), the PR to "fix did not clear"
      with the partial delta, and the cause returns to open with "Dispatch fix
      task" available again - a second dispatch creates a fresh task
- [ ] `node --test` passes (includes tests/m4.test.mjs: pass path, fail path,
      webhook match + signature enforcement)

## Verification checklist (M5)

Everything below works in demo mode except the scheduler (needs real AQA).
Optional env: `ADMIN_TOKEN`, `SCHEDULE_ENABLED=1`, `SCHEDULE_TICK_MS`,
`STATE_DB`, `STORE_BACKEND=json`, `AQA_MAX_RPM`, `AQA_RATE_WINDOW_MS`.

Store backend:

- [ ] On Node 22.5+ startup logs `store: sqlite backend (...state.db)`; on
      Node 20, or with `STORE_BACKEND=json` or `STATE_FILE` set, it logs
      `store: json backend (...state.json)`
- [ ] First sqlite boot with an existing data/state.json imports it (log:
      "imported state.json into sqlite") and renames it to state.json.migrated
- [ ] Onboard a site, restart the server: the site survives (state held in
      the single-row `state` table, written on the same debounced save)

Auth (start with `ADMIN_TOKEN=sekret`):

- [ ] `curl localhost:4173/api/health` shows `"auth":true` in mode (and 200
      without any header - GETs stay open)
- [ ] `curl -X POST localhost:4173/api/demo/reset` returns 401
      `{"error":"auth required"}`; adding
      `-H "authorization: Bearer sekret"` returns 200
- [ ] POST /api/webhooks/github still works without a bearer (its HMAC auth
      is unchanged)
- [ ] In the webapp, the first write action prompts for the token once,
      stores it, and retries; Settings shows the "Admin auth" row enabled

Batch onboarding:

- [ ] Paste CSV into the onboard screen's "Batch onboard (CSV)" section:
      valid rows create sites, duplicate url/suite rows are skipped, bad rows
      list per-line errors inline
- [ ] `curl -X POST localhost:4173/api/sites/batch --data-binary @sites.csv`
      returns `{created, skipped, errors:[{line, error}]}`; a header row
      without url/repo/suiteId returns 400

Scheduling (real AQA + `SCHEDULE_ENABLED=1`):

- [ ] Startup logs "weekly staggered scans enabled"; Settings shows the
      "Scheduled scans" row enabled and `/api/state` sites carry
      `schedule: {day, hour}` (stable per site, Mon-Thu, 01:00-05:00 UTC)
- [ ] When a site's slot matches the current UTC weekday+hour, the tick kicks
      its scan (activity: "Scheduled weekly scan started..."), sets
      `lastScheduledScanAt`, and will not re-kick within 6 days
- [ ] Demo mode or `SCHEDULE_ENABLED` unset: no timer, Settings row disabled

Rate budget:

- [ ] With `AQA_MAX_RPM=2 AQA_RATE_WINDOW_MS=1000`, the third AQA request in
      a burst waits ~1 s for a slot (covers polling and retries)
- [ ] `node --test` passes (includes tests/m5.test.mjs: auth, CSV batch,
      limiter, slotFor, and a sqlite restart test that skips on Node < 22.5)

## Verification checklist (evaluate + journey runner)

**This checklist is the only thing standing between this path and a wrong contract.**
Steps 1-5 of the evaluate work are verified against `tests/journey.test.mjs`, whose
mock evaluate server was written from the vendored OpenAPI at
`aqa-usablenet-helper/skills/aqa-cover/resources/aqa-openapi.json`. If the live API
disagrees with that spec, the mock reproduces the same misreading and the tests still
pass. Only a human with a live key can catch that.

Needs real mode: `AQA_TEAMSLUG` + `AQA_API_KEY`, a valid `rulesetId` from
`GET /a11y/tests/rulesets`, and Chromium (`npm install && npx playwright install
chromium`). Start both processes: `npm start` and, in a second shell, `npm run runner`.
Optional env: `RUNNER_URL`, `RUNNER_PORT`, `RUNNER_HOST`, `RUNNER_TIMEOUT_MS`,
`RUNNER_STEP_TIMEOUT_MS`, `AQA_ANALYZER_URL`.

Wiring:

- [ ] `curl localhost:4173/api/runner/health` returns `{"ok":true}` with the runner
      reporting `"aqa":"real"`; with the runner stopped it returns `{"ok":false}` and
      an error rather than hanging
- [ ] Create a journey against a public page and run it:

  ```sh
  curl -X POST localhost:4173/api/journeys -H 'content-type: application/json' -d '{
    "siteId":"<siteId>","name":"smoke","rulesetId":"<rulesetId>",
    "startUrl":"https://example.com/",
    "steps":[{"type":"snapshot","label":"home"}]}'
  curl -X POST localhost:4173/api/journeys/<journeyId>/run
  ```

  returns 202, and `/api/state` shows `runState:"running"` then a populated `lastRun`

**The camelCase question (the highest-risk item).** The spec defines the request
properties as `pageUrl` / `rulesetId` but its `required` array spells them `pageurl` /
`rulesetid`. Only one can be what the server actually parses. The client sends
camelCase (see the comment on `evaluate()` in integrations/aqa.mjs).

- [ ] The smoke journey above returns issues rather than a 4xx. If it fails with a
      missing-parameter error, switch the two keys in `evaluate()` to lowercase and
      confirm that fixes it - then record which spelling won here, and fix the mock
      in tests/journey.test.mjs to match so it stays honest
- [ ] Confirm `pageUrl` really is a label only: pass a `pageUrl` that does not resolve
      (for example `https://localhost.invalid/checkout`) while the `code` is a real
      snapshot, and check the issues come back scored against the snapshot. If AQA
      instead tries to fetch that URL, the whole premise of this path is wrong

**The response shape.** The mock returns issues shaped like the spec's own example:
`ruleId, solutionId, selectors[], ruleShortTitle, ruleTitle, needFixTitle, tagName,
properties[]`. `groupIssues()` reads exactly those.

- [ ] Dump one real response (`node -e` against `evaluate()`, or the runner log) and
      compare field by field with the mock in tests/journey.test.mjs. Names, not just
      presence: a `selector` string where we expect a `selectors` array silently
      collapses every cause into one bucket
- [ ] `properties[]` really carries the impact tags `high` / `medium` / low that
      `mapSeverity()` maps to critical / serious / minor. If real responses only carry
      `"needs fix"` / `"check manually"` and no impact tag, every cause lands as minor
- [ ] Root causes appear in `/api/state` with sane `instances`, `pages` (snapshot
      labels) and `severity`, and the site's suite causes are still there untouched
- [ ] `descriptions[issue.ruleId][issue.solutionId]` resolves as the spec claims (we
      do not consume it yet; confirming it now is what makes it usable later)

**`context` scoping.**

- [ ] Run the same journey twice, once with `"context":"<a real container selector>"`
      on the snapshot step and once without. The scoped run should return a subset:
      issues from inside that subtree only. If `context` is ignored, the two runs come
      back identical and the field is unusable
- [ ] A `context` selector that matches nothing returns an empty or error result
      rather than silently scoring the whole page

**Runner behavior against a real site.**

- [ ] The vendor analyzer injects cleanly (`AQA_ANALYZER_URL` default) on a real page
      with a strict CSP. If `addScriptTag` is blocked by CSP, fall back to the
      `window.eval(response)` form the spec documents
- [ ] Snapshot `bytes` in `lastRun` is plausible for the page (a few hundred KB, not a
      few hundred bytes - a tiny snapshot means the analyzer ran before the app rendered)
- [ ] A journey through a login returns issues for a page the suite path cannot reach.
      This is the whole point of the path; if it does not work, nothing else matters
- [ ] An `optional: true` cookie-banner click is reported `"skipped"` on a session
      where the banner does not appear, and the run still completes
- [ ] A non-optional selector miss fails the run, `lastRun.ok` is false, and the
      journey's previous causes are unchanged (a partial walk must never read as
      "the rest got fixed")
- [ ] Rate budget: the runner is a separate process, so it carries its OWN
      `AQA_MAX_RPM` window. Confirm a long journey plus a concurrent suite scan stays
      inside the account's real limit, or set `AQA_MAX_RPM` lower in both processes

**Still open from M1** (unchanged by this work, still needs the same live pass):

- [ ] `testRun` response shape: does it return the new run id, and under which key
      (`id`, `runId`, `run.id`)? `startRun()` in orchestrator.mjs guesses all three and
      falls back to the newest run on the test
- [ ] `runGet` response shape: which field carries status (`status` or `state`) and
      what are the real terminal values? `waitForRun()` accepts finished/completed/
      done/success/succeeded and error/failed/failure/cancelled/canceled

## Verification checklist (loading + feedback states)

Works entirely in demo mode. Optional env: `DEMO_SCAN_MS` sets the demo scan
duration (default 2000).

Before this pass the app had no loading affordance at all: no spinner, skeleton,
progress or toast class existed anywhere in `web/app.css`.

Scan progress:

- [ ] Click "Run tests" on a site: the button becomes a disabled "Scanning…"
      with a spinner, and a progress panel appears above the KPI cards naming
      the current stage ("Requesting a run from AQA" -> "Waiting for AQA to
      finish the run" -> "Collecting issues and regrouping causes")
- [ ] The panel shows elapsed time, the timeout budget, and the AQA run id once
      known. The bar is a full-width barber pole, never a partial fill - AQA
      reports no percentage, so no percentage is implied
- [ ] The busy button survives the 3s poll re-render (it is derived from
      `site.scanState`, not a local flag)
- [ ] A second `POST /api/sites/:id/scan` while one is running returns 409 in
      demo mode as well as real mode
- [ ] When the scan lands the panel disappears, the button returns to "Run
      tests", and the last-scan diff line reappears
- [ ] A failed real scan leaves `site.scanError` and renders it under the title

First load and polling:

- [ ] A cold load shows a skeleton matching the dashboard layout, never a blank
      pane; `#main` carries `aria-busy` while it is in place
- [ ] Killing the server mid-session keeps the last good data on screen and
      raises a banner naming the failure and the retry interval; the poll backs
      off 3s -> 6s -> 12s -> 30s and recovers on its own
- [ ] Switching to another browser tab stops the poll; returning resumes it
      immediately at the base interval

Errors and credentials:

- [ ] Every failing action raises a dismissible toast, not `alert()`. Errors use
      `role="alert"` and never auto-dismiss; confirmations use `role="status"`
      and clear after 6s
- [ ] With `ADMIN_TOKEN` set, the first write action opens an in-page dialog
      (not `window.prompt`), traps Escape/Enter, and restores focus on close

Accessibility:

- [ ] `#main` no longer carries `aria-live` - it used to, and since the poll
      replaces the pane wholesale, screen readers re-announced the entire page
      every 3 seconds
- [ ] `#announcer`, `#toasts` and `#conn-banner` live outside `#main` so the
      poll cannot destroy them; the announcer fires on transitions only
- [ ] Keyboard focus survives the poll re-render (focus a button, wait 5s, it is
      still focused)
- [ ] With reduced motion the spinner, skeleton and barber pole degrade to
      static but still visible states, not invisible ones
- [ ] `npm run test:e2e` passes (includes tests/e2e/feedback.spec.mjs)

Note: `playwright.config.mjs` now ignores `demo-video.spec.mjs`, which belongs to
`playwright.demo.config.mjs` - it needs its own server, a synced fleet and a 120s
timeout, so it could never pass in the default run and failed it every time.

## Repo layout

```
server/
  index.mjs         HTTP server + static + API routing
  routes.mjs        API handlers (M5: admin-token auth, CSV batch onboarding)
  store.mjs         state store: sqlite (node:sqlite) or JSON file backend (M5)
  bootstrap.mjs     fleet config + startup hydration from AQA
  aqa-sync.mjs      shared AQA hydration, cause grouping, merge + run diffing,
                    evaluate -> cause adapter
  journey-model.mjs journey + step validation (pure)
  journeys.mjs      journey storage, runner client, journey run pipeline
  mapper.mjs        selector-to-source index + cause mapping (M3)
  scheduler.mjs     staggered weekly scan slots + tick loop (M5)
  orchestrator.mjs  task lifecycle, real scan pipeline, demo simulation loop
runner/             SEPARATE process - the only place Playwright is imported
  index.mjs         HTTP wrapper the control plane calls (RUNNER_PORT, default 4174)
  journey-run.mjs   Chromium walk, analyzer injection, evaluate per snapshot
integrations/
  aqa.mjs           AQA v3.1 client (+ global rate budget M5, + evaluate)
  cursor.mjs        Cursor Cloud Agents client (v1, validated against office org)
web/
  index.html  app.css  app.js    the 7-screen SPA, hash routing, polls /api/state
data/
  state.db          runtime state, sqlite backend (gitignored; Node 22.5+)
  state.json        runtime state, JSON backend (gitignored; recreated from seed)
PLAN.md             this file
```
