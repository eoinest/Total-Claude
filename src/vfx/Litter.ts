import * as THREE from 'three';
import type { BattleSystem } from '../sim/BattleSystem';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { FACTIONS } from '../sim/types';
import { hash01 } from '../util/rand';

/**
 * Battlefield litter: shields dropped where men fell, weapons let go of, helmets
 * knocked loose.
 *
 * One geometry, one draw call. Everything is a thin faceted disc, scaled
 * non-uniformly per instance: near-round for a shield, long and narrow for a blade or a
 * spear shaft, small and squat for a helmet. At the distances a battle is watched from
 * the silhouette on the ground is all that reads, and the alternative — a separate mesh
 * per object type — costs draw calls that the dust and blood need more.
 *
 * Objects are laid flat on the terrain and tilted onto its normal, so litter on a slope
 * follows the slope instead of hovering.
 */

enum Kind {
  Shield = 0,
  Blade = 1,
  Spear = 2,
  Helmet = 3,
}

/** Which missile left the shaft. Drives length, angle and shaft colour. */
export type ShaftKind = 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt';

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpNormal = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpColour = new THREE.Color();

export class LitterField {
  readonly mesh: THREE.InstancedMesh;

  private cap: number;
  private head = 0;
  private live = 0;
  private terrain?: TerrainSystem;
  private dirtyLo: number;
  private dirtyHi = -1;
  private wrote = 0;
  private wroteLast = 0;

  constructor(capacity: number, terrain: TerrainSystem | undefined) {
    this.cap = capacity;
    this.dirtyLo = capacity;
    this.terrain = terrain;

    const geo = this.buildGeometry();
    // Lambert, not Standard. Every one of these is a sub-metre object seen from tens of
    // metres away; the PBR terms that MeshStandardMaterial adds — IBL, split-sum
    // specular, roughness — are per-fragment work that cannot resolve on something two
    // pixels wide. Lambert keeps the sun, the ambient and the received shadow, which is
    // all that reads, at a fraction of the fragment cost for thousands of instances.
    //
    // Metalness is gone for a second reason too: a metallic slice of a blue sky IBL turned
    // every brown ash shaft into a navy splinter.
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'vfx-litter';
  }

  /**
   * A shallow ten-sided dish, 1 m across and 8 cm deep, with a raised centre. Read as
   * a shield boss from above; scaled thin it reads as a blade with a spine.
   */
  private buildGeometry(): THREE.BufferGeometry {
    const sides = 10;
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];

    // Centre (raised) then rim, top face.
    pos.push(0, 0.08, 0);
    nrm.push(0, 1, 0);
    col.push(1, 1, 1);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      pos.push(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
      // Splay the rim normals so the dish catches a rim highlight.
      const n = new THREE.Vector3(Math.cos(a) * 0.42, 0.9, Math.sin(a) * 0.42).normalize();
      nrm.push(n.x, n.y, n.z);
      col.push(0.82, 0.82, 0.82);
    }
    for (let s = 0; s < sides; s++) {
      idx.push(0, 1 + s, 1 + ((s + 1) % sides));
    }
    // Underside, so a shield seen from a low camera is not see-through.
    const base = pos.length / 3;
    pos.push(0, -0.02, 0);
    nrm.push(0, -1, 0);
    col.push(0.5, 0.5, 0.5);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      pos.push(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
      nrm.push(0, -1, 0);
      col.push(0.55, 0.55, 0.55);
    }
    for (let s = 0; s < sides; s++) {
      idx.push(base, base + 1 + ((s + 1) % sides), base + 1 + s);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /** Drop what a fallen man let go of. Called once per death. */
  dropFrom(index: number, x: number, y: number, z: number, battle: BattleSystem): void {
    const h1 = hash01(index, 401);
    const h2 = hash01(index, 409);
    const h3 = hash01(index, 419);
    const h4 = hash01(index, 431);

    const faction = index >= 0 ? battle.pool.faction[index] : 0;
    const unit = index >= 0 ? battle.unitById(battle.pool.unitId[index]) : undefined;
    const def = unit ? battle.typeOf(unit) : undefined;
    const hasShield = def ? def.appearance.shield !== 'none' : true;

    // Shields are heavy and get dropped; blades are held onto more often.
    if (hasShield && h1 < 0.62) {
      this.place(Kind.Shield, x + (h2 - 0.5) * 1.1, z + (h3 - 0.5) * 1.1, h4 * 6.283, faction, index);
    }
    if (h2 < 0.38) {
      const spear = def ? def.appearance.weapon === 'spear' || def.appearance.weapon === 'pike' : false;
      this.place(spear ? Kind.Spear : Kind.Blade, x + (h3 - 0.5) * 1.3, z + (h1 - 0.5) * 1.3, h2 * 6.283, faction, index + 1);
    }
    if (h3 < 0.16) {
      this.place(Kind.Helmet, x + (h1 - 0.5) * 1.0, z + (h2 - 0.5) * 1.0, h3 * 6.283, faction, index + 2);
    }
    void y;
  }

  /**
   * A spent shaft standing in the earth where a missile fell short.
   *
   * Rome II's fields fill with these, and they are the cheapest possible way to make a
   * battlefield read as *used*: after four thousand missiles a stretch of ground that
   * took two volleys is visibly bristling, and the density map of shafts is a record of
   * where the archers were aimed. Reuses the litter dish scaled to a sliver and tilted
   * out of the ground, so it costs no extra draw call and no extra material.
   */
  plantShaft(kind: ShaftKind, x: number, z: number, seed: number): void {
    // A sling stone leaves nothing behind, and a spent bolt is too small to read.
    if (kind === 'sling') return;

    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.live = Math.min(this.cap, this.live + 1);
    this.mesh.count = this.live;

    const h1 = hash01(seed, 641);
    const h2 = hash01(seed, 643);
    const h3 = hash01(seed, 647);

    const ground = this.terrain?.heightAt(x, z) ?? 0;

    // Visible length above ground, and elevation from horizontal. A plunging arrow
    // stands steeply; a flat-thrown pilum leans hard and often lies half over.
    let len: number;
    let elev: number;
    switch (kind) {
      case 'pilum':
        len = 1.45 + h1 * 0.60;
        elev = 0.62 + h2 * 0.55;
        tmpColour.setRGB(0.30, 0.245, 0.165);
        break;
      case 'javelin':
        len = 1.20 + h1 * 0.50;
        elev = 0.68 + h2 * 0.52;
        tmpColour.setRGB(0.33, 0.27, 0.18);
        break;
      case 'bolt':
        len = 0.62 + h1 * 0.26;
        elev = 0.85 + h2 * 0.5;
        tmpColour.setRGB(0.28, 0.23, 0.155);
        break;
      default: // arrow
        len = 0.70 + h1 * 0.34;
        elev = 0.95 + h2 * 0.45;
        tmpColour.setRGB(0.37, 0.31, 0.20);
        break;
    }
    // Weathered ash and hazel, varied so a cluster is not a uniform mat. The dish's face
    // normal points sideways once the shaft is tilted, so most shafts are edge-lit and
    // land darker than their albedo suggests; the extra gain compensates.
    tmpColour.multiplyScalar(1.05 + h3 * 0.5);

    // Rotate the dish's long axis (+Z) up by `elev`, then yaw it about the vertical.
    tmpQuat.setFromAxisAngle(X_AXIS, -elev);
    tmpQuat2.setFromAxisAngle(Y_AXIS, h3 * 6.283);
    tmpQuat.premultiply(tmpQuat2);

    // Section thick enough to survive a couple of pixels at battle range; a
    // geometrically honest 25 mm shaft is a shimmering sub-pixel line. Anything fatter
    // than this stops reading as a shaft and starts reading as a pale blade lying flat.
    tmpScale.set(0.075, 0.44, len);
    // The dish is centred on its long axis, so lift the centre by half the vertical
    // component to leave the head buried and the butt in the air.
    tmpPos.set(x, ground + Math.sin(elev) * len * 0.5, z);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    this.mesh.setMatrixAt(i, tmpMat);
    this.mesh.setColorAt(i, tmpColour);
    this.touch(i);
  }

  /**
   * Mark one instance dirty, accumulating a contiguous span for the frame.
   *
   * `needsUpdate = true` with no update range re-uploads the *entire* instance buffer: at
   * 7,000 instances that is 448 KB of matrices plus 84 KB of colours across the bus on
   * every frame in which a single man drops his shield — which, in a battle, is most of
   * them. But ranges have to *accumulate*: clearing them per item means that when six men
   * die in one frame, only the sixth item's matrix is uploaded and the other five keep
   * whatever was in the buffer before, which for a slot never written is the zero matrix —
   * and a zero matrix collapses an instance to a point at the world origin, i.e. litter
   * that silently does not exist.
   *
   * Placement walks a ring buffer, so a frame's writes are contiguous apart from the one
   * wrap; a single low..high span covers them with at most a few stale instances re-sent,
   * which is far cheaper than either a full upload or a per-item range list.
   */
  private touch(i: number): void {
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    this.wrote++;
  }

  /**
   * Upload this frame's placements. Must be called once per frame, after emission.
   */
  flush(): void {
    if (this.dirtyHi < this.dirtyLo) return;
    const lo = this.dirtyLo;
    const n = this.dirtyHi - lo + 1;
    const m = this.mesh.instanceMatrix;
    const c = this.mesh.instanceColor;
    m.clearUpdateRanges();
    if (c) c.clearUpdateRanges();
    // A span covering more than half the buffer costs more to describe than to send whole.
    if (n < this.cap * 0.5) {
      m.addUpdateRange(lo * 16, n * 16);
      if (c) c.addUpdateRange(lo * 3, n * 3);
    }
    m.needsUpdate = true;
    if (c) c.needsUpdate = true;
    this.dirtyLo = this.cap;
    this.dirtyHi = -1;
    this.wroteLast = this.wrote;
    this.wrote = 0;
  }

  /** Items placed on the last flushed frame. Diagnostic only. */
  get placedLastFrame(): number {
    return this.wroteLast;
  }

  private place(kind: Kind, x: number, z: number, yaw: number, faction: number, seed: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.live = Math.min(this.cap, this.live + 1);
    this.mesh.count = this.live;

    const ground = this.terrain?.heightAt(x, z) ?? 0;
    if (this.terrain) this.terrain.normalAt(x, z, tmpNormal);
    else tmpNormal.set(0, 1, 0);

    const h = hash01(seed, 887);
    switch (kind) {
      case Kind.Shield:
        // Scutum: 1.05 m tall, 0.8 m wide, curved. Lying flat it is a broad oval.
        tmpScale.set(0.82 + h * 0.12, 0.55, 1.08 + h * 0.14);
        tmpColour.setHex(FACTIONS[faction === 1 ? 1 : 0].clothColour);
        tmpColour.multiplyScalar(0.55 + h * 0.3);
        break;
      case Kind.Blade:
        tmpScale.set(0.13 + h * 0.04, 0.4, 0.92 + h * 0.2);
        tmpColour.setRGB(0.36, 0.37, 0.39);
        break;
      case Kind.Spear:
        tmpScale.set(0.075, 0.35, 2.3 + h * 0.5);
        tmpColour.setRGB(0.30, 0.23, 0.15);
        break;
      case Kind.Helmet:
        tmpScale.set(0.42, 1.5, 0.44);
        tmpColour.setRGB(0.42, 0.40, 0.33);
        break;
    }

    // Align to the ground normal, then spin about it.
    tmpQuat.setFromUnitVectors(UP, tmpNormal);
    tmpQuat2.setFromAxisAngle(tmpNormal, yaw);
    tmpQuat.premultiply(tmpQuat2);
    tmpPos.set(x, ground + 0.03, z);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    this.mesh.setMatrixAt(i, tmpMat);
    this.mesh.setColorAt(i, tmpColour);
    this.touch(i);
  }

  get count(): number {
    return this.live;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
