/**
 * Throwaway: the camera moving between two menus, as a clip and as a strip of frames.
 *
 * The clip is what the move actually looks like; the strip is what can be read in a report
 * without a player. Both come off one page load so they are the same move.
 *
 *   node tools/scratch/menu-clip.mjs --port=5619 --out=screenshots/menu-clip
 */
import path from 'node:path';
import process from 'node:process';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5619);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/menu-clip');
const W = 1440; const H = 900;

await mkdir(OUT, { recursive: true });
const vite = await startVite({ port: PORT, root: ROOT, label: 'menu-clip' });
const browser = await launchBrowser({ label: 'menu-clip', port: PORT, root: ROOT });
try {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  const page = await ctx.newPage();
  await page.goto(`${vite.base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu.at-home .dest-battle');
  // Long enough for the plate to decode and the ambient drift to have started, so the strip
  // shows a camera that was already moving rather than one starting from rest.
  await page.waitForTimeout(2600);

  /** A frame every 140 ms across a move, numbered so they read in order. */
  const strip = async (tag, n, gap) => {
    for (let i = 0; i < n; i += 1) {
      await page.screenshot({ path: path.join(OUT, `${tag}-${String(i).padStart(2, '0')}.png`) });
      await page.waitForTimeout(gap);
    }
  };

  await strip('a-door', 4, 160);
  // The move the brief cares about most: front door to the battle setup.
  await page.click('.menu-home .dest-battle');
  await strip('b-travel', 12, 160);
  await page.waitForSelector('.menu.at-setup .begin');
  // And the one that changes battlefield: Rome's field to the Punic elephants.
  await page.click('.menu [data-map="carthage"]');
  await strip('c-carthage', 10, 160);
  // Then the storm, which flies from the elephant line to the wall it has to climb.
  await page.click('.menu [data-scen="assault"]');
  await strip('d-storm', 10, 160);
  // Back out, which travels the whole way home.
  await page.click('.menu .menu-back');
  await strip('e-back', 10, 160);

  await ctx.close();
  const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
  for (const v of vids) await rename(path.join(OUT, v), path.join(OUT, 'menu-camera.webm'));
  console.log(`clip + strip -> ${OUT}`);
} finally {
  await browser.close();
  await vite.close();
}
