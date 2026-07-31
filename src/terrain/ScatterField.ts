import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import { hash2 } from '../util/rand';
import { fbm, sstep } from './noise';
import {
  buildBush,
  buildReeds,
  buildRock,
  buildSpecies,
  cellUv,
  createFoliageAtlas,
  type AtlasCell,
  type Species,
} from './proceduralPlants';
import { HALF_EXTENT, crestZAt } from './topography';
import type { ScatterProfile } from '../maps/types';
import type { TerrainSystem } from './TerrainSystem';

/**
 * Trees, scrub, reeds, rocks.
 *
 * Placement is deterministic: one candidate per lattice cell, jittered and accepted by
 * `hash2(cellX, cellZ)` from `util/rand`, so the same wood grows in the same place every
 * run and nothing depends on `Math.random`. Candidates are rejected inside the deployment
 * boxes, on the road, in the river channel, in the quarries and on anything too steep,
 * which is what stops vegetation from looking sprinkled: it is the exclusions, not the
 * distribution, that make a landscape read as used.
 *
 * **Which species goes where is the map's decision, not this file's.** A `ScatterProfile`
 * supplies the placement rules; this class owns only the lattice, the exclusion bookkeeping,
 * the instancing and the three detail tiers. On the Campus Martius that means willows on the
 * Tiber terrace and cypresses along the Via Flaminia; on the plain of Pydna it means terraced
 * olive groves and an all-but-empty pasture. Neither set of rules lives here.
 *
 * Three detail tiers. Every tree is in exactly one of them each frame, reassigned only
 * when the camera has moved far enough to matter.
 */

const NEAR_DIST = 115;
const MID_DIST = 440;
const NEAR_CAPACITY = 340;

/**
 * Keep-out around the Aurelian Wall, measured from `crestZAt(x)` — the line the city
 * agent builds the curtain along.
 *
 * Outward: a besieged city clears its glacis. Aurelian's engineers demolished and felled
 * everything within bowshot of the new circuit, and the frames showed 20 m umbrella pines
 * standing *through* the curtain, which is both a defensive absurdity and a hard clipping
 * artefact. Inward: everything behind the crest is the city's ground, and `CitySystem`
 * plants its own cypresses and garden trees there.
 */
const WALL_CLEAR_OUT = 30;
/** Understorey scrub may grow closer than a tree — it cannot poke through masonry. */
const WALL_CLEAR_SCRUB_OUT = 11;
/** Loose stone is allowed right up to the footing, but never on a city street. */
const WALL_CLEAR_ROCK_OUT = 2;

interface Placed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

interface SpeciesGroup {
  species: Species;
  lod0: THREE.InstancedMesh;
  lod1: THREE.InstancedMesh;
  items: Placed[];
  height: number;
  billboard: AtlasCell;
}


export class ScatterField {
  private groups: SpeciesGroup[] = [];
  private billboards?: THREE.InstancedMesh;
  private billboardItems: { g: number; i: number }[] = [];
  private atlas?: THREE.DataTexture;
  private materials: THREE.Material[] = [];
  private simple: THREE.InstancedMesh[] = [];
  private lastLodPos = new THREE.Vector3(1e9, 0, 1e9);
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private s3 = new THREE.Vector3();

  /**
   * Whether this map has a city wall to keep clear of. The Aurelian curtain is fitted to the
   * `crestZAt` line, so on the Campus Martius nothing may be planted or dropped past it; on a
   * field battle there is no wall and the whole map is plantable.
   */
  private readonly hasWall: boolean;

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly profile: ScatterProfile,
    hasWall: boolean,
  ) {
    this.hasWall = hasWall;
  }

  init(ctx: EngineContext): void {
    this.atlas = createFoliageAtlas();

    const foliage = new THREE.MeshStandardMaterial({
      map: this.atlas,
      // Alpha test rather than blending: foliage must write depth or a wood turns into a
      // sorting nightmare, and at these leaf densities the hard edge is invisible.
      alphaTest: 0.42,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    foliage.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  // Leaf cards are double-sided so a crown reads from every bearing, but three's
  // DOUBLE_SIDED handling flips the normal on back faces — which pointed half of every
  // canopy away from the sun and rendered it flat black, so an olive read as a
  // half-white, half-black blob. A canopy is a translucent mass of leaves, not a solid
  // surface: keep the authored outward normal on both faces.
  normal = normalize(vNormal);
  nonPerturbedNormal = normal;`
        )
        // Leaves lit from behind glow rather than going dark. Small, because these are
        // holm oak and olive, not birch.
        .replace(
          '#include <emissivemap_fragment>',
          'totalEmissiveRadiance += diffuseColor.rgb * 0.16;'
        );
    };
    foliage.customProgramCacheKey = () => 'veg-foliage-twosided-v1';
    this.materials.push(foliage);

    const trees = this.placeTrees();

    for (const species of this.profile.species as readonly Species[]) {
      const items = trees.get(species) ?? [];
      if (items.length === 0) continue;
      const geo = buildSpecies(species);
      const lod0 = new THREE.InstancedMesh(geo.lod0, foliage, Math.min(items.length, NEAR_CAPACITY));
      const lod1 = new THREE.InstancedMesh(geo.lod1, foliage, items.length);
      for (const m of [lod0, lod1]) {
        m.count = 0;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.name = `veg-${species}`;
        ctx.scene.add(m);
      }
      this.groups.push({ species, lod0, lod1, items, height: geo.height, billboard: geo.billboard });
    }

    this.buildBillboards(ctx, foliage);
    this.buildUnderstorey(ctx, foliage);
    this.buildRocks(ctx);
  }

  // ---------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------

  /**
   * True where nothing should be planted: parade ground, carriageway, water, quarry, and
   * the cleared strip either side of the city wall.
   *
   * `clearOut` lets scrub creep closer to the masonry than a 20 m pine may.
   */
  private excluded(
    x: number,
    z: number,
    h: number,
    slope: number,
    clearOut = WALL_CLEAR_OUT
  ): boolean {
    return this.profile.excluded(x, z, h, slope, clearOut);
  }

  /**
   * Distance from a point to the wall line, negative inside the city. Exposed for the
   * shot-side assertion that the keep-out actually holds. Meaningless on a map with no city,
   * where it reports everything as clear.
   */
  wallClearance(x: number, z: number): number {
    return this.profile.species.length > 0 && this.hasWall ? crestZAt(x) - z : Infinity;
  }

  private placeTrees(): Map<Species, Placed[]> {
    const out = new Map<Species, Placed[]>();
    for (const s of this.profile.species as readonly Species[]) out.set(s, []);
    const ctl = { r: 0, g: 0, b: 0, a: 0 };

    // 21 m lattice: about 17,700 candidates over the field, of which a few per cent
    // survive. Coarse enough to be cheap, fine enough that a wood is not a grid.
    const cell = 21;
    const n = Math.floor((HALF_EXTENT * 2) / cell);
    for (let gj = 0; gj < n; gj++) {
      for (let gi = 0; gi < n; gi++) {
        const h1 = hash2(gi, gj, 11);
        const h2 = hash2(gi, gj, 23);
        const h3 = hash2(gi, gj, 37);
        const h4 = hash2(gi, gj, 53);
        const x = -HALF_EXTENT + (gi + 0.5) * cell + (h1 - 0.5) * cell * 0.92;
        const z = -HALF_EXTENT + (gj + 0.5) * cell + (h2 - 0.5) * cell * 0.92;
        const h = this.terrain.heightAt(x, z);
        const slope = this.terrain.slopeAt(x, z);
        if (this.excluded(x, z, h, slope)) continue;
        this.terrain.controlAt(x, z, ctl);

        const pick = this.profile.tree(x, z, h, slope, ctl, h3);
        if (!pick || h4 > pick.density) continue;
        const bucket = out.get(pick.species as Species);
        if (!bucket) continue;

        bucket.push({
          x,
          y: h,
          z,
          yaw: hash2(gi, gj, 71) * Math.PI * 2,
          scale: 0.72 + hash2(gi, gj, 89) * 0.62,
        });
      }
    }
    return out;
  }

  private buildBillboards(ctx: EngineContext, _foliage: THREE.Material): void {
    let total = 0;
    for (const g of this.groups) total += g.items.length;
    if (total === 0) return;

    // A single unit quad, pivoted at its base, sized and textured per instance.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3)
    );
    geo.setAttribute(
      'normal',
      // Straight up, matching the grass: it keeps the far tier's brightness close to the
      // mid tier's average instead of flashing as the camera turns.
      new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3)
    );
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const rects = new Float32Array(total * 4);
    geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(rects, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.MeshStandardMaterial({
      map: this.atlas!,
      alphaTest: 0.4,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aAtlas;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = aAtlas.xy + uv * aAtlas.zw;')
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
  // Y-locked billboard: the card swings to face the camera about the world up axis, so
  // the trunk stays vertical however far the camera pitches over.
  vec3 iPos = vec3(instanceMatrix[3].xyz);
  float bw = length(instanceMatrix[0].xyz);
  float bh = length(instanceMatrix[1].xyz);
  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 bWorld = iPos + camRight * (transformed.x * bw) + vec3(0.0, transformed.y * bh, 0.0);
  vec4 mvPosition = viewMatrix * vec4(bWorld, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
`
        );
    };
    mat.customProgramCacheKey = () => 'veg-billboard-v1';
    this.materials.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, total);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'veg-billboards';
    ctx.scene.add(mesh);
    this.billboards = mesh;
  }

  /** Scrub on the slopes and reed beds at the water's edge. */
  private buildUnderstorey(ctx: EngineContext, foliage: THREE.Material): void {
    const bushes: Placed[] = [];
    const reeds: Placed[] = [];
    const ctl = { r: 0, g: 0, b: 0, a: 0 };

    const cell = 11;
    const n = Math.floor((HALF_EXTENT * 2) / cell);
    for (let gj = 0; gj < n; gj++) {
      for (let gi = 0; gi < n; gi++) {
        const h1 = hash2(gi, gj, 131);
        const h2 = hash2(gi, gj, 149);
        const h3 = hash2(gi, gj, 167);
        const x = -HALF_EXTENT + (gi + 0.5) * cell + (h1 - 0.5) * cell;
        const z = -HALF_EXTENT + (gj + 0.5) * cell + (h2 - 0.5) * cell;
        const h = this.terrain.heightAt(x, z);
        const slope = this.terrain.slopeAt(x, z);
        this.terrain.controlAt(x, z, ctl);

        const pick = this.profile.understorey(x, z, h, slope, ctl, h3);
        if (!pick) continue;
        // Reed beds are exempt from the planting exclusions — nobody forms up in one — so
        // the profile decides them before the exclusion test rather than after it.
        if (pick.kind === 'reeds') {
          if (h3 < pick.density) {
            reeds.push({ x, y: h, z, yaw: hash2(gi, gj, 181) * Math.PI * 2, scale: 0.7 + h1 * 0.8 });
          }
          continue;
        }
        if (this.excluded(x, z, h, slope, WALL_CLEAR_SCRUB_OUT)) continue;
        if (h3 < pick.density) {
          bushes.push({ x, y: h, z, yaw: hash2(gi, gj, 197) * Math.PI * 2, scale: 0.7 + h1 * 0.95 });
        }
      }
    }

    this.addSimple(ctx, buildBush(), foliage, bushes, 'veg-bush', true);
    this.addSimple(ctx, buildReeds(), foliage, reeds, 'veg-reeds', false);
  }

  private buildRocks(ctx: EngineContext): void {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    this.materials.push(mat);

    const items: Placed[] = [];
    const ctl = { r: 0, g: 0, b: 0, a: 0 };
    const cell = 13;
    const n = Math.floor((HALF_EXTENT * 2) / cell);
    for (let gj = 0; gj < n; gj++) {
      for (let gi = 0; gi < n; gi++) {
        const h1 = hash2(gi, gj, 211);
        const h2 = hash2(gi, gj, 223);
        const h3 = hash2(gi, gj, 239);
        const x = -HALF_EXTENT + (gi + 0.5) * cell + (h1 - 0.5) * cell;
        const z = -HALF_EXTENT + (gj + 0.5) * cell + (h2 - 0.5) * cell;
        const h = this.terrain.heightAt(x, z);
        const slope = this.terrain.slopeAt(x, z);
        if (this.hasWall && z > crestZAt(x) - WALL_CLEAR_ROCK_OUT) continue;
        this.terrain.controlAt(x, z, ctl);
        const d = this.profile.rock(x, z, h, slope, ctl);
        if (h3 > d) continue;
        items.push({
          x,
          y: h,
          z,
          yaw: hash2(gi, gj, 251) * Math.PI * 2,
          // Mostly cobbles and small blocks with the occasional boulder.
          scale: 0.24 + Math.pow(hash2(gi, gj, 263), 3) * this.profile.rockMaxScale,
        });
      }
    }
    // No shadow casting: most of these are sub-metre stones whose shadow is a few
    // pixels, and multiplying 1,400 instances across four shadow cascades is two million
    // triangles for nothing.
    this.addSimple(ctx, buildRock(5, this.profile.rockTint), mat, items, 'veg-rocks', false);
  }

  private addSimple(
    ctx: EngineContext,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    items: Placed[],
    name: string,
    shadows: boolean
  ): void {
    if (items.length === 0) {
      geo.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      this.v3.set(p.x, p.y, p.z);
      this.s3.setScalar(p.scale);
      this.m4.compose(this.v3, this.q, this.s3);
      mesh.setMatrixAt(i, this.m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    // These never move, so a single static bounding sphere and no per-frame culling.
    mesh.frustumCulled = false;
    mesh.name = name;
    ctx.scene.add(mesh);
    this.simple.push(mesh);
  }

  // ---------------------------------------------------------------------
  // Level of detail
  // ---------------------------------------------------------------------

  preRender(ctx: EngineContext): void {
    const cam = ctx.camera.position;
    // Reassigning tiers is cheap but not free; 9 m of camera movement changes nothing
    // visible at the 130 m and 460 m thresholds.
    if (cam.distanceToSquared(this.lastLodPos) < 81) return;
    this.lastLodPos.copy(cam);

    let bbCount = 0;
    const bb = this.billboards;
    const rects = bb ? (bb.geometry.getAttribute('aAtlas') as THREE.InstancedBufferAttribute) : null;

    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      let n0 = 0;
      let n1 = 0;
      const [u0, v0, du, dv] = cellUv(g.billboard);
      for (let i = 0; i < g.items.length; i++) {
        const p = g.items[i];
        const dx = p.x - cam.x;
        const dz = p.z - cam.z;
        const dy = p.y - cam.y;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < NEAR_DIST && n0 < g.lod0.instanceMatrix.count) {
          this.writeInstance(g.lod0, n0++, p);
        } else if (d < MID_DIST && n1 < g.lod1.instanceMatrix.count) {
          this.writeInstance(g.lod1, n1++, p);
        } else if (bb && rects && bbCount < bb.instanceMatrix.count) {
          // The card is sized to the tree's silhouette, not its trunk.
          this.q.identity();
          this.v3.set(p.x, p.y, p.z);
          const hgt = g.height * p.scale;
          this.s3.set(hgt * (g.billboard === 'spire' ? 0.32 : 0.92), hgt, 1);
          this.m4.compose(this.v3, this.q, this.s3);
          bb.setMatrixAt(bbCount, this.m4);
          rects.setXYZW(bbCount, u0, v0, du, dv);
          bbCount++;
        }
      }
      g.lod0.count = n0;
      g.lod1.count = n1;
      g.lod0.instanceMatrix.needsUpdate = true;
      g.lod1.instanceMatrix.needsUpdate = true;
    }

    if (bb && rects) {
      bb.count = bbCount;
      bb.instanceMatrix.needsUpdate = true;
      rects.needsUpdate = true;
    }
  }

  private writeInstance(mesh: THREE.InstancedMesh, i: number, p: Placed): void {
    this.q.setFromAxisAngle(UP, p.yaw);
    this.v3.set(p.x, p.y, p.z);
    this.s3.setScalar(p.scale);
    this.m4.compose(this.v3, this.q, this.s3);
    mesh.setMatrixAt(i, this.m4);
  }

  dispose(): void {
    for (const g of this.groups) {
      g.lod0.geometry.dispose();
      g.lod1.geometry.dispose();
      g.lod0.dispose();
      g.lod1.dispose();
    }
    this.groups.length = 0;
    this.billboards?.geometry.dispose();
    this.billboards?.dispose();
    for (const m of this.simple) {
      m.geometry.dispose();
      m.dispose();
    }
    this.simple.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.atlas?.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
