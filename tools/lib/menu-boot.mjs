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
import { ownDevServer } from './devtree.mjs';

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
export async function ensureServer({ port, root, cacheDir }) {
  /*
   * Delegated to `tools/lib/devtree.mjs`, and the delegation is the point rather than tidiness.
   *
   * This used to be "if something answers on the port, use it", which is not the same claim as
   * "this tree is on the port". Eighty git worktrees in this checkout default to the same
   * handful of ports, so the playability rig and `qa-replay` could both boot another agent's
   * branch and report on it as this one's. `ownDevServer` asks the listener for every `.ts`
   * under `src/` through Vite's `?raw` route and exits 2 naming the differences.
   *
   * It also spawns Vite's own binary rather than `npx vite`. `npx` is a wrapper *process*, so
   * the `SIGTERM` below reached the wrapper and left the server holding the port — which is
   * where the orphan sweeps came from, and the reason the exit hook this function already had
   * was not enough.
   *
   * The `{ base, server }` shape is unchanged, including `server: null` on a reused server, so
   * every caller's `if (server) server.kill('SIGTERM')` still reads correctly.
   */
  const { base, spawned, kill } = await ownDevServer({
    root,
    port,
    cacheDir: cacheDir ?? process.env.TC_VITE_CACHE_DIR
      ?? path.join('/tmp', `tc-vite-${path.basename(root)}`),
    label: 'menu-boot',
  });
  return { base, server: spawned ? { kill: () => kill() } : null };
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
