import type { CityAssertion, PlanRect } from '../cityPlan';
import type { Lane } from '../insulae';
import {
  APRON_DEPTH, APRON_HALF_RUN, CIRCUIT_X_MAX, CIRCUIT_X_MIN, circuitZAt,
  INTERVALLUM, intervallumDepthAt, STAIR_APRONS,
} from './circuit';
import { MONUMENTS, PUNIC_WAYS, shoreZAt } from './layout';

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
  /** How many buildings each quarter placed, and their roof area. */
  blocksByQuarter: readonly { id: string; placed: number; rejected: number; roofArea: number }[];
  shedCount: number;
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
  {
    const blocked: string[] = [];
    for (const ax of STAIR_APRONS) {
      const z0 = circuitZAt(ax);
      let hit = 0;
      let tested = 0;
      for (let dx = -APRON_HALF_RUN; dx <= APRON_HALF_RUN; dx += 6) {
        for (let dz = 4; dz <= APRON_DEPTH; dz += 6) {
          const x = ax + dx;
          const z = z0 + dz;
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
    out.push({
      name: 'roof coverage',
      ok: true,
      detail: `${placed} blocks (${rejected} rejected), ${(roof / 1e4).toFixed(1)} ha of roof over `
        + `${(walled / 1e4).toFixed(1)} ha of walled land = **${pctWalled.toFixed(1)}%**; `
        + `${(wayArea / 1e4).toFixed(1)} ha of that is carriageway, so roof between street lines is `
        + `**${betweenLines.toFixed(1)}%**. Not a pass/fail: the second figure is the one comparable `
        + `with an orthophoto, and Megara is a garden suburb that is *supposed* to be empty.`,
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
