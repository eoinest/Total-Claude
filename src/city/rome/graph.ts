/**
 * **The road network as a planar graph, and the faces of it that are the city's blocks.**
 *
 * `docs/ROME-FABRIC.md` §4.3 is one sentence long where it matters: *"Take the graph's faces.
 * Those are the blocks. Not rectangles laid over the streets — the actual enclosed polygons.
 * This is the one line in this document that most changes the result, because it makes a
 * block's orientation a property of the streets that bound it rather than of
 * `hash2(round(d.e), round(d.n), 0x5c1)`."* This file is that operation and nothing else.
 *
 * ## What is deliberately not in here
 *
 * **Monuments.** Not imported, not reachable. §4.3 step 6 rejects against monuments *after*
 * the faces exist, in `fabric.ts`, for the same reason `ways.ts` sits above `layout.ts`: a
 * module that can see a monument will eventually be asked to bend round one. The whole of
 * `deflect()` grew out of exactly that access.
 *
 * **Regions.** A face does not know which *regio* it lies in. `regions.ts` assigns that
 * afterwards, from the face's own centroid, and the assignment is what makes the regions a
 * partition — see the head of that file.
 *
 * **Randomness.** Nothing in this file draws from an `Rng`. The graph is a pure function of
 * the way table and the map frame, so two callers get the same faces in the same order.
 *
 * **And nothing exported here is unused.** `pointInPoly`, `clipToHalfPlane`, `spanAtU` and a
 * `traceBoundary` that walked the outline of a set of faces were all written for this pass and
 * all deleted before it shipped, because the design they were for — a *regio*'s published
 * extent as the union of its blocks — was replaced by an authored partition. `ROME-FABRIC.md`
 * §9.9 is right about `maxDrawAt`: a function whose docstring makes a promise and which nothing
 * calls is worse than no function at all.
 *
 * ## The convention, stated once, because a sign error here is invisible
 *
 * Everything is in the battlefield's `(x, z)` plane, and the shoelace sum
 * `Σ (x_i·z_{i+1} − x_{i+1}·z_i)` is treated as *positive for an interior face*. Under that
 * convention the interior of a ring lies to the **left** of each directed edge, where "left"
 * of a direction `(ex, ez)` is `(−ez, ex)`. `insetFace` and the span clip in `fabric.ts` both
 * depend on it and both would silently produce mirrored answers if it were flipped, which is
 * `MAP-METHOD.md` rule 24's fault one level down. `faceBearing` returns a **world bearing** —
 * `atan2(dz, dx)` — and a caller that wants a *plan rotation* must negate it. See
 * `fabric.ts`'s `blockFrame`, and `assertBlockBearingSign`, which is the deliberately
 * asymmetric case rule 24 asks for.
 */
import type { WayClass } from '../layout';

export interface Pt {
  x: number;
  z: number;
}

/** A polyline offered to the graph. */
export interface GraphWay {
  id: string;
  cls: WayClass;
  path: readonly Pt[];
}

/** One enclosed polygon of the planar subdivision. */
export interface Face {
  /** Index into `PlanarGraph.faces`. */
  index: number;
  /** The ring, in world metres, with positive shoelace area. Never fewer than three points. */
  ring: Pt[];
  /** The rank of the way that drew the edge from `ring[i]` to `ring[i + 1]`. */
  cls: WayClass[];
  /** Half-edge index of the edge from `ring[i]` to `ring[i + 1]`, for boundary tracing. */
  he: number[];
  areaM2: number;
  cx: number;
  cz: number;
}

export interface PlanarGraph {
  nodes: Pt[];
  /** Undirected edges. Half-edge `2i` runs `a → b`; `2i + 1` runs `b → a`. */
  edges: { a: number; b: number; cls: WayClass }[];
  /** Face index for each half-edge; `-1` on an outer face. */
  faceOf: Int32Array;
  /** The next half-edge round the same face. */
  next: Int32Array;
  faces: Face[];
  /** What the planariser had to throw away, by reason. Nothing is discarded silently. */
  report: {
    inputWays: number;
    inputSegments: number;
    intersections: number;
    nodes: number;
    edges: number;
    /** Degree-1 chains removed before face extraction; each is a street that ends in a block. */
    prunedStubs: number;
    outerFaces: number;
    faces: number;
    /** Rings that came back with fewer than three distinct points. */
    degenerateFaces: number;
  };
}

const RANK: Readonly<Record<WayClass, number>> = { artery: 3, secondary: 2, local: 1, vicus: 0 };

/**
 * Snap tolerance for node identity, metres.
 *
 * Two ways that share a junction share a node in the authored table, so they arrive at
 * identical coordinates and any epsilon works for them. The number is for the *computed*
 * crossings: a segment cut at parameter `t` and the same crossing found from the other
 * segment's parameter `u` differ in the last bits, and a graph in which those are two nodes
 * has a zero-length edge and a slit face. 0.02 m is four orders below the narrowest street.
 */
const SNAP = 0.02;
const SNAP_INV = 1 / SNAP;

const nodeKey = (x: number, z: number): string =>
  `${Math.round(x * SNAP_INV)},${Math.round(z * SNAP_INV)}`;

export const polyArea = (p: readonly Pt[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const r = p[(i + 1) % p.length];
    a += q.x * r.z - r.x * q.z;
  }
  return a * 0.5;
};

/**
 * Clip a polygon to the half-plane *left of `a → b`, offset inward by `d`*.
 *
 * Sutherland–Hodgman against one line. Applied edge by edge round a ring this is the
 * **intersection of the inward half-planes**, which for a convex face is exactly the inset
 * and for a re-entrant one is a *subset* of it. The subset direction is the safe one — it can
 * never put a building outside a street — and `insetFace`'s caller counts the faces where it
 * bites.
 */
function clipHalf(poly: readonly Pt[], ax: number, az: number, bx: number, bz: number, d: number): Pt[] {
  const ex = bx - ax;
  const ez = bz - az;
  const len = Math.sqrt(ex * ex + ez * ez);
  if (len < 1e-9) return poly.slice();
  const off = d * len;
  const side = (p: Pt): number => ex * (p.z - az) - ez * (p.x - ax) - off;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    }
  }
  return out;
}

/** Drop points a clipper left within a hair of each other; a zero-length edge has no bearing. */
function dedupeRing(poly: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) continue;
    out.push(p);
  }
  if (out.length >= 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-4 && Math.abs(f.z - l.z) < 1e-4) out.pop();
  }
  return out;
}

/**
 * The buildable polygon of a face: the ring pulled in by each bounding edge's own setback.
 *
 * The ring is a chain of street **centrelines**, so the setback is half the carriageway plus
 * the rank's frontage — the same `WAY_WIDTH[cls] * 0.5 + WAY_FRONTAGE[cls]` the lattice this
 * replaces used for its own spines. Returns an empty array when nothing survives; that is a
 * result, and the caller records the reason rather than dropping it.
 */
export function insetFace(face: Face, setback: (cls: WayClass) => number): Pt[] {
  let poly: Pt[] = face.ring;
  for (let i = 0; i < face.ring.length && poly.length >= 3; i++) {
    const a = face.ring[i];
    const b = face.ring[(i + 1) % face.ring.length];
    poly = clipHalf(poly, a.x, a.z, b.x, b.z, setback(face.cls[i]));
  }
  const out = dedupeRing(poly);
  return out.length >= 3 ? out : [];
}

/**
 * **The bearing a block takes, and where it comes from.**
 *
 * The *longest* edge of the polygon, as a world bearing folded into `[−π/2, π/2)`. Longest
 * rather than, say, the mean of the edges weighted by length: a block's grain is set by the
 * street it fronts, and the street it fronts is the long side. A mean over four sides of a
 * quadrilateral whose two ends splay is the 45° between them, which is the worst answer
 * available and is the fault `wayBearingAt` had to quadruple its angles to avoid.
 */
export function faceBearing(poly: readonly Pt[]): number {
  /*
   * **The longest *side*, not the longest edge, and the difference cost half the fabric.**
   *
   * A face's ring is a chain of graph edges, and the planariser splits an edge at every node
   * on it — including the nodes a *neighbouring* block's cross-lanes put there. So a plain
   * rectangular block 80 m by 66 m comes back with sixteen edges, and the longest single one
   * of them can be a 30 m fragment of the 66 m side. Taking that as the block's grain turned
   * the frame ninety degrees, which turned the terrace ninety degrees, which made every
   * frontage's depth the block's *length* — measured: 82 % of frontages took the shallow
   * single-row branch and the city covered 26 % of its own block faces.
   *
   * So consecutive edges within a degree of each other are one side, and the longest side
   * wins. That is what "the street that bounds it" means: a street does not stop being one
   * street because a lane joins it halfway along.
   */
  const n = poly.length;
  let best = 0;
  let bestLen = -1;
  const bearingOf = (i: number): number => {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  const lenOf = (i: number): number => {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    return Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z));
  };
  const TOL = (1 * Math.PI) / 180;
  const near = (p: number, q: number): boolean => {
    let d = Math.abs(p - q) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d <= TOL;
  };
  // Start at an edge that begins a side, so a run that wraps the array is not cut in two.
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (!near(bearingOf(i), bearingOf((i - 1 + n) % n))) {
      start = i;
      break;
    }
  }
  let runLen = 0;
  let runBearing = bearingOf(start);
  for (let k = 0; k <= n; k++) {
    const i = (start + k) % n;
    if (k < n && (k === 0 || near(bearingOf(i), runBearing))) {
      runLen += lenOf(i);
      continue;
    }
    if (runLen > bestLen) {
      bestLen = runLen;
      best = runBearing;
    }
    if (k >= n) break;
    runBearing = bearingOf(i);
    runLen = lenOf(i);
  }
  // Fold: a block fronting its street and a block gable-end to it are the same grain, and
  // `probe-fabric` G20 folds the answer the same way.
  while (best >= Math.PI / 2) best -= Math.PI;
  while (best < -Math.PI / 2) best += Math.PI;
  return best;
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  cls: WayClass;
}

/**
 * Split every segment at every crossing, weld coincident endpoints, and hand back a graph
 * whose faces can be walked.
 *
 * The broadphase is a uniform grid on segment bounding boxes. Rome's armature plus the
 * generated cross-lanes is a few thousand segments; the pairwise test inside a cell is cheap
 * and the whole thing runs once per boot.
 */
export function planarise(ways: readonly GraphWay[]): PlanarGraph {
  const segs: Seg[] = [];
  for (const w of ways) {
    for (let i = 0; i + 1 < w.path.length; i++) {
      const a = w.path[i];
      const b = w.path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (dx * dx + dz * dz < 1e-6) continue;
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, cls: w.cls });
    }
  }

  // ---- broadphase ---------------------------------------------------------
  const CELL = 64;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL);
    const x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
    const z0 = Math.floor(Math.min(s.az, s.bz) / CELL);
    const z1 = Math.floor(Math.max(s.az, s.bz) / CELL);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const k = `${ix},${iz}`;
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }

  // ---- cut parameters -----------------------------------------------------
  const cuts: number[][] = segs.map(() => [0, 1]);
  let crossings = 0;
  const seen = new Set<number>();
  for (const list of cells.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p];
        const j = list[q];
        const pk = i < j ? i * 1000003 + j : j * 1000003 + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const s = segs[i];
        const t = segs[j];
        const rx = s.bx - s.ax;
        const rz = s.bz - s.az;
        const sx = t.bx - t.ax;
        const sz = t.bz - t.az;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-12) continue;
        const u = ((t.ax - s.ax) * sz - (t.az - s.az) * sx) / den;
        const v = ((t.ax - s.ax) * rz - (t.az - s.az) * rx) / den;
        if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
        crossings++;
        if (u > 1e-9 && u < 1 - 1e-9) cuts[i].push(u);
        if (v > 1e-9 && v < 1 - 1e-9) cuts[j].push(v);
      }
    }
  }

  // ---- nodes and edges ----------------------------------------------------
  const nodes: Pt[] = [];
  const nodeAt = new Map<string, number>();
  const node = (x: number, z: number): number => {
    const k = nodeKey(x, z);
    const got = nodeAt.get(k);
    if (got !== undefined) return got;
    nodes.push({ x, z });
    nodeAt.set(k, nodes.length - 1);
    return nodes.length - 1;
  };

  const edgeAt = new Map<string, number>();
  const edges: { a: number; b: number; cls: WayClass }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = cuts[i].slice().sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const na = node(s.ax + (s.bx - s.ax) * t0, s.az + (s.bz - s.az) * t0);
      const nb = node(s.ax + (s.bx - s.ax) * t1, s.az + (s.bz - s.az) * t1);
      if (na === nb) continue;
      const ek = na < nb ? `${na}:${nb}` : `${nb}:${na}`;
      const have = edgeAt.get(ek);
      if (have !== undefined) {
        // Two ways down the same line: the wider rank owns the edge, so a *vicus* laid over
        // the Via Lata does not demote it and pull the block in by 1.5 m instead of 31.
        if (RANK[s.cls] > RANK[edges[have].cls]) edges[have].cls = s.cls;
        continue;
      }
      edgeAt.set(ek, edges.length);
      edges.push({ a: na, b: nb, cls: s.cls });
    }
  }

  // ---- prune degree-1 chains ---------------------------------------------
  /*
   * A way that stops in the middle of a block leaves a dangling edge, and a dangling edge
   * turns the face around it into a ring that runs out along the stub and back — a slit with
   * zero area whose inset is undefined. The stub is still *drawn*: `buildWays` paves the way
   * table directly and never consults this graph. What is dropped here is the stub's claim to
   * bound a block, which it does not have.
   */
  const alive = edges.map(() => true);
  let prunedStubs = 0;
  for (;;) {
    const deg = new Int32Array(nodes.length);
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i]) continue;
      deg[edges[i].a]++;
      deg[edges[i].b]++;
    }
    let cut = 0;
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i]) continue;
      if (deg[edges[i].a] <= 1 || deg[edges[i].b] <= 1) {
        alive[i] = false;
        cut++;
      }
    }
    if (cut === 0) break;
    prunedStubs += cut;
  }
  const kept = edges.filter((_, i) => alive[i]);

  // ---- half-edges ---------------------------------------------------------
  const outgoing: number[][] = nodes.map(() => []);
  for (let i = 0; i < kept.length; i++) {
    outgoing[kept[i].a].push(2 * i);
    outgoing[kept[i].b].push(2 * i + 1);
  }
  const tail = (h: number): number => (h % 2 === 0 ? kept[h / 2].a : kept[(h - 1) / 2].b);
  const headOf = (h: number): number => (h % 2 === 0 ? kept[h / 2].b : kept[(h - 1) / 2].a);
  const angleOf = (h: number): number => {
    const a = nodes[tail(h)];
    const b = nodes[headOf(h)];
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  const slot: number[] = new Array(kept.length * 2).fill(0);
  for (const list of outgoing) {
    list.sort((p, q) => angleOf(p) - angleOf(q) || p - q);
    for (let i = 0; i < list.length; i++) slot[list[i]] = i;
  }
  const next = new Int32Array(kept.length * 2).fill(-1);
  for (let h = 0; h < kept.length * 2; h++) {
    const twin = h ^ 1;
    const v = tail(twin);
    const list = outgoing[v];
    const i = slot[twin];
    // The outgoing edge one step CLOCKWISE from the way we came in. With `outgoing` sorted
    // counter-clockwise that is the previous entry, wrapping. This is what makes an interior
    // face come out with a positive shoelace; see the file header.
    next[h] = list[(i - 1 + list.length) % list.length];
  }

  // ---- faces --------------------------------------------------------------
  const faceOf = new Int32Array(kept.length * 2).fill(-2);
  const faces: Face[] = [];
  let outerFaces = 0;
  let degenerate = 0;
  for (let h0 = 0; h0 < kept.length * 2; h0++) {
    if (faceOf[h0] !== -2) continue;
    const cycle: number[] = [];
    let h = h0;
    for (let guard = 0; guard < kept.length * 2 + 4; guard++) {
      cycle.push(h);
      faceOf[h] = -1;
      h = next[h];
      if (h === h0) break;
    }
    const ring: Pt[] = cycle.map((e) => nodes[tail(e)]);
    const area = polyArea(ring);
    if (area <= 0) {
      outerFaces++;
      continue;
    }
    if (ring.length < 3) {
      degenerate++;
      continue;
    }
    let cx = 0;
    let cz = 0;
    let w = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const cr = a.x * b.z - b.x * a.z;
      cx += (a.x + b.x) * cr;
      cz += (a.z + b.z) * cr;
      w += cr;
    }
    const f: Face = {
      index: faces.length,
      ring,
      cls: cycle.map((e) => kept[e >> 1].cls),
      he: cycle,
      areaM2: area,
      cx: Math.abs(w) > 1e-9 ? cx / (3 * w) : ring[0].x,
      cz: Math.abs(w) > 1e-9 ? cz / (3 * w) : ring[0].z,
    };
    for (const e of cycle) faceOf[e] = f.index;
    faces.push(f);
  }

  return {
    nodes,
    edges: kept,
    faceOf,
    next,
    faces,
    report: {
      inputWays: ways.length,
      inputSegments: segs.length,
      intersections: crossings,
      nodes: nodes.length,
      edges: kept.length,
      prunedStubs,
      outerFaces,
      faces: faces.length,
      degenerateFaces: degenerate,
    },
  };
}
