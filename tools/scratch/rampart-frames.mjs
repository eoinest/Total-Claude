#!/usr/bin/env node
/**
 * Matched overhead frames of one cohort forming up on a rampart, at two destinations that
 * differ only in how many men the stone can seat.
 *
 * There is no before/after pair to shoot — this pass changed no simulation code — so the pair
 * that carries the finding is the *control* pair: the same 150-man `punic-levy`, the same
 * traverse verb, the same map and the same 300 s window, sent to a run with 280 seats and to
 * a run with 140. One settles; one never does.
 *
 * Usage: node tools/scratch/rampart-frames.mjs --port=5952
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5952);
const OUT = path.join(ROOT, 'screenshots', 'rampart-fit');
await mkdir(OUT, { recursive: true });

const browser = await launchBrowser({ label: 'rampart-frames', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'rampart-frames', slot: browser.budgetSlot,
});

const SETUP = `
(async () => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  const run = (sec) => { const n = Math.round(sec * 30); for (let k = 0; k < n; k++) step(); };
  window.__rf = { g, b, s, p, step, run };
  return true;
})()
`;

const shots = [
  { name: 'fits', seats: 'the run that holds it' },
  { name: 'does-not-fit', seats: 'the run that does not' },
];

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${base}/?harness=1&autoplay=0&quality=high&w=1600&h=900&map=carthage&scenario=assault`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
  await page.evaluate(SETUP);

  const info = await page.evaluate((wantSmall) => {
    const w = window.__rf, s = w.s, b = w.b;
    w.run(2);
    let u = null;
    for (const x of b.units) {
      if (x.destroyed || x.alive < 20 || !s.isGarrisoned(x.id) || s.plans.has(x.id)) continue;
      if (!u || x.alive > u.alive) u = x;
    }
    const here = s.stationNear(u.x, u.z);
    // Every run the walk joins this one to, with its seat count.
    const lo = new Map(), hi = new Map();
    for (let st = 0; st < s.stationCount; st++) {
      const r = s.sRun[st];
      if (!lo.has(r) || st < lo.get(r)) lo.set(r, st);
      if (!hi.has(r) || st > hi.get(r)) hi.set(r, st);
    }
    const rows = [];
    for (const r of lo.keys()) {
      if (r === s.sRun[here]) continue;
      if (!isFinite(s.walkDistance(here, r))) continue;
      const a = lo.get(r), c = hi.get(r);
      let ranks = 99;
      for (let k = a; k <= c; k++) {
        const n = Math.max(1, Math.min(5, Math.floor((s.sOuter[k] - s.sInner[k]) / 0.72) + 1));
        if (n < ranks) ranks = n;
      }
      rows.push({ run: r, lo: a, hi: c, stations: c - a + 1, ranks, seats: (c - a + 1) * ranks });
    }
    rows.sort((x, y) => x.seats - y.seats);
    const target = wantSmall ? rows[0] : rows[rows.length - 1];
    const dest = (target.lo + target.hi) >> 1;
    w.g.engine.events.emit("orderIssued",
      { unitIds: [u.id], kind: 'move', x: s.sx[dest], z: s.sz[dest] });
    w.step();
    w.run(300);
    // Census at the frame.
    let onWall = 0, far = 0, alive = 0;
    const seats = new Map();
    for (const i of u.members) {
      if (!w.p.aliveAt(i)) continue;
      alive++;
      if (s.stationOf[i] >= 0) onWall++;
      const d = Math.hypot(b.slotX[i] - w.p.x[i], b.slotZ[i] - w.p.z[i]);
      if (d > 0.6) far++;
      const key = Math.round(b.slotX[i] * 4) + ':' + Math.round(b.slotZ[i] * 4);
      seats.set(key, (seats.get(key) ?? 0) + 1);
    }
    let pile = 0, share = 0;
    for (const v of seats.values()) { if (v > pile) pile = v; if (v > 1) share += v; }
    /*
     * Overhead, over the destination, looking along the wall.
     *
     * The rig ties pitch to zoom, and the zoom that gives a steep enough pitch to see a
     * 5.75 m band puts the eye 300 m up, where a cohort is nine pixels. So the pitch is
     * pinned on the live rig and the zoom is left where it frames the men — the same
     * override `tools/film.mjs` uses for its wall shots, and for the same reason.
     */
    const rig = w.g.engine.rig;
    rig.pitchForZoom = () => 1.16;
    // The focus has to sit on the walk, not on the terrain thirteen metres under it, or the
    // men are off the top of the frame. Same override `film.mjs` uses for its wall shots.
    let cx = 0, cz = 0, cn = 0, cy = s.sy[dest];
    for (const i of u.members) {
      if (!w.p.aliveAt(i) || s.stationOf[i] < 0) continue;
      cx += w.p.x[i]; cz += w.p.z[i]; cn++;
    }
    if (cn > 0) { cx /= cn; cz /= cn; } else { cx = s.sx[dest]; cz = s.sz[dest]; }
    rig.heightAt = () => cy;
    if (rig.walkableTopAt) rig.walkableTopAt = null;
    const yaw = Math.atan2(-s.snz[dest], s.snx[dest]);
    w.g.setCamera(cx, cz, 0.52, yaw);
    // `jumpTo` sets the target and `update` eases toward it; the pitch override only takes
    // effect on the next update, so the frames below are shot after eight of them.
    return { unit: u.id, type: u.typeId, alive, run: target.run,
      stations: target.stations, ranks: target.ranks, seats: target.seats,
      surplus: Math.max(0, alive - target.seats), onWall, far, pile, share,
      x: +s.sx[dest].toFixed(1), z: +s.sz[dest].toFixed(1) };
  }, shot.name === 'does-not-fit');

  // Let the renderer catch up with the stepped world.
  await page.evaluate(() => { for (let k = 0; k < 8; k++) window.__rf.g.engine.advance(1 / 30, 1000 / 60); });
  await new Promise((r) => setTimeout(r, 900));
  const file = path.join(OUT, `carthage-${shot.name}.png`);
  await page.screenshot({ path: file });
  console.log(`${shot.name.padEnd(14)} run ${info.run}  ${info.stations} stations x ${info.ranks} ranks `
    + `= ${info.seats} seats,  roster ${info.alive}, surplus ${info.surplus}`);
  console.log(`               t=300s: ${info.onWall} on the walk, ${info.far} not on their slot, `
    + `worst pile ${info.pile}, ${info.share} men sharing a place  ->  ${file}`);
  await page.close();
}

await browser.close();
await closeServer();
