import * as THREE from 'three';
import type { UvRect } from './atlas';

/**
 * A small procedural geometry accumulator with skin weights.
 *
 * Soldier meshes are built in code, in the rig's rest pose, from swept tubes, lathed
 * profiles and boxes. Because each piece is generated along a known bone, its skin
 * weights are assigned explicitly rather than solved from proximity — no weight bleed
 * between a shield and the ribs it hangs in front of, and no envelope tuning.
 *
 * Two bone influences per vertex, which is all an armoured man needs: most of the mesh is
 * rigid plate, mail or leather riding one bone, and only the elbow, knee, shoulder and
 * waist blend. That halves the animation texture traffic in the vertex shader.
 */

const V = new THREE.Vector3();
const N = new THREE.Vector3();

/** One point of a swept sheet: position plus the outward normal of the front face. */
export interface SheetPoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  /** bone0, bone1, weight0, weight1 */
  readonly skin: number[] = [];
  /** piece id, tint slot, plus a spare UV pair for the shield facing */
  readonly pieceTint: number[] = [];
  readonly idx: number[] = [];

  /** Current transform applied to every emitted vertex. */
  private xf = new THREE.Matrix4();
  private nxf = new THREE.Matrix3();
  private piece = 0;
  private tint = 0;
  private b0 = 0;
  private b1 = 0;
  private w0 = 1;
  private auxU = 0;
  private auxV = 0;

  setPiece(piece: number, tint: number): this {
    this.piece = piece;
    this.tint = tint;
    return this;
  }

  setBone(b0: number, b1 = b0, w0 = 1): this {
    this.b0 = b0;
    this.b1 = b1;
    this.w0 = w0;
    return this;
  }

  /**
   * A second UV pair carried alongside the atlas UV.
   *
   * The shield facing needs both: the atlas coordinate so its normal and roughness come
   * from the plank tile, and a plain 0..1 panel coordinate so the fragment shader can
   * place a painted device from the emblem block. One spare pair on the piece attribute is
   * cheaper than a whole extra vertex attribute.
   */
  setAux(u: number, v: number): this {
    this.auxU = u;
    this.auxV = v;
    return this;
  }

  setMatrix(m: THREE.Matrix4 | null): this {
    if (m) this.xf.copy(m);
    else this.xf.identity();
    this.nxf.setFromMatrix4(this.xf).invert().transpose();
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    V.set(x, y, z).applyMatrix4(this.xf);
    N.set(nx, ny, nz).applyMatrix3(this.nxf).normalize();
    this.pos.push(V.x, V.y, V.z);
    this.nrm.push(N.x, N.y, N.z);
    this.uv.push(u, v);
    this.skin.push(this.b0, this.b1, this.w0, 1 - this.w0);
    this.pieceTint.push(this.piece, this.tint, this.auxU, this.auxV);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Map a 0..1 pair into an atlas tile, optionally tiling within it. */
  static tileUv(r: UvRect, s: number, t: number, repeatS = 1, repeatT = 1): [number, number] {
    const fs = repeatS === 1 ? Math.min(1, Math.max(0, s)) : (s * repeatS) % 1;
    const ft = repeatT === 1 ? Math.min(1, Math.max(0, t)) : (t * repeatT) % 1;
    return [r.u0 + fs * (r.u1 - r.u0), r.v0 + ft * (r.v1 - r.v0)];
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /**
   * A swept tube: a ring of `segments` vertices at each node, with an elliptical cross
   * section. Nodes carry their own bone binding so a limb can blend across a joint.
   */
  tube(
    nodes: readonly {
      y: number;
      /** Lateral and fore-aft radius. */
      rx: number;
      rz: number;
      /** Optional centre offset. */
      x?: number;
      z?: number;
      bone?: number;
      bone2?: number;
      w?: number;
    }[],
    segments: number,
    uv: UvRect,
    opts: { capStart?: boolean; capEnd?: boolean; repeatV?: number; repeatU?: number } = {}
  ): void {
    const rings: number[][] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.bone !== undefined) this.setBone(n.bone, n.bone2 ?? n.bone, n.w ?? 1);
      const ring: number[] = [];
      const t = i / (nodes.length - 1);
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        // Slope-aware normal so a tapering limb is not lit like a cylinder.
        let dy = 0;
        if (i > 0 && i < nodes.length - 1) {
          const dr = (nodes[i + 1].rx - nodes[i - 1].rx) / 2;
          const dyy = nodes[i + 1].y - nodes[i - 1].y;
          dy = dyy !== 0 ? dr / dyy : 0;
        }
        const [u, v] = MeshBuilder.tileUv(uv, s / segments, t, opts.repeatU ?? 1, opts.repeatV ?? 1);
        ring.push(
          this.vert(
            (n.x ?? 0) + cx * n.rx,
            n.y,
            (n.z ?? 0) + cz * n.rz,
            cx, -dy, cz,
            u, v
          )
        );
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        this.quad(rings[i][s], rings[i][s2], rings[i + 1][s2], rings[i + 1][s]);
      }
    }
    if (opts.capStart) this.cap(nodes[0], segments, uv, -1);
    if (opts.capEnd) this.cap(nodes[nodes.length - 1], segments, uv, 1);
  }

  private cap(
    n: { y: number; rx: number; rz: number; x?: number; z?: number; bone?: number; bone2?: number; w?: number },
    segments: number,
    uv: UvRect,
    dir: number
  ): void {
    if (n.bone !== undefined) this.setBone(n.bone, n.bone2 ?? n.bone, n.w ?? 1);
    const [cu, cv] = MeshBuilder.tileUv(uv, 0.5, 0.5);
    const centre = this.vert(n.x ?? 0, n.y, n.z ?? 0, 0, dir, 0, cu, cv);
    const ring: number[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const [u, v] = MeshBuilder.tileUv(uv, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      ring.push(
        this.vert((n.x ?? 0) + Math.cos(a) * n.rx, n.y, (n.z ?? 0) + Math.sin(a) * n.rz, 0, dir, 0, u, v)
      );
    }
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      if (dir > 0) this.tri(centre, ring[s], ring[s2]);
      else this.tri(centre, ring[s2], ring[s]);
    }
  }

  /**
   * A tube swept along an arbitrary 3D polyline.
   *
   * Needed for a quadruped, whose spine runs fore-and-aft through four bones and whose
   * neck leaves it at an angle: a Y-axis tube cannot express either. The ring frame is
   * built from the local direction and a reference up vector, so `rx` is always lateral
   * and `rz` always the perpendicular in the up plane.
   */
  sweep(
    nodes: readonly {
      p: readonly [number, number, number];
      rx: number;
      rz: number;
      bone?: number;
      bone2?: number;
      w?: number;
    }[],
    up: readonly [number, number, number],
    segments: number,
    uv: UvRect,
    opts: { capStart?: boolean; capEnd?: boolean; repeatU?: number; repeatV?: number } = {}
  ): void {
    const rings: number[][] = [];
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const upv = new THREE.Vector3(up[0], up[1], up[2]);
    const perp = new THREE.Vector3();

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.bone !== undefined) this.setBone(n.bone, n.bone2 ?? n.bone, n.w ?? 1);
      const a = nodes[Math.max(0, i - 1)].p;
      const c = nodes[Math.min(nodes.length - 1, i + 1)].p;
      dir.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      if (dir.lengthSq() < 1e-10) dir.set(0, 0, 1);
      dir.normalize();
      side.crossVectors(upv, dir);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      perp.crossVectors(dir, side).normalize();

      const t = i / (nodes.length - 1);
      const ring: number[] = [];
      for (let s = 0; s < segments; s++) {
        const ang = (s / segments) * Math.PI * 2;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const nx = side.x * ca * n.rz + perp.x * sa * n.rx;
        const ny = side.y * ca * n.rz + perp.y * sa * n.rx;
        const nz = side.z * ca * n.rz + perp.z * sa * n.rx;
        const [u, v] = MeshBuilder.tileUv(uv, s / segments, t, opts.repeatU ?? 1, opts.repeatV ?? 1);
        ring.push(
          this.vert(
            n.p[0] + side.x * ca * n.rx + perp.x * sa * n.rz,
            n.p[1] + side.y * ca * n.rx + perp.y * sa * n.rz,
            n.p[2] + side.z * ca * n.rx + perp.z * sa * n.rz,
            nx, ny, nz, u, v
          )
        );
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        this.quad(rings[i][s], rings[i][s2], rings[i + 1][s2], rings[i + 1][s]);
      }
    }
    const capAt = (i: number, sign: number): void => {
      const n = nodes[i];
      if (n.bone !== undefined) this.setBone(n.bone, n.bone2 ?? n.bone, n.w ?? 1);
      const a = nodes[Math.max(0, i - 1)].p;
      const c = nodes[Math.min(nodes.length - 1, i + 1)].p;
      dir.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize().multiplyScalar(sign);
      const [cu, cv] = MeshBuilder.tileUv(uv, 0.5, 0.5);
      const centre = this.vert(n.p[0], n.p[1], n.p[2], dir.x, dir.y, dir.z, cu, cv);
      const ring = rings[i];
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        if (sign > 0) this.tri(centre, ring[s], ring[s2]);
        else this.tri(centre, ring[s2], ring[s]);
      }
    };
    if (opts.capStart) capAt(0, -1);
    if (opts.capEnd) capAt(nodes.length - 1, 1);
  }

  /** A lathed profile of [radius, y] pairs revolved about the Y axis. */
  revolve(profile: readonly (readonly [number, number])[], segments: number, uv: UvRect, repeatU = 1): void {
    const rings: number[][] = [];
    for (let i = 0; i < profile.length; i++) {
      const [r, y] = profile[i];
      const ring: number[] = [];
      const t = i / (profile.length - 1);
      // Profile tangent for the normal.
      const p = profile[Math.max(0, i - 1)];
      const q = profile[Math.min(profile.length - 1, i + 1)];
      const dr = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dr, dy) || 1;
      const nr = dy / len;
      const ny = -dr / len;
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const [u, v] = MeshBuilder.tileUv(uv, s / segments, t, repeatU, 1);
        ring.push(this.vert(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a) * nr, ny, Math.sin(a) * nr, u, v));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        this.quad(rings[i][s], rings[i][s2], rings[i + 1][s2], rings[i + 1][s]);
      }
    }
  }

  /** An axis-aligned box centred at (cx, cy, cz). */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    uv: UvRect,
    repeat = 1
  ): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const faces: [number[], number[]][] = [
      [[1, 0, 0], [hx, hy, hz]],
      [[-1, 0, 0], [-hx, hy, -hz]],
      [[0, 1, 0], [hx, hy, -hz]],
      [[0, -1, 0], [hx, -hy, hz]],
      [[0, 0, 1], [-hx, hy, hz]],
      [[0, 0, -1], [hx, hy, -hz]],
    ];
    for (const [n] of faces) {
      const [nx, ny, nz] = n;
      // Build each face from its two in-plane axes.
      let ax: number[];
      let ay: number[];
      if (Math.abs(nx) > 0.5) { ax = [0, 0, nx]; ay = [0, 1, 0]; }
      else if (Math.abs(ny) > 0.5) { ax = [ny, 0, 0]; ay = [0, 0, 1]; }
      else { ax = [nz, 0, 0]; ay = [0, 1, 0]; }
      const ex = [ax[0] * hx, ax[1] * hy, ax[2] * hz];
      const ey = [ay[0] * hx, ay[1] * hy, ay[2] * hz];
      const c = [cx + nx * hx, cy + ny * hy, cz + nz * hz];
      const v: number[] = [];
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const [u, vv] = MeshBuilder.tileUv(uv, (su + 1) / 2, (sv + 1) / 2, repeat, repeat);
        v.push(this.vert(
          c[0] + ex[0] * su + ey[0] * sv,
          c[1] + ex[1] * su + ey[1] * sv,
          c[2] + ex[2] * su + ey[2] * sv,
          nx, ny, nz, u, vv
        ));
      }
      this.quad(v[0], v[1], v[2], v[3]);
    }
  }

  /**
   * A dished or cylindrically curved shield panel in the XY plane, bulging toward +Z.
   *
   * `curve` is the sagitta in metres: a legionary scutum is a section of a cylinder about
   * 0.30 m deep across its width, which is what makes it wrap the body.
   */
  shieldPanel(
    halfW: number,
    halfH: number,
    curve: number,
    thickness: number,
    cols: number,
    rows: number,
    faceUv: UvRect,
    edgeUv: UvRect,
    faceTint: number,
    edgeTint: number,
    shape: (sx: number, sy: number) => number,
    piece: number
  ): void {
    const z = (sx: number): number => curve * (1 - sx * sx);
    const front: number[][] = [];
    const back: number[][] = [];

    this.setPiece(piece, faceTint);
    for (let r = 0; r <= rows; r++) {
      const sy = (r / rows) * 2 - 1;
      const fRow: number[] = [];
      for (let c = 0; c <= cols; c++) {
        const sx = (c / cols) * 2 - 1;
        const w = shape(sx, sy);
        const x = sx * halfW * w;
        const y = sy * halfH;
        // Face normal from the cylindrical curvature.
        const slope = -2 * curve * sx / halfW;
        const len = Math.hypot(slope, 1);
        const [u, v] = MeshBuilder.tileUv(faceUv, (sx + 1) / 2, (sy + 1) / 2);
        this.setAux((sx + 1) / 2, (sy + 1) / 2);
        fRow.push(this.vert(x, y, z(sx) + thickness * 0.5, slope / len, 0, 1 / len, u, v));
      }
      front.push(fRow);
    }
    this.setPiece(piece, edgeTint);
    this.setAux(0, 0);
    for (let r = 0; r <= rows; r++) {
      const sy = (r / rows) * 2 - 1;
      const bRow: number[] = [];
      for (let c = 0; c <= cols; c++) {
        const sx = (c / cols) * 2 - 1;
        const w = shape(sx, sy);
        const [u, v] = MeshBuilder.tileUv(edgeUv, (sx + 1) / 2, (sy + 1) / 2);
        bRow.push(this.vert(sx * halfW * w, sy * halfH, z(sx) - thickness * 0.5, 0, 0, -1, u, v));
      }
      back.push(bRow);
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.quad(front[r][c], front[r][c + 1], front[r + 1][c + 1], front[r + 1][c]);
        this.quad(back[r][c], back[r + 1][c], back[r + 1][c + 1], back[r][c + 1]);
      }
    }
    // Rim: stitch the two shells together around the border.
    for (let c = 0; c < cols; c++) {
      this.quad(front[0][c + 1], front[0][c], back[0][c], back[0][c + 1]);
      this.quad(front[rows][c], front[rows][c + 1], back[rows][c + 1], back[rows][c]);
    }
    for (let r = 0; r < rows; r++) {
      this.quad(front[r][0], front[r + 1][0], back[r + 1][0], back[r][0]);
      this.quad(front[r + 1][cols], front[r][cols], back[r][cols], back[r + 1][cols]);
    }
  }

  /**
   * A double-sided sheet: cloak, mane, banner.
   *
   * Emitted as two independent windings with opposite normals rather than one winding drawn
   * with `DoubleSide`. That matters because the material culls backfaces for fill-rate
   * reasons, and because a reversed triangle sharing a front-facing normal lights as a flat
   * slab — which is exactly how a cloak reads if you get this wrong.
   *
   * `thickness` separates the two shells along the surface normal and stitches a rim between
   * them, which is what turns a sheet into cloth. At zero the two shells are coincident: the
   * silhouette is then a mathematical line, the edge z-fights with itself, and the garment
   * reads as an infinitely thin decal wrapped on a cone — which is the specific complaint
   * ("zero-thickness cloth", "a rigid unlit cone") that blind critics have made about the
   * sagum in several rounds. A real woollen sagum is 3-5 mm of fulled cloth and hangs with a
   * visible edge; 6 mm here is deliberately a shade over life size, because a sub-pixel edge
   * buys nothing and the extra millimetre is what makes the hem catch the light.
   */
  sheet(
    rows: number,
    cols: number,
    at: (u: number, v: number, out: SheetPoint) => void,
    bindOf: (v: number) => { bone: number; bone2: number; w: number },
    uv: UvRect,
    repeatU = 1,
    repeatV = 1,
    thickness = 0
  ): void {
    const p: SheetPoint = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
    /** Both shells' rings, so the rim can be stitched between them afterwards. */
    const shells: number[][][] = [];
    for (const facing of [1, -1]) {
      const grid: number[][] = [];
      for (let r = 0; r <= rows; r++) {
        const tv = r / rows;
        const bind = bindOf(tv);
        this.setBone(bind.bone, bind.bone2, bind.w);
        const row: number[] = [];
        for (let c = 0; c <= cols; c++) {
          const tu = c / cols;
          at(tu, tv, p);
          const [u, v] = MeshBuilder.tileUv(uv, tu, tv, repeatU, repeatV);
          // Push each shell a half-thickness along its own outward normal.
          const nl = Math.hypot(p.nx, p.ny, p.nz) || 1;
          const off = (facing * thickness) / (2 * nl);
          row.push(this.vert(
            p.x + p.nx * off, p.y + p.ny * off, p.z + p.nz * off,
            p.nx * facing, p.ny * facing, p.nz * facing, u, v
          ));
        }
        grid.push(row);
      }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (facing > 0) this.quad(grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]);
          else this.quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
        }
      }
      shells.push(grid);
    }
    if (thickness <= 0) return;
    // Rim. Front shell is shells[0], back is shells[1]; both are indexed [row][col].
    const [f, bk] = shells;
    for (let c = 0; c < cols; c++) {
      this.quad(f[0][c + 1], f[0][c], bk[0][c], bk[0][c + 1]);
      this.quad(f[rows][c], f[rows][c + 1], bk[rows][c + 1], bk[rows][c]);
    }
    for (let r = 0; r < rows; r++) {
      this.quad(f[r][0], f[r + 1][0], bk[r + 1][0], bk[r][0]);
      this.quad(f[r + 1][cols], f[r][cols], bk[r][cols], bk[r + 1][cols]);
    }
  }

  /**
   * Finalise as an `InstancedBufferGeometry`.
   *
   * Instanced rather than plain so three issues one `drawElementsInstanced` per LOD; the
   * per-instance attributes are added by the render system afterwards.
   */
  toGeometry(name: string): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aSkin', new THREE.BufferAttribute(new Float32Array(this.skin), 4));
    g.setAttribute('aPieceTint', new THREE.BufferAttribute(new Float32Array(this.pieceTint), 4));
    const max = this.pos.length / 3;
    g.setIndex(
      max > 65535
        ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1)
        : new THREE.BufferAttribute(new Uint16Array(this.idx), 1)
    );
    // Culling is done per instance on the CPU, so the geometry's own sphere is only used
    // by three's sanity checks; make it big enough to never be the reason a draw is skipped.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 4);
    g.name = name;
    return g;
  }
}
