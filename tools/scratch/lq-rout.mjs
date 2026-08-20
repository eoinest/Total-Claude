#!/usr/bin/env node
/**
 * Break an escalade party on purpose, and watch its men leave. Or not.
 *
 * The natural-rout detector in `lq-measure.mjs` depends on which unit the battle happens to
 * break, which is not stable across a steering change. This is the controlled form: advance
 * to a fixed time, find a party that is in the precondition the bug needs — men queueing at
 * the foot of its ladders AND at least one man already over the parapet, so `adoptBoarders`
 * has made it a garrison — call `BattleSystem.rout` on it, and measure.
 *
 * Two questions:
 *   does the siege let go of the men on the grass, so they actually run;
 *   and does it keep hold of the men on the stonework, so nobody is dropped off the wall.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', 5487));
const MAP = arg('map', '');
const AT = Number(arg('at', 12));
const MINFOOT = Number(arg('minfoot', 3));
const LABEL = arg('label', 'run');
const OUT = arg('out', '/tmp/lq-rout.json');
const SHOTS = arg('shots', '');
const QUALITY = arg('quality', 'low');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: SHOTS ? 1280 : 800, height: SHOTS ? 720 : 500 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=${QUALITY}${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

const r = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const F = 1/30, tick = () => g.engine.advance(F, 1000/30);
  const med = (a) => { if (!a.length) return null; const q=[...a].sort((x,y)=>x-y); return q[Math.floor(q.length/2)]; };
  for (let i = 0; i < Math.round(${AT}/F); i++) tick();

  /*
   * Search forward for the precondition rather than assuming a time.
   *
   * The two builds do not reach the same world state at the same second — the muster fix
   * changes how fast a bank empties, which is the point of it — so a fixed --at compares
   * two different situations. The rule is the same on both arms: take the first moment any
   * escalade party has men still on the grass at its own ladders *and* at least one man
   * already over the parapet, which is the state that made garrisons.has exempt it.
   */
  const MINFOOT = ${MINFOOT};
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
      if (foot >= MINFOOT && wall >= 1 && (!pick || foot > pick.foot)) pick = { uid, group, foot, wall };
    }
    if (!pick) tick();
  }
  if (!pick) return { error: 'no party in the precondition (men at the foot + men on the wall)' };

  const u = b.unitById(pick.uid);
  const pre = { uid: pick.uid, foot: pick.foot, wall: pick.wall,
    garrisoned: s.isGarrisoned(pick.uid), owned: s.ownsUnit(pick.uid), order: u.order };

  const footMen = [], wallMen = [];
  for (const i of u.members) {
    if (!p.aliveAt(i)) continue;
    if (s.stationOf[i] >= 0 || s.crossOf[i] !== -1) wallMen.push(i);
    else footMen.push(i);
  }
  const start = new Map(), yPrev = new Map();
  for (const i of footMen) start.set(i, [p.x[i], p.z[i]]);
  for (const i of wallMen) yPrev.set(i, p.y[i]);

  // Hand the camera the party's own ground, so the frame is the same situation on both
  // arms even though the two builds do not reach it at the same second. Focus on the
  // centroid of the men still on the grass, looking at the wall they were queuing for.
  let cx = 0, cz = 0, cn = 0;
  for (const i of footMen) { cx += p.x[i]; cz += p.z[i]; cn++; }
  window.__lqCam = { x: cx / Math.max(1, cn), z: cz / Math.max(1, cn), yaw: pick.group[0].facing };

  b.rout(u);

  const N = 90;
  const prev = new Map(start);
  const speeds = [], toSlot = [];
  const dist = new Map(), nT = new Map();
  let worstDy = 0, worstOffSupport = 0, fell = 0;
  let ownedAfter1 = null;
  for (let t = 0; t < N; t++) {
    tick();
    if (t === 0) ownedAfter1 = s.ownsUnit(u.id);
    for (const i of footMen) {
      if (!p.aliveAt(i) || s.crossOf[i] !== -1 || s.stationOf[i] !== -1) continue;
      const xy = prev.get(i);
      const d = Math.hypot(p.x[i]-xy[0], p.z[i]-xy[1]);
      speeds.push(d / F);
      toSlot.push(Math.hypot(b.slotX[i]-p.x[i], b.slotZ[i]-p.z[i]));
      dist.set(i, (dist.get(i) ?? 0) + d); nT.set(i, (nT.get(i) ?? 0) + 1);
      prev.set(i, [p.x[i], p.z[i]]);
    }
    for (const i of wallMen) {
      if (!p.aliveAt(i)) continue;
      const y0 = yPrev.get(i);
      const dy = Math.abs(p.y[i] - y0);
      if (dy > worstDy) worstDy = dy;
      if (dy > 1.0) fell++;
      yPrev.set(i, p.y[i]);
      if (b.elevated[i] !== 0 && b.support[i] > -1e8) worstOffSupport = Math.max(worstOffSupport, Math.abs(p.y[i] - b.support[i]));
    }
  }
  const perMan = [];
  for (const [i, d] of dist) { const n = nT.get(i) ?? 0; if (n >= 30) perMan.push(d/(n*F)); }
  const gone = [];
  for (const i of footMen) if (p.aliveAt(i)) {
    const st = start.get(i);
    gone.push(Math.hypot(p.x[i]-st[0], p.z[i]-st[1]));
  }
  const def = b.typeOf(u);
  return { pre, ownedAfter1Tick: ownedAfter1, ownedAtEnd: s.ownsUnit(u.id),
    footMen: footMen.length, wallMen: wallMen.length,
    medSpeedPerMan: perMan.length ? +med(perMan).toFixed(3) : null,
    medTickSpeed: speeds.length ? +med(speeds).toFixed(3) : null,
    stalledTickFrac: speeds.length ? +(speeds.filter((v)=>v<0.2).length/speeds.length).toFixed(3) : null,
    medToSlot: toSlot.length ? +med(toSlot).toFixed(3) : null,
    medDistanceFled3s: gone.length ? +med(gone).toFixed(2) : null,
    runSpeed: +(def.runSpeed*1.06).toFixed(2), walkSpeed: +def.walkSpeed.toFixed(2),
    worstTickDy: +worstDy.toFixed(3), worstOffSupport: +worstOffSupport.toFixed(3), fell,
    t: +g.engine.time.simTime.toFixed(1) };
})()`);

r.label = LABEL; r.errs = errs;
fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(`--- ${LABEL} (pageerrors ${errs.length}) ---`);
console.log(JSON.stringify(r, null, 1));
await browser.close();
