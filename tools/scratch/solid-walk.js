/*
 * The case matrix: man-ticks inside masonry, per class of mover, per thousand.
 *
 * Injected into the page by `probe-solid.mjs --case=walk`. Kept as its own file rather
 * than as a template literal so it can be read and edited as JavaScript.
 *
 * Three ground truths per man, because they answer different questions and have disagreed:
 *
 *   inWall  is he inside the curtain's own footprint — within a half-thickness of the bay
 *           centreline, below its crest, in a bay that carries stone, and not in the clear
 *           width of an *open* gate? This is the one that does not ask any part of the
 *           collision system whether the collision system is working. **It is the primary
 *           number.** A ghost hole — collision open, stone drawn — shows up here and
 *           nowhere else.
 *   boxWall is he inside an obstacle of kind wall/tower/gate, as the sim's own
 *           `ObstacleField` sees it, honouring `topY` exactly as `integrate` does? Non-zero
 *           means the collider is failing against the set it was given.
 *   boxCity the same query against the insulae and monuments, reported apart so a man
 *           standing in a shop does not read as a man standing in the curtain. The first
 *           version of this probe merged the two and reported 191 per mille on Rome, of
 *           which none at all was the wall.
 *
 * `elevated` men are exempt: the garrison on the wall-walk, a boarding party on a ramp and
 * anyone mid-crossing are placed by `Siege` and rewritten in `postIntegrate`. They are
 * counted in their own column so the exemption cannot hide anything.
 */
window.__psWalk = (seconds) => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const city = ctx.tryGet('city');
  const engine = g.engine;
  const p = b.pool;
  const DYING = 10, DEAD = 11;
  const SOLDIER_RADIUS = 0.42;

  /** Silence the directors so the measurement is of the orders this probe gives. */
  const held = [];
  for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage']) {
    const s = ctx.tryGet(name);
    if (s && s.fixedUpdate) { held.push([s, s.fixedUpdate]); s.fixedUpdate = () => {}; }
  }

  const gates = city.getGates();
  const bays = city.getGarrisonBays();
  const halfOpen = (city.cityPlan.gateOpenWidth ?? 4) * 0.5 + 0.5;
  /**
   * A bay that carries no stone a man could be inside.
   *
   * `footing` is a bare ankle-high course — `WallBlocker` omits it and the occupancy grid
   * deliberately leaves it open, so a man walking over one is walking over a kerb, not
   * through a wall. `gap` is rubble and a palisade and *is* solid, which is why it is not
   * in this set: it carries a blocker and an obstacle box.
   */
  const OPEN_STAGE = new Set(['footing']);

  const bayAt = (x) => {
    for (const bay of bays) if (x >= bay.x0 && x <= bay.x1) return bay;
    return null;
  };
  /** Wall centreline z at x, by linear interpolation along the bay polyline. */
  const wallZAt = (x) => {
    const bay = bayAt(x);
    if (!bay) return null;
    const t = (x - bay.x0) / (bay.x1 - bay.x0);
    return bay.z0 + (bay.z1 - bay.z0) * t;
  };
  /** Distance from x to the nearest gate axis, and whether that gate stands open. */
  const nearestGate = (x) => {
    let best = null, bd = Infinity;
    for (const gt of gates) {
      const d = Math.abs(x - gt.x);
      if (d < bd) { bd = d; best = gt; }
    }
    return { d: bd, gate: best };
  };
  /** True where a man is legitimately allowed through the wall line. */
  const throughWay = (x) => {
    const bay = bayAt(x);
    if (!bay || OPEN_STAGE.has(bay.stage)) return true;
    const ng = nearestGate(x);
    return !!(ng.gate && ng.gate.open && ng.d <= halfOpen);
  };

  /**
   * Is this man inside the curtain's own solid, judged from the published bay geometry?
   *
   * Signed offset along the bay's outward normal, against its half thickness plus a body
   * radius, under its crest. Nothing here reads the obstacle set or the raster.
   */
  const inWall = (x, z, y) => {
    const bay = bayAt(x);
    if (!bay || OPEN_STAGE.has(bay.stage)) return false;
    if (throughWay(x)) return false;
    const t = (x - bay.x0) / (bay.x1 - bay.x0);
    const cz = bay.z0 + (bay.z1 - bay.z0) * t;
    const off = (x - (bay.x0 + (bay.x1 - bay.x0) * t)) * bay.nx + (z - cz) * bay.nz;
    /*
     * His **centre point**, not his body, and with a 0.3 m margin inside the face.
     *
     * A man correctly stopped by `ObstacleField.resolve` comes to rest with his centre at
     * `halfW + SOLDIER_RADIUS` = 3.42 m off a 6 m curtain — he is touching the stone and he
     * is outside it. Testing the inflated body against the footprint counts every man in
     * the front rank of a formation halted at the wall as a penetration, which is the exact
     * artefact probe-nav records ("once men are correctly stopped *against* the face, a
     * raster test counts them as inside"). Measured on Rome it was worth 52.4 per mille of
     * pure boundary contact. Half a body inside the face is the line.
     */
    if (Math.abs(off) > Math.max(0.1, bay.halfThickness - 0.3)) return false;
    const crest = Number.isFinite(bay.crestY) ? bay.crestY : bay.walkY;
    return y < crest - 0.6;
  };

  const field = b.masonry;
  const items = field.items || [];
  /**
   * Which solid contains this man's centre — radius **0**, for the same reason `inWall`
   * uses his centre. `blocked(..., SOLDIER_RADIUS)` answers "is he touching one", which is
   * what a man halted against a wall is doing correctly.
   */
  const kindAt = (x, z, y) => {
    const i = field.solidAt(x, z, y, 0);
    if (i < 0) return null;
    return items[i] ? items[i].kind : 'unknown';
  };

  const step = () => engine.advance(1 / 60, 166);

  // ---- warm up: let the siege place its garrison and the armies close ------
  for (let t = 0; t < 20 * 60; t++) step();

  // ---- classify -------------------------------------------------------------
  const classOf = (u) => {
    const def = b.typeOf(u);
    const owned = !!(b.siege && b.siege.ownsUnit && b.siege.ownsUnit(u.id));
    let elev = 0, n = 0;
    for (const i of u.members) {
      if (p.state[i] === DEAD || p.state[i] === DYING) continue;
      n++; if (b.elevated[i]) elev++;
    }
    if (n && elev / n > 0.5) return 'garrison';
    if (owned || !def || def.walkSpeed < 1.0) return 'engine';
    for (const i of u.members) {
      if (p.state[i] === DEAD || p.state[i] === DYING) continue;
      return b.mounted && b.mounted[i] ? 'cavalry' : 'infantry';
    }
    return 'infantry';
  };

  const roster = [];
  for (const u of b.units) {
    if (u.destroyed || u.alive === 0) continue;
    roster.push({ u, cls: classOf(u) });
  }

  /*
   * Order everything that can march to a point 150 m inside the circuit.
   *
   * The player's own report, driven through the same `orderIssued` channel the mouse uses:
   * "I send a group of soldiers and they walk through the wall". Units already inside are
   * left alone; the garrison is left standing, which is its own case.
   */
  const ordered = [];
  let routed = null;
  for (const r of roster) {
    const u = r.u;
    if (r.cls === 'garrison') continue;
    const wz = wallZAt(u.x);
    if (wz === null || u.z >= wz - 20) continue;
    engine.events.emit('orderIssued', {
      unitIds: [u.id], kind: 'move', x: u.x, z: wz + 150, facing: 0, running: true,
    });
    ordered.push(r);
    r.startZ = u.z;
    r.startX = u.x;
    // One infantry unit routs instead: a rout path ignores formation and most steering,
    // so it is the case most likely to walk through something.
    if (!routed && r.cls === 'infantry') { routed = r; r.cls = 'rout'; b.rout(u); }
  }

  // ---- measure ---------------------------------------------------------------
  const CLASSES = ['infantry', 'rout', 'cavalry', 'engine', 'garrison'];
  const acc = {};
  for (const c of CLASSES) {
    acc[c] = { manTicks: 0, inWall: 0, inWallClean: 0, boxWall: 0, boxCity: 0, elevInWall: 0, worst: 0, deepest: null, cleanDeepest: null, cleanWorst: 0 };
  }
  const clsOfUnit = new Map();
  for (const r of roster) clsOfUnit.set(r.u.id, r.cls);

  // Crossings of the wall plane, counted once per man per crossing.
  const side = new Int8Array(p.x.length);
  /**
   * Has this man ever been elevated during the run?
   *
   * The assault AI escalades: `Siege` puts a man on a ladder, flags him `elevated` and
   * rewrites his position, and it clears the flag while he queues at the foot of a flight.
   * A man who is inside the stone during one of those transitions is a siege bookkeeping
   * question, not a collision failure. A man who has **never** been elevated and is inside
   * six metres of brick walked there, and that is the number the player's report is about.
   */
  const everElev = new Uint8Array(p.x.length);
  const crossings = { total: 0, offWay: 0, worstOffset: 0, where: [] };
  for (let i = 0; i < p.count; i++) {
    const wz = wallZAt(p.x[i]);
    side[i] = wz === null ? 0 : (p.z[i] < wz ? -1 : 1);
  }

  /** Signed offset of (x,z) from its bay's centreline along the outward normal. */
  const wallOffset = (x, z) => {
    const bay = bayAt(x);
    if (!bay) return 99;
    const t = (x - bay.x0) / (bay.x1 - bay.x0);
    const cz = bay.z0 + (bay.z1 - bay.z0) * t;
    return (x - (bay.x0 + (bay.x1 - bay.x0) * t)) * bay.nx + (z - cz) * bay.nz;
  };
  /** Distribution of |offset| over the men counted as inside, in 0.5 m bins. */
  const offHist = new Int32Array(10);

  const ticks = Math.round(seconds * 60);
  for (let t = 0; t < ticks; t++) {
    step();
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === DEAD || st === DYING) continue;
      const cls = clsOfUnit.get(p.unitId[i]);
      if (!cls) continue;
      const a = acc[cls];
      a.manTicks++;
      const x = p.x[i], z = p.z[i], y = p.y[i];
      const elev = b.elevated[i] !== 0;
      if (elev) everElev[i] = 1;

      if (inWall(x, z, y)) {
        offHist[Math.min(9, Math.floor(Math.abs(wallOffset(x, z)) * 2))]++;
        if (elev) a.elevInWall++;
        else {
          a.inWall++;
          const bay = bayAt(x);
          const crest = bay ? bay.crestY : y;
          const d = crest - y;
          if (d > a.worst) { a.worst = d; a.deepest = { x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), bay: bay ? bay.index : -1 }; }
          if (!everElev[i]) {
            a.inWallClean++;
            if (d > a.cleanWorst) { a.cleanWorst = d; a.cleanDeepest = { x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), bay: bay ? bay.index : -1 }; }
          }
        }
      }
      if (!elev) {
        const k = kindAt(x, z, y);
        if (k === 'wall' || k === 'tower' || k === 'gate') a.boxWall++;
        else if (k) a.boxCity++;
      }

      const wz = wallZAt(x);
      if (wz !== null && side[i] !== 0) {
        const now = z < wz ? -1 : 1;
        if (now !== side[i]) {
          side[i] = now;
          crossings.total++;
          if (!throughWay(x)) {
            crossings.offWay++;
            if (!everElev[i]) crossings.offWayClean = (crossings.offWayClean || 0) + 1;
            const off = nearestGate(x).d;
            if (off > crossings.worstOffset) crossings.worstOffset = off;
            if (crossings.where.length < 30) {
              const bay = bayAt(x);
              crossings.where.push({ x: +x.toFixed(1), z: +z.toFixed(1), bay: bay ? bay.index : -1, stage: bay ? bay.stage : '?' });
            }
          }
        }
      }
    }
  }

  // ---- how far did each ordered unit actually get? ---------------------------
  const arrivals = [];
  for (const r of ordered) {
    const u = b.unitById(r.u.id);
    if (!u) continue;
    const wz = wallZAt(u.x);
    arrivals.push({
      id: u.id, typeId: u.typeId, cls: r.cls,
      startX: +r.startX.toFixed(0), startZ: +r.startZ.toFixed(0),
      nowX: +u.x.toFixed(0), nowZ: +u.z.toFixed(0),
      wallZ: wz === null ? null : +wz.toFixed(0),
      inside: wz !== null && u.z > wz + 8,
      through: throughWay(u.x),
      bay: bayAt(u.x) ? bayAt(u.x).index : -1,
    });
  }

  for (const [s, fn] of held) s.fixedUpdate = fn;

  const rows = {};
  for (const c of CLASSES) {
    const a = acc[c];
    rows[c] = {
      units: roster.filter((r) => r.cls === c).length,
      manTicks: a.manTicks,
      inWallPerMille: a.manTicks ? +(a.inWall / a.manTicks * 1000).toFixed(2) : 0,
      inWallCleanPerMille: a.manTicks ? +(a.inWallClean / a.manTicks * 1000).toFixed(2) : 0,
      inWallCleanManTicks: a.inWallClean, cleanWorstDepth: +a.cleanWorst.toFixed(1), cleanDeepest: a.cleanDeepest,
      boxWallPerMille: a.manTicks ? +(a.boxWall / a.manTicks * 1000).toFixed(2) : 0,
      boxCityPerMille: a.manTicks ? +(a.boxCity / a.manTicks * 1000).toFixed(2) : 0,
      inWallManTicks: a.inWall, boxWallManTicks: a.boxWall, boxCityManTicks: a.boxCity,
      elevatedInWallManTicks: a.elevInWall,
      worstDepth: +a.worst.toFixed(1), deepest: a.deepest,
    };
  }
  return {
    seconds, ticks, city: city.cityPlan.id,
    unitsOrdered: ordered.length,
    rows, crossings, offsetHist: Array.from(offHist),
    arrivals: arrivals.slice(0, 40),
    unitsInside: arrivals.filter((a) => a.inside).length,
    unitsInsideOffWay: arrivals.filter((a) => a.inside && !a.through).length,
  };
};
