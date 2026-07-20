# A11y Agent

Control plane for the accessibility SDLC across a fleet of sites. Give it a website URL,
a repo, and an AQA (UsableNet) suite; it provisions coverage, runs tests, groups
violations by root cause, dispatches fix tasks to Cursor Background Agents, tracks the
resulting PRs, and verifies fixes after merge.

Full plan, milestones, and the verification checklist: **[PLAN.md](PLAN.md)**

## Quick start

```sh
git clone https://github.com/1291pravin/a11y-agent
cd a11y-agent
cp .env.example .env    # optional — fill AQA/Cursor keys for real mode
npm install             # dev deps for Playwright E2E only
npm start
# open http://localhost:4173
```

No runtime dependencies, no build step. Node 20+ only. `npm install` pulls in
`@playwright/test` for browser E2E tests only.

```sh
npm test           # API smoke tests (node:test)
npm run test:e2e   # browser E2E (Playwright, demo mode)
npm run test:all   # both
```

Without credentials the app runs in **demo mode**: three seeded sites, real task
lifecycle (queued -> working -> verifying, then done or reopened after merge),
simulated Cursor agent with live logs and fabricated PRs. Everything on screen is
testable end-to-end.

## Real mode

```sh
AQA_TEAMSLUG=your-team    # UsableNet team slug (filorga repos use AQA_TEAM_SLUG)
AQA_API_KEY=your-key      # sent as x-team header
CURSOR_API_KEY=your-key   # Cursor Cloud Agents API (model: composer-2.5, set in code)
```

Filorga projects store `AQA_TEAM_SLUG` — this repo expects `AQA_TEAMSLUG` (no
underscore). Copy the values from `filorga-fr` or `filorga-eu` `.env` when wiring
real mode. `npm start` loads `.env` via Node's `--env-file` flag.

Set any of these and restart; each integration switches to real independently.
Real AQA scans land in M1, real Cursor dispatch in M2 - see PLAN.md.

### Fleet hardening (M5, all optional)

```sh
ADMIN_TOKEN=...           # require "authorization: Bearer <token>" on all write
                          # routes (GETs stay open; the GitHub webhook keeps its
                          # own HMAC auth). The webapp prompts once and stores it.
SCHEDULE_ENABLED=1        # staggered weekly scans (real AQA only): each site
                          # hashes to a stable Mon-Thu 01:00-05:00 UTC slot
STATE_DB=data/state.db    # move the SQLite state DB (used automatically when
                          # node:sqlite exists, i.e. Node 22.5+)
STORE_BACKEND=json        # force the JSON file store even where SQLite exists
AQA_MAX_RPM=60            # AQA request budget per sliding window (default 60/min;
                          # applies to polling and retries too)
```

State persists to SQLite (`data/state.db`) on Node 22.5+ and to `data/state.json`
elsewhere; an existing `state.json` is imported into the DB once on first boot.
Batch onboarding: POST raw CSV (`url,repo,suiteId` header row, optional
`testId,repoPath,framework`) to `/api/sites/batch`, or use the CSV section on
the onboard screen.

## Try the demo loop

1. Open the dashboard - three sites, sorted by attention.
2. Open **fr.filorga.com** - violations grouped into root causes.
3. Click **Dispatch fix task** on a mapped cause.
4. Watch **Tasks**: the card auto-advances Queued -> Working -> Verifying
   (~5 s per stage) with a live log, then parks with an open PR awaiting merge.
5. Check **Pull requests**: evidence, diff context, and the expected delta.
   Click **Mark merged** to trigger the verification re-run (real installs can
   point a GitHub webhook at `/api/webhooks/github` instead).
6. Back on the site: violation counts dropped, cause shows "fixed & verified".
   If the re-run still finds the violation, the task reopens for re-dispatch.

**Reset demo data** button in the sidebar restores the seed.

## Related

- Foundation (AQA API client + PageCapture automation): [aqa-usablenet-helper](https://github.com/1291pravin/aqa-usablenet-helper)
