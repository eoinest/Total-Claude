import * as THREE from 'three';
import { hash2 } from '../util/rand';
import type { CityMatKey, CityMaterials } from './materials';

/**
 * Geometry accumulation for the city.
 *
 * Everything in Rome is authored into `GeoStream`s — one per material per spatial
 * chunk — and baked into a single `BufferGeometry` at the end. That is what keeps the
 * whole city inside a hundred draw calls: a district of two hundred insulae becomes
 * two meshes (stucco walls, tiled roofs), not four hundred.
 *
 * Three conventions make the rest of the city code short:
 *
 * 1. **World-projected UVs.** A quad's `u` is the world distance along its first edge
 *    and `v` the distance along its second, divided by the material's tile size in
 *    metres. Adjacent quads therefore share a continuous texture without any UV
 *    bookkeeping, and a wall 1.6 km long tiles correctly with no seams.
 * 2. **Colour is geometry.** Albedo hue comes from the per-vertex colour, so a builder
 *    varies paint, weathering and baked ambient occlusion for free.
 * 3. **Normal hints.** Emitters pass the direction a face is *meant* to point and the
 *    stream fixes the winding. Single-sided geometry authored by hand always grows
 *    inside-out faces otherwise, and they are invisible until they are not.
 */

const V = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const E1 = new THREE.Vector3();
const E2 = new THREE.Vector3();
const NRM = new THREE.Vector3();
const HINT = new THREE.Vector3();

/** Growable interleaved vertex stream for one material. */
export class GeoStream {
  private pos: Float32Array;
  private nrm: Float32Array;
  private uvs: Float32Array;
  private col: Float32Array;
  private idx: Uint32Array;
  private vCount = 0;
  private iCount = 0;

  /** Reciprocal tile size in metres — set from the material. */
  uvScale = 1;
  /** Subtracted from world position before UV projection, to keep UVs small. */
  readonly uvOrigin = new THREE.Vector3();

  private xf = new THREE.Matrix4();
  private hasXf = false;
  private stack: { m: THREE.Matrix4; had: boolean }[] = [];
  private stackTop = 0;

  constructor(vertexCapacity = 2048) {
    this.pos = new Float32Array(vertexCapacity * 3);
    this.nrm = new Float32Array(vertexCapacity * 3);
    this.uvs = new Float32Array(vertexCapacity * 2);
    this.col = new Float32Array(vertexCapacity * 3);
    this.idx = new Uint32Array(vertexCapacity * 3);
  }

  get vertexCount(): number {
    return this.vCount;
  }
  get triangleCount(): number {
    return this.iCount / 3;
  }
  get empty(): boolean {
    return this.iCount === 0;
  }

  /** Replace the local-to-world transform. */
  setTransform(m: THREE.Matrix4 | null): void {
    if (m) {
      this.xf.copy(m);
      this.hasXf = true;
    } else {
      this.hasXf = false;
      this.xf.identity();
    }
  }

  /** Compose an extra local transform, restored by `pop()`. */
  push(m: THREE.Matrix4): void {
    let slot = this.stack[this.stackTop];
    if (!slot) {
      slot = { m: new THREE.Matrix4(), had: false };
      this.stack[this.stackTop] = slot;
    }
    slot.m.copy(this.xf);
    slot.had = this.hasXf;
    this.stackTop++;
    if (this.hasXf) this.xf.multiply(m);
    else {
      this.xf.copy(m);
      this.hasXf = true;
    }
  }

  pushTranslate(x: number, y: number, z: number): void {
    TRANS.makeTranslation(x, y, z);
    this.push(TRANS);
  }

  pop(): void {
    if (this.stackTop === 0) return;
    this.stackTop--;
    const slot = this.stack[this.stackTop];
    this.xf.copy(slot.m);
    this.hasXf = slot.had;
  }

  private growVerts(need: number): void {
    let cap = this.pos.length / 3;
    if (this.vCount + need <= cap) return;
    while (cap < this.vCount + need) cap *= 2;
    const p2 = new Float32Array(cap * 3);
    p2.set(this.pos.subarray(0, this.vCount * 3));
    this.pos = p2;
    const n = new Float32Array(cap * 3);
    n.set(this.nrm.subarray(0, this.vCount * 3));
    this.nrm = n;
    const u = new Float32Array(cap * 2);
    u.set(this.uvs.subarray(0, this.vCount * 2));
    this.uvs = u;
    const c = new Float32Array(cap * 3);
    c.set(this.col.subarray(0, this.vCount * 3));
    this.col = c;
  }

  private growIdx(need: number): void {
    let cap = this.idx.length;
    if (this.iCount + need <= cap) return;
    while (cap < this.iCount + need) cap *= 2;
    const a = new Uint32Array(cap);
    a.set(this.idx.subarray(0, this.iCount));
    this.idx = a;
  }

  /** Write `n` transformed vertices with a shared normal and projected UVs. */
  private emit(n: number, cols: (THREE.Color | undefined)[], uvMul: number, flip: boolean): void {
    const s = this.uvScale * uvMul;
    // In-plane orthonormal basis from the first two edges.
    E1.subVectors(V[1], V[0]);
    E2.subVectors(V[n - 1], V[0]);
    const ul = E1.length() || 1;
    const uax = E1.x / ul;
    const uay = E1.y / ul;
    const uaz = E1.z / ul;
    const d = E2.x * uax + E2.y * uay + E2.z * uaz;
    let vx = E2.x - uax * d;
    let vy = E2.y - uay * d;
    let vz = E2.z - uaz * d;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl;
    vy /= vl;
    vz /= vl;

    const nx = flip ? -NRM.x : NRM.x;
    const ny = flip ? -NRM.y : NRM.y;
    const nz = flip ? -NRM.z : NRM.z;

    this.growVerts(n);
    const base = this.vCount;
    for (let i = 0; i < n; i++) {
      const v = V[i];
      const c = cols[i] ?? cols[0]!;
      const o3 = (base + i) * 3;
      this.pos[o3] = v.x;
      this.pos[o3 + 1] = v.y;
      this.pos[o3 + 2] = v.z;
      this.nrm[o3] = nx;
      this.nrm[o3 + 1] = ny;
      this.nrm[o3 + 2] = nz;
      this.col[o3] = c.r;
      this.col[o3 + 1] = c.g;
      this.col[o3 + 2] = c.b;
      const rx = v.x - this.uvOrigin.x;
      const ry = v.y - this.uvOrigin.y;
      const rz = v.z - this.uvOrigin.z;
      const o2 = (base + i) * 2;
      this.uvs[o2] = (rx * uax + ry * uay + rz * uaz) * s;
      this.uvs[o2 + 1] = (rx * vx + ry * vy + rz * vz) * s;
    }
    this.vCount += n;

    const triCount = n - 2;
    this.growIdx(triCount * 3);
    let k = this.iCount;
    for (let t = 0; t < triCount; t++) {
      if (flip) {
        this.idx[k++] = base;
        this.idx[k++] = base + t + 2;
        this.idx[k++] = base + t + 1;
      } else {
        this.idx[k++] = base;
        this.idx[k++] = base + t + 1;
        this.idx[k++] = base + t + 2;
      }
    }
    this.iCount = k;
  }

  private prepare(n: number, hint: THREE.Vector3 | null): boolean {
    for (let i = 0; i < n; i++) if (this.hasXf) V[i].applyMatrix4(this.xf);
    E1.subVectors(V[1], V[0]);
    E2.subVectors(V[n - 1], V[0]);
    NRM.crossVectors(E1, E2);
    if (NRM.lengthSq() < 1e-16) return false;
    NRM.normalize();
    if (hint) {
      HINT.copy(hint);
      if (this.hasXf) HINT.transformDirection(this.xf);
      return NRM.dot(HINT) < 0 ? this.flag(true) : this.flag(false);
    }
    return this.flag(false);
  }

  private flipNext = false;
  private flag(f: boolean): boolean {
    this.flipNext = f;
    return true;
  }

  /** Quad, winding as given. `p0..p3` must be counter-clockwise from the front. */
  quad(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    c0: THREE.Color,
    c1: THREE.Color = c0,
    c2: THREE.Color = c1,
    c3: THREE.Color = c0,
    uvMul = 1
  ): void {
    V[0].copy(p0);
    V[1].copy(p1);
    V[2].copy(p2);
    V[3].copy(p3);
    if (!this.prepare(4, null)) return;
    this.emit(4, [c0, c1, c2, c3], uvMul, this.flipNext);
  }

  /** Quad whose winding is corrected so the face points along `hint`. */
  quadN(
    hint: THREE.Vector3,
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    c0: THREE.Color,
    c1: THREE.Color = c0,
    c2: THREE.Color = c1,
    c3: THREE.Color = c0,
    uvMul = 1
  ): void {
    V[0].copy(p0);
    V[1].copy(p1);
    V[2].copy(p2);
    V[3].copy(p3);
    if (!this.prepare(4, hint)) return;
    this.emit(4, [c0, c1, c2, c3], uvMul, this.flipNext);
  }

  tri(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, c0: THREE.Color, c1: THREE.Color = c0, c2: THREE.Color = c0, uvMul = 1): void {
    V[0].copy(p0);
    V[1].copy(p1);
    V[2].copy(p2);
    if (!this.prepare(3, null)) return;
    this.emit(3, [c0, c1, c2], uvMul, this.flipNext);
  }

  triN(hint: THREE.Vector3, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, c0: THREE.Color, c1: THREE.Color = c0, c2: THREE.Color = c0, uvMul = 1): void {
    V[0].copy(p0);
    V[1].copy(p1);
    V[2].copy(p2);
    if (!this.prepare(3, hint)) return;
    this.emit(3, [c0, c1, c2], uvMul, this.flipNext);
  }

  build(): THREE.BufferGeometry | null {
    if (this.iCount === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vCount * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.vCount * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs.slice(0, this.vCount * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.vCount * 3), 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.iCount), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const TRANS = new THREE.Matrix4();

/**
 * A set of streams keyed by material. Builders write into `s(key)`.
 *
 * `collapseTo` funnels every material into one stream, which is how the far LOD gets
 * a whole district — walls, roofs, paving, colonnades — into a *single* merged mesh
 * and therefore a single draw call. At a kilometre the surface texture is below a
 * pixel and only the vertex colour survives, so nothing is lost.
 */
/**
 * Trim materials folded away at mid detail.
 *
 * Because the city's colour lives in vertex attributes and not in its textures, merging
 * two materials costs only the surface *micro*-detail — the hue is untouched. Beyond a
 * few hundred metres a scaffold pole's plank grain and a gate hinge's hammer marks are
 * well under a pixel, so every one of these is a draw call bought for nothing. Folding
 * them saves four meshes per wall chunk in the main pass and the same again in every
 * shadow cascade, which is where a city goes over a 220-call budget.
 */
const TRIM_MERGE: Partial<Record<CityMatKey, CityMatKey>> = {
  metal: 'stone',
  road: 'stone',
  concrete: 'stone',
  timber: 'brick',
  // Marble veining and granite speckle are centimetre features; past the mid-detail
  // switch they are well under a pixel and only the vertex colour still reads.
  marble: 'stone',
  granite: 'stone',
};

/**
 * Materials whose geometry contributes nothing worth four shadow passes.
 *
 * `road` and `stone` paving are flat on the ground and cast onto themselves. `metal` is
 * gate fittings and ballista ironwork, centimetres across. `concrete` is the poured core,
 * which is always behind a brick face that casts the same silhouette — the one exception
 * being the exposed core at a footing site, where the brick face has not been built yet
 * and the loss is a soft edge on a 3 m stub.
 */
const NO_SHADOW: ReadonlySet<CityMatKey> = new Set<CityMatKey>(['metal', 'road', 'concrete']);

export class Batch {
  private streams = new Map<CityMatKey, GeoStream>();

  constructor(
    private readonly mats: CityMaterials,
    private readonly collapseTo?: CityMatKey,
    /** Fold the trim materials into their structural neighbours. */
    private readonly mergeTrim = false
  ) {}

  s(key: CityMatKey): GeoStream {
    const k = this.collapseTo ?? (this.mergeTrim ? (TRIM_MERGE[key] ?? key) : key);
    let st = this.streams.get(k);
    if (!st) {
      st = new GeoStream();
      st.uvScale = 1 / this.mats.worldSize(k);
      st.uvOrigin.copy(this.uvOrigin);
      this.streams.set(k, st);
    }
    return st;
  }

  /**
   * The distinct streams behind `keys`, each appearing once.
   *
   * **`s()` is not injective, and that is what produced buildings in the battlefield.**
   * `collapseTo` maps all nine material keys to one stream and `mergeTrim` maps them to
   * five, so the natural-looking
   *
   * ```ts
   * for (const k of keys) batch.s(k).push(mat);   // WRONG
   * ```
   *
   * pushes `mat` onto the *same* stream once per alias, and `GeoStream.push` composes
   * rather than replaces — so at mid detail a landmark was emitted at `mat⁴` and at far
   * detail the gate at `mat⁶`. For a Y-rotation-plus-translation the composed translation
   * is `(I + R + R² + R³)·p`, whose length collapses to **zero at a 90° rotation**: the
   * Mausoleum of Augustus, the Horologium, the Iseum and Trajan's Column all sit at
   * exactly 90° in world rotation and were therefore drawn at the world origin — in the
   * middle of the battlefield — at every camera distance beyond 560 m, vanishing again as
   * soon as the camera came close enough to swap in the correct full-detail level.
   *
   * Use `pushAll`/`popAll`, or this, and never iterate keys.
   */
  distinct(keys: readonly CityMatKey[]): GeoStream[] {
    const out: GeoStream[] = [];
    for (const key of keys) {
      const st = this.s(key);
      // Eleven keys at most, so a linear scan is cheaper than a Set.
      if (!out.includes(st)) out.push(st);
    }
    return out;
  }

  /** Push one matrix onto each distinct stream behind `keys`. Pop with `popAll`. */
  pushAll(keys: readonly CityMatKey[], m: THREE.Matrix4): GeoStream[] {
    const out = this.distinct(keys);
    for (const st of out) st.push(m);
    return out;
  }

  /** As `pushAll`, with a pure translation. */
  pushAllTranslate(keys: readonly CityMatKey[], x: number, y: number, z: number): GeoStream[] {
    TRANS.makeTranslation(x, y, z);
    return this.pushAll(keys, TRANS);
  }

  popAll(streams: readonly GeoStream[]): void {
    for (const st of streams) st.pop();
  }

  /**
   * Shift UV origin for every stream — keeps UV magnitudes small far from origin.
   *
   * Remembered, and applied to streams created later, because callers set it *before*
   * building and the streams are created lazily inside the builder. Without that, the first
   * object in a chunk got no UV origin at all and every one after it carried its
   * predecessor's.
   */
  setUvOrigin(x: number, y: number, z: number): void {
    this.uvOrigin.set(x, y, z);
    for (const st of this.streams.values()) st.uvOrigin.copy(this.uvOrigin);
  }
  private readonly uvOrigin = new THREE.Vector3();

  setTransform(m: THREE.Matrix4 | null): void {
    for (const st of this.streams.values()) st.setTransform(m);
  }

  get triangleCount(): number {
    let n = 0;
    for (const st of this.streams.values()) n += st.triangleCount;
    return n;
  }

  get isEmpty(): boolean {
    for (const st of this.streams.values()) if (!st.empty) return false;
    return true;
  }

  /** Bake into meshes, in a deterministic material order. */
  toMeshes(namePrefix: string, castShadow: boolean, receiveShadow = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const keys = [...this.streams.keys()].sort();
    for (const key of keys) {
      const g = this.streams.get(key)!.build();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this.mats.get(key));
      mesh.name = `${namePrefix}-${key}`;
      mesh.castShadow = castShadow && !NO_SHADOW.has(key);
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      out.push(mesh);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Primitives. Local coordinates; use `GeoStream.push`/`pop` to place them.
// ---------------------------------------------------------------------------

const q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const N_UP = new THREE.Vector3(0, 1, 0);
const N_DOWN = new THREE.Vector3(0, -1, 0);
const N_PX = new THREE.Vector3(1, 0, 0);
const N_NX = new THREE.Vector3(-1, 0, 0);
const N_PZ = new THREE.Vector3(0, 0, 1);
const N_NZ = new THREE.Vector3(0, 0, -1);
const NH = new THREE.Vector3();
const C_TMP = new THREE.Color();
const C_TMP2 = new THREE.Color();

export interface BoxOpts {
  top?: boolean;
  bottom?: boolean;
  xMin?: boolean;
  xMax?: boolean;
  zMin?: boolean;
  zMax?: boolean;
  /** Inward lean per metre of height, as on a battered wall footing. */
  batter?: number;
  /** Darken the bottom edge to fake contact occlusion. */
  groundShade?: number;
  uvMul?: number;
  /** Multiply the top face colour — sun-bleached horizontal surfaces. */
  topGain?: number;
}

/** Axis-aligned box, `(x0,y0,z0)` to `(x1,y1,z1)`. */
export function box(
  st: GeoStream,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  col: THREE.Color,
  o: BoxOpts = {}
): void {
  const inset = (o.batter ?? 0) * (y1 - y0);
  const ux0 = x0 + inset;
  const ux1 = x1 - inset;
  const uz0 = z0 + inset;
  const uz1 = z1 - inset;
  const shade = o.groundShade ?? 0;
  const cLow = shade > 0 ? C_TMP.copy(col).multiplyScalar(1 - shade).clone() : col;
  const cTop = o.topGain ? C_TMP2.copy(col).multiplyScalar(o.topGain).clone() : col;
  const uvMul = o.uvMul ?? 1;

  if (o.zMin !== false) {
    q[0].set(x0, y0, z0);
    q[1].set(x1, y0, z0);
    q[2].set(ux1, y1, uz0);
    q[3].set(ux0, y1, uz0);
    st.quadN(N_NZ, q[0], q[1], q[2], q[3], cLow, cLow, col, col, uvMul);
  }
  if (o.zMax !== false) {
    q[0].set(x0, y0, z1);
    q[1].set(x1, y0, z1);
    q[2].set(ux1, y1, uz1);
    q[3].set(ux0, y1, uz1);
    st.quadN(N_PZ, q[0], q[1], q[2], q[3], cLow, cLow, col, col, uvMul);
  }
  if (o.xMin !== false) {
    q[0].set(x0, y0, z0);
    q[1].set(x0, y0, z1);
    q[2].set(ux0, y1, uz1);
    q[3].set(ux0, y1, uz0);
    st.quadN(N_NX, q[0], q[1], q[2], q[3], cLow, cLow, col, col, uvMul);
  }
  if (o.xMax !== false) {
    q[0].set(x1, y0, z0);
    q[1].set(x1, y0, z1);
    q[2].set(ux1, y1, uz1);
    q[3].set(ux1, y1, uz0);
    st.quadN(N_PX, q[0], q[1], q[2], q[3], cLow, cLow, col, col, uvMul);
  }
  if (o.top !== false) {
    q[0].set(ux0, y1, uz0);
    q[1].set(ux1, y1, uz0);
    q[2].set(ux1, y1, uz1);
    q[3].set(ux0, y1, uz1);
    st.quadN(N_UP, q[0], q[1], q[2], q[3], cTop, cTop, cTop, cTop, uvMul);
  }
  if (o.bottom === true) {
    q[0].set(x0, y0, z0);
    q[1].set(x1, y0, z0);
    q[2].set(x1, y0, z1);
    q[3].set(x0, y0, z1);
    st.quadN(N_DOWN, q[0], q[1], q[2], q[3], cLow, cLow, cLow, cLow, uvMul);
  }
}

/**
 * Vertical cylinder / truncated cone on the local Y axis.
 * `flutes > 0` cuts classical fluting into the shaft; `entasis` swells it.
 */
export function cylinder(
  st: GeoStream,
  cx: number,
  y0: number,
  cz: number,
  r0: number,
  r1: number,
  h: number,
  seg: number,
  col: THREE.Color,
  opts: {
    top?: boolean;
    bottom?: boolean;
    flutes?: number;
    entasis?: number;
    arcFrom?: number;
    arcTo?: number;
    shadeLow?: number;
    inward?: boolean;
  } = {}
): void {
  const from = opts.arcFrom ?? 0;
  const to = opts.arcTo ?? Math.PI * 2;
  const flutes = opts.flutes ?? 0;
  const entasis = opts.entasis ?? 0;
  const shade = opts.shadeLow ?? 0;
  const cLow = shade > 0 ? C_TMP.copy(col).multiplyScalar(1 - shade).clone() : col;
  const y1 = y0 + h;
  const sgn = opts.inward ? -1 : 1;

  const rAt = (t: number, a: number): number => {
    const e = entasis > 0 ? Math.sin(Math.min(1, t) * Math.PI * 0.86 + 0.2) * entasis : 0;
    const base = r0 + (r1 - r0) * t + e;
    if (flutes <= 0) return base;
    return base * (1 - 0.055 * (0.5 - 0.5 * Math.cos(a * flutes)));
  };

  for (let i = 0; i < seg; i++) {
    const a0 = from + ((to - from) * i) / seg;
    const a1 = from + ((to - from) * (i + 1)) / seg;
    const am = (a0 + a1) * 0.5;
    const rb0 = rAt(0, a0);
    const rb1 = rAt(0, a1);
    const rt0 = rAt(1, a0);
    const rt1 = rAt(1, a1);
    q[0].set(cx + Math.cos(a0) * rb0, y0, cz + Math.sin(a0) * rb0);
    q[1].set(cx + Math.cos(a1) * rb1, y0, cz + Math.sin(a1) * rb1);
    q[2].set(cx + Math.cos(a1) * rt1, y1, cz + Math.sin(a1) * rt1);
    q[3].set(cx + Math.cos(a0) * rt0, y1, cz + Math.sin(a0) * rt0);
    NH.set(Math.cos(am) * sgn, (r0 - r1) * 0.3, Math.sin(am) * sgn);
    st.quadN(NH, q[0], q[1], q[2], q[3], cLow, cLow, col, col);
  }
  if (opts.top && r1 > 0.001) {
    for (let i = 0; i < seg; i++) {
      const a0 = from + ((to - from) * i) / seg;
      const a1 = from + ((to - from) * (i + 1)) / seg;
      q[0].set(cx, y1, cz);
      q[1].set(cx + Math.cos(a0) * rAt(1, a0), y1, cz + Math.sin(a0) * rAt(1, a0));
      q[2].set(cx + Math.cos(a1) * rAt(1, a1), y1, cz + Math.sin(a1) * rAt(1, a1));
      st.triN(N_UP, q[0], q[1], q[2], col);
    }
  }
  if (opts.bottom && r0 > 0.001) {
    for (let i = 0; i < seg; i++) {
      const a0 = from + ((to - from) * i) / seg;
      const a1 = from + ((to - from) * (i + 1)) / seg;
      q[0].set(cx, y0, cz);
      q[1].set(cx + Math.cos(a0) * rAt(0, a0), y0, cz + Math.sin(a0) * rAt(0, a0));
      q[2].set(cx + Math.cos(a1) * rAt(0, a1), y0, cz + Math.sin(a1) * rAt(0, a1));
      st.triN(N_DOWN, q[0], q[1], q[2], col);
    }
  }
}

/** Cone — cypress crowns, spires, tent tops. */
export function cone(
  st: GeoStream,
  cx: number,
  y0: number,
  cz: number,
  r: number,
  h: number,
  seg: number,
  col: THREE.Color,
  tipCol: THREE.Color = col
): void {
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    const am = (a0 + a1) * 0.5;
    q[0].set(cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r);
    q[1].set(cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r);
    q[2].set(cx, y0 + h, cz);
    NH.set(Math.cos(am), r / Math.max(0.01, h), Math.sin(am));
    st.triN(NH, q[0], q[1], q[2], col, col, tipCol);
  }
}

/**
 * Hemispherical dome shell, optionally coffered.
 *
 * The Pantheon's dome carries five rings of twenty-eight coffers diminishing upward;
 * that pattern is the most recognisable thing about it, so it is modelled as real
 * recesses rather than painted on.
 */
export function dome(
  st: GeoStream,
  cx: number,
  y0: number,
  cz: number,
  radius: number,
  segU: number,
  segV: number,
  col: THREE.Color,
  opts: { coffers?: { rings: number; perRing: number; depth: number }; oculus?: number; heightScale?: number } = {}
): void {
  const hs = opts.heightScale ?? 1;
  const oc = opts.oculus ?? 0;
  const vMax = oc > 0 ? Math.acos(Math.min(0.999, oc / radius)) : Math.PI * 0.5;
  const cof = opts.coffers;
  const shadow = C_TMP.copy(col).multiplyScalar(0.5).clone();

  const at = (u: number, v: number, rMul: number, out: THREE.Vector3): THREE.Vector3 => {
    const sv = Math.sin(v);
    const cv = Math.cos(v);
    return out.set(cx + Math.cos(u) * sv * radius * rMul, y0 + cv * radius * hs * rMul, cz + Math.sin(u) * sv * radius * rMul);
  };

  for (let j = 0; j < segV; j++) {
    const v0 = vMax * (1 - j / segV);
    const v1 = vMax * (1 - (j + 1) / segV);
    const vm = (v0 + v1) * 0.5;
    const ringIdx = cof ? Math.floor(((j + 0.5) / segV) * cof.rings) : -1;
    for (let i = 0; i < segU; i++) {
      const u0 = (Math.PI * 2 * i) / segU;
      const u1 = (Math.PI * 2 * (i + 1)) / segU;
      const um = (u0 + u1) * 0.5;
      let rMul = 1;
      let c = col;
      if (cof && ringIdx >= 0 && ringIdx < cof.rings) {
        const uCell = ((i + 0.5) / segU) * cof.perRing;
        const vCell = ((j + 0.5) / segV) * cof.rings;
        const fu = uCell - Math.floor(uCell);
        const fv = vCell - Math.floor(vCell);
        if (fu > 0.2 && fu < 0.8 && fv > 0.2 && fv < 0.8) {
          rMul = 1 - cof.depth / radius;
          c = shadow;
        }
      }
      at(u0, v0, rMul, q[0]);
      at(u1, v0, rMul, q[1]);
      at(u1, v1, rMul, q[2]);
      at(u0, v1, rMul, q[3]);
      NH.set(Math.cos(um) * Math.sin(vm), Math.cos(vm), Math.sin(um) * Math.sin(vm));
      st.quadN(NH, q[0], q[1], q[2], q[3], c);
    }
  }
}

export interface ArchPanelOpts {
  /** Depth of the panel along local Z (the wall thickness). */
  depth: number;
  /** Springing height of the arch above the panel base. */
  spring: number;
  /** Clear width of the opening. */
  openWidth: number;
  segments?: number;
  /** Draw the back face too (free-standing arcades like an aqueduct). */
  backFace?: boolean;
  /** Colour of the shaded reveal inside the opening. */
  voidCol?: THREE.Color;
  /** Recess the arch face by this much, giving a projecting archivolt frame. */
  archivolt?: number;
  /** Fill the opening below `blockTo` with masonry (blocked-up arcade bays). */
  blockTo?: number;
}

/**
 * A rectangular wall panel pierced by a semicircular arch — the most useful Roman
 * module there is. Aqueduct arcades, the Colosseum's eighty bays per storey, theatre
 * façades, gate passages and ground-floor *tabernae* are all this function.
 *
 * Local frame: x ∈ [-w/2, w/2], y ∈ [0, h], z ∈ [0, depth]. Front face is at z = 0
 * and looks toward −Z.
 */
export function archPanel(st: GeoStream, w: number, h: number, col: THREE.Color, o: ArchPanelOpts): void {
  const seg = o.segments ?? 10;
  const ow = o.openWidth;
  const r = ow / 2;
  const spring = o.spring;
  const crown = spring + r;
  const d = o.depth;
  const voidCol = o.voidCol ?? C_TMP.copy(col).multiplyScalar(0.14).clone();
  const dark = C_TMP2.copy(col).multiplyScalar(0.7).clone();
  const lowCol = new THREE.Color().copy(col).multiplyScalar(0.86);
  if (crown > h + 1e-3) return;

  for (const fz of o.backFace ? [0, d] : [0]) {
    const hint = fz === 0 ? N_NZ : N_PZ;
    for (const side of [-1, 1]) {
      const xa = side < 0 ? -w / 2 : ow / 2;
      const xb = side < 0 ? -ow / 2 : w / 2;
      if (Math.abs(xb - xa) < 1e-4) continue;
      q[0].set(xa, 0, fz);
      q[1].set(xb, 0, fz);
      q[2].set(xb, h, fz);
      q[3].set(xa, h, fz);
      st.quadN(hint, q[0], q[1], q[2], q[3], lowCol, lowCol, col, col);
    }
    for (let i = 0; i < seg; i++) {
      const a0 = Math.PI - (Math.PI * i) / seg;
      const a1 = Math.PI - (Math.PI * (i + 1)) / seg;
      const x0 = Math.cos(a0) * r;
      const x1 = Math.cos(a1) * r;
      const y0 = spring + Math.sin(a0) * r;
      const y1 = spring + Math.sin(a1) * r;
      q[0].set(x0, y0, fz);
      q[1].set(x1, y1, fz);
      q[2].set(x1, h, fz);
      q[3].set(x0, h, fz);
      st.quadN(hint, q[0], q[1], q[2], q[3], col);
    }
  }

  // Reveals: the jambs and intrados seen through the opening. These are what make an
  // arch read as a hole in three and a half metres of masonry, not a decal.
  for (const side of [-1, 1]) {
    const x = (side * ow) / 2;
    q[0].set(x, 0, 0);
    q[1].set(x, 0, d);
    q[2].set(x, spring, d);
    q[3].set(x, spring, 0);
    NH.set(-side, 0, 0);
    st.quadN(NH, q[0], q[1], q[2], q[3], voidCol, voidCol, dark, dark);
  }
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI - (Math.PI * i) / seg;
    const a1 = Math.PI - (Math.PI * (i + 1)) / seg;
    const am = (a0 + a1) * 0.5;
    const x0 = Math.cos(a0) * r;
    const x1 = Math.cos(a1) * r;
    const y0 = spring + Math.sin(a0) * r;
    const y1 = spring + Math.sin(a1) * r;
    q[0].set(x0, y0, 0);
    q[1].set(x0, y0, d);
    q[2].set(x1, y1, d);
    q[3].set(x1, y1, 0);
    NH.set(-Math.cos(am), -Math.sin(am), 0);
    st.quadN(NH, q[0], q[1], q[2], q[3], dark);
  }

  // Blocked-up bay: rubble infill, as the Aurelianic builders did to older arcades.
  if (o.blockTo && o.blockTo > 0) {
    box(st, -ow / 2, 0, 0, ow / 2, Math.min(o.blockTo, crown), d, lowCol, { top: true, bottom: false, xMin: false, xMax: false });
  }

  if (o.archivolt && o.archivolt > 0) {
    const t = o.archivolt;
    for (let i = 0; i < seg; i++) {
      const a0 = Math.PI - (Math.PI * i) / seg;
      const a1 = Math.PI - (Math.PI * (i + 1)) / seg;
      const am = (a0 + a1) * 0.5;
      const rr = r + t * 1.6;
      const zz = -t * 0.6;
      q[0].set(Math.cos(a0) * r, spring + Math.sin(a0) * r, zz);
      q[1].set(Math.cos(a1) * r, spring + Math.sin(a1) * r, zz);
      q[2].set(Math.cos(a1) * rr, spring + Math.sin(a1) * rr, zz);
      q[3].set(Math.cos(a0) * rr, spring + Math.sin(a0) * rr, zz);
      st.quadN(N_NZ, q[0], q[1], q[2], q[3], col);
      q[0].set(Math.cos(a0) * rr, spring + Math.sin(a0) * rr, zz);
      q[1].set(Math.cos(a1) * rr, spring + Math.sin(a1) * rr, zz);
      q[2].set(Math.cos(a1) * rr, spring + Math.sin(a1) * rr, 0);
      q[3].set(Math.cos(a0) * rr, spring + Math.sin(a0) * rr, 0);
      NH.set(Math.cos(am), Math.sin(am), 0);
      st.quadN(NH, q[0], q[1], q[2], q[3], dark);
    }
  }
}

/** A run of `count` arch panels along local X, centred on the origin. */
export function arcade(
  st: GeoStream,
  count: number,
  bayWidth: number,
  h: number,
  col: THREE.Color,
  o: ArchPanelOpts,
  perBay?: (i: number, out: THREE.Color) => { col: THREE.Color; blockTo?: number }
): void {
  const total = count * bayWidth;
  const scratch = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const cx = -total / 2 + bayWidth * (i + 0.5);
    const v = perBay ? perBay(i, scratch) : null;
    st.pushTranslate(cx, 0, 0);
    archPanel(st, bayWidth, h, v ? v.col : col, v && v.blockTo ? { ...o, blockTo: v.blockTo } : o);
    st.pop();
  }
}

/** Gabled tiled roof over a rectangle, with eaves overhang. */
export function gableRoof(
  st: GeoStream,
  roofSt: GeoStream,
  w: number,
  d: number,
  baseY: number,
  ridgeH: number,
  overhang: number,
  col: THREE.Color,
  ridgeAlongX = true
): void {
  const ow = w / 2 + overhang;
  const od = d / 2 + overhang;
  const ridge = baseY + ridgeH;
  const eave = baseY;
  const sunlit = new THREE.Color().copy(col).multiplyScalar(1.1);
  const slope = ridgeH / Math.max(0.01, ridgeAlongX ? od : ow);
  if (ridgeAlongX) {
    q[0].set(-ow, eave, od);
    q[1].set(ow, eave, od);
    q[2].set(ow, ridge, 0);
    q[3].set(-ow, ridge, 0);
    NH.set(0, 1, slope);
    roofSt.quadN(NH, q[0], q[1], q[2], q[3], col, col, sunlit, sunlit);
    q[0].set(-ow, eave, -od);
    q[1].set(ow, eave, -od);
    q[2].set(ow, ridge, 0);
    q[3].set(-ow, ridge, 0);
    NH.set(0, 1, -slope);
    roofSt.quadN(NH, q[0], q[1], q[2], q[3], col, col, sunlit, sunlit);
    q[0].set(-ow, eave, -od);
    q[1].set(-ow, eave, od);
    q[2].set(-ow, ridge, 0);
    st.triN(N_NX, q[0], q[1], q[2], col);
    q[0].set(ow, eave, -od);
    q[1].set(ow, eave, od);
    q[2].set(ow, ridge, 0);
    st.triN(N_PX, q[0], q[1], q[2], col);
  } else {
    q[0].set(ow, eave, -od);
    q[1].set(ow, eave, od);
    q[2].set(0, ridge, od);
    q[3].set(0, ridge, -od);
    NH.set(slope, 1, 0);
    roofSt.quadN(NH, q[0], q[1], q[2], q[3], col, col, sunlit, sunlit);
    q[0].set(-ow, eave, -od);
    q[1].set(-ow, eave, od);
    q[2].set(0, ridge, od);
    q[3].set(0, ridge, -od);
    NH.set(-slope, 1, 0);
    roofSt.quadN(NH, q[0], q[1], q[2], q[3], col, col, sunlit, sunlit);
    q[0].set(-ow, eave, -od);
    q[1].set(ow, eave, -od);
    q[2].set(0, ridge, -od);
    st.triN(N_NZ, q[0], q[1], q[2], col);
    q[0].set(-ow, eave, od);
    q[1].set(ow, eave, od);
    q[2].set(0, ridge, od);
    st.triN(N_PZ, q[0], q[1], q[2], col);
  }
}

/** Four-sided hipped tiled roof — Aurelian tower caps and most insula blocks. */
export function hipRoof(
  st: GeoStream,
  w: number,
  d: number,
  baseY: number,
  h: number,
  overhang: number,
  col: THREE.Color
): void {
  const ow = w / 2 + overhang;
  const od = d / 2 + overhang;
  const alongX = w >= d;
  const ridgeHalf = alongX ? Math.max(0.15, ow - od) : Math.max(0.15, od - ow);
  const top = baseY + h;
  const sunlit = new THREE.Color().copy(col).multiplyScalar(1.12);
  const r0 = new THREE.Vector3();
  const r1 = new THREE.Vector3();
  if (alongX) {
    r0.set(-ridgeHalf, top, 0);
    r1.set(ridgeHalf, top, 0);
  } else {
    r0.set(0, top, -ridgeHalf);
    r1.set(0, top, ridgeHalf);
  }
  const c0 = new THREE.Vector3(-ow, baseY, -od);
  const c1 = new THREE.Vector3(ow, baseY, -od);
  const c2 = new THREE.Vector3(ow, baseY, od);
  const c3 = new THREE.Vector3(-ow, baseY, od);
  const sl = h / Math.max(0.01, alongX ? od : ow);
  if (alongX) {
    NH.set(0, 1, sl);
    st.quadN(NH, c3, c2, r1, r0, col, col, sunlit, sunlit);
    NH.set(0, 1, -sl);
    st.quadN(NH, c0, c1, r1, r0, col, col, sunlit, sunlit);
    NH.set(-1, sl, 0);
    st.triN(NH, c0, c3, r0, col, col, sunlit);
    NH.set(1, sl, 0);
    st.triN(NH, c1, c2, r1, col, col, sunlit);
  } else {
    NH.set(sl, 1, 0);
    st.quadN(NH, c1, c2, r1, r0, col, col, sunlit, sunlit);
    NH.set(-sl, 1, 0);
    st.quadN(NH, c0, c3, r1, r0, col, col, sunlit, sunlit);
    NH.set(0, sl, -1);
    st.triN(NH, c0, c1, r0, col, col, sunlit);
    NH.set(0, sl, 1);
    st.triN(NH, c3, c2, r1, col, col, sunlit);
  }
}

/** Flat roof terrace with a low parapet — common on grander town houses. */
export function flatRoof(st: GeoStream, w: number, d: number, y: number, parapet: number, col: THREE.Color): void {
  box(st, -w / 2, y - 0.1, -d / 2, w / 2, y, d / 2, col, { bottom: false });
  if (parapet > 0) {
    const t = 0.3;
    box(st, -w / 2, y, -d / 2, w / 2, y + parapet, -d / 2 + t, col, { bottom: false });
    box(st, -w / 2, y, d / 2 - t, w / 2, y + parapet, d / 2, col, { bottom: false });
    box(st, -w / 2, y, -d / 2 + t, -w / 2 + t, y + parapet, d / 2 - t, col, { bottom: false });
    box(st, w / 2 - t, y, -d / 2 + t, w / 2, y + parapet, d / 2 - t, col, { bottom: false });
  }
}

export type ColumnOrder = 'tuscan' | 'ionic' | 'corinthian';

/**
 * A classical column: base, shaft with entasis and optional fluting, capital.
 * Proportions follow Vitruvius (III.3, IV.1) — the shaft tapers to five-sixths of
 * the lower diameter at the neck, and Corinthian capitals stand one diameter tall.
 */
export function column(
  st: GeoStream,
  cx: number,
  y0: number,
  cz: number,
  radius: number,
  height: number,
  order: ColumnOrder,
  col: THREE.Color,
  detail = 1
): void {
  const seg = detail > 0 ? 14 : 7;
  const flutes = detail > 0 && order !== 'tuscan' ? 20 : 0;
  const baseH = order === 'tuscan' ? radius * 0.4 : radius * 0.6;
  const capH = order === 'corinthian' ? radius * 2.0 : order === 'ionic' ? radius * 0.9 : radius * 0.6;
  const shaftH = Math.max(radius, height - baseH - capH);
  const shade = new THREE.Color().copy(col).multiplyScalar(0.84);

  box(st, cx - radius * 1.3, y0, cz - radius * 1.3, cx + radius * 1.3, y0 + baseH * 0.45, cz + radius * 1.3, shade, { bottom: false });
  cylinder(st, cx, y0 + baseH * 0.45, cz, radius * 1.24, radius * 1.03, baseH * 0.55, seg, col);
  cylinder(st, cx, y0 + baseH, cz, radius, radius * 0.84, shaftH, seg, col, {
    flutes,
    entasis: radius * 0.035,
    shadeLow: 0.06,
  });
  const capY = y0 + baseH + shaftH;
  if (order === 'corinthian') {
    cylinder(st, cx, capY, cz, radius * 0.84, radius * 1.02, capH * 0.52, seg, col);
    cylinder(st, cx, capY + capH * 0.52, cz, radius * 1.02, radius * 1.38, capH * 0.3, seg, col);
    box(st, cx - radius * 1.5, capY + capH * 0.82, cz - radius * 1.5, cx + radius * 1.5, capY + capH, cz + radius * 1.5, col, { bottom: false });
  } else if (order === 'ionic') {
    cylinder(st, cx, capY, cz, radius * 0.84, radius * 0.96, capH * 0.45, seg, col);
    for (const s of [-1, 1]) {
      box(st, cx + s * radius * 1.28 - radius * 0.22, capY + capH * 0.3, cz - radius * 0.9, cx + s * radius * 1.28 + radius * 0.22, capY + capH * 0.85, cz + radius * 0.9, col, { bottom: false });
    }
    box(st, cx - radius * 1.35, capY + capH * 0.8, cz - radius, cx + radius * 1.35, capY + capH, cz + radius, col, { bottom: false });
  } else {
    cylinder(st, cx, capY, cz, radius * 0.84, radius * 1.12, capH * 0.6, seg, col);
    box(st, cx - radius * 1.22, capY + capH * 0.6, cz - radius * 1.22, cx + radius * 1.22, capY + capH, cz + radius * 1.22, col, { bottom: false });
  }
}

/**
 * Temple pediment: tympanum plus raking cornices. Roman pitch runs about 1 : 4
 * (roughly 15°), noticeably flatter than Greek practice.
 */
export function pediment(st: GeoStream, w: number, y0: number, depth: number, col: THREE.Color, pitch = 0.24): void {
  const h = (w / 2) * pitch;
  const cornice = Math.max(0.35, w * 0.022);
  const bright = new THREE.Color().copy(col).multiplyScalar(1.16);
  // Rake direction, for the top face's normal.
  const rl = Math.hypot(w / 2, h) || 1;
  for (const face of [-1, 1]) {
    const zIn = (face * depth) / 2;
    const zOut = zIn + face * cornice;
    // Tympanum: the triangular field the sculpture sits in.
    q[0].set(-w / 2, y0, zIn);
    q[1].set(w / 2, y0, zIn);
    q[2].set(0, y0 + h, zIn);
    st.triN(face > 0 ? N_PZ : N_NZ, q[0], q[1], q[2], col);

    // Raking cornice: a moulding *along each sloping edge of the gable*, one cornice-width
    // deep and one cornice-width tall, on the front and back faces only.
    //
    // Emitted full-depth — as an earlier revision did, with a single quad per rake spanning
    // the whole building from front to back — it is not a moulding at all but a plane laid
    // over the entire roof: on the Capitoline temple that was two 1,800 m² slabs of marble
    // covering the tiling completely, and at marble albedo times 1.16 they clipped through
    // the top of the filmic curve into a blank white sheet. That sheet was the one visibly
    // broken building on the skyline, and it was hiding a correct roof underneath.
    for (const s of [-1, 1]) {
      const ex = s * (w / 2);
      // Outward face of the moulding.
      q[0].set(ex, y0, zOut);
      q[1].set(ex, y0 + cornice, zOut);
      q[2].set(0, y0 + h + cornice, zOut);
      q[3].set(0, y0 + h, zOut);
      NH.set(0, 0, face);
      st.quadN(NH, q[0], q[1], q[2], q[3], bright);
      // Sloping top of the moulding. Normal is perpendicular to the rake, in the xy plane.
      q[0].set(ex, y0 + cornice, zIn);
      q[1].set(ex, y0 + cornice, zOut);
      q[2].set(0, y0 + h + cornice, zOut);
      q[3].set(0, y0 + h + cornice, zIn);
      NH.set((s * h) / rl, (w / 2) / rl, 0);
      st.quadN(NH, q[0], q[1], q[2], q[3], bright);
    }
  }
}

/** A box aligned to an arbitrary horizontal direction — walls, merlons, kerbs. */
export function quadPrism(
  st: GeoStream,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  nx: number,
  nz: number,
  thickness: number,
  y0: number,
  y1: number,
  col: THREE.Color,
  topCol: THREE.Color = col,
  opts: { top?: boolean; ends?: boolean; batter?: number } = {}
): void {
  const t = thickness * 0.5;
  const bat = (opts.batter ?? 0) * (y1 - y0);
  const dl = Math.hypot(bx - ax, bz - az) || 1;
  const dx = (bx - ax) / dl;
  const dz = (bz - az) / dl;
  const low = new THREE.Color().copy(col).multiplyScalar(0.87);

  const cor = (atA: boolean, outer: boolean, top: boolean): THREE.Vector3 => {
    const px = atA ? ax : bx;
    const pz = atA ? az : bz;
    const off = top ? t - bat : t;
    const s = outer ? -off : off;
    return q[0].set(px + nx * s, top ? y1 : y0, pz + nz * s);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const dd = new THREE.Vector3();

  // Outer face (−n)
  a.copy(cor(true, true, false));
  b.copy(cor(false, true, false));
  c.copy(cor(false, true, true));
  dd.copy(cor(true, true, true));
  NH.set(-nx, 0, -nz);
  st.quadN(NH, a, b, c, dd, low, low, col, col);
  // Inner face (+n)
  a.copy(cor(true, false, false));
  b.copy(cor(false, false, false));
  c.copy(cor(false, false, true));
  dd.copy(cor(true, false, true));
  NH.set(nx, 0, nz);
  st.quadN(NH, a, b, c, dd, low, low, col, col);
  if (opts.ends !== false) {
    a.copy(cor(true, true, false));
    b.copy(cor(true, false, false));
    c.copy(cor(true, false, true));
    dd.copy(cor(true, true, true));
    NH.set(-dx, 0, -dz);
    st.quadN(NH, a, b, c, dd, low, low, col, col);
    a.copy(cor(false, true, false));
    b.copy(cor(false, false, false));
    c.copy(cor(false, false, true));
    dd.copy(cor(false, true, true));
    NH.set(dx, 0, dz);
    st.quadN(NH, a, b, c, dd, low, low, col, col);
  }
  if (opts.top !== false) {
    a.copy(cor(true, true, true));
    b.copy(cor(false, true, true));
    c.copy(cor(false, false, true));
    dd.copy(cor(true, false, true));
    st.quadN(N_UP, a, b, c, dd, topCol);
  }
}

/**
 * Crenellated parapet along a straight run.
 *
 * The Aurelian Wall's first phase carried a plain crenellated parapet on the outer
 * lip of the walkway; merlons run roughly 1.4 m wide with 0.7 m embrasures between,
 * and every other merlon is pierced by a loophole.
 */
export function crenellation(
  st: GeoStream,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  baseY: number,
  merlonH: number,
  thickness: number,
  col: THREE.Color,
  merlonW = 1.4,
  gapW = 0.72,
  arrowSlit = true
): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.4) return;
  const dx = (x1 - x0) / len;
  const dz = (z1 - z0) / len;
  const nx = -dz;
  const nz = dx;
  const pitch = merlonW + gapW;
  const n = Math.max(1, Math.round(len / pitch));
  const step = len / n;
  const mw = step * (merlonW / pitch);
  const shade = new THREE.Color().copy(col).multiplyScalar(0.94);
  const cap = new THREE.Color().copy(col).multiplyScalar(1.15);
  const dark = new THREE.Color(0.012, 0.011, 0.01);

  for (let i = 0; i < n; i++) {
    const s = i * step + (step - mw) * 0.5;
    const ax = x0 + dx * s;
    const az = z0 + dz * s;
    const bx = x0 + dx * (s + mw);
    const bz = z0 + dz * (s + mw);
    quadPrism(st, ax, az, bx, bz, nx, nz, thickness, baseY, baseY + merlonH, shade, cap);
    if (arrowSlit && i % 2 === 0) {
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      quadPrism(
        st,
        mx - dx * 0.09,
        mz - dz * 0.09,
        mx + dx * 0.09,
        mz + dz * 0.09,
        nx,
        nz,
        thickness + 0.08,
        baseY + merlonH * 0.24,
        baseY + merlonH * 0.74,
        dark,
        dark
      );
    }
  }
}

export interface CaveaOpts {
  /** Stepped divisions across the bank. Few and deep, not one per seat row — see below. */
  rows: number;
  /** Angular divisions of the whole sweep. */
  seg: number;
  /** Row boundaries carrying a *praecinctio*: a level walkway behind a parapet wall. */
  breaks?: readonly number[];
  /** Parapet height of a praecinctio, metres. */
  balteus?: number;
  /** Number of radial stairways (*scalaria*) dividing the bank into wedges. */
  scalaria?: number;
  tread: THREE.Color;
  riser: THREE.Color;
  /** Deterministic salt for the per-row tone jitter. */
  salt?: number;
}

/**
 * Elliptical stepped seating between an inner and an outer ellipse.
 *
 * Two things this fixes over a naive annulus. First, the *ratio* of the semi-axes is
 * not constant across a cavea: the Colosseum's arena is 83 × 48 m (a/b = 1.73) inside a
 * building that is 189 × 156 m (a/b = 1.21), so a bank drawn as `sin θ · b/a` at every
 * radius leaves a crescent of open ground between the arena wall and the first row —
 * which is exactly how you ended up seeing grass and a tree through the middle of the
 * amphitheatre. Interpolating both semi-axes per row makes the inner edge land on the
 * arena ellipse by construction.
 *
 * Second, *step depth*. A real cavea is 30-odd 0.7 m seat rows, and drawing them
 * literally puts a 1-pixel light/dark pair every screen pixel at any strategic camera
 * distance: pure moiré, and it shimmers as the camera moves. Roman seating was actually
 * built as a few deep concrete steps carrying wooden or marble benches, and grouped into
 * *maeniana* separated by walkways. Emitting the maenianum steps — 2.5–4 m treads with a
 * praecinctio wall between blocks — is both cheaper and closer to the archaeology, and it
 * gives the eye the strong horizontal bands the real building has.
 */
export function ellipseCavea(
  st: GeoStream,
  aIn: number,
  bIn: number,
  aOut: number,
  bOut: number,
  y0: number,
  yTop: number,
  from: number,
  to: number,
  o: CaveaOpts
): void {
  const rows = Math.max(1, o.rows);
  const seg = Math.max(3, o.seg);
  const breaks = o.breaks ?? [];
  const balteus = o.balteus ?? 1.5;
  const rise = (yTop - y0) / rows;
  const shade = C_TMP.copy(o.riser).clone();
  const salt = o.salt ?? 0;
  const cTread = new THREE.Color();
  const scal = o.scalaria ?? 0;
  const pale = new THREE.Color().copy(o.tread).multiplyScalar(1.16);

  const ax = (t: number): number => aIn + (aOut - aIn) * t;
  const bx = (t: number): number => bIn + (bOut - bIn) * t;

  let y = y0;
  for (let r = 0; r < rows; r++) {
    const t0 = r / rows;
    const t1 = (r + 1) / rows;
    const a0 = ax(t0);
    const b0 = bx(t0);
    const a1 = ax(t1);
    const b1 = bx(t1);
    // Per-row tone drift. Without it the bank is a run of identical rings, and identical
    // rings at sub-pixel spacing are what the eye reads as moiré even when the geometry
    // is coarse.
    const tone = 0.9 + hash2(r, 0, 811 + salt) * 0.2;
    cTread.copy(o.tread).multiplyScalar(tone);
    for (let i = 0; i < seg; i++) {
      const u0 = from + ((to - from) * i) / seg;
      const u1 = from + ((to - from) * (i + 1)) / seg;
      const um = (u0 + u1) * 0.5;
      const c0 = Math.cos(u0);
      const s0 = Math.sin(u0);
      const c1 = Math.cos(u1);
      const s1 = Math.sin(u1);
      // Tread.
      q[0].set(c0 * a0, y, s0 * b0);
      q[1].set(c1 * a0, y, s1 * b0);
      q[2].set(c1 * a1, y, s1 * b1);
      q[3].set(c0 * a1, y, s0 * b1);
      st.quadN(N_UP, q[0], q[1], q[2], q[3], cTread);
      // Riser at the outer edge of the tread.
      q[0].set(c0 * a1, y, s0 * b1);
      q[1].set(c1 * a1, y, s1 * b1);
      q[2].set(c1 * a1, y + rise, s1 * b1);
      q[3].set(c0 * a1, y + rise, s0 * b1);
      NH.set(-Math.cos(um) * b1, 0, -Math.sin(um) * a1);
      st.quadN(NH, q[0], q[1], q[2], q[3], shade);
    }
    y += rise;
    // Praecinctio: the tread above this row is a walkway, and its parapet is the single
    // most legible line on a cavea from any distance.
    if (breaks.includes(r + 1) && r + 1 < rows) {
      for (let i = 0; i < seg; i++) {
        const u0 = from + ((to - from) * i) / seg;
        const u1 = from + ((to - from) * (i + 1)) / seg;
        const um = (u0 + u1) * 0.5;
        const c0 = Math.cos(u0);
        const s0 = Math.sin(u0);
        const c1 = Math.cos(u1);
        const s1 = Math.sin(u1);
        const a1b = ax(t1);
        const b1b = bx(t1);
        q[0].set(c0 * a1b, y, s0 * b1b);
        q[1].set(c1 * a1b, y, s1 * b1b);
        q[2].set(c1 * a1b, y + balteus, s1 * b1b);
        q[3].set(c0 * a1b, y + balteus, s0 * b1b);
        NH.set(-Math.cos(um) * b1b, 0, -Math.sin(um) * a1b);
        st.quadN(NH, q[0], q[1], q[2], q[3], pale);
        q[0].set(c0 * a1b, y + balteus, s0 * b1b);
        q[1].set(c1 * a1b, y + balteus, s1 * b1b);
        q[2].set(c1 * (a1b + 0.5), y + balteus, s1 * (b1b + 0.5));
        q[3].set(c0 * (a1b + 0.5), y + balteus, s0 * (b1b + 0.5));
        st.quadN(N_UP, q[0], q[1], q[2], q[3], pale);
      }
      y += balteus;
    }
  }

  // Scalaria. Drawn as raised radial strips rather than modelled flights: from every
  // camera that can see a whole cavea they are a pattern of pale radial lines, and that
  // pattern — not the individual steps — is what identifies the building.
  if (scal > 0) {
    const half = ((to - from) / seg) * 0.28;
    for (let k = 0; k < scal; k++) {
      const u = from + ((to - from) * (k + 0.5)) / scal;
      for (let r = 0; r < rows; r++) {
        const t0 = r / rows;
        const t1 = (r + 1) / rows;
        const yy = y0 + rise * r + 0.22;
        for (const [ua, ub] of [[u - half, u + half]] as const) {
          q[0].set(Math.cos(ua) * ax(t0), yy, Math.sin(ua) * bx(t0));
          q[1].set(Math.cos(ub) * ax(t0), yy, Math.sin(ub) * bx(t0));
          q[2].set(Math.cos(ub) * ax(t1), yy, Math.sin(ub) * bx(t1));
          q[3].set(Math.cos(ua) * ax(t1), yy, Math.sin(ua) * bx(t1));
          st.quadN(N_UP, q[0], q[1], q[2], q[3], pale);
        }
      }
    }
  }
}

/**
 * Straight stepped seating bank running along local X, rising away from the track.
 *
 * `zInner` is the signed z of the front row and `side` is +1 for a bank on the +Z side of
 * the arena, −1 for the −Z side. **`depth` is unsigned**: the direction comes from `side`
 * alone. An earlier revision took a signed depth *and* multiplied by `side`, so the two
 * cancelled and the −Z bank of every circus and stadium grew *inward across the arena* —
 * one bank of the Circus Maximus was laid over its own racetrack, which is a large part of
 * what "the Circus Maximus is overlapping multiple buildings" looked like from the air.
 *
 * Same maenianum treatment as `ellipseCavea`, for the long sides of a circus or stadium.
 */
export function straightCavea(
  st: GeoStream,
  halfLen: number,
  zInner: number,
  depth: number,
  y0: number,
  yTop: number,
  side: 1 | -1,
  o: CaveaOpts
): void {
  const rows = Math.max(1, o.rows);
  const rise = (yTop - y0) / rows;
  const rowD = Math.abs(depth) / rows;
  const breaks = o.breaks ?? [];
  const balteus = o.balteus ?? 1.5;
  const salt = o.salt ?? 0;
  const cTread = new THREE.Color();
  const pale = new THREE.Color().copy(o.tread).multiplyScalar(1.16);
  const nOut = side > 0 ? N_NZ : N_PZ;
  // Longitudinal cells as well as rows: one 560 m quad per step is a single enormous
  // untextured band, and the vertex-colour drift that keeps a surface alive needs
  // somewhere to live.
  const cells = Math.max(2, Math.round(halfLen / 22));

  let y = y0;
  for (let r = 0; r < rows; r++) {
    const z0 = zInner + side * rowD * r;
    const z1 = z0 + side * rowD;
    for (let i = 0; i < cells; i++) {
      const x0 = -halfLen + (halfLen * 2 * i) / cells;
      const x1 = -halfLen + (halfLen * 2 * (i + 1)) / cells;
      cTread.copy(o.tread).multiplyScalar(0.9 + hash2(r, i, 613 + salt) * 0.2);
      q[0].set(x0, y, Math.min(z0, z1));
      q[1].set(x1, y, Math.min(z0, z1));
      q[2].set(x1, y, Math.max(z0, z1));
      q[3].set(x0, y, Math.max(z0, z1));
      st.quadN(N_UP, q[0], q[1], q[2], q[3], cTread);
      q[0].set(x0, y, z1);
      q[1].set(x1, y, z1);
      q[2].set(x1, y + rise, z1);
      q[3].set(x0, y + rise, z1);
      st.quadN(nOut, q[0], q[1], q[2], q[3], o.riser);
    }
    y += rise;
    if (breaks.includes(r + 1) && r + 1 < rows) {
      const zb = zInner + side * rowD * (r + 1);
      box(st, -halfLen, y, Math.min(zb, zb + side * 0.6), halfLen, y + balteus, Math.max(zb, zb + side * 0.6), pale, {
        bottom: false,
      });
      y += balteus;
    }
  }
}

/**
 * A large paved area emitted as cells with per-cell tone drift.
 *
 * A forum is 100 m across. As one quad it is one flat plate of vertex colour, and from
 * a strategic camera the biggest featureless region in the frame — which is precisely
 * the note the QA pass raised about the piazzas. Real paving is slabs of slightly
 * different stone laid over centuries, patched and rutted, so cutting it into 4-6 m
 * cells and drifting each one costs a few hundred triangles and buys the surface back.
 */
export function pavedField(
  st: GeoStream,
  hw: number,
  hd: number,
  y: number,
  cell: number,
  col: THREE.Color,
  salt: number,
  spread = 0.16
): void {
  const nx = Math.max(1, Math.round((hw * 2) / cell));
  const nz = Math.max(1, Math.round((hd * 2) / cell));
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = -hw + (hw * 2 * i) / nx;
      const x1 = -hw + (hw * 2 * (i + 1)) / nx;
      const z0 = -hd + (hd * 2 * j) / nz;
      const z1 = -hd + (hd * 2 * (j + 1)) / nz;
      c.copy(col).multiplyScalar(1 - spread * 0.5 + hash2(i, j, salt) * spread);
      q[0].set(x0, y, z0);
      q[1].set(x1, y, z0);
      q[2].set(x1, y, z1);
      q[3].set(x0, y, z1);
      st.quadN(N_UP, q[0], q[1], q[2], q[3], c);
    }
  }
}

/** Elliptical paved / sanded surface, cell-varied like `pavedField`. Arena floors. */
export function pavedEllipse(
  st: GeoStream,
  a: number,
  b: number,
  y: number,
  rings: number,
  seg: number,
  col: THREE.Color,
  salt: number,
  spread = 0.14
): void {
  const c = new THREE.Color();
  const centre = new THREE.Vector3(0, y, 0);
  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    for (let i = 0; i < seg; i++) {
      const u0 = (Math.PI * 2 * i) / seg;
      const u1 = (Math.PI * 2 * (i + 1)) / seg;
      c.copy(col).multiplyScalar(1 - spread * 0.5 + hash2(r, i, salt) * spread);
      if (r === 0) {
        q[0].copy(centre);
        q[1].set(Math.cos(u0) * a * t1, y, Math.sin(u0) * b * t1);
        q[2].set(Math.cos(u1) * a * t1, y, Math.sin(u1) * b * t1);
        st.triN(N_UP, q[0], q[1], q[2], c);
        continue;
      }
      q[0].set(Math.cos(u0) * a * t0, y, Math.sin(u0) * b * t0);
      q[1].set(Math.cos(u1) * a * t0, y, Math.sin(u1) * b * t0);
      q[2].set(Math.cos(u1) * a * t1, y, Math.sin(u1) * b * t1);
      q[3].set(Math.cos(u0) * a * t1, y, Math.sin(u0) * b * t1);
      st.quadN(N_UP, q[0], q[1], q[2], q[3], c);
    }
  }
}

/** Stepped seating banks for the Colosseum, theatres and the Circus. */
export function seatingBank(
  st: GeoStream,
  innerR: number,
  outerR: number,
  y0: number,
  rise: number,
  rows: number,
  segU: number,
  from: number,
  to: number,
  col: THREE.Color,
  ellipseB = 1
): void {
  const rowD = (outerR - innerR) / rows;
  const shade = new THREE.Color().copy(col).multiplyScalar(0.74);
  for (let r = 0; r < rows; r++) {
    const r0 = innerR + rowD * r;
    const r1 = r0 + rowD;
    const yTread = y0 + rise * r;
    const yNext = yTread + rise;
    for (let i = 0; i < segU; i++) {
      const a0 = from + ((to - from) * i) / segU;
      const a1 = from + ((to - from) * (i + 1)) / segU;
      const am = (a0 + a1) * 0.5;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0) * ellipseB;
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1) * ellipseB;
      q[0].set(c0 * r0, yTread, s0 * r0);
      q[1].set(c1 * r0, yTread, s1 * r0);
      q[2].set(c1 * r1, yTread, s1 * r1);
      q[3].set(c0 * r1, yTread, s0 * r1);
      st.quadN(N_UP, q[0], q[1], q[2], q[3], col);
      q[0].set(c0 * r1, yTread, s0 * r1);
      q[1].set(c1 * r1, yTread, s1 * r1);
      q[2].set(c1 * r1, yNext, s1 * r1);
      q[3].set(c0 * r1, yNext, s0 * r1);
      NH.set(-Math.cos(am), 0, -Math.sin(am) * ellipseB);
      st.quadN(NH, q[0], q[1], q[2], q[3], shade);
    }
  }
}

/** Flight of steps advancing along local −Z. */
export function steps(
  st: GeoStream,
  w: number,
  y0: number,
  z0: number,
  count: number,
  rise: number,
  tread: number,
  col: THREE.Color
): void {
  const bright = new THREE.Color().copy(col).multiplyScalar(1.08);
  for (let i = 0; i < count; i++) {
    const y = y0 + rise * i;
    const z = z0 - tread * i;
    q[0].set(-w / 2, y, z);
    q[1].set(w / 2, y, z);
    q[2].set(w / 2, y + rise, z);
    q[3].set(-w / 2, y + rise, z);
    st.quadN(N_PZ, q[0], q[1], q[2], q[3], col);
    q[0].set(-w / 2, y + rise, z);
    q[1].set(w / 2, y + rise, z);
    q[2].set(w / 2, y + rise, z - tread);
    q[3].set(-w / 2, y + rise, z - tread);
    st.quadN(N_UP, q[0], q[1], q[2], q[3], bright);
  }
}

/**
 * A standing bronze figure — togate, one arm raised — for honorific columns, temple
 * acroteria and the summit of the Mausoleum.
 *
 * Modelled as an asymmetric silhouette on purpose: a symmetric arms-out figure at
 * this polygon count reads as a cross, which would be a spectacular anachronism in
 * 271. `height` is the figure's own height; Roman honorific bronzes ran 2.5–4 m so
 * they still read from the street below a 12 m column.
 */
export function statue(
  st: GeoStream,
  cx: number,
  y0: number,
  cz: number,
  height: number,
  col: THREE.Color,
  facing = 0,
  seg = 7
): void {
  const h = height;
  const shade = new THREE.Color().copy(col).multiplyScalar(0.78);
  st.push(place(cx, y0, cz, facing));
  // Plinth, then the drapery of the toga as a tapering drum.
  box(st, -h * 0.17, 0, -h * 0.12, h * 0.17, h * 0.05, h * 0.12, shade, { bottom: false });
  cylinder(st, 0, h * 0.05, 0, h * 0.15, h * 0.11, h * 0.52, seg, col, { shadeLow: 0.18 });
  // Torso, canted slightly, and the mass of cloth over the left shoulder.
  box(st, -h * 0.13, h * 0.5, -h * 0.08, h * 0.13, h * 0.78, h * 0.08, col, { bottom: false });
  box(st, -h * 0.16, h * 0.52, -h * 0.1, -h * 0.02, h * 0.74, h * 0.06, shade, { bottom: false });
  // Neck and head.
  box(st, -h * 0.045, h * 0.78, -h * 0.045, h * 0.045, h * 0.82, h * 0.045, shade, { bottom: false, top: false });
  box(st, -h * 0.07, h * 0.82, -h * 0.065, h * 0.07, h * 0.95, h * 0.065, col, { bottom: false });
  // Right arm raised and forward in the *adlocutio* gesture; left arm down at the side.
  st.push(place(h * 0.13, h * 0.72, 0, 0));
  st.push(new THREE.Matrix4().makeRotationZ(-0.62));
  box(st, -h * 0.035, 0, -h * 0.035, h * 0.035, h * 0.3, h * 0.035, col, { bottom: false });
  st.pop();
  st.pop();
  box(st, -h * 0.17, h * 0.44, -h * 0.035, -h * 0.1, h * 0.74, h * 0.035, col, { bottom: false });
  st.pop();
}

/** Reusable scratch for callers composing transforms. */
const PLACE_M = new THREE.Matrix4();
const PLACE_Q = new THREE.Quaternion();
const PLACE_V = new THREE.Vector3();
const PLACE_S = new THREE.Vector3(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Compose a Y-rotation + translation. The returned matrix is reused — copy if kept. */
export function place(x: number, y: number, z: number, rotY: number, scale = 1): THREE.Matrix4 {
  PLACE_Q.setFromAxisAngle(Y_AXIS, rotY);
  PLACE_S.setScalar(scale);
  return PLACE_M.compose(PLACE_V.set(x, y, z), PLACE_Q, PLACE_S);
}
