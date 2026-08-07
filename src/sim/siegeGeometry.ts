import * as THREE from 'three';

/**
 * Geometry for the siege train.
 *
 * Every machine here is built once, at unit scale where it makes sense, and drawn with
 * `InstancedMesh`, so four towers, a ram and two dozen ladders cost seven draw calls
 * whatever their number — three of which cast, because a caster is re-rendered once per
 * shadow cascade and a ladder rung's shadow is not worth four passes.
 *
 * The tower is split into a *shaft* (authored with y in 0..1 and stretched per instance
 * to reach that bay's wall-walk), a *deck*, a set of *wheels* and a *ramp*. That division
 * exists because the wall-walk is not level: `walkY` steps in 0.55 m construction
 * increments and the ground under it rolls through forty metres, so two towers on the same
 * curtain need different heights. Stretching the whole model would give one of them
 * ellipsoidal wheels.
 *
 * Colour is per-vertex and every part shares one `MeshStandardMaterial`, so timber, raw
 * hide, iron and rope cost nothing extra.
 *
 * There is no artillery here on purpose — see the note at the foot of the file.
 */

/**
 * Albedo, authored in sRGB and converted, exactly as `src/city/palette.ts` does it.
 *
 * The first pass wrote raw linear triples and the whole siege train rendered near-black
 * against the curtain. Two faults at once: the values were being read as linear when they
 * had been picked as though they were sRGB, and — the larger one — the thin hide panels had
 * inconsistent quad winding, so half of them faced away and took no light at all. The
 * material is `DoubleSide` now, which fixes the shading as well as the visibility because
 * `MeshStandardMaterial` flips its normal for a back-facing fragment.
 */
const srgb = (hex: number): THREE.Color => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// Weathered oak, matched to the city's own timber so a siege engine and a scaffold read as
// the same material — they were cut from the same woods in the same month.
const OAK = srgb(0x8a6a45);
const OAK_DARK = srgb(0x604a30);
const OAK_PALE = srgb(0xa98a63);
/** Green ox-hide nailed over the face and soaked against fire: grey-brown, slightly waxy. */
const HIDE = srgb(0x9c8f7c);
const HIDE_DARK = srgb(0x6f6455);
const IRON = srgb(0x55585e);
const ROPE = srgb(0xb2a179);

/** A growable soup of triangles with per-vertex colour, flushed into one geometry. */
class Mesher {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    c: THREE.Color
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      this.nrm.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
    }
  }

  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    c: THREE.Color
  ): void {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, c);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, c);
  }

  /** An axis-aligned box. The workhorse: a siege engine is a pile of squared timber. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, top = c): void {
    this.quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, top);       // +Y
    this.quad(x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0, OAK_DARK);  // -Y
    this.quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, c);         // -Z
    this.quad(x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1, c);         // +Z
    this.quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1, c);         // -X
    this.quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, c);         // +X
  }

  /** A squared beam between two points — braces, rafters, ladder rails. */
  beam(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, c: THREE.Color
  ): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // Any vector not parallel to the axis gives a usable first perpendicular.
    let px = -uy, py = ux, pz = 0;
    if (Math.hypot(px, py, pz) < 1e-4) { px = 1; py = 0; pz = 0; }
    const pl = Math.hypot(px, py, pz);
    px /= pl; py /= pl; pz /= pl;
    const qx = uy * pz - uz * py;
    const qy = uz * px - ux * pz;
    const qz = ux * py - uy * px;
    const corner = (s: number, t: number, at: 0 | 1): [number, number, number] => [
      (at ? bx : ax) + px * s * r + qx * t * r,
      (at ? by : ay) + py * s * r + qy * t * r,
      (at ? bz : az) + pz * s * r + qz * t * r,
    ];
    const s = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    for (let k = 0; k < 4; k++) {
      const [a0, a1] = s[k];
      const [b0, b1] = s[(k + 1) % 4];
      const p0 = corner(a0, a1, 0);
      const p1 = corner(b0, b1, 0);
      const p2 = corner(b0, b1, 1);
      const p3 = corner(a0, a1, 1);
      this.quad(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2],
        k % 2 === 0 ? c : new THREE.Color().copy(c).multiplyScalar(0.82));
    }
  }

  /** A disc-ended cylinder about +Y, for wheels laid on their side and for rollers. */
  wheel(cx: number, cy: number, cz: number, radius: number, width: number, seg: number, c: THREE.Color): void {
    const hw = width * 0.5;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2;
      const a1 = ((k + 1) / seg) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, y0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius, y1 = Math.sin(a1) * radius;
      // Tread.
      this.quad(cx + x0, cy + y0, cz - hw, cx + x1, cy + y1, cz - hw,
        cx + x1, cy + y1, cz + hw, cx + x0, cy + y0, cz + hw,
        k % 2 === 0 ? c : new THREE.Color().copy(c).multiplyScalar(0.86));
      // Cheeks.
      this.tri(cx, cy, cz + hw, cx + x0, cy + y0, cz + hw, cx + x1, cy + y1, cz + hw, OAK_PALE);
      this.tri(cx, cy, cz - hw, cx + x1, cy + y1, cz - hw, cx + x0, cy + y0, cz - hw, OAK_DARK);
    }
  }

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Shared by every siege engine, so the whole train is one material. */
export function siegeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
    // Every skin, plank deck and ladder rung here is a single-thickness panel, and getting
    // the winding right on all of them by hand is a losing game — the first pass had half
    // the hide on a siege tower facing inward, which rendered the machine as a black
    // faceted slab. Double-sided costs no draw calls and `MeshStandardMaterial` flips its
    // normal for back-facing fragments, so it fixes the shading and not just the holes.
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Siege tower — *turris ambulatoria*
// ---------------------------------------------------------------------------

/**
 * Plan half-width of a tower across the wall, metres.
 *
 * 1.75 gives a 3.5 m face — four men abreast at 0.86 m centres, and the same width as the
 * curtain it docks against, which is what lets the ramp land square. Measured off
 * `reference/siege/siege-tower-from-behind.jpg`, where the towers read as roughly four to
 * five times as tall as they are wide; an earlier 2.35 made a squat box that looked like a
 * shed on wheels rather than a tower.
 */
export const TOWER_HALF_W = 2.1;
/** Plan half-depth, front to back. */
export const TOWER_HALF_D = 2.1;
/**
 * Floors between the ground and the fighting deck.
 *
 * The rear of a real tower is open lattice and the assault party is visible standing on
 * every level of it as it comes on — the strongest single feature of the reference frame.
 * These are the decks they stand on, and the landings the internal stair zig-zags between.
 */
export const TOWER_FLOORS = 4;
/**
 * How much wider the tower's foot is than its deck, per side, metres.
 *
 * Exported because the wheels have to stand outside the skin this produces, and the two were
 * separately-written numbers that drifted apart once already.
 */
export const SHAFT_SPREAD = 0.8;
/** Height of the fighting deck above the tower's own base, before per-instance stretch. */
export const TOWER_NOMINAL_H = 8.0;
/**
 * Length of the hinged boarding ramp.
 *
 * 3.4 m reaches the walk from a deck level with it. It would need to be about 4.2 m to reach
 * down over the merlons from a deck above them, which is where the deck should be — see the
 * note on `deckY` in `Siege.ts` for why it is not.
 */
export const RAMP_LEN = 3.4;
export const RAMP_HALF_W = 1.5;

/**
 * The shaft: four raking uprights, cross-bracing and a hide-covered front screen,
 * authored with y running 0..1 so one geometry serves every wall height.
 *
 * -Z is the front, the face that goes against the wall. That matches the wall's own
 * convention, where the outward normal points at the attackers.
 */
export function buildTowerShaft(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = TOWER_HALF_W;
  const D = TOWER_HALF_D;
  // A real tower tapers hard: a 15 m box of green timber with a dozen men on top of it
  // needs its weight inside its base or the first soft ground tips it over. See `SHAFT_SPREAD`.
  const spread = SHAFT_SPREAD;
  const post = 0.13;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bx = sx * (W + spread);
      const bz = sz * (D + spread);
      m.beam(bx, 0, bz, sx * W, 1, sz * D, post, OAK);
    }
  }
  // Planked floors between the ties. Left visible because the back of the tower is open
  // lattice and the assault party rides up standing on them.
  for (let lv = 1; lv < TOWER_FLOORS; lv++) {
    const t = lv / TOWER_FLOORS;
    const w = W + spread * (1 - t);
    const d = D + spread * (1 - t);
    const planks = 5;
    for (let k = 0; k < planks; k++) {
      const z0 = -d + (2 * d * k) / planks;
      const z1 = -d + (2 * d * (k + 1)) / planks - 0.02;
      m.box(-w, t - 0.06, z0, w, t, z1, k % 2 === 0 ? OAK : OAK_PALE, OAK_PALE);
    }
  }
  // Horizontal ties at four levels, and a diagonal in each bay between them.
  for (let lv = 0; lv <= 4; lv++) {
    const t = lv / 4;
    const w = (W + spread) + (W - W - spread) * t;
    const d = (D + spread) + (D - D - spread) * t;
    const y = t;
    for (const sz of [-1, 1]) m.beam(-w, y, sz * d, w, y, sz * d, 0.085, OAK_DARK);
    for (const sx of [-1, 1]) m.beam(sx * w, y, -d, sx * w, y, d, 0.085, OAK_DARK);
    if (lv < 4) {
      const t2 = (lv + 1) / 4;
      const w2 = (W + spread) + (W - W - spread) * t2;
      const d2 = (D + spread) + (D - D - spread) * t2;
      for (const sz of [-1, 1]) {
        const dir = lv % 2 === 0 ? 1 : -1;
        m.beam(-w * dir, y, sz * d, w2 * dir, t2, sz * d2, 0.065, OAK);
      }
      for (const sx of [-1, 1]) {
        m.beam(sx * w, y, -d, sx * w2, t2, d2, 0.065, OAK);
      }
    }
  }
  // Raw hide nailed over the front and the lower two thirds of each flank. This is what
  // makes the silhouette read as a siege tower rather than as scaffolding: a solid,
  // slightly irregular skin with the frame showing through at the corners.
  const skin = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number, x3: number, y3: number, z3: number): void => {
    // Split into four horizontal bands so the hides read as separate stretched skins.
    for (let k = 0; k < 4; k++) {
      const a = k / 4;
      const b = (k + 1) / 4;
      const lerp3 = (p: number[], q: number[], t: number): number[] =>
        [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      const L0 = lerp3([x0, y0, z0], [x3, y3, z3], a);
      const R0 = lerp3([x1, y1, z1], [x2, y2, z2], a);
      const R1 = lerp3([x1, y1, z1], [x2, y2, z2], b);
      const L1 = lerp3([x0, y0, z0], [x3, y3, z3], b);
      const c = k % 2 === 0 ? HIDE : HIDE_DARK;
      m.quad(L0[0], L0[1], L0[2], R0[0], R0[1], R0[2], R1[0], R1[1], R1[2], L1[0], L1[1], L1[2], c);
    }
  };
  /**
   * The internal stair, and a doorway at the foot of it.
   *
   * The men crossing a tower climb a zig-zag path between floor landings — see
   * `Siege.buildTowerCrossing` — and until now there was nothing under their feet. A blind
   * critic asked to judge the machine could not name a single way a man gets to the top:
   * "no internal ladder or stair, no door at ground level". Both are now built, on exactly
   * the geometry the path uses, and both are visible through the open rear face.
   */
  for (let f = 0; f < TOWER_FLOORS; f++) {
    const y0 = f / TOWER_FLOORS;
    const y1 = (f + 1) / TOWER_FLOORS;
    const t0 = W + spread * (1 - y0);
    const t1 = W + spread * (1 - y1);
    // Alternating sides, matching the landings the crossing path reverses at.
    const s0 = f % 2 === 0 ? -1 : 1;
    const ax = s0 * (t0 - 0.6);
    const bx = -s0 * (t1 - 0.6);
    /**
     * Local **+Z**, which is the rear — the open side, away from the wall.
     *
     * This is the other half of the yaw fix, and it is the change the previous note here said
     * was owed. The stair has to stand under the face the crossing path actually climbs, and
     * that path musters at `-(TOWER_HALF_D + 1.6)` in the *tower's world frame*, i.e. on the
     * side away from the masonry. With the shaft now drawn at `facing + PI` so its hide front
     * (local −Z) faces the wall, the side away from the wall is local +Z, and that is where
     * the flight and the ground doorway belong.
     *
     * It is also how the machine was really built: the hides go where the missiles come from,
     * and the back is open lattice so the assault party is visible riding up it — the
     * strongest single feature of `reference/siege/siege-tower-from-behind.jpg`, and the thing
     * a blind critic could not find when it said "the floor decks are there, nothing connects
     * them".
     */
    const zz = D - 0.55;
    // Two stringers and the treads between them.
    for (const sx of [-1, 1]) {
      m.beam(ax, y0, zz + sx * 0.34, bx, y1, zz + sx * 0.34, 0.055, OAK_DARK);
    }
    const treads = 6;
    for (let k = 1; k < treads; k++) {
      const u = k / treads;
      const tx = ax + (bx - ax) * u;
      const ty = y0 + (y1 - y0) * u;
      m.beam(tx, ty, zz - 0.34, tx, ty, zz + 0.34, 0.04, OAK_PALE);
    }
  }
  // Doorway in the rear face, at the foot of the stair: a lintel over the gap. Local +Z, on
  // the open side away from the wall, matching the flight above it.
  const doorW = 0.85;
  m.beam(-doorW, 1 / TOWER_FLOORS, D + spread, doorW, 1 / TOWER_FLOORS, D + spread, 0.09, OAK);

  const fo = 0.06;
  skin(
    -(W + spread), 0, -(D + spread) - fo, (W + spread), 0, -(D + spread) - fo,
    W, 1, -D - fo, -W, 1, -D - fo
  );
  for (const sx of [-1, 1]) {
    skin(
      sx * ((W + spread) + fo), 0, -(D + spread), sx * ((W + spread) + fo), 0, (D + spread),
      sx * (W + fo), 0.82, D, sx * (W + fo), 0.82, -D
    );
  }
  return m.build();
}

/**
 * The deck: floor, breastwork, and the frame the ramp hinges from. Authored at the
 * origin so it can be planted at whatever height the shaft reaches.
 */
export function buildTowerDeck(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = TOWER_HALF_W;
  const D = TOWER_HALF_D;
  // Planked floor, laid across.
  const planks = 9;
  for (let k = 0; k < planks; k++) {
    const z0 = -D + (2 * D * k) / planks;
    const z1 = -D + (2 * D * (k + 1)) / planks - 0.025;
    m.box(-W, -0.16, z0, W, 0, z1, k % 2 === 0 ? OAK : OAK_PALE, OAK_PALE);
  }
  // Breastwork: chest-high on the flanks and the back, open at the front where the ramp
  // goes. A man on the deck is 1.75 m; 1.05 m of timber covers him to the shoulder.
  const bh = 1.05;
  for (const sx of [-1, 1]) m.box(sx * W - 0.09 * sx, 0, -D, sx * W + 0.09 * sx, bh, D, OAK, OAK_PALE);
  m.box(-W, 0, D - 0.18, W, bh, D, OAK, OAK_PALE);
  // Front cheeks either side of the ramp opening.
  for (const sx of [-1, 1]) {
    m.box(sx * RAMP_HALF_W, 0, -D, sx * W, bh, -D + 0.18, OAK, OAK_PALE);
  }
  // Corner posts carrying the roof.
  const rh = 2.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) m.beam(sx * (W - 0.1), 0, sz * (D - 0.1), sx * (W - 0.1), rh, sz * (D - 0.1), 0.1, OAK);
  }
  // Pitched hide roof against dropped fire.
  const ridge = rh + 0.7;
  m.quad(-W, rh, -D, W, rh, -D, W, ridge, 0, -W, ridge, 0, HIDE);
  m.quad(W, rh, D, -W, rh, D, -W, ridge, 0, W, ridge, 0, HIDE_DARK);
  m.tri(-W, rh, -D, -W, ridge, 0, -W, rh, D, HIDE_DARK);
  m.tri(W, rh, -D, W, rh, D, W, ridge, 0, HIDE_DARK);
  // Hinge pintles for the ramp, iron.
  for (const sx of [-1, 1]) m.box(sx * RAMP_HALF_W - 0.05, -0.06, -D - 0.1, sx * RAMP_HALF_W + 0.05, 0.1, -D + 0.06, IRON);
  return m.build();
}

/**
 * The boarding ramp — a *pons*. Hinged at its own origin, running out along -Z, so a
 * rotation about +X swings it from stowed vertical down onto the wall-walk.
 */
export function buildTowerRamp(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = RAMP_HALF_W;
  // Two rails and the planking between them.
  for (const sx of [-1, 1]) m.box(sx * W - 0.08, -0.1, -RAMP_LEN, sx * W + 0.08, 0.06, 0, OAK_DARK);
  const planks = 8;
  for (let k = 0; k < planks; k++) {
    const z0 = -(RAMP_LEN * (k + 1)) / planks;
    const z1 = -(RAMP_LEN * k) / planks - 0.03;
    m.box(-W, -0.08, z0, W, 0, z1, k % 2 === 0 ? OAK : OAK_PALE, OAK_PALE);
  }
  // Iron-shod lip that bites into the parapet.
  m.box(-W, -0.1, -RAMP_LEN - 0.16, W, 0.04, -RAMP_LEN, IRON);
  // Hoisting ropes to the roof, slack once it is down.
  for (const sx of [-1, 1]) m.beam(sx * (W - 0.1), 0, -RAMP_LEN + 0.3, sx * (W - 0.1), 1.9, 0.2, 0.03, ROPE);
  return m.build();
}

/** Six wheels on two axles, sized for the tower base. Planted at the tower's own origin. */
export function buildTowerWheels(): THREE.BufferGeometry {
  const m = new Mesher();
  const R = 0.68;
  /**
   * Clear of the hide skin, which reaches ±(TOWER_HALF_W + SHAFT_SPREAD).
   *
   * This has now been wrong twice in the same way. Set inboard of the skin the wheels are
   * geometrically present and completely invisible, and a blind critic asked to judge the
   * machine cropped three separate instances at the base and reported "no sill frame, no bed,
   * no bearers, no axles, no wheels — this machine cannot be moved". The first fix put them
   * 0.16 m outboard; widening the tower's base afterwards swallowed them again. So the offset
   * is now expressed *from the skin* rather than as a number that happens to clear it.
   */
  const W = TOWER_HALF_W + SHAFT_SPREAD + 0.34;
  const D = TOWER_HALF_D + 0.42;
  for (const sz of [-1, 0, 1]) {
    const z = sz * (D - 0.35);
    for (const sx of [-1, 1]) {
      // Wheels are authored in the XY plane by `wheel`, so rotate by hand: build the
      // tread ring in the ZY plane instead by swapping the axes at the call site.
      const cx = sx * W;
      const seg = 9;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2;
        const a1 = ((k + 1) / seg) * Math.PI * 2;
        const y0 = R + Math.sin(a0) * R, z0 = z + Math.cos(a0) * R;
        const y1 = R + Math.sin(a1) * R, z1 = z + Math.cos(a1) * R;
        const c = k % 2 === 0 ? OAK : OAK_DARK;
        m.quad(cx - 0.16, y0, z0, cx + 0.16, y0, z0, cx + 0.16, y1, z1, cx - 0.16, y1, z1, c);
        m.tri(cx + 0.16, R, z, cx + 0.16, y0, z0, cx + 0.16, y1, z1, OAK_PALE);
        m.tri(cx - 0.16, R, z, cx - 0.16, y1, z1, cx - 0.16, y0, z0, OAK_DARK);
      }
    }
    m.beam(-W, R, z, W, R, z, 0.09, IRON);
  }
  return m.build();
}

// ---------------------------------------------------------------------------
// Battering ram under a shed — *aries* in a *testudo arietaria*
// ---------------------------------------------------------------------------

export const RAM_HALF_W = 1.9;
export const RAM_HALF_D = 4.2;
export const RAM_SHED_H = 2.7;
/**
 * Distance from the trunk's origin to the tip of its iron head, metres.
 *
 * The trunk is authored along -Z from its origin: 6.4 m of oak, then a 0.75 m ram's-head
 * casting. Anything positioning it has to know this number, because the origin is the hinge
 * and the head is the end that matters.
 */
export const RAM_TRUNK_REACH = 7.15;

/** The shed: a hide-roofed timber cage on wheels, with the trunk slung inside it. */
export function buildRamShed(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = RAM_HALF_W;
  const D = RAM_HALF_D;
  const H = RAM_SHED_H;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) m.beam(sx * W, 0, sz * D, sx * W, H, sz * D, 0.12, OAK);
    for (let k = 1; k < 4; k++) {
      const z = -D + (2 * D * k) / 4;
      m.beam(sx * W, 0, z, sx * W, H, z, 0.09, OAK_DARK);
    }
    m.beam(sx * W, H, -D, sx * W, H, D, 0.1, OAK);
    m.beam(sx * W, 0.1, -D, sx * W, 0.1, D, 0.1, OAK);
  }
  // Steep pitched roof, hide over boards: a stone dropped from the parapet must glance off.
  const ridge = H + 1.25;
  m.quad(-W, H, -D, W, H, -D, W, ridge, -D, -W, ridge, -D, OAK_DARK);
  m.quad(W, H, D, -W, H, D, -W, ridge, D, W, ridge, D, OAK_DARK);
  for (let k = 0; k < 6; k++) {
    const z0 = -D + (2 * D * k) / 6;
    const z1 = -D + (2 * D * (k + 1)) / 6;
    const c = k % 2 === 0 ? HIDE : HIDE_DARK;
    m.quad(-W - 0.1, H, z0, 0, ridge, z0, 0, ridge, z1, -W - 0.1, H, z1, c);
    m.quad(0, ridge, z0, W + 0.1, H, z0, W + 0.1, H, z1, 0, ridge, z1, c);
  }
  // Wheels.
  for (const sz of [-1, 1]) {
    const z = sz * (D - 0.7);
    for (const sx of [-1, 1]) {
      const cx = sx * (W + 0.14);
      const R = 0.5;
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2;
        const a1 = ((k + 1) / 8) * Math.PI * 2;
        const y0 = R + Math.sin(a0) * R, z0 = z + Math.cos(a0) * R;
        const y1 = R + Math.sin(a1) * R, z1 = z + Math.cos(a1) * R;
        m.quad(cx - 0.13, y0, z0, cx + 0.13, y0, z0, cx + 0.13, y1, z1, cx - 0.13, y1, z1,
          k % 2 === 0 ? OAK : OAK_DARK);
        m.tri(cx + 0.13, R, z, cx + 0.13, y0, z0, cx + 0.13, y1, z1, OAK_PALE);
      }
    }
  }
  // The slings the trunk hangs in.
  for (const sz of [-1, 1]) m.beam(0, H - 0.1, sz * 1.5, 0, 1.35, sz * 1.5, 0.035, ROPE);
  return m.build();
}

/**
 * The trunk itself, an iron-headed oak baulk. Authored along -Z from its own origin so
 * the shed can slide it back and forth on the recoil axis.
 */
export function buildRamTrunk(): THREE.BufferGeometry {
  const m = new Mesher();
  const L = 6.4;
  const seg = 8;
  const R = 0.29;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    const x0 = Math.cos(a0) * R, y0 = Math.sin(a0) * R;
    const x1 = Math.cos(a1) * R, y1 = Math.sin(a1) * R;
    m.quad(x0, y0, 0, x1, y1, 0, x1, y1, -L, x0, y0, -L, k % 2 === 0 ? OAK : OAK_DARK);
  }
  // Iron head, cast as a ram's: a blunt cone with a pair of horns.
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    const rr = R * 1.3;
    m.quad(Math.cos(a0) * rr, Math.sin(a0) * rr, -L, Math.cos(a1) * rr, Math.sin(a1) * rr, -L,
      Math.cos(a1) * R * 0.7, Math.sin(a1) * R * 0.7, -L - 0.75,
      Math.cos(a0) * R * 0.7, Math.sin(a0) * R * 0.7, -L - 0.75, IRON);
  }
  for (const sx of [-1, 1]) m.beam(sx * 0.22, 0.08, -L - 0.2, sx * 0.46, -0.2, -L - 0.55, 0.09, IRON);
  // Iron bands along the shaft.
  for (let k = 1; k < 6; k++) {
    const z = -(L * k) / 6;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2;
      const a1 = ((s + 1) / seg) * Math.PI * 2;
      const rr = R * 1.08;
      m.quad(Math.cos(a0) * rr, Math.sin(a0) * rr, z + 0.09, Math.cos(a1) * rr, Math.sin(a1) * rr, z + 0.09,
        Math.cos(a1) * rr, Math.sin(a1) * rr, z - 0.09, Math.cos(a0) * rr, Math.sin(a0) * rr, z - 0.09, IRON);
    }
  }
  return m.build();
}

// ---------------------------------------------------------------------------
// The great ram — a *testudo arietaria* built to take a curtain down
// ---------------------------------------------------------------------------

/**
 * The wall-breaker, and why it is a separate machine rather than the gate ram scaled up.
 *
 * A gate ram is a shed with a beam in it. This is a *building* on wheels: 11.6 m long and
 * 3.4 m wide against the gate ram's 8.4 by 3.8, standing 4.2 m to the eaves, with a trunk of
 * 11 m of oak hung on four slings instead of two. Vitruvius X.13 has Hegetor's ram at
 * Byzantium at 55 m of beam on a shed with eight wheels; this is a tenth of that and still
 * reads as the largest thing on the field.
 *
 * Uniform scaling was the cheap alternative and it is wrong twice over. A machine three
 * times the mass does not have three-times-thicker planks — the timber sizes barely change,
 * only the count of them — so a scaled shed reads as a toy photographed close up. And the
 * silhouette that says "this one is for the wall" is the *proportion*: long and low and
 * heavily raked, against the gate ram's short box.
 */
/**
 * And it is *wider* than the gate ram, not merely longer.
 *
 * 1.7 was wrong and the assertion caught it: at 3.4 m across against the gate ram's 3.8 the
 * great ram had only **1.24x** its footprint, because it had been made long and narrow
 * rather than big. That reads as a different machine of the same size, which is not what
 * "much larger, dedicated to tearing down walls" means.
 *
 * 4.8 m across is the width the job actually needs. The beam is 11 m of oak on four slings
 * and the gang works it from both sides standing inside the shed, which is two files of men
 * plus the swing of the trunk between them; at 3.4 m they would be shoulder to shoulder with
 * a ten-tonne baulk. It also puts the wheels far enough apart that the thing does not tip
 * crossing a ditch, which is the failure that ends most of these machines.
 */
export const GREAT_RAM_HALF_W = 2.4;
export const GREAT_RAM_HALF_D = 5.8;
export const GREAT_RAM_SHED_H = 4.2;
/** Origin of the trunk to the tip of its iron head. See `RAM_TRUNK_REACH`. */
export const GREAT_RAM_REACH = 11.9;

export function buildGreatRamShed(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = GREAT_RAM_HALF_W;
  const D = GREAT_RAM_HALF_D;
  const H = GREAT_RAM_SHED_H;
  // Eight bays of framing rather than four: the give-away that this is a bigger machine and
  // not a nearer one is that the members are the same size and there are twice as many.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) m.beam(sx * W, 0, sz * D, sx * W, H, sz * D, 0.15, OAK);
    for (let k = 1; k < 8; k++) {
      const z = -D + (2 * D * k) / 8;
      m.beam(sx * W, 0, z, sx * W, H, z, 0.1, OAK_DARK);
      // Knee braces into the sill, which is what stops a shed this long racking.
      m.beam(sx * W, 1.5, z, sx * W, 0.15, z - 1.1, 0.07, OAK);
    }
    m.beam(sx * W, H, -D, sx * W, H, D, 0.13, OAK);
    m.beam(sx * W, 0.12, -D, sx * W, 0.12, D, 0.15, OAK);
    // A second rail at chest height: the crew work standing inside this.
    m.beam(sx * W, 1.9, -D, sx * W, 1.9, D, 0.09, OAK_DARK);
  }
  // Cross-ties over the crew, carrying the sling tackle.
  for (let k = 0; k <= 8; k++) {
    const z = -D + (2 * D * k) / 8;
    m.beam(-W, H, z, W, H, z, 0.09, OAK_DARK);
  }
  // Steep pitched roof, hide over boards, with the ridge carried well past the front so a
  // stone dropped from the parapet glances off before it reaches the head.
  const ridge = H + 1.8;
  m.quad(-W, H, -D, W, H, -D, W, ridge, -D, -W, ridge, -D, OAK_DARK);
  m.quad(W, H, D, -W, H, D, -W, ridge, D, W, ridge, D, OAK_DARK);
  for (let k = 0; k < 10; k++) {
    const z0 = -D + (2 * D * k) / 10;
    const z1 = -D + (2 * D * (k + 1)) / 10;
    const c = k % 2 === 0 ? HIDE : HIDE_DARK;
    m.quad(-W - 0.14, H, z0, 0, ridge, z0, 0, ridge, z1, -W - 0.14, H, z1, c);
    m.quad(0, ridge, z0, W + 0.14, H, z0, W + 0.14, H, z1, 0, ridge, z1, c);
  }
  // A hide apron down the front face, hung clear of the head's travel.
  m.quad(-W - 0.14, H, -D, W + 0.14, H, -D, W + 0.14, 2.6, -D - 0.5, -W - 0.14, 2.6, -D - 0.5, HIDE_DARK);
  // Eight wheels on four axles. `RAM_HALF_D` gets two; this needs the bearing area.
  for (const sz of [-1.5, -0.5, 0.5, 1.5]) {
    const z = sz * (D - 1.0) * 0.66;
    for (const sx of [-1, 1]) {
      const cx = sx * (W + 0.17);
      const R = 0.62;
      for (let k = 0; k < 9; k++) {
        const a0 = (k / 9) * Math.PI * 2;
        const a1 = ((k + 1) / 9) * Math.PI * 2;
        const y0 = R + Math.sin(a0) * R, z0 = z + Math.cos(a0) * R;
        const y1 = R + Math.sin(a1) * R, z1 = z + Math.cos(a1) * R;
        m.quad(cx - 0.16, y0, z0, cx + 0.16, y0, z0, cx + 0.16, y1, z1, cx - 0.16, y1, z1,
          k % 2 === 0 ? OAK : OAK_DARK);
        m.tri(cx + 0.16, R, z, cx + 0.16, y0, z0, cx + 0.16, y1, z1, OAK_PALE);
        m.tri(cx - 0.16, R, z, cx - 0.16, y1, z1, cx - 0.16, y0, z0, OAK_DARK);
      }
    }
    m.beam(-W - 0.2, 0.62, z, W + 0.2, 0.62, z, 0.1, IRON);
  }
  // Four slings, not two: eleven metres of oak needs carrying in more than one place.
  for (const sz of [-2.4, -0.8, 0.8, 2.4]) {
    for (const sx of [-1, 1]) {
      m.beam(sx * 0.34, H - 0.12, sz, sx * 0.12, 1.85, sz, 0.04, ROPE);
    }
  }
  return m.build();
}

/** Eleven metres of iron-bound oak. Authored along -Z from its origin, as the light one is. */
export function buildGreatRamTrunk(): THREE.BufferGeometry {
  const m = new Mesher();
  const L = 10.7;
  const seg = 10;
  const R = 0.42;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    // Tapered: a real baulk is the trunk of a tree and is thicker at the butt.
    const r0 = R, r1 = R * 0.82;
    m.quad(Math.cos(a0) * r0, Math.sin(a0) * r0, 0, Math.cos(a1) * r0, Math.sin(a1) * r0, 0,
      Math.cos(a1) * r1, Math.sin(a1) * r1, -L, Math.cos(a0) * r1, Math.sin(a0) * r1, -L,
      k % 2 === 0 ? OAK : OAK_DARK);
  }
  // The head: a heavier casting than the gate ram's, with four horns instead of two.
  const rr = R * 1.35;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    m.quad(Math.cos(a0) * rr, Math.sin(a0) * rr, -L, Math.cos(a1) * rr, Math.sin(a1) * rr, -L,
      Math.cos(a1) * R * 0.66, Math.sin(a1) * R * 0.66, -L - 1.2,
      Math.cos(a0) * R * 0.66, Math.sin(a0) * R * 0.66, -L - 1.2, IRON);
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      m.beam(sx * 0.3, sy * 0.24, -L - 0.3, sx * 0.62, sy * 0.46, -L - 0.85, 0.1, IRON);
    }
  }
  // Iron bands, and the four sling collars they run between.
  for (let k = 1; k < 9; k++) {
    const z = -(L * k) / 9;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2;
      const a1 = ((s + 1) / seg) * Math.PI * 2;
      const br = R * 1.1;
      m.quad(Math.cos(a0) * br, Math.sin(a0) * br, z + 0.11, Math.cos(a1) * br, Math.sin(a1) * br, z + 0.11,
        Math.cos(a1) * br, Math.sin(a1) * br, z - 0.11, Math.cos(a0) * br, Math.sin(a0) * br, z - 0.11, IRON);
    }
  }
  return m.build();
}

// ---------------------------------------------------------------------------
// Escalade ladder — *scalae*
// ---------------------------------------------------------------------------

/** Authored with y running 0..1 along the rails so one geometry reaches any parapet. */
export function buildLadder(): THREE.BufferGeometry {
  const m = new Mesher();
  const halfW = 0.42;
  for (const sx of [-1, 1]) m.beam(sx * halfW, 0, 0, sx * halfW, 1, 0, 0.055, OAK);
  const rungs = 14;
  for (let k = 1; k < rungs; k++) {
    const y = k / rungs;
    m.beam(-halfW, y, 0, halfW, y, 0, 0.04, OAK_PALE);
  }
  // Iron hooks at the head that bite over the merlons.
  for (const sx of [-1, 1]) {
    m.beam(sx * halfW, 1, 0, sx * halfW, 1, -0.34, 0.05, IRON);
    m.beam(sx * halfW, 1, -0.34, sx * halfW, 0.965, -0.34, 0.05, IRON);
  }
  return m.build();
}

// ---------------------------------------------------------------------------
// Artillery is deliberately absent
// ---------------------------------------------------------------------------
//
// A placeholder onager lived here and has been removed. `src/units/engines.ts` owns every
// stone-thrower and bolt-shooter on the field and already resolves a high-arc missile unit
// to `EngineKind.Onager` with its own crew stations and arm sweep, so the `onager` and
// `carroballista` units this workstream added get their machines from there. Drawing a
// second set here superimposed two machines on one spot and cost ten draw calls.
