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

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

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
  const base = `http://127.0.0.1:${port}`;
  if (await waitForServer(base, 1200)) return { base, server: null };
  const server = spawn(
    'npx', ['vite', '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        TC_NO_HMR: '1',
        TC_VITE_CACHE_DIR: cacheDir ?? process.env.TC_VITE_CACHE_DIR
          ?? path.join('/tmp', `tc-vite-${path.basename(root)}`),
      },
    }
  );
  if (!(await waitForServer(base, 90000))) {
    server.kill('SIGTERM');
    throw new Error(`vite did not start on ${port}`);
  }
  /*
   * Unref plus an exit hook, so a script that forgets to kill the server still exits.
   *
   * A live child handle keeps node's event loop alive, and the playability scripts close
   * their browser and return without touching the server — so before this they hung after
   * printing their last line, which reads as a stuck run. `unref` lets the parent exit;
   * the hook stops that orphaning a vite on the port for the next agent to trip over.
   */
  server.unref();
  process.once('exit', () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } });
  return { base, server };
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
