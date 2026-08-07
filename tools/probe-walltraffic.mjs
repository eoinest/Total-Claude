#!/usr/bin/env node
/**
 * The wall as somewhere you can be ordered, driven from the player's side.
 *
 * `probe-siege.mjs` tests the same orders by calling `Siege.sendToWall`, `moveAlongWall`
 * and `sendToGround` directly. **That is the gap that let a wall nobody could leave ship
 * green twice.** An order given through the API skips `applyOrder`, `holdShortOfSolid`,
 * `interceptOrders` and every gate between them; a right-click does not. Everything here
 * goes in as an `orderIssued` event carrying the point the player clicked, exactly as
 * `SelectionController` and `ai/Orders.ts` emit it, and then measures whether men moved.
 *
 * It grades the *path*, not the endpoint: which run each man is standing on, completed link
 * crossings, and the worst single-tick vertical step — a cohort that ends up on the ground
 * having teleported there is a failure, not a pass. One check is read back out of the
 * `iPos` instance buffer the renderer uploaded, because the simulation's own arrays are the
 * thing under test.
 *
 * **Each order is its own page load.** The four arms would otherwise share one battle and
 * one clock, and a garrison four hundred seconds into an assault is a remnant in melee —
 * `steerToSlots` leaves a `Fighting` man exactly where he stands, so a late arm grades the
 * casualty list rather than the order. Measured twice while this was being written: a
 * traverse scored against a cohort that had two men left, and then against one that had none.
 *
 * Usage:
 *   node tools/probe-walltraffic.mjs --port=5388
 *   node tools/probe-walltraffic.mjs --port=5388 --json
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5388);
const MAP = args.get('map') ?? '';
const AS_JSON = args.has('json');

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server answering /src/main.ts at ${base} — a probe that falls through`
    + ' to a stale dist/ measures a build, not this tree');
  process.exit(2);
}
console.log(`• dev server ${base}${MAP ? `, map ${MAP}` : ''}`);

/*
 * The GPU flags are not a speed nicety.
 *
 * Without them headless Chromium falls back to SwiftShader and rasterises the siege in
 * software across every core. Measured on this machine: the same 470 s of simulation ran in
 * about 35 s with them and was still going after **thirty-one minutes** without them, at
 * 725% CPU — which on a shared box is indistinguishable from a hung probe and takes the
 * rest of the machine down with it.
 */
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const errs = [];

/**
 * Helpers installed into the page, shared by every arm.
 *
 * A string rather than four copies inside four `evaluate` calls, because they have to agree
 * exactly: the whole point of the probe is that one arm's number is comparable with another's.
 */
const HELPERS = `
window.__wt = (() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const city = g.engine.context.get('city');

  /*
   * Stop the rAF loop before anything is measured, and do not expect it to be enough.
   *
   * Left running, wall-clock time between two Playwright round trips advances one run
   * further than another: two runs of this file differing only in the text of an assertion
   * reported **15 and then 12** survivors of the same traverse. Stopping it here removes
   * most of that, but frames still run between \`ready\` and this call, so a hundred and
   * fifty seconds of a chaotic assault still lands in a slightly different place each time.
   * Every threshold below therefore has margin in it, and precise reproducibility is
   * \`qa-determinism.mjs\`'s job, not this file's.
   */
  g.engine.stop();

  /**
   * Exactly one fixed step, so a teleport cannot hide between two samples.
   *
   * \`window.__game.advance\` fixes \`stepMs\` at 1/60 and therefore renders two frames per
   * simulation tick. Naming the step outright halves the frame cost of a long watch.
   */
  const step = () => g.engine.advance(1 / 30, 1000 / 30);

  /** Right-click, as the mouse produces it. Nothing here touches a \`Siege\` method. */
  const click = (u, x, z) =>
    g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z });

  const census = (u) => {
    let onWall = 0, onGround = 0, onTerrain = 0, fighting = 0, n = 0, sumY = 0;
    const runs = {};
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; sumY += p.y[i];
      if (b.elevated[i]) onWall++; else onGround++;
      if (Math.abs(p.y[i] - b.groundAt(p.x[i], p.z[i])) < 0.6) onTerrain++;
      if (p.state[i] === 4) fighting++;
      const st = s.stationOf[i];
      const r = st >= 0 && st < s.stationCount ? s.sRun[st] : -1;
      runs[r] = (runs[r] ?? 0) + 1;
    }
    return { n, onWall, onGround, onTerrain, fighting, meanY: n ? sumY / n : 0, runs };
  };

  /**
   * Run the clock a tick at a time and watch the men, because a teleport is invisible in a
   * before/after pair. \`worstRise\`/\`worstDrop\` are the largest single-tick vertical steps
   * in m/s: a stair is 0.78 and free fall off this wall reaches 13.
   */
  const watch = (u, seconds) => {
    const ticks = Math.round(seconds * 30);
    const prevY = new Map();
    for (const i of u.members) prevY.set(i, p.y[i]);
    let worstRise = 0, worstDrop = 0, ticksWithAManOnALink = 0, peakOnLink = 0;
    let releasedAt = -1;
    for (let k = 0; k < ticks; k++) {
      step();
      let onLink = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (s.linkOf[i] >= 0 || s.crossOf[i] !== -1) onLink++;
        const d = (p.y[i] - prevY.get(i)) * 30;
        if (d > worstRise) worstRise = d;
        if (-d > worstDrop) worstDrop = -d;
        prevY.set(i, p.y[i]);
      }
      if (onLink > 0) { ticksWithAManOnALink++; peakOnLink = Math.max(peakOnLink, onLink); }
      if (releasedAt < 0 && !s.ownsUnit(u.id)) releasedAt = +(k / 30).toFixed(1);
    }
    return { worstRise: +worstRise.toFixed(2), worstDrop: +worstDrop.toFixed(2),
      ticksWithAManOnALink, peakOnLink, releasedAt };
  };

  /** Completed crossings, split by kind, so a climb and a tower pass cannot be confused. */
  const crossings = (stair) =>
    s.links.reduce((n, l) => n + ((l.kind === 2) === stair ? l.used : 0), 0);

  /**
   * What the renderer actually drew, not what the simulation thinks.
   *
   * The soldier meshes are \`InstancedBufferGeometry\` carrying an \`iPos\` attribute uploaded
   * in \`preRender\`, so counting instances inside a height band over a stretch of curtain is
   * a measurement that owes nothing to \`pool.y\`. It counts *everybody* up there, which is
   * why it is only used on the arm that runs from a clean start.
   */
  const drawnNear = (cx, cz, radius, yLo, yHi) => {
    let n = 0;
    g.engine.context.scene.traverse((o) => {
      const at = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('iPos');
      if (!at || !o.visible) return;
      const a = at.array;
      const count = o.geometry.instanceCount ?? at.count;
      for (let k = 0; k < count; k++) {
        const x = a[k * 3], y = a[k * 3 + 1], z = a[k * 3 + 2];
        if (y < yLo || y > yHi) continue;
        if ((x - cx) ** 2 + (z - cz) ** 2 > radius * radius) continue;
        n++;
      }
    });
    return n;
  };

  const bays = city.getGarrisonBays();
  const mid = (q) => ({ x: (q.x0 + q.x1) * 0.5, z: (q.z0 + q.z1) * 0.5 });
  const nearestBay = (x, z, needGarrisonable) => {
    let best = null, bd = Infinity;
    for (const q of bays) {
      if (needGarrisonable && !q.garrisonable) continue;
      const c = mid(q); const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };
  /** Signed: negative along a bay's outward normal is inside the city. */
  const insideOf = (u, c, nx, nz) => {
    let n = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if ((p.x[i] - c.x) * nx + (p.z[i] - c.z) * nz < 0) n++;
    }
    return n;
  };
  const garrisonFaction = () => b.units.find((q) => s.isGarrisoned(q.id))?.faction;

  return { g, b, s, p, city, bays, step, click, census, watch, crossings, drawnNear,
    mid, nearestBay, insideOf, garrisonFaction };
})();
// The completion value of an evaluated string is what Playwright ships back over the pipe,
// and the line above evaluates to the whole engine graph. Left as it was, the handshake
// tried to serialise the scene and died on ERR_STRING_TOO_LONG.
undefined;
`;

/** One arm: its own page, its own battle, its own clock starting at zero. */
async function arm(fn) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  /*
   * 480x270 and `low`. Nothing here is graded on a pixel — every number comes out of the
   * simulation arrays or out of an instance buffer, both CPU-side and resolution
   * independent — and the harness otherwise defaults to 1920x1080.
   */
  await page.goto(
    `${base}/?harness=1&autoplay=0&quality=low&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 150000 });
  await page.evaluate(HELPERS);
  const r = await page.evaluate(fn);
  await page.close();
  return r;
}

// ---------------------------------------------------------------------------
// 1. A defender on the wall, right-clicked into the city.
// ---------------------------------------------------------------------------
const descend = await arm(() => {
  const w = window.__wt;
  w.g.advance(2);
  let u = null;
  for (const q of w.b.units) {
    if (q.destroyed || q.alive < 20 || !w.s.isGarrisoned(q.id) || w.s.plans.has(q.id)) continue;
    if (!u || q.alive > u.alive) u = q;
  }
  if (!u) return { fail: 'no garrisoned unit' };
  const bay = w.nearestBay(u.x, u.z, false);
  const c = w.mid(bay);
  const rally = { x: c.x - bay.nx * 60, z: c.z - bay.nz * 60 };
  const before = w.census(u);
  const walkY = before.meanY;
  const drawnBefore = w.drawnNear(c.x, c.z, 45, walkY - 1.5, walkY + 2.5);
  const crossBefore = w.crossings(true);
  w.click(u, rally.x, rally.z);
  const goalOnTick1 = (w.step(), w.s.plans.has(u.id) ? w.s.plans.get(u.id).goal : -1);
  const motion = w.watch(u, 150);
  const after = w.census(u);
  return {
    unitId: u.id, rally: { x: +rally.x.toFixed(0), z: +rally.z.toFixed(0) },
    goalOnTick1, before, after, motion,
    inside: w.insideOf(u, c, bay.nx, bay.nz),
    stairCrossings: w.crossings(true) - crossBefore,
    drawnOnTheWalkBefore: drawnBefore,
    drawnOnTheWalkAfter: w.drawnNear(c.x, c.z, 45, walkY - 1.5, walkY + 2.5),
    fellMetres: +(before.meanY - after.meanY).toFixed(2),
  };
});

// ---------------------------------------------------------------------------
// 2. A cohort standing in the city, right-clicked onto the parapet.
// ---------------------------------------------------------------------------
const ascend = await arm(() => {
  const w = window.__wt;
  w.g.advance(2);
  const defender = w.garrisonFaction();
  let u = null;
  for (const q of w.b.units) {
    if (q.destroyed || q.alive < 12 || q.faction !== defender) continue;
    if (w.s.ownsUnit(q.id) || w.s.isGarrisoned(q.id)) continue;
    if (!u || q.alive > u.alive) u = q;
  }
  if (!u) return { fail: 'no free defender standing on the ground' };
  const bay = w.nearestBay(u.x, u.z, true);
  const c = w.mid(bay);
  const before = w.census(u);
  const crossBefore = w.crossings(true);
  w.click(u, c.x, c.z);
  const goalOnTick1 = (w.step(), w.s.plans.has(u.id) ? w.s.plans.get(u.id).goal : -1);
  const motion = w.watch(u, 90);
  const after = w.census(u);
  return {
    unitId: u.id, aimed: { x: +c.x.toFixed(0), z: +c.z.toFixed(0) },
    goalOnTick1, before, after, motion,
    stairCrossings: w.crossings(true) - crossBefore,
    roseMetres: +(after.meanY - before.meanY).toFixed(2),
    owned: w.s.ownsUnit(u.id),
  };
});

// ---------------------------------------------------------------------------
// 3. A garrison right-clicked further along its own wall.
// ---------------------------------------------------------------------------
const traverse = await arm(() => {
  const w = window.__wt;
  w.g.advance(2);
  /*
   * The settled garrison furthest from the gate. That is where the assault lands, and a
   * cohort in melee is not steered at all — grading a redeployment there measures the
   * storm, not the order.
   */
  const gate = w.bays.find((q) => q.isGate) ?? w.bays[Math.floor(w.bays.length / 2)];
  const gc = w.mid(gate);
  let u = null, far = -1;
  for (const q of w.b.units) {
    if (q.destroyed || q.alive < 20 || !w.s.isGarrisoned(q.id) || w.s.plans.has(q.id)) continue;
    const d = Math.hypot(q.x - gc.x, q.z - gc.z);
    if (d > far) { far = d; u = q; }
  }
  if (!u) return { fail: 'no settled garrison' };
  let here = 0, bd = Infinity;
  for (let k = 0; k < w.bays.length; k++) {
    const c = w.mid(w.bays[k]); const d = (c.x - u.x) ** 2 + (c.z - u.z) ** 2;
    if (d < bd) { bd = d; here = k; }
  }
  /*
   * Send him *away* from the gate where there is wall to send him to.
   *
   * Three bays toward the gate walked a 44-man cohort into the storm and it was wiped
   * inside a hundred seconds — `n` 44 to 0 — which grades the assault, not the redeployment.
   */
  const away = here > w.bays.indexOf(gate) ? 1 : -1;
  let target = null;
  for (const off of [away * 2, away * 3, away * 4, -away * 2, -away * 3]) {
    const q = w.bays[here + off];
    if (q && q.garrisonable) { target = q; break; }
  }
  if (!target) return { fail: 'no bay to move to' };
  const c = w.mid(target);
  const targetRun = w.s.sRun[w.s.stationNear(c.x, c.z)];
  const startRun = w.s.sRun[w.s.stationNear(u.x, u.z)];
  const before = w.census(u);
  const passesBefore = w.crossings(false);
  w.click(u, c.x, c.z);
  const goalOnTick1 = (w.step(), w.s.plans.has(u.id) ? w.s.plans.get(u.id).goal : -1);
  /*
   * The high-water mark, not just the state at the end.
   *
   * A cohort that redeploys and is then killed on the bay it redeployed to has still
   * redeployed, and a probe that only reads the final census cannot tell that from one that
   * never moved. Peaks are taken every tick alongside the watch.
   */
  let peakOnTargetRun = 0, peakAtTarget = 0;
  const ticks = 90 * 30;
  const prevY = new Map();
  for (const i of u.members) prevY.set(i, w.p.y[i]);
  let worstDrop = 0, worstRise = 0, ticksWithAManOnALink = 0, peakOnLink = 0;
  for (let n = 0; n < ticks; n++) {
    w.step();
    let onRun = 0, at = 0, onLink = 0;
    for (const i of u.members) {
      if (!w.p.aliveAt(i)) continue;
      const st = w.s.stationOf[i];
      if (st >= 0 && st < w.s.stationCount && w.s.sRun[st] === targetRun) onRun++;
      if (Math.hypot(w.p.x[i] - c.x, w.p.z[i] - c.z) < 26) at++;
      if (w.s.linkOf[i] >= 0 || w.s.crossOf[i] !== -1) onLink++;
      const dy = (w.p.y[i] - prevY.get(i)) * 30;
      if (dy > worstRise) worstRise = dy;
      if (-dy > worstDrop) worstDrop = -dy;
      prevY.set(i, w.p.y[i]);
    }
    if (onLink > 0) { ticksWithAManOnALink++; peakOnLink = Math.max(peakOnLink, onLink); }
    peakOnTargetRun = Math.max(peakOnTargetRun, onRun);
    peakAtTarget = Math.max(peakAtTarget, at);
  }
  const motion = { worstRise: +worstRise.toFixed(2), worstDrop: +worstDrop.toFixed(2),
    ticksWithAManOnALink, peakOnLink, releasedAt: -1 };
  const after = w.census(u);
  let stillUp = 0, atTarget = 0, worstFeet = 0;
  for (const i of u.members) {
    if (!w.p.aliveAt(i)) continue;
    if (w.b.elevated[i]) {
      stillUp++;
      worstFeet = Math.max(worstFeet, Math.abs(w.p.y[i] - w.b.support[i]));
    }
    if (Math.hypot(w.p.x[i] - c.x, w.p.z[i] - c.z) < 26) atTarget++;
  }
  return {
    unitId: u.id, bays: `${here} -> ${w.bays.indexOf(target)}`, fromGate: +far.toFixed(0),
    goalOnTick1, before, after, motion, stillUp, atTarget,
    startRun, targetRun, peakOnTargetRun, peakAtTarget,
    startRuns: Object.keys(before.runs).map(Number).filter((r) => r >= 0),
    endRuns: Object.keys(after.runs).map(Number).filter((r) => r >= 0),
    towerPasses: w.crossings(false) - passesBefore,
    worstFeetError: +worstFeet.toFixed(3),
    anchorToTarget: +Math.hypot(u.x - c.x, u.z - c.z).toFixed(1),
  };
});

// ---------------------------------------------------------------------------
// 4. An attacker who has taken a stretch of wall, right-clicked into the streets.
// ---------------------------------------------------------------------------
const stormer = await arm(() => {
  const w = window.__wt;
  w.g.advance(2);
  const defender = w.garrisonFaction();
  let u = null;
  for (const q of w.b.units) {
    if (q.destroyed || q.alive < 20 || q.faction === defender) continue;
    if (w.s.ownsUnit(q.id) || w.s.isGarrisoned(q.id)) continue;
    if (!u || q.alive > u.alive) u = q;
  }
  if (!u) return { fail: 'no free attacker' };
  const bay = w.nearestBay(u.x, u.z, true);
  const c = w.mid(bay);
  // A lodgement is what taking a wall leaves: his men are standing on the parapet.
  const lodged = w.s.garrison(u, c.x, c.z);
  w.g.advance(1);
  const before = w.census(u);
  const rally = { x: c.x - bay.nx * 70, z: c.z - bay.nz * 70 };
  w.click(u, rally.x, rally.z);
  const goalOnTick1 = (w.step(), w.s.plans.has(u.id) ? w.s.plans.get(u.id).goal : -1);
  const motion = w.watch(u, 150);
  const after = w.census(u);
  return {
    unitId: u.id, faction: u.faction, lodged, goalOnTick1, before, after, motion,
    inside: w.insideOf(u, c, bay.nx, bay.nz),
    fellMetres: +(before.meanY - after.meanY).toFixed(2),
    owned: w.s.ownsUnit(u.id), order: u.order,
  };
});

await browser.close();

const out = { descend, ascend, traverse, stormer };
if (AS_JSON) {
  console.log(JSON.stringify(out, null, 1));
  if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 8).join('\n'));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const d = descend, a = ascend, t = traverse, k = stormer;
// WallGoal: 0 Hold, 1 Ascend, 2 Traverse, 3 Descend, 4 Storm.

check('a right-click into the city turns a garrison order into a descent, on tick 1',
  !!d && d.goalOnTick1 === 3,
  `goal on tick 1 = ${d?.goalOnTick1} (3 = Descend); unit ${d?.unitId}, ${d?.before.n} men, `
  + `aimed at ${d?.rally?.x},${d?.rally?.z}`);
check('the garrison actually comes off the stone',
  !!d && d.after.onWall <= 3 && d.inside >= d.after.n * 0.9,
  `${d?.before.onWall} men on the walk before, ${d?.after.onWall} after; `
  + `${d?.after.onTerrain}/${d?.after.n} are standing on the terrain and ${d?.inside} are `
  + `cityward of the curtain; the cohort fell ${d?.fellMetres} m`);
check('they walked down, and nobody was dropped or teleported',
  !!d && d.stairCrossings > 0 && d.motion.worstDrop < 3.5,
  `${d?.stairCrossings} completed stair crossings, a man on a link on `
  + `${d?.motion.ticksWithAManOnALink} ticks (peak ${d?.motion.peakOnLink} at once); fastest `
  + `descent ${d?.motion.worstDrop} m/s (a stair is 0.78, free fall off this wall reaches 13)`);
check('the renderer agrees the walk is empty',
  !!d && d.drawnOnTheWalkAfter < d.drawnOnTheWalkBefore * 0.5,
  `iPos instances drawn within 45 m of the bay at walk height: `
  + `${d?.drawnOnTheWalkBefore} before, ${d?.drawnOnTheWalkAfter} after (45 m reaches the `
  + `neighbouring bays, so what is left is the garrisons either side)`);

check('a right-click on the parapet sends a cohort in the city up onto it',
  !!a && a.goalOnTick1 === 1,
  `goal on tick 1 = ${a?.goalOnTick1} (1 = Ascend); unit ${a?.unitId}, ${a?.before.n} men, `
  + `aimed at ${a?.aimed?.x},${a?.aimed?.z}; siege-owned: ${a?.owned}`);
check('men ordered onto the wall climb a stair and arrive on the walkway',
  !!a && a.after.onWall >= a.after.n * 0.75 && a.stairCrossings > 0,
  `${a?.after.onWall}/${a?.after.n} men are on the walk, up ${a?.roseMetres} m; `
  + `${a?.stairCrossings} completed stair crossings; a man on a stair on `
  + `${a?.motion.ticksWithAManOnALink} ticks`);
check('nobody is flung up the wall',
  !!a && a.motion.worstRise < 3.0,
  `worst climb ${a?.motion.worstRise} m/s (a stair is 0.78)`);

check('a right-click further along the parapet is a lateral move, not a descent',
  !!t && t.goalOnTick1 === 2,
  `goal on tick 1 = ${t?.goalOnTick1} (2 = Traverse); unit ${t?.unitId}, ${t?.before.n} men, `
  + `bays ${t?.bays}, ${t?.fromGate} m from the gate`);
/*
 * Graded against the men who are still alive, and against a run the cohort did not start on.
 *
 * A garrison redeploying under an assault takes losses on the way — 44 men went and 15
 * arrived in the run that produced these numbers — so scoring the arrivals against the
 * *starting* strength measures the casualty list again. What the order has to produce is
 * that the survivors are on the section they were sent to, and the only route between two
 * runs is a link through a tower, so `startRun !== targetRun` is itself the crossing.
 */
check('the cohort redeploys along the wall and stays on it',
  !!t && t.after.n > 0 && t.startRun !== t.targetRun
    && t.atTarget >= t.after.n * 0.8 && t.stillUp >= t.after.n * 0.8
    && t.motion.ticksWithAManOnALink > 0,
  `run ${t?.startRun} -> run ${t?.targetRun}; ${t?.atTarget}/${t?.after.n} surviving men are `
  + `within 26 m of the bay they were sent to and ${t?.stillUp} are still on the stone, from `
  + `${t?.before.n} who set off (peak on the target run ${t?.peakOnTargetRun}); a man of this `
  + `cohort was on a link on ${t?.motion.ticksWithAManOnALink} ticks, and the tower passes `
  + `carried ${t?.towerPasses} men across the circuit`);
check('feet stay on the walkway through the traverse',
  !!t && t.worstFeetError < 0.05 && t.motion.worstDrop < 3.5,
  `worst |y - support| = ${((t?.worstFeetError ?? 0) * 100).toFixed(2)} cm over ${t?.stillUp} `
  + `men; worst vertical step ${t?.motion.worstDrop} m/s`);

check('an attacker who has taken the wall can be ordered into the streets',
  !!k && k.lodged && k.goalOnTick1 === 3,
  `lodgement placed: ${k?.lodged}; goal on tick 1 = ${k?.goalOnTick1} (3 = Descend); `
  + `faction ${k?.faction}, ${k?.before.n} men`);
check('and he gets down there',
  !!k && k.after.onWall <= 3 && k.inside >= k.after.n * 0.9,
  `${k?.before.onWall} on the wall before, ${k?.after.onWall} after; ${k?.inside} men are `
  + `inside the curtain and ${k?.after.onTerrain} are on the terrain; fell ${k?.fellMetres} m `
  + `at worst ${k?.motion.worstDrop} m/s`);
check('a unit that has come down is a field formation again',
  !!k && k.owned === false,
  `the siege system still owns it: ${k?.owned} (must be false); released `
  + `${k?.motion.releasedAt} s after the click`);

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 8).join('\n'));
process.exit(fail ? 1 : 0);
