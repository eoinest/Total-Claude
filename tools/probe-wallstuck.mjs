#!/usr/bin/env node
/**
 * What "stuck on the wall" actually is, measured per tick and per man.
 *
 * Two owner reports, same code region:
 *   A. "units on a wall try and stay in formation on top of the wall. If the formation is
 *      too large they get stuck."
 *   B. "routed units half up the wall … some on top routed, some at the bottom routed, and
 *      they kind of are all stuck half on the wall half off."
 *
 * This file measures and asserts nothing. It prints a trace. Every number comes out of the
 * simulation arrays; the only page calls are `engine.advance` and read-only census.
 *
 * **The stepping idiom is fixed at `advance(1/30, 1000/60, { render: false })`** — two 60 Hz
 * frames, exactly one 30 Hz fixed tick, which is `__game.fastForward`'s own idiom and the
 * one `qa-determinism` pins. A coarser step is a different battle (see `Engine.advance`).
 *
 * Usage: node tools/probe-wallstuck.mjs --port=5491 [--map=carthage] [--json=path]
 *        [--only=A,B,C,D]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5491);
const MAP = args.get('map') ?? '';
const JSON_OUT = args.get('json') ?? null;
const ONLY = args.get('only') ? new Set(args.get('only').split(',')) : null;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server at ${base} — a probe falling through to dist/ measures a build`);
  process.exit(2);
}
console.log(`• dev server ${base}${MAP ? `, map ${MAP}` : ''}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const errs = [];

const HELPERS = `
window.__ws = (() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const city = g.engine.context.get('city');
  g.engine.stop();

  /** Exactly one 30 Hz fixed tick, at the 60 Hz frame step the determinism pin uses. */
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  const run = (sec) => { const n = Math.round(sec * 30); for (let k = 0; k < n; k++) step(); };

  const click = (u, x, z) =>
    g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z });

  /**
   * Where a man is, in the only three places the wall has: the parapet, a path, the grass.
   * Read off the arrays the sim itself branches on, so it cannot disagree with behaviour.
   *   parapet: stationOf >= 0            (he holds a slot on the stonework)
   *   rungs:   crossOf !== -1            (he is on a ladder/stair/ramp path)
   *   pending: stationOf === -2          (PENDING_SLOT: over the parapet, no slot yet)
   *   link:    stationOf === -3          (ON_LINK)
   *   grass:   stationOf === -1 && crossOf === -1
   */
  const where = (i) => {
    if (s.crossOf[i] !== -1) return 'rungs';
    const st = s.stationOf[i];
    if (st >= 0) return 'parapet';
    if (st === -2) return 'pending';
    if (st === -3) return 'link';
    return 'grass';
  };

  const bays = city.getGarrisonBays();
  const mid = (q) => ({ x: (q.x0 + q.x1) * 0.5, z: (q.z0 + q.z1) * 0.5, nx: q.nx, nz: q.nz });
  const nearestBay = (x, z, needG) => {
    let best = null, bd = Infinity;
    for (const q of bays) {
      if (needG && !q.garrisonable) continue;
      const c = mid(q); const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };

  /** The run a station belongs to, and how many stations that run holds. */
  const runOf = (st) => (st >= 0 && st < s.stationCount ? s.sRun[st] : -1);
  const runLen = (r) => {
    let n = 0;
    for (let k = 0; k < s.stationCount; k++) if (s.sRun[k] === r) n++;
    return n;
  };

  /**
   * One tick's picture of a unit. Everything the two reports could plausibly be.
   *
   *  - the census by locus
   *  - how many men are *sharing* a (station, rank) place, which is a formation that does
   *    not fit expressing itself as men standing inside each other
   *  - lateral offset from the walkway centreline against the bay's own clear band, so
   *    "outside the band" is measured against the stone and not against a constant
   *  - distance from each man to the slot he is being steered at, and his speed
   */
  const frame = (u) => {
    const c = { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0 };
    /**
     * Men per distinct *slot point*, quantised to 0.25 m — not per (station, rank) pair.
     *
     * The pair is the wrong instrument and read zero through the whole of the first run of
     * this probe. \`layOutArrived\` gives every man a distinct rank, so the seats are always
     * distinct in the ledger; \`slotAt\` then clamps every rank deeper than the band will
     * take to the same lateral offset, so the seats are *identical on the ground*. The
     * collision is physical and has to be measured physically.
     */
    const seats = new Map();
    let outBand = 0, worstOut = 0, frozen = 0, sumToSlot = 0, n = 0, maxToSlot = 0;
    let sumSpeed = 0, routing = 0, fighting = 0, maxRank = 0;
    const runs = {};
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++;
      const w = where(i);
      c[w]++;
      const st = s.stationOf[i];
      if (st >= 0) {
        const key = Math.round(b.slotX[i] * 4) + ':' + Math.round(b.slotZ[i] * 4);
        seats.set(key, (seats.get(key) ?? 0) + 1);
        if (s.rankOf[i] > maxRank) maxRank = s.rankOf[i];
        const r = runOf(st);
        runs[r] = (runs[r] ?? 0) + 1;
        const off = (p.x[i] - s.sx[st]) * s.snx[st] + (p.z[i] - s.sz[st]) * s.snz[st];
        const over = Math.max(s.sInner[st] - off, off - s.sOuter[st]);
        if (over > 0.02) { outBand++; if (over > worstOut) worstOut = over; }
      }
      const dsx = b.slotX[i] - p.x[i], dsz = b.slotZ[i] - p.z[i];
      const d = Math.hypot(dsx, dsz);
      sumToSlot += d; if (d > maxToSlot) maxToSlot = d;
      const sp = Math.hypot(p.vx[i], p.vz[i]);
      sumSpeed += sp;
      if (d > 0.6 && sp < 0.08) frozen++;
      if (p.state[i] === 12) routing++;
      if (p.state[i] === 4) fighting++;
    }
    let worstPile = 0, shared = 0;
    for (const v of seats.values()) { if (v > worstPile) worstPile = v; if (v > 1) shared += v; }
    const pl = s.plans.get(u.id);
    const gg = s.garrisons.get(u.id);
    return {
      n, ...c, distinctSlots: seats.size, worstPile, menSharingASlot: shared, maxRank,
      outBand, worstOut: +worstOut.toFixed(3), frozen,
      meanToSlot: n ? +(sumToSlot / n).toFixed(2) : 0, maxToSlot: +maxToSlot.toFixed(2),
      meanSpeed: n ? +(sumSpeed / n).toFixed(3) : 0, routing, fighting,
      runs, owned: s.ownsUnit(u.id), garr: s.isGarrisoned(u.id),
      order: u.order,
      plan: pl ? { goal: pl.goal, age: pl.age, stuck: pl.stuck, destRun: pl.destRun,
        destStation: pl.destStation, stair: pl.stair } : null,
      g: gg ? { from: gg.from, span: gg.span, ranks: gg.ranks, overflow: gg.overflow,
        plannedFor: gg.plannedFor, sticky: gg.sticky, filled: gg.filled } : null,
    };
  };

  /** Trace one unit for "sec" seconds, sampling every "every" ticks. */
  const trace = (u, sec, every = 15) => {
    const ticks = Math.round(sec * 30);
    const out = [];
    const prevY = new Map(), still = new Map(), startX = new Map();
    let worstDrop = 0, worstRise = 0;
    for (const i of u.members) { prevY.set(i, p.y[i]); still.set(i, 0); startX.set(i, [p.x[i], p.z[i]]); }
    for (let k = 0; k < ticks; k++) {
      step();
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const d = (p.y[i] - prevY.get(i)) * 30;
        if (d > worstRise) worstRise = d;
        if (-d > worstDrop) worstDrop = -d;
        prevY.set(i, p.y[i]);
        const sp = Math.hypot(p.vx[i], p.vz[i]);
        still.set(i, sp < 0.08 ? (still.get(i) ?? 0) + 1 : 0);
      }
      if (k % every === 0 || k === ticks - 1) out.push({ t: +(k / 30).toFixed(1), ...frame(u) });
    }
    // Men who have not moved for the last 10 s and are not where they are being sent.
    let nailed = 0, nailedOn = { parapet: 0, rungs: 0, grass: 0, pending: 0, link: 0 };
    let netMoved = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const a = startX.get(i);
      netMoved += Math.hypot(p.x[i] - a[0], p.z[i] - a[1]);
      if ((still.get(i) ?? 0) >= 300) { nailed++; nailedOn[where(i)]++; }
    }
    const alive = u.members.filter((i) => p.aliveAt(i)).length;
    return { samples: out, worstRise: +worstRise.toFixed(2), worstDrop: +worstDrop.toFixed(2),
      nailed, nailedOn, meanNetMoved: alive ? +(netMoved / alive).toFixed(1) : 0 };
  };

  return { g, b, s, p, city, bays, mid, nearestBay, step, run, click, where, frame, trace,
    runOf, runLen };
})();
undefined;
`;

async function arm(name, fn) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => errs.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`[${name}] console: ${m.text()}`); });
  await page.goto(
    `${base}/?harness=1&autoplay=0&quality=high&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
  await page.evaluate(HELPERS);
  const r = await page.evaluate(fn);
  await page.close();
  return r;
}

const out = {};
const want = (k) => !ONLY || ONLY.has(k);

// ---------------------------------------------------------------------------
// A — the arithmetic. What every garrison's roster is against the run it stands on.
// ---------------------------------------------------------------------------
if (want('A')) {
  out.A = await arm('A', () => {
    const w = window.__ws, s = w.s, b = w.b, p = w.p;
    w.run(2);
    const runs = [];
    for (let r = 0; r < s.runNext.length; r++) {
      const n = w.runLen(r);
      if (n > 0) runs.push(n);
    }
    runs.sort((x, y) => x - y);
    const units = [];
    for (const u of b.units) {
      if (u.destroyed || !s.isGarrisoned(u.id)) continue;
      const f = w.frame(u);
      const st0 = u.members.find((i) => p.aliveAt(i) && s.stationOf[i] >= 0);
      const run = st0 === undefined ? -1 : w.runOf(s.stationOf[st0]);
      units.push({
        id: u.id, type: u.typeId, alive: u.alive, width: u.width,
        run, runStations: run >= 0 ? w.runLen(run) : 0,
        span: f.g ? f.g.span : -1, ranks: f.g ? f.g.ranks : -1,
        capacity: f.g ? f.g.span * f.g.ranks : -1,
        overflow: f.g ? f.g.overflow : -1,
        worstPile: f.worstPile, menSharingASlot: f.menSharingASlot, outBand: f.outBand,
      });
    }
    return {
      stationCount: s.stationCount,
      runCount: runs.length,
      runStationsMin: runs[0], runStationsMed: runs[runs.length >> 1],
      runStationsMax: runs[runs.length - 1],
      stationPitch: 0.86,
      garrisons: units,
    };
  });
}

// ---------------------------------------------------------------------------
// B — a big cohort ordered from the ground onto the parapet.
// ---------------------------------------------------------------------------
if (want('B')) {
  out.B = await arm('B', () => {
    const w = window.__ws, s = w.s, b = w.b;
    w.run(2);
    const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction;
    let u = null;
    for (const q of b.units) {
      if (q.destroyed || q.faction !== defender) continue;
      if (s.ownsUnit(q.id) || s.isGarrisoned(q.id)) continue;
      if (!u || q.alive > u.alive) u = q;
    }
    if (!u) return { fail: 'no free defender on the ground' };
    /*
     * Aim at a *station*, not at a bay midpoint.
     *
     * The first version of this arm aimed at (x0+x1)/2 of the nearest garrisonable bay and
     * measured a unit that never got an order at all: on Rome that bay is the gate, the
     * spine has no stations inside the gate block, and `wallTargetAt` correctly answered
     * "not the parapet" 2.22 m along the wall from the nearest station. Surveyed since:
     * `wallTargetAt` accepts 1673/1673 stations and 1628/1628 inter-station midpoints on
     * Rome and 2016/2016 + 1976/1976 on Carthage, so the order gate is not the fault and
     * the old aim was an instrument defect.
     */
    let dest = -1, bd = Infinity;
    for (let k = 0; k < s.stationCount; k++) {
      const d = (s.sx[k] - u.x) ** 2 + (s.sz[k] - u.z) ** 2;
      if (d < bd) { bd = d; dest = k; }
    }
    const destRun = s.sRun[dest];
    const before = w.frame(u);
    w.click(u, s.sx[dest], s.sz[dest]);
    w.step();
    const t = w.trace(u, 240, 30);
    return {
      unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      destStation: dest, destRun, destRunStations: w.runLen(destRun),
      capacity: w.runLen(destRun) * 5,
      band: +(s.sOuter[dest] - s.sInner[dest]).toFixed(3),
      before, ...t, after: w.frame(u),
    };
  });
}

// ---------------------------------------------------------------------------
// C — a garrison ordered along its own wall.
// ---------------------------------------------------------------------------
if (want('C')) {
  out.C = await arm('C', () => {
    const w = window.__ws, s = w.s, b = w.b;
    w.run(2);
    const gate = w.bays.find((q) => q.isGate) ?? w.bays[w.bays.length >> 1];
    const gc = w.mid(gate);
    let u = null, far = -1;
    for (const q of b.units) {
      if (q.destroyed || q.alive < 20 || !s.isGarrisoned(q.id) || s.plans.has(q.id)) continue;
      const d = Math.hypot(q.x - gc.x, q.z - gc.z);
      if (d > far) { far = d; u = q; }
    }
    if (!u) return { fail: 'no settled garrison' };
    let here = 0, bd = Infinity;
    for (let k = 0; k < w.bays.length; k++) {
      const c = w.mid(w.bays[k]); const d = (c.x - u.x) ** 2 + (c.z - u.z) ** 2;
      if (d < bd) { bd = d; here = k; }
    }
    const away = here > w.bays.indexOf(gate) ? 1 : -1;
    let target = null;
    for (const off of [away * 2, away * 3, away * 4, -away * 2, -away * 3]) {
      const q = w.bays[here + off];
      if (q && q.garrisonable) { target = q; break; }
    }
    if (!target) return { fail: 'no bay to move to' };
    const c = w.mid(target);
    const dest = s.stationNear(c.x, c.z);
    const before = w.frame(u);
    w.click(u, c.x, c.z);
    w.step();
    const t = w.trace(u, 200, 30);
    return {
      unitId: u.id, type: u.typeId, alive: u.alive,
      fromBay: here, toBay: target.index,
      destStation: dest, destRun: s.sRun[dest], destRunStations: w.runLen(s.sRun[dest]),
      before, ...t, after: w.frame(u),
    };
  });
}

// ---------------------------------------------------------------------------
// D — a party half up a ladder, broken.
// ---------------------------------------------------------------------------
if (want('D')) {
  out.D = await arm('D', () => {
    const w = window.__ws, s = w.s, b = w.b, p = w.p;
    // Let the storm develop until an escalade party is genuinely spread over three places.
    let u = null, waited = 0;
    for (let k = 0; k < 90 && !u; k++) {
      w.run(4); waited += 4;
      for (const l of s.ladders) {
        for (const id of [l.unitId, ...l.boarders]) {
          const q = b.unitById(id);
          if (!q || q.destroyed || q.alive < 12) continue;
          if (q.order === 5 /* Rout */) continue;
          const f = w.frame(q);
          if (f.rungs >= 2 && f.parapet >= 2 && f.grass >= 4) { u = q; break; }
        }
        if (u) break;
      }
    }
    if (!u) return { fail: 'no party spread across three places', waited };
    const spread = w.frame(u);
    const pre = {
      elevatedOnGrass: u.members.filter((i) => p.aliveAt(i) && s.stationOf[i] === -1
        && s.crossOf[i] === -1 && b.elevated[i] !== 0).length,
    };
    b.rout(u);
    const t = w.trace(u, 90, 15);
    // Where did the men end up, and how fast were they going? A routing man runs at ~4.35.
    let sumSp = 0, n = 0, slow = 0;
    const byLocus = { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0 };
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; byLocus[w.where(i)]++;
      const sp = Math.hypot(p.vx[i], p.vz[i]);
      sumSp += sp; if (sp < 0.5) slow++;
    }
    return {
      unitId: u.id, type: u.typeId, waited, spread, pre,
      ...t, after: w.frame(u), byLocus,
      meanSpeedAfter: n ? +(sumSp / n).toFixed(2) : 0, slowAfter: slow, aliveAfter: n,
      stillOwned: s.ownsUnit(u.id), stillGarrisoned: s.isGarrisoned(u.id),
    };
  });
}

await browser.close();

for (const [k, v] of Object.entries(out)) {
  console.log(`\n===== ARM ${k} =====`);
  console.log(JSON.stringify(v, null, 1));
}
if (errs.length) { console.log('\npage errors:'); for (const e of errs) console.log('  ' + e); }
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ out, errs }, null, 1));
