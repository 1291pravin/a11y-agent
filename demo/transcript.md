# A11y Agent — 1-Minute Demo Transcript

These lines are **burned into the video** via the blue subtitle bar at the bottom (recorded by Playwright, not added in post).

| Screen | Subtitle |
|--------|----------|
| **Dashboard** | A11y Agent — portfolio view of sites covered, open violations, fix PRs, and active agent tasks. |
| **Sites** | Every storefront links to its GitHub repo, AQA suite, and live status. |
| **Site detail** | Violations grouped by root cause — WCAG rule, severity, instances, and mapped file:line for dispatch. |
| **Fix tasks** | Task lifecycle: Queued → Working → Verifying. Agent patches the repo and opens a PR. |
| **Pull requests** | PR shows WCAG evidence, affected pages, source file, and expected violation delta after merge. |
| **Merge & verify** | After merge, AQA re-runs to confirm the violation cleared. |
| **Task complete** | Verification passed — task in Done, root cause marked fixed. |
| **PR verified** | PR merged and verified — the accessibility fix loop is complete. |
| **Settings** | AQA, Cursor, and GitHub connections — plus policies for dispatch, merge, and scan cadence. |
| **Dashboard** | From scan to fix to verified merge — accessibility built into your SDLC. |

## Re-record

```bash
npm run record:demo
```

Target runtime: **~60 seconds**. Pacing is per-screen (3–8s) rather than a fixed delay.
