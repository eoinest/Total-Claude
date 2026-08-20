/**
 * trailer-shot.mjs — the cut, and the camera that shoots it.
 *
 * Extracted from `trailer-recut.mjs` so the *sound* pass can put the listener in exactly the
 * place the picture pass put the lens. The audio engine takes its listener basis straight off
 * `ctx.camera.matrixWorld` (`AudioEngine.preRender`), so a sound pass that ran a different
 * camera would pan and attenuate everything to a frame nobody is looking at.
 *
 * This is a copy rather than an import back into the picture tool, and it is checked rather
 * than trusted: `trailer-audio-pass.mjs` recomputes each beat's camera from here and asserts
 * the resulting eye positions against the `eye` field the picture capture recorded per frame
 * in `capture.json`. If the two ever drift, the assertion fires.
 */

export const FPS = 30;
export const ease = (u) => u * u * (3 - 2 * u);            // smoothstep: gentle in and out
export const easeOut = (u) => 1 - (1 - u) * (1 - u);
export const lerp = (a, b, u) => a + (b - a) * u;
/** Interpolate every numeric field of two like-shaped param objects. */
export const mix = (a, b, u) => {
  const o = {};
  for (const k of Object.keys(a)) {
    const va = a[k], vb = b === undefined || b[k] === undefined ? va : b[k];
    o[k] = typeof va === 'number' && typeof vb === 'number' ? lerp(va, vb, u) : va;
  }
  return o;
};

export const SCENES = {
  'rome-field':    { map: 'campus-martius', scenario: 'field',   hour: 8.2 },
  'rome-assault':  { map: 'campus-martius', scenario: 'assault', hour: 14.3 },
  'carth-assault': { map: 'carthage', enemy: 'carthage', scenario: 'assault', hour: 16.2 },
  'carth-field':   { map: 'carthage', enemy: 'carthage', scenario: 'field',   hour: 10.4 },
};

export const BEATS = [
  // ---- I. the line, standing to -------------------------------------------
  {
    // Looking *north*, from behind the Roman line at the host it is waiting for, and that
    // is a lighting decision rather than a compositional one. Rome sits south of the field,
    // so a camera on the enemy's side looking back at the shields looks south — and at
    // 08:12 that is 20 degrees off a 12-degree sun. Two passes of this beat came back as
    // one flat cream wash with the men barely legible in it. Turned around, the same dawn
    // is a 90-degree cross-light and the same men have edges.
    id: 'field-line', scene: 'rome-field', at: [4, 9],
    desc: 'Dawn. Behind the Roman line, tracking along it, the Juthungi host beyond.',
    anchor: { kind: 'unitClass', faction: 0, cls: 'heavy-infantry', pick: 'frontmost' },
    from: { along: -40, eye: 2.7, aim: 1.55, dist: 27, fov: 32, yawAdd: Math.PI - 0.34 },
    to:   { along: 32, eye: 2.5, aim: 1.50, dist: 21, fov: 32, yawAdd: Math.PI - 0.22 },
    caption: { text: 'THE CAMPUS MARTIUS', sub: 'Rome, 271 AD', at: [0.14, 0.94] },
  },
  // ---- II. the build -------------------------------------------------------
  {
    id: 'field-clash', scene: 'rome-field', at: [63, 70],
    desc: 'The last fifty metres and the crash: the lines meet.',
    anchor: { kind: 'frontGap' },
    from: { dx: 0, dz: 0, eye: 15, aim: 2.4, dist: 96, fov: 32, yawAdd: 1.02 },
    to:   { dx: 0, dz: 0, eye: 11, aim: 2.0, dist: 62, fov: 32, yawAdd: 0.80 },
  },
  {
    id: 'field-cav', scene: 'rome-field', at: [74, 78],
    desc: 'The equites wing coming round the flank at the gallop.',
    anchor: { kind: 'cavalryUnit' },
    from: { dx: 0, dz: 0, eye: 8, aim: 2.0, dist: 58, fov: 32, yawAdd: 0.50 },
    to:   { dx: 0, dz: 0, eye: 6, aim: 1.8, dist: 40, fov: 32, yawAdd: 0.86 },
  },
  {
    /*
     * The scale shot, and the reason it looks *along* the battle line rather than at it.
     *
     * Two earlier framings of this failed in opposite directions. At zoom 0.78 the RTS
     * camera's own pitch curve is 50 degrees down and eight thousand men render as smudges
     * on a map. Pulled back to a 500 m standoff with a long lens instead, the aerial
     * perspective at that range washed the whole field to one cream and the hosts stopped
     * reading as hosts. A camera on the flank at 90 m, looking down the length of the
     * engagement, gets the whole frontage without the distance: the near end is 200 m away
     * and the far end recedes, which is what depth is for.
     */
    id: 'field-scale', scene: 'rome-field', at: [92, 98],
    desc: 'From the flank at ninety metres, down the length of the whole engagement.',
    anchor: { kind: 'contact' },
    from: { dx: 46, dz: 0, eye: 74, aim: 5, dist: 250, fov: 34, yaw: -Math.PI / 2 - 0.22 },
    to:   { dx: 16, dz: 0, eye: 58, aim: 5, dist: 196, fov: 34, yaw: -Math.PI / 2 - 0.08 },
  },
  // ---- III. the wall -------------------------------------------------------
  {
    id: 'siege-approach', scene: 'rome-assault', at: [15, 22],
    desc: 'Siege towers and ladders crossing open ground toward the wall, under artillery.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 74, lift: 0, eye: 27, aim: 7, dist: 178, fov: 32, yaw: 'in', yawAdd: -0.38 },
    to:   { stand: 62, lift: 0, eye: 19, aim: 6, dist: 138, fov: 32, yaw: 'in', yawAdd: -0.18 },
    caption: { text: 'THE AURELIAN WALL', sub: 'The Juthungi at the gates', at: [0.12, 0.92] },
  },
  {
    id: 'siege-ladders', scene: 'rome-assault', at: [40, 46],
    desc: 'Escalade against the unfinished stretch: men on the rungs, the garrison above them.',
    anchor: { kind: 'bay', k: -3 },
    from: { stand: 4, lift: 0, eye: 10, aim: 5.5, dist: 54, fov: 34, yaw: 'in', yawAdd: 0.58 },
    to:   { stand: 4, lift: 0, eye: 17, aim: 7.5, dist: 41, fov: 34, yaw: 'in', yawAdd: 0.34 },
  },
  {
    /*
     * The parapet from *outside*, at the height of the crest.
     *
     * The first attempt stood the camera on the wall-walk and looked along it, which is the
     * composition this shot wants and is not survivable: the run is 34 m of walk and every
     * fifth bay carries a covered gallery or a tower chamber, so the camera ended up inside
     * one and the frame was a photograph of a doorway. Outside the face at crest height,
     * looking obliquely along the curtain, gets the embrasures, the men in them and the
     * ladder heads without putting the lens inside the masonry.
     */
    id: 'siege-parapet', scene: 'rome-assault', at: [52, 57],
    desc: 'The crest from outside: the garrison in the embrasures, escaladers at the top.',
    anchor: { kind: 'bay', k: -3 },
    from: { stand: 3, lift: 'crest', eye: 1.3, aim: -1.5, dist: 46, fov: 32, yaw: 'in', yawAdd: 1.06 },
    to:   { stand: 3, lift: 'crest', eye: 1.0, aim: -1.3, dist: 33, fov: 32, yaw: 'in', yawAdd: 0.86 },
    fadeOut: 9,
  },
  // ---- IV. Carthage --------------------------------------------------------
  {
    id: 'carth-wall', scene: 'carth-assault', at: [12, 19],
    desc: 'A descending crane: the city and the Byrsa, then down onto the great wall and its ditch.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 20, lift: 0, eye: 158, aim: 22, dist: 380, fov: 34, yaw: 'in', yawAdd: -0.30 },
    to:   { stand: 52, lift: 0, eye: 44, aim: 9, dist: 196, fov: 34, yaw: 'in', yawAdd: -0.10 },
    caption: { text: 'CARTHAGE', sub: 'Spring, 146 BC', at: [0.12, 0.92] },
    fadeIn: 9,
  },
  {
    id: 'carth-eles', scene: 'carth-field', at: [96, 101],
    desc: 'The war elephants coming on in front of the Punic centre.',
    anchor: { kind: 'unitType', id: 'war-elephants' },
    from: { dx: 0, dz: 0, eye: 5.0, aim: 2.4, dist: 52, fov: 32, yawAdd: 0.45 },
    to:   { dx: 0, dz: 0, eye: 3.6, aim: 2.8, dist: 32, fov: 32, yawAdd: 0.72 },
  },
  {
    id: 'carth-tower', scene: 'carth-assault', at: [252, 257],
    desc: 'Two siege towers docked on the Punic parapet, columns queuing up into them.',
    anchor: { kind: 'bay', k: 1 },
    from: { stand: 26, lift: 0, eye: 26, aim: 15, dist: 60, fov: 32, yaw: 'in', yawAdd: 0.62 },
    to:   { stand: 22, lift: 0, eye: 21, aim: 14, dist: 44, fov: 32, yaw: 'in', yawAdd: 0.42 },
    fadeOut: 9,
  },
  // ---- V. the climax: the gate --------------------------------------------
  {
    /*
     * One take, and it used to be two.
     *
     * The released cut broke this in the middle: `rome-ram` ran t+202..208 and `rome-gate`
     * t+210..218, so the join had a two-second hole in sim time the capture never shot, and
     * the camera stepped *backwards* across it — eye 8 -> 8.5 m, standoff 33 -> 44 m. A
     * viewer reads a wider frame after a tighter one as a new setup, which is precisely the
     * thing this shot must not be: the ram is one continuous push and the payoff is the
     * twenty-sixth blow at the end of it. Shot as a single sixteen-second beat with one
     * eased move, monotonic in eye, standoff and yaw, so nothing can read as a cut. It
     * costs the trailer two seconds. The slow push is what the two seconds buy.
     */
    id: 'rome-ram-gate', scene: 'rome-assault', at: [202, 218],
    desc: 'One take: the ram at the Porta Flaminia, pushing in, and the leaves giving way at t+215.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 10, lift: 0, eye: 11, aim: 3.8, dist: 46, fov: 34, yaw: 'in', yawAdd: -0.98 },
    to:   { stand: 3, lift: 0, eye: 6.0, aim: 3.4, dist: 30, fov: 32, yaw: 'in', yawAdd: -0.44 },
    fadeIn: 9,
  },
  {
    id: 'rome-arch', scene: 'rome-assault', at: [218, 224],
    desc: 'From the street inside: the arch is open, and the last cohort stands in it.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: -14, lift: 0, eye: 6.0, aim: 3.4, dist: 33, fov: 32, yaw: 'out', yawAdd: 0.16 },
    to:   { stand: -9, lift: 0, eye: 4.4, aim: 3.2, dist: 25, fov: 32, yaw: 'out', yawAdd: 0.04 },
  },
  // ---- VI. end card --------------------------------------------------------
  {
    id: 'endcard', scene: 'rome-assault', at: [230, 237],
    desc: 'The Aurelian Wall with Rome behind it, and the title.',
    anchor: { kind: 'bay', k: 6 },
    from: { stand: 128, lift: 0, eye: 66, aim: 16, dist: 250, fov: 32, yaw: 'in', yawAdd: 0.34 },
    to:   { stand: 112, lift: 0, eye: 58, aim: 15, dist: 218, fov: 32, yaw: 'in', yawAdd: 0.20 },
    endcard: true,
  },
];

export const PAGE_LIB = () => {
  const g = window.__game;
  const rig = g.engine.rig;
  const T = {
    savedHeightAt: rig.heightAt,
    savedPitch: rig.pitchForZoom,
    savedFov: rig.fovForZoom,
    savedRadius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
  };
  window.__tr = T;

  T.reset = () => {
    rig.heightAt = T.savedHeightAt;
    rig.pitchForZoom = T.savedPitch;
    rig.fovForZoom = T.savedFov;
    if (T.savedRadius) Object.defineProperty(rig, 'radius', T.savedRadius);
    else delete rig.radius;
  };

  /** Resolve a beat's anchor against the live world. Plain numbers only. */
  T.anchor = (spec) => {
    const b = g.battle;
    const city = g.engine.context.tryGet('city');
    const ground = (x, z) => T.savedHeightAt ? T.savedHeightAt(x, z) : 0;
    if (spec.kind === 'world') return { x: 0, z: 0, terrY: ground(0, 0) };
    if (spec.kind === 'bay') {
      const bays = city.getGarrisonBays();
      const gi = bays.findIndex((q) => q.isGate);
      const bay = bays[Math.max(0, Math.min(bays.length - 1, (gi < 0 ? 0 : gi) + spec.k))];
      let mx = (bay.x0 + bay.x1) * 0.5, mz = (bay.z0 + bay.z1) * 0.5;
      if (spec.subject === 'gate') {
        // The gate is not at the centre of its own bay — the road decides where it is.
        const gate = city.getGates()[0];
        if (gate) { mx = gate.x; mz = gate.z; }
      }
      return { x: mx, z: mz, nx: bay.nx, nz: bay.nz, dx: bay.dx, dz: bay.dz,
        walkY: bay.walkY, crestY: bay.crestY, terrY: ground(mx, mz), bayIndex: bay.index };
    }
    if (spec.kind === 'frontGap') {
      // Midpoint of the two *front lines*, not of the two hosts. The hosts' centroids
      // include the reserves and the artillery, so their midpoint sits tens of metres
      // behind where the lines are about to touch — which is how the first pass of the
      // clash beat opened on two thirds of a frame of empty grass.
      let ours = null, theirs = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const cls = b.typeOf(u).unitClass;
        const line = cls === 'heavy-infantry' || cls === 'spear-infantry'
          || cls === 'shock-infantry' || cls === 'light-infantry';
        if (!line) continue;
        if (u.faction === 0) { if (!ours || u.z < ours.z) ours = u; }
        else if (!theirs || u.z > theirs.z) theirs = u;
      }
      if (!ours || !theirs) return null;
      const x = (ours.x + theirs.x) / 2, z = (ours.z + theirs.z) / 2;
      return { x, z, terrY: ground(x, z), gap: +(ours.z - theirs.z).toFixed(1),
        axis: Math.atan2(theirs.x - ours.x, theirs.z - ours.z) };
    }
    if (spec.kind === 'contact' || spec.kind === 'closing') {
      // The densest 40 m cell of men actually fighting; before contact, the midpoint of
      // the two hosts on the axis between them.
      const p = b.pool;
      const cells = new Map();
      const cx = [0, 0, 0], cz = [0, 0, 0], cn = [0, 0, 0];
      for (let i = 0; i < p.count; i++) {
        const st = p.state[i];
        if (st === 11 || st === 10) continue;
        const f = p.faction[i];
        cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++;
        if (st !== 4) continue;
        const key = Math.floor((p.z[i] + 1400) / 40) * 128 + Math.floor((p.x[i] + 1400) / 40);
        const c = cells.get(key);
        if (c) { c.x += p.x[i]; c.z += p.z[i]; c.n++; } else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
      }
      const foe = cn[2] > cn[1] ? 2 : 1;
      const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
      const bx = cn[foe] ? cx[foe] / cn[foe] : 0, bz = cn[foe] ? cz[foe] / cn[foe] : 0;
      let best = null;
      for (const c of cells.values()) if (!best || c.n > best.n) best = c;
      const useCell = best && best.n >= 12;
      const x = useCell ? best.x / best.n : (ax + bx) / 2;
      const z = useCell ? best.z / best.n : (az + bz) / 2;
      return { x, z, terrY: ground(x, z), axis: Math.atan2(bx - ax, bz - az),
        cellN: best ? best.n : 0 };
    }
    if (spec.kind === 'unitType' || spec.kind === 'unitClass' || spec.kind === 'cavalryUnit') {
      let best = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const t = b.typeOf(u);
        if (spec.kind === 'unitType' && t.id !== spec.id) continue;
        if (spec.kind === 'unitClass') {
          if (u.faction !== spec.faction || t.unitClass !== spec.cls) continue;
        }
        if (spec.kind === 'cavalryUnit'
            && t.unitClass !== 'heavy-cavalry' && t.unitClass !== 'light-cavalry') continue;
        if (spec.pick === 'frontmost') {
          // Nearest the enemy: faction 0 faces -Z on both maps.
          if (!best || (spec.faction === 0 ? u.z < best.z : u.z > best.z)) best = u;
        } else if (!best || u.alive > best.alive) best = u;
      }
      if (!best) return null;
      return { x: best.x, z: best.z, facing: best.facing, alive: best.alive,
        terrY: ground(best.x, best.z), unit: b.typeOf(best).id };
    }
    return null;
  };

  /** Park the camera for one frame. Everything is absolute; nothing is remembered. */
  T.apply = (s) => {
    T.reset();
    if (s.liftY !== null && s.liftY !== undefined) {
      const y = s.liftY;
      rig.heightAt = () => y;
    }
    if (s.cam) {
      const LIFT = 1.55;
      const groundY = (s.liftY !== null && s.liftY !== undefined)
        ? s.liftY : T.savedHeightAt(s.fx, s.fz);
      const rise = s.cam.eye - s.cam.aim + LIFT;
      const R = Math.hypot(rise, s.cam.dist);
      const P = Math.atan2(rise, s.cam.dist);
      rig.zoom = 0; rig.zoomTarget = 0;
      rig.pitchForZoom = () => P;
      rig.fovForZoom = () => s.cam.fov;
      Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
      rig.heightAt = () => groundY + s.cam.aim - LIFT;
      rig.jumpTo(s.fx, s.fz, 0, s.yaw);
    } else {
      rig.jumpTo(s.fx, s.fz, s.zoom, s.yaw);
    }
  };

  /** One rendered frame == one 30 Hz simulation tick. */
  T.step = () => { g.engine.advance(1 / 30, 1000 / 30); };

  T.stats = () => {
    const b = g.battle, p = b.pool;
    let alive = 0, fighting = 0, corpses = 0, moving = 0, climbing = 0, shooting = 0, routing = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 11 || st === 10) { corpses++; continue; }
      alive++;
      if (st === 4) fighting++;
      else if (st === 1 || st === 2 || st === 3) moving++;
      else if (st === 13) climbing++;
      else if (st === 6 || st === 7 || st === 8) shooting++;
      else if (st === 12) routing++;
    }
    const st = g.engine.stats();
    const cam = g.engine.rig.camera;
    /*
     * How far off the sun the lens points, in degrees, and how high the sun is.
     *
     * Inside about 45 degrees of a low sun every surface in frame goes to one flat cream —
     * bloom, god rays and forward scatter all peak at once. The first pass of the opening
     * beat came back at 14 degrees off an 8-degree sun and read as a lighting fault rather
     * than as dawn. It is a number, so it is recorded rather than argued about.
     */
    let sunAngle = null, sunElev = null;
    const sky = g.engine.context.tryGet('sky');
    const sd = sky && sky.sunDirection;
    if (sd) {
      const f = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
      const fl = Math.hypot(f.x, f.z) || 1e-6, sl = Math.hypot(sd.x, sd.z) || 1e-6;
      const c = (f.x * sd.x + f.z * sd.z) / (fl * sl);
      sunAngle = +((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI).toFixed(1);
      sunElev = +((Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180) / Math.PI).toFixed(1);
    }
    return { t: +g.simTime().toFixed(4), alive, fighting, corpses, moving, climbing,
      shooting, routing, draws: st.calls, tris: st.tris, sunAngle, sunElev,
      fov: +cam.fov.toFixed(1),
      eye: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)] };
  };
};;

/**
 * The absolute camera state for frame `i` of `total` in a beat, against a resolved anchor.
 * Byte-for-byte the body of the picture tool's per-frame block, with `p`/`u` computed here.
 */
export function frameState(beat, anchor, i, total) {
  const u = ease(total <= 1 ? 0 : i / (total - 1));
  const p = mix(beat.from, beat.to, u);
  const st = { fx: 0, fz: 0, yaw: 0, zoom: 0.5, liftY: null, cam: null };

  // Focus, in whichever frame the anchor provides.
  if (p.x !== undefined) { st.fx = p.x; st.fz = p.z; }
  else if (anchor.nx !== undefined) {
    // A wall bay: out along its own outward normal, and along its own run.
    st.fx = anchor.x + anchor.nx * (p.stand ?? 0) + anchor.dx * (p.along ?? 0);
    st.fz = anchor.z + anchor.nz * (p.stand ?? 0) + anchor.dz * (p.along ?? 0);
  } else if (anchor.facing !== undefined && p.along !== undefined) {
    // A unit: slide down its own frontage, which is perpendicular to its facing.
    const f = anchor.facing;
    st.fx = anchor.x + Math.cos(f) * p.along;
    st.fz = anchor.z - Math.sin(f) * p.along;
  } else {
    st.fx = anchor.x + (p.dx ?? 0); st.fz = anchor.z + (p.dz ?? 0);
  }

  // The ground datum this beat measures its heights against.
  const lift = beat.from.lift;
  if (lift !== undefined) {
    const parse = (v) => (typeof v === 'string'
      ? (v.startsWith('walk') ? { base: 'walk', add: v.length > 4 ? Number(v.slice(4)) : 0 }
        : { base: 'crest', add: v.length > 5 ? Number(v.slice(5)) : 0 })
      : { base: 'terrain', add: v });
    const la = parse(lift), lb = parse(beat.to.lift ?? lift);
    if (la.base !== lb.base) throw new Error(`${beat.id}: lift datum changes mid-beat`);
    const add = lerp(la.add, lb.add, u);
    st.liftY = la.base === 'walk' ? anchor.walkY + add
      : la.base === 'crest' ? anchor.crestY + add
        : anchor.terrY + add;
  }

  // Yaw. Named against the wall where there is one, so it cannot go stale when the
  // curtain is re-cut; otherwise off the axis between the armies or the unit's facing.
  const yw = p.yaw === 'in' ? Math.atan2(-anchor.nx, -anchor.nz)
    : p.yaw === 'out' ? Math.atan2(anchor.nx, anchor.nz)
      : p.yaw === 'along' ? Math.atan2(anchor.dx, anchor.dz)
        : typeof p.yaw === 'number' ? p.yaw
          : (anchor.axis ?? ((anchor.facing ?? 0) + Math.PI));
  st.yaw = yw + (p.yawAdd ?? 0);

  // Framing.
  if (p.eye !== undefined) st.cam = { eye: p.eye, aim: p.aim, dist: p.dist, fov: p.fov };
  else st.zoom = p.zoom;
  return st;
}
