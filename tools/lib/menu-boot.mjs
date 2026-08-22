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
export async function bootThroughMenu(page, {
  base, map, scenario, tier = 'high', size, query = 'autoplay=0',
  onSetup, readyTimeout = 240000,
} = {}) {
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
  if (map) await page.click(`.menu [data-map="${map}"]`);
  if (scenario) await page.click(`.menu [data-scen="${scenario}"]`);
  if (tier) await page.click(`.menu [data-tier="${tier}"]`);
  if (size) await page.click(`.menu [data-size="${size}"]`);
  await page.waitForTimeout(250);
  if (onSetup) await onSetup(page);
  await page.click('.menu .begin');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: readyTimeout });
  return page;
}
