import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';

/**
 * Battlefield terrain: the Campus Martius flood plain and the northern approach to
 * Rome, rising toward the Quirinal and Pincian hills where the Aurelian Walls stand.
 *
 * PROVISIONAL IMPLEMENTATION — replaced by the terrain agent with a real
 * multi-resolution clipmap, splat-mapped triplanar PBR material and erosion-shaped
 * heightfield. The contracts below are stable and other systems depend on them:
 *   - `heightAt(x, z)`      metres above datum, bilinear-filtered
 *   - `normalAt(x, z, out)` unit surface normal
 *   - `slopeAt(x, z)`       0 (flat) .. 1 (vertical), for movement cost
 *   - `HALF_EXTENT`         battlefield half-size in metres
 */

export const HALF_EXTENT = 1400;

export class TerrainSystem implements Subsystem {
  readonly name = 'terrain';
  readonly order = -50;

  /** Heightfield resolution (samples per side). */
  private readonly res = 513;
  private heights = new Float32Array(this.res * this.res);
  private readonly spacing = (HALF_EXTENT * 2) / (this.res - 1);
  private mesh?: THREE.Mesh;

  init(ctx: EngineContext): void {
    this.generateHeights();

    const seg = 256;
    const geo = new THREE.PlaneGeometry(HALF_EXTENT * 2, HALF_EXTENT * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x7a7355,
      roughness: 0.95,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    ctx.scene.add(this.mesh);

    // Let the camera ride the ground instead of clipping through hills.
    ctx.rig.heightAt = (x, z) => this.heightAt(x, z);
    ctx.rig.setBounds(HALF_EXTENT * 0.92, HALF_EXTENT * 0.92);
  }

  /**
   * Provisional heightfield: broad valley floor with the Tiber trench to the west and
   * ground rising to the south-east where the city sits.
   */
  private generateHeights(): void {
    const { res } = this;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = i / (res - 1);
        const v = j / (res - 1);
        const wx = -HALF_EXTENT + u * HALF_EXTENT * 2;
        const wz = -HALF_EXTENT + v * HALF_EXTENT * 2;

        // Gentle rise toward the city (south-east).
        let h = 6 + (wz / HALF_EXTENT) * 14 + (wx / HALF_EXTENT) * 5;
        // Rolling undulation.
        h += Math.sin(wx * 0.0031) * 5.5 + Math.cos(wz * 0.0027) * 4.5;
        h += Math.sin(wx * 0.0092 + wz * 0.0071) * 2.2;
        h += Math.sin(wx * 0.021) * Math.cos(wz * 0.019) * 0.9;
        // Tiber channel along the western edge.
        const river = Math.exp(-Math.pow((wx + 760) / 130, 2));
        h -= river * 16;
        this.heights[j * res + i] = h;
      }
    }
  }

  /** Bilinear-filtered ground height. Clamps at the battlefield edge. */
  heightAt(x: number, z: number): number {
    const { res, spacing } = this;
    const fx = (x + HALF_EXTENT) / spacing;
    const fz = (z + HALF_EXTENT) / spacing;
    const i0 = Math.max(0, Math.min(res - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(res - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const h = this.heights;
    const a = h[j0 * res + i0];
    const b = h[j0 * res + i0 + 1];
    const c = h[(j0 + 1) * res + i0];
    const d = h[(j0 + 1) * res + i0 + 1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * tz;
  }

  /** Surface normal via central differences. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.spacing;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  /** 0 on the flat, approaching 1 on a cliff. Used as a movement-cost multiplier. */
  slopeAt(x: number, z: number): number {
    const e = this.spacing;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.min(1, Math.hypot(dx, dz));
  }

  /** Raw heightfield access for the vegetation and pathfinding systems. */
  get heightField(): { data: Float32Array; res: number; spacing: number; halfExtent: number } {
    return { data: this.heights, res: this.res, spacing: this.spacing, halfExtent: HALF_EXTENT };
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}
