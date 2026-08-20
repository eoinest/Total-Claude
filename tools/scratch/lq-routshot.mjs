#!/usr/bin/env node
/**
 * A routing party at the foot of a wall, photographed: three frames from one fixed camera.
 *
 * The companion to `--set=escalade` in `tools/shoot.mjs`, and it is a probe rather than a
 * `SHOTS` entry for one reason: a rout is not something a fixed `at` time can be pointed at.
 * Which unit breaks, and when, is a property of how the battle went, and the whole point of
 * the change under test is that the battle now goes differently. A camera parked at t+31 on
 * bay -3 would photograph two unrelated situations and invite the reader to compare them.
 *
 * So the *situation* is fixed instead of the clock. Both arms search forward for the same
 * precondition — an escalade party with men still on the grass at its own ladders and at
 * least one man already over the parapet, which is the state that made `garrisons.has`
 * exempt it from release — then break it with `BattleSystem.rout` and photograph the same
 * three moments after: the instant it breaks, 1.5 s later, 3 s later.
 *
 * The camera is anchored to the party's own centroid and aimed at the wall those men were
 * queuing for, so it frames the ground they have to get off.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', 5487));
const MAP = arg('map', '');
const OUT = arg('out', '/tmp/lq-routshot');
const LABEL = arg('label', 'run');
const ZOOM = Number(arg('zoom', 0.26));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=high&w=1280&h=720${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

/*
 * Strip the interface the same way `shoot.mjs` does — by id, and by reaching into the
 * world-space overlay.
 *
 * The first cut of this hid every direct child of `body` that was not itself a canvas. The
 * canvas is not a direct child of `body`; it is inside a container, so that hid the
 * container and every frame came back 1280x720 of near-black. A black frame is the worst
 * possible failure here because it is not obviously wrong — it looks like a night shot, or
 * like the camera ended up inside the masonry, and either reading would have been reported
 * as a finding. Copy the harness that works rather than improvising a second one.
 */
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});
await page.evaluate(`(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  if (hud && hud.overlay) hud.overlay.visible = false;
})()`);

const setup = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const F = 1/30, tick = () => g.engine.advance(F, 1000/30);
  for (let i = 0; i < Math.round(12/F); i++) tick();
  let pick = null;
  for (let step = 0; step < 30 * 60 && !pick; step++) {
    const banks = new Map();
    for (const l of s.ladders) { const a = banks.get(l.unitId) ?? []; a.push(l); banks.set(l.unitId, a); }
    for (const [uid, group] of banks) {
      const u = b.unitById(uid);
      if (!u || u.destroyed || u.order === 5) continue;
      let foot = 0, wall = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (s.stationOf[i] >= 0) { wall++; continue; }
        if (s.crossOf[i] !== -1) continue;
        for (const l of group) if (Math.hypot(p.x[i]-l.x, p.z[i]-l.z) < 25) { foot++; break; }
      }
      if (foot >= 3 && wall >= 1 && (!pick || foot > pick.foot)) pick = { uid, group, foot, wall };
    }
    if (!pick) tick();
  }
  if (!pick) return { error: 'no party in the precondition' };
  const u = b.unitById(pick.uid);
  const foot = [];
  for (const i of u.members) if (p.aliveAt(i) && s.stationOf[i] === -1 && s.crossOf[i] === -1) foot.push(i);
  let cx = 0, cz = 0;
  for (const i of foot) { cx += p.x[i]; cz += p.z[i]; }
  cx /= Math.max(1, foot.length); cz /= Math.max(1, foot.length);
  window.__lq = { uid: pick.uid, foot, cx, cz, yaw: pick.group[0].facing, start: foot.map((i) => [p.x[i], p.z[i]]) };
  g.setCamera(cx, cz, ${ZOOM}, pick.group[0].facing);
  b.rout(u);
  g.advance(0.25);
  return { uid: pick.uid, foot: foot.length, wall: pick.wall,
    garrisoned: s.isGarrisoned(pick.uid), owned: s.ownsUnit(pick.uid),
    cx: +cx.toFixed(1), cz: +cz.toFixed(1), t: +g.engine.time.simTime.toFixed(1) };
})()`);

if (setup.error) { console.log(`--- ${LABEL} --- ERROR:`, setup.error); await browser.close(); process.exit(1); }
console.log(`--- ${LABEL} ---`);
console.log(`unit ${setup.uid}: ${setup.foot} men on the grass, ${setup.wall} over the parapet, `
  + `garrisoned=${setup.garrisoned} owned=${setup.owned}, broken at t+${setup.t}`);

const CAL = arg('cal', '');
if (CAL) {
  for (const z of CAL.split(',')) {
    await page.evaluate(`(() => { const g = window.__game;
      g.setCamera(window.__lq.cx, window.__lq.cz, ${z}, window.__lq.yaw); g.advance(0.05); })()`);
    await page.screenshot({ path: path.join(OUT, `cal-z${z}.png`) });
    console.log('  calibration frame at zoom', z);
  }
  await browser.close();
  process.exit(0);
}

const marks = [0, 1.5, 3.0];
for (const [n, secs] of marks.entries()) {
  if (n > 0) {
    await page.evaluate(`(() => {
      const g = window.__game;
      const F = 1/30;
      for (let i = 0; i < Math.round(${marks[n] - marks[n-1]}/F); i++) g.engine.advance(F, 1000/30);
      // Hold the camera where it was: this frame is about the men moving, not the lens.
      g.setCamera(window.__lq.cx, window.__lq.cz, ${ZOOM}, window.__lq.yaw);
      g.advance(0.05);
    })()`);
  }
  const stat = await page.evaluate(`(() => {
    const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
    const L = window.__lq;
    let moved = 0, n = 0, still = 0;
    for (let k = 0; k < L.foot.length; k++) {
      const i = L.foot[k];
      if (!p.aliveAt(i)) continue;
      const d = Math.hypot(p.x[i]-L.start[k][0], p.z[i]-L.start[k][1]);
      moved += d; n++;
      if (d < 1.0) still++;
    }
    return { owned: s.ownsUnit(L.uid), n, meanFled: n ? +(moved/n).toFixed(2) : 0, still };
  })()`);
  const file = path.join(OUT, `rout-${String(secs).replace('.', 'p')}s.png`);
  await page.screenshot({ path: file });
  console.log(`  t+${secs}s  owned=${stat.owned}  ${stat.n} men  mean fled ${stat.meanFled} m  `
    + `${stat.still} still within 1 m of where they broke   -> ${path.basename(file)}`);
}
console.log(`pageerrors: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 3));
await browser.close();
