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
import {
  HALF_EXTENT,
  QUARRIES,
  WATER_LEVEL,
  germanDeployMask,
  riseToeZ,
  riverCentreX,
  roadCentreX,
  romanDeployMask,
  streamDistance,
} from './topography';
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
 * Species follow the ground: willows and reeds on the Tiber's terrace, cypresses lining
 * the Via Flaminia and clustered by the city, umbrella pine and holm oak on the hills,
 * olives in groves on the centuriated plain.
 *
 * Three detail tiers. Every tree is in exactly one of them each frame, reassigned only
 * when the camera has moved far enough to matter.
 */

const NEAR_DIST = 115;
const MID_DIST = 440;
const NEAR_CAPACITY = 340;

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

const SPECIES_LIST: readonly Species[] = ['cypress', 'pine', 'oak', 'olive', 'willow'];

/** Must match the centuriation lattice the heightfield banks the field edges on. */
const FIELD_ANGLE = 0.213;
const FIELD_COS = Math.cos(FIELD_ANGLE);
const FIELD_SIN = Math.sin(FIELD_ANGLE);
const FIELD_PERIOD = 94;

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

  constructor(private readonly terrain: TerrainSystem) {}

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
    this.materials.push(foliage);

    const trees = this.placeTrees();

    for (const species of SPECIES_LIST) {
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

  /** True where nothing should be planted: parade ground, carriageway, water, quarry. */
  private excluded(x: number, z: number, h: number, slope: number): boolean {
    if (h < WATER_LEVEL + 0.7) return true;
    if (slope > 0.78) return true;
    if (Math.max(germanDeployMask(x, z), romanDeployMask(x, z)) > 0.12) return true;
    if (Math.abs(x - roadCentreX(z)) < 10.5) return true;
    for (const q of QUARRIES) {
      if (Math.hypot((x - q.x) / q.radius, (z - q.z) / (q.radius * 0.8)) < 1.25) return true;
    }
    return false;
  }

  private placeTrees(): Map<Species, Placed[]> {
    const out = new Map<Species, Placed[]>();
    for (const s of SPECIES_LIST) out.set(s, []);
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
        if (ctl.b > 0.5) continue; // heavily trodden ground

        const toe = riseToeZ(x);
        const onHill = z > toe - 50;
        const dRiver = Math.abs(x - riverCentreX(z));
        const dRoad = Math.abs(x - roadCentreX(z));
        const above = h - WATER_LEVEL;

        let species: Species;
        let density: number;
        if (dRiver < 175 && above < 5.4) {
          // The Tiber's water meadow: willow and poplar thickets. Kept below a third
          // because willow crowns are wide alpha-tested cards and a solid thicket of
          // them is the most expensive fill in the frame.
          species = 'willow';
          density = 0.32;
        } else if (dRoad < 44 && dRoad > 10.5) {
          // A cypress avenue along the Via Flaminia — unmistakably Italian, and it gives
          // the road a readable line from a high camera.
          species = h3 < 0.82 ? 'cypress' : 'oak';
          density = 0.5;
        } else if (onHill) {
          species = h3 < 0.42 ? 'pine' : h3 < 0.82 ? 'oak' : 'cypress';
          // Denser on the flanks, thinning on the crest where the city begins.
          density = 0.34 * (1 - sstep(toe + 260, toe + 620, z) * 0.6);
        } else {
          // The centuriated plain: olive groves in blocks, hedgerow trees along the
          // field boundaries, and copses in between. Uniform scatter over farmland is
          // the clearest tell that nobody has ever worked the ground.
          const grove = fbm(x, z, 2, 1 / 235, 9091) * 0.5 + 0.5;
          if (grove > 0.58) {
            species = 'olive';
            density = 0.42;
          } else {
            species = h3 < 0.7 ? 'oak' : 'olive';
            // Same lattice the heightfield banks the field edges on, so the trees line
            // up with the boundaries rather than ignoring them.
            const u = x * FIELD_COS - z * FIELD_SIN;
            const v = x * FIELD_SIN + z * FIELD_COS;
            const du = Math.abs(((u % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
            const dv = Math.abs(((v % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
            const hedge = 1 - sstep(3, 12, Math.min(du, dv));
            const copse = fbm(x, z, 3, 1 / 130, 7717) * 0.5 + 0.5;
            density = 0.02 + 0.34 * hedge + 0.22 * sstep(0.6, 0.85, copse);
          }
        }
        // Nothing grows on scoured bedrock.
        density *= 1 - ctl.g * 0.75;
        if (h4 > density) continue;

        out.get(species)!.push({
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
        const above = h - WATER_LEVEL;
        const dRiver = Math.abs(x - riverCentreX(z));
        const dStream = z > -220 && z < 420 && x > -880 && x < 280 ? streamDistance(x, z) : 999;

        // Reeds stand in the water's edge and along the drainage stream, where the
        // deployment exclusion does not apply — nobody forms up in a reed bed anyway.
        if ((above > -0.4 && above < 1.15 && dRiver < 150) || (dStream < 9 && above > 0)) {
          if (h3 < 0.62) {
            reeds.push({ x, y: h, z, yaw: hash2(gi, gj, 181) * Math.PI * 2, scale: 0.7 + h1 * 0.8 });
          }
          continue;
        }

        if (this.excluded(x, z, h, slope)) continue;
        this.terrain.controlAt(x, z, ctl);
        if (ctl.b > 0.45) continue;

        const toe = riseToeZ(x);
        const onHill = z > toe - 40;
        // Maquis clings to the broken ground of the slopes; the plain is grazed bare.
        let d = onHill ? 0.3 : 0.05;
        d += sstep(0.16, 0.5, slope) * 0.3;
        d *= 1 - ctl.g * 0.6;
        // Nothing woody roots in a river bar: those are reworked every flood. The silt
        // channel of the control map is exactly where that is true.
        d *= 1 - sstep(0.25, 0.55, ctl.a);
        if (h3 < d) {
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
        if (h < WATER_LEVEL - 0.6) continue;
        this.terrain.controlAt(x, z, ctl);
        // Stone shows where the ground has been scoured, on steep faces, on the river's
        // gravel bars, and in the quarry spoil.
        const bar = ctl.a * (1 - sstep(0.2, 2.2, h - WATER_LEVEL));
        const d = ctl.g * 0.55 + sstep(0.2, 0.62, slope) * 0.4 + bar * 0.5;
        if (h3 > d) continue;
        items.push({
          x,
          y: h,
          z,
          yaw: hash2(gi, gj, 251) * Math.PI * 2,
          // Mostly cobbles and small blocks with the occasional boulder.
          scale: 0.24 + Math.pow(hash2(gi, gj, 263), 3) * 2.1,
        });
      }
    }
    // No shadow casting: most of these are sub-metre stones whose shadow is a few
    // pixels, and multiplying 1,400 instances across four shadow cascades is two million
    // triangles for nothing.
    this.addSimple(ctx, buildRock(5), mat, items, 'veg-rocks', false);
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
