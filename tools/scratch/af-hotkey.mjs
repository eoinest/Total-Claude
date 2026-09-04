#!/usr/bin/env node
/**
 * Does pressing U actually about-face the selection?
 *
 * The order path is already covered by `tools/probe-aboutface.mjs`, which emits
 * `orderIssued` directly. This checks the half that probe cannot: that a real key press on a
 * real page reaches `SelectionController.issueAboutFace`, that `KeyU` is not already spoken
 * for by the camera or the HUD, and that the order survives the replay's quantisation.
 *
 * Keyboard only, through Playwright's real key events — F selects the army, U turns it —
 * because a check that calls the method is a check of the method.
 *
 * Usage: node tools/scratch/af-hotkey.mjs --port=5945
 */

import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5945);

const browser = await launchBrowser({ label: 'af-hotkey', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'af-hotkey', slot: browser.budgetSlot,
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(300000);
await page.goto(`${base}/?harness=1&quality=low&autoplay=0&w=1280&h=720`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 300000 });

const canvas = await page.$('canvas');
await canvas.click({ position: { x: 640, y: 400 } });   // focus the page, clear any selection
await page.keyboard.press('KeyF');                       // select the army
await page.waitForTimeout(200);

const before = await page.evaluate(() => {
  const b = window.__game.battle;
  return b.units.filter((u) => u.selected && !u.destroyed)
    .map((u) => ({ id: u.id, facing: u.facing, targetFacing: u.targetFacing }));
});

await page.keyboard.press('KeyU');
// The order goes through ReplaySystem, which lands it on the next tick, so give the sim one.
await page.evaluate(() => window.__game.advanceTicks(2));

const after = await page.evaluate((ids) => {
  const b = window.__game.battle;
  return ids.map((id) => {
    const u = b.unitById(id);
    return { id, targetFacing: u ? u.targetFacing : null };
  });
}, before.map((u) => u.id));

const wrap = (a) => {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
};
// A loose tolerance on purpose. The clock is running — this is a real page being typed at,
// not a stopped harness — so a unit that was already wheeling has moved a few hundredths of
// a radian between the read and the key press. 0.25 rad is nowhere near a wrong answer:
// either the key reached `issueAboutFace` and the bearing flipped by a half turn, or it did
// not and the bearing did not move at all.
const TOL = 0.25;
let turned = 0;
let worst = 0;
for (let i = 0; i < before.length; i++) {
  const want = wrap(before[i].facing + Math.PI);
  const got = after[i].targetFacing;
  if (got === null) continue;
  const err = Math.abs(wrap(got - want));
  if (err > worst) worst = err;
  if (err < TOL) turned++;
}
console.log(`[af-hotkey] selected ${before.length} unit(s); `
  + `${turned} took the about-face; worst bearing error ${(worst * 180 / Math.PI).toFixed(3)} deg`);
if (errors.length) console.log('[page errors]', errors.slice(0, 3));

await page.close();
await browser.close();
await closeServer();
process.exit(before.length > 0 && turned === before.length ? 0 : 1);
