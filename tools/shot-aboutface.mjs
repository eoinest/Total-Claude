#!/usr/bin/env node
/**
 * Matched frames of a 180-degree about-face, so the numbers can be looked at.
 *
 * `tools/probe-aboutface.mjs` says the median man walked 20.45 m to turn round and now walks
 * 1.63 m. This is the same event with a camera on it: one legionary cohort and one squadron
 * of Roman cavalry, halted, settled, ordered to face the other way, and photographed at the
 * same *simulated* times either side of the change.
 *
 * The frames are matched because everything is stepped in ticks with the clock stopped — see
 * `tools/lib/simclock.mjs` — so `t+2.0` is the same 60 fixed steps in both runs and the two
 * images are of the same instant of the same battle.
 *
 * The camera looks along the block's own left flank rather than down at it, because the
 * thing being shown is which way the *men* are pointing and a plan view cannot show that.
 *
 * Usage:
 *   node tools/shot-aboutface.mjs --port=5943 --label=after
 *   node tools/shot-aboutface.mjs --port=5943 --label=before      (on the base tree)
 *
 * Output: screenshots/aboutface/<label>/<case>-t<seconds>.png
 */

import { mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { stopClockOnReady } from './lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5943);
const LABEL = args.get('label') ?? 'after';
const OUT = path.resolve(ROOT, `screenshots/aboutface/${LABEL}`);

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

await mkdir(OUT, { recursive: true });

const browser = await launchBrowser({ label: 'shot-aboutface', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'shot-aboutface', slot: browser.budgetSlot,
});

const SETUP = `
window.__afs = (() => {
  const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
  const wrap = (a) => {
    let v = a;
    while (v > Math.PI) v -= 2 * Math.PI;
    while (v < -Math.PI) v += 2 * Math.PI;
    return v;
  };
  /*
   * The shipped battle, with the two AIs stopped and nothing else.
   *
   * The first version of this rig tore the battle down and spawned its subject onto empty
   * ground, the way tools/probe-hivemind.mjs does — and photographed a black rectangle,
   * because that teardown shields every system's update and preRender in a try/catch and
   * whatever the sky and the terrain need in there stops happening. draws 0, tris 0k.
   *
   * Shooting the real battle is better evidence anyway: these are the men the owner was
   * looking at, on the ground he was looking at them on. Only the generals are silenced,
   * so the order under test is the only order the subject has.
   */
  let stopped = false;
  const stopGenerals = () => {
    if (stopped) return;
    stopped = true;
    for (const name of ['tactical-ai', 'general-ai']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
  };
  return { g, b, ctx, p, wrap, stopGenerals };
})();

window.__afsSetup = (spec) => {
  const H = window.__afs, { g, b, ctx } = H;
  H.stopGenerals();
  const cands = b.units.filter((u) => !u.destroyed && u.typeId === spec.type && !u.contactLock);
  cands.sort((a, c) => (c.alive - a.alive) || (a.id - c.id));
  const u = cands[0];
  if (!u) return { error: 'no subject of type ' + spec.type };
  ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });
  g.advance(spec.settle);
  // Close on the block, yawed off its own heading. zoom is a 0..1 fraction of the rig's
  // range, not metres — 0.30 to 0.40 is what tools/shoot.mjs uses for its unit plates.
  g.setCamera(u.x, u.z, spec.zoom, u.facing + spec.yaw);
  // Half a second of real frames after the jump, before anything is photographed: the rig
  // adopts a new focus in one frame and the motion blur and the TAA history do not, so a
  // shot taken straight after setCamera is of a smear. Identical in both runs.
  g.advance(0.5);
  return { id: u.id, x: u.x, z: u.z, facing: u.facing, alive: u.alive, formation: u.formationId };
};

window.__afsOrder = (id) => {
  const H = window.__afs;
  const u = H.b.unitById(id);
  H.ctx.events.emit('orderIssued', {
    unitIds: [id], kind: 'facing', facing: H.wrap(u.facing + Math.PI),
  });
};

/*
 * Step with the rasteriser on, so the canvas is current when the screenshot is taken.
 *
 * advanceTicks — which is what tools/probe-aboutface.mjs measures with — passes
 * render:false and leaves the canvas showing the frame before the call, which is fine for a
 * number and useless for a photograph. advance() draws every synthetic frame. Both runs get
 * the identical schedule from a stopped, rebased clock, so t+2 is the same instant of the
 * same battle in both, which is the only property these frames need.
 */
window.__afsStep = (seconds) => window.__game.advance(seconds);
`;

const CASES = [
  { id: 'infantry', type: 'legio-cohort', settle: 8, yaw: 0, zoom: 0.36 },
  { id: 'cavalry', type: 'equites', settle: 8, yaw: 0, zoom: 0.40 },
];
/** Simulated seconds after the order. t+0 is the frame the order was given on. */
const MARKS = [0, 1, 2, 4, 8];

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(300000);
await stopClockOnReady(page);
await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=1280&h=720`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());
await page.evaluate((s) => { new Function(s)(); }, SETUP);

console.log(`[shot-aboutface] tree ${rev} — ${LABEL}`);
for (const spec of CASES) {
  const info = await page.evaluate((s) => window.__afsSetup(s), spec);
  if (info.error) { console.log(`${spec.id}: ${info.error}`); continue; }
  console.log(`  ${spec.id}: ${spec.type} in ${info.formation}, ${info.alive} men `
    + `at ${info.x.toFixed(1)}, ${info.z.toFixed(1)} facing ${(info.facing * 180 / Math.PI).toFixed(0)} deg`);
  await page.evaluate((id) => window.__afsOrder(id), info.id);
  let at = 0;
  for (const t of MARKS) {
    const step = t - at;
    at = t;
    if (step > 0) await page.evaluate((s) => window.__afsStep(s), step);
    else await page.evaluate(() => window.__afsStep(1 / 60));
    const file = path.join(OUT, `${spec.id}-t${String(t).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, type: 'png' });
    console.log(`    t+${t}s -> ${path.relative(ROOT, file)}`);
  }
}
if (errors.length) console.log('[page errors]', errors.slice(0, 3));

await page.close();
await browser.close();
await closeServer();
