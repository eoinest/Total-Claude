import * as THREE from 'three';

/**
 * Geometry clipmap.
 *
 * A single 256² plane cannot serve both a camera at eye level in a melee and a view of
 * the whole 2.8 km field: one needs half-metre triangles, the other needs the horizon.
 * The clipmap solves it with concentric levels, each covering four times the area of
 * the one inside it at half the vertex density, all recentred on the camera.
 *
 * Two decisions make this cheap:
 *
 *  - Vertices carry grid *indices*, not positions. `position` holds (gridI, level, gridJ)
 *    and the vertex shader turns that into a world position from the clipmap centre and
 *    the level's spacing. Height comes from the heightfield texture. So the entire
 *    terrain — every level — is one static geometry and one draw call, and recentring
 *    the clipmap is a two-float uniform update rather than a buffer upload.
 *
 *  - All levels share one centre, snapped to twice the coarsest level's spacing. That
 *    makes each level's outer boundary land exactly on the next level's grid, so the
 *    classic clipmap "fixup" strips are unnecessary: the shader simply morphs each
 *    level's outermost band onto the coarser grid, which collapses the extra vertices
 *    onto their coarse neighbours. No cracks, and no popping when a level recentres.
 */

/** Cells per side, per level. Must be divisible by four so the ring hole is exact. */
export const CLIP_CELLS = 192;
/** Levels including the solid centre block. 7 × 192 cells at 0.5 m reaches ±3072 m. */
export const CLIP_LEVELS = 7;
/** Vertex spacing of the finest level, in metres. */
export const CLIP_BASE_SPACING = 0.5;
/** Fraction of each level's half-extent used for the morph band. */
export const CLIP_MORPH_BAND = 0.2;

/**
 * The clipmap centre is snapped to this in world space so every level stays aligned.
 * Twice the coarsest spacing: the camera can therefore sit up to half of this from the
 * centre, which is why the centre block (±48 m) is comfortably larger.
 */
export const CLIP_SNAP = 2 * CLIP_BASE_SPACING * Math.pow(2, CLIP_LEVELS - 1);

export function buildClipmapGeometry(): THREE.BufferGeometry {
  const verts = CLIP_CELLS + 1;
  const perLevel = verts * verts;
  const positions = new Float32Array(perLevel * CLIP_LEVELS * 3);

  for (let lvl = 0; lvl < CLIP_LEVELS; lvl++) {
    const base = lvl * perLevel;
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const o = (base + j * verts + i) * 3;
        // Not a position: the vertex shader reads these as (gridI, level, gridJ).
        positions[o] = i;
        positions[o + 1] = lvl;
        positions[o + 2] = j;
      }
    }
  }

  const holeLo = CLIP_CELLS / 4;
  const holeHi = (CLIP_CELLS * 3) / 4;
  const indices: number[] = [];
  for (let lvl = 0; lvl < CLIP_LEVELS; lvl++) {
    const base = lvl * perLevel;
    for (let j = 0; j < CLIP_CELLS; j++) {
      const inHoleJ = j >= holeLo && j < holeHi;
      for (let i = 0; i < CLIP_CELLS; i++) {
        // Every level above the first is a hollow square; the hole is exactly the
        // extent of the level inside it.
        if (lvl > 0 && inHoleJ && i >= holeLo && i < holeHi) continue;
        const a = base + j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  // The mesh never moves and is never culled — it is always centred on the camera — so
  // give it a bounding sphere that cannot fail a frustum test.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1e5, -1e5, -1e5),
    new THREE.Vector3(1e5, 1e5, 1e5)
  );
  return geo;
}

/** Triangle count of the clipmap, for the performance log. */
export const clipmapTriangles = (): number => {
  const solid = CLIP_CELLS * CLIP_CELLS * 2;
  const ring = (CLIP_CELLS * CLIP_CELLS - (CLIP_CELLS / 2) * (CLIP_CELLS / 2)) * 2;
  return solid + ring * (CLIP_LEVELS - 1);
};
