#!/usr/bin/env node
/**
 * The frontage arithmetic, caught in the act.
 *
 * Orders one 160-man cohort onto three different stretches of the same wall — an empty
 * long run, an occupied run, a short run — and reports what the layout hands out: the
 * garrison window, and how many men are being steered at the *same physical point*.
 *
 * The last of those is the measurement that matters and the one the first instrument
 * missed. Counting duplicate `(station, rank)` pairs reads zero even when every man in the
 * unit is walking at the same 0.8 m of stone, because `layOutArrived` gives each man a
 * distinct rank and `slotAt` then clamps every rank past the band's depth to the same
 * offset. The seats are distinct in the ledger and identical on the ground.
 */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5491);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? '';
const SECS = Number(process.argv.find((a) => a.startsWith('--secs='))?.slice(7) ?? 200);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });

const HELP = `
window.__f = (() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  g.engine.stop();
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  const run = (sec) => { const n = Math.round(sec * 30); for (let k = 0; k < n; k++) step(); };
  const click = (u, x, z) => g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z });
  const runLo = [], runHi = [];
  for (let i = 0; i < s.stationCount; i++) {
    const r = s.sRun[i];
    if (runLo[r] === undefined) runLo[r] = i;
    runHi[r] = i;
  }
  /** Men per distinct slot point, quantised to 0.25 m. The honest collision metric. */
  const slotPile = (u) => {
    const m = new Map();
    let n = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if (s.stationOf[i] < 0) continue;
      n++;
      const k = Math.round(b.slotX[i] * 4) + ':' + Math.round(b.slotZ[i] * 4);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    let worst = 0, shared = 0;
    for (const v of m.values()) { if (v > worst) worst = v; if (v > 1) shared += v; }
    return { placed: n, distinctSlots: m.size, worstPile: worst, menSharingASlot: shared };
  };
  const rankSpread = (u) => {
    let hi = 0; const h = {};
    for (const i of u.members) {
      if (!p.aliveAt(i) || s.stationOf[i] < 0) continue;
      const r = s.rankOf[i];
      if (r > hi) hi = r;
      h[r] = (h[r] ?? 0) + 1;
    }
    return { maxRank: hi, ranks: Object.keys(h).length };
  };
  const owners = (r) => {
    const o = {};
    for (let i = runLo[r]; i <= runHi[r]; i++) o[s.sOwner[i]] = (o[s.sOwner[i]] ?? 0) + 1;
    return o;
  };
  const pic = (u) => {
    const gg = s.garrisons.get(u.id), pl = s.plans.get(u.id);
    let sp = 0, n = 0, toSlot = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; sp += Math.hypot(p.vx[i], p.vz[i]);
      toSlot += Math.hypot(b.slotX[i] - p.x[i], b.slotZ[i] - p.z[i]);
    }
    return { alive: n, meanSpeed: n ? +(sp / n).toFixed(3) : 0,
      meanToSlot: n ? +(toSlot / n).toFixed(2) : 0,
      g: gg ? { from: gg.from, span: gg.span, ranks: gg.ranks, overflow: gg.overflow } : null,
      plan: pl ? { goal: pl.goal, age: pl.age, stuck: pl.stuck } : null,
      ...slotPile(u), ...rankSpread(u) };
  };
  return { g, b, s, p, step, run, click, runLo, runHi, pic, owners, slotPile };
})();
undefined;
`;

async function one(label, pick, secs) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/?harness=1&autoplay=0&quality=high&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(HELP);
  const r = await page.evaluate(([mode, sec]) => {
    const w = window.__f, s = w.s, b = w.b;
    w.run(2);
    const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction;
    let u = null;
    for (const q of b.units) {
      if (q.destroyed || q.faction !== defender) continue;
      if (s.ownsUnit(q.id) || s.isGarrisoned(q.id)) continue;
      if (!u || q.alive > u.alive) u = q;
    }
    if (!u) return { fail: 'no cohort' };
    // Runs by length and by how much of them is already claimed.
    const cand = [];
    for (let r = 0; r < s.runNext.length; r++) {
      if (w.runLo[r] === undefined) continue;
      let free = 0;
      for (let i = w.runLo[r]; i <= w.runHi[r]; i++) if (s.sOwner[i] < 0) free++;
      const len = w.runHi[r] - w.runLo[r] + 1;
      const mid = (w.runLo[r] + w.runHi[r]) >> 1;
      cand.push({ run: r, len, free, mid,
        d: Math.hypot(s.sx[mid] - u.x, s.sz[mid] - u.z) });
    }
    let target;
    if (mode === 'long-empty') {
      target = cand.filter((c) => c.free === c.len && c.len >= 30).sort((a, b2) => a.d - b2.d)[0];
    } else if (mode === 'occupied') {
      target = cand.filter((c) => c.free < c.len * 0.5).sort((a, b2) => a.d - b2.d)[0];
    } else {
      target = cand.slice().sort((a, b2) => a.len - b2.len)[0];
    }
    if (!target) return { fail: 'no run of that kind', cand };
    const dest = target.mid;
    const before = { alive: u.alive, width: u.width, type: u.typeId };
    const ownersBefore = w.owners(target.run);
    w.click(u, s.sx[dest], s.sz[dest]);
    const marks = [];
    for (const t of [10, 30, 60, 100, 150, sec]) {
      w.run(t - (marks.length ? marks[marks.length - 1].t : 0));
      marks.push({ t, ...w.pic(u) });
    }
    return {
      mode, unitId: u.id, before,
      target: { run: target.run, len: target.len, freeStations: target.free, dest },
      band: +(s.sOuter[dest] - s.sInner[dest]).toFixed(3),
      bandRanks: Math.min(5, Math.floor((s.sOuter[dest] - s.sInner[dest]) / 0.72) + 1),
      ownersBefore, ownersAfter: w.owners(target.run),
      marks,
    };
  }, [pick, secs]);
  await page.close();
  return { label, ...r, errs };
}

const out = [];
for (const m of ['long-empty', 'occupied', 'short']) out.push(await one(m, m, SECS));
await browser.close();
for (const r of out) {
  console.log(`\n===== ${r.label} =====`);
  const { marks, ...rest } = r;
  console.log(JSON.stringify(rest));
  for (const k of marks ?? []) console.log('  ' + JSON.stringify(k));
}
