import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { FACTIONS, SoldierState } from '../sim/types';
import { unitType } from './roster';

/**
 * Soldier rendering.
 *
 * PROVISIONAL — one instanced proxy mesh per faction, enough to read formations and
 * movement on screen. The units and animation agents replace this with:
 *   - properly modelled legionary / warrior meshes with kit variants
 *   - a vertex-animation-texture skinning path so every man animates on the GPU
 *   - three LODs plus a billboard impostor tier
 *   - a texture atlas so all variants share one draw call per LOD
 *
 * Contract kept stable for those replacements: this system reads
 * `BattleSystem.pool` and `.units` only, and writes nothing back.
 */

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3(1, 1, 1);
const tmpColour = new THREE.Color();
const rp = { x: 0, y: 0, z: 0 };

export class UnitRenderSystem implements Subsystem {
  readonly name = 'unitRender';
  readonly order = 200;

  private battle!: BattleSystem;
  private meshes = new Map<number, THREE.InstancedMesh>();

  init(ctx: EngineContext): void {
    this.battle = ctx.get<BattleSystem>('battle');

    for (const key of [0, 1]) {
      const geo = this.buildProxyGeometry();
      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.72,
        metalness: 0.15,
        vertexColors: true,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, ctx.quality.maxSoldiers);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = `soldiers-${FACTIONS[key as 0 | 1].shortName}`;
      // Per-instance tint carries the faction colour and per-man variation.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(ctx.quality.maxSoldiers * 3), 3
      );
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      ctx.scene.add(mesh);
      this.meshes.set(key, mesh);
    }
  }

  /**
   * A blocky stand-in soldier, roughly 1.75 m tall, built from merged boxes so the
   * silhouette reads as a shielded man rather than a capsule. Vertex colours mark
   * the regions the real material will later texture: skin, cloth, metal, wood.
   */
  private buildProxyGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, c: THREE.ColorRepresentation) => {
      g.translate(x, y, z);
      const col = new THREE.Color(c);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = col.r;
        arr[i * 3 + 1] = col.g;
        arr[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    };

    // torso, legs, head, helmet, shield, spear
    add(new THREE.BoxGeometry(0.44, 0.6, 0.26), 0, 1.16, 0, 0xffffff); // cloth (tinted per instance)
    add(new THREE.BoxGeometry(0.34, 0.52, 0.22), 0, 0.62, 0, 0x6b5a42); // legs
    add(new THREE.BoxGeometry(0.19, 0.2, 0.2), 0, 1.56, 0, 0xc99f76); // head/skin
    add(new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 1.6, 0, 0x9a8f6d); // helmet
    add(new THREE.BoxGeometry(0.06, 0.72, 0.5), -0.26, 1.1, 0.14, 0x8c5a3a); // shield
    add(new THREE.CylinderGeometry(0.022, 0.022, 2.1, 6), 0.26, 1.2, -0.02, 0x6f5638); // shaft

    // Manual merge to avoid pulling in BufferGeometryUtils for six boxes.
    let vTotal = 0;
    let iTotal = 0;
    for (const g of parts) {
      vTotal += g.attributes.position.count;
      iTotal += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const col = new Float32Array(vTotal * 3);
    const idx = new Uint16Array(iTotal);
    let vo = 0;
    let io = 0;
    for (const g of parts) {
      const gp = g.attributes.position as THREE.BufferAttribute;
      const gn = g.attributes.normal as THREE.BufferAttribute;
      const gc = g.attributes.color as THREE.BufferAttribute;
      pos.set(gp.array as Float32Array, vo * 3);
      nrm.set(gn.array as Float32Array, vo * 3);
      col.set(gc.array as Float32Array, vo * 3);
      if (g.index) {
        const gi = g.index.array;
        for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
        io += gi.length;
      } else {
        for (let k = 0; k < gp.count; k++) idx[io + k] = k + vo;
        io += gp.count;
      }
      vo += gp.count;
      g.dispose();
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  preRender(ctx: EngineContext): void {
    const b = this.battle;
    const p = b.pool;
    const alpha = ctx.time.alpha;
    const counts = new Map<number, number>([[0, 0], [1, 0]]);

    for (const u of b.units) {
      const def = unitType(u.typeId);
      const fac = FACTIONS[u.faction];
      const mesh = this.meshes.get(u.faction);
      if (!mesh) continue;
      let n = counts.get(u.faction)!;

      for (const i of u.members) {
        const st = p.state[i] as SoldierState;
        if (st === SoldierState.Dead && p.animTime[i] >= 1) {
          // Corpses still draw, flattened onto the ground.
        }
        b.renderPos(i, alpha, rp);
        const facing = b.renderFacing(i, alpha);

        const dying = st === SoldierState.Dying || st === SoldierState.Dead;
        if (dying) {
          // Fake the fall: rotate about the axis perpendicular to the death direction.
          const fall = Math.min(1, p.animTime[i] * 1.6);
          const ang = fall * Math.PI * 0.48;
          tmpQuat.setFromAxisAngle(
            new THREE.Vector3(p.deathDirZ[i], 0, -p.deathDirX[i]).normalize(),
            ang
          );
          const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);
          tmpQuat.premultiply(yaw);
        } else {
          tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);
          if (p.lean[i] > 0.001) {
            const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -p.lean[i]);
            tmpQuat.multiply(lean);
          }
        }

        // Bob the body on the walk cycle so movement reads even without real animation.
        const bob = st === SoldierState.Marching || st === SoldierState.Running
          ? Math.abs(Math.sin(p.animTime[i] * Math.PI * 2)) * 0.045
          : 0;

        tmpPos.set(rp.x, rp.y + bob, rp.z);
        const s = p.scale[i];
        tmpScale.set(s, s, s);
        tmpMat.compose(tmpPos, tmpQuat, tmpScale);
        mesh.setMatrixAt(n, tmpMat);

        // Tint: faction cloth colour, darkened by grime, varied per man.
        tmpColour.setHex(def.appearance.tunicColour);
        const v = 0.86 + p.variant[i] * 0.28;
        tmpColour.multiplyScalar(v * (1 - p.grime[i] * 0.45));
        if (u.selected) tmpColour.lerp(new THREE.Color(fac.accent), 0.28);
        mesh.setColorAt(n, tmpColour);

        n++;
        if (n >= mesh.instanceMatrix.count) break;
      }
      counts.set(u.faction, n);
    }

    for (const [fac, mesh] of this.meshes) {
      mesh.count = counts.get(fac)!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes.clear();
  }
}
