// In-page demo overlay: burned-in subtitles + click highlights (captured in video).

export async function installDemoOverlay(page) {
  await page.addInitScript(() => {
    if (window.__demoOverlayReady) return;
    window.__demoOverlayReady = true;

    const css = document.createElement('style');
    css.textContent = `
      @keyframes demo-pulse-ring {
        0% { transform: scale(0.55); opacity: 1; }
        100% { transform: scale(2.2); opacity: 0; }
      }
      @keyframes demo-cursor-dot {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.15); }
      }
      #demo-subtitle-bar {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.8) 25%);
        padding: 28px 32px 18px;
        z-index: 100000;
        pointer-events: none;
        font-family: 'DM Sans', system-ui, sans-serif;
      }
      #demo-subtitle-inner {
        max-width: 960px;
        margin: 0 auto;
        background: rgba(0, 104, 255, 0.94);
        color: #fff;
        padding: 12px 20px;
        border-radius: 10px;
        font-size: 16px;
        line-height: 1.45;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      #demo-step-badge {
        display: block;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        opacity: 0.9;
        margin-bottom: 5px;
      }
      .demo-click-ring {
        position: fixed;
        width: 52px;
        height: 52px;
        margin: -26px 0 0 -26px;
        border: 3px solid #fff;
        border-radius: 50%;
        box-shadow: 0 0 0 3px #0068FF, 0 0 20px rgba(0, 104, 255, 0.6);
        pointer-events: none;
        z-index: 99999;
        animation: demo-pulse-ring 0.75s ease-out 2;
      }
      .demo-click-cursor {
        position: fixed;
        width: 16px;
        height: 16px;
        margin: -8px 0 0 -8px;
        background: #0068FF;
        border: 2px solid #fff;
        border-radius: 50%;
        pointer-events: none;
        z-index: 99999;
        animation: demo-cursor-dot 0.5s ease-in-out 2;
      }
      .demo-click-label {
        position: fixed;
        background: rgba(15, 23, 42, 0.92);
        color: #fff;
        font-family: 'DM Sans', system-ui, sans-serif;
        font-size: 13px;
        font-weight: 600;
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        pointer-events: none;
        z-index: 100001;
        white-space: nowrap;
      }
    `;
    document.documentElement.appendChild(css);

    function ensureBar() {
      let bar = document.getElementById('demo-subtitle-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'demo-subtitle-bar';
        bar.innerHTML =
          '<div id="demo-subtitle-inner"><span id="demo-step-badge"></span><span id="demo-subtitle-text"></span></div>';
        document.body.appendChild(bar);
      }
      return bar;
    }

    window.__demoSetSubtitle = (step, text) => {
      ensureBar();
      document.getElementById('demo-step-badge').textContent = step || '';
      document.getElementById('demo-subtitle-text').textContent = text || '';
    };

    window.__demoClickFx = (x, y, label) => {
      const ring = document.createElement('div');
      ring.className = 'demo-click-ring';
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      document.body.appendChild(ring);
      const dot = document.createElement('div');
      dot.className = 'demo-click-cursor';
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      document.body.appendChild(dot);
      let lbl = null;
      if (label) {
        lbl = document.createElement('div');
        lbl.className = 'demo-click-label';
        lbl.textContent = label;
        lbl.style.left = `${x + 20}px`;
        lbl.style.top = `${y - 32}px`;
        document.body.appendChild(lbl);
      }
      setTimeout(() => { ring.remove(); dot.remove(); lbl?.remove(); }, 1600);
    };
  });
}

export async function setSubtitle(page, step, text) {
  await page.evaluate(({ step, text }) => {
    window.__demoSetSubtitle?.(step, text);
  }, { step, text });
}

export async function hold(page, ms) {
  await page.waitForTimeout(ms);
}

/** Show burned-in subtitle for holdMs; optionally await background work in parallel. */
export async function narrate(page, step, text, holdMs, work) {
  await setSubtitle(page, step, text);
  if (work) {
    await Promise.all([hold(page, holdMs), work()]);
  } else {
    await hold(page, holdMs);
  }
}

export async function clickHighlighted(page, locator, { label = 'Click' } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    await locator.click();
    return;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 60, y - 30, { steps: 6 });
  await page.mouse.move(x, y, { steps: 5 });
  await page.evaluate(({ x, y, label }) => {
    window.__demoClickFx?.(x, y, label);
  }, { x, y, label });
  await hold(page, 220);
  await locator.click();
  await hold(page, 120);
}

export async function waitForTaskState(page, check, arg, timeout = 20_000) {
  if (check === 'dispatched') {
    await page.waitForFunction(async (title) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tasks.some((t) => t.title === title);
    }, arg, { timeout });
    return;
  }
  if (check === 'verifying') {
    await page.waitForFunction(async (title) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tasks.some((t) => t.title === title && t.state === 'verifying' && t.pr?.num);
    }, arg, { timeout });
    return;
  }
  if (check === 'merged-verified') {
    await page.waitForFunction(async (prNum) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.prs.some((p) => p.num === prNum && p.state === 'merged-verified');
    }, arg, { timeout });
  }
}
