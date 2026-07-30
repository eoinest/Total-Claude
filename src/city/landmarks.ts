import * as THREE from 'three';
import { lerp } from '../util/math';
import { Rng, hash2 } from '../util/rand';
import {
  archPanel,
  arcade,
  box,
  column,
  cone,
  crenellation,
  cylinder,
  dome,
  gableRoof,
  hipRoof,
  pediment,
  quadPrism,
  seatingBank,
  statue,
  steps,
  type Batch,
  type ColumnOrder,
  type GeoStream,
} from './build';
import { crestZAt, roadCentreX } from '../terrain/topography';
import { AQUEDUCTS, GATE_X, LANDMARKS, type LandmarkPlacement } from './layout';
import { PAL } from './palette';
import { cylinderBetween, type CityChunkSpec, type TreeRequest } from './wall';

/**
 * Rome's monuments, at true scale.
 *
 * Every dimension below is the real one, cited where it is not obvious. The city's
 * *positions* are compressed (see `layout.ts`) but nothing is scaled, because the
 * whole point of a skyline is that the Pantheon's dome is 43 m across and the
 * Colosseum is 48 m tall, and a man beside them is 1.75 m.
 */

export interface LandmarkOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /** Circular footprints, for `blocksMovement` and for the insula generator. */
  footprints: { x: number; z: number; r: number }[];
}

type Ground = (x: number, z: number) => number;

/**
 * Mausoleum of Augustus: 87 m across and about 42 m tall, built as concentric
 * travertine drums retaining planted earth terraces (Strabo V.3.8 describes the
 * evergreens and the bronze Augustus above them). Shared between the geometry and
 * the planting planner so the cypresses land on the terraces, not on the ground.
 */
const MAUS_R = 43.5;
const MAUS_DRUMS = [
  { r: MAUS_R, h: 13.0 },
  { r: MAUS_R * 0.72, h: 11.5 },
  { r: MAUS_R * 0.42, h: 9.5 },
];

function mausoleumTerraces(g: number): { rOut: number; rIn: number; y: number }[] {
  const out: { rOut: number; rIn: number; y: number }[] = [];
  let y = g + 0.3;
  for (let d = 0; d < MAUS_DRUMS.length; d++) {
    y = y + MAUS_DRUMS[d].h + 1.35;
    out.push({ rOut: MAUS_DRUMS[d].r + 0.5, rIn: d + 1 < MAUS_DRUMS.length ? MAUS_DRUMS[d + 1].r : 0, y });
  }
  return out;
}

/**
 * All planting that belongs to a monument. Kept out of the geometry builders because
 * those run once per detail level.
 */
function planLandmarkTrees(l: LandmarkPlacement, heightAt: Ground, rng: Rng, out: TreeRequest[]): void {
  const g = heightAt(l.x, l.z) + (l.mound ?? 0);
  const cs = Math.cos(l.rot);
  const sn = Math.sin(l.rot);
  const push = (lx: number, lz: number, kind: TreeRequest['kind'], scale: number, y?: number): void => {
    out.push({ x: l.x + lx * cs - lz * sn, z: l.z + lx * sn + lz * cs, kind, scale, y });
  };

  if (l.id === 'mausoleum-augustus') {
    const terraces = mausoleumTerraces(heightAt(l.x, l.z));
    for (let d = 0; d < terraces.length; d++) {
      const t = terraces[d];
      // Sparse and irregular: a perfect ring of cones on a terrace reads as a
      // hedgehog, and Strabo's evergreens were a grove, not a colonnade.
      if (d > 1) continue;
      const mid = (t.rOut + t.rIn) * 0.5;
      const n = Math.max(5, Math.round(mid * 0.34));
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * (i + rng.range(-0.35, 0.35))) / n;
        const r = lerp(t.rIn + 2.5, t.rOut - 2.5, rng.next());
        push(Math.cos(a) * r, Math.sin(a) * r, 'cypress', (1.0 + d * 0.1) * rng.range(0.85, 1.2), t.y);
      }
    }
    return;
  }
  if (l.id === 'palatine') {
    for (let i = 0; i < 26; i++) {
      push(rng.range(-100, 100), rng.range(-60, 82), rng.bool(0.5) ? 'cypress' : 'pine', rng.range(0.9, 1.4), g);
    }
    return;
  }
  if (l.id === 'forum-romanum') {
    for (let i = 0; i < 9; i++) push(rng.range(-42, 42), rng.range(-32, 24), 'umbrella', rng.range(0.9, 1.3), g);
    return;
  }
  if (l.id === 'gardens-sallust' || l.id === 'janiculum') {
    const R = l.clear * 0.9;
    const n = Math.round(R * 0.8);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = R * Math.sqrt(rng.next());
      push(Math.cos(a) * r, Math.sin(a) * r, rng.pick(['cypress', 'pine', 'umbrella'] as const), rng.range(0.85, 1.5), l.mound ? undefined : undefined);
    }
    return;
  }
  // Temples, theatres and baths get a light scatter round their precinct wall.
  const n = Math.max(3, Math.round(l.clear * 0.12));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = l.clear * rng.range(0.78, 1.0);
    push(Math.cos(a) * r, Math.sin(a) * r, rng.bool(0.55) ? 'cypress' : 'pine', rng.range(0.8, 1.25));
  }
}

export function buildLandmarks(heightAt: Ground, seed: string): LandmarkOutput {
  const rng = new Rng(seed);
  const footprints: { x: number; z: number; r: number }[] = [];
  for (const l of LANDMARKS) footprints.push({ x: l.x, z: l.z, r: l.clear * 0.78 });

  // Planting and tomb layout are *planned* here, not emitted from the geometry
  // builders. Chunk builders run once per detail level, so anything that appends to a
  // shared list from inside one would be duplicated — and the tree chunks are
  // partitioned before any baking happens, so it would never render at all.
  const tombs = planRoadTombs(heightAt, rng.fork('tombs'));
  const trees: TreeRequest[] = [...tombs.trees];
  for (const l of LANDMARKS) planLandmarkTrees(l, heightAt, rng.fork(`plant-${l.id}`), trees);

  // Group monuments into depth bands so a whole band shares one LOD and one set of
  // merged meshes. Individual LODs per monument would triple the draw count.
  const bands: { name: string; from: number; to: number }[] = [
    { name: 'monuments-a', from: 0, to: 560 },
    { name: 'monuments-b', from: 560, to: 820 },
    { name: 'monuments-c', from: 820, to: 1060 },
    { name: 'monuments-d', from: 1060, to: 4000 },
  ];

  const chunks: CityChunkSpec[] = [];
  for (const band of bands) {
    const members = LANDMARKS.filter((l) => l.z >= band.from && l.z < band.to);
    if (!members.length) continue;
    let cx = 0;
    let cz = 0;
    for (const m of members) {
      cx += m.x;
      cz += m.z;
    }
    cx /= members.length;
    cz /= members.length;
    let radius = 60;
    for (const m of members) radius = Math.max(radius, Math.hypot(m.x - cx, m.z - cz) + m.clear + 40);
    chunks.push({
      name: band.name,
      cx,
      cz,
      radius,
      castShadow: band.from < 600,
      lodSwitch: [560, 1e9],
      build: (batch, detail) => {
        for (const m of members) {
          batch.setUvOrigin(m.x, 0, m.z);
          buildLandmark(batch, detail, m, heightAt, rng.fork(m.id));
        }
      },
    });
  }

  // Aqueducts get their own chunks: they are long and thin, so they cull well.
  for (const aq of AQUEDUCTS) {
    let cx = 0;
    let cz = 0;
    for (const p of aq.path) {
      cx += p.x;
      cz += p.z;
    }
    cx /= aq.path.length;
    cz /= aq.path.length;
    let radius = 60;
    for (const p of aq.path) radius = Math.max(radius, Math.hypot(p.x - cx, p.z - cz) + 30);
    chunks.push({
      name: `aqueduct-${aq.id}`,
      cx,
      cz,
      radius,
      castShadow: false,
      lodSwitch: [700, 1e9],
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        buildAqueduct(batch, detail, aq, heightAt);
      },
    });
  }

  // Tombs lining the Via Flaminia outside the gate. Roman law barred burial inside
  // the walls, so every approach road ran through a corridor of monuments — and in
  // this battle they are the only cover on the plain in front of the wall.
  chunks.push({
    name: 'road-tombs',
    cx: GATE_X,
    cz: crestZAt(GATE_X) - 110,
    radius: 340,
    castShadow: true,
    lodSwitch: [420, 1200],
    build: (batch, detail) => {
      batch.setUvOrigin(GATE_X, 0, crestZAt(GATE_X) - 110);
      buildRoadTombs(batch, detail, heightAt, tombs.sites);
    },
  });

  // The far horizon: the Alban hills and the campagna, closing the view beyond the
  // terrain's edge so the city does not end against empty sky.
  chunks.push({
    name: 'far-hills',
    cx: 0,
    cz: 1900,
    radius: 2600,
    castShadow: false,
    lodSwitch: [1e9, 1e9],
    build: (batch) => {
      batch.setUvOrigin(0, 0, 1900);
      buildFarHills(batch, heightAt);
    },
  });

  return { chunks, trees, footprints };
}

function buildLandmark(batch: Batch, detail: number, m: LandmarkPlacement, heightAt: Ground, rng: Rng): void {
  const g = heightAt(m.x, m.z);
  const mat = new THREE.Matrix4().makeRotationY(m.rot).setPosition(m.x, 0, m.z);
  // Every stream the monument builders might touch has to share the placement
  // transform. Unused streams cost nothing: empty ones are dropped when baking.
  const keys: Parameters<Batch['s']>[0][] = ['stone', 'brick', 'stucco', 'roof', 'metal', 'timber', 'road'];
  for (const k of keys) batch.s(k).push(mat);

  let podium = g;
  if (m.mound) {
    buildMound(batch, detail, m.moundRadius ?? 100, m.mound, g, heightAt, m.x, m.z, m.rot);
    podium = g + m.mound;
  }

  switch (m.id) {
    case 'pantheon':
      buildPantheon(batch, detail, podium);
      break;
    case 'colosseum':
      buildColosseum(batch, detail, podium);
      break;
    case 'circus-maximus':
      buildCircusMaximus(batch, detail, podium, rng);
      break;
    case 'temple-jupiter':
      // Podium 63 × 53 m, hexastyle with a three-deep Etruscan porch, columns of
      // Pentelic marble ~17 m tall, and the gilded bronze roof tiles Domitian paid
      // 12,000 talents for (Plutarch, *Publicola* 15).
      buildTemple(batch, detail, podium, {
        w: 53,
        d: 63,
        podiumH: 5.2,
        colH: 17,
        colR: 0.95,
        colsFront: 6,
        colsSide: 4,
        porchRows: 3,
        order: 'corinthian',
        roofCol: PAL.gilt,
        // Gilded *tiles*, not sheet: the tile material's normal and roughness maps give the
        // pan-and-cover relief, and the gold comes from the vertex colour. The metal material
        // is a near-mirror at metalness 1, and on 3,300 m² of upward-facing roof it reflected
        // the whole sky dome and clipped to a blank white sheet — no amount of tilting the
        // course normals helps, because every upward direction sees bright sky.
        roofMat: 'roof',
        wallCol: PAL.marble,
        cellae: 3,
      });
      break;
    case 'mausoleum-augustus':
      buildMausoleum(batch, detail, podium, rng);
      break;
    case 'trajan-column':
      buildTrajansColumn(batch, detail, podium);
      break;
    case 'theatre-marcellus':
      // 111 m across, 32.6 m tall, 41 arcade bays per storey, seated ~15,000.
      buildTheatre(batch, detail, podium, 55.5, 32.6, 41, 2);
      break;
    case 'theatre-pompey':
      // Rome's first stone theatre: cavea about 150 m across.
      buildTheatre(batch, detail, podium, 75, 33, 48, 3);
      break;
    case 'stadium-domitian':
      // 275 × 106 m; the plan survives as the Piazza Navona.
      buildStadium(batch, detail, podium, 275, 106, rng);
      break;
    case 'basilica-ulpia':
      buildBasilica(batch, detail, podium, 130, 55);
      break;
    case 'forum-romanum':
      buildForum(batch, detail, podium, rng);
      break;
    case 'baths-trajan':
      // Platform 330 × 215 m on the Esquiline.
      buildBaths(batch, detail, podium, 250, 170, rng);
      break;
    case 'baths-agrippa':
      buildBaths(batch, detail, podium, 110, 90, rng);
      break;
    case 'castra-praetoria':
      // 440 × 380 m, brick curtain about 4.7 m high in its original phase.
      buildCastra(batch, detail, podium, 380, 300, heightAt, m);
      break;
    case 'horologium':
      // The obelisk of Psammetichus II, 21.8 m of red granite on a 5 m base.
      buildObelisk(batch, detail, podium, 21.8, 1.9);
      break;
    case 'ara-pacis':
      buildAltarEnclosure(batch, detail, podium, 11.6, 10.6);
      break;
    case 'temple-isis':
      buildTemple(batch, detail, podium, {
        w: 22,
        d: 34,
        podiumH: 2.6,
        colH: 10.5,
        colR: 0.58,
        colsFront: 4,
        colsSide: 6,
        porchRows: 2,
        order: 'corinthian',
        roofCol: PAL.roofTile,
        roofMat: 'roof',
        wallCol: PAL.marbleShadow,
        cellae: 1,
      });
      buildObelisk(batch, detail, podium, 9.2, 0.85);
      break;
    case 'temple-serapis':
      buildTemple(batch, detail, podium, {
        w: 34,
        d: 46,
        podiumH: 4.4,
        colH: 14,
        colR: 0.8,
        colsFront: 6,
        colsSide: 5,
        porchRows: 2,
        order: 'corinthian',
        roofCol: PAL.bronze,
        roofMat: 'roof',
        wallCol: PAL.marble,
        cellae: 1,
      });
      break;
    case 'palatine':
      buildPalatine(batch, detail, podium, rng);
      break;
    case 'gardens-sallust':
      buildGardens(batch, detail, podium, rng, m.clear);
      break;
    case 'janiculum':
      buildGardens(batch, detail, podium, rng, m.clear);
      break;
    default:
      break;
  }

  for (const k of keys) batch.s(k).pop();
}

// ---------------------------------------------------------------------------
// Artificial hills. The Capitol and the Palatine stood on massive substructures;
// where the battlefield terrain is smooth, the mound *is* the substructure.
// ---------------------------------------------------------------------------

function buildMound(
  batch: Batch,
  detail: number,
  radius: number,
  height: number,
  g: number,
  heightAt: Ground,
  wx: number,
  wz: number,
  rot: number
): void {
  const st = batch.s('stone');
  const seg = detail >= 1 ? 26 : 12;
  const rings = detail >= 1 ? 3 : 2;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);

  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    // Terraced: each ring is a retaining wall with a planted platform behind it.
    // Most of the shrink happens in the first ring, so the profile is a steep bank
    // with a broad platform on top rather than a stepped cone.
    const shrink = (t: number): number => 1 - (0.34 * t + 0.24 * t * t);
    const r0 = radius * shrink(t0);
    const r1 = radius * shrink(t1);
    const y0 = g + height * t0;
    const y1 = g + height * t1;
    const shade = new THREE.Color().copy(r % 2 === 0 ? PAL.peperino : PAL.tufa).multiplyScalar(0.94);
    for (let i = 0; i < seg; i++) {
      const a0 = (Math.PI * 2 * i) / seg;
      const a1 = (Math.PI * 2 * (i + 1)) / seg;
      // The base of the outermost ring must follow the terrain or it floats.
      const groundAt = (a: number, rr: number): number => {
        if (r > 0) return y0;
        const lx = Math.cos(a) * rr;
        const lz = Math.sin(a) * rr;
        return Math.min(y0, heightAt(wx + lx * cs - lz * sn, wz + lx * sn + lz * cs) - 1.5);
      };
      quadPrism(
        st,
        Math.cos(a0) * r0,
        Math.sin(a0) * r0,
        Math.cos(a1) * r0,
        Math.sin(a1) * r0,
        Math.cos((a0 + a1) / 2),
        Math.sin((a0 + a1) / 2),
        0.01,
        Math.min(groundAt(a0, r0), groundAt(a1, r0)),
        y1,
        shade,
        shade,
        { top: false, ends: false }
      );
      // Terrace deck.
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const p0 = new THREE.Vector3(c0 * r0, y1, s0 * r0);
      const p1 = new THREE.Vector3(c1 * r0, y1, s1 * r0);
      const p2 = new THREE.Vector3(c1 * r1, y1, s1 * r1);
      const p3 = new THREE.Vector3(c0 * r1, y1, s0 * r1);
      UP.set(0, 1, 0);
      st.quadN(UP, p0, p1, p2, p3, PAL.dust);
    }
  }
  // Ramped approach on the north face so the hill reads as accessible.
  if (detail >= 1) {
    const w = Math.min(18, radius * 0.24);
    st.pushTranslate(0, 0, -radius * 0.34);
    steps(st, w, g, -radius * 0.66 + radius * 0.34, Math.round(height / 0.34), 0.34, radius * 0.32 / Math.max(1, Math.round(height / 0.34)), PAL.travertineDirty);
    st.pop();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// The Pantheon — Hadrian's rotunda, complete since about 126 AD
// ---------------------------------------------------------------------------

/**
 * External diameter 58 m, internal 43.3 m, wall 6 m thick; the dome's apex is
 * 43.3 m above the floor, exactly its internal span, and the oculus is 8.8 m across.
 * The pronaos is 33.1 m wide and 15.5 m deep with eight granite columns 11.8 m tall
 * and 1.48 m in diameter, and the roof tiles were gilded bronze until 655.
 */
function buildPantheon(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const brick = batch.s('brick');
  const rOut = 29;
  const drumH = 30;
  const seg = detail >= 1 ? 40 : 18;

  // Stepped travertine platform.
  cylinder(stone, 0, g - 1.2, 0, rOut + 2.4, rOut + 2.2, 1.4, seg, PAL.travertineDirty, { top: true });
  // Drum, brick-faced with travertine string courses, in three external stages.
  const stages = [
    { h: drumH * 0.46, r: rOut, col: PAL.brick },
    { h: drumH * 0.3, r: rOut - 0.55, col: PAL.brick },
    { h: drumH * 0.24, r: rOut - 1.1, col: PAL.brickPale },
  ];
  let y = g + 0.2;
  for (const s of stages) {
    cylinder(brick, 0, y, 0, s.r, s.r, s.h, seg, s.col, { shadeLow: 0.12 });
    cylinder(stone, 0, y + s.h - 0.42, 0, s.r + 0.28, s.r + 0.28, 0.42, seg, PAL.travertine, { top: true });
    y += s.h;
  }
  // Relieving arches in the drum face — visible on the real building.
  if (detail >= 1) {
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14 + 0.22;
      const px = Math.cos(a) * (rOut - 0.2);
      const pz = Math.sin(a) * (rOut - 0.2);
      brick.push(new THREE.Matrix4().makeRotationY(-a + Math.PI * 0.5).setPosition(px, g + 3.5, pz));
      archPanel(brick, 5.4, 8.4, PAL.brickDark, { depth: 0.5, spring: 4.6, openWidth: 3.0, segments: 7 });
      brick.pop();
    }
  }

  // The dome: a shallow external shell over stepped rings, in gilded bronze tile.
  const domeBase = g + 0.2 + drumH;
  const rings = detail >= 1 ? 7 : 3;
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings;
    const t1 = (i + 1) / rings;
    const r0 = lerp(rOut - 1.1, rOut - 8.5, t0);
    const r1 = lerp(rOut - 1.1, rOut - 8.5, t1);
    const h = 1.05;
    cylinder(stone, 0, domeBase + i * h, 0, r0, r1, h, seg, PAL.travertine, { top: true });
  }
  const shellBase = domeBase + rings * 1.05;
  const shellR = rOut - 8.5;
  // Apex 43.3 m above the floor; the shell above the stepped rings makes up the rest.
  const apex = g + 43.5;
  dome(metal, 0, shellBase, 0, shellR, seg, detail >= 1 ? 9 : 4, PAL.bronze, {
    heightScale: (apex - shellBase) / shellR,
    oculus: 4.4,
  });
  // Oculus rim.
  cylinder(stone, 0, apex - 0.6, 0, 4.9, 4.9, 0.9, detail >= 1 ? 18 : 8, PAL.marble, { top: true });

  // ---- pronaos -------------------------------------------------------------
  const porchW = 33.1;
  const porchD = 15.5;
  const colH = 11.8;
  const colR = 0.74;
  const zFront = -(rOut + porchD);
  // Podium and the five steps up to it.
  box(stone, -porchW / 2 - 1, g - 1.2, zFront - 1, porchW / 2 + 1, g + 1.5, -rOut + 2, PAL.travertine, { topGain: 1.08 });
  stone.pushTranslate(0, 0, zFront - 1);
  steps(stone, porchW * 0.8, g - 1.2, 0, 5, 0.3, 0.36, PAL.travertineDirty);
  stone.pop();

  // Eight columns across the front, three rows deep (8 + 4 + 4).
  const rows = [
    { z: zFront + 1.6, n: 8 },
    { z: zFront + 6.4, n: 4 },
    { z: zFront + 11.0, n: 4 },
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const cx = row.n === 8 ? lerp(-porchW / 2 + 2.4, porchW / 2 - 2.4, i / 7) : lerp(-porchW / 2 + 2.4, porchW / 2 - 2.4, i / 3) * (i < 2 ? 1 : 1);
      const x = row.n === 8 ? cx : (i < 2 ? -1 : 1) * (porchW / 2 - 2.4 - (i % 2) * 4.6);
      column(stone, x, g + 1.5, row.z, colR, colH, 'corinthian', PAL.marbleShadow, detail);
    }
  }
  // Entablature and pediment. Roman pediment pitch here is about 1:4.
  const entY = g + 1.5 + colH;
  box(stone, -porchW / 2 - 0.6, entY, zFront - 0.6, porchW / 2 + 0.6, entY + 2.6, -rOut + 1, PAL.marble, { topGain: 1.12 });
  stone.pushTranslate(0, 0, (zFront + (-rOut + 1)) / 2);
  pediment(stone, porchW + 1.2, entY + 2.6, Math.abs(-rOut + 1 - zFront), PAL.marble, 0.22);
  stone.pop();
  // Bronze-tiled porch roof behind the pediment.
  const roofSt = batch.s('metal');
  gableRoof(
    metal,
    roofSt,
    porchW,
    porchD,
    entY + 2.6,
    (porchW / 2) * 0.22,
    0.4,
    PAL.bronze,
    false
  );
  // The intermediate block joining the porch to the rotunda.
  box(brick, -porchW / 2 + 3, g + 1.5, -rOut - 3.5, porchW / 2 - 3, entY + 8.5, -rOut + 4, PAL.brickPale, { topGain: 1.1 });
}

// ---------------------------------------------------------------------------
// The Flavian Amphitheatre
// ---------------------------------------------------------------------------

/**
 * 189 × 156 m at the ground, 48 m to the top of the attic, 80 arcade bays per storey
 * on the three lower orders. Storey heights 10.5, 11.85 and 11.6 m with a 13.6 m
 * attic; ground-storey arches 4.2 m wide and 7.05 m tall. Engaged half-columns run
 * Tuscan, Ionic, Corinthian up the façade, with Corinthian pilasters on the attic.
 */
function buildColosseum(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const a = 94.5;
  const b = 78;
  const bays = detail >= 1 ? 80 : 40;
  const storeys = [
    { h: 10.5, order: 'tuscan' as ColumnOrder, spring: 4.2, open: 4.2 },
    { h: 11.85, order: 'ionic' as ColumnOrder, spring: 4.4, open: 4.2 },
    { h: 11.6, order: 'corinthian' as ColumnOrder, spring: 4.3, open: 4.2 },
  ];
  const wallT = 5.5;

  // Stepped travertine platform (the two-step *crepidines*).
  ellipseRing(stone, a + 3.2, b + 3.2, a - wallT - 2, b - wallT - 2, g - 0.9, 0.9, bays, PAL.travertineDirty);

  let y = g;
  for (let s = 0; s < storeys.length; s++) {
    const st = storeys[s];
    const scale = 1 - s * 0.008;
    for (let i = 0; i < bays; i++) {
      const t0 = (Math.PI * 2 * i) / bays;
      const t1 = (Math.PI * 2 * (i + 1)) / bays;
      const tm = (t0 + t1) / 2;
      const px = Math.cos(tm) * a * scale;
      const pz = Math.sin(tm) * b * scale;
      // Bay width from the chord between successive division points.
      const bw = Math.hypot(Math.cos(t1) * a - Math.cos(t0) * a, Math.sin(t1) * b - Math.sin(t0) * b);
      // Tangent angle of the ellipse, so panels sit square to the façade.
      const ang = Math.atan2(Math.cos(tm) * a, -Math.sin(tm) * b);
      stone.push(new THREE.Matrix4().makeRotationY(ang).setPosition(px, y, pz));
      archPanel(stone, bw + 0.06, st.h, PAL.travertine, {
        depth: wallT,
        spring: st.spring,
        openWidth: Math.min(st.open, bw * 0.62),
        segments: detail >= 2 ? 9 : detail === 1 ? 6 : 4,
        archivolt: detail >= 2 ? 0.2 : 0,
        voidCol: new THREE.Color(0.05, 0.045, 0.04),
      });
      if (detail >= 1) {
        // Engaged half-column between bays, and the order changes each storey.
        column(stone, bw / 2, 0, -0.55, 0.62, st.h - 1.4, st.order, PAL.travertine, detail - 1);
      }
      stone.pop();
    }
    // Entablature ring capping the storey.
    ellipseRing(stone, a * scale + 0.7, b * scale + 0.7, a * scale - wallT, b * scale - wallT, y + st.h - 1.5, 1.5, bays, PAL.travertine);
    y += st.h;
  }

  // Attic: solid wall with Corinthian pilasters and small square windows, plus the
  // corbels that carried the *velarium* masts.
  const atticH = 13.6;
  for (let i = 0; i < bays; i++) {
    const t0 = (Math.PI * 2 * i) / bays;
    const t1 = (Math.PI * 2 * (i + 1)) / bays;
    const tm = (t0 + t1) / 2;
    const px = Math.cos(tm) * a * 0.976;
    const pz = Math.sin(tm) * b * 0.976;
    const bw = Math.hypot(Math.cos(t1) * a - Math.cos(t0) * a, Math.sin(t1) * b - Math.sin(t0) * b);
    const ang = Math.atan2(Math.cos(tm) * a, -Math.sin(tm) * b);
    stone.push(new THREE.Matrix4().makeRotationY(ang).setPosition(px, y, pz));
    box(stone, -bw / 2 - 0.04, 0, 0, bw / 2 + 0.04, atticH, wallT, PAL.travertine, { topGain: 1.1 });
    if (detail >= 1) {
      if (i % 2 === 0) {
        // Square window, alternating bays.
        box(stone, -1.1, atticH * 0.42, -0.06, 1.1, atticH * 0.42 + 2.2, 0.3, new THREE.Color(0.05, 0.045, 0.04));
      } else if (detail >= 2) {
        // Gilded bronze shield (*clipeus*) between the windows.
        cylinder(batch.s('metal'), 0, atticH * 0.44, -0.2, 1.2, 1.2, 0.16, 12, PAL.gilt, { top: true });
      }
      // Pilaster.
      box(stone, bw / 2 - 0.42, 0, -0.34, bw / 2 + 0.42, atticH - 1.4, 0, PAL.travertine);
      // Mast corbels: three per bay at the top.
      if (detail >= 2) {
        for (let k = 0; k < 2; k++) {
          const ox = (k - 0.5) * bw * 0.5;
          box(stone, ox - 0.24, atticH - 2.6, -0.9, ox + 0.24, atticH - 1.9, 0, PAL.travertineDirty);
          box(stone, ox - 0.3, atticH - 0.9, -0.8, ox + 0.3, atticH - 0.2, 0, PAL.travertineDirty);
        }
      }
    }
    stone.pop();
  }
  ellipseRing(stone, a * 0.976 + 0.9, b * 0.976 + 0.9, a * 0.976 - wallT, b * 0.976 - wallT, y + atticH, 1.1, bays, PAL.travertine);

  // ---- interior: cavea and arena ------------------------------------------
  const caveaOuterA = a - wallT - 1;
  const arenaA = 43;
  const arenaB = 27;
  seatingBank(
    concrete,
    arenaA + 3,
    caveaOuterA,
    g + 3.2,
    (y + atticH - g - 6) / (detail >= 1 ? 34 : 12),
    detail >= 1 ? 34 : 12,
    bays,
    0,
    Math.PI * 2,
    PAL.travertineDirty,
    (b - wallT - 1) / caveaOuterA
  );
  // Arena floor and the hypogeum walls showing through the sand.
  ellipseDisc(concrete, arenaA, arenaB, g + 2.6, bays, PAL.dust);
  if (detail >= 1) {
    for (let i = -4; i <= 4; i++) {
      const zz = (i / 4) * arenaB * 0.7;
      box(concrete, -arenaA * 0.8, g + 2.6, zz - 0.5, arenaA * 0.8, g + 3.0, zz + 0.5, PAL.peperino);
    }
  }
  // Arena wall (*podium*) protecting the front rows.
  ellipseRing(concrete, arenaA + 3, arenaB + 3, arenaA, arenaB, g + 2.6, 3.6, bays, PAL.marbleShadow);
}

/** Elliptical annulus prism — platforms and entablature rings. */
function ellipseRing(
  st: GeoStream,
  aOut: number,
  bOut: number,
  aIn: number,
  bIn: number,
  y0: number,
  h: number,
  seg: number,
  col: THREE.Color
): void {
  const bright = new THREE.Color().copy(col).multiplyScalar(1.14);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i < seg; i++) {
    const t0 = (Math.PI * 2 * i) / seg;
    const t1 = (Math.PI * 2 * (i + 1)) / seg;
    const tm = (t0 + t1) / 2;
    // Outer face.
    p0.set(Math.cos(t0) * aOut, y0, Math.sin(t0) * bOut);
    p1.set(Math.cos(t1) * aOut, y0, Math.sin(t1) * bOut);
    p2.set(Math.cos(t1) * aOut, y0 + h, Math.sin(t1) * bOut);
    p3.set(Math.cos(t0) * aOut, y0 + h, Math.sin(t0) * bOut);
    nrm.set(Math.cos(tm) * bOut, 0, Math.sin(tm) * aOut).normalize();
    st.quadN(nrm, p0, p1, p2, p3, col, col, bright, bright);
    // Top.
    p0.set(Math.cos(t0) * aOut, y0 + h, Math.sin(t0) * bOut);
    p1.set(Math.cos(t1) * aOut, y0 + h, Math.sin(t1) * bOut);
    p2.set(Math.cos(t1) * aIn, y0 + h, Math.sin(t1) * bIn);
    p3.set(Math.cos(t0) * aIn, y0 + h, Math.sin(t0) * bIn);
    nrm.set(0, 1, 0);
    st.quadN(nrm, p0, p1, p2, p3, bright);
  }
}

/** Flat elliptical disc — arena floors, pools, paved plazas. */
function ellipseDisc(st: GeoStream, a: number, b: number, y: number, seg: number, col: THREE.Color): void {
  const c = new THREE.Vector3(0, y, 0);
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < seg; i++) {
    const t0 = (Math.PI * 2 * i) / seg;
    const t1 = (Math.PI * 2 * (i + 1)) / seg;
    p1.set(Math.cos(t0) * a, y, Math.sin(t0) * b);
    p2.set(Math.cos(t1) * a, y, Math.sin(t1) * b);
    st.triN(nrm, c, p1, p2, col);
  }
}

// ---------------------------------------------------------------------------
// Circus Maximus
// ---------------------------------------------------------------------------

/**
 * 621 × 118 m, seating around 150,000. The *spina* runs some 340 m down the middle
 * carrying the obelisk Augustus brought from Heliopolis (23.5 m of red granite),
 * the two *metae* turning posts, and the seven lap-counting eggs and dolphins.
 * Twelve *carceres* close the flat north-west end.
 */
function buildCircusMaximus(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const brick = batch.s('brick');
  const L = 621;
  const W = 118;
  const seatDepth = 32;
  const tiers = detail >= 1 ? 26 : 10;
  const facadeH = 28;

  // Arena floor, sanded.
  box(concrete, -L / 2 + 20, g, -W / 2, L / 2 - 20, g + 0.1, W / 2, PAL.dust);

  // Seating banks either side, plus the curved *sphendone* at the south-east end.
  for (const s of [-1, 1]) {
    const z0 = (s * W) / 2;
    const rows = tiers;
    const rise = (facadeH - 4) / rows;
    for (let r = 0; r < rows; r++) {
      const zz = z0 + s * (seatDepth * r) / rows;
      const yy = g + 2 + rise * r;
      box(concrete, -L / 2 + 20, yy, Math.min(zz, zz + s * (seatDepth / rows)), L / 2 - 30, yy + rise, Math.max(zz, zz + s * (seatDepth / rows)), PAL.travertineDirty, {
        topGain: 1.06,
      });
    }
    // Arcaded outer façade.
    const zf = z0 + s * (seatDepth + 4);
    const bays = detail >= 1 ? 62 : 24;
    brick.push(new THREE.Matrix4().makeRotationY(s > 0 ? Math.PI : 0).setPosition(0, g, zf));
    arcade(brick, bays, (L - 60) / bays, facadeH * 0.52, PAL.travertineDirty, {
      depth: 3.4,
      spring: 4.6,
      openWidth: Math.min(4.0, ((L - 60) / bays) * 0.6),
      segments: detail >= 2 ? 8 : 4,
      archivolt: detail >= 2 ? 0.18 : 0,
    });
    box(brick, -(L - 60) / 2, facadeH * 0.52, 0, (L - 60) / 2, facadeH, 3.4, PAL.brick, { topGain: 1.1 });
    brick.pop();
  }
  // Curved end.
  const endX = L / 2 - 30;
  seatingBank(concrete, W / 2 - 6, W / 2 + seatDepth, g + 2, (facadeH - 4) / tiers, tiers, detail >= 1 ? 20 : 9, -Math.PI / 2, Math.PI / 2, PAL.travertineDirty);
  concrete.pushTranslate(endX, 0, 0);
  concrete.pop();

  // ---- spina --------------------------------------------------------------
  const spinaL = 340;
  box(stone, -spinaL / 2, g + 0.1, -3.2, spinaL / 2, g + 2.6, 3.2, PAL.marbleShadow, { topGain: 1.1 });
  // Obelisk at the centre.
  buildObelisk(batch, detail, g + 2.6, 23.5, 1.15);
  // Metae: three conical turning posts at each end of the spina.
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const px = s * (spinaL / 2 - 3) - s * 0 + (k - 1) * 2.6;
      box(stone, px - 1.2, g + 2.6, -1.2, px + 1.2, g + 3.4, 1.2, PAL.marble);
      cone(stone, px, g + 3.4, 0, 1.05, 6.4, detail >= 1 ? 10 : 6, PAL.marble, PAL.gilt);
    }
  }
  // Lap counters: seven bronze dolphins on a rail.
  if (detail >= 1) {
    const metal = batch.s('metal');
    for (let k = 0; k < 7; k++) {
      const px = lerp(-spinaL * 0.28, spinaL * 0.28, k / 6);
      cylinder(metal, px, g + 2.6, 1.6, 0.16, 0.16, 3.4, 6, PAL.bronze);
      cylinder(metal, px, g + 6.0, 1.6, 0.55, 0.15, 1.5, 7, PAL.bronze, { top: true });
    }
  }
  // Small shrines and honorific columns along the spina.
  if (detail >= 1) {
    for (let k = 0; k < 6; k++) {
      const px = rng.range(-spinaL * 0.45, spinaL * 0.45);
      if (Math.abs(px) < 18) continue;
      column(stone, px, g + 2.6, rng.jitter(1.6), 0.42, 7.5, 'corinthian', PAL.marble, detail - 1);
    }
  }

  // ---- carceres: twelve starting gates at the flat end ---------------------
  const cx0 = -L / 2 + 6;
  brick.pushTranslate(cx0, 0, 0);
  box(brick, 0, g, -W / 2 - 4, 9, g + 14, W / 2 + 4, PAL.brick, { topGain: 1.08 });
  for (let k = 0; k < 12; k++) {
    const zz = lerp(-W / 2 + 4, W / 2 - 4, k / 11);
    brick.pushTranslate(9, g, zz);
    brick.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    archPanel(brick, (W - 8) / 12, 8.5, PAL.travertine, { depth: 3, spring: 4.0, openWidth: 3.2, segments: detail >= 1 ? 7 : 4 });
    brick.pop();
    brick.pop();
  }
  // Towers flanking the carceres. The roof stream needs the same translation as the
  // brick one or every tower cap piles up at the monument's origin.
  const roofSt = batch.s('roof');
  roofSt.pushTranslate(cx0, 0, 0);
  for (const s of [-1, 1]) {
    box(brick, -1, g, s * (W / 2 + 2) - 3, 11, g + 20, s * (W / 2 + 2) + 3, PAL.brick, { topGain: 1.1 });
    roofSt.pushTranslate(5, 0, s * (W / 2 + 2));
    hipRoof(roofSt, 12, 6, g + 20, 2.4, 0.4, PAL.roofTile);
    roofSt.pop();
  }
  roofSt.pop();
  brick.pop();
}

// ---------------------------------------------------------------------------
// Temples
// ---------------------------------------------------------------------------

interface TempleOpts {
  w: number;
  d: number;
  podiumH: number;
  colH: number;
  colR: number;
  colsFront: number;
  colsSide: number;
  porchRows: number;
  order: ColumnOrder;
  roofCol: THREE.Color;
  roofMat: 'roof' | 'metal';
  wallCol: THREE.Color;
  cellae: number;
}

/**
 * A temple roof emitted in tile courses instead of as one plane, with a ridge cap.
 *
 * The Capitoline temple's roof is 53 × 63 m. As a single quad per slope that is 3,300 m² of
 * unmodulated surface, and with gilded bronze's high environment intensity it resolved to a
 * blank cream sheet sitting on the Capitol — the one obviously broken building on the
 * skyline, visible from every city camera. A Roman roof of any material reads as *rows*:
 * banding the slope gives the eye tile courses, a ridge and eaves to hold onto, and the
 * per-course tone variation is what stops a specular surface reading as a mirror. Ridge runs
 * along Z, matching the Italic temple's axial plan.
 *
 * Costs `courses * 4 + 6` triangles — a few dozen — against four for the flat version.
 */
function tiledGable(
  st: GeoStream,
  roofSt: GeoStream,
  w: number,
  d: number,
  baseY: number,
  ridgeH: number,
  overhang: number,
  col: THREE.Color,
  detail: number
): void {
  const ow = w / 2 + overhang;
  const od = d / 2 + overhang;
  // Roman pan-and-cover tiling runs about 0.55 m to a course; below three metres per band
  // the courses stop resolving from any camera that can see the whole roof at once.
  const courses = detail >= 1 ? Math.max(4, Math.min(20, Math.round(ow / 1.9))) : 3;
  const slope = ridgeH / Math.max(0.01, ow);
  const cLo = new THREE.Color();
  const cHi = new THREE.Color();
  for (const sx of [-1, 1]) {
    for (let k = 0; k < courses; k++) {
      const x0 = sx * ow * (1 - k / courses);
      const x1 = sx * ow * (1 - (k + 1) / courses);
      const y0 = baseY + ridgeH * (k / courses);
      const y1 = baseY + ridgeH * ((k + 1) / courses);
      // Alternating courses, plus a gentle darkening toward the eaves where rain and dust
      // collect. Both are small: this is a roof, not a chequerboard.
      const alt = k % 2 === 0 ? 1.0 : 0.93;
      cLo.copy(col).multiplyScalar(alt * (0.9 + 0.1 * (k / courses)));
      cHi.copy(col).multiplyScalar(alt * (1.0 + 0.1 * (k / courses)));
      // Alternate courses are shaded as if tilted 8° toward the eave and toward the ridge.
      // Roman roofing is pan-and-cover: flat *tegulae* with raised semicircular *imbrices*
      // over the joints, so the surface is a sawtooth, not a plane, and shading it as one
      // gives the eye the rows without any extra geometry.
      const tilt = k % 2 === 0 ? 0.14 : -0.14;
      NH.set(sx * (slope + tilt), 1, 0).normalize();
      P0.set(x0, y0, -od);
      P1.set(x0, y0, od);
      P2.set(x1, y1, od);
      P3.set(x1, y1, -od);
      roofSt.quadN(NH, P0, P1, P2, P3, cLo, cLo, cHi, cHi);
    }
    // Gable end, in stone: the tympanum face behind the pediment.
    P0.set(sx * ow, baseY, sx * od);
    P1.set(0, baseY + ridgeH, sx * od);
    P2.set(-sx * ow, baseY, sx * od);
    st.triN(sx > 0 ? PZ : NZ, P0, P1, P2, col);
  }
  // Ridge cap: a run of *imbrices* over the joint, and the strongest line on the roof.
  const cap = new THREE.Color().copy(col).multiplyScalar(1.14);
  box(roofSt, -ow * 0.045, baseY + ridgeH - 0.12, -od, ow * 0.045, baseY + ridgeH + 0.26, od, cap, {
    bottom: false,
  });
}

/**
 * A band of weather staining on the four faces of a square monument.
 *
 * Emitted 30 mm proud of the face it sits on so it needs no z-fight tolerance, and graded
 * from dirty at the wet end to clean at the dry end. `wetAtTop` picks which end that is:
 * true under a cornice, where the water sheds off the overhang and runs back down the wall,
 * false at a plinth, where the road splashes up it.
 */
function dripStain(
  st: GeoStream,
  half: number,
  y0: number,
  height: number,
  base: THREE.Color,
  strength: number,
  wetAtTop: boolean
): void {
  const wet = new THREE.Color().copy(base).multiplyScalar(1 - strength).lerp(PAL.voidWarm, 0.16);
  const dry = new THREE.Color().copy(base).multiplyScalar(1 - strength * 0.16);
  const h = half + 0.03;
  for (const [nx, nz] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ]) {
    const ax = nz !== 0 ? -h : nx * h;
    const az = nx !== 0 ? -h : nz * h;
    const bx = nz !== 0 ? h : nx * h;
    const bz = nx !== 0 ? h : nz * h;
    STAIN_N.set(nx, 0, nz);
    P0.set(ax, y0, az);
    P1.set(bx, y0, bz);
    P2.set(bx, y0 + height, bz);
    P3.set(ax, y0 + height, az);
    const lo = wetAtTop ? dry : wet;
    const hi = wetAtTop ? wet : dry;
    st.quadN(STAIN_N, P0, P1, P2, P3, lo, lo, hi, hi);
  }
}

const STAIN_N = new THREE.Vector3();
const PZ = new THREE.Vector3(0, 0, 1);
const NZ = new THREE.Vector3(0, 0, -1);
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();
const NH = new THREE.Vector3();

/** Italic temple: high podium, frontal steps, deep porch, walled cella. */
function buildTemple(batch: Batch, detail: number, g: number, o: TempleOpts): void {
  const stone = batch.s('stone');
  const roofSt = batch.s(o.roofMat);
  const { w, d, podiumH, colH, colR } = o;

  // Podium with a moulded base and cap.
  box(stone, -w / 2 - 1.4, g - 1.0, -d / 2 - 1.4, w / 2 + 1.4, g + 0.7, d / 2 + 1.4, PAL.travertineDirty, { topGain: 1.06 });
  box(stone, -w / 2 - 0.7, g + 0.7, -d / 2 - 0.7, w / 2 + 0.7, g + podiumH - 0.5, d / 2 + 0.7, PAL.travertine, { topGain: 1.06 });
  box(stone, -w / 2 - 1.2, g + podiumH - 0.5, -d / 2 - 1.2, w / 2 + 1.2, g + podiumH, d / 2 + 1.2, PAL.marbleShadow, { topGain: 1.14 });
  // Frontal steps only — the Italic temple is emphatically axial.
  stone.pushTranslate(0, 0, -d / 2 - 1.4);
  steps(stone, w * 0.72, g - 1.0, 0, Math.max(3, Math.round(podiumH / 0.32)), 0.32, 0.4, PAL.travertineDirty);
  stone.pop();

  const colY = g + podiumH;
  const halfW = w / 2 - colR * 2.2;
  const zFront = -d / 2 + colR * 2.4;
  const spacing = (halfW * 2) / (o.colsFront - 1);
  // Porch colonnade.
  for (let r = 0; r < o.porchRows; r++) {
    for (let i = 0; i < o.colsFront; i++) {
      column(stone, -halfW + spacing * i, colY, zFront + r * spacing * 0.92, colR, colH, o.order, PAL.marble, detail);
    }
  }
  // Cella walls behind the porch.
  const cellaZ0 = zFront + (o.porchRows - 0.5) * spacing * 0.92 + 1.2;
  const cellaZ1 = d / 2 - colR * 1.6;
  box(stone, -halfW - colR, colY, cellaZ0, halfW + colR, colY + colH + 0.6, cellaZ1, o.wallCol, { topGain: 1.06 });
  if (o.cellae === 3 && detail >= 1) {
    // The Capitoline temple's triple cella: two dividing walls read as deep shadow.
    for (const s of [-1, 1]) {
      box(stone, (s * halfW) / 3 - 0.5, colY, cellaZ0 - 0.4, (s * halfW) / 3 + 0.5, colY + colH + 0.7, cellaZ0 + 0.4, PAL.marbleShadow);
    }
    // Three doorways.
    for (const s of [-1, 0, 1]) {
      box(stone, (s * halfW) / 1.6 - 1.6, colY, cellaZ0 - 0.1, (s * halfW) / 1.6 + 1.6, colY + colH * 0.62, cellaZ0 + 0.2, new THREE.Color(0.03, 0.026, 0.02));
    }
  } else if (detail >= 1) {
    box(stone, -2.0, colY, cellaZ0 - 0.1, 2.0, colY + colH * 0.6, cellaZ0 + 0.2, new THREE.Color(0.03, 0.026, 0.02));
  }
  // Engaged pilasters along the cella flanks.
  if (detail >= 1 && o.colsSide > 0) {
    for (let i = 0; i < o.colsSide; i++) {
      const zz = lerp(cellaZ0 + 1.5, cellaZ1 - 1.5, i / Math.max(1, o.colsSide - 1));
      for (const s of [-1, 1]) {
        column(stone, s * (halfW + colR * 0.4), colY, zz, colR * 0.72, colH, o.order, PAL.marbleShadow, detail - 1);
      }
    }
  }

  // Entablature: architrave, frieze, cornice.
  const entY = colY + colH;
  box(stone, -w / 2 - 0.2, entY, -d / 2 - 0.2, w / 2 + 0.2, entY + colR * 1.1, d / 2 + 0.2, PAL.marble, { topGain: 1.1 });
  box(stone, -w / 2 - 0.5, entY + colR * 1.1, -d / 2 - 0.5, w / 2 + 0.5, entY + colR * 2.4, d / 2 + 0.5, PAL.marbleShadow, { topGain: 1.14 });
  box(stone, -w / 2 - 1.1, entY + colR * 2.4, -d / 2 - 1.1, w / 2 + 1.1, entY + colR * 3.0, d / 2 + 1.1, PAL.marble, { topGain: 1.2 });

  const roofBase = entY + colR * 3.0;
  pediment(stone, w + 2.2, roofBase, d + 2.2, PAL.marble, 0.24);
  tiledGable(stone, roofSt, w + 1.0, d + 1.0, roofBase, ((w + 2.2) / 2) * 0.24, 0.5, o.roofCol, detail);
  // Acroteria on the ridge and the pediment corners.
  if (detail >= 1) {
    const metal = batch.s('metal');
    const apex = roofBase + ((w + 2.2) / 2) * 0.24;
    // A quadriga on the Capitoline; a simple finial elsewhere.
    if (o.cellae === 3) {
      for (let k = 0; k < 4; k++) {
        const hx = (k - 1.5) * 1.7;
        box(metal, hx - 0.55, apex, -d / 2 - 1.0, hx + 0.55, apex + 2.1, -d / 2 + 1.4, PAL.gilt);
        box(metal, hx - 0.4, apex + 2.1, -d / 2 - 0.5, hx + 0.4, apex + 3.0, -d / 2 + 0.9, PAL.gilt);
      }
      box(metal, -1.6, apex + 1.2, -d / 2 + 1.6, 1.6, apex + 3.4, -d / 2 + 3.4, PAL.gilt);
    } else {
      cone(metal, 0, apex, -d / 2 - 0.4, 0.7, 2.0, 8, PAL.bronze, PAL.gilt);
    }
  }
}

// ---------------------------------------------------------------------------
// Mausoleum of Augustus
// ---------------------------------------------------------------------------

/**
 * 87 m in diameter and about 42 m tall: concentric travertine drums retaining an
 * earth tumulus planted with evergreens, a bronze statue of Augustus on the summit,
 * and a pair of obelisks flanking the entrance on the south side.
 */
function buildMausoleum(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const rOut = MAUS_R;
  const seg = detail >= 1 ? 36 : 16;
  const drums = MAUS_DRUMS;
  const terraces = mausoleumTerraces(g);
  cylinder(stone, 0, g - 1.4, 0, rOut + 2.4, rOut + 1.9, 1.7, seg, PAL.travertineDirty, { top: true });
  let y = g + 0.3;
  for (let d = 0; d < drums.length; d++) {
    const dr = drums[d];
    // Ashlar drum, battered slightly, with pilaster strips breaking the curve.
    cylinder(stone, 0, y, 0, dr.r, dr.r * 0.99, dr.h, seg, PAL.travertineDirty, { shadeLow: 0.24 });
    if (detail >= 1) {
      // Shallow blind pilasters, recessed rather than applied: a ring of projecting
      // half-columns on an 87 m drum reads as gear teeth from above.
      const nP = Math.max(10, Math.round(dr.r * 0.5));
      for (let i = 0; i < nP; i++) {
        const a = (Math.PI * 2 * i) / nP;
        cylinder(stone, 0, y + dr.h * 0.12, 0, dr.r * 0.985, dr.r * 0.985, dr.h * 0.76, 3, PAL.travertineDirty, {
          arcFrom: a - 0.055,
          arcTo: a + 0.055,
        });
      }
    }
    // Heavy projecting cornice: without it a drum this big reads as a silo.
    cylinder(stone, 0, y + dr.h, 0, dr.r + 0.85, dr.r + 0.85, 1.0, seg, PAL.travertine, { top: true });
    cylinder(stone, 0, y + dr.h + 1.0, 0, dr.r + 0.5, dr.r + 0.5, 0.35, seg, PAL.travertine, { top: true });
    // Planted earth terrace behind it.
    const t = terraces[d];
    // Planted earth, not paving: the terraces of the Mausoleum were a grove.
    ringDisc(stone, t.rOut, t.rIn, t.y, seg, new THREE.Color().copy(PAL.dust).multiplyScalar(0.62).lerp(PAL.vine, 0.34));
    y = t.y;
  }
  // Summit tumulus over the innermost drum, then the pillar and the bronze statue.
  const summit = y;
  dome(stone, 0, summit, 0, drums[2].r * 0.94, seg, detail >= 1 ? 6 : 3, new THREE.Color().copy(PAL.dust).multiplyScalar(0.66).lerp(PAL.vine, 0.3), { heightScale: 0.24 });
  const pillarY = summit + drums[2].r * 0.94 * 0.24 - 0.5;
  cylinder(stone, 0, pillarY, 0, 4.6, 4.2, 5.2, detail >= 1 ? 18 : 8, PAL.marble, { top: true });
  cylinder(stone, 0, pillarY + 5.2, 0, 5.1, 5.1, 0.6, detail >= 1 ? 18 : 8, PAL.marbleShadow, { top: true });
  // 42 m overall to the head of the colossal bronze Augustus.
  statue(metal, 0, pillarY + 5.8, 0, 4.6, PAL.bronze, Math.PI, detail >= 1 ? 8 : 5);

  // Entrance on the south, flanked by the pair of red granite obelisks.
  stone.pushTranslate(0, g + 0.3, rOut - 0.4);
  stone.push(new THREE.Matrix4().makeRotationY(Math.PI));
  archPanel(stone, 13, 10.5, PAL.travertine, {
    depth: 4.0,
    spring: 3.8,
    openWidth: 3.6,
    segments: detail >= 1 ? 10 : 5,
    archivolt: 0.34,
    voidCol: new THREE.Color(0.03, 0.028, 0.024),
  });
  stone.pop();
  stone.pop();
  for (const s2 of [-1, 1]) {
    stone.pushTranslate(s2 * 12, 0, rOut + 9);
    buildObelisk(batch, detail, g, 9.2, 0.8);
    stone.pop();
  }
}

/** Flat annulus — planted terraces, colonnade floors, tomb platforms. */
function ringDisc(st: GeoStream, rOut: number, rIn: number, y: number, seg: number, col: THREE.Color): void {
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Vector3();
  for (let i = 0; i < seg; i++) {
    const a0 = (Math.PI * 2 * i) / seg;
    const a1 = (Math.PI * 2 * (i + 1)) / seg;
    if (rIn <= 0.01) {
      c.set(0, y, 0);
      p1.set(Math.cos(a0) * rOut, y, Math.sin(a0) * rOut);
      p2.set(Math.cos(a1) * rOut, y, Math.sin(a1) * rOut);
      st.triN(nrm, c, p1, p2, col);
      continue;
    }
    p0.set(Math.cos(a0) * rOut, y, Math.sin(a0) * rOut);
    p1.set(Math.cos(a1) * rOut, y, Math.sin(a1) * rOut);
    p2.set(Math.cos(a1) * rIn, y, Math.sin(a1) * rIn);
    p3.set(Math.cos(a0) * rIn, y, Math.sin(a0) * rIn);
    st.quadN(nrm, p0, p1, p2, p3, col);
  }
}

// ---------------------------------------------------------------------------
// Trajan's Column
// ---------------------------------------------------------------------------

/**
 * The shaft with base and capital is 29.78 m — exactly 100 Roman feet, which is what
 * the inscription's *ad declarandum quantae altitudinis* refers to — 3.7 m in
 * diameter, on a 5.4 m pedestal, with a gilt-bronze statue on top: 35.07 m overall.
 */
function buildTrajansColumn(batch: Batch, detail: number, g: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const seg = detail >= 1 ? 20 : 10;
  const r = 1.85;

  box(stone, -3.4, g, -3.4, 3.4, g + 4.4, 3.4, PAL.marble, { topGain: 1.08 });
  box(stone, -3.9, g + 4.4, -3.9, 3.9, g + 5.4, 3.9, PAL.marbleShadow, { topGain: 1.16 });
  cylinder(stone, 0, g + 5.4, 0, r * 1.24, r * 1.1, 1.0, seg, PAL.marble);
  // Shaft. The helical relief is suggested by a shallow spiral step, which is all
  // that survives the distance anyway.
  const shaftH = 26.5;
  const turns = 23;
  const bands = detail >= 2 ? turns * 3 : detail === 1 ? turns : 4;
  for (let i = 0; i < bands; i++) {
    const y0 = g + 6.4 + (shaftH * i) / bands;
    const h = shaftH / bands;
    const rr = r * (1 - (i / bands) * 0.05) * (i % 3 === 1 ? 0.985 : 1);
    cylinder(stone, 0, y0, 0, rr, rr, h, seg, i % 3 === 1 ? PAL.marbleShadow : PAL.marble);
  }
  cylinder(stone, 0, g + 6.4 + shaftH, 0, r * 1.05, r * 1.3, 1.6, seg, PAL.marble);
  box(stone, -2.7, g + 8.0 + shaftH, -2.7, 2.7, g + 8.8 + shaftH, 2.7, PAL.marble, { topGain: 1.18 });
  // Gilt bronze Trajan: 35.07 m to the top of the head.
  statue(metal, 0, g + 8.8 + shaftH, 0, 3.5, PAL.gilt, Math.PI, seg);
}

// ---------------------------------------------------------------------------
// Theatres and the Stadium
// ---------------------------------------------------------------------------

/** Roman theatre: semicircular cavea, arcaded exterior, scaenae frons behind. */
function buildTheatre(batch: Batch, detail: number, g: number, radius: number, height: number, bays: number, storeys: number): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const brick = batch.s('brick');
  const nb = detail >= 1 ? bays : Math.round(bays / 2);
  const storeyH = height / (storeys + 0.5);

  // Arcaded curved façade. The convex back of the cavea faces −Z, toward the viewer.
  for (let s = 0; s < storeys; s++) {
    const y = g + storeyH * s;
    const rr = radius - s * 0.5;
    for (let i = 0; i < nb; i++) {
      const a0 = Math.PI + (Math.PI * i) / nb;
      const a1 = Math.PI + (Math.PI * (i + 1)) / nb;
      const am = (a0 + a1) / 2;
      const bw = 2 * rr * Math.sin(Math.PI / (2 * nb));
      const px = Math.cos(am) * rr;
      const pz = Math.sin(am) * rr;
      stone.push(new THREE.Matrix4().makeRotationY(-am + Math.PI * 0.5).setPosition(px, y, pz));
      if (s < storeys - 1 || storeys === 1) {
        archPanel(stone, bw + 0.05, storeyH, PAL.travertineDirty, {
          depth: 3.6,
          spring: storeyH * 0.42,
          openWidth: Math.min(bw * 0.6, storeyH * 0.5),
          segments: detail >= 2 ? 8 : 4,
          archivolt: detail >= 2 ? 0.16 : 0,
        });
        if (detail >= 1) column(stone, bw / 2, 0, -0.5, 0.5, storeyH - 1.1, s === 0 ? 'tuscan' : s === 1 ? 'ionic' : 'corinthian', PAL.travertine, detail - 1);
      } else {
        box(stone, -bw / 2, 0, 0, bw / 2, storeyH, 3.6, PAL.travertine, { topGain: 1.1 });
      }
      stone.pop();
    }
  }
  // Attic and cornice.
  const atticY = g + storeyH * storeys;
  for (let i = 0; i < nb; i++) {
    const a0 = Math.PI + (Math.PI * i) / nb;
    const a1 = Math.PI + (Math.PI * (i + 1)) / nb;
    const am = (a0 + a1) / 2;
    const bw = 2 * radius * Math.sin(Math.PI / (2 * nb));
    brick.push(new THREE.Matrix4().makeRotationY(-am + Math.PI * 0.5).setPosition(Math.cos(am) * radius, atticY, Math.sin(am) * radius));
    box(brick, -bw / 2, 0, 0, bw / 2, storeyH * 0.5, 3.6, PAL.brick, { topGain: 1.14 });
    brick.pop();
  }

  // Cavea seating inside.
  seatingBank(
    concrete,
    radius * 0.28,
    radius - 4.5,
    g + 2.4,
    (height - 8) / (detail >= 1 ? 28 : 10),
    detail >= 1 ? 28 : 10,
    detail >= 1 ? 26 : 12,
    Math.PI,
    Math.PI * 2,
    new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(1.06)
  );
  // *Scalaria*: radial stairways dividing the cavea into wedges. From above they are
  // the single most identifiable feature of a Roman cavea.
  if (detail >= 1) {
    const cunei = 12;
    for (let i = 1; i < cunei; i++) {
      const a = Math.PI + (Math.PI * i) / cunei;
      const rise = (height - 8) / 28;
      for (let r2 = 0; r2 < 28; r2++) {
        const rr = radius * 0.28 + ((radius - 4.5 - radius * 0.28) * r2) / 28;
        const yy = g + 2.4 + rise * r2;
        const w2 = 0.55;
        const tx = -Math.sin(a) * w2;
        const tz = Math.cos(a) * w2;
        box(
          concrete,
          Math.cos(a) * rr + Math.min(0, tx),
          yy,
          Math.sin(a) * rr + Math.min(0, tz),
          Math.cos(a) * rr + Math.max(0.2, tx),
          yy + rise * 0.55,
          Math.sin(a) * rr + Math.max(0.2, tz),
          new THREE.Color().copy(PAL.travertine).multiplyScalar(1.08),
          { bottom: false }
        );
      }
    }
  }
  // Orchestra and stage.
  ellipseDisc(concrete, radius * 0.3, radius * 0.3, g + 2.4, 18, PAL.marbleShadow);
  box(concrete, -radius * 0.72, g + 2.4, 0, radius * 0.72, g + 4.0, radius * 0.2, PAL.marbleShadow, { topGain: 1.1 });
  // Scaenae frons: a tall columnar screen closing the stage.
  const sfY = g + 4.0;
  box(stone, -radius * 0.78, sfY, radius * 0.2, radius * 0.78, g + height * 0.92, radius * 0.2 + 4.5, PAL.marbleShadow, { topGain: 1.06 });
  if (detail >= 1) {
    const n = Math.max(6, Math.round(radius / 6));
    for (let i = 0; i < n; i++) {
      const px = lerp(-radius * 0.72, radius * 0.72, i / (n - 1));
      column(stone, px, sfY, radius * 0.2 - 0.9, 0.55, 11.5, 'corinthian', PAL.marble, detail - 1);
      column(stone, px, sfY + 12.4, radius * 0.2 - 0.9, 0.46, 9.5, 'corinthian', PAL.marble, detail - 1);
    }
  }
  // Porticus behind the stage, the *quadriporticus* every big theatre had.
  if (detail >= 1) {
    const pz = radius * 0.2 + 5;
    for (const side of [-1, 1]) {
      const n = 12;
      for (let i = 0; i < n; i++) {
        column(stone, side * radius * 0.8, g + 1.2, pz + i * 6.5, 0.48, 8.5, 'ionic', PAL.marble, detail - 1);
      }
    }
  }
}

/** Domitian's stadium: a U-plan arcaded track for Greek athletics. */
function buildStadium(batch: Batch, detail: number, g: number, L: number, W: number, rng: Rng): void {
  const stone = batch.s('stone');
  const concrete = batch.s('stone');
  const seatDepth = 22;
  const facadeH = 22;
  const tiers = detail >= 1 ? 18 : 8;

  box(concrete, -L / 2 + 24, g, -W / 2 + seatDepth, L / 2 - 24, g + 0.1, W / 2 - seatDepth, PAL.dust);
  for (const s of [-1, 1]) {
    const bays = detail >= 1 ? 34 : 14;
    const bw = (L - 60) / bays;
    stone.push(new THREE.Matrix4().makeRotationY(s > 0 ? Math.PI : 0).setPosition(0, g, (s * W) / 2));
    arcade(stone, bays, bw, facadeH * 0.55, PAL.travertine, {
      depth: 3.2,
      spring: 4.4,
      openWidth: Math.min(3.8, bw * 0.6),
      segments: detail >= 2 ? 8 : 4,
      archivolt: detail >= 2 ? 0.18 : 0,
    });
    box(stone, -(L - 60) / 2, facadeH * 0.55, 0, (L - 60) / 2, facadeH, 3.2, PAL.travertineDirty, { topGain: 1.12 });
    stone.pop();

    // Straight-side seating: a stepped rank along the track.
    //
    // `seatingBank` is an *annular* fan about the stream's local origin. Called here with
    // two angular segments, as an earlier revision did, it drew a single 200 m wedge right
    // across the arena — which is why the Stadium of Domitian read as a grey circus tent
    // on the skyline. A stadium's long sides are straight; they need steps, not an arc.
    const bankLen = (L - 60) / 2;
    const rowD = (seatDepth - 3) / tiers;
    const rise = (facadeH - 6) / tiers;
    for (let r = 0; r < tiers; r++) {
      const zA = s * (W / 2 - seatDepth + rowD * r);
      const zB = s * (W / 2 - seatDepth + rowD * (r + 1));
      const y = g + 2 + rise * r;
      box(concrete, -bankLen, y, Math.min(zA, zB), bankLen, y + rise, Math.max(zA, zB), PAL.travertineDirty, {
        bottom: false,
        topGain: 1.08,
      });
    }
  }
  // The *sphendone*: the semicircular closed end, at the north of the track rather than
  // wrapped round the middle of it.
  concrete.pushTranslate(-(L - 60) / 2, 0, 0);
  seatingBank(
    concrete,
    W / 2 - seatDepth,
    W / 2 - 3,
    g + 2,
    (facadeH - 6) / tiers,
    tiers,
    detail >= 1 ? 16 : 8,
    Math.PI / 2,
    Math.PI * 1.5,
    PAL.travertineDirty
  );
  concrete.pop();
}

// ---------------------------------------------------------------------------
// Basilica, Forum, Baths, Castra
// ---------------------------------------------------------------------------

/** Basilica Ulpia: a 130 × 55 m hall with apses at both ends and a bronze roof. */
function buildBasilica(batch: Batch, detail: number, g: number, L: number, W: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const navH = 26;

  box(stone, -L / 2, g - 0.6, -W / 2, L / 2, g + 1.4, W / 2, PAL.travertineDirty, { topGain: 1.06 });
  // Aisle walls with engaged columns; the nave rises above them.
  box(stone, -L / 2, g + 1.4, -W / 2, L / 2, g + 13.5, W / 2, PAL.marbleShadow, { topGain: 1.06 });
  box(stone, -L / 2 + 6, g + 13.5, -W / 2 + 9, L / 2 - 6, g + navH, W / 2 - 9, PAL.marble, { topGain: 1.06 });
  if (detail >= 1) {
    const n = Math.round(L / 7);
    for (let i = 0; i < n; i++) {
      const px = lerp(-L / 2 + 4, L / 2 - 4, i / (n - 1));
      for (const s of [-1, 1]) column(stone, px, g + 1.4, (s * W) / 2 + s * 0.4, 0.62, 11.5, 'corinthian', PAL.marble, detail - 1);
      // Clerestory windows above the aisle roofs.
      box(stone, px - 1.4, g + 16, -W / 2 + 8.8, px + 1.4, g + 21, -W / 2 + 9.2, new THREE.Color(0.05, 0.045, 0.04));
      box(stone, px - 1.4, g + 16, W / 2 - 9.2, px + 1.4, g + 21, W / 2 - 8.8, new THREE.Color(0.05, 0.045, 0.04));
    }
  }
  // Apses.
  for (const s of [-1, 1]) {
    cylinder(stone, (s * L) / 2, g + 1.4, 0, W * 0.36, W * 0.36, 15, detail >= 1 ? 16 : 8, PAL.marbleShadow, {
      arcFrom: s < 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
      arcTo: s < 0 ? Math.PI * 1.5 : Math.PI * 0.5,
    });
    dome(metal, (s * L) / 2, g + 16.4, 0, W * 0.36, detail >= 1 ? 16 : 8, 5, PAL.bronze, { heightScale: 0.55 });
  }
  // Gilt-bronze tiled roofs: the aisles low, the nave high.
  gableRoof(stone, metal, L - 12, W - 18, g + navH, 4.5, 1.0, PAL.bronze, true);
  for (const s of [-1, 1]) {
    const z0 = (s * (W / 2 + W / 2 - 9)) / 2;
    box(metal, -L / 2, g + 13.5, Math.min(z0, (s * W) / 2), L / 2, g + 14.0, Math.max(z0, (s * W) / 2), PAL.bronze);
  }
}

/** A colonnaded forum square with temples, arches and honorific columns. */
function buildForum(batch: Batch, detail: number, g: number, rng: Rng): void {
  const stone = batch.s('stone');
  const road = batch.s('road');
  const W = 96;
  const D = 132;

  // Paved piazza.
  box(road, -W / 2, g, -D / 2, W / 2, g + 0.12, D / 2, PAL.marbleShadow, { topGain: 1.05 });
  // Porticoes on three sides.
  const colH = 8.6;
  for (const side of [-1, 1]) {
    const n = Math.round(D / 5.4);
    for (let i = 0; i < n; i++) {
      const zz = lerp(-D / 2 + 3, D / 2 - 3, i / (n - 1));
      column(stone, (side * W) / 2, g + 0.7, zz, 0.5, colH, 'corinthian', PAL.marble, detail - 1);
      if (detail >= 1) column(stone, side * (W / 2 + 7), g + 0.7, zz, 0.5, colH, 'corinthian', PAL.marbleShadow, detail - 1);
    }
    box(stone, (side * W) / 2 - side * 0.9, g + 0.7 + colH, -D / 2, (side * W) / 2 + side * 8.2, g + 0.7 + colH + 1.9, D / 2, PAL.marble, {
      topGain: 1.12,
    });
    box(batch.s('roof'), (side * W) / 2 - side * 1.2, g + 0.7 + colH + 1.9, -D / 2, (side * W) / 2 + side * 9, g + 0.7 + colH + 3.4, D / 2, PAL.roofTile, {
      topGain: 1.1,
    });
  }
  // A temple closing the north end, facing down the square.
  stone.pushTranslate(0, 0, D / 2 - 26);
  buildTemple(batch, detail, g, {
    w: 26,
    d: 40,
    podiumH: 3.4,
    colH: 12,
    colR: 0.66,
    colsFront: 6,
    colsSide: 5,
    porchRows: 2,
    order: 'corinthian',
    roofCol: PAL.bronze,
    roofMat: 'roof',
    wallCol: PAL.marble,
    cellae: 1,
  });
  stone.pop();
  // Rostra, honorific columns and a triumphal arch.
  box(stone, -16, g + 0.12, -D / 2 + 8, 16, g + 3.2, -D / 2 + 16, PAL.marbleShadow, { topGain: 1.1 });
  if (detail >= 1) {
    for (let i = 0; i < 7; i++) {
      const px = lerp(-W / 2 + 12, W / 2 - 12, i / 6);
      column(stone, px, g + 0.12, -D / 2 + 26, 0.55, 11.5, 'corinthian', PAL.marble, detail - 1);
      statue(batch.s('metal'), px, g + 12.5, -D / 2 + 26, 3.0, PAL.gilt, Math.PI, detail >= 1 ? 7 : 5);
    }
    // Triumphal arch on the axis.
    stone.pushTranslate(0, 0, -D / 2 - 4);
    archPanel(stone, 22, 18, PAL.marble, { depth: 7, spring: 7.5, openWidth: 6.6, segments: detail >= 2 ? 12 : 6, backFace: true, archivolt: 0.4 });
    box(stone, -11.6, g + 18, -0.7, 11.6, g + 22, 7.7, PAL.marble, { topGain: 1.14 });
    for (let k = 0; k < 4; k++) {
      const hx = (k - 1.5) * 2.0;
      box(batch.s('metal'), hx - 0.7, g + 22, 2.2, hx + 0.7, g + 24.6, 4.4, PAL.gilt);
    }
    stone.pop();
  }
}

/** Imperial baths: a vaulted block in a walled precinct, unmistakable from above. */
function buildBaths(batch: Batch, detail: number, g: number, W: number, D: number, rng: Rng): void {
  const brick = batch.s('brick');
  const concrete = batch.s('stone');
  const stone = batch.s('stone');

  // Precinct wall with exedrae.
  box(brick, -W / 2, g, -D / 2, W / 2, g + 8.5, -D / 2 + 2.2, PAL.brick, { topGain: 1.08 });
  box(brick, -W / 2, g, D / 2 - 2.2, W / 2, g + 8.5, D / 2, PAL.brick, { topGain: 1.08 });
  box(brick, -W / 2, g, -D / 2, -W / 2 + 2.2, g + 8.5, D / 2, PAL.brick, { topGain: 1.08 });
  box(brick, W / 2 - 2.2, g, -D / 2, W / 2, g + 8.5, D / 2, PAL.brick, { topGain: 1.08 });

  // Central block: frigidarium with three cross-vaults, caldarium apse to the south.
  const bw = W * 0.5;
  const bd = D * 0.44;
  box(brick, -bw / 2, g, -bd / 2, bw / 2, g + 22, bd / 2, PAL.brick, { topGain: 1.06 });
  const vaultSeg = detail >= 1 ? 14 : 7;
  for (let i = 0; i < 3; i++) {
    const px = (i - 1) * (bw / 3);
    // Barrel vault as a half-cylinder lying along Z.
    const vm = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(px, g + 22, 0);
    concrete.push(vm);
    cylinder(concrete, 0, -bd / 2, 0, bw / 6.4, bw / 6.4, bd, vaultSeg, PAL.concrete, { arcFrom: 0, arcTo: Math.PI });
    concrete.pop();
  }
  // Caldarium: a domed rotunda on the sunny side.
  cylinder(brick, 0, g, bd / 2 + 14, 15, 15, 18, detail >= 1 ? 20 : 10, PAL.brick, { shadeLow: 0.16 });
  dome(concrete, 0, g + 18, bd / 2 + 14, 15, detail >= 1 ? 20 : 10, detail >= 1 ? 7 : 3, PAL.concrete, { heightScale: 0.8 });
  // Palaestrae: colonnaded courts either side.
  if (detail >= 1) {
    for (const s of [-1, 1]) {
      const px = (s * W) / 2 - s * 22;
      for (let i = 0; i < 8; i++) {
        const zz = lerp(-bd / 2, bd / 2, i / 7);
        column(stone, px, g + 0.6, zz, 0.5, 7.5, 'corinthian', PAL.marble, detail - 1);
      }
    }
    // Great semicircular exedra in the back wall.
    cylinder(brick, 0, g, -D / 2 + 1, 22, 22, 11, 14, PAL.brick, { arcFrom: 0, arcTo: Math.PI });
  }
}

/** Castra Praetoria: the Praetorian barracks, a fortified brick camp. */
function buildCastra(batch: Batch, detail: number, g: number, W: number, D: number, heightAt: Ground, m: LandmarkPlacement): void {
  const brick = batch.s('brick');
  const roof = batch.s('roof');
  const H = 4.7; // original height; Aurelian later incorporated it into the circuit
  const t = 1.4;

  const sides: [number, number, number, number][] = [
    [-W / 2, -D / 2, W / 2, -D / 2],
    [-W / 2, D / 2, W / 2, D / 2],
    [-W / 2, -D / 2, -W / 2, D / 2],
    [W / 2, -D / 2, W / 2, D / 2],
  ];
  for (const [x0, z0, x1, z1] of sides) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const g0 = heightAt(m.x + x0, m.z + z0) - g;
    quadPrism(brick, x0, z0, x1, z1, -dz, dx, t, g + g0 - 1.2, g + H, PAL.brick, PAL.travertine, { ends: false });
    crenellation(brick, x0, z0, x1, z1, g + H, 1.5, t, PAL.brick, 1.3, 0.7, detail >= 1);
    // Square interval towers.
    const nT = Math.max(2, Math.round(len / 30));
    for (let i = 0; i <= nT; i++) {
      const px = lerp(x0, x1, i / nT);
      const pz = lerp(z0, z1, i / nT);
      quadPrism(brick, px - dx * 2.2, pz - dz * 2.2, px + dx * 2.2, pz + dz * 2.2, -dz, dx, t + 2.4, g - 1.2, g + H + 3.2, PAL.brick, PAL.brickPale);
      if (detail >= 1) {
        roof.pushTranslate(px, 0, pz);
        hipRoof(roof, 5.6, 5.6, g + H + 3.2, 1.4, 0.3, PAL.roofTile);
        roof.pop();
      }
    }
  }
  // Barrack ranges inside.
  if (detail >= 1) {
    for (let r = 0; r < 6; r++) {
      const zz = lerp(-D / 2 + 26, D / 2 - 26, r / 5);
      box(brick, -W / 2 + 20, g, zz - 5, W / 2 - 20, g + 6.2, zz + 5, PAL.ochreDeep, { topGain: 1.06 });
      brick.pushTranslate(0, 0, zz);
      roof.pushTranslate(0, 0, zz);
      gableRoof(brick, roof, W - 40, 10, g + 6.2, 2.6, 0.6, PAL.roofTileOld, true);
      brick.pop();
      roof.pop();
    }
    // Principia on the axis.
    box(brick, -22, g, -6, 22, g + 11, 10, PAL.brickPale, { topGain: 1.08 });
    gableRoof(brick, roof, 44, 16, g + 11, 4.5, 0.8, PAL.roofTile, true);
  }
}

// ---------------------------------------------------------------------------
// Small monuments
// ---------------------------------------------------------------------------

/** Egyptian obelisk on a plinth. Roman obelisks taper about 1 : 10 and are pyramidal-tipped. */
function buildObelisk(batch: Batch, detail: number, g: number, height: number, baseHalf: number): void {
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const plinth = height * 0.14;
  box(stone, -baseHalf * 2.4, g, -baseHalf * 2.4, baseHalf * 2.4, g + plinth, baseHalf * 2.4, PAL.peperino, { topGain: 1.08 });
  const shaftH = height * 0.9;
  const top = baseHalf * 0.66;
  box(stone, -baseHalf, g + plinth, -baseHalf, baseHalf, g + plinth + shaftH, baseHalf, PAL.brickDark, {
    batter: (baseHalf - top) / shaftH,
    topGain: 1.1,
  });
  // Pyramidion, sheathed in bronze on the Augustan obelisks.
  cone(metal, 0, g + plinth + shaftH, 0, top * 1.42, height * 0.1, 4, PAL.bronze, PAL.gilt);
}

/** Walled altar enclosure — the Ara Pacis and its many imitators. */
function buildAltarEnclosure(batch: Batch, detail: number, g: number, w: number, d: number): void {
  const stone = batch.s('stone');
  const t = 0.6;
  box(stone, -w / 2 - 1, g - 0.4, -d / 2 - 1, w / 2 + 1, g + 0.5, d / 2 + 1, PAL.travertineDirty, { topGain: 1.06 });
  box(stone, -w / 2, g + 0.5, -d / 2, w / 2, g + 4.8, -d / 2 + t, PAL.marble, { topGain: 1.14 });
  box(stone, -w / 2, g + 0.5, d / 2 - t, w / 2, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  box(stone, -w / 2, g + 0.5, -d / 2, -w / 2 + t, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  box(stone, w / 2 - t, g + 0.5, -d / 2, w / 2, g + 4.8, d / 2, PAL.marble, { topGain: 1.14 });
  // The altar itself, on its steps.
  stone.pushTranslate(0, 0, 1.5);
  steps(stone, w * 0.5, g + 0.5, -1.5, 5, 0.28, 0.34, PAL.marble);
  stone.pop();
  box(stone, -w * 0.22, g + 1.9, -1.2, w * 0.22, g + 3.1, 1.6, PAL.marble, { topGain: 1.16 });
}

/** Palace terraces on the Palatine: long substructure arcades and roof gardens. */
function buildPalatine(batch: Batch, detail: number, g: number, rng: Rng): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');

  // The great façade of the Domus Augustana, arcaded over its substructures.
  brick.pushTranslate(0, 0, -104);
  arcade(brick, detail >= 1 ? 22 : 10, 9.5, 18, PAL.brick, {
    depth: 5,
    spring: 5.5,
    openWidth: 5.0,
    segments: detail >= 2 ? 9 : 5,
    archivolt: detail >= 2 ? 0.24 : 0,
  });
  box(brick, -105, g + 18, 0, 105, g + 24, 5, PAL.brickPale, { topGain: 1.1 });
  brick.pop();

  // Blocks of palace above, in painted stucco with tiled roofs.
  const blocks: [number, number, number, number, number][] = [
    [-60, -50, 70, 44, 15],
    [30, -34, 62, 50, 18],
    [-10, 40, 96, 46, 13],
    [-72, 34, 44, 40, 11],
  ];
  for (const [bx, bz, bw, bd, bh] of blocks) {
    const st = batch.s('stucco');
    st.pushTranslate(bx, 0, bz);
    roof.pushTranslate(bx, 0, bz);
    box(st, -bw / 2, g, -bd / 2, bw / 2, g + bh, bd / 2, PAL.limeWhite, { topGain: 1.05 });
    hipRoof(roof, bw + 1.6, bd + 1.6, g + bh, Math.min(bw, bd) * 0.16, 0.9, PAL.roofTile);
    st.pop();
    roof.pop();
  }
  // A colonnaded peristyle court with a pool.
  box(stone, -34, g + 0.1, -6, 34, g + 0.2, 26, PAL.marbleShadow, { topGain: 1.05 });
  if (detail >= 1) {
    for (let i = 0; i < 12; i++) {
      const px = lerp(-32, 32, i / 11);
      column(stone, px, g + 0.2, -6, 0.44, 7.5, 'corinthian', PAL.marble, detail - 1);
      column(stone, px, g + 0.2, 26, 0.44, 7.5, 'corinthian', PAL.marble, detail - 1);
    }
  }
}

/** Gardens: terraces, pergolas, fountains and heavy planting. */
function buildGardens(batch: Batch, detail: number, g: number, rng: Rng, clear: number): void {
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const R = clear * 0.9;

  // A garden pavilion and a long pergola walk.
  box(stone, -9, g, -7, 9, g + 5.5, 7, PAL.limeWhite, { topGain: 1.06 });
  hipRoof(batch.s('roof'), 20, 16, g + 5.5, 3.2, 1.0, PAL.roofTile);
  if (detail >= 1) {
    for (let i = 0; i < 14; i++) {
      const px = lerp(-R * 0.7, R * 0.7, i / 13);
      for (const s of [-1, 1]) {
        cylinder(stone, px, g, s * 3.2 + 26, 0.24, 0.22, 3.0, 7, PAL.marbleShadow);
      }
      cylinderBetween(timber, px, g + 3.1, 22.8, px, g + 3.1, 29.2, 0.09, PAL.timber);
    }
    for (const s of [-1, 1]) {
      cylinderBetween(timber, -R * 0.7, g + 3.15, s * 3.2 + 26, R * 0.7, g + 3.15, s * 3.2 + 26, 0.1, PAL.timberDark);
    }
    // Fountain basin.
    cylinder(stone, 0, g, -24, 6.5, 6.5, 0.9, 16, PAL.marble, { top: true });
    cylinder(stone, 0, g + 0.9, -24, 1.2, 0.5, 2.4, 10, PAL.marble, { top: true });
  }

}

// ---------------------------------------------------------------------------
// Aqueducts
// ---------------------------------------------------------------------------

/**
 * An arcade carrying a water channel. The Aqua Claudia reached 28 m on piers about
 * 2.4 m wide with spans of some 5.5 m; the Aqua Virgo crossed the Campus Martius on
 * a much lower arcade to reach the Baths of Agrippa.
 */
function buildAqueduct(
  batch: Batch,
  detail: number,
  aq: (typeof AQUEDUCTS)[number],
  heightAt: Ground
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const bay = aq.bayWidth;

  for (let seg = 0; seg + 1 < aq.path.length; seg++) {
    const a = aq.path[seg];
    const b = aq.path[seg + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / bay));
    const dirY = Math.atan2(b.x - a.x, b.z - a.z);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const px = lerp(a.x, b.x, t);
      const pz = lerp(a.z, b.z, t);
      const g = heightAt(px, pz);
      // The channel must fall continuously, so its soffit is set from the run's ends
      // and the piers take up the difference — exactly the real engineering problem.
      const chY = lerp(heightAt(a.x, a.z) + aq.height, heightAt(b.x, b.z) + aq.height * 0.94, t);
      const h = chY - g;
      if (h < 3) continue;
      const m = new THREE.Matrix4().makeRotationY(dirY).setPosition(px, g, pz);
      stone.push(m);
      brick.push(m);
      const spring = Math.max(2.5, h - bay * 0.5 - 1.6);
      const open = Math.min(bay - aq.pierWidth, (h - spring) * 2);
      archPanel(stone, bay + 0.05, h, PAL.travertineDirty, {
        depth: 2.6,
        spring,
        openWidth: Math.max(2.0, open),
        segments: detail >= 2 ? 10 : detail === 1 ? 6 : 3,
        backFace: true,
        archivolt: detail >= 2 ? 0.16 : 0,
      });
      // The *specus*: the covered channel on top, with its cover slabs.
      box(brick, -bay / 2 - 0.03, h, -1.6, bay / 2 + 0.03, h + 1.9, 1.6, PAL.brick, { topGain: 1.14 });
      box(stone, -bay / 2 - 0.03, h + 1.9, -1.85, bay / 2 + 0.03, h + 2.25, 1.85, PAL.travertine, { topGain: 1.2 });
      // A second, taller tier on the tallest runs, as at the Porta Maggiore.
      if (aq.height > 20 && h > 18) {
        archPanel(stone, bay + 0.05, spring, PAL.travertineDirty, {
          depth: 2.6,
          spring: Math.max(2.2, spring * 0.5),
          openWidth: Math.max(1.8, bay - aq.pierWidth - 0.6),
          segments: detail >= 2 ? 8 : 4,
          backFace: true,
        });
      }
      stone.pop();
      brick.pop();
    }
  }
}

// ---------------------------------------------------------------------------
// Far horizon
// ---------------------------------------------------------------------------

/**
 * A ring of low hills beyond the terrain's edge, so the city does not end against
 * bare sky. From the battlefield these sit 1.5–2.5 km out and read as the Alban
 * hills through the aerial haze — cheap, and the frame collapses without them.
 */
function buildFarHills(batch: Batch, heightAt: Ground): void {
  const st = batch.s('stone');
  const ridge = new THREE.Color().copy(PAL.peperino).multiplyScalar(0.85);
  const far = new THREE.Color().copy(PAL.peperino).multiplyScalar(0.62);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  // Three concentric ridges of increasing distance and decreasing contrast.
  const layers = [
    { r: 1560, h: 62, freq: 5.5, tint: ridge },
    { r: 2050, h: 108, freq: 3.5, tint: new THREE.Color().lerpColors(ridge, far, 0.5) },
    { r: 2600, h: 168, freq: 2.5, tint: far },
  ];
  for (const L of layers) {
    const seg = 96;
    for (let i = 0; i < seg; i++) {
      const a0 = (Math.PI * 2 * i) / seg;
      const a1 = (Math.PI * 2 * (i + 1)) / seg;
      const hAt = (a: number): number =>
        L.h *
        (0.35 +
          0.4 * (0.5 + 0.5 * Math.sin(a * L.freq + L.r * 0.001)) +
          0.25 * (0.5 + 0.5 * Math.sin(a * L.freq * 2.7 + 1.3)));
      const base = heightAt(0, 1200) - 30;
      p0.set(Math.cos(a0) * L.r, base, Math.sin(a0) * L.r);
      p1.set(Math.cos(a1) * L.r, base, Math.sin(a1) * L.r);
      p2.set(Math.cos(a1) * L.r, base + hAt(a1), Math.sin(a1) * L.r);
      p3.set(Math.cos(a0) * L.r, base + hAt(a0), Math.sin(a0) * L.r);
      nrm.set(-Math.cos((a0 + a1) / 2), 0.25, -Math.sin((a0 + a1) / 2)).normalize();
      st.quadN(nrm, p0, p1, p2, p3, L.tint, L.tint, L.tint, L.tint);
    }
  }
}

// ---------------------------------------------------------------------------
// Tombs along the Via Flaminia
// ---------------------------------------------------------------------------

/**
 * Roadside tombs. Burial inside the walls was forbidden from the Twelve Tables on, so
 * the approaches to every Roman city ran through a street of monuments: drum tombs on
 * square podia after the fashion of Caecilia Metella, altar tombs, brick columbaria,
 * aedicula tombs and plain cippi, with cypress planted between them.
 */
export type TombKind = 'drum' | 'altar' | 'columbarium' | 'aedicula' | 'tumulus' | 'cippus';

export interface TombSite {
  x: number;
  z: number;
  kind: TombKind;
  rot: number;
  /** Governing dimension: drum radius, altar half-width, block half-width. */
  size: number;
  tone: number;
}

/**
 * Choose the tomb sites. Split out from the geometry so the planting that goes with
 * them is known before any chunk is baked, and so a tomb never changes type when its
 * chunk swaps detail level.
 */
function planRoadTombs(heightAt: Ground, rng: Rng): { sites: TombSite[]; trees: TreeRequest[] } {
  const sites: TombSite[] = [];
  const trees: TreeRequest[] = [];
  // Fixed pairs flanking the carriageway: the grandest tombs always stood closest to
  // the gate, and they are also the foreground of the establishing shot.
  // Positions are given as (metres back from the gate along the road, lateral offset)
  // and resolved against the road centreline and the crest, so the whole necropolis
  // follows the terrain instead of sitting at fixed coordinates.
  const gateZ = crestZAt(GATE_X);
  const onRoad = (back: number, lateral: number): { x: number; z: number } => {
    const z = gateZ - back;
    return { x: roadCentreX(z) + lateral, z };
  };
  const fixedSpec: [number, number, TombKind, number, number, number][] = [
    [26, -20, 'drum', 6.4, 0.1, 1.0],
    [30, 25, 'altar', 3.5, -0.08, 0.94],
    [62, -27, 'aedicula', 4.4, 0.06, 1.06],
    [66, 30, 'drum', 5.2, -0.14, 0.9],
    [104, -33, 'columbarium', 4.6, 0.12, 1.02],
    [112, 36, 'tumulus', 7.4, 0, 0.96],
    [150, -26, 'altar', 4.0, 0.2, 1.1],
    [158, 31, 'aedicula', 4.6, -0.2, 0.88],
  ];
  const fixed: TombSite[] = fixedSpec.map(([back, lat, kind, size, rot, tone]) => {
    const p = onRoad(back, lat);
    return { x: p.x, z: p.z, kind, rot, size, tone };
  });
  for (const t of fixed) {
    sites.push(t);
    if (t.kind === 'tumulus') trees.push({ x: t.x, z: t.z, kind: 'cypress', scale: 0.85, y: heightAt(t.x, t.z) + 2.2 + t.size * 0.4 });
    trees.push({ x: t.x + (t.x < 0 ? -8 : 8), z: t.z + 5, kind: 'cypress', scale: 1.05 });
    trees.push({ x: t.x + (t.x < 0 ? -6 : 6), z: t.z - 7, kind: 'cypress', scale: 0.92 });
  }
  for (let i = 0; i < 34; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    // The belt ran a couple of hundred metres out from the gate and crowded the road:
    // frontage on the Flaminia was the whole point of the monument.
    const z = gateZ - rng.range(14, 205);
    const x = roadCentreX(z) + side * (14 + rng.next() ** 1.7 * 62);
    const kind = rng.pickWeighted(
      ['drum', 'altar', 'columbarium', 'aedicula', 'tumulus', 'cippus'] as const,
      [0.18, 0.24, 0.14, 0.14, 0.14, 0.16]
    );
    const size = kind === 'drum' ? rng.range(4.2, 7.5) : kind === 'tumulus' ? rng.range(6, 11) : rng.range(2.6, 5.4);
    const rot = rng.jitter(0.5);
    const tone = rng.range(0.6, 1.05);
    const plantIt = rng.bool(0.6);
    const pa = rng.range(0, Math.PI * 2);
    const pr = rng.range(8, 13);
    const ps = rng.range(0.75, 1.1);
    // Keep the carriageway clear and stop tombs growing into one another.
    if (Math.abs(x - roadCentreX(z)) < 13) continue;
    let tooClose = false;
    for (const p of sites) if (Math.hypot(p.x - x, p.z - z) < size + p.size + 12) tooClose = true;
    if (tooClose) continue;
    sites.push({ x, z, kind, rot, size, tone });
    if (kind === 'tumulus') {
      trees.push({ x, z, kind: 'cypress', scale: 0.8, y: heightAt(x, z) + 2.2 + size * 0.4 });
    }
    // Cypress beside most tombs: the funerary tree, and it breaks the skyline of the
    // plain in front of the wall.
    if (plantIt) trees.push({ x: x + Math.cos(pa) * pr, z: z + Math.sin(pa) * pr, kind: 'cypress', scale: ps });
  }
  return { sites, trees };
}

function buildRoadTombs(batch: Batch, detail: number, heightAt: Ground, sites: TombSite[]): void {
  // Every stream this builder can touch, resolved up front and pushed together — the same
  // rule `buildLandmark` follows, and for the same reason.
  //
  // The aedicula branch used to reach for `batch.s('roof')` inline, inside the pushed region
  // but without ever pushing it, so its gable was emitted in *unshifted local coordinates*:
  // both aedicula roofs ended up stacked at the world origin at 20–30 m altitude, which is
  // dead centre of the battlefield. That is the pair of terracotta planes floating in mid-air
  // over open ground in every strategic frame. An unpushed stream fails silently and puts the
  // geometry somewhere plausible-looking, which is why it survived several passes.
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const metal = batch.s('metal');
  const roof = batch.s('roof');
  const pushed = [stone, brick, metal, roof];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const g = heightAt(site.x, site.z);
    const m = new THREE.Matrix4().makeRotationY(site.rot).setPosition(site.x, 0, site.z);
    for (const st of pushed) st.push(m);
    const kind = site.kind;
    // Roadside tombs are tufa, travertine and brick, and half of them were rendered and
    // painted. Marble was for the very rich, and a whole necropolis of it reads as snow.
    const stock = hash2(i, 3, 617);
    // Tufa and peperino were cheap and got rendered; the render got painted. Ostia and the
    // Isola Sacra necropolis are full of ochre and red-washed tombs, and a street of bare
    // grey stone — which is what the first pass of this necropolis was — is both wrong and
    // the dullest possible frame.
    const base =
      stock < 0.30 ? PAL.travertineDirty
      : stock < 0.50 ? PAL.tufa
      : stock < 0.62 ? PAL.peperino
      : stock < 0.74 ? PAL.limeWhite
      : stock < 0.86 ? PAL.ochrePale
      : stock < 0.95 ? PAL.terraDirty
      : PAL.pompeianRed;
    const weathered = new THREE.Color().copy(base).multiplyScalar(site.tone * 0.86);

    if (kind === 'drum') {
      // Caecilia Metella is 29.5 m across; the ordinary roadside version is a third
      // of that on a square podium two courses high.
      const r = site.size;
      const podium = r * 1.35;
      box(stone, -podium, g - 0.5, -podium, podium, g + r * 0.55, podium, new THREE.Color().copy(weathered).multiplyScalar(0.82), { topGain: 1.06, groundShade: 0.22 });
      cylinder(stone, 0, g + r * 0.55, 0, r, r * 0.98, r * 1.5, detail >= 1 ? 16 : 8, weathered, { shadeLow: 0.26 });
      cylinder(stone, 0, g + r * 0.55 + r * 1.5, 0, r + 0.5, r + 0.5, 0.6, detail >= 1 ? 16 : 8, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { top: true });
      if (detail >= 1) {
        // Frieze of bucrania and garlands, read as a band of blocks at this distance.
        const n = detail >= 2 ? 18 : 10;
        for (let k = 0; k < n; k++) {
          const a = (Math.PI * 2 * k) / n;
          box(stone, Math.cos(a) * r - 0.34, g + r * 0.55 + r * 1.18, Math.sin(a) * r - 0.34, Math.cos(a) * r + 0.34, g + r * 0.55 + r * 1.42, Math.sin(a) * r + 0.34, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.96));
        }
      }
      // Conical earth cap, as on Caecilia Metella before the medieval crenellations.
      cylinder(stone, 0, g + r * 0.55 + r * 1.5 + 0.6, 0, r * 0.92, 0, r * 0.8, detail >= 1 ? 14 : 7, new THREE.Color().copy(PAL.dust).multiplyScalar(0.7).lerp(PAL.vine, 0.28));
    } else if (kind === 'altar') {
      const w = site.size * 0.8;
      const h = site.size * 1.35;
      box(stone, -w * 1.25, g - 0.4, -w * 1.25, w * 1.25, g + 0.7, w * 1.25, weathered, { topGain: 1.1 });
      box(stone, -w, g + 0.7, -w, w, g + h, w, new THREE.Color().copy(weathered).multiplyScalar(1.12), { topGain: 1.12 });
      // Drip staining under the cornice, and dirt splashed up off the road onto the plinth.
      // Water sheds off a projecting cornice and runs back onto the face below it, so a
      // monument is dark in a band immediately under its overhang and dark again at its
      // foot, and pale and sun-bleached in between. Nothing sells cut stone as *old* faster.
      dripStain(stone, w, g + h - w * 0.42, w * 0.42, weathered, 0.60, true);
      dripStain(stone, w * 1.25, g - 0.3, 0.85, weathered, 0.52, false);
      box(stone, -w * 1.16, g + h, -w * 1.16, w * 1.16, g + h + 0.55, w * 1.16, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.92), { topGain: 1.2 });
      if (detail >= 1) {
        // Inscription panel and a portrait niche.
        box(stone, -w * 0.66, g + h * 0.52, -w - 0.07, w * 0.66, g + h * 0.86, -w + 0.06, PAL.marbleShadow);
        box(stone, -w * 0.34, g + h * 0.14, -w - 0.04, w * 0.34, g + h * 0.46, -w + 0.22, new THREE.Color(0.05, 0.045, 0.04));
        // Corner *pulvini*: horizontal bolsters lying along the top, which is the
        // detail that makes an altar tomb read as an altar.
        for (const sx of [-1, 1]) {
          const bm = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(sx * w * 0.78, g + h + 0.86, -w * 0.9);
          stone.push(bm);
          cylinder(stone, 0, 0, 0, 0.3, 0.3, w * 1.8, 8, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), { top: true, bottom: true });
          stone.pop();
        }
      }
    } else if (kind === 'columbarium') {
      const w = site.size * 1.15;
      const d = site.size * 0.92;
      const h = site.size * 1.5;
      box(brick, -w, g - 0.5, -d, w, g + h, d, new THREE.Color().copy(PAL.brick).multiplyScalar(site.tone * 0.92), { groundShade: 0.26, topGain: 1.06 });
      // Brick stains harder than stone: the whole top third under the cornice goes dark.
      dripStain(brick, Math.min(w, d), g + h - h * 0.3, h * 0.3, new THREE.Color().copy(PAL.brick).multiplyScalar(site.tone * 0.92), 0.44, true);
      box(stone, -w - 0.3, g + h, -d - 0.3, w + 0.3, g + h + 0.4, d + 0.3, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { topGain: 1.18 });
      if (detail >= 1) {
        brick.pushTranslate(0, g, -d);
        archPanel(brick, w * 2, h, PAL.brick, { depth: 0.5, spring: 2.3, openWidth: 1.4, segments: detail >= 2 ? 7 : 4, voidCol: new THREE.Color(0.03, 0.026, 0.02) });
        brick.pop();
        // Rows of niche arches down the flank.
        for (let r2 = 0; r2 < 2; r2++) {
          for (let k = 0; k < 3; k++) {
            const px = -w * 0.6 + (k * w * 1.2) / 2;
            box(brick, px - 0.34, g + 1.2 + r2 * 1.9, d - 0.06, px + 0.34, g + 2.2 + r2 * 1.9, d + 0.18, new THREE.Color(0.04, 0.035, 0.03));
          }
        }
      }
    } else if (kind === 'aedicula') {
      const w = site.size * 0.9;
      box(stone, -w, g - 0.4, -w * 0.8, w, g + 2.2, w * 0.8, weathered, { topGain: 1.1 });
      for (const sx of [-1, 1]) column(stone, sx * (w - 0.55), g + 2.2, -w * 0.6, 0.34, 4.4, 'corinthian', new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), detail - 1);
      box(stone, -w, g + 2.2, w * 0.1, w, g + 6.8, w * 0.8, weathered, { topGain: 1.08 });
      box(stone, -w - 0.25, g + 6.6, -w * 0.85, w + 0.25, g + 7.3, w * 0.85, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), { topGain: 1.16 });
      pediment(stone, (w + 0.25) * 2, g + 7.3, w * 1.7, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.94), 0.26);
      // A pediment with nothing behind it is a flat-topped box with a triangle on it.
      gableRoof(stone, roof, (w + 0.25) * 2 - 0.4, w * 1.7 - 0.4, g + 7.3, (w + 0.25) * 0.26, 0.3, PAL.roofTileOld, false);
      if (detail >= 1) box(stone, -0.5, g + 2.4, -w * 0.2, 0.5, g + 5.4, w * 0.3, new THREE.Color(0.04, 0.036, 0.03));
    } else if (kind === 'tumulus') {
      const r = site.size;
      cylinder(stone, 0, g - 0.6, 0, r, r * 0.98, 2.4, detail >= 1 ? 14 : 7, weathered, { shadeLow: 0.2 });
      cylinder(stone, 0, g + 1.8, 0, r + 0.4, r + 0.4, 0.4, detail >= 1 ? 14 : 7, PAL.travertine, { top: true });
      dome(stone, 0, g + 2.2, 0, r * 0.95, detail >= 1 ? 14 : 7, detail >= 1 ? 5 : 2, new THREE.Color().copy(PAL.dust).multiplyScalar(0.68).lerp(PAL.vine, 0.36), { heightScale: 0.42 });
    } else {
      // A plain *cippus* and a bench: the poor man's frontage on the great road.
      const h = 0.55 + site.size * 0.4;
      box(stone, -0.55, g - 0.3, -0.5, 0.55, g + h, 0.5, weathered, { topGain: 1.14 });
      box(stone, -0.75, g + h, -0.68, 0.75, g + h + 0.28, 0.68, new THREE.Color().copy(PAL.travertine).multiplyScalar(0.9), { topGain: 1.2 });
      if (detail >= 1) {
        box(stone, -0.42, g + h * 0.45, -0.56, 0.42, g + h * 0.82, -0.46, PAL.marble);
        box(stone, 1.3, g, -0.8, 3.4, g + 0.45, 0.8, weathered, { topGain: 1.12 });
      }
      if (detail >= 2) box(metal, -0.3, g + h + 0.28, -0.3, 0.3, g + h + 1.1, 0.3, PAL.bronze);
    }

    for (const st of pushed) st.pop();
  }
}
