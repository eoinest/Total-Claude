/**
 * Booting the game the way a player does, and starting a server to do it on.
 *
 * Lifted out of `tools/scratch/pl-lib-emc.mjs` for the reason `tools/lib/deck-audit.mjs`
 * gives for itself: a second driver needed the same sequence and the two obvious
 * alternatives were both bad — import from a scratch script, or paste the clicks and let
 * the copies drift.
 *
 * They had already drifted, and silently. `pl-lib-emc.mjs` landed on 18 August clicking
 * `[data-map=…]` straight after the menu appeared; the **front door** landed on 20 August
 * (`8534b23`), `menu.css` hides `.menu-setup` while `.menu` is `at-home`, and `startStep`
 * only opens on the setup sheet for `?menu=battle` or a URL that already names a battle
 * (`battle`, `map`, `scenario`, `enemy`). So every one of the six playability scripts has
 * been unable to reach the setup rows for two days, and nobody noticed because none of them
 * asserts anything. That is the whole argument for this file.
 *
 * Used by `tools/qa-replay.mjs` and by the playability rig.
 */

import path from 'node:path';
import process from 'node:process';
import { startVite } from './browser-budget.mjs';
import { stopClockOnReady } from './simclock.mjs';

export const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/**
 * Reuse a dev server on `port` or start a private one. Never 5173, which belongs to whoever
 * is playing the game — pass a port in the 5199–5847 band and pass `--strictPort` with it,
 * which this does, so a clash fails loudly instead of silently landing somewhere else.
 *
 * `TC_VITE_CACHE_DIR` is set per worktree: every agent worktree symlinks `node_modules` at
 * the shared checkout, so vite's default `node_modules/.vite` is one dependency cache being
 * written by as many vite processes as there are agents running a gate.
 */
export async function ensureServer({ port, root, cacheDir, label = 'menu-boot', slot = null }) {
  /*
   * ## 22 Aug 2026 — this now goes through `startVite` in `tools/lib/browser-budget.mjs`
   *
   * The body used to be `spawn('npx', ['vite', …])` plus `unref` plus an exit hook, and the
   * hook was the best cleanup in the repository. It still leaked, and the reason is in the
   * first word: **`server` was npx, not Vite.** `npx` execs a shell which execs
   * `node …/vite.js`, so `server.kill('SIGTERM')` signalled a wrapper two processes above the
   * one holding the port. You can watch it happen — `ps` on this machine shows the pair,
   * `npm exec vite --port 5934` and `node …/.bin/vite --port 5934`, every time.
   *
   * Nineteen dev servers were swept off this box in one morning, several more than a day old.
   * And an exit hook does nothing at all when the harness is SIGKILLed or the machine falls
   * over, which is what happened at load 160.
   *
   * `startVite` spawns `tools/lib/vite-runner.mjs` under `node` directly — the PID the caller
   * holds is the PID holding the port — in its own process group, and the runner polls its
   * parent and exits within two seconds of losing it. It also refuses to reuse a listener that
   * turns out to be serving a *different worktree*, which this function did silently and which
   * is how a probe measures another branch and reports it as yours.
   *
   * The return shape is unchanged: `{ base, server }`, `server` null when a server was reused,
   * so `if (server) server.kill('SIGTERM')` at the end of two dozen callers still works. There
   * is now also `close()`, which is safe to call in either case and is what new code should use.
   */
  const r = await startVite({
    port,
    root,
    cacheDir: cacheDir ?? process.env.TC_VITE_CACHE_DIR
      ?? path.join('/tmp', `tc-vite-${path.basename(root)}`),
    label,
    slot,
  });
  return { base: r.base, server: r.server, started: r.started, close: r.close };
}

/**
 * The front door, the setup sheet, BEGIN BATTLE, and the wait for `window.__game.ready`.
 *
 * `page.click` on the selectors rather than coordinates, and the reason is measured: the
 * menu fades in over two frames and a coordinate press lands during the transition and is
 * swallowed. Playwright's actionability wait handles the fade; a `page.mouse.click` does not.
 *
 * `onSetup` is called with the page once the setup sheet is up and before BEGIN is pressed,
 * for anything a caller wants to do there — a screenshot, an army edit.
 */
/**
 * `stopClock` is **opt-in and defaults off, deliberately.**
 *
 * `src/main.ts` starts the rAF loop at the end of `boot()` and sets `ready` after it, so any
 * driver that waits for the flag and then evaluates a stop loses an unpredictable number of
 * ticks to the round trip — see `tools/lib/simclock.mjs` for the measurement and the scare.
 * Passing `stopClock: true` closes that window from inside the page.
 *
 * It cannot be the default here because this function's other callers are the playability rigs,
 * which drive the battle in real time and need the clock they were given. **If your tool hashes
 * anything at a fixed checkpoint, pass it.** If your tool watches a battle happen, do not.
 */
export async function bootThroughMenu(page, {
  base, map, scenario, tier = 'high', size, query = 'autoplay=0',
  onSetup, readyTimeout = 240000, stopClock = false,
} = {}) {
  if (stopClock) await stopClockOnReady(page);
  await page.goto(`${base}/?${query}`, { waitUntil: 'domcontentloaded' });
  // Either sheet may be the one that appears: `startStep` opens on the setup screen for
  // `?menu=battle` and for any URL that already names a battle, and on the front door for
  // everything else. Ask which, rather than assuming.
  await page.waitForSelector('.menu-sheet', { timeout: 60000 });
  const atHome = await page.evaluate(() =>
    !!document.querySelector('.menu.at-home'));
  if (atHome) {
    await page.click('.menu-home .dest-battle');
    await page.waitForSelector('.menu.at-setup .begin', { timeout: 60000 });
  }
  /*
   * Click a setup option, or say out loud that it was not available.
   *
   * A bare `page.click` on a *disabled* button waits thirty seconds and then throws, and the
   * menu legitimately disables options: the battle-size stepper is greyed wherever the pool cap
   * or the scenario fixes the establishment, so `size: 'small'` is unavailable on some
   * (map, scenario) pairs. A driver that hung there stopped `tools/qa-replay.mjs`'s matrix arm
   * dead on its second battle.
   *
   * Skipped rather than fatal, because "this battle does not offer that option" is a fact about
   * the product and not a failure — but recorded on `page.__menuSkipped`, because a driver that
   * silently declines to do what it was asked is how six playability scripts spent two days
   * unable to reach the setup sheet with nobody noticing.
   */
  page.__menuSkipped = [];
  const pick = async (sel, what) => {
    const el = await page.$(sel);
    if (!el) { page.__menuSkipped.push(`${what} (no such option)`); return false; }
    if (!(await el.isEnabled())) { page.__menuSkipped.push(`${what} (disabled)`); return false; }
    await el.click();
    return true;
  };
  if (map) await pick(`.menu [data-map="${map}"]`, `map=${map}`);
  if (scenario) await pick(`.menu [data-scen="${scenario}"]`, `scenario=${scenario}`);
  if (tier) await pick(`.menu [data-tier="${tier}"]`, `tier=${tier}`);
  if (size) await pick(`.menu [data-size="${size}"]`, `size=${size}`);
  await page.waitForTimeout(250);
  if (onSetup) await onSetup(page);
  await page.click('.menu .begin');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: readyTimeout });
  return page;
}
