#!/usr/bin/env node
/**
 * Can a man walk the length of the wall, past the towers?
 *
 * The owner's report was *"soldiers cannot walk past the towers"*, and the traversal system
 * already had a `TowerPass` link, so the interesting question was never "is there an edge in
 * the graph" — it was **"is there a hole in the stone, and does the path go through it"**.
 * Those are two different measurements and this file makes both.
 *
 * **Arm 1 measures the built geometry, not the source.** For every tower it sweeps the
 * wall-walk laterally and fires a ray *along the wall axis* through the tower's footprint at
 * a walking man's chest height, against the meshes the city actually baked and the renderer
 * actually drew. A doorway that exists in `buildTower` and is 1.4 m above the walk on one
 * side, or 1.4 m to the field side of where men walk, fails this and passes a source read.
 * It reports the widest *contiguous* clear lane, because two 0.4 m slots either side of a
 * pier are not a doorway.
 *
 * **Arm 2 is the player's own right-click**, given as an `orderIssued` event, and counts the
 * men who complete a tower crossing and the men who reach the bay they were sent to. Rome's
 * assault kills a redeploying cohort, so completed crossings are graded as well as arrivals:
 * a man who got past two towers and was then shot got past two towers.
 *
 * Usage:
 *   node tools/probe-towerpass.mjs --port=5407
 *   node tools/probe-towerpass.mjs --port=5407 --json
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5407);
const AS_JSON = args.has('json');
const SECONDS = Number(args.get('seconds') ?? 120);

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server answering /src/main.ts at ${base} — a probe that falls through`
    + ' to a stale dist/ measures a build, not this tree');
  process.exit(2);
}
console.log(`• dev server ${base}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const errs = [];

/**
 * Installed into the page.
 *
 * The ray test is written out in full rather than borrowed from `THREE.Raycaster`, for one
 * reason: `three` is a bare specifier and there is no import map on this page, so a second
 * copy cannot be loaded, and the app's own copy is not reachable from any object on the
 * scene graph. Möller-Trumbore over the position buffers the renderer uploaded is the same
 * measurement and owes nothing to a module resolution.
 */
const HELPERS = `
window.__tp = (() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const city = g.engine.context.get('city');
  g.engine.stop();

  /**
   * Every mesh the city is currently *showing*, and nothing else.
   *
   * A raycast that ignores \`visible\` would hit all three LOD levels of every chunk at once
   * and report solid stone everywhere. Shadow proxies are excluded by name: they are coarse
   * boxes standing in for the real geometry and a doorway is exactly what they do not have.
   */
  const visibleCityMeshes = () => {
    const out = [];
    const root = city.root ?? g.engine.context.scene.getObjectByName('city');
    root.updateMatrixWorld(true);
    const walk = (o, vis) => {
      const v = vis && o.visible !== false;
      if (v && o.isMesh && !/-shadow$/.test(o.name)) out.push(o);
      for (const c of o.children) walk(c, v);
    };
    walk(root, true);
    return out;
  };

  const MESHES = visibleCityMeshes();

  /** World-space triangles of every visible city mesh whose bounds touch a box. */
  const trisInBox = (x0, y0, z0, x1, y1, z1) => {
    const out = [];
    const e = new Float64Array(16);
    for (const m of MESHES) {
      const geo = m.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      // Mesh bounds in world space; the city's chunk groups carry a translation only, but
      // read the full matrix so a rotated chunk cannot slip through.
      const mm = m.matrixWorld.elements;
      for (let i = 0; i < 16; i++) e[i] = mm[i];
      const bb = geo.boundingBox;
      const cx = [bb.min.x, bb.max.x], cy = [bb.min.y, bb.max.y], cz = [bb.min.z, bb.max.z];
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
      for (let a = 0; a < 2; a++) for (let bq = 0; bq < 2; bq++) for (let c = 0; c < 2; c++) {
        const px = cx[a], py = cy[bq], pz = cz[c];
        const wx = e[0] * px + e[4] * py + e[8] * pz + e[12];
        const wy = e[1] * px + e[5] * py + e[9] * pz + e[13];
        const wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        if (wx < ax0) ax0 = wx; if (wx > ax1) ax1 = wx;
        if (wy < ay0) ay0 = wy; if (wy > ay1) ay1 = wy;
        if (wz < az0) az0 = wz; if (wz > az1) az1 = wz;
      }
      if (ax1 < x0 || ax0 > x1 || ay1 < y0 || ay0 > y1 || az1 < z0 || az0 > z1) continue;
      const pos = geo.getAttribute('position');
      const idx = geo.getIndex();
      const n = idx ? idx.count : pos.count;
      const arr = pos.array;
      const ia = idx ? idx.array : null;
      const wp = new Float64Array(9);
      /*
       * Kept on an AABB *overlap*, not on "a vertex is inside the box".
       *
       * The first version tested vertices and it silently passed Carthage: the Punic tower
       * is one 20 m box, so every triangle of its side faces has both its vertices outside
       * a 6 m tall slice at walk level and the whole tower was dropped from the test —
       * reported as 5.73 m of clear lane through eleven metres of solid tufa. Rome's tower
       * has a course band every 0.9 m, so it kept enough triangles to look plausible, which
       * is exactly how a broken instrument survives.
       */
      for (let t = 0; t < n; t += 3) {
        let tx0 = Infinity, ty0 = Infinity, tz0 = Infinity;
        let tx1 = -Infinity, ty1 = -Infinity, tz1 = -Infinity;
        for (let k = 0; k < 3; k++) {
          const vi = (ia ? ia[t + k] : t + k) * 3;
          const px = arr[vi], py = arr[vi + 1], pz = arr[vi + 2];
          const wx = e[0] * px + e[4] * py + e[8] * pz + e[12];
          const wy = e[1] * px + e[5] * py + e[9] * pz + e[13];
          const wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
          wp[k * 3] = wx; wp[k * 3 + 1] = wy; wp[k * 3 + 2] = wz;
          if (wx < tx0) tx0 = wx; if (wx > tx1) tx1 = wx;
          if (wy < ty0) ty0 = wy; if (wy > ty1) ty1 = wy;
          if (wz < tz0) tz0 = wz; if (wz > tz1) tz1 = wz;
        }
        if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1 || tz1 < z0 || tz0 > z1) continue;
        out.push(wp.slice());
      }
    }
    return out;
  };

  /**
   * Moller-Trumbore, two-sided: a wall is a wall whichever way its winding runs.
   *
   * Returns the nearest hit's distance and the mean height of the triangle that made it,
   * because "blocked" on its own does not tell you whether you are looking at a lintel, a
   * jamb or a tread, and the first three rounds of this were spent guessing which.
   */
  const nearestHit = (tris, ox, oy, oz, dx, dy, dz, len) => {
    let bestT = Infinity, bestY = 0;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
      const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const inv = 1 / det;
      const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const s2 = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (s2 > 1e-4 && s2 < len && s2 < bestT) { bestT = s2; bestY = (t[1] + t[4] + t[7]) / 3; }
    }
    return { t: bestT, y: bestY };
  };

  const hits = (tris, ox, oy, oz, dx, dy, dz, len) => {
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
      const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const inv = 1 / det;
      const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const s2 = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (s2 > 1e-4 && s2 < len) return true;
    }
    return false;
  };

  const bays = city.getGarrisonBays();

  /**
   * The clear lane through one tower, measured across the walk.
   *
   * Chest height above the *higher* of the two walk levels, because that is the level a man
   * is at when he is inside the tower: on a stepped joint the low side climbs. Reported as
   * the widest run of consecutive clear samples, so a 1.7 m door and a 0.4 m gap beside a
   * pier cannot add up to 2.1 m.
   */
  const laneAt = (k) => {
    const bay = bays[k];
    const prev = bays[k - 1];
    if (!bay || !bay.hasTower || !prev) return null;
    /*
     * Only a tower with a wall-walk on *both* sides is a tower a man can walk past. Rome's
     * circuit carries footings, gaps and half-built bays whose "walk" is a construction
     * level tens of metres from its neighbour's — bay 3 reads a 28.39 m step against bay 2,
     * which is not a doorway problem, it is an unbuilt bay, and the traversal graph already
     * refuses to link across it.
     */
    if (!bay.walkable || !prev.walkable) return null;
    const half = bay.towerHalf;
    const walkHi = Math.max(bay.walkY, prev.walkY);
    const walkLo = Math.min(bay.walkY, prev.walkY);
    /*
     * Along the wall, from just clear of the tower's west face to just clear of its east.
     *
     * **The tower's own footprint plus 0.4 m, and not a metre more.** The first version ran
     * the ray 1.5 m out either side and four of Rome's forty-two passes failed on it with
     * the blocking triangle at 4.10 m from the tower centre — 0.3 m *outside* a 3.8 m
     * half-footprint. That is the scaffolding and the treadwheel crane a half-built bay
     * carries on its own walk, which is a real obstruction and a different question. A
     * probe that mixes the two cannot tell a tower with no doorway from a bay with a crane
     * parked on it. \`approach\` measures the second, separately.
     */
    const run = half * 2 + 0.8;
    const x0 = bay.x0 - bay.dx * (half + 0.4);
    const z0 = bay.z0 - bay.dz * (half + 0.4);
    const lo = Math.min(bay.innerOff, prev.innerOff);
    const hi = Math.max(bay.outerOff, prev.outerOff);
    // Every triangle within the tower's own block, once, so the sweep below is cheap.
    const pad = half + 2.5;
    const tris = trisInBox(
      bay.x0 - pad, walkLo - 0.5, bay.z0 - pad,
      bay.x0 + pad, walkHi + 5.0, bay.z0 + pad
    );
    const N = Math.max(2, Math.round((hi - lo) / 0.1));
    const clear = [];
    for (let i = 0; i <= N; i++) {
      const off = lo + ((hi - lo) * i) / N;
      const px = x0 + bay.nx * off;
      const pz = z0 + bay.nz * off;
      const chest = !hits(tris, px, walkHi + 1.15, pz, bay.dx, 0, bay.dz, run);
      clear.push(chest);
    }
    let best = 0, bestAt = 0, cur = 0;
    for (let i = 0; i <= N; i++) {
      if (clear[i]) { cur++; if (cur > best) { best = cur; bestAt = i - cur + 1; } }
      else cur = 0;
    }
    const width = best > 0 ? (best - 1) * ((hi - lo) / N) : 0;
    const centre = best > 0 ? lo + ((hi - lo) * (bestAt + (best - 1) / 2)) / N : 0;
    /*
     * Where the siege system actually walks a man across.
     *
     * The centre of the lane the bay publishes, which is what \`Siege.linkPath\` reads. Where
     * the city publishes none it falls back to the cityward lip, which is where \`linkPath\`
     * falls back to as well — so this arm and the sim always ask the same question.
     */
    const half2 = ((bay.passOuter ?? 0) - (bay.passInner ?? 0)) * 0.5;
    const pathOff = half2 > 0
      ? ((bay.passOuter ?? 0) + (bay.passInner ?? 0)) * 0.5
      : Math.min(bay.innerOff, prev.innerOff) - 0.15;
    const ppx = x0 + bay.nx * pathOff;
    const ppz = z0 + bay.nz * pathOff;
    const pathClear = !hits(tris, ppx, walkHi + 1.15, ppz, bay.dx, 0, bay.dz, run);
    /*
     * Headroom over the path, from the *higher* walk — the level the tower's own floor is
     * at. Measured from the lower one it reads the flight inside the tower as an obstacle,
     * which it is not: it is the floor.
     */
    let head = 0;
    let headY = 0;
    for (let k = 2; k <= 40; k++) {
      const h = k * 0.1;
      const q = nearestHit(tris, ppx, walkHi + h, ppz, bay.dx, 0, bay.dz, run);
      if (q.t < Infinity) { headY = +(q.y - walkHi).toFixed(2); break; }
      head = h;
    }
    /*
     * The 1.5 m of open walk either side of the tower, graded on its own.
     *
     * A construction bay parks a treadwheel crane and a scaffold lift on its own walkway,
     * and that stops a file as surely as a solid tower does — but it is \`buildScaffold\`'s
     * decision, not the tower's, and it should be reported rather than folded in.
     */
    const apRun = 1.6;
    const apW = !hits(tris, x0 - bay.dx * apRun + bay.nx * pathOff, walkHi + 1.15,
      z0 - bay.dz * apRun + bay.nz * pathOff, bay.dx, 0, bay.dz, apRun);
    const apE = !hits(tris, x0 + bay.dx * (run + 0.05) + bay.nx * pathOff, walkHi + 1.15,
      z0 + bay.dz * (run + 0.05) + bay.nz * pathOff, bay.dx, 0, bay.dz, apRun);
    return {
      bay: bay.index,
      /*
       * Both bays' construction stage, because a half-built bay is a building site: its
       * walk is a 3.4 m rubble lift, it carries a scaffold and, every other bay, a 15 m
       * treadwheel crane standing on the walk itself. Four of Rome's forty-two joints are
       * half-built pairs and they are graded apart from the finished circuit rather than
       * quietly excluded.
       */
      site: bay.stage !== 'finished' || prev.stage !== 'finished',
      step: +(walkHi - walkLo).toFixed(2),
      band: +(hi - lo).toFixed(2),
      lane: +width.toFixed(2),
      centre: +centre.toFixed(2),
      pathOff: +pathOff.toFixed(2),
      pathClear,
      approach: apW && apE,
      head: +head.toFixed(1),
      headY,
    };
  };

  const towers = [];
  for (let k = 0; k < bays.length; k++) {
    const q = laneAt(k);
    if (q) towers.push(q);
  }

  // ---- arm 2 helpers ------------------------------------------------------
  const step = () => g.engine.advance(1 / 30, 1000 / 30);
  const mid = (q) => ({ x: (q.x0 + q.x1) * 0.5, z: (q.z0 + q.z1) * 0.5 });
  const click = (u, x, z) =>
    g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z });

  return { g, b, s, p, city, bays, towers, step, mid, click, trisInBox, hits, MESHES };
})();
undefined;
`;

async function arm(map, fn, argsIn) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => errs.push(`pageerror[${map || 'rome'}]: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console[${map || 'rome'}]: ${m.text()}`); });
  await page.goto(
    `${base}/?harness=1&autoplay=0&quality=low&w=480&h=270&scenario=assault${map ? `&map=${map}` : ''}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 150000 });
  await page.evaluate(HELPERS);
  const r = await page.evaluate(fn, argsIn);
  await page.close();
  return r;
}

const GEOM = () => {
  const w = window.__tp;
  const all = w.towers;
  const t = all.filter((q) => !q.site);
  const site = all.filter((q) => q.site);
  const blocked = t.filter((q) => q.lane < 0.85);
  const offPath = t.filter((q) => !q.pathClear);
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
  return {
    towers: t.length,
    siteTowers: site.length,
    siteBlocked: site.filter((q) => q.lane < 0.85).length,
    siteBays: site.map((q) => q.bay),
    laneMin: Math.min(...t.map((q) => q.lane)),
    laneMed: med(t.map((q) => q.lane)),
    laneMax: Math.max(...t.map((q) => q.lane)),
    bandMed: med(t.map((q) => q.band)),
    headMed: med(t.map((q) => q.head)),
    stepMax: Math.max(...t.map((q) => q.step)),
    stepMed: med(t.map((q) => q.step)),
    stepOver2: t.filter((q) => q.step > 2.0).length,
    headMin: Math.min(...t.map((q) => q.head)),
    lowHead: t.filter((q) => q.head < 2.0).length,
    approachBlocked: t.filter((q) => !q.approach).length,
    blockedTowers: blocked.length,
    pathBlockedTowers: offPath.length,
    steps: t.map((q) => q.step).sort((x, y) => x - y),
    worst: t.slice().sort((a, b) => a.lane - b.lane).slice(0, 5),
    lowHeadSample: t.filter((q) => q.head < 2.0).slice(0, 5),
    sample: t.slice(0, 4),
  };
};

const TRAFFIC = (secs) => {
  const w = window.__tp;
  const { g, b, s, p } = w;
  g.advance(2);
  /*
   * The quietest settled garrison, not the furthest from the gate. On Rome the far end of
   * the curtain is where the storm lands, and a cohort ordered along the wall there is
   * grading the casualty list. "Quiet" is fewest live enemies inside 140 m.
   */
  let u = null, bestThreat = Infinity;
  for (const q of b.units) {
    if (q.destroyed || q.alive < 20 || !s.isGarrisoned(q.id) || s.plans.has(q.id)) continue;
    let threat = 0;
    for (const e of b.units) {
      if (e.destroyed || e.alive === 0 || e.faction === q.faction) continue;
      if (Math.hypot(e.x - q.x, e.z - q.z) < 140) threat += e.alive;
    }
    if (threat < bestThreat) { bestThreat = threat; u = q; }
  }
  if (!u) return { fail: 'no settled garrison' };
  let here = 0, bd = Infinity;
  for (let k = 0; k < w.bays.length; k++) {
    const c = w.mid(w.bays[k]); const d = (c.x - u.x) ** 2 + (c.z - u.z) ** 2;
    if (d < bd) { bd = d; here = k; }
  }
  // Four bays along, whichever direction has wall. Four bays is at least two towers on
  // Rome (a tower per bay) and two on Carthage (a tower every other bay).
  let target = null, off0 = 0;
  for (const off of [4, -4, 5, -5, 3, -3]) {
    const q = w.bays[here + off];
    if (q && q.garrisonable) { target = q; off0 = off; break; }
  }
  if (!target) return { fail: 'no bay to move to' };
  const c = w.mid(target);
  const startRun = s.sRun[s.stationNear(u.x, u.z)];
  const targetRun = s.sRun[s.stationNear(c.x, c.z)];
  const before = u.alive;
  // Per-man: did this man ever complete a tower pass?
  const crossed = new Set();
  const usedBefore = s.links.map((l) => l.used);
  w.click(u, c.x, c.z);
  w.step();
  const goal = s.plans.has(u.id) ? s.plans.get(u.id).goal : -1;
  const onLinkNow = new Set();
  let peakAt = 0, ticksOnLink = 0;
  for (let n = 0; n < Math.round(secs * 30); n++) {
    w.step();
    let at = 0, onLink = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const li = s.linkOf[i];
      if (li >= 0 && s.links[li] && s.links[li].kind === 0) onLinkNow.add(i);
      else if (onLinkNow.has(i) && s.crossOf[i] === -1) { crossed.add(i); onLinkNow.delete(i); }
      if (li >= 0 || s.crossOf[i] !== -1) onLink++;
      if (Math.hypot(p.x[i] - c.x, p.z[i] - c.z) < 26) at++;
    }
    if (onLink > 0) ticksOnLink++;
    peakAt = Math.max(peakAt, at);
  }
  let at = 0, alive = 0, stillUp = 0, worstFeet = 0;
  for (const i of u.members) {
    if (!p.aliveAt(i)) continue;
    alive++;
    if (b.elevated[i]) { stillUp++; worstFeet = Math.max(worstFeet, Math.abs(p.y[i] - b.support[i])); }
    if (Math.hypot(p.x[i] - c.x, p.z[i] - c.z) < 26) at++;
  }
  const passDelta = s.links.reduce((n, l, k) => n + (l.kind === 0 ? l.used - usedBefore[k] : 0), 0);
  return {
    unitId: u.id, bays: `${here} -> ${here + off0}`, threat: bestThreat, goal,
    startRun, targetRun, before, alive, at, peakAt, stillUp,
    menPastATower: crossed.size, circuitPasses: passDelta, ticksOnLink,
    worstFeet: +worstFeet.toFixed(3),
  };
};

/** `--geom` skips the two 120 s traffic arms; the stone does not move while iterating. */
const GEOM_ONLY = args.has('geom');
const romeGeom = await arm('', GEOM);
const carGeom = await arm('carthage', GEOM);
const romeTraffic = GEOM_ONLY ? null : await arm('', TRAFFIC, SECONDS);
const carTraffic = GEOM_ONLY ? null : await arm('carthage', TRAFFIC, SECONDS);
await browser.close();

const out = { romeGeom, carGeom, romeTraffic, carTraffic };
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

for (const [city, gm] of [['Rome', romeGeom], ['Carthage', carGeom]]) {
  check(`${city}: every tower on the finished circuit has a lane through it a man fits down`,
    gm.blockedTowers === 0,
    `${gm.towers} towers; clear lane min ${gm.laneMin} m, median ${gm.laneMed} m, max `
    + `${gm.laneMax} m across a ${gm.bandMed} m standing band; ${gm.blockedTowers} towers `
    + `under 0.85 m (a man is 0.84 m across the shoulders). Graded apart: ${gm.siteTowers} `
    + `joints between bays still under construction, ${gm.siteBlocked} of them blocked `
    + `(bays ${gm.siteBays.join(',') || 'none'}) — a half-built bay carries a scaffold and a `
    + `treadwheel crane on its own walk, which is \`buildScaffold\`'s call and not the tower's`);
  check(`${city}: the lane is tall enough to walk down`,
    gm.headMin >= 2.0,
    `headroom over the path, from the tower's own floor: min ${gm.headMin} m, median `
    + `${gm.headMed} m; ${gm.lowHead} towers under 2.0 m`);
  check(`${city}: the traversal path goes through the hole`,
    gm.pathBlockedTowers === 0,
    `${gm.pathBlockedTowers}/${gm.towers} towers where the offset \`linkPath\` walks men `
    + `along is inside masonry; walk step at a tower median ${gm.stepMed} m, worst `
    + `${gm.stepMax} m; ${gm.approachBlocked} towers whose approach along the open walk is `
    + `blocked by something that is not the tower (scaffolding, a crane on a half-built bay)`);
}

for (const [city, t] of GEOM_ONLY ? [] : [['Rome', romeTraffic], ['Carthage', carTraffic]]) {
  check(`${city}: a right-click along the wall is a traverse`,
    !!t && t.goal === 2 && t.startRun !== t.targetRun,
    `goal ${t?.goal} (2 = Traverse), run ${t?.startRun} -> ${t?.targetRun}, bays ${t?.bays}, `
    + `${t?.before} men, ${t?.threat} enemies within 140 m`);
  check(`${city}: men get past the towers`,
    !!t && t.menPastATower >= Math.max(8, t.before * 0.5),
    `${t?.menPastATower}/${t?.before} men of this cohort completed a tower crossing; `
    + `${t?.circuitPasses} crossings on the whole circuit; a man on a link on `
    + `${t?.ticksOnLink} ticks`);
  check(`${city}: and they arrive on the bay they were sent to`,
    !!t && t.alive > 0 && t.peakAt >= t.before * 0.5,
    `${t?.at}/${t?.alive} surviving men within 26 m of the target bay at the end, peak `
    + `${t?.peakAt} of ${t?.before}; ${t?.stillUp} still on the stone, worst |y - support| `
    + `${((t?.worstFeet ?? 0) * 100).toFixed(2)} cm`);
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 8).join('\n'));
process.exit(fail ? 1 : 0);
