import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import {
  CLIP_BASE_SPACING,
  CLIP_CELLS,
  CLIP_SNAP,
  buildClipmapGeometry,
  clipmapTriangles,
} from './clipmap';
import { buildControlTexture, buildHeightTexture } from './fieldTextures';
import { loadGroundTextures, type GroundTextures } from './groundTextures';
import { buildTerrain, type TerrainData } from './heightfield';
import { createTerrainMaterial, type TerrainMaterialSet } from './TerrainMaterial';
import { HALF_EXTENT, WATER_LEVEL } from './topography';
import { GrassField } from './GrassField';
import { ScatterField } from './ScatterField';
import { RiverWater } from './RiverWater';

/**
 * Battlefield terrain: the Campus Martius flood plain and the northern approach to
 * Rome, rising toward the Quirinal and Pincian hills where the Aurelian Walls stand.
 *
 * Owns the whole ground stack — heightfield, clipmap geometry, splat material,
 * vegetation, scatter and the Tiber's water surface — so `main.ts` needs no extra
 * registrations. See `heightfield.ts` for the topography and `TerrainMaterial.ts` for
 * the shading.
 *
 * Public contract, depended on by the sim, the camera and the city:
 *   - `heightAt(x, z)`      metres above datum, bilinear-filtered, allocation-free
 *   - `normalAt(x, z, out)` unit surface normal
 *   - `slopeAt(x, z)`       0 (flat) .. 1 (vertical), for movement cost
 *   - `heightField`         raw field access for pathfinding and scatter
 *   - `HALF_EXTENT`         battlefield half-size in metres
 */

export { HALF_EXTENT } from './topography';

export class TerrainSystem implements Subsystem {
  readonly name = 'terrain';
  readonly order = -50;

  private data!: TerrainData;
  private heights!: Float32Array;
  private res = 0;
  private spacing = 1;

  private mesh?: THREE.Mesh;
  private matSet?: TerrainMaterialSet;
  private textures?: GroundTextures;
  private heightTex?: THREE.DataTexture;
  private controlTex?: THREE.DataTexture;

  private grass?: GrassField;
  private scatter?: ScatterField;
  private water?: RiverWater;

  /** Diagnostics surfaced in the console at boot. */
  stats = { buildMs: 0, triangles: 0, layersFromPack: '' };

  async init(ctx: EngineContext): Promise<void> {
    this.data = buildTerrain();
    this.heights = this.data.heights;
    this.res = this.data.res;
    this.spacing = this.data.spacing;

    // Install the ground sampler before anything else runs: the camera rig clamps its
    // eye height against it every frame and other systems query it during their init.
    ctx.rig.heightAt = (x, z) => this.heightAt(x, z);
    ctx.rig.setBounds(HALF_EXTENT * 0.92, HALF_EXTENT * 0.92);

    this.heightTex = buildHeightTexture(this.heights, this.res);
    this.controlTex = buildControlTexture(this.data.control, this.data.controlRes);
    this.textures = await loadGroundTextures();

    // Distant ground drifts to a little above the plain so the world reads as continuing
    // countryside rather than ending at the battlefield boundary.
    const farHeight = 13.5;
    this.matSet = createTerrainMaterial(
      this.textures,
      this.heightTex,
      this.controlTex,
      this.spacing,
      farHeight
    );

    const geo = buildClipmapGeometry();
    this.mesh = new THREE.Mesh(geo, this.matSet.material);
    this.mesh.customDepthMaterial = this.matSet.depthMaterial;
    this.mesh.receiveShadow = true;
    // Deliberately *not* casting. The clipmap's coarse outer levels have 8–32 m
    // triangles, and the outer shadow cascades cannot bias that against a fragment
    // normal computed at heightfield resolution: the far half of every frame breaks out
    // in a lattice of self-shadowing acne. A correct depth material exists
    // (`matSet.depthMaterial`) so this is one flag to flip once the lighting system has
    // slope-scaled bias per cascade — see the hand-off notes.
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.name = 'terrain';
    ctx.scene.add(this.mesh);

    this.water = new RiverWater(this);
    await this.water.init(ctx, this.textures, this.heightTex);

    this.scatter = new ScatterField(this);
    this.scatter.init(ctx);

    this.grass = new GrassField(this);
    this.grass.init(ctx, this.heightTex, this.controlTex);

    this.stats.buildMs = this.data.buildMs;
    this.stats.triangles = clipmapTriangles();
    this.stats.layersFromPack = this.textures.sourced.join(', ') || 'none (all procedural)';
    // One line at boot is worth having: it is the only way to tell whether the asset
    // pack was found without opening the network panel.
    console.info(
      `[terrain] ${this.res}² field in ${this.data.buildMs.toFixed(0)} ms, ` +
        `${(this.stats.triangles / 1000).toFixed(0)}k clipmap tris, ` +
        `pack layers: ${this.stats.layersFromPack}`
    );
  }

  update(dt: number, ctx: EngineContext): void {
    this.water?.update(dt, ctx);
    this.grass?.update(dt);
  }

  preRender(ctx: EngineContext): void {
    const cam = ctx.camera.position;
    // Snap the clipmap centre so every level's grid stays aligned with every other's;
    // that alignment is what makes the level seams watertight.
    const cx = Math.round(cam.x / CLIP_SNAP) * CLIP_SNAP;
    const cz = Math.round(cam.z / CLIP_SNAP) * CLIP_SNAP;
    const u = this.matSet?.uniforms.uClipCentre.value as THREE.Vector2 | undefined;
    if (u) u.set(cx, cz);

    this.grass?.preRender(ctx);
    this.scatter?.preRender(ctx);
    this.water?.preRender(ctx);
  }

  // ---------------------------------------------------------------------
  // Sampling contract. `heightAt` is called tens of thousands of times per tick by the
  // battle sim, so it stays a flat bilinear read with no allocation and no branches
  // beyond the edge clamp.
  // ---------------------------------------------------------------------

  heightAt(x: number, z: number): number {
    const res = this.res;
    const fx = (x + HALF_EXTENT) / this.spacing;
    const fz = (z + HALF_EXTENT) / this.spacing;
    let i0 = fx | 0;
    let j0 = fz | 0;
    if (i0 < 0) i0 = 0;
    else if (i0 > res - 2) i0 = res - 2;
    if (j0 < 0) j0 = 0;
    else if (j0 > res - 2) j0 = res - 2;
    let tx = fx - i0;
    let tz = fz - j0;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
    tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
    const h = this.heights;
    const r0 = j0 * res + i0;
    const r1 = r0 + res;
    const a = h[r0];
    const b = h[r0 + 1];
    const c = h[r1];
    const d = h[r1 + 1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * tz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = this.spacing;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  slopeAt(x: number, z: number): number {
    const e = this.spacing;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const m = Math.hypot(dx, dz);
    return m > 1 ? 1 : m;
  }

  get heightField(): { data: Float32Array; res: number; spacing: number; halfExtent: number } {
    return { data: this.heights, res: this.res, spacing: this.spacing, halfExtent: HALF_EXTENT };
  }

  /** RGBA control channels at a world position: wetness, bedrock, trampling, silt. */
  controlAt(x: number, z: number, out: { r: number; g: number; b: number; a: number }): void {
    const res = this.data.controlRes;
    const sp = (HALF_EXTENT * 2) / (res - 1);
    let i = Math.round((x + HALF_EXTENT) / sp);
    let j = Math.round((z + HALF_EXTENT) / sp);
    i = i < 0 ? 0 : i > res - 1 ? res - 1 : i;
    j = j < 0 ? 0 : j > res - 1 ? res - 1 : j;
    const o = (j * res + i) * 4;
    const c = this.data.control;
    out.r = c[o] / 255;
    out.g = c[o + 1] / 255;
    out.b = c[o + 2] / 255;
    out.a = c[o + 3] / 255;
  }

  /** Water surface height of the Tiber. Constant: it is a river, not a lake. */
  get waterLevel(): number {
    return WATER_LEVEL;
  }

  /** Finest clipmap triangle edge in metres — used by the grass to size its patches. */
  get finestSpacing(): number {
    return CLIP_BASE_SPACING;
  }

  /** Half-extent of the innermost clipmap level, in metres. */
  get nearFieldRadius(): number {
    return (CLIP_CELLS / 2) * CLIP_BASE_SPACING;
  }

  dispose(): void {
    this.grass?.dispose();
    this.scatter?.dispose();
    this.water?.dispose();
    this.mesh?.geometry.dispose();
    this.matSet?.dispose();
    this.textures?.dispose();
    this.heightTex?.dispose();
    this.controlTex?.dispose();
  }
}
