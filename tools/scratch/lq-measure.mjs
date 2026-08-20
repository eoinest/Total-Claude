#!/usr/bin/env node
/**
 * The four numbers this workstream is judged on. Same run, same seed, before and after.
 *
 *   M1  ladder bank: how often a waiting man's assigned rail changes, and by how far
 *   M2  tower muster: the same question for a boarding column
 *   M3  a routed party at the foot of a wall: how fast its men actually move
 *   M4  a ram whose crew has routed: does the machine still roll
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', 5487));
const MAP = arg('map', '');
const OUT = arg('out', '/tmp/lq-measure.json');
const LABEL = arg('label', 'run');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=low${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

const r = await page.evaluate(`(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const F = 1/30, tick = () => g.engine.advance(F, 1000/30);
  const med = (a) => { if (!a.length) return null; const q=[...a].sort((x,y)=>x-y); return q[Math.floor(q.length/2)]; };
  const near = (list, x, z) => { let k=-1,bd=Infinity; for (let n=0;n<list.length;n++){const d=Math.hypot(list[n].x-x,list[n].z-z); if(d<bd){bd=d;k=n;}} return k; };

  // ---------- M1 / M2 : slot stability while men queue ----------
  for (let i = 0; i < Math.round(18/F); i++) tick();

  const trackSlots = (members, anchors) => {
    // returns per-man: number of anchor changes, and the list of slot jumps
    const lastAnchor = new Map(), lastSlot = new Map(), changes = new Map();
    const jumps = [];
    const seen = new Set();
    return {
      sample() {
        for (const i of members()) {
          seen.add(i);
          const a = near(anchors(), b.slotX[i], b.slotZ[i]);
          const la = lastAnchor.get(i);
          if (la !== undefined && la !== a) changes.set(i, (changes.get(i) ?? 0) + 1);
          lastAnchor.set(i, a);
          const ls = lastSlot.get(i);
          if (ls) { const d = Math.hypot(b.slotX[i]-ls[0], b.slotZ[i]-ls[1]); if (d > 0.05) jumps.push(d); }
          lastSlot.set(i, [b.slotX[i], b.slotZ[i]]);
        }
      },
      report(secs) {
        const ch = [...changes.values()];
        const total = ch.reduce((x,y)=>x+y,0);
        return { men: seen.size, changes: total,
          perManPerSec: seen.size ? +(total/seen.size/secs).toFixed(3) : null,
          jumps: jumps.length, medJump: jumps.length ? +med(jumps).toFixed(2) : null,
          maxJump: jumps.length ? +Math.max(...jumps).toFixed(2) : null,
          bigJumps: jumps.filter(d=>d>3).length };
      },
    };
  };

  // pick the busiest ladder bank
  const banks = new Map();
  for (const l of s.ladders) { const a = banks.get(l.unitId) ?? []; a.push(l); banks.set(l.unitId, a); }
  let bank = null;
  for (const [uid, group] of banks) {
    const u = b.unitById(uid);
    if (!u || u.destroyed || u.order === 5) continue;
    let q = 0;
    for (const i of u.members) if (p.aliveAt(i) && s.stationOf[i] < 0 && s.crossOf[i] === -1) q++;
    if (!bank || q > bank.q) bank = { uid, group, q };
  }
  const tower = s.towers.find((t) => { const u = b.unitById(t.unitId); return u && !u.destroyed && u.order !== 5; }) ?? null;

  const ladderM = bank ? trackSlots(
    function*(){ const u=b.unitById(bank.uid); if(!u) return;
      for (const i of u.members) if (p.aliveAt(i) && s.stationOf[i] < 0 && s.crossOf[i] === -1) yield i; },
    () => bank.group) : null;
  const towerM = tower ? trackSlots(
    function*(){ for (const uid of tower.boarders) { const u=b.unitById(uid); if(!u) continue;
      for (const i of u.members) if (p.aliveAt(i) && s.stationOf[i] < 0 && s.crossOf[i] === -1) yield i; } },
    // a tower column is four files 0.9 m apart; use four virtual anchors across its rear
    () => { const c=Math.cos(tower.facing), sn=Math.sin(tower.facing); const out=[];
      for (let f=0;f<4;f++){ const rx=(f-1.5)*0.9, fz=-(3.6); out.push({x:tower.x+rx*c+fz*sn, z:tower.z-rx*sn+fz*c}); }
      return out; }) : null;

  const TICKS = 150;
  for (let t = 0; t < TICKS; t++) { tick(); if (ladderM) ladderM.sample(); if (towerM) towerM.sample(); }
  const secs = TICKS * F;
  const M1 = ladderM ? { ...ladderM.report(secs), rails: bank.group.length,
    pitch: +Math.hypot(bank.group[1].x-bank.group[0].x, bank.group[1].z-bank.group[0].z).toFixed(2), uid: bank.uid } : null;
  const M2 = towerM ? towerM.report(secs) : null;

  // ---------- M3 : a routed party at a wall foot ----------
  // The detector must not depend on the bug it is measuring. It fires on the *first* tick
  // any escalade party is routing with at least one man still standing on the ground within
  // 25 m of one of its own rails — which is true the instant the party breaks, whether or
  // not the siege is still holding him there.
  let M3 = { error: 'none found' };
  let found = null;
  for (let step = 0; step < 30*260 && !found; step++) {
    tick();
    for (const [uid, group] of (() => { const m=new Map(); for (const l of s.ladders){const a=m.get(l.unitId)??[];a.push(l);m.set(l.unitId,a);} return m; })()) {
      const u = b.unitById(uid);
      if (!u || u.destroyed || u.order !== 5) continue;
      let foot = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i) || s.stationOf[i] !== -1 || s.crossOf[i] !== -1) continue;
        for (const l of group) if (Math.hypot(p.x[i]-l.x, p.z[i]-l.z) < 25) { foot++; break; }
      }
      if (foot >= 1) { found = { uid, group }; break; }
    }
  }
  if (found) {
    const u = b.unitById(found.uid);
    const prev = new Map(), dist = new Map(), ticks = new Map();
    const samples = [], toSlot = [];
    const N = 90;
    let ownedAt0 = s.ownsUnit(u.id);
    for (const i of u.members) if (p.aliveAt(i) && s.stationOf[i] === -1 && s.crossOf[i] === -1) prev.set(i, [p.x[i], p.z[i]]);
    // M5: nobody on the stonework may be dropped by the release. Watch every man of the
    // party who is standing on a station or on the rungs, and record the worst vertical
    // step and the worst gap between his feet and the surface he is supposed to be on.
    let worstDy = 0, worstOffSupport = 0, wallMen = 0;
    const yPrev = new Map();
    for (const i of u.members) if (p.aliveAt(i) && (s.stationOf[i] >= 0 || s.crossOf[i] !== -1)) { yPrev.set(i, p.y[i]); wallMen++; }
    for (let t = 0; t < N; t++) {
      tick();
      for (const [i, y0] of yPrev) {
        if (!p.aliveAt(i)) continue;
        worstDy = Math.max(worstDy, Math.abs(p.y[i] - y0));
        yPrev.set(i, p.y[i]);
        if (b.elevated[i] !== 0 && b.support[i] > -1e8) worstOffSupport = Math.max(worstOffSupport, Math.abs(p.y[i] - b.support[i]));
      }
      for (const [i, xy] of prev) {
        if (!p.aliveAt(i) || s.stationOf[i] !== -1 || s.crossOf[i] !== -1) continue;
        const d1 = Math.hypot(p.x[i]-xy[0], p.z[i]-xy[1]);
        dist.set(i, (dist.get(i) ?? 0) + d1);
        ticks.set(i, (ticks.get(i) ?? 0) + 1);
        samples.push(d1 / F);
        toSlot.push(Math.hypot(b.slotX[i]-p.x[i], b.slotZ[i]-p.z[i]));
        prev.set(i, [p.x[i], p.z[i]]);
      }
    }
    const speeds = [], still = [];
    for (const [i, d] of dist) {
      const n = ticks.get(i) ?? 0;
      if (n < 30) continue;
      const v = d / (n*F);
      speeds.push(v);
      if (v < 0.25) still.push(i);
    }
    const def = b.typeOf(u);
    M3 = { uid: found.uid, owned: ownedAt0, men: speeds.length,
      medSpeed: speeds.length ? +med(speeds).toFixed(3) : null,
      maxSpeed: speeds.length ? +Math.max(...speeds).toFixed(3) : null,
      rootedMen: still.length,
      stalledTickFrac: samples.length ? +(samples.filter((v)=>v<0.2).length/samples.length).toFixed(3) : null,
      medToSlot: toSlot.length ? +med(toSlot).toFixed(3) : null,
      samples: samples.length,
      expectedRunSpeed: +(def.runSpeed*1.06).toFixed(2), walkSpeed: +def.walkSpeed.toFixed(2),
      // M5, reported alongside because it is the safety half of the same change.
      wallMen, worstTickDy: +worstDy.toFixed(3), worstOffSupport: +worstOffSupport.toFixed(3) };
  }

  // ---------- M4 : a ram whose crew has routed ----------
  let M4 = { error: 'no routed ram crew seen' };
  for (let step = 0; step < 30*200; step++) {
    tick();
    const r0 = s.rams.find((r) => { const u=b.unitById(r.unitId); return !r.wreck && u && u.order === 5; });
    if (!r0) continue;
    const x0 = r0.x, z0 = r0.z, uid0 = r0.unitId;
    for (let t = 0; t < 60; t++) tick();
    const u = b.unitById(r0.unitId);
    M4 = { moved: +Math.hypot(r0.x-x0, r0.z-z0).toFixed(3), overSecs: 2,
      crewStillRouted: !!u && u.order === 5, crewChanged: r0.unitId !== uid0, state: r0.state };
    break;
  }

  return { M1, M2, M3, M4, t: +g.engine.time.simTime.toFixed(1) };
})()`);

r.label = LABEL; r.errs = errs;
fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(`--- ${LABEL} (pageerrors ${errs.length}) ---`);
console.log('M1 ladder bank :', JSON.stringify(r.M1));
console.log('M2 tower column:', JSON.stringify(r.M2));
console.log('M3 routed foot :', JSON.stringify(r.M3));
console.log('M4 routed ram  :', JSON.stringify(r.M4));
if (errs.length) console.log(errs.slice(0,3));
await browser.close();
