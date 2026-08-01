import * as THREE from 'three';
import { makeEngineMaterial, type EngineMaterialSet } from '../units/engineMaterial';
import { buildOnagerGeometry, buildScorpioGeometry } from '../units/engineMesh';
import {
  CREW_OF, EngineKind, EnginePhase, STATIONS_OF, armStateOf, crewClip, emptyPose,
  enginePose, sliderZOf, stationJitter, type CrewStation, type EnginePose,
} from '../units/engines';

/**
 * Siege engines, posed by hand.
 *
 * The machines are instanced the same way the men are, but articulated rather than skinned:
 * one attribute, `iState`, carries the arm sweep, the slider position, the recoil ring and
 * whether a bolt is in the groove, and `engineMesh.ts` moves the right parts in the vertex
 * shader from the part id. So "show me the machine at half draw" is a single float, and the
 * viewer can scrub the whole loading cycle without a simulation behind it.
 *
 * `enginePose(t, reload)` is reused rather than re-derived: the ease on the windlass, the
 * 4 Hz damped recoil and the moment the bolt appears are all timing decisions taken in that
 * file, and a viewer that invented its own would be showing a machine the game never draws.
 */

const CAP = 8;

interface Tier {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attrs: { iPos: THREE.InstancedBufferAttribute; iOrient: THREE.InstancedBufferAttribute; iState: THREE.InstancedBufferAttribute };
  pos: Float32Array;
  orient: Float32Array;
  state: Float32Array;
  count: number;
  tris: number;
}

export interface EngineView {
  kind: EngineKind;
  x: number;
  z: number;
  yaw: number;
  /** Muzzle elevation, radians. */
  elev: number;
  /** Seconds since the last shot; drives the whole cycle. */
  sinceShot: number;
  /** The unit's reload gap, seconds — the windlass's clock. */
  reload: number;
  variant: number;
  /** An abandoned gun: string forward, groove empty, muzzle down. */
  abandoned: boolean;
}

export class EngineRig {
  readonly group = new THREE.Group();
  private readonly mat: EngineMaterialSet;
  private readonly tiers = new Map<EngineKind, Tier>();
  private readonly pose: EnginePose = emptyPose();
  private readonly jitter: [number, number, number] = [0, 0, 0];

  constructor(base: THREE.MeshStandardMaterialParameters) {
    // 2.4 rather than the soldiers' 2.9: timber and cord are dielectric and only the
    // fittings are metal, which is the same split the game makes.
    this.mat = makeEngineMaterial({ ...base, envMapIntensity: 2.4 });
    this.group.name = 'viewer-engines';
  }

  private tier(kind: EngineKind): Tier {
    let t = this.tiers.get(kind);
    if (t) return t;

    const geometry = kind === EngineKind.Onager ? buildOnagerGeometry() : buildScorpioGeometry();
    const pos = new Float32Array(CAP * 3);
    const orient = new Float32Array(CAP * 4);
    const state = new Float32Array(CAP * 4);
    const attr = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs = { iPos: attr(pos, 3), iOrient: attr(orient, 4), iState: attr(state, 4) };
    geometry.setAttribute('iPos', attrs.iPos);
    geometry.setAttribute('iOrient', attrs.iOrient);
    geometry.setAttribute('iState', attrs.iState);
    geometry.instanceCount = 0;

    const mesh = new THREE.Mesh(geometry, this.mat.material);
    mesh.name = kind === EngineKind.Onager ? 'viewer-onager' : 'viewer-scorpio';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.customDepthMaterial = this.mat.depth;
    mesh.customDistanceMaterial = this.mat.distance;
    mesh.visible = false;
    this.group.add(mesh);

    const idx = geometry.getIndex();
    t = { mesh, geometry, attrs, pos, orient, state, count: 0, tris: idx ? idx.count / 3 : 0 };
    this.tiers.set(kind, t);
    return t;
  }

  triangles(kind: EngineKind): number {
    return this.tier(kind).tris;
  }

  begin(): void {
    for (const t of this.tiers.values()) t.count = 0;
  }

  /** Push one machine and return the pose it was drawn in, so the crew can match it. */
  push(v: EngineView): EnginePose {
    const t = this.tier(v.kind);
    const n = t.count;
    const pose = v.abandoned
      ? Object.assign(this.pose, { draw: 0, recoil: 0, loaded: 0, phase: EnginePhase.Recover })
      : enginePose(v.sinceShot, v.reload, this.pose);
    if (n >= CAP) return pose;

    t.pos[n * 3] = v.x;
    t.pos[n * 3 + 1] = 0;
    t.pos[n * 3 + 2] = v.z;
    const o = n * 4;
    t.orient[o] = v.yaw;
    t.orient[o + 1] = 1;
    t.orient[o + 2] = v.abandoned ? -0.06 : v.elev;
    t.orient[o + 3] = v.variant;
    t.state[o] = armStateOf(v.kind, pose.draw);
    t.state[o + 1] = sliderZOf(pose.draw);
    t.state[o + 2] = pose.recoil;
    t.state[o + 3] = pose.loaded;
    t.count = n + 1;
    return pose;
  }

  /**
   * Where this machine's crew stand and what they are doing.
   *
   * The stations are the game's own, jitter included: a crew standing on exact marks is one
   * of the things that makes a battery read as furniture rather than as men working.
   */
  crew(v: EngineView, pose: EnginePose): { x: number; z: number; yaw: number; clip: number; station: CrewStation }[] {
    const table = STATIONS_OF[v.kind];
    const out: { x: number; z: number; yaw: number; clip: number; station: CrewStation }[] = [];
    const cu = Math.cos(v.yaw);
    const su = Math.sin(v.yaw);
    for (let s = 0; s < CREW_OF[v.kind]; s++) {
      const st = table[s % table.length];
      stationJitter((v.variant + s * 0.173) % 1, this.jitter);
      const lx = st.x + this.jitter[0];
      const lz = st.z + this.jitter[1];
      out.push({
        x: v.x + lx * cu + lz * su,
        z: v.z - lx * su + lz * cu,
        yaw: v.yaw + st.turn + this.jitter[2] * 0.4,
        clip: crewClip(v.kind, s, pose.phase),
        station: st,
      });
    }
    return out;
  }

  end(): void {
    for (const t of this.tiers.values()) {
      t.geometry.instanceCount = t.count;
      t.mesh.visible = t.count > 0;
      if (t.count === 0) continue;
      for (const a of Object.values(t.attrs)) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, t.count * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  setDebugParts(on: boolean): void {
    this.mat.setDebugParts(on);
  }

  /**
   * Triangles the machines rasterise this frame.
   *
   * All of them, unlike a soldier: an engine's geometry carries no kit mask, so nothing is
   * collapsed and submitted equals drawn. Exposed separately so the readout's scene total is
   * the whole frame rather than just the men — an earlier pass counted only the crew and
   * under-reported a scorpio battery by two thirds.
   */
  get drawnTotal(): number {
    let n = 0;
    for (const t of this.tiers.values()) n += t.count * t.tris;
    return n;
  }

  drawnMeshes(): { name: string; count: number; tris: number }[] {
    const out: { name: string; count: number; tris: number }[] = [];
    for (const t of this.tiers.values()) {
      if (t.count > 0) out.push({ name: t.mesh.name, count: t.count, tris: t.tris });
    }
    return out;
  }

  dispose(): void {
    for (const t of this.tiers.values()) t.geometry.dispose();
    this.tiers.clear();
    this.mat.dispose();
    this.group.clear();
  }
}
