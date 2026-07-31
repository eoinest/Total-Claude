import * as THREE from 'three';

/**
 * Geometry for the siege train.
 *
 * Every machine here is built once, at unit scale where it makes sense, and drawn with
 * `InstancedMesh` — four towers, three onagers and a ram together cost nine draw calls
 * whatever their number, which is the only way they fit inside the 220-call budget next
 * to a city and nine thousand men.
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
 * **Onager and ballista geometry here is a placeholder.** A parallel workstream is
 * building properly researched artillery in `src/units/engines.ts`; these exist so the
 * siege systems can be tested and shot end to end, and should be replaced by that work.
 */

// Timber, weathered oak. Everything on a siege engine is this or darker.
const OAK = new THREE.Color(0.30, 0.215, 0.135);
const OAK_DARK = new THREE.Color(0.185, 0.13, 0.082);
const OAK_PALE = new THREE.Color(0.42, 0.325, 0.215);
/** Green ox-hide nailed over the face, soaked against fire. Rome II reads this as grey-brown. */
const HIDE = new THREE.Color(0.355, 0.315, 0.265);
const HIDE_DARK = new THREE.Color(0.20, 0.175, 0.148);
const IRON = new THREE.Color(0.175, 0.178, 0.186);
const ROPE = new THREE.Color(0.46, 0.40, 0.27);

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
export const TOWER_HALF_W = 1.75;
/** Plan half-depth, front to back. */
export const TOWER_HALF_D = 2.0;
/**
 * Floors between the ground and the fighting deck.
 *
 * The rear of a real tower is open lattice and the assault party is visible standing on
 * every level of it as it comes on — the strongest single feature of the reference frame.
 * These are the decks they stand on, and the landings the internal stair zig-zags between.
 */
export const TOWER_FLOORS = 4;
/** Height of the fighting deck above the tower's own base, before per-instance stretch. */
export const TOWER_NOMINAL_H = 8.0;
/** Length of the hinged boarding ramp. */
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
  // needs its weight inside its base or the first soft ground tips it over. The reference
  // towers are about 1.35 times wider at the foot than at the deck.
  const spread = 0.62;
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
  const R = 0.62;
  const W = TOWER_HALF_W + 0.42;
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
// Onager — PLACEHOLDER, see the file header
// ---------------------------------------------------------------------------

/**
 * A one-armed torsion stone-thrower on a timber bed.
 *
 * **Placeholder.** Correct in mass, proportion and silhouette so that the siege
 * simulation can be tested and graded, but it is not the researched machine the
 * artillery workstream is building in `src/units/engines.ts`, and should be replaced by
 * that geometry when it lands. The arm is a separate part so it can be wound and released.
 */
export function buildOnagerBed(): THREE.BufferGeometry {
  const m = new Mesher();
  const W = 0.85;
  const D = 2.3;
  // Two heavy side rails on cross-timbers.
  for (const sx of [-1, 1]) m.box(sx * W - 0.14, 0.28, -D, sx * W + 0.14, 0.62, D, OAK, OAK_PALE);
  for (const sz of [-1, 1]) m.box(-W - 0.2, 0.1, sz * (D - 0.4) - 0.16, W + 0.2, 0.4, sz * (D - 0.4) + 0.16, OAK_DARK);
  // The torsion bundle: a thick rope skein between the rails, and its washers.
  for (let k = 0; k < 7; k++) {
    const z = 0.55 + (k - 3) * 0.055;
    m.box(-W + 0.14, 0.55, z - 0.024, W - 0.14, 1.02, z + 0.024, ROPE);
  }
  for (const sx of [-1, 1]) m.box(sx * W - 0.16, 0.5, 0.32, sx * W + 0.16, 1.07, 0.78, IRON);
  // The padded stop the arm slams into — the thing that actually throws the stone.
  m.box(-W, 1.1, -1.5, W, 1.55, -1.16, OAK_DARK, HIDE);
  for (const sx of [-1, 1]) m.beam(sx * W, 0.62, -1.34, sx * W, 1.5, -0.2, 0.09, OAK);
  // Windlass at the tail.
  m.beam(-W - 0.24, 0.9, D - 0.3, W + 0.24, 0.9, D - 0.3, 0.11, OAK);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    m.beam(sx * (W + 0.2), 0.9, D - 0.3, sx * (W + 0.2) + sx * 0.4, 0.9, D - 0.3 + sz * 0.4, 0.035, OAK_PALE);
  }
  return m.build();
}

/** The throwing arm and its sling, hinged at the origin, at rest pointing back and up. */
export function buildOnagerArm(): THREE.BufferGeometry {
  const m = new Mesher();
  const L = 2.75;
  m.beam(0, 0, 0, 0, L, 0, 0.11, OAK);
  m.box(-0.2, L - 0.1, -0.16, 0.2, L + 0.24, 0.16, OAK_DARK);
  // The sling and its pouch, hanging off the head.
  for (const sx of [-1, 1]) m.beam(sx * 0.16, L + 0.1, 0, sx * 0.26, L - 0.72, 0.34, 0.028, ROPE);
  m.box(-0.26, L - 0.94, 0.18, 0.26, L - 0.72, 0.5, HIDE_DARK);
  // The stone in the pouch.
  const R = 0.22;
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2;
    const a1 = ((k + 1) / 6) * Math.PI * 2;
    m.tri(0, L - 0.83, 0.34 + R,
      Math.cos(a0) * R, L - 0.83 + Math.sin(a0) * R, 0.34,
      Math.cos(a1) * R, L - 0.83 + Math.sin(a1) * R, 0.34, new THREE.Color(0.44, 0.42, 0.38));
    m.tri(0, L - 0.83, 0.34 - R,
      Math.cos(a1) * R, L - 0.83 + Math.sin(a1) * R, 0.34,
      Math.cos(a0) * R, L - 0.83 + Math.sin(a0) * R, 0.34, new THREE.Color(0.34, 0.32, 0.29));
  }
  return m.build();
}
