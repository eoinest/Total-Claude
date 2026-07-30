import * as THREE from 'three';
import { clamp, lerp } from '../util/math';
import { Rng, hash2 } from '../util/rand';
import {
  archPanel,
  box,
  column,
  cylinder,
  gableRoof,
  hipRoof,
  quadPrism,
  type Batch,
  type GeoStream,
} from './build';
import { DISTRICTS, KeepOut, STREETS, type DistrictSpec } from './layout';
import { PAL } from './palette';
import { cylinderBetween, type CityChunkSpec, type TreeRequest } from './wall';

/**
 * The city fabric: *insulae*, streets and courtyards.
 *
 * This is the mass of Rome and it must not look like copy-paste boxes, so nothing is
 * placed on a grid. Each district is cut into blocks by recursive binary subdivision
 * with jittered cuts, each block is cut again into building footprints, and every
 * building then draws its storey count, paint, roof form, window rhythm, balconies
 * and courtyard from its own deterministic stream. The result is irregular the way a
 * real city is irregular: no two blocks the same shape, no two façades the same.
 *
 * Real dimensions: Roman insulae ran three to five storeys, and Augustus capped them
 * at 70 Roman feet (20.7 m) after collapses — Trajan later lowered it to 60 (17.8 m).
 * Ground floors held *tabernae* with wide arched openings, and the storeys above were
 * about 3.1 m each with shuttered windows and projecting timber balconies.
 */

const STOREY_H = 3.15;
const GROUND_H = 4.3;

export interface DistrictOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /** Building footprints, in world space, for the movement-blocking grid. */
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
}

type Ground = (x: number, z: number) => number;

interface Rect {
  u: number;
  v: number;
  hu: number;
  hv: number;
}

interface Plot {
  /** World centre. */
  x: number;
  z: number;
  rot: number;
  /** Half-extents of the footprint in the district's local frame. */
  hw: number;
  hd: number;
  /** Which side faces the widest street; tabernae and balconies go there. */
  frontSide: 1 | -1;
}

/** Recursive binary subdivision with jittered cuts and a gap for the street. */
function subdivide(r: Rect, rng: Rng, maxSize: number, gap: number, out: Rect[], depth = 0): void {
  const long = Math.max(r.hu, r.hv) * 2;
  if (long <= maxSize || depth > 7) {
    out.push(r);
    return;
  }
  const splitU = r.hu >= r.hv;
  // Off-centre cuts are what stop the result reading as a grid.
  const t = rng.range(0.36, 0.64);
  if (splitU) {
    const total = r.hu * 2 - gap;
    const a = total * t;
    const b = total - a;
    subdivide({ u: r.u - r.hu + a / 2, v: r.v, hu: a / 2, hv: r.hv }, rng, maxSize, gap, out, depth + 1);
    subdivide({ u: r.u + r.hu - b / 2, v: r.v, hu: b / 2, hv: r.hv }, rng, maxSize, gap, out, depth + 1);
  } else {
    const total = r.hv * 2 - gap;
    const a = total * t;
    const b = total - a;
    subdivide({ u: r.u, v: r.v - r.hv + a / 2, hu: r.hu, hv: a / 2 }, rng, maxSize, gap, out, depth + 1);
    subdivide({ u: r.u, v: r.v + r.hv - b / 2, hu: r.hu, hv: b / 2 }, rng, maxSize, gap, out, depth + 1);
  }
}

export function buildDistricts(
  heightAt: Ground,
  keepOut: KeepOut,
  seed: string,
  wallZAt: (x: number) => number
): DistrictOutput {
  const rng = new Rng(seed);
  const trees: TreeRequest[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];

  // Plan every district up front so the movement grid and the tree list are complete
  // before any geometry is built (chunk builders run lazily, per LOD level).
  const planned = new Map<string, Plot[]>();
  for (const d of DISTRICTS) {
    const drng = rng.fork(d.id);
    const plots: Plot[] = [];
    const cs = Math.cos(d.rot);
    const sn = Math.sin(d.rot);
    const blocks: Rect[] = [];
    // Blocks of 40–75 m separated by streets 7 m wide, then each block cut into
    // building plots separated by 2 m alleys.
    subdivide({ u: 0, v: 0, hu: d.hw, hv: d.hd }, drng, lerp(78, 46, d.density), 7.5, blocks);

    for (const blk of blocks) {
      const plotsIn: Rect[] = [];
      subdivide(blk, drng, lerp(32, 18, d.density), 1.0, plotsIn);
      for (const p of plotsIn) {
        const wx = d.x + p.u * cs - p.v * sn;
        const wz = d.z + p.u * sn + p.v * cs;
        const r = Math.max(p.hu, p.hv);
        // Never grow through a monument, a main street, or north of the wall line.
        if (keepOut.blocked(wx, wz, r * 0.82)) continue;
        if (wz < wallZAt(wx) + 12) continue;
        if (Math.min(p.hu, p.hv) < 3.2) continue;
        if (drng.next() > 0.62 + d.density * 0.38) continue;
        const plot: Plot = {
          x: wx,
          z: wz,
          rot: d.rot + drng.jitter(0.06),
          hw: Math.max(2.6, p.hu - drng.range(0.05, 0.32)),
          hd: Math.max(2.6, p.hv - drng.range(0.05, 0.32)),
          frontSide: drng.bool() ? 1 : -1,
        };
        plots.push(plot);
        footprints.push({ x: wx, z: wz, hw: plot.hw, hd: plot.hd, rot: plot.rot });
      }
    }
    planned.set(d.id, plots);

    // Courtyard trees and street planting: cypress in gardens, umbrella pine in
    // squares. Density falls with how packed the district is.
    const nTrees = Math.round(d.hw * d.hd * 0.0008 * (1.4 - d.density));
    for (let i = 0; i < nTrees; i++) {
      const u = drng.range(-d.hw, d.hw);
      const v = drng.range(-d.hd, d.hd);
      const wx = d.x + u * cs - v * sn;
      const wz = d.z + u * sn + v * cs;
      if (wz < wallZAt(wx) + 14) continue;
      trees.push({ x: wx, z: wz, kind: drng.pick(['cypress', 'pine', 'umbrella'] as const), scale: drng.range(0.75, 1.25) });
    }
  }

  // Group districts into depth bands: one chunk per band keeps the draw count down,
  // and the whole city is normally in frame at once anyway so per-district culling
  // buys little.
  const groups: { name: string; ids: string[]; lod: [number, number] }[] = [
    { name: 'city-gate', ids: ['porta-flaminia'], lod: [260, 1200] },
    { name: 'city-campus-n', ids: ['campus-north', 'via-lata', 'quirinal', 'vaticanus'], lod: [420, 1400] },
    { name: 'city-campus-s', ids: ['campus-mid', 'campus-south', 'trastevere'], lod: [520, 1e9] },
    { name: 'city-east', ids: ['viminal', 'esquiline', 'east-suburb'], lod: [560, 1e9] },
    { name: 'city-central', ids: ['subura', 'forum-east'], lod: [560, 1e9] },
    { name: 'city-south', ids: ['caelian', 'aventine'], lod: [600, 1e9] },
  ];

  const chunks: CityChunkSpec[] = [];
  for (const grp of groups) {
    const specs = DISTRICTS.filter((d) => grp.ids.includes(d.id));
    if (!specs.length) continue;
    let cx = 0;
    let cz = 0;
    for (const d of specs) {
      cx += d.x;
      cz += d.z;
    }
    cx /= specs.length;
    cz /= specs.length;
    let radius = 60;
    for (const d of specs) radius = Math.max(radius, Math.hypot(d.x - cx, d.z - cz) + Math.hypot(d.hw, d.hd));
    chunks.push({
      name: grp.name,
      cx,
      cz,
      radius,
      castShadow: grp.name === 'city-gate',
      lodSwitch: grp.lod,
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        for (const d of specs) {
          if (detail >= 1) buildDistrictGround(batch, detail, d, heightAt, wallZAt);
          const plots = planned.get(d.id) ?? [];
          for (let i = 0; i < plots.length; i++) {
            buildBuilding(batch, detail, plots[i], d, heightAt, new Rng(Rng.hashString(`${d.id}:${i}`)));
          }
        }
      },
    });
  }

  // Streets are one long thin thing each: their own chunk, one material, one draw.
  chunks.push({
    name: 'streets',
    cx: 0,
    cz: 760,
    radius: 1500,
    castShadow: false,
    lodSwitch: [1e9, 1e9],
    build: (batch, detail) => {
      batch.setUvOrigin(0, 0, 760);
      buildStreets(batch, detail, heightAt);
    },
  });

  return { chunks, trees, footprints };
}

/**
 * Beaten earth and paving between the buildings. Sampled against the terrain on a
 * coarse grid so the district floor never floats or sinks, and tinted per cell so it
 * does not read as one flat plane.
 */
function buildDistrictGround(batch: Batch, detail: number, d: DistrictSpec, heightAt: Ground, wallZAt: (x: number) => number): void {
  const st = batch.s('stone');
  // 22 cells across a 540 m district is ~25 m a cell — about a city block, which is the scale
  // at which the surface actually changes from paving to yard to beaten earth.
  const n = detail >= 1 ? 22 : 8;
  const cs = Math.cos(d.rot);
  const sn = Math.sin(d.rot);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();

  const at = (u: number, v: number, out: THREE.Vector3): boolean => {
    const wx = d.x + u * cs - v * sn;
    const wz = d.z + u * sn + v * cs;
    out.set(wx, heightAt(wx, wz) + 0.06, wz);
    return wz > wallZAt(wx) + 6;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = lerp(-d.hw, d.hw, i / n);
      const u1 = lerp(-d.hw, d.hw, (i + 1) / n);
      const v0 = lerp(-d.hd, d.hd, j / n);
      const v1 = lerp(-d.hd, d.hd, (j + 1) / n);
      const ok = at(u0, v0, p0) && at(u1, v0, p1) && at(u1, v1, p2) && at(u0, v1, p3);
      if (!ok) continue;
      const seed = Rng.hashString(d.id) & 0xffff;
      const h = hash2(i, j, seed);
      const t = hash2(i, j, seed ^ 0x5bd1);
      // Three surfaces, because a Roman district floor is not one material: basalt paving in
      // the streets, beaten earth in the yards, and dust everywhere in between.
      //
      // The *tone* hash has to be independent of the *type* hash. Both used to be `h`, so
      // dark basalt cells always got the bright end of the 0.66–1.0 multiplier and pale dust
      // cells always got the dark end — the two converged on the same value and several
      // hundred metres of district floor resolved to one flat plate, which from a strategic
      // camera was the largest featureless area in the frame.
      const base = h < 0.34 ? PAL.basalt : h < 0.72 ? PAL.dust : PAL.terraDirty;
      c.copy(base).multiplyScalar(0.68 + t * 0.44);
      st.quadN(nrm, p0, p1, p2, p3, c);
    }
  }
}

/**
 * Pick a paint colour. Roman street façades were mostly red and ochre.
 *
 * Lime white is down from a fifth of frontages to an eighth. It is the least saturated entry
 * by a wide margin, and at 20 % it was the reason a district read grey from a strategic
 * camera even though two thirds of its buildings were painted: the white ones cluster and the
 * eye averages them. The rubric is explicit that the everyday palette is reds and ochres with
 * cheap lime white as the *minority* note, and Ostia bears that out.
 */
function paintColour(rng: Rng): THREE.Color {
  const base = rng.pickWeighted(
    [PAL.pompeianRed, PAL.ochre, PAL.limeWhite, PAL.ochreDeep, PAL.terraDirty, PAL.romanRed],
    [0.27, 0.26, 0.125, 0.15, 0.115, 0.08]
  );
  return new THREE.Color().copy(base).multiplyScalar(rng.range(0.78, 1.18));
}

function roofColour(rng: Rng): THREE.Color {
  const base = rng.pickWeighted([PAL.roofTile, PAL.roofTileOld, PAL.roofTileDark], [0.5, 0.34, 0.16]);
  return new THREE.Color().copy(base).multiplyScalar(rng.range(0.82, 1.16));
}

// ---------------------------------------------------------------------------
// One building
// ---------------------------------------------------------------------------

function buildBuilding(batch: Batch, detail: number, plot: Plot, d: DistrictSpec, heightAt: Ground, rng: Rng): void {
  const g = heightAt(plot.x, plot.z);
  const m = new THREE.Matrix4().makeRotationY(plot.rot).setPosition(plot.x, 0, plot.z);
  const stucco = batch.s('stucco');
  const roof = batch.s('roof');
  const used: GeoStream[] = [stucco, roof];
  const timber = detail >= 2 ? batch.s('timber') : null;
  const stone = detail >= 1 ? batch.s('stone') : null;
  if (timber) used.push(timber);
  if (stone) used.push(stone);
  for (const st of used) st.push(m);

  const w = plot.hw * 2;
  const dep = plot.hd * 2;
  const area = w * dep;
  const grand = rng.next() < d.grandeur && area > 240;
  const floors = grand
    ? Math.max(1, d.minFloors - 1)
    : clamp(rng.int(d.minFloors - 1, d.maxFloors) + (rng.next() < 0.14 ? 1 : 0), 1, 6);

  if (detail === 0) {
    // Far silhouette: one prism and one roof plane. Everything the eye keeps at a
    // kilometre is the massing and the terracotta.
    const h = GROUND_H + STOREY_H * (floors - 1);
    box(stucco, -w / 2, g, -dep / 2, w / 2, g + h, dep / 2, paintColour(rng), { bottom: false });
    hipRoof(roof, w, dep, g + h, Math.min(w, dep) * 0.16, 0.4, roofColour(rng));
    for (const st of used) st.pop();
    return;
  }

  if (grand) {
    buildDomus(batch, detail, w, dep, g, rng, stucco, roof, stone, timber);
    for (const st of used) st.pop();
    return;
  }

  // Larger plots become a ring of wings round a light well — the *cavaedium* plan,
  // and from above the courtyards are what make the roofscape read as a city.
  const courtyard = area > 300 && Math.min(w, dep) > 15 && rng.bool(0.55);
  const paint = paintColour(rng);
  const tile = roofColour(rng);

  if (courtyard) {
    const wingW = rng.range(5.5, 8.0);
    const wings: [number, number, number, number][] = [
      [-w / 2, -dep / 2, w / 2, -dep / 2 + wingW],
      [-w / 2, dep / 2 - wingW, w / 2, dep / 2],
      [-w / 2, -dep / 2 + wingW, -w / 2 + wingW, dep / 2 - wingW],
      [w / 2 - wingW, -dep / 2 + wingW, w / 2, dep / 2 - wingW],
    ];
    for (let k = 0; k < wings.length; k++) {
      const [x0, z0, x1, z1] = wings[k];
      if (x1 - x0 < 2.4 || z1 - z0 < 2.4) continue;
      const fl = clamp(floors + (hash2(k, Math.round(w), 55) < 0.3 ? -1 : 0), 1, 5);
      buildWing(batch, detail, x0, z0, x1, z1, g, fl, paint, tile, rng, stucco, roof, timber, stone, k === 0 ? -1 : k === 1 ? 1 : 0, k < 2 ? 'gable' : 'hip');
    }
    // The court itself: paved, with a cistern mouth and a vine.
    const cst = batch.s('stone');
    cst.push(m);
    box(cst, -w / 2 + wingW, g + 0.06, -dep / 2 + wingW, w / 2 - wingW, g + 0.12, dep / 2 - wingW, PAL.basalt, { bottom: false });
    cst.pop();
    if (detail >= 2 && stone) {
      cylinder(stone, 0, g + 0.1, 0, 0.7, 0.65, 0.85, 9, PAL.travertineDirty, { top: true });
    }
  } else {
    buildWing(batch, detail, -w / 2, -dep / 2, w / 2, dep / 2, g, floors, paint, tile, rng, stucco, roof, timber, stone, plot.frontSide);
  }

  for (const st of used) st.pop();
}

/**
 * One block of building: storeys, string courses, windows, shutters, balcony,
 * ground-floor tabernae, and a roof. `front` selects which long side gets the shop
 * fronts and balcony (0 = neither, for internal courtyard wings).
 */
function buildWing(
  batch: Batch,
  detail: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  g: number,
  floors: number,
  paint: THREE.Color,
  tile: THREE.Color,
  rng: Rng,
  stucco: GeoStream,
  roof: GeoStream,
  timber: GeoStream | null,
  stone: GeoStream | null,
  front: number,
  roofOverride?: 'hip' | 'gable' | 'terrace'
): void {
  const w = x1 - x0;
  const dep = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;

  // Every random choice is drawn here, before any `detail` branch. A level-of-detail
  // swap must not change a building's roof form or storey height, and it would if the
  // number of draws taken from the stream depended on the detail level.
  const P = {
    groundH: GROUND_H * rng.range(0.92, 1.1),
    storeyH: STOREY_H * rng.range(0.94, 1.08),
    bareGround: rng.bool(0.4),
    groundTone: rng.range(0.7, 0.92),
    tabernaBay: rng.range(3.4, 4.6),
    windowPitchX: rng.range(2.6, 3.6),
    windowPitchZ: rng.range(2.6, 3.6),
    balcony: rng.bool(0.5),
    balconyFloor: rng.int(1, 3),
    balconyProj: rng.range(0.9, 1.5),
    balconyFrac: rng.range(0.5, 0.9),
    roofKind: rng.pickWeighted(['hip', 'gable', 'terrace'] as const, [0.5, 0.28, 0.22]),
    gablePitch: rng.range(0.2, 0.3),
    overhang: rng.range(0.35, 0.7),
    hipRise: rng.range(0.14, 0.21),
    chimney: rng.bool(0.35),
    chimneyU: rng.next(),
    chimneyV: rng.next(),
    chimneyH: rng.range(1.1, 2.0),
  };
  const groundH = P.groundH;
  const storeyH = P.storeyH;
  const top = g + groundH + storeyH * (floors - 1);
  const dark = new THREE.Color(0.022, 0.02, 0.017);

  // Ground storey: often left as bare brick or a darker render, as at Ostia.
  const groundPaint = new THREE.Color().copy(P.bareGround ? PAL.terraDirty : paint).multiplyScalar(P.groundTone);
  box(stucco, x0, g - 0.6, z0, x1, g + groundH, z1, groundPaint, { groundShade: 0.24 });
  // Splash-back dado. `groundShade` ramps the whole storey, which over four metres reads as
  // a soft vignette rather than as dirt; the line where cart wheels, rain off the eaves and
  // a public street actually stain a façade is a crisp band about a metre up, and every
  // surviving Ostian frontage has one. Proud of the wall by 40 mm so it reads in section
  // as well as in tone.
  const dado = new THREE.Color().copy(groundPaint).multiplyScalar(0.62).lerp(PAL.dust, 0.22);
  box(stucco, x0 - 0.04, g - 0.5, z0 - 0.04, x1 + 0.04, g + 1.05, z1 + 0.04, dado, {
    bottom: false,
    top: false,
    groundShade: 0.26,
  });
  // Upper storeys, each a fraction lighter than the one below (rain-washed).
  for (let f = 1; f < floors; f++) {
    const y0 = g + groundH + storeyH * (f - 1);
    const c = new THREE.Color().copy(paint).multiplyScalar(0.94 + f * 0.035);
    box(stucco, x0, y0, z0, x1, y0 + storeyH, z1, c, { bottom: false, top: false });
    // String course marking the floor line.
    if (detail >= 1) {
      box(stucco, x0 - 0.14, y0 - 0.16, z0 - 0.14, x1 + 0.14, y0, z1 + 0.14, new THREE.Color().copy(paint).multiplyScalar(1.2), {
        bottom: false,
      });
    }
  }

  // ---- tabernae: wide arched shop fronts at street level -------------------
  if (front !== 0 && detail >= 1 && w > 6) {
    const bays = Math.max(1, Math.floor(w / P.tabernaBay));
    const bw = w / bays;
    const zf = front < 0 ? z0 : z1;
    for (let i = 0; i < bays; i++) {
      const bxp = x0 + bw * (i + 0.5);
      stucco.push(new THREE.Matrix4().makeRotationY(front < 0 ? 0 : Math.PI).setPosition(bxp, g, zf));
      archPanel(stucco, bw + 0.02, groundH, groundPaint, {
        depth: 0.55,
        spring: groundH * 0.56,
        openWidth: bw * (0.5 + hash2(i, Math.round(w * 4), 401) * 0.18),
        segments: detail >= 2 ? 7 : 4,
        voidCol: dark,
      });
      stucco.pop();
      // Cloth awning over every other shop — the top face is what the camera sees.
      if (detail >= 2 && hash2(i, Math.round(cx * 3), 907) > 0.55) {
        const aw = bw * 0.8;
        const proj = 1.2 + hash2(i, Math.round(cz * 3), 331) * 0.8;
        const yTop = g + groundH * 0.86;
        const s = front < 0 ? -1 : 1;
        const p0 = new THREE.Vector3(bxp - aw / 2, yTop, zf + s * 0.1);
        const p1 = new THREE.Vector3(bxp + aw / 2, yTop, zf + s * 0.1);
        const p2 = new THREE.Vector3(bxp + aw / 2, yTop - 0.75, zf + s * proj);
        const p3 = new THREE.Vector3(bxp - aw / 2, yTop - 0.75, zf + s * proj);
        NRM_UP.set(0, 1, 0);
        const cloth = [PAL.limeWhite, PAL.ochrePale, PAL.pompeianRed][Math.floor(hash2(i, Math.round(cx), 71) * 3)];
        stucco.quadN(NRM_UP, p0, p1, p2, p3, new THREE.Color().copy(cloth).multiplyScalar(1.1));
        if (timber) {
          cylinderBetween(timber, bxp - aw / 2, yTop - 0.75, zf + s * proj, bxp + aw / 2, yTop - 0.75, zf + s * proj, 0.05, PAL.timber, 4);
        }
      }
    }
  } else if (detail >= 1 && w > 4) {
    // Otherwise a plain doorway.
    const zf = z0;
    box(stucco, cx - 0.75, g, zf - 0.06, cx + 0.75, g + 2.3, zf + 0.2, dark);
  }

  // ---- windows -------------------------------------------------------------
  if (detail >= 1) {
    const perFloorX = Math.max(1, Math.floor(w / P.windowPitchX));
    const perFloorZ = Math.max(1, Math.floor(dep / P.windowPitchZ));
    for (let f = 1; f < floors; f++) {
      const y = g + groundH + storeyH * (f - 1) + storeyH * 0.34;
      const wh = storeyH * 0.36;
      const ww = 0.62;
      for (let i = 0; i < perFloorX; i++) {
        const px = lerp(x0 + 1.3, x1 - 1.3, perFloorX === 1 ? 0.5 : i / (perFloorX - 1));
        for (const zz of [z0, z1]) {
          if (hash2(i * 11 + f * 7, Math.round(px * 3), 61) < 0.3) continue;
          const s = zz === z0 ? -1 : 1;
          box(stucco, px - ww / 2, y, zz + s * 0.02, px + ww / 2, y + wh, zz - s * 0.14, dark);
          // Lintel and sill in travertine.
          if (detail >= 2 && stone) {
            box(stone, px - ww / 2 - 0.12, y + wh, zz + s * 0.06, px + ww / 2 + 0.12, y + wh + 0.13, zz - s * 0.06, PAL.travertine);
            box(stone, px - ww / 2 - 0.12, y - 0.1, zz + s * 0.1, px + ww / 2 + 0.12, y, zz - s * 0.02, PAL.travertine);
          }
          // Shutters: a leaf folded back against the wall on one side.
          if (timber && hash2(i * 3 + f, Math.round(px), 19) > 0.55) {
            box(timber, px + ww / 2, y, zz + s * 0.06, px + ww / 2 + 0.42, y + wh, zz + s * 0.14, PAL.timberDark);
          }
        }
      }
      for (let i = 0; i < perFloorZ; i++) {
        const pz = lerp(z0 + 1.3, z1 - 1.3, perFloorZ === 1 ? 0.5 : i / (perFloorZ - 1));
        for (const xx of [x0, x1]) {
          if (hash2(i * 13 + f * 5, Math.round(pz * 3), 71) < 0.42) continue;
          const s = xx === x0 ? -1 : 1;
          box(stucco, xx + s * 0.02, y, pz - ww / 2, xx - s * 0.14, y + wh, pz + ww / 2, dark);
        }
      }
    }
  }

  // ---- balcony (*maenianum*) ----------------------------------------------
  if (front !== 0 && floors >= 3 && detail >= 1 && P.balcony) {
    const f = Math.min(P.balconyFloor, Math.max(1, floors - 2));
    const y = g + groundH + storeyH * (f - 1) + storeyH * 0.02;
    const s = front < 0 ? -1 : 1;
    const zf = front < 0 ? z0 : z1;
    const proj = P.balconyProj;
    const bw = w * P.balconyFrac;
    box(stucco, cx - bw / 2, y, Math.min(zf, zf + s * proj), cx + bw / 2, y + 0.22, Math.max(zf, zf + s * proj), new THREE.Color().copy(paint).multiplyScalar(1.14));
    if (timber) {
      const rails = Math.max(3, Math.round(bw / 0.5));
      for (let i = 0; i <= rails; i++) {
        const px = lerp(cx - bw / 2, cx + bw / 2, i / rails);
        cylinder(timber, px, y + 0.22, zf + s * proj, 0.045, 0.04, 0.95, 4, PAL.timber);
      }
      cylinderBetween(timber, cx - bw / 2, y + 1.15, zf + s * proj, cx + bw / 2, y + 1.15, zf + s * proj, 0.055, PAL.timberDark, 4);
      // Corbels under the slab.
      for (let i = 0; i < 3; i++) {
        const px = lerp(cx - bw / 2 + 0.4, cx + bw / 2 - 0.4, i / 2);
        cylinderBetween(timber, px, y, zf, px, y - 0.5, zf + s * proj, 0.07, PAL.timberDark, 4);
      }
    }
  }

  // Baked eaves shadow: the façades the camera sees are backlit, so without a dark
  // band under the overhang a wall and its roof merge into one silhouette.
  if (detail >= 1) {
    box(stucco, x0 - 0.03, top - 0.42, z0 - 0.03, x1 + 0.03, top, z1 + 0.03, new THREE.Color().copy(paint).multiplyScalar(0.42), {
      bottom: false,
      top: false,
    });
  }

  // ---- roof ---------------------------------------------------------------
  const roofKind = roofOverride ?? P.roofKind;
  roof.pushTranslate(cx, 0, cz);
  stucco.pushTranslate(cx, 0, cz);
  if (roofKind === 'terrace') {
    // Flat roof terrace with a parapet, planters and a vine pergola — very Roman,
    // and the variety it gives the roofscape from above is worth the triangles.
    const par = 0.85;
    box(stucco, -w / 2, top, -dep / 2, w / 2, top + 0.12, dep / 2, PAL.dust, { bottom: false });
    for (const [ax, az, bx, bz] of [
      [-w / 2, -dep / 2, w / 2, -dep / 2 + 0.28],
      [-w / 2, dep / 2 - 0.28, w / 2, dep / 2],
      [-w / 2, -dep / 2, -w / 2 + 0.28, dep / 2],
      [w / 2 - 0.28, -dep / 2, w / 2, dep / 2],
    ] as const) {
      box(stucco, ax, top, az, bx, top + par, bz, new THREE.Color().copy(paint).multiplyScalar(1.08), { bottom: false });
    }
    if (timber && Math.min(w, dep) > 9 && P.chimney) {
      const pw = Math.min(w - 4, 3.6);
      const pd = Math.min(dep - 4, 2.8);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cylinder(timber, (sx * pw) / 2, top + 0.12, (sz * pd) / 2, 0.07, 0.06, 2.3, 4, PAL.timber);
        }
      }
      for (let i = 0; i < 5; i++) {
        const px = lerp(-pw / 2, pw / 2, i / 4);
        cylinderBetween(timber, px, top + 2.4, -pd / 2, px, top + 2.4, pd / 2, 0.045, PAL.timberDark, 4);
      }
      // Vine over the pergola. Kept in the timber stream rather than the foliage one
      // so a district never pays a draw call for a handful of leaves.
      box(timber, -pw / 2, top + 2.4, -pd / 2, pw / 2, top + 2.7, pd / 2, PAL.vine, { bottom: false });
    }
  } else if (roofKind === 'gable') {
    const pitch = P.gablePitch;
    const alongX = w >= dep;
    const rh = (alongX ? dep : w) * 0.5 * pitch * 2;
    gableRoof(stucco, roof, w, dep, top, rh, P.overhang, tile, alongX);
    if (detail >= 2) {
      // Ridge tiles.
      const rl = alongX ? w : dep;
      const rc = new THREE.Color().copy(tile).multiplyScalar(1.16);
      if (alongX) box(roof, -rl / 2, top + rh - 0.06, -0.14, rl / 2, top + rh + 0.12, 0.14, rc, { bottom: false });
      else box(roof, -0.14, top + rh - 0.06, -rl / 2, 0.14, top + rh + 0.12, rl / 2, rc, { bottom: false });
    }
  } else {
    const rh = Math.min(w, dep) * P.hipRise;
    hipRoof(roof, w, dep, top, rh, P.overhang, tile);
    if (detail >= 2) {
      const rc = new THREE.Color().copy(tile).multiplyScalar(1.16);
      const alongX = w >= dep;
      const half = Math.max(0.2, alongX ? w / 2 - dep / 2 : dep / 2 - w / 2);
      if (alongX) box(roof, -half, top + rh - 0.06, -0.14, half, top + rh + 0.12, 0.14, rc, { bottom: false });
      else box(roof, -0.14, top + rh - 0.06, -half, 0.14, top + rh + 0.12, half, rc, { bottom: false });
    }
  }
  // A vent or chimney stack — bakeries and heated rooms had them, and they break up
  // an otherwise unbroken field of tile.
  if (detail >= 2 && P.chimney) {
    const px = lerp(-w / 2 + 1.2, w / 2 - 1.2, P.chimneyU);
    const pz = lerp(-dep / 2 + 1.2, dep / 2 - 1.2, P.chimneyV);
    box(stucco, px - 0.32, top, pz - 0.32, px + 0.32, top + P.chimneyH, pz + 0.32, PAL.terraDirty, { bottom: false });
  }
  roof.pop();
  stucco.pop();
}

const NRM_UP = new THREE.Vector3(0, 1, 0);

/** A *domus*: low, wide, ranged round a colonnaded peristyle with a pool. */
function buildDomus(
  batch: Batch,
  detail: number,
  w: number,
  dep: number,
  g: number,
  rng: Rng,
  stucco: GeoStream,
  roof: GeoStream,
  stone: GeoStream | null,
  timber: GeoStream | null
): void {
  const paint = paintColour(rng);
  const tile = roofColour(rng);
  const h = GROUND_H + (rng.bool(0.4) ? STOREY_H : 0);
  const wingW = Math.min(7.5, Math.min(w, dep) * 0.3);

  const wings: [number, number, number, number][] = [
    [-w / 2, -dep / 2, w / 2, -dep / 2 + wingW],
    [-w / 2, dep / 2 - wingW, w / 2, dep / 2],
    [-w / 2, -dep / 2 + wingW, -w / 2 + wingW, dep / 2 - wingW],
    [w / 2 - wingW, -dep / 2 + wingW, w / 2, dep / 2 - wingW],
  ];
  for (const [x0, z0, x1, z1] of wings) {
    if (x1 - x0 < 2 || z1 - z0 < 2) continue;
    box(stucco, x0, g - 0.5, z0, x1, g + h, z1, paint, { groundShade: 0.2 });
    roof.pushTranslate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    hipRoof(roof, x1 - x0 + 1.2, z1 - z0 + 1.2, g + h, Math.min(x1 - x0, z1 - z0) * 0.2, 0.7, tile);
    roof.pop();
  }
  // Peristyle: paved court, colonnade and an *impluvium* pool.
  const cw = w - wingW * 2;
  const cd = dep - wingW * 2;
  box(batch.s('stone'), -cw / 2, g + 0.06, -cd / 2, cw / 2, g + 0.14, cd / 2, PAL.marbleShadow, { bottom: false });
  if (stone && cw > 5 && cd > 5) {
    const nx = Math.max(2, Math.round(cw / 3.0));
    const nz = Math.max(2, Math.round(cd / 3.0));
    for (let i = 0; i <= nx; i++) {
      const px = lerp(-cw / 2 + 0.5, cw / 2 - 0.5, i / nx);
      column(stone, px, g + 0.14, -cd / 2 + 0.5, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
      column(stone, px, g + 0.14, cd / 2 - 0.5, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
    }
    for (let i = 1; i < nz; i++) {
      const pz = lerp(-cd / 2 + 0.5, cd / 2 - 0.5, i / nz);
      column(stone, -cw / 2 + 0.5, g + 0.14, pz, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
      column(stone, cw / 2 - 0.5, g + 0.14, pz, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
    }
    box(stone, -cw / 2 + 0.2, g + 3.6, -cd / 2 + 0.2, cw / 2 - 0.2, g + 4.1, cd / 2 - 0.2, PAL.marble, { bottom: false });
    // Pool.
    box(stone, -cw * 0.22, g + 0.1, -cd * 0.22, cw * 0.22, g + 0.32, cd * 0.22, PAL.marbleShadow, { bottom: false });
    box(stone, -cw * 0.19, g + 0.1, -cd * 0.19, cw * 0.19, g + 0.24, cd * 0.19, new THREE.Color(0.1, 0.2, 0.24), { bottom: false });
  }
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

/**
 * Paved streets as terrain-following ribbons with raised kerbs and footways. Roman
 * major streets were 6–9 m between kerbs, surfaced in polygonal basalt setts and
 * heavily cambered, with high footways because the carriageway carried the water.
 */
function buildStreets(batch: Batch, detail: number, heightAt: Ground): void {
  const st = batch.s('road');
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();

  for (const street of STREETS) {
    for (let s = 0; s + 1 < street.path.length; s++) {
      const a = street.path[s];
      const b = street.path[s + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(2, Math.round(len / (detail >= 1 ? 9 : 26)));
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      const nx = -dz;
      const nz = dx;
      const hw = street.width * 0.5;
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const ax = lerp(a.x, b.x, t0);
        const az = lerp(a.z, b.z, t0);
        const bx = lerp(a.x, b.x, t1);
        const bz = lerp(a.z, b.z, t1);
        // Carriageway.
        p0.set(ax - nx * hw, heightAt(ax - nx * hw, az - nz * hw) + 0.08, az - nz * hw);
        p1.set(bx - nx * hw, heightAt(bx - nx * hw, bz - nz * hw) + 0.08, bz - nz * hw);
        p2.set(bx + nx * hw, heightAt(bx + nx * hw, bz + nz * hw) + 0.08, bz + nz * hw);
        p3.set(ax + nx * hw, heightAt(ax + nx * hw, az + nz * hw) + 0.08, az + nz * hw);
        c.copy(street.paved ? PAL.basalt : PAL.dust).multiplyScalar(0.9 + hash2(i, s, 33) * 0.24);
        st.quadN(nrm, p0, p1, p2, p3, c);
        if (detail >= 1) {
          // Raised footways either side.
          for (const side of [-1, 1]) {
            const o0 = hw + 0.05;
            const o1 = hw + 2.1;
            p0.set(ax + nx * side * o0, heightAt(ax, az) + 0.34, az + nz * side * o0);
            p1.set(bx + nx * side * o0, heightAt(bx, bz) + 0.34, bz + nz * side * o0);
            p2.set(bx + nx * side * o1, heightAt(bx + nx * side * o1, bz + nz * side * o1) + 0.34, bz + nz * side * o1);
            p3.set(ax + nx * side * o1, heightAt(ax + nx * side * o1, az + nz * side * o1) + 0.34, az + nz * side * o1);
            st.quadN(nrm, p0, p1, p2, p3, PAL.travertineDirty);
            // Kerb face.
            quadPrism(
              st,
              ax + nx * side * o0,
              az + nz * side * o0,
              bx + nx * side * o0,
              bz + nz * side * o0,
              nx * side,
              nz * side,
              0.12,
              heightAt(ax, az) - 0.1,
              heightAt(ax, az) + 0.34,
              PAL.peperino,
              PAL.travertineDirty,
              { ends: false, top: false }
            );
          }
        }
      }
    }
  }
}
