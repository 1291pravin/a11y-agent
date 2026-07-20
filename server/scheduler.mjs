// M5: staggered weekly scan scheduling. Each site hashes to a stable slot
// (Mon-Thu, 01:00-05:00 UTC) so a fleet never scans all at once. A tick every
// 10 minutes (SCHEDULE_TICK_MS override for tests) kicks the real scan for
// sites whose slot matches the current UTC weekday+hour and whose last
// scheduled scan is older than 6 days - serialized, one site at a time.
// Inert unless SCHEDULE_ENABLED=1 and AQA is real (no timer in demo mode).
//
// Store/orchestrator are imported lazily inside tick() so unit tests can
// import slotFor without pulling in persistence or the demo simulation timer.

import * as aqa from '../integrations/aqa.mjs';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu'];
const WEEK_GUARD_MS = 6 * 24 * 60 * 60 * 1000;

// Pure, stable FNV-1a hash of the site id -> weekly slot.
export function slotFor(siteId) {
  let h = 2166136261;
  for (const ch of String(siteId)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { day: DAYS[h % 4], hour: 1 + ((h >>> 2) % 5) };
}

export function schedulerEnabled() {
  return process.env.SCHEDULE_ENABLED === '1' && aqa.isReal;
}

let timer = null;
let ticking = false;

export function initScheduler() {
  if (!schedulerEnabled() || timer) return false;
  const tickMs = Number(process.env.SCHEDULE_TICK_MS) || 10 * 60 * 1000;
  timer = setInterval(() => {
    tick().catch((err) => console.error('scheduler:', err.message));
  }, tickMs);
  timer.unref?.();
  return true;
}

async function tick() {
  if (ticking) return; // a long serialized batch must not overlap the next tick
  ticking = true;
  try {
    const { getState, update } = await import('./store.mjs');
    const { startRealScan } = await import('./orchestrator.mjs');
    const now = new Date();
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()];
    const hour = now.getUTCHours();
    const due = getState().sites.filter((site) => {
      if (!site.testId || site.scanState === 'running') return false;
      const slot = slotFor(site.id);
      if (slot.day !== day || slot.hour !== hour) return false;
      return !(site.lastScheduledScanAt && Date.now() - site.lastScheduledScanAt < WEEK_GUARD_MS);
    });
    for (const site of due) {
      const slot = slotFor(site.id);
      update((s) => {
        const x = s.sites.find((y) => y.id === site.id);
        if (x) x.lastScheduledScanAt = Date.now();
        s.activity.unshift({
          ts: Date.now(),
          msg: `Scheduled weekly scan started for ${site.url} (slot ${slot.day} ${String(slot.hour).padStart(2, '0')}:00 UTC)`,
        });
      });
      await startRealScan(site.id); // serialized: one scheduled scan at a time
    }
  } finally {
    ticking = false;
  }
}
