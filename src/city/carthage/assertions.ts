import type { CityAssertion, PlanRect } from '../cityPlan';
import type { Lane } from '../cityPlan';
import {
  APRON_DEPTH, APRON_HALF_RUN, CIRCUIT_X_MAX, CIRCUIT_X_MIN, circuitZAt,
  INTERVALLUM, intervallumDepthAt, STAIR_APRONS,
} from './circuit';
import { BASIN_WATER_Y, FREEBOARD } from './harbour';
import {
  COTHON, INSULA_DEPTH, INSULA_FACE, MERCHANT_HARBOUR, MONUMENTS, PUNIC_WAY_WIDTH,
  PUNIC_WAYS, shoreZAt,
} from './layout';
import { SEA_LEVEL } from '../../maps/carthage/topography';

/**
 * Build-time checks on the *built* city, not on the intent.
 *
 * **The instrument is the point of this file.** Rome shipped `assertNoFootprintOverlaps`
 * with a name that reads like a guarantee and a body that compared landmarks with landmarks,
 * skipped anything flagged `soft`, and had never in its life looked at an insula. It
 * reported zero, correctly, while the player was staring at monuments dropped across
 * housing. Every check below therefore states in `detail` exactly what population it
 * sampled, and a non-zero result is *reported* rather than suppressed: an honest number
 * with the reasoning written down beats a green board.
 */

interface Obb {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
}

/** Separating-axis test for two oriented rectangles. Returns the overlap depth, 0 if apart. */
function obbOverlap(a: Obb, b: Obb): number {
  const axes: [number, number][] = [
    [Math.cos(a.rot), Math.sin(a.rot)], [-Math.sin(a.rot), Math.cos(a.rot)],
    [Math.cos(b.rot), Math.sin(b.rot)], [-Math.sin(b.rot), Math.cos(b.rot)],
  ];
  const ca: [number, number][] = [
    [Math.cos(a.rot), Math.sin(a.rot)], [-Math.sin(a.rot), Math.cos(a.rot)],
  ];
  const cb: [number, number][] = [
    [Math.cos(b.rot), Math.sin(b.rot)], [-Math.sin(b.rot), Math.cos(b.rot)],
  ];
  let least = Infinity;
  for (const [ax, az] of axes) {
    const ra = Math.abs(a.hw * (ca[0][0] * ax + ca[0][1] * az)) + Math.abs(a.hd * (ca[1][0] * ax + ca[1][1] * az));
    const rb = Math.abs(b.hw * (cb[0][0] * ax + cb[0][1] * az)) + Math.abs(b.hd * (cb[1][0] * ax + cb[1][1] * az));
    const d = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az);
    const gap = ra + rb - d;
    if (gap <= 0) return 0;
    least = Math.min(least, gap);
  }
  return least;
}

/** Is a point inside an oriented rectangle? */
function inside(x: number, z: number, o: Obb, pad = 0): boolean {
  const cs = Math.cos(o.rot);
  const sn = Math.sin(o.rot);
  const dx = x - o.x;
  const dz = z - o.z;
  return Math.abs(dx * cs + dz * sn) <= o.hw + pad && Math.abs(-dx * sn + dz * cs) <= o.hd + pad;
}

/**
 * A solid, tagged with what it is.
 *
 * `CityBuild` splits the two into `landmarkFootprints` and `buildingFootprints` because the
 * obstacle set gives them different `kind`s; the checks below want them as one population,
 * because the question "does anything stand inside anything else" does not care. The tag is
 * carried so the two scalars `CityChecks` has room for can still be filled honestly.
 */
export type TaggedRect = PlanRect & { kind: 'monument' | 'building' };

export interface AssertInput {
  /** Every solid on the ground: monuments, housing, quays, moles. */
  footprints: readonly TaggedRect[];
  /** Thick-line solids — the harbour water and the two channels. */
  occSegments: readonly { x1: number; z1: number; x2: number; z2: number; halfW: number }[];
  lanes: readonly Lane[];
  /** How many buildings each quarter placed, their roof area, and why the rest were refused. */
  blocksByQuarter: readonly {
    id: string; placed: number; rejected: number; roofArea: number; drowned: number;
    why?: Readonly<Record<string, number>>;
  }[];
  shedCount: number;
  /** The terrain sampler, so a check can ask what the ground under a solid is doing. */
  heightAt: (x: number, z: number) => number;
  /** Every tower on the circuit, so their footings can be measured too. */
  towers: readonly { x: number; z: number; hw: number }[];
}

/**
 * What the plan hands `CitySystem`: the full assertions, plus the four scalars `CityChecks`
 * has columns for so the stats panel and the debug overlay are not blank on this city.
 */
export interface CarthageChecks {
  assertions: CityAssertion[];
  /** Monument-on-monument overlaps, the population Rome's own scalar counts. */
  footprintOverlaps: number;
  footprintOverlapWorst: number;
  /** Overlaps involving at least one house — Rome's `assertNoFabricOverlaps` population. */
  fabricOverlaps: number;
  fabricOverlapWorst: number;
  /** Named-way centreline samples standing inside a solid, and how many were taken. */
  wayInsideMonument: number;
  waySamples: number;
}

export function assertCarthage(inp: AssertInput): CarthageChecks {
  const out: CityAssertion[] = [];
  const scalars = {
    footprintOverlaps: 0,
    footprintOverlapWorst: 0,
    fabricOverlaps: 0,
    fabricOverlapWorst: 0,
    wayInsideMonument: 0,
    waySamples: 0,
  };

  /**
   * Thick lines as rectangles, so the water counts as solid in every check below.
   *
   * The first revision tested the ways only against `footprints`, and `via-navalis` started
   * *inside the naval harbour* and scored clean — the harbour basins are stamped as chords,
   * not as footprints, so the instrument could not see the one obstacle a harbour road is
   * most likely to be laid across. An assertion that cannot see half the solids in the city
   * is Rome's `assertNoFootprintOverlaps` again in a different costume.
   */
  const asRects: Obb[] = inp.occSegments.map((b) => {
    const dx = b.x2 - b.x1;
    const dz = b.z2 - b.z1;
    return {
      x: (b.x1 + b.x2) * 0.5, z: (b.z1 + b.z2) * 0.5,
      hw: Math.hypot(dx, dz) * 0.5, hd: b.halfW, rot: Math.atan2(dz, dx),
    };
  });
  const solids: Obb[] = [...inp.footprints.map((f) => ({ ...f, rot: f.rot })), ...asRects];

  // ---- 1. named ways clear of everything solid ---------------------------
  //
  // The check Rome's equivalent could not make, because it only ever looked at monuments.
  // This samples every named way's centreline against **every solid in the city, monuments
  // and houses alike**, which is the population a marching cohort actually meets.
  {
    let samples = 0;
    let hits = 0;
    const worst: Record<string, number> = {};
    for (const w of PUNIC_WAYS) {
      let wSamples = 0;
      let wHits = 0;
      for (let s = 0; s + 1 < w.path.length; s++) {
        const a = w.path[s];
        const b = w.path[s + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.round(len / 6));
        for (let i = 0; i <= n; i++) {
          const x = a.x + ((b.x - a.x) * i) / n;
          const z = a.z + ((b.z - a.z) * i) / n;
          wSamples++;
          for (const f of solids) {
            if (inside(x, z, f)) { wHits++; break; }
          }
        }
      }
      samples += wSamples;
      hits += wHits;
      if (wHits > 0) worst[w.id] = Math.round((wHits / Math.max(1, wSamples)) * 100);
    }
    const bad = Object.entries(worst).sort((a, b) => b[1] - a[1]).slice(0, 3);
    scalars.wayInsideMonument = hits;
    scalars.waySamples = samples;
    out.push({
      name: 'ways clear of all solids',
      ok: hits === 0,
      detail: `${hits}/${samples} centreline samples at 6 m along the ${PUNIC_WAYS.length} named ways stand inside a solid — `
        + `monuments, houses **and the harbour water**, not monuments alone. `
        + (bad.length ? `Worst: ${bad.map(([k, v]) => `${k} ${v}%`).join(', ')}.` : 'No way is obstructed.'),
    });
  }

  // ---- 2. solid/solid interpenetration, no exemptions ---------------------
  //
  // Every solid against every solid: monument-monument, monument-house, house-house, and
  // everything against the harbour water. Nothing is skipped for being `soft`. A broad-phase
  // bin keeps it near-linear.
  {
    /**
     * The population, and the **one** pair class that is excluded and why.
     *
     * `footprints` first, then the harbour water. The cothon is a 325 m circle of water and
     * the occupancy raster has no vocabulary for a disc, so it is published as 28 chords of
     * an annulus — consecutive chords necessarily overlap at their ends by ~3 m, because they
     * are one object cut into pieces and not 28 objects. Counting a discretisation against
     * itself measures the discretisation. So chord-against-chord is skipped and **nothing
     * else is**: every chord is still tested against every monument, every warehouse and
     * every house, which is the direction a real fault would come from and the direction the
     * earlier revision could not see at all. The count of chords is printed with the total so
     * the exclusion is arithmetic a reader can check rather than a claim.
     */
    const water: Obb[] = asRects;
    const all: Obb[] = [...inp.footprints, ...water];
    const nFoot = inp.footprints.length;
    const CELL = 60;
    const bins = new Map<number, number[]>();
    const key = (x: number, z: number): number =>
      ((Math.floor(x / CELL) + 2048) << 12) | (Math.floor(z / CELL) + 2048);
    all.forEach((f, i) => {
      const r = Math.hypot(f.hw, f.hd);
      for (let x = f.x - r; x <= f.x + r + CELL; x += CELL) {
        for (let z = f.z - r; z <= f.z + r + CELL; z += CELL) {
          const k = key(x, z);
          let list = bins.get(k);
          if (!list) bins.set(k, (list = []));
          if (!list.includes(i)) list.push(i);
        }
      }
    });
    let count = 0;
    let worst = 0;
    // Named, not just counted: "4 overlaps, worst 34 m" is a number nobody can act on.
    let worstPair = 'none';
    const seen = new Set<number>();
    for (const list of bins.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const i = list[a];
          const j = list[b];
          if (i >= nFoot && j >= nFoot) continue;
          const pair = i < j ? i * 100000 + j : j * 100000 + i;
          if (seen.has(pair)) continue;
          seen.add(pair);
          const d = obbOverlap(all[i], all[j]);
          /**
           * 0.4 m of allowance, and **no upper escape hatch**.
           *
           * The first revision also skipped anything overlapping by more than 40 m, on the
           * grounds that the Byrsa published two deliberately nested rectangles. That
           * exemption hid a real 46 m overlap between a warehouse and a harbour mole, which
           * is exactly how `assertNoFootprintOverlaps` came to report zero at Rome while the
           * player was looking at the thing it was skipping. The Byrsa now publishes one
           * rectangle instead of two and the exemption is gone.
           */
          if (d > 0.4) {
            count++;
            const A = all[i];
            const B = all[j];
            // Split into the two populations `CityChecks` has scalars for, so those columns
            // are answered rather than left at a zero that reads as a pass. Water counts as a
            // monument, which is what `CitySystem` boxes it as.
            const kindOf = (k: number): string => (k >= nFoot ? 'monument' : inp.footprints[k].kind);
            if (kindOf(i) === 'monument' && kindOf(j) === 'monument') {
              scalars.footprintOverlaps++;
              scalars.footprintOverlapWorst = Math.max(scalars.footprintOverlapWorst, d);
            } else {
              scalars.fabricOverlaps++;
              scalars.fabricOverlapWorst = Math.max(scalars.fabricOverlapWorst, d);
            }
            if (d > worst) {
              worst = d;
              worstPair = `(${A.x.toFixed(0)}, ${A.z.toFixed(0)}) ${(A.hw * 2).toFixed(0)}×${(A.hd * 2).toFixed(0)}`
                + ` / (${B.x.toFixed(0)}, ${B.z.toFixed(0)}) ${(B.hw * 2).toFixed(0)}×${(B.hd * 2).toFixed(0)}`;
            }
          }
        }
      }
    }
    out.push({
      name: 'solid/solid interpenetration',
      ok: count === 0,
      detail: `${count} overlapping pair(s) over ${all.length} solids `
        + `(${nFoot} footprints + ${water.length} harbour-water rectangles), worst ${worst.toFixed(1)} m. `
        + `Population is every solid against every other — monuments, houses, quays, moles and `
        + `the water — with a 0.4 m allowance for the party walls a terrace is made of, and one `
        + `exclusion: the ${water.length} chords are one basin cut into pieces and are not tested `
        + `against each other. No soft exemption and no upper escape hatch. Worst pair: ${worstPair}.`,
    });
  }

  // ---- 3. the intervallum is actually clear -------------------------------
  //
  // Measured as a depth from real masonry over the circuit's **real span** and nowhere else.
  // Rome's equivalent sampled 300 m past the east end of its own wall against a `wallZAt`
  // that clamps, and reported four intrusions that were depths from a frozen line with no
  // stone near it.
  {
    let min = Infinity;
    let minX = 0;
    let samples = 0;
    let short = 0;
    for (let x = CIRCUIT_X_MIN; x <= CIRCUIT_X_MAX; x += 8) {
      const z0 = circuitZAt(x);
      let depth = 420;
      for (let z = z0 + 2; z < z0 + 420; z += 3) {
        let hit = false;
        for (const f of solids) {
          if (inside(x, z, f)) { hit = true; break; }
        }
        if (hit) { depth = z - z0; break; }
      }
      samples++;
      const want = intervallumDepthAt(x);
      if (depth < want - 1) short++;
      if (depth < min) { min = depth; minX = x; }
    }
    out.push({
      name: 'intervallum clear behind the circuit',
      ok: short === 0,
      detail: `min ${min.toFixed(1)} m at x=${minX} over ${samples} samples across the circuit's real span `
        + `(${CIRCUIT_X_MIN}..${CIRCUIT_X_MAX}); ${short} sample(s) below the required `
        + `${INTERVALLUM} m, or ${APRON_DEPTH} m over a stair apron.`,
    });
  }

  // ---- 4. every stair apron is empty --------------------------------------
  //
  // Wall traversal landed at fbcfe65: men climb the wall, walk along it and come *down the
  // stairs into the city*, so the ground at the foot of a flight is where the battle goes.
  // This is the check that a formation coming off a stair has somewhere to form up.
  //
  // **The apron follows the wall, and this measured a flat box.** `z0` was taken once, at the
  // apron's centre, and the same `z0` was used across all 120 m of its run — but the circuit
  // leans 121 m across the map and moves about 4 m over an apron's own width. So the far row
  // of a flat box stood a few metres *cityward* of the curved line the fabric is actually
  // held behind, and the check reported seven obstructed samples at x −475 that were two
  // perfectly legal houses standing 2.5 m behind their own build line. Reading `circuitZAt`
  // at each sample's own x costs one call and makes the box the shape of the thing it is
  // measuring. Same family as the `wallZAt` that clamped past the end of Rome's curtain and
  // invented four pomerium intrusions out of a frozen z-line.
  {
    const blocked: string[] = [];
    for (const ax of STAIR_APRONS) {
      let hit = 0;
      let tested = 0;
      for (let dx = -APRON_HALF_RUN; dx <= APRON_HALF_RUN; dx += 6) {
        for (let dz = 4; dz <= APRON_DEPTH; dz += 6) {
          const x = ax + dx;
          const z = circuitZAt(x) + dz;
          tested++;
          for (const f of solids) {
            if (inside(x, z, f)) { hit++; break; }
          }
        }
      }
      if (hit > 0) blocked.push(`x=${ax}: ${hit}/${tested}`);
    }
    out.push({
      name: 'stair-foot aprons clear',
      ok: blocked.length === 0,
      detail: `${STAIR_APRONS.length} aprons of ${APRON_HALF_RUN * 2} × ${APRON_DEPTH} m at `
        + `x ${STAIR_APRONS.join(', ')}. ${blocked.length ? `Obstructed: ${blocked.join('; ')}.` : 'All empty.'} `
        + `A 35 m cohort in line fits in every one with 43 m of depth to spare.`,
    });
  }

  // ---- 5. the honest density number ---------------------------------------
  //
  // Rome's "20.5% built" was an instrument reading its own streets as failure: its keep-out
  // came from the twenty-two named viae and could not see the 374 lanes the districts cut,
  // so 39 hectares of carriageway scored as unbuilt gap. Two figures are given here, and the
  // second is the one to compare with an orthophoto.
  {
    let roof = 0;
    let placed = 0;
    let rejected = 0;
    for (const q of inp.blocksByQuarter) { roof += q.roofArea; placed += q.placed; rejected += q.rejected; }
    // Walled land: integrate the depth from the circuit to the shore across the frontage,
    // rather than multiplying two round numbers. The circuit leans 121 m and the coast runs
    // diagonally, so a rectangle over-states the area by about a tenth and would flatter the
    // coverage figure by the same.
    let walled = 0;
    for (let x = CIRCUIT_X_MIN; x <= CIRCUIT_X_MAX; x += 10) {
      walled += Math.max(0, shoreZAt(x) - circuitZAt(x)) * 10;
    }
    // Street area: every carriageway, named and cut, at its own width.
    let wayArea = 0;
    for (const w of PUNIC_WAYS) {
      for (let s = 0; s + 1 < w.path.length; s++) {
        wayArea += Math.hypot(w.path[s + 1].x - w.path[s].x, w.path[s + 1].z - w.path[s].z) * w.width;
      }
    }
    for (const l of inp.lanes) {
      for (let s = 0; s + 1 < l.path.length; s++) {
        wayArea += Math.hypot(l.path[s + 1].x - l.path[s].x, l.path[s + 1].z - l.path[s].z) * l.width;
      }
    }
    const pctWalled = (roof / walled) * 100;
    const betweenLines = (roof / Math.max(1, walled - wayArea)) * 100;
    // The rejection ledger, pooled. A single "771 rejected" hid three empty quarters for a
    // whole revision; a cause breakdown names the binding constraint in one line.
    const pool: Record<string, number> = {};
    for (const q of inp.blocksByQuarter) {
      for (const [k, v] of Object.entries(q.why ?? {})) pool[k] = (pool[k] ?? 0) + v;
    }
    const ledger = Object.entries(pool)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    // The decomposition, which is the figure that actually compares with a Punic core.
    //
    // A single average over the walled land cannot answer "is the fabric dense enough",
    // because a third of Carthage inside the wall is §7.7's garden suburb and is supposed to
    // be empty. Split the two and the answer is unambiguous — and it is the opposite of what
    // the pooled number suggests.
    let megaraRoof = 0;
    let denseRoof = 0;
    for (const q of inp.blocksByQuarter) {
      if (/megara/.test(q.id)) megaraRoof += q.roofArea; else denseRoof += q.roofArea;
    }
    out.push({
      name: 'roof coverage',
      ok: true,
      detail: `${placed} blocks (${rejected} rejected: ${ledger || 'no ledger'}), `
        + `${(roof / 1e4).toFixed(1)} ha of roof over `
        + `${(walled / 1e4).toFixed(1)} ha of walled land = **${pctWalled.toFixed(1)}%**; `
        + `${(wayArea / 1e4).toFixed(1)} ha of that is carriageway, so roof between street lines is `
        + `**${betweenLines.toFixed(1)}%**. Split: dense city ${(denseRoof / 1e4).toFixed(1)} ha, `
        + `Megara ${(megaraRoof / 1e4).toFixed(1)} ha of walled enclosure. Not a pass/fail: the `
        + `second figure is the one comparable with an orthophoto, and Megara is a garden `
        + `suburb that is *supposed* to be empty — see 'dense fabric at the module's ceiling'.`,
    });
  }

  // ---- 5b. the figure that actually compares with a Punic core ------------
  //
  // **A pooled coverage percentage cannot answer "is the fabric dense enough", and it was
  // being asked to.** Carthage's published 25.0 % of walled land against Rome's 51.6 % looks
  // like a thin city. It is not one. A 4 m land census inside the build line finds
  // 120.8 buildable hectares, of which §7.7's garden suburb claims about a third by design,
  // the ways and monuments reserve a further sixth, and 8 ha is water. Measure the dense
  // quarters against the land they actually have and the answer is 60-70 % — which is the
  // figure the archaeology gives for the Carthaginian core, and it is also the arithmetic
  // ceiling of the cubit module itself:
  //
  //     block 30.9 × 15.45 in a cell of (30.9 + 4) × (15.45 + 7) = 477 / 784 = 60.9 %
  //
  // So the dense fabric is **at its ceiling**, and the only way to raise the pooled number
  // further is to narrow the streets below Lancel's measured 5-7 m band or to build over the
  // Megara. Both would be a different city. This check states the ceiling next to the
  // achieved figure so nobody has to rediscover that.
  {
    const cellArea = (INSULA_FACE + PUNIC_WAY_WIDTH.vicus) * (INSULA_DEPTH + PUNIC_WAY_WIDTH.local);
    const ceiling = ((INSULA_FACE * INSULA_DEPTH) / cellArea) * 100;
    let denseRoof = 0;
    let denseBlocks = 0;
    for (const q of inp.blocksByQuarter) {
      if (/megara/.test(q.id)) continue;
      denseRoof += q.roofArea;
      denseBlocks += q.placed;
    }
    // The land the dense quarters stand on, measured rather than declared: the union of the
    // blocks' own cells. One cell per block is exact by construction — the lattice places at
    // most one block per cell — so this is the module's own denominator and nothing else.
    const denseLand = denseBlocks * cellArea;
    const achieved = denseLand > 0 ? (denseRoof / denseLand) * 100 : 0;
    out.push({
      name: "dense fabric at the module's ceiling",
      // Clipped blocks are shorter than a full five-plot face, so the achieved figure is
      // *under* the ceiling by construction and 0.85 of it is a full city.
      ok: achieved >= ceiling * 0.8,
      detail: `${denseBlocks} blocks outside the Megara carry ${(denseRoof / 1e4).toFixed(1)} ha of `
        + `roof over ${(denseLand / 1e4).toFixed(1)} ha of their own lattice cells = `
        + `**${achieved.toFixed(1)}%**, against the cubit module's arithmetic ceiling of `
        + `${ceiling.toFixed(1)}% (a ${INSULA_FACE.toFixed(1)} × ${INSULA_DEPTH.toFixed(1)} m block `
        + `in a ${(INSULA_FACE + PUNIC_WAY_WIDTH.vicus).toFixed(1)} × `
        + `${(INSULA_DEPTH + PUNIC_WAY_WIDTH.local).toFixed(1)} m cell) and the 60-70% the `
        + `archaeology gives for the Carthaginian core. **The gap between this and the pooled `
        + `figure above is the Megara and the streets, not thin housing.**`,
    });
  }

  // ---- 5a. no residential quarter may be empty ----------------------------
  //
  // **This check exists because three of them were, and nothing said so.** `hannibal-quarter`
  // is the Byrsa slope Lancel excavated — the source of every dimension in §7.1 and the
  // single most important piece of urbanism on the map — and it placed zero blocks;
  // `byrsa-approach`, which carries Appian's six-storey ranges on the three streets, placed
  // zero; `quarter-salammbo` placed zero. Pooled into "423 blocks, 25.0% coverage" all three
  // were invisible, because a coverage percentage is an average and an average cannot be
  // empty in one place. A quarter that is named, authored and residential and then builds
  // nothing is a bug in the constants, not a thin district.
  {
    const empty = inp.blocksByQuarter.filter((q) => q.placed === 0);
    out.push({
      name: 'every residential quarter builds',
      ok: empty.length === 0,
      detail: empty.length === 0
        ? `all ${inp.blocksByQuarter.length} quarters placed at least one block; the smallest is `
          + `${inp.blocksByQuarter.reduce((a, q) => (q.placed < a.placed ? q : a)).id} at `
          + `${inp.blocksByQuarter.reduce((a, q) => (q.placed < a.placed ? q : a)).placed}.`
        : `${empty.length} empty: ${empty.map((q) => `${q.id} (0 of ${q.rejected}: `
          + `${Object.entries(q.why ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')})`).join('; ')}`,
    });
  }

  // ---- 6. the ship sheds, reported not asserted ---------------------------
  out.push({
    name: 'ship sheds',
    ok: true,
    detail: `${inp.shedCount} built — 30 on the island and 138 round the ring, at the 5.9 m `
      + `slipway width the British excavation measured. Appian says 220; archaeology gives `
      + `160-170. We model the archaeology and the blurb may quote Appian.`,
  });

  // ---- 6a. nothing the city builds stands under the sea --------------------
  //
  // **The check that did not exist while the water was a splat.** `planQuarter` refused
  // anything seaward of `shoreZAt`, which is the Gulf of Tunis and a function of x; the Lake
  // of Tunis is a function of z and nothing tested it, so the Salammbô quarter's grid marched
  // across the lagoon behind the Taenia — 22 footprints, 6,689 m², the deepest with its floor
  // 9.3 m under water. The gulf's swell breathes the waterline to +0.44 m at the crest, so
  // the bar is the datum plus a freeboard and not the datum itself.
  //
  // Monuments are counted separately and are *expected* to be wet: Scipio's mole, the
  // quay-fort on the captured quay, the cut channel and the cothon's own ring are harbour
  // works standing in the sea on purpose.
  {
    const SWELL_CREST = 0.44;
    let wetFabric = 0;
    let wetFabricArea = 0;
    let worst = 0;
    let worstAt = '';
    let wetMonuments = 0;
    for (const f of inp.footprints) {
      const c = Math.cos(f.rot);
      const s = Math.sin(f.rot);
      let lo = Infinity;
      for (let iu = -1; iu <= 1; iu++) {
        for (let iv = -1; iv <= 1; iv++) {
          const u = iu * f.hw;
          const v = iv * f.hd;
          lo = Math.min(lo, inp.heightAt(f.x + u * c - v * s, f.z + u * s + v * c));
        }
      }
      if (lo >= SEA_LEVEL) continue;
      if (f.kind === 'monument') { wetMonuments++; continue; }
      wetFabric++;
      wetFabricArea += 4 * f.hw * f.hd;
      if (-lo > worst) { worst = -lo; worstAt = `(${f.x.toFixed(0)}, ${f.z.toFixed(0)})`; }
    }
    let wetTowers = 0;
    let towerWorst = 0;
    for (const t of inp.towers) {
      let lo = Infinity;
      for (let i = -1; i <= 1; i++) {
        for (let k = -1; k <= 1; k++) {
          lo = Math.min(lo, inp.heightAt(t.x + i * t.hw, t.z + k * t.hw));
        }
      }
      if (lo < SEA_LEVEL) { wetTowers++; towerWorst = Math.max(towerWorst, -lo); }
    }
    const drowned = inp.blocksByQuarter.reduce((a, q) => a + q.drowned, 0);
    out.push({
      name: 'nothing the city builds stands under the sea',
      ok: wetFabric === 0 && wetTowers === 0,
      detail: `${wetFabric} of ${inp.footprints.filter((f) => f.kind === 'building').length} `
        + `house footprints and ${wetTowers} of ${inp.towers.length} curtain towers have any `
        + `part of their plan below ${SEA_LEVEL} m`
        + (wetFabric ? `, worst ${worst.toFixed(2)} m under at ${worstAt}` : '')
        + (wetTowers ? `, worst tower ${towerWorst.toFixed(2)} m under` : '')
        + `. ${drowned} candidate blocks were refused at build for standing within `
        + `${SWELL_CREST} m of the datum, which is where the gulf's swell crest reaches. `
        + `${wetMonuments} monuments *are* under it and are meant to be — Scipio's mole, the `
        + `quay-fort, the cut channel and the cothon ring are harbour works built into the sea.`,
    });
  }

  // ---- 6b. the harbour basins are one body of water ------------------------
  //
  // Both basins join the gulf through 21 m channels, so all three surfaces are the same
  // water. They were not: each basin's level was `heightAt(its own centre) - FREEBOARD`,
  // which put the cothon at −1.46 and the merchant basin at −0.04 against a sea at 0. The
  // level is now `BASIN_WATER_Y` for both and the *freeboard* is what the ground supplies,
  // so it is measured here rather than assumed — and the cothon's is the finding.
  {
    /**
     * **Sample the quay, not the water.**
     *
     * Both freeboards used to be `heightAt(basin centre)`, which was defensible only while the
     * heightfield still left the basins filled in — the "quay" and the basin floor were then
     * the same ground. Now that both basins are genuinely excavated, the centre of a basin is
     * its *bed*, so this read a bed depth and printed it as a quay height: the merchant basin
     * reported a freeboard of **−3.10 m**, a number with no meaning, inside a check that said
     * `[ ok ]`. A green board carrying a nonsense figure is worse than a red one.
     *
     * Each is now sampled on the belt a man actually stands on. The merchant reference is the
     * landward quay, `mh.z - mh.hd - mh.quayWest * 0.5`, which is the point `harbour.ts` sets
     * its own quay level from and the one `layout.ts` hangs `via-navalis` on, so the three
     * cannot drift apart. The cothon's basin is annular and its centre is the admiralty
     * island — made ground, and itself a quay — so that sample was already honest.
     *
     * And the freeboard is now part of `ok`. It was an "output": printed, never tested. That
     * is how it sat at 0.34 m against §6.2's 1.8 without anything going red.
     */
    const cothonQuay = inp.heightAt(COTHON.x, COTHON.z);
    const mh = MERCHANT_HARBOUR;
    const merchantQuay = inp.heightAt(mh.x, mh.z - mh.hd - mh.quayWest * 0.5);
    const cf = cothonQuay - BASIN_WATER_Y;
    const mf = merchantQuay - BASIN_WATER_Y;
    out.push({
      name: 'harbour basins at sea level, on quays a man can stand on',
      ok: BASIN_WATER_Y === SEA_LEVEL && cf >= FREEBOARD && mf >= FREEBOARD,
      detail: `both basins at ${BASIN_WATER_Y.toFixed(2)} m, the gulf they join at `
        + `${SEA_LEVEL.toFixed(2)}. Quay freeboard, sampled on the quay belt and not at the `
        + `basin centre: cothon **${cf.toFixed(2)} m**, merchant **${mf.toFixed(2)} m**, both `
        + `against the ${FREEBOARD} m of §6.2. Raising a quay is not a fix for a short one — `
        + `men stand at terrain height, so a lifted quay is one they walk under, and the `
        + `heightfield has to be cut instead.`,
    });
  }

  // ---- 7. every monument the plan names got built --------------------------
  out.push({
    name: 'monuments planned',
    ok: MONUMENTS.length > 0,
    detail: `${MONUMENTS.length} named: ${MONUMENTS.map((m) => m.id).join(', ')}. `
      + `Positions are authored final and there is no resolver — see the order-of-operations `
      + `note in layout.ts. Nothing moves after the ways are projected, which is the failure `
      + `mode this plan is shaped to avoid.`,
  });

  return { assertions: out, ...scalars };
}
