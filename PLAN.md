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
   |-- State store       server/store.mjs          JSON file (data/state.json), SQLite later
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

### M2 - Real Cursor dispatch

- [ ] Verify Background Agents API contract against office Cursor org (endpoint shapes
      in integrations/cursor.mjs are best-effort and must be confirmed)
- [ ] Dispatch builds the prompt from violation evidence + mapped file
- [ ] Webhook or poll to track agent completion -> PR number into the store

### M3 - Root-cause mapper

- [ ] Selector-to-source index built during repo scout
- [ ] Grouping heuristics (same rule + same selector pattern = one cause)
- [ ] Unmapped causes export as fix-report.md instead of dispatching

### M4 - Verification loop

- [ ] GitHub webhook on merge -> re-run affected AQA tests -> record delta
- [ ] Failed verification reopens the task with the re-run attached

### M5 - Fleet hardening

- [ ] SQLite store, auth, multi-user
- [ ] Batch onboarding (CSV), staggered scheduling, rate-limit budget

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

## Repo layout

```
server/
  index.mjs         HTTP server + static + API routing
  routes.mjs        API handlers
  store.mjs         JSON store, seed data, persistence
  bootstrap.mjs     fleet config + startup hydration from AQA
  aqa-sync.mjs      shared AQA hydration, cause grouping, merge + run diffing
  orchestrator.mjs  task lifecycle, real scan pipeline, demo simulation loop
integrations/
  aqa.mjs           AQA v3.1 client (ported, + unverified results endpoints)
  cursor.mjs        Cursor Background Agents client (unverified contract)
web/
  index.html  app.css  app.js    the 7-screen SPA, hash routing, polls /api/state
data/
  state.json        runtime state (gitignored; recreated from seed)
PLAN.md             this file
```
