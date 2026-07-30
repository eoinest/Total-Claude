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

  constructor(capacity: number, terrain: TerrainSystem | undefined) {
    this.cap = capacity;
    this.terrain = terrain;

    const geo = this.buildGeometry();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.22,
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
        len = 1.25 + h1 * 0.55;
        elev = 0.62 + h2 * 0.55;
        tmpColour.setRGB(0.30, 0.245, 0.175);
        break;
      case 'javelin':
        len = 1.05 + h1 * 0.5;
        elev = 0.68 + h2 * 0.52;
        tmpColour.setRGB(0.33, 0.27, 0.19);
        break;
      case 'bolt':
        len = 0.55 + h1 * 0.25;
        elev = 0.85 + h2 * 0.5;
        tmpColour.setRGB(0.27, 0.22, 0.16);
        break;
      default: // arrow
        len = 0.60 + h1 * 0.32;
        elev = 0.95 + h2 * 0.45;
        tmpColour.setRGB(0.38, 0.32, 0.22);
        break;
    }
    // Weathered wood in sunlight, varied so a cluster is not a uniform grey mat.
    tmpColour.multiplyScalar(0.8 + h3 * 0.5);

    // Rotate the dish's long axis (+Z) up by `elev`, then yaw it about the vertical.
    tmpQuat.setFromAxisAngle(X_AXIS, -elev);
    tmpQuat2.setFromAxisAngle(Y_AXIS, h3 * 6.283);
    tmpQuat.premultiply(tmpQuat2);

    // Section thick enough to survive a couple of pixels at battle range; a
    // geometrically honest 25 mm shaft is a shimmering sub-pixel line.
    tmpScale.set(0.135, 0.62, len);
    // The dish is centred on its long axis, so lift the centre by half the vertical
    // component to leave the head buried and the butt in the air.
    tmpPos.set(x, ground + Math.sin(elev) * len * 0.5, z);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    this.mesh.setMatrixAt(i, tmpMat);
    this.mesh.setColorAt(i, tmpColour);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
