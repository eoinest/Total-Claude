#!/usr/bin/env node
/**
 * Per-tick position trace at a ladder foot.
 *
 * Two questions, one run:
 *   A. what exactly are the men queueing for a ladder doing tick to tick;
 *   B. what is a man of a *routed* escalade party at the wall foot doing tick to tick.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', 5487));
const MAP = arg('map', '');
const WARM = Number(arg('warm', 18));
const TICKS = Number(arg('ticks', 120));
const OUT = arg('out', '/tmp/lq-trace.json');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=low${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

const data = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const FIXED = 1 / 30;
  const tick = () => g.engine.advance(FIXED, 1000 / 30);

  const banks = () => {
    const m = new Map();
    for (const l of s.ladders) { const a = m.get(l.unitId) ?? []; a.push(l); m.set(l.unitId, a); }
    return m;
  };
  // Which ladder of the bank a point is nearest, and how far.
  const nearestRail = (group, x, z) => {
    let k = -1, bd = Infinity;
    for (let n = 0; n < group.length; n++) {
      const d = Math.hypot(group[n].x - x, group[n].z - z);
      if (d < bd) { bd = d; k = n; }
    }
    return { k, d: bd };
  };

  for (let i = 0; i < Math.round(${WARM} / FIXED); i++) tick();

  // ---- pick the bank with the most men still queueing on the ground ----
  const bs = banks();
  let pick = null;
  for (const [uid, group] of bs) {
    const u = b.unitById(uid);
    if (!u || u.destroyed || u.order === 5) continue;
    let q = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if (s.stationOf[i] >= 0 || s.crossOf[i] !== -1) continue;
      q++;
    }
    if (!pick || q > pick.q) pick = { uid, group, q };
  }
  if (!pick) return { error: 'no bank queueing' };

  const u = b.unitById(pick.uid);
  const rails = pick.group.map((l, n) => ({ n, x: +l.x.toFixed(2), z: +l.z.toFixed(2), st: l.station }));
  // pitch between adjacent rails
  const pitch = [];
  for (let n = 1; n < pick.group.length; n++) pitch.push(+Math.hypot(pick.group[n].x - pick.group[n-1].x, pick.group[n].z - pick.group[n-1].z).toFixed(2));

  const frames = [];
  for (let t = 0; t < ${TICKS}; t++) {
    tick();
    const men = [];
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const onCross = s.crossOf[i] !== -1;
      const st = s.stationOf[i];
      const slotRail = nearestRail(pick.group, b.slotX[i], b.slotZ[i]);
      const posRail = nearestRail(pick.group, p.x[i], p.z[i]);
      men.push({
        i,
        x: +p.x[i].toFixed(3), z: +p.z[i].toFixed(3), y: +p.y[i].toFixed(2),
        sx: +b.slotX[i].toFixed(3), sz: +b.slotZ[i].toFixed(3),
        st, cross: onCross ? 1 : 0,
        // which rail his SLOT sits behind, and how far his slot is from that rail's foot
        srail: slotRail.k, srd: +slotRail.d.toFixed(2),
        prail: posRail.k, prd: +posRail.d.toFixed(2),
      });
    }
    frames.push({ t: +g.engine.time.simTime.toFixed(3), order: u.order, alive: u.alive, men });
  }
  return { uid: pick.uid, typeId: u.typeId, rails, pitch, frames };
})()`);

// ---- part B: run on to a rout and trace displacement ----
const rout = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const FIXED = 1 / 30;
  const tick = () => g.engine.advance(FIXED, 1000 / 30);
  const banks = () => { const m = new Map(); for (const l of s.ladders) { const a = m.get(l.unitId) ?? []; a.push(l); m.set(l.unitId, a); } return m; };
  // advance until some ladder party is routing with men still on the ground at the foot
  let target = null;
  for (let step = 0; step < 30 * 240 && !target; step++) {
    tick();
    for (const [uid, group] of banks()) {
      const u = b.unitById(uid);
      if (!u || u.destroyed || u.order !== 5) continue;
      let foot = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (s.stationOf[i] >= 0 || s.crossOf[i] !== -1) continue;
        for (const l of group) if (Math.hypot(p.x[i]-l.x, p.z[i]-l.z) < 15) { foot++; break; }
      }
      if (foot >= 4) { target = { uid, group, foot }; break; }
    }
  }
  if (!target) return { error: 'no routed party found at a wall foot' };
  const u = b.unitById(target.uid);
  const frames = [];
  const prev = new Map();
  for (let t = 0; t < 90; t++) {
    tick();
    const men = [];
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if (s.stationOf[i] >= 0 || s.crossOf[i] !== -1) continue;
      const px = prev.get(i);
      const d = px ? Math.hypot(p.x[i]-px[0], p.z[i]-px[1]) : null;
      prev.set(i, [p.x[i], p.z[i]]);
      men.push({ i, x: +p.x[i].toFixed(3), z: +p.z[i].toFixed(3),
        sx: +b.slotX[i].toFixed(3), sz: +b.slotZ[i].toFixed(3),
        toSlot: +Math.hypot(b.slotX[i]-p.x[i], b.slotZ[i]-p.z[i]).toFixed(3),
        v: +Math.hypot(p.vx[i], p.vz[i]).toFixed(3),
        step: d === null ? null : +d.toFixed(4),
        state: p.state[i] });
    }
    frames.push({ t: +g.engine.time.simTime.toFixed(3), order: u.order, alive: u.alive,
      owned: s.ownsUnit(u.id), garrison: s.isGarrisoned ? s.isGarrisoned(u.id) : null, men });
  }
  return { uid: target.uid, typeId: u.typeId, frames };
})()`);

fs.writeFileSync(OUT, JSON.stringify({ queue: data, rout, errs }, null, 1));
console.log('pageerrors:', errs.length, errs.slice(0, 3));
console.log('wrote', OUT);
if (data.error) console.log('QUEUE ERROR', data.error);
else {
  console.log(`bank unit ${data.uid} (${data.typeId}) rails=${data.rails.length} pitch=${data.pitch} m`);
  console.log('rails', JSON.stringify(data.rails));
}
if (rout.error) console.log('ROUT ERROR', rout.error);
else console.log(`routed unit ${rout.uid} (${rout.typeId}), ${rout.frames.length} frames`);
await browser.close();
