import * as THREE from 'three';
import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { CITY_Z_MAX, worldOf } from './rome';

/**
 * Debug-only reference overlay: a georeferenced archaeological plan of Rome, laid on the
 * battlefield ground so the city can be graded against it from directly overhead.
 *
 * ## Why
 *
 * The survey in `rome.ts` carries a citation per monument, but a citation is not a
 * measurement of *this* build: nothing in it proves that the projection, the overlap
 * solver and the geometry builders together put the Colosseum where the plan says it is.
 * A three-quarter screenshot cannot answer that either. What answers it is putting the
 * plan itself on the ground at the same scale as the city and looking straight down, so
 * the two are the same picture and the error is visible rather than argued.
 *
 * ## Georeference
 *
 * A raster carries a plain 6-parameter affine from its own pixels to the survey frame of
 * `rome.ts` (metres east/north of the Temple of Jupiter OM). For the Lanciani sheet that
 * affine was fitted against a full inverse of its native CRS — Monte Mario / Gauss-Boaga
 * Est, EPSG:3004 — over a 13 x 13 grid spanning the whole plate, and reproduces it to
 * **1.26 m worst-case over 7 km**, which is a twentieth of a pixel of the compressed
 * world. The 0.0294 shear term is the grid convergence of EPSG:3004 at Rome's longitude
 * (1.68 degrees west of grid north), so the overlay is *not* axis-aligned in the survey
 * frame and must not be treated as a north-up rectangle.
 *
 * Composing that affine with `worldOf` is still affine, so the overlay is a parallelogram
 * in world space. It is emitted as a conforming grid rather than one quad anyway, because
 * it has to sit on the terrain, which is not a plane.
 *
 * ## Never ships
 *
 * Only `preview.ts` and the plan-view harness import this, and neither is a build entry
 * (Vite's only input is `index.html`). `enableCityOverlay` additionally refuses outside
 * `import.meta.env.DEV`, and the rasters live in gitignored `reference/`, so a production
 * bundle has no code path and no asset. Loading failure is non-fatal by design: with an
 * empty `reference/` the overlay simply does not appear.
 */

export interface ReferencePlan {
  id: string;
  name: string;
  /** Served by Vite from the repository root in dev. Gitignored, so never present in a build. */
  url: string;
  widthPx: number;
  heightPx: number;
  /**
   * Pixel to survey frame, metres east/north of the Capitol:
   * `e = ex * px + ey * py + e0`, `n = nx * px + ny * py + n0`.
   * Pixel origin is the raster's top-left, y down.
   */
  ex: number;
  ey: number;
  e0: number;
  nx: number;
  ny: number;
  n0: number;
  credit: string;
}

/**
 * Lanciani, *Forma Urbis Romae* (1893–1901), as georectified by ArcheoSITARproject
 * (SSABAP-RM) and served from their GeoServer WMS in EPSG:3004. See `ASSETS.md` entry 5
 * for the licence and the exact `GetMap` request. Map content public domain (Lanciani
 * d. 1929); georectification CC-BY-SA 4.0. Local reference only, never shipped.
 */
export const LANCIANI_1901: ReferencePlan = {
  id: 'lanciani',
  name: 'Lanciani, Forma Urbis Romae (1893–1901), georectified',
  url: '/reference/work/overlay-lanciani-2048.jpg',
  // The affine was fitted against the 4096 px original; a resized copy shares the same
  // corner geometry, so the coefficients scale with the raster.
  widthPx: 4096,
  heightPx: 2734,
  ex: 1.70846149,
  ey: 0.05015993,
  e0: -3538.9517,
  nx: 0.05027504,
  ny: -1.71190121,
  n0: 2244.571,
  credit: 'Lanciani / SITAR SSABAP-RM, CC-BY-SA 4.0 (georectification)',
};

/**
 * Modern colour orthophoto of the same ground, at the same georeference, so the two
 * rasters are pixel-registered to each other and to the world. AGEA 2012, 50 cm native,
 * from Italy's Geoportale Nazionale WMS; `Fees: Nessuna condizione applicata`,
 * `AccessConstraints: Nessuno`. See `ASSETS.md` entry 8.
 *
 * This is the "aerial photo of Rome" half of the comparison. It answers questions the
 * archaeological plan cannot: where the Tiber actually runs, how wide it is, and how the
 * ground rises onto the hills.
 */
export const AGEA_2012: ReferencePlan = {
  id: 'aerial',
  name: 'AGEA 2012 orthophoto, central Rome',
  url: '/reference/work/overlay-aerial-2048.jpg',
  widthPx: 4096,
  heightPx: 2734,
  ex: 1.70846149,
  ey: 0.05015993,
  e0: -3538.9517,
  nx: 0.05027504,
  ny: -1.71190121,
  n0: 2244.571,
  credit: 'AGEA / Geoportale Nazionale (MATTM), no access constraints',
};

export const REFERENCE_PLANS: readonly ReferencePlan[] = [LANCIANI_1901, AGEA_2012];

export interface OverlayOptions {
  /**
   * `ground` drapes the raster on the terrain, which is what the eye wants when judging
   * whether a monument stands where the plan puts it. `above` floats it over the whole
   * scene with depth testing off, for checking registration against standing geometry.
   */
  mode?: 'ground' | 'above';
  opacity?: number;
  /** Metres above the sampled ground, in `ground` mode. */
  lift?: number;
  /** Grid divisions across the raster. 96 is ~0.4 m of sag on the steepest slope. */
  divisions?: number;
}

/**
 * Build the overlay mesh. Returns null when the raster is missing, which is the normal
 * state of a fresh checkout: `reference/` is gitignored.
 */
export async function buildReferenceOverlay(
  plan: ReferencePlan,
  heightAt: (x: number, z: number) => number,
  opts: OverlayOptions = {}
): Promise<THREE.Mesh | null> {
  const texture = await loadTexture(plan.url);
  if (!texture) return null;

  const mode = opts.mode ?? 'ground';
  const div = opts.divisions ?? 96;
  const lift = opts.lift ?? 0.55;
  // In `above` mode the plane sits over the tallest thing in the city (the Capitol's
  // podium plus a temple, ~75 m) so it cannot intersect geometry even with depth off.
  const flatY = 150;

  const enOf = (px: number, py: number): { e: number; n: number } => ({
    e: plan.ex * px + plan.ey * py + plan.e0,
    n: plan.nx * px + plan.ny * py + plan.n0,
  });

  // Vertex grid. Position is exact per vertex; only the terrain sag between vertices is
  // approximated, which is why the grid is dense rather than a single quad.
  const cols = div + 1;
  const pos = new Float32Array(cols * cols * 3);
  const uv = new Float32Array(cols * cols * 2);
  const inside = new Uint8Array(cols * cols);
  const MARGIN = 8;
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / div;
      const v = j / div;
      const { e, n } = enOf(u * plan.widthPx, v * plan.heightPx);
      const w = worldOf(e, n);
      const k = j * cols + i;
      pos[k * 3] = w.x;
      pos[k * 3 + 1] = mode === 'above' ? flatY : heightAt(w.x, w.z) + lift;
      pos[k * 3 + 2] = w.z;
      // Image row 0 is the top of the picture; three.js samples v from the bottom.
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
      inside[k] =
        w.x > -HALF_EXTENT + MARGIN &&
        w.x < HALF_EXTENT - MARGIN &&
        w.z > -HALF_EXTENT + MARGIN &&
        w.z < Math.min(HALF_EXTENT - MARGIN, CITY_Z_MAX + 20)
          ? 1
          : 0;
    }
  }
  // Only emit quads wholly on the heightfield: a triangle hanging off the edge would be
  // draped over clamped terrain heights and read as a cliff of map.
  const idx: number[] = [];
  for (let j = 0; j < div; j++) {
    for (let i = 0; i < div; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (!inside[a] || !inside[b] || !inside[c] || !inside[d]) continue;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Explicit, because unused vertices are still in the position buffer and an automatic
  // bound would include the ones trimmed off the map.
  geo.computeBoundingSphere();

  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: opts.opacity ?? 1,
    depthWrite: false,
    depthTest: mode === 'ground',
    side: THREE.DoubleSide,
    // The raster is a document, not a lit surface: tone mapping it would change the very
    // contrast the comparison depends on.
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `reference-overlay-${plan.id}`;
  mesh.renderOrder = mode === 'above' ? 9000 : 2;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Corner coordinates of a plan in world metres, for the plan-view framing. */
export function overlayWorldBounds(plan: ReferencePlan): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [px, py] of [
    [0, 0],
    [plan.widthPx, 0],
    [plan.widthPx, plan.heightPx],
    [0, plan.heightPx],
  ]) {
    const w = worldOf(plan.ex * px + plan.ey * py + plan.e0, plan.nx * px + plan.ny * py + plan.n0);
    minX = Math.min(minX, w.x);
    maxX = Math.max(maxX, w.x);
    minZ = Math.min(minZ, w.z);
    maxZ = Math.max(maxZ, w.z);
  }
  return { minX, maxX, minZ, maxZ };
}

async function loadTexture(url: string): Promise<THREE.Texture | null> {
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const tex = new THREE.Texture(bitmap);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  } catch {
    // A missing reference raster is the normal state of a clean checkout.
    return null;
  }
}
