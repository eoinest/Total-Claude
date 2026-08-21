import * as THREE from 'three';
import { hash01 } from '../util/rand';
import { cone, cylinder, dome, type Batch } from './build';
import { PAL } from './palette';
import type { CityChunkSpec, TreeRequest } from './wall';

/**
 * Planting.
 *
 * Three species carry the whole Roman landscape: Mediterranean cypress (*Cupressus
 * sempervirens*), which is a near-black spire 15–25 m tall and the single most
 * recognisable silhouette in Italy; Italian stone pine (*Pinus pinea*), a bare trunk
 * under a flat umbrella crown; and broad-canopied planes in the squares.
 *
 * Every tree in the city goes into three merged meshes — one per depth band — so the
 * whole of Rome's planting costs three draw calls. They are solid geometry rather
 * than alpha-tested cards because at this scale the silhouette is the whole point and
 * cards flicker badly in a shadow pass.
 */

type Ground = (x: number, z: number) => number;

export function buildTreeChunks(trees: TreeRequest[], heightAt: Ground): CityChunkSpec[] {
  if (!trees.length) return [];
  const bands: { name: string; from: number; to: number; members: TreeRequest[] }[] = [
    { name: 'trees-near', from: -1e9, to: 640, members: [] },
    { name: 'trees-far', from: 640, to: 1e9, members: [] },
  ];
  for (const t of trees) {
    for (const b of bands) {
      if (t.z >= b.from && t.z < b.to) {
        b.members.push(t);
        break;
      }
    }
  }

  const chunks: CityChunkSpec[] = [];
  for (const b of bands) {
    if (!b.members.length) continue;
    let cx = 0;
    let cz = 0;
    for (const t of b.members) {
      cx += t.x;
      cz += t.z;
    }
    cx /= b.members.length;
    cz /= b.members.length;
    let radius = 40;
    for (const t of b.members) radius = Math.max(radius, Math.sqrt((t.x - cx) * (t.x - cx) + (t.z - cz) * (t.z - cz)) + 20);
    chunks.push({
      name: b.name,
      cx,
      cz,
      radius,
      castShadow: b.name === 'trees-near',
      lodSwitch: [420, 1e9],
      // Trees never collapse into masonry: they are already one draw call.
      farMaterial: 'foliage',
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        const st = batch.s('foliage');
        for (let i = 0; i < b.members.length; i++) {
          const t = b.members[i];
          const g = t.y ?? heightAt(t.x, t.z);
          st.pushTranslate(t.x, g, t.z);
          buildTree(st, detail, t, i);
          st.pop();
        }
      },
    });
  }
  return chunks;
}

const TRUNK = new THREE.Color();
const CANOPY = new THREE.Color();
const CANOPY_LIT = new THREE.Color();

function buildTree(st: ReturnType<Batch['s']>, detail: number, t: TreeRequest, index: number): void {
  const v = hash01(index, 917);
  const v2 = hash01(index, 5501);
  const seg = detail >= 1 ? 7 : 5;
  TRUNK.copy(PAL.timberDark).multiplyScalar(0.8 + v * 0.5);

  if (t.kind === 'cypress') {
    // 15–22 m is normal for a mature Mediterranean cypress; crown width about 1/8 of
    // the height, which is what makes it read as a spire rather than a cone.
    const h = (15 + v * 7) * t.scale;
    CANOPY.copy(PAL.cypress).multiplyScalar(0.95 + v2 * 0.34);
    CANOPY_LIT.copy(CANOPY).multiplyScalar(1.5);
    cylinder(st, 0, 0, 0, 0.3, 0.22, h * 0.14, 5, TRUNK);
    const lobes = detail >= 1 ? 5 : 2;
    for (let k = 0; k < lobes; k++) {
      const y0 = h * (0.06 + (k * 0.6) / lobes);
      // Crown width about a seventh of the height: narrow enough to read as a spire,
      // wide enough not to vanish into a green splinter at 200 m.
      // Crown roughly a ninth of the height: the mature Mediterranean cypress is a
      // 7:1 spire, and anything squatter reads as a party hat from above.
      const r = h * 0.088 * (1 - k * 0.1) * (0.88 + hash01(index * 7 + k, 31) * 0.26);
      cone(st, 0, y0, 0, r, h * (0.56 - k * 0.05), seg, CANOPY, CANOPY_LIT);
    }
  } else if (t.kind === 'pine') {
    // *Pinus pinea*: a clean trunk for two-thirds of its height, then a flat crown.
    const h = (16 + v * 8) * t.scale;
    CANOPY.copy(PAL.pine).multiplyScalar(0.74 + v2 * 0.42);
    CANOPY_LIT.copy(CANOPY).multiplyScalar(1.45);
    const lean = (v2 - 0.5) * 0.1;
    st.push(new THREE.Matrix4().makeRotationZ(lean));
    cylinder(st, 0, 0, 0, 0.46, 0.32, h * 0.62, 7, TRUNK, { shadeLow: 0.2 });
    // The stone pine's crown is a shallow parasol of overlapping tufts, not a
    // starburst. Overlapping flattened domes at slightly different heights give the
    // flat top and ragged edge that identifies the species at a kilometre.
    const crowns = detail >= 1 ? 5 : 2;
    for (let k = 0; k < crowns; k++) {
      const a = (Math.PI * 2 * k) / crowns + v * 5;
      const rr = k === 0 ? 0 : h * 0.14;
      const r = h * (0.19 - (k % 2) * 0.03);
      dome(st, Math.cos(a) * rr, h * (0.6 + hash01(index * 5 + k, 213) * 0.1), Math.sin(a) * rr, r, seg + 1, detail >= 1 ? 3 : 2, k % 2 === 0 ? CANOPY : CANOPY_LIT, {
        heightScale: 0.42,
      });
    }
    st.pop();
  } else {
    // Plane or holm oak: a broad low canopy for the squares and gardens.
    const h = (11 + v * 5) * t.scale;
    CANOPY.copy(PAL.vine).multiplyScalar(0.7 + v2 * 0.4);
    CANOPY_LIT.copy(CANOPY).multiplyScalar(1.42);
    cylinder(st, 0, 0, 0, 0.42, 0.3, h * 0.4, 6, TRUNK, { shadeLow: 0.2 });
    const lobes = detail >= 1 ? 3 : 1;
    for (let k = 0; k < lobes; k++) {
      const a = (Math.PI * 2 * k) / lobes + v * 4;
      const rr = lobes > 1 ? h * 0.14 : 0;
      dome(st, Math.cos(a) * rr, h * (0.38 + hash01(index + k, 77) * 0.1), Math.sin(a) * rr, h * 0.34, seg, detail >= 1 ? 4 : 2, CANOPY, {
        heightScale: 0.62,
      });
    }
    CANOPY_LIT.copy(CANOPY).multiplyScalar(1.3);
    dome(st, 0, h * 0.52, 0, h * 0.26, seg, detail >= 1 ? 3 : 2, CANOPY_LIT, { heightScale: 0.6 });
  }
}
