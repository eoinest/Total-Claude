import { Rng } from '../../util/rand';
import { CARTHAGE_WALL_LINE } from '../../city/carthage/circuit';
import { BASIN_DEPTH, BASIN_WATER_Y, FREEBOARD } from '../../city/carthage/harbour';
import { COTHON, MERCHANT_HARBOUR } from '../../city/carthage/layout';
import { CARTHAGE_DITCH_SECTION, carthageDitchPath } from '../../city/carthageWall';
import { blurField, hydraulicErode } from '../../terrain/erosion';
import { fbm, gnoise, ridged, sstep, warpedFbm } from '../../terrain/noise';
import { FIELD_RES, FIELD_SPACING, sampleBilinear, type TerrainData } from '../../terrain/heightfield';
import {
  BYRSA_SUMMIT,
  BYRSA_X,
  BYRSA_Z,
  HALF_EXTENT,
  ROAD_HALF_WIDTH,
  SEA_LEVEL,
  SEGUIAS,
  WADI_HALF_WIDTH,
  WALL_BENCH_HALF,
  WALL_X_MAX,
  WALL_X_MIN,
  arianaEdgeX,
  battleCoreMask,
  carthageWallZ,
  coastZ,
  lakeEdgeX,
  punicDeployMask,
  regionalLand,
  roadCentreX,
  romanDeployMask,
  seguiaDistance,
  softGround,
  taeniaNess,
  wadiInfluence,
  wadiProfile,
  wadiZ,
} from './topography';

/**
 * Builds the heightfield for the isthmus of Carthage, spring 146 BC. Built to
 * `docs/CARTHAGE.md` §2 and §3.
 *
 * Same five-stage pipeline as the other two maps — analytic macro form, droplet erosion on a
 * 1025² working grid, Catmull-Rom upsample to 2049², human marks at full resolution, control
 * texture from the erosion by-products — and it has to be, because `TerrainData` is what the
 * clipmap, the splat material, the grass and the scatter all read. What differs is where the
 * budget goes, and three stages are unlike anything the other maps do:
 *
 *  - **A bench under the wall line.** §3.1: at Rome the wall stands on a 22–34 m rise and an
 *    attacker climbs 175 m of slope under fire; the Carthaginian isthmus is a flat neck and
 *    the wall carries all of its defence in stone. The bench is *not* a rise — it levels the
 *    footing without raising it, because the flatness is the design. It is a gameplay
 *    requirement: `buildWall` levels each bay to the ground under it, so unbenched terrain
 *    gives neighbouring bays differing by metres, and `Siege.layOutGarrison` walks one
 *    continuous run of stations along the walkway. A 3 m step between bays is a cliff in the
 *    middle of the garrison.
 *  - **Erosion is confined to the two hills.** There is no drainage network to find on a
 *    coastal neck two metres above a lagoon, and a droplet on a salt pan pits it.
 *  - **Nothing may dig near water, and the shore must plunge.** See `SHORE_SCARP_DEPTH` in
 *    `topography.ts`: the pathfinder marks a cell impassable above gradient 0.62, and that
 *    scarp is the only thing on this map stopping an army walking into the Gulf of Tunis.
 *  - **Except the harbours, which are dug on purpose.** Stage 4g, and the one place on this
 *    map where the terrain takes an instruction from the city plan rather than the other way
 *    round. See `HARBOUR_GROUND`.
 *  - **And the ditch, which is the other one.** Stage 4h. `carthageWall.ts` publishes a
 *    20 x 6 m dry ditch on the wall's own glacis and cannot cut it; this file can. See
 *    `THE DITCH` below for the profile and for the two places it is not full depth.
 *
 * The control texture's four channels carry the meanings the shader contract fixes, but on
 * this coast in April they describe different things — see stage 5.
 */

/** Working grid for the expensive noise and erosion stages. Matches the other two maps. */
const WORK_RES = 1025;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Catmull-Rom weights for the halfway sample of a 2× upsample. */
const UP_A = -1 / 16;
const UP_B = 9 / 16;

/**
 * Weight of the two hills, for the relief octaves and the erosion mask.
 *
 * Deliberately wider than the hills' own footprints so their skirts get gullies too, and
 * `max`ed rather than summed for the same reason `regionalLand` maxes the hills themselves.
 */
const uplandWeight = (x: number, z: number): number => {
  const byrsa = Math.exp(-Math.pow(Math.hypot((x - BYRSA_X) / 230, (z - BYRSA_Z) / 145), 2));
  const djedid = Math.exp(-Math.pow(Math.hypot((x - 210) / 260, (z - 1037) / 175), 2));
  return Math.max(byrsa, djedid * 0.85);
};

/**
 * 1 on firm dry ground, 0 at a water's edge or on a salt margin.
 *
 * Every subtractive mark on this map is multiplied by it, and it is a shared helper rather
 * than three local expressions because the reason is shared: near the water the ground sits
 * under two metres, so a 1.6 m channel or a 0.7 m detail octave puts it through the datum —
 * and below the datum, on a map with no water surface, is a hole the splat has no material
 * for and the pathfinder reads as a beach.
 */
const dryLand = (x: number, z: number): number => {
  const nearLake = 1 - sstep(0, 280, x - lakeEdgeX(z));
  const nearCoast = 1 - sstep(0, 220, coastZ(x) - z);
  const nearAriana = 1 - sstep(0, 240, arianaEdgeX(z) - x);
  return 1 - Math.max(nearLake, Math.max(nearCoast, nearAriana));
};

/** The macro landform plus its fBm relief, before any human marks or the exact wadi bed. */
function baseHeight(x: number, z: number, seed: number): number {
  let h = regionalLand(x, z);

  const core = battleCoreMask(x, z);
  const upland = uplandWeight(x, z);
  const dry = dryLand(x, z);

  // --- Relief on the isthmus ------------------------------------------------
  // Broad swells at a 560 m wavelength, warped so they are lobed rather than sinusoidal.
  // 2.0 m, against Pydna's 3.4: this is a marine terrace on a coastal neck, and the flatness
  // is the whole reason a wall got built across it (§3.1).
  h += warpedFbm(x, z, 4, 1 / 560, seed + 1, 0.9) * 2.0 * dry;
  // The band that reads. 145 m at 2.2 m — invisible to a man, and under a 20° sun the thing
  // that models the plain into lit and shaded faces. Damped to 38 % in the fighting corridor.
  h += fbm(x, z, 3, 1 / 145, seed + 2) * 2.2 * dry * (1 - 0.62 * core);
  // Surface roughness, damped hard in the corridor: at this scale it would trip formation
  // spacing without reading in any frame.
  h += fbm(x, z, 3, 1 / 38, seed + 3) * 0.36 * dry * (1 - 0.7 * core);

  // --- The two hills --------------------------------------------------------
  // Ridged multifractal on the Byrsa and Bordj Djedid only. Few octaves and a low gain: the
  // fine structure of a hillside comes out of the erosion pass, not out of noise, or the
  // slopes read as corduroy. These are calcarenite hills — soft marine sandstone — so they
  // weather to rounded shoulders with steep gullied noses, which is what the pass gives.
  //
  // **Weighted by `flank`, not by `upland`, and that is the whole trick.** `upland` peaks at
  // the summit and so does a ridged multifractal, so the two do not average there, they add —
  // and whichever way the noise happens to fall, the published summit height is the one number
  // on this hill that must survive. Weighted at `4u(1−u)` the relief is zero at the centre,
  // zero far away, and full at mid-flank, which is also where gullies belong on a hill that
  // weathers from its own drainage. Both errors have now been made and measured: at
  // `upland × 26` the Byrsa came out 16 m over its published 60, and at `upland × 9` it came
  // out 9 m under. Size hill relief against the measured field, never against the intent.
  const flank = 4 * upland * (1 - upland);
  h += flank * (ridged(x, z, 4, 1 / 300, seed + 11, 0.44) - 0.46) * 11;
  h += flank * fbm(x, z, 3, 1 / 90, seed + 12) * 2.2;

  // --- The wadi -------------------------------------------------------------
  // Tapered by `dry`, so the channel loses itself as it reaches the lake margin. That is what
  // a wadi entering a sabkha does — it spreads into a delta of fines and stops being a
  // channel — and it keeps the bed off the datum.
  const d = z - wadiZ(x);
  const inf = wadiInfluence(d) * dry;
  if (inf > 0.001) h += (wadiProfile(d, h) - h) * inf;

  return h;
}

/**
 * Floor the *dry land* just clear of the datum, smoothly — and leave the water alone.
 *
 * The floor is needed because the shore terms are not the only thing that can dig: the detail
 * octave adds ±0.7 m on a slope, the erosion pass moves material, and a channel cut near a
 * margin compounds with both. A hard `Math.max` would leave a visible shelf wherever it bit;
 * a softplus never quite reaches the floor and is smooth in its first derivative, so the pan
 * simply stops descending instead of hitting a plate.
 *
 * It is applied by *how dry the ground is*, not everywhere, because this map deliberately has
 * ground below the datum — the sea, and the scarp that keeps an army out of it.
 */
const FLOOR = 0.25;
const FLOOR_KNEE = 0.35;
const softFloor = (h: number, dry: number): number => {
  if (dry <= 0.001) return h;
  const t = h - FLOOR;
  // Past six knees the softplus is the identity to within a float epsilon, and `exp` of a
  // large argument is an overflow waiting to happen in the one place it is called 4.2 M times.
  const floored = t > FLOOR_KNEE * 6 ? h : FLOOR + FLOOR_KNEE * Math.log1p(Math.exp(t / FLOOR_KNEE));
  return h + (floored - h) * dry;
};

// ---------------------------------------------------------------------------
// The harbours (§6.2) — the only ground on this map that is dug on purpose
// ---------------------------------------------------------------------------

/**
 * **The basins were painted, not dug, and rendering the water is what proved it.**
 *
 * Until `WaterSurface` landed, a harbour basin on this map was a hole in `harbour.ts`'s own
 * geometry standing on ground the heightfield knew nothing about, and a splat rule painted
 * whatever was under the datum blue. Put a real surface in each basin and the measurement
 * falls out: **51 % of the cothon's water area and 84 % of the merchant basin's stood under
 * terrain that was above their own surface** — the water was buried and the parts of it that
 * showed were the parts the coastal ramp happened to have taken below zero.
 *
 * The same ramp is why the cothon's quay cleared its water by **0.34 m** against the 1.8 m
 * `FREEBOARD` §6.2 asks for: `regionalLand` crushes the crown to a twentieth of itself within
 * 220 m of `coastZ`, and the cothon's centre is 19 m inside it. §3.3 puts the harbour district
 * at **2–6 m**, so the ground there was 1.7 m short of its own survey.
 *
 * **Raising the quay is not the fix and it is worth saying why in the terrain file.** Men
 * stand at terrain height. A ring quay lifted 1.5 m to meet the design figure is 1 km of
 * colonnade the garrison walks *under*. The ground has to come up and the basin has to go
 * down, both here, and the numbers for both are imported from the builder that draws the
 * masonry rather than copied — two files disagreeing about one basin is the fault this
 * workstream keeps finding in other people's code.
 *
 * **What is dug and what is not.** The cothon's annulus, the 30 m Carthaginian cut and the
 * 21 m channel into the naval yard are dug. The merchant basin is *not* — see
 * `CUT_MERCHANT_BASIN`. Its 21 m sea entrance needs nothing: it opens 38 m seaward of
 * `coastZ`, where the bed is already at −9.1 m.
 */
/** Level of the harbour district's made ground, and the argument for the value.
 *
 * §3.3 gives the district 2–6 m; §6.2's `FREEBOARD` implies 1.8. The two disagree by 0.2 m and
 * this takes the higher, because §3.3's band is a survey figure and the freeboard is `[GAME]`.
 * Derived rather than typed so that moving `FREEBOARD` past 2 m moves the ground with it.
 */
const HARBOUR_GROUND = BASIN_WATER_Y + Math.max(FREEBOARD, 2.0);

/**
 * How far the terrain bed sits under the built floor plate, and why it is not zero.
 *
 * `harbour.ts` lays a flat concrete plate across each basin at `BASIN_WATER_Y - BASIN_DEPTH`.
 * Terrain at exactly that height is coplanar with it and z-fights through 2.8 m of water at a
 * 400 m camera — the same reason `carthage.ts` lifts the water plate by `BASIN_LIFT`. So the
 * bed goes 0.3 m under the plate: invisible, and it keeps the *rendered* depth at §6.2's 2.8 m
 * because what the eye sees is the plate. Where there is no plate — the two channels — this is
 * the whole story and the water is 3.1 m deep.
 */
const BED_SINK = 0.3;
const BASIN_BED = BASIN_WATER_Y - BASIN_DEPTH - BED_SINK;

/**
 * **The merchant basin is dug.** It was blocked on one line in `harbour.ts`: the merchant
 * harbour's quay elevation was sampled as `heightAt(mh.x, mh.z)` — the ground at the **centre
 * of the basin**. Excavating with that line unfixed would have made that sample the bed: the
 * 15/25 m quay belts, the basin's own revetment and both entrance moles would all have been
 * rebuilt at −3.1 m, three metres under the sea. The cothon never had this problem because
 * *its* sample lands on the admiralty island, which stays at quay level by design.
 *
 * `harbour.ts` now samples `heightAt(mh.x, mh.z - mh.hd - mh.quayWest * 0.5)` — the landward
 * quay belt, not the basin centre — so digging the basin here no longer moves the quay's own
 * reference point. The district raise (`cothonApron`) still does not reach the merchant
 * harbour: its quay was never below `HARBOUR_GROUND` the way the cothon's was, so it needs no
 * made-ground lift, only the cut below.
 */
const CUT_MERCHANT_BASIN = true;

/**
 * The ring quay, metres. `harbour.ts` paves the annulus `outerR .. outerR + 20` and does not
 * export the width; it is restated here with the call named so a reader can check it, and it
 * is the *only* harbour number in this file that is not imported.
 */
const COTHON_QUAY = 20;
/** Working margin outside the paving before the made ground starts to fall away. */
const QUAY_MARGIN = 8;
/**
 * How far the made ground takes to die into whatever is around it. **A pathfinder number.**
 *
 * Landward the platform meets ground at 0.7–1.9 m, so 20 m of fall is a 0.06 gradient and the
 * harbour joins the city. Seaward it meets the gulf floor at −9.2 m, so the same 20 m is a
 * peak gradient of 1.5 × 11.2 / 20 = **0.84** — over `SLOPE_IMPASSABLE`, which is the point:
 * the outer face of a mole has to refuse a formation exactly as the shore scarp does, or the
 * harbour becomes the flank march this map is built not to have.
 */
const APRON_FALL = 20;
/**
 * Feather at a basin wall, metres. One heightfield cell, and the tightest thing in this file.
 *
 * Turned *inward*, never outward: `harbour.ts` stands a vertical revetment at `outerR` and at
 * `islandR`, so the ramp from quay level down to the bed has to hide behind that masonry. A
 * feather that reached outward would undercut the ring quay men fight along.
 *
 * It cannot be zero — the field is reconstructed bilinearly and a step is a step over one cell
 * whatever is written into it — and every metre of it is a metre of bed standing above the
 * waterline at the foot of the wall. At 2.8 m it measured as a 1.0 m ledge of sand right round
 * both revetments, 2.0 % of the basin's plan; at one cell it is half that.
 */
const BASIN_EDGE = 1.4;

/**
 * §6.4's two channels, with the endpoints `harbour.ts` publishes as `occSegments`.
 *
 * Verbatim, so the ground that is water and the ground the pathfinder is told is water are the
 * same ground. Both capsules reach a little inside the ring — which is what a channel cut
 * through a quay is, and what the city's own blockers already say: the cut is *also* a 30 m
 * gap in Carthage's own defences and the ring is severed at both of them by design.
 */
const CHANNELS: readonly { x1: number; z1: number; x2: number; z2: number; half: number }[] = [
  // The Carthaginians' cut straight out to the open sea, 30 m, freshly dug and unrevetted.
  { x1: COTHON.x, z1: COTHON.z + COTHON.outerR + 6, x2: COTHON.x + 60, z2: 1340, half: 15 },
  // The controlled channel into the naval yard, 21 m, behind a double wall with a gate.
  {
    x1: COTHON.x + COTHON.outerR + 8, z1: COTHON.z,
    x2: MERCHANT_HARBOUR.x - MERCHANT_HARBOUR.hw - 6, z2: MERCHANT_HARBOUR.z, half: 10.5,
  },
];

/** Distance from a point to a segment. The two channels are capsules, as the city stamps them. */
const segDist = (
  x: number, z: number, x1: number, z1: number, x2: number, z2: number,
): number => {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp01(((x - x1) * dx + (z - z1) * dz) / l2) : 0;
  return Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
};

/** 0 on a channel's centreline, 1 at its lip, greater than 1 clear of both. */
const channelNess = (x: number, z: number): number => {
  let least = Infinity;
  for (const c of CHANNELS) least = Math.min(least, segDist(x, z, c.x1, c.z1, c.x2, c.z2) / c.half);
  return least;
};

/** 1 on the cothon's made ground — island, water and ring quay alike — 0 past its outer fall. */
const cothonApron = (x: number, z: number): number => {
  const flat = COTHON.outerR + COTHON_QUAY + QUAY_MARGIN;
  return 1 - sstep(flat, flat + APRON_FALL, Math.hypot(x - COTHON.x, z - COTHON.z));
};

/**
 * 1 in open harbour water, 0 on the quay, on the island and on the mole.
 *
 * **The island is not in here and must not be.** §6.2 calls it an artificial raised platform
 * 125 m across; excavating it with the water round it would leave the admiral's house, thirty
 * ship sheds and the causeway's far landing standing on the bottom of the basin.
 *
 * **The whole 100 m annulus is dug, and the one thing that argues against it is measured
 * rather than asserted.** §6.2 gives 100 m of annular water and `harbour.ts` reads that as
 * "80 of it is shed and 20 is water" — but it then draws all 168 sheds *flat at `quayY`*, so
 * any bed under them at all floats them, and digging only the middle 20 m would leave the
 * authored water plate in `carthage.ts` buried over 80 % of its own plan. Dug in full, the
 * sheds stand 5.10 m over their bed and 1.65 m over the water, which is `harbour.ts`'s to fix
 * by building them and their §6.3 1:10 slipways from `floorY` up through the waterline.
 *
 * The gameplay worry — that this takes the ring-shed range out of the battle §6.1 says the
 * harbours exist for — was measured and is the other way round. Flood-filling the pathfinder's
 * own `isStandable` at the 35 m body from the harbour district: the ring-shed band r 122.5–162.5
 * goes from **2.17 of 3.59 ha reachable to 3.54**, and the ring quay itself from **1.27 of 2.15
 * to 2.08**, because half of both used to be nine metres under the Gulf of Tunis. The bed at
 * −3.10 m is chest-deep rather than drowning, so the sheds are waded at 2.6× cost; the 20 m
 * manoeuvring ring in the middle stays a hard obstacle because the city stamps it as one.
 */
const harbourWater = (x: number, z: number): number => {
  const r = Math.hypot(x - COTHON.x, z - COTHON.z);
  let w = sstep(COTHON.islandR, COTHON.islandR + BASIN_EDGE, r)
    * (1 - sstep(COTHON.outerR - BASIN_EDGE, COTHON.outerR, r));
  const mh = MERCHANT_HARBOUR;
  for (const c of CHANNELS) {
    w = Math.max(w, 1 - sstep(c.half - BASIN_EDGE, c.half,
      segDist(x, z, c.x1, c.z1, c.x2, c.z2)));
  }
  if (CUT_MERCHANT_BASIN) {
    w = Math.max(w, Math.min(
      1 - sstep(mh.hw - BASIN_EDGE, mh.hw, Math.abs(x - mh.x)),
      1 - sstep(mh.hd - BASIN_EDGE, mh.hd, Math.abs(z - mh.z)),
    ));
  }
  return w;
};

// ---------------------------------------------------------------------------
// THE DITCH (§4.2 row 0) — the second deliberate excavation on this map
// ---------------------------------------------------------------------------

/**
 * **The ditch was published and never cut, and that is a worse state than either.**
 *
 * `carthageWall.ts` builds a 20 x 6 m dry ditch into its own arithmetic: `BELT_DEPTH` counts
 * it, `assertSection` checks it, `CARTHAGE_SECTION.beltDepth` reports **34.1 m** of landward
 * defence, and `CitySystem.getDitch()` hands the record to anyone who asks. What stood on the
 * ground was flat. Measured with `tools/probe-ditch-ds.mjs` before this stage existed, the
 * glacis fell **0.16 m at its worst station and 0.00 m at three of eight** across the 60 m in
 * front of the wall — the belt an assault actually had to cross was the 14.1 m of masonry, and
 * every consumer of the plan was being told 34.1.
 *
 * The wall could not fix it: a 6 m cut is a heightfield edit and `src/maps/` is not the city's.
 * So the plan crossed the seam as a request with `built: false` on it, and nothing on this side
 * had ever answered. This stage answers.
 *
 * ## The profile is not copied
 *
 * Every number below comes from `CARTHAGE_DITCH_SECTION` and every point on the centreline
 * from `carthageDitchPath(CARTHAGE_WALL_LINE)` — the *same call* `buildCarthageWall` makes to
 * publish the record. Two files disagreeing about one trench is exactly the fault that put
 * 84 % of the merchant basin under its own water, and it is not being repeated 400 m west.
 *
 * ## Two places it is deliberately not 6 m deep
 *
 *  1. **Near the anchors.** §2.2: "the wall's two ends both die on water." `DITCH_END_MARGIN`
 *     already stops the cut 120 m short of each anchor, but the ground at the cut's own ends
 *     is only **3.6 m** at the south and **9.2 m** at the north, so a flat 6 m would put the
 *     bottom 2.4 m *under the Gulf of Tunis* and `WaterSurface` — which renders whatever is
 *     below the datum, with no coastline polygon — would flood it into a canal. A dry ditch
 *     that fills with sea is not the work §4.2 describes; it is a moat, and a moat on this
 *     map is a flank the wall was built to deny. So the depth is capped at whatever
 *     freeboard the ground has over `SEA_LEVEL`, less `DITCH_DRY_MARGIN`, and the shortfall
 *     is reported rather than hidden.
 *  2. **At the Porta Byrsae.** §4.5 calls a gate "a 90 m tunnel through the whole belt — a
 *     bridged ditch, a gap in the outwork, a gap in the middle wall, and only then the
 *     leaves", and `carthageWall.ts`'s own gatehouse comment says what survives of that is
 *     "the ditch causeway and the leaves". A causeway is a permanent earth bank, so it is
 *     terrain and it belongs here.
 *
 *     **Only the principal gate gets one.** `porta-uticensis` and `porta-maritima` are
 *     "barred with masonry, which is what a city does with the gates it is not using during a
 *     siege" (`circuit.ts`) — and a city that walls a gate up breaks its causeway too, or it
 *     has bricked a door and left the bridge to it standing. Three free crossings of a
 *     1,743 m trench would also have made the ditch decorative, which is the failure this
 *     whole stage exists to end.
 *
 * ## What it costs an assault, and why that is not a barrier
 *
 * The V's sides run 9 m for 6 m of fall — gradient 0.667, above `Pathfinding.SLOPE_IMPASSABLE`
 * of 0.62 — and a naive reading says the ditch is a wall no formed unit can cross. It is not,
 * because the pathfinder does not measure the ground at 1 m. `CELL` is 7 m and `deriveCost`
 * central-differences over **14 m**, which is wider than the 9 m slope: the steepest gradient
 * any nav cell can read across this profile is 6 m over 14, or **0.43**, which is passable at
 * `1 + 0.43 * 5 = 3.1x` the cost of open ground plus the climb term. That is the right answer
 * for a game as well as the true one — the ditch slows and disorders an assault, at the foot
 * of a wall, under fire, and does not forbid it. The measurement is in `assertDitchCut`, which
 * reports the worst gradient it actually produced rather than this prediction.
 */

/** How much dry freeboard the bottom of a *dry* ditch keeps over the sea. */
const DITCH_DRY_MARGIN = 0.6;
/**
 * How far the cut takes to die away at each end, along the frontage.
 *
 * Without it the trench ends in a 6 m transverse cliff 120 m short of each anchor, which is
 * both unbuildable and — since the cliff faces along the wall rather than across it — a
 * gradient the nav grid *does* refuse, sitting exactly where a flanking column would walk.
 * 45 m is a shade under one and a half bay pitches.
 */
const DITCH_RUNOUT = 45;
/**
 * Half-width of the flat of the causeway at the Porta Byrsae, and its ramps.
 *
 * The flat is the gatehouse block's own width, so the earth under the gate is as wide as the
 * masonry over it; the ramps then feather the full section in over another 12 m either side.
 */
const CAUSEWAY_HALF = CARTHAGE_DITCH_SECTION.gateBlockWidth * 0.5;
const CAUSEWAY_RAMP = 12;

/**
 * The V, as a fraction of full depth against distance from the centreline.
 *
 * 1 across the flat bottom, falling linearly to 0 at each lip. Linear and not smoothstepped:
 * a ditch is dug with mattocks to a batter, and the lip and the toe of a real counterscarp
 * are both angles, not fillets. The heightfield's own bilinear reconstruction rounds them by
 * a cell anyway, which is the only softening this profile should get.
 */
const ditchV = (d: number): number => {
  const half = CARTHAGE_DITCH_SECTION.width * 0.5;
  const flat = CARTHAGE_DITCH_SECTION.bottomWidth * 0.5;
  const a = Math.abs(d);
  if (a >= half) return 0;
  if (a <= flat) return 1;
  return 1 - (a - flat) / (half - flat);
};

export function buildCarthageTerrain(seedLabel = 'carthage-146bc'): TerrainData {
  const t0 = performance.now();
  const rng = new Rng(seedLabel);
  const seed = rng.getState() & 0xffff;

  // ---------------------------------------------------------------------
  // 1. Base form on the working grid
  // ---------------------------------------------------------------------
  const wres = WORK_RES;
  const wspacing = (HALF_EXTENT * 2) / (wres - 1);
  const work = new Float32Array(wres * wres);
  for (let j = 0; j < wres; j++) {
    const wz = -HALF_EXTENT + j * wspacing;
    const row = j * wres;
    for (let i = 0; i < wres; i++) {
      work[row + i] = baseHeight(-HALF_EXTENT + i * wspacing, wz, seed);
    }
  }

  // ---------------------------------------------------------------------
  // 2. Erosion, confined to the hills and the wadi's banks.
  // ---------------------------------------------------------------------
  const hillRegion = (i: number, j: number): number => {
    const x = -HALF_EXTENT + i * wspacing;
    const z = -HALF_EXTENT + j * wspacing;
    const bank = 1 - sstep(34, 170, Math.abs(z - wadiZ(x)));
    // Flanks, not summits, for the same reason the relief octaves use `flank`: droplets take
    // material off the highest ground first, and the Byrsa's published 60 m is the number
    // this map exists to put on the skyline. Measured — with `uplandWeight` here the summit
    // came out at 48.8 m, eleven metres of citadel eroded away. It is also the right
    // landscape: gullies belong on a hillside, and the Byrsa's summit carried a built temple
    // platform that no drainage ever crossed.
    const u = uplandWeight(x, z);
    const flank = 4 * u * (1 - u);
    // Nothing near water, whatever else says so: a droplet on a salt pan pits it, and a
    // droplet on the scarp would grade the one slope holding an army back from the sea.
    return Math.max(flank, bank * 0.7) * clamp01(dryLand(x, z));
  };
  const maps = hydraulicErode(work, wres, rng.fork('erode'), hillRegion, {
    // Soft calcarenite in a semi-arid climate: rare violent storms that cut hard and dump
    // their load as coarse fans the moment the gradient breaks. High capacity, high erode
    // rate, and a deposit rate to match so the fans actually build.
    inertia: 0.038,
    capacity: 4.2,
    erodeRate: 0.4,
    depositRate: 0.38,
    hillBias: 0.78,
  });

  // ---------------------------------------------------------------------
  // 3. Upsample to the final grid, then a fine octave weighted by local slope.
  // ---------------------------------------------------------------------
  const res = FIELD_RES;
  const spacing = FIELD_SPACING;
  const heights = new Float32Array(res * res);

  const midRow = new Float32Array(res * wres);
  const cr = (a: number, b: number, c: number, d: number): number =>
    UP_A * a + UP_B * b + UP_B * c + UP_A * d;
  for (let j = 0; j < wres; j++) {
    const src = j * wres;
    const dst = j * res;
    for (let i = 0; i < wres; i++) {
      midRow[dst + i * 2] = work[src + i];
      if (i * 2 + 1 < res) {
        const im1 = i > 0 ? i - 1 : 0;
        const ip1 = i + 1 < wres ? i + 1 : wres - 1;
        const ip2 = i + 2 < wres ? i + 2 : wres - 1;
        midRow[dst + i * 2 + 1] = cr(work[src + im1], work[src + i], work[src + ip1], work[src + ip2]);
      }
    }
  }
  for (let j = 0; j < wres; j++) {
    const jm1 = j > 0 ? j - 1 : 0;
    const jp1 = j + 1 < wres ? j + 1 : wres - 1;
    const jp2 = j + 2 < wres ? j + 2 : wres - 1;
    const dstA = j * 2 * res;
    const dstB = (j * 2 + 1) * res;
    for (let i = 0; i < res; i++) {
      heights[dstA + i] = midRow[j * res + i];
      if (j * 2 + 1 < res) {
        heights[dstB + i] = cr(
          midRow[jm1 * res + i],
          midRow[j * res + i],
          midRow[jp1 * res + i],
          midRow[jp2 * res + i],
        );
      }
    }
  }

  const detailSeed = seed + 31;
  for (let j = 1; j < res - 1; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 1; i < res - 1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const gx = (heights[row + i + 1] - heights[row + i - 1]) / (2 * spacing);
      const gz = (heights[row + res + i] - heights[row - res + i]) / (2 * spacing);
      const slope = clamp01(Math.hypot(gx, gz));
      const n =
        gnoise(wx * 0.036, wz * 0.036, detailSeed) * 0.62 +
        gnoise(wx * 0.105, wz * 0.105, detailSeed + 7) * 0.38;
      // Lower baseline than Pydna's 0.17: half this map is worked garden soil, salt pan and
      // beaten siege ground, all of which really are smooth. The slope term still roughens
      // the two hills.
      //
      // Suppressed on the scarp. A 0.7 m wobble on a 0.79 gradient is nothing to look at and
      // everything to the pathfinder, which samples the gradient over 7 m and would find
      // walkable notches in the one slope keeping an army out of the sea.
      const onScarp = sstep(0.45, 0.72, slope);
      heights[row + i] += n * (0.12 + 0.6 * slope) * (1 - onScarp);
    }
  }

  // ---------------------------------------------------------------------
  // 4. Human marks and the exact wadi bed, at full resolution.
  // ---------------------------------------------------------------------
  const rowRoadX = new Float32Array(res);
  const colWadiZ = new Float32Array(res);
  for (let k = 0; k < res; k++) {
    rowRoadX[k] = roadCentreX(-HALF_EXTENT + k * spacing);
    colWadiZ[k] = wadiZ(-HALF_EXTENT + k * spacing);
  }

  // -- 4a. Re-impose the wadi. Erosion and the upsample both smear the bed, and the braided
  //        gravel the splat rules paint needs a clean flat floor to sit in.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = wz - colWadiZ[i];
      if (Math.abs(d) > 90) continue;
      const inf = wadiInfluence(d) * clamp01(dryLand(wx, wz));
      if (inf < 0.002) continue;
      const h = heights[row + i];
      const prof = wadiProfile(d, h);
      const strength = Math.abs(d) < WADI_HALF_WIDTH ? 1 : 0.8;
      heights[row + i] = h + (prof - h) * inf * strength;
      // Bars in the braid: a dry bed is not a flat floor, it is shingle islands with dry
      // channels between them.
      if (Math.abs(d) < WADI_HALF_WIDTH * 1.4) {
        const bar = gnoise(wx * 0.06, wz * 0.13, seed + 41);
        heights[row + i] += bar * 0.4 * inf;
      }
    }
  }

  // -- 4b. The irrigation channels. Cut before the deployment flattening, which is then
  //        masked away from them, so the boxes do not erase the one thing giving the flattest
  //        ground on any of the three maps a shadow line.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -420 || wz > 460) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      // Nobody digs an irrigation channel into a salt pan, and cutting one there would take
      // the ground under the datum.
      const dry = clamp01(dryLand(wx, wz));
      if (dry < 0.02) continue;
      for (let k = 0; k < SEGUIAS.length; k++) {
        const s = SEGUIAS[k];
        const d = Math.abs(seguiaDistance(k, wx, wz));
        if (d > s.width * 2.2) continue;
        const cut = (1 - sstep(s.width * 0.5, s.width * 1.5, d)) * dry;
        if (cut < 0.004) continue;
        // A dug channel is far more even along its length than a watercourse, but a hand-cut
        // one silts and is redug in patches, so it is not uniform either.
        const vary = 0.74 + 0.36 * (0.5 + 0.5 * gnoise(wx * 0.0062, wz * 0.0062, seed + 51 + k));
        heights[row + i] -= cut * s.depth * vary;
        // The spoil bank on the downhill lip, which is where the channel's own dredgings go.
        heights[row + i] += Math.exp(-Math.pow((d - s.width * 1.4) / (s.width * 0.45), 2)) * 0.12;
      }
    }
  }

  // -- 4c. Deployment zones onto the regional plane.
  //
  //        0.8, between Rome's 0.9 and Pydna's 0.72. There is less to preserve here than at
  //        Pydna — the swells are 2.2 m rather than 3.3 and the battle does not turn on them
  //        — and more to gain: this is ground a Roman army camped on and levelled for three
  //        years, and ground an army has levelled *is* flat.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    if (wz < -350 || wz > 300) continue;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const m = Math.max(romanDeployMask(wx, wz), punicDeployMask(wx, wz));
      if (m < 0.002) continue;
      const target = regionalLand(wx, wz);
      heights[row + i] += (target - heights[row + i]) * m * 0.8;
    }
  }

  // -- 4d. **The bench under the wall line.** See the header. Smoothed along its own length
  //        rather than flattened to a constant: the wall should still fall 121 m of z from
  //        the Ariana anchor to the lake anchor and rise a little with the ground under it,
  //        it should just do both evenly.
  const benchProfile = new Float32Array(res);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    benchProfile[i] = sampleBilinear(heights, res, spacing, wx, carthageWallZ(wx));
  }
  smooth1D(benchProfile, 26);
  for (let i = 0; i < res; i++) {
    const wx = -HALF_EXTENT + i * spacing;
    // Only where the wall actually stands. Past its anchors the line is a mathematical
    // extension into water, and benching there would flatten the scarp.
    if (wx < WALL_X_MIN - 60 || wx > WALL_X_MAX + 60) continue;
    const ends = sstep(WALL_X_MIN - 60, WALL_X_MIN + 40, wx)
      * (1 - sstep(WALL_X_MAX - 40, WALL_X_MAX + 60, wx));
    const cz = carthageWallZ(wx);
    const base = benchProfile[i];
    const j0 = Math.max(0, Math.floor((cz - WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    const j1 = Math.min(res - 1, Math.ceil((cz + WALL_BENCH_HALF * 2.2 + HALF_EXTENT) / spacing));
    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const d = Math.abs(wz - cz);
      const w = (1 - sstep(WALL_BENCH_HALF, WALL_BENCH_HALF * 2.1, d)) * ends;
      if (w < 0.002) continue;
      const k = j * res + i;
      heights[k] += (base - heights[k]) * w * 0.92;
    }
  }

  // -- 4e. The road from Tunes. A metalled Punic trunk road: graded and slightly crowned,
  //        unlike Pydna's worn cart track, but not the 1.1 m agger of a consular via.
  const roadProfile = new Float32Array(res);
  for (let j = 0; j < res; j++) {
    roadProfile[j] = sampleBilinear(heights, res, spacing, rowRoadX[j], -HALF_EXTENT + j * spacing);
  }
  smooth1D(roadProfile, 18);
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    const cx = rowRoadX[j];
    const base = roadProfile[j];
    const i0 = Math.max(0, Math.floor((cx - 20 + HALF_EXTENT) / spacing));
    const i1 = Math.min(res - 1, Math.ceil((cx + 20 + HALF_EXTENT) / spacing));
    for (let i = i0; i <= i1; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      const d = Math.abs(wx - cx);
      const w = (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 9, d)) * clamp01(dryLand(wx, wz));
      if (w < 0.002) continue;
      const target = base + 0.22 * (1 - sstep(0, ROAD_HALF_WIDTH, d));
      heights[row + i] += (target - heights[row + i]) * w * 0.75;
    }
  }

  // -- 4f. Floor the dry land just clear of the datum. Last, because every stage above it can
  //        dig, and weighted by dryness so the sea and its scarp survive. See `softFloor`.
  for (let j = 0; j < res; j++) {
    const wz = -HALF_EXTENT + j * spacing;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const wx = -HALF_EXTENT + i * spacing;
      heights[row + i] = softFloor(heights[row + i], clamp01(dryLand(wx, wz)));
    }
  }

  // -- 4g. **The harbours.** The made ground up, the basins down. See `HARBOUR_GROUND`.
  //
  //        **After the floor, not before it**, and the ordering is a measured one. `softFloor`
  //        exists to stop the noise and the erosion digging *accidentally* near the datum, and
  //        it is weighted by how dry the ground is; at the cothon's landward rim `dryLand` is
  //        0.21, so a bed cut to −3.1 m before the floor came back up to −2.40. The basins are
  //        the one deliberate excavation on this map and they run last.
  {
    const reach = COTHON.outerR + COTHON_QUAY + QUAY_MARGIN + APRON_FALL + spacing;
    const bound = (v: number): number =>
      Math.max(0, Math.min(res - 1, Math.round((v + HALF_EXTENT) / spacing)));
    const i0 = bound(COTHON.x - reach);
    const i1 = bound(MERCHANT_HARBOUR.x + MERCHANT_HARBOUR.hw + 40);
    const j0 = bound(COTHON.z - reach);
    // The Carthaginian cut runs on to z 1340, well past the cothon's own apron.
    const j1 = bound(1360);
    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const wx = -HALF_EXTENT + i * spacing;
        let h = heights[row + i];
        const apron = cothonApron(wx, wz);
        if (apron > 0.002) {
          // Made ground: a worked quay platform, so it is levelled rather than smoothed, with
          // 9 cm of settling left in it at a 33 m wavelength — enough that a 20° sun finds
          // something on it and far too little for the pathfinder to notice.
          //
          // **Raise-only.** The apron is a disc and the lower town east of it stands at 12–18 m
          // (§3.3); a lerp toward 2 m would quarry the city if these constants ever moved.
          const made = HARBOUR_GROUND + 0.09 * gnoise(wx * 0.03, wz * 0.03, seed + 61);
          if (made > h) h += (made - h) * apron;
        }
        const wet = harbourWater(wx, wz);
        // **Dig-only**, for the mirror-image reason: the Carthaginian cut runs 170 m out into
        // a gulf whose floor is already at −9.2 m, and a lerp toward −3.1 there would build a
        // bar across the escape channel it exists to be.
        if (wet > 0.002 && BASIN_BED < h) h += (BASIN_BED - h) * wet;
        heights[row + i] = h;
      }
    }
  }

  // -- 4h. **The ditch.** See `THE DITCH` above. Last of all the human marks, and after the
  //        floor for the same reason 4g is: `softFloor` exists to stop noise and erosion
  //        digging near the datum by accident, and this cut is on purpose. Running it before
  //        the floor would have the floor partly fill it back in wherever the glacis is low.
  {
    const sec = CARTHAGE_DITCH_SECTION;
    const line = carthageDitchPath(CARTHAGE_WALL_LINE, 96);
    const gateX = CARTHAGE_WALL_LINE.gateX;
    const half = sec.width * 0.5;
    // Bounding box of the cut, with a cell of slack. The ditch is a thin band across the
    // whole frontage, so a box is a poor fit and a per-row x window is not worth the code:
    // the whole box is 2 000 x 60 m, which is 3 % of the field.
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const p of line) {
      if (p.x < bx0) bx0 = p.x;
      if (p.x > bx1) bx1 = p.x;
      if (p.z < bz0) bz0 = p.z;
      if (p.z > bz1) bz1 = p.z;
    }
    const pad = half + DITCH_RUNOUT + spacing * 2;
    const bound = (v: number): number =>
      Math.max(0, Math.min(res - 1, Math.round((v + HALF_EXTENT) / spacing)));
    const i0 = bound(bx0 - pad);
    const i1 = bound(bx1 + pad);
    const j0 = bound(bz0 - pad);
    const j1 = bound(bz1 + pad);
    const xEnd0 = line[0].x;
    const xEnd1 = line[line.length - 1].x;

    /** Perpendicular distance from a point to the ditch's centreline polyline. */
    const toCentreline = (x: number, z: number): number => {
      let best = Infinity;
      for (let k = 0; k + 1 < line.length; k++) {
        const a = line[k];
        const b = line[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp01(((x - a.x) * dx + (z - a.z) * dz) / l2) : 0;
        const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
        if (d < best) best = d;
      }
      return best;
    };

    for (let j = j0; j <= j1; j++) {
      const wz = -HALF_EXTENT + j * spacing;
      const row = j * res;
      for (let i = i0; i <= i1; i++) {
        const wx = -HALF_EXTENT + i * spacing;
        const d = toCentreline(wx, wz);
        if (d >= half) continue;
        let f = ditchV(d);
        if (f <= 0.0005) continue;
        // Run out at each end of the cut rather than ending in a transverse cliff.
        f *= sstep(xEnd0 - 1, xEnd0 + DITCH_RUNOUT, wx)
          * (1 - sstep(xEnd1 - DITCH_RUNOUT, xEnd1 + 1, wx));
        // The causeway at the Porta Byrsae, and only there.
        f *= sstep(CAUSEWAY_HALF, CAUSEWAY_HALF + CAUSEWAY_RAMP, Math.abs(wx - gateX));
        // Nobody digs a dry ditch into a lagoon margin. Belt and braces over the depth cap
        // below, because `dryLand` is the term every other cut on this map is weighted by.
        f *= clamp01(dryLand(wx, wz));
        if (f <= 0.0005) continue;
        const h = heights[row + i];
        // The bottom keeps its freeboard over the sea. See `DITCH_DRY_MARGIN`: a cut taken
        // under the datum is rendered as water by `WaterSurface`, which turns a dry ditch
        // into a moat and the wall's two anchors into a flank.
        const allowed = Math.max(0, h - (SEA_LEVEL + DITCH_DRY_MARGIN));
        heights[row + i] = h - Math.min(sec.depth, allowed) * f;
      }
    }
  }

  // ---------------------------------------------------------------------
  // 5. Control texture.
  //
  //    Same four channels as the other maps, because the shader contract is shared. On this
  //    coast at the end of April they mean:
  //      R  water: the wadi bed, the irrigation channels and the gardens they feed — which is
  //         the only reason a city of a quarter of a million people could stand here
  //      G  bedrock: calcarenite scoured bare on the two hills and on the wave-cut coast
  //      B  trodden *and soft*: the siege lines, the road, the glacis — and, at the top of
  //         the range, the sabkha margins where a wheel sinks (§3.4). One channel carries
  //         both because a beaten surface and a soft one are the same thing to the splat
  //         rules (bare, no sward) and because there is no fifth channel; `softGround` is
  //         published separately for anything that needs the mechanic rather than the look.
  //      A  evaporite and fines: the salt crust of the two pans and the shell sand of the
  //         beach, which is what the shores are painted from
  // ---------------------------------------------------------------------
  const flow = blurField(maps.flow, wres, 2);
  const rock = blurField(maps.eroded, wres, 2);
  const silt = blurField(maps.deposited, wres, 2);
  let flowMax = 1e-6;
  let rockMax = 1e-6;
  let siltMax = 1e-6;
  for (let i = 0; i < flow.length; i++) {
    if (flow[i] > flowMax) flowMax = flow[i];
    if (rock[i] > rockMax) rockMax = rock[i];
    if (silt[i] > siltMax) siltMax = silt[i];
  }

  const control = new Uint8Array(wres * wres * 4);
  for (let j = 0; j < wres; j++) {
    const wz = -HALF_EXTENT + j * wspacing;
    for (let i = 0; i < wres; i++) {
      const wx = -HALF_EXTENT + i * wspacing;
      const k = j * wres + i;
      const rx = roadCentreX(wz);
      const soft = softGround(wx, wz);

      // Water. Tighter even than Pydna's: this is the end of a North African dry season, the
      // wadi is dry, and the only reliably damp ground is the bottom of a channel someone is
      // paying to keep flowing.
      let wet = clamp01(Math.log1p((flow[k] / flowMax) * 48) / Math.log(49)) * 0.4;
      const dWadi = Math.abs(wz - wadiZ(wx));
      wet = Math.max(wet, (1 - sstep(WADI_HALF_WIDTH, 46, dWadi)) * 0.62);
      for (let r = 0; r < SEGUIAS.length; r++) {
        const d = Math.abs(seguiaDistance(r, wx, wz));
        wet = Math.max(wet, (1 - sstep(SEGUIAS[r].width * 0.5, SEGUIAS[r].width * 2.6, d)) * 0.72);
      }
      wet *= 0.6 + 0.4 * (0.5 + 0.5 * gnoise(wx * 0.0061, wz * 0.0061, seed + 91));

      // Bedrock: scoured hillside, and the wave-cut platform where the gulf has stripped the
      // dune belt back to the calcarenite under it.
      let bare = clamp01((rock[k] / rockMax) * 3.0);
      bare = Math.max(bare, uplandWeight(wx, wz)
        * sstep(0.14, 0.42, slopeOfWork(work, wres, wspacing, i, j)) * 0.9);

      // Trodden, and soft. Three years of siege lines on the isthmus is the heaviest
      // trampling on any map in this project.
      const churn =
        0.34 +
        0.44 * (0.5 + 0.5 * gnoise(wx * 0.0095, wz * 0.0095, seed + 92)) +
        0.3 * (0.5 + 0.5 * gnoise(wx * 0.04, wz * 0.04, seed + 93));
      let tramp = Math.max(romanDeployMask(wx, wz), punicDeployMask(wx, wz)) * 0.42 * churn;
      tramp = Math.max(tramp, (1 - sstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 8, Math.abs(wx - rx))) * 0.88);
      // The cleared glacis, swept and beaten by every working party in the siege.
      const glacis = 1 - sstep(20, 150, Math.abs(wz - carthageWallZ(wx)));
      tramp = Math.max(tramp, glacis * 0.6 * churn);
      // The sabkha margins occupy the top of the range, above anything trampling can reach,
      // so a consumer that wants only the soft ground can threshold this channel at 0.8.
      if (soft > 0.35) tramp = Math.max(tramp, 0.8 + 0.2 * soft);

      // Evaporite and fines: the two salt pans, the beach, the Taenia's sand and the fans at
      // the foot of the Byrsa. This is the channel that makes the map look like North Africa.
      let fines = clamp01((silt[k] / siltMax) * 3.4);
      fines = Math.max(fines, soft * 0.95);
      fines = Math.max(fines, taeniaNess(wx, wz) * 0.9);
      fines = Math.max(fines, (1 - sstep(0, 240, coastZ(wx) - wz)) * 0.85);
      fines = Math.max(fines, (1 - sstep(WADI_HALF_WIDTH * 1.5, 48, dWadi)) * 0.7);

      control[k * 4] = (clamp01(wet) * 255) | 0;
      control[k * 4 + 1] = (clamp01(bare) * 255) | 0;
      control[k * 4 + 2] = (clamp01(tramp) * 255) | 0;
      control[k * 4 + 3] = (clamp01(fines) * 255) | 0;
    }
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < minHeight) minHeight = v;
    if (v > maxHeight) maxHeight = v;
  }

  assertSurveyElevations(heights, res, spacing);
  assertHarbourWorks(heights, res, spacing);
  assertDitchCut(heights, res, spacing);

  return {
    heights,
    res,
    spacing,
    minHeight,
    maxHeight,
    control,
    controlRes: wres,
    buildMs: performance.now() - t0,
  };
}

/**
 * Grade the built field against `docs/CARTHAGE.md` §3.3 and §2.5, and say so out loud.
 *
 * **This is here because a survey that is not checked is a comment.** The whole point of §2.3
 * is that Carthage should be wrong only if the survey is wrong — and the survey reaches the
 * screen through five stages of noise, erosion, upsampling, benching and flooring, any one of
 * which can move a number by ten metres. A first pass at the Byrsa came out 16 m over its
 * published height because the hill's analytic form and its ridged relief both peak at the
 * summit and add there; nothing but a measurement would have caught that, and nothing did
 * until this ran.
 *
 * Warnings rather than throws, deliberately. A map that is 3 m out somewhere is still a map
 * the other three workstreams can build against, and a throw at module init is the failure
 * mode this project has already shipped three times.
 */
function assertSurveyElevations(heights: Float32Array, res: number, spacing: number): void {
  const at = (x: number, z: number): number => sampleBilinear(heights, res, spacing, x, z);
  /** [name, x, z, low, high] — the bounds are §3.3's, widened only by the noise amplitude. */
  const CHECKS: readonly [string, number, number, number, number][] = [
    ['Byrsa summit', BYRSA_X, BYRSA_Z, BYRSA_SUMMIT - 4, BYRSA_SUMMIT + 4],
    ['Odeon / north ridge', 210, 1037, 38, 52],
    ['lower town, W of the Byrsa', -180, 1000, 10, 20],
    ['harbour district', -600, 978, 1, 8],
    ['wall ground line, mid-span', 0, 527, 9, 16],
    // Inboard of the anchors, not at them. §3.3 gives the wall's ground line as 10–14 and
    // §2.2 says both its ends die on water; those cannot both hold at the last metre, and the
    // wall necessarily walks down to the waterline at each end. So the level is checked where
    // the wall stands on the isthmus and the *descent* is checked separately below.
    ['wall ground line, 700 m north', 700, 498, 6, 16],
    ['wall ground line, 700 m south', -700, 585, 6, 16],
    ['isthmus spine, at the siege line', 0, -196, 8, 15],
    ['Sebkhet Ariana', 1250, 300, -0.5, 2.5],
    ['Taenia crown', -1270, 200, 1.5, 7.5],
    ['open sea, beyond the coast', 400, 1330, -12, -4],
    ['head of the Lake of Tunis', -1060, 615, -12, -3],
  ];
  const bad: string[] = [];
  for (const [name, x, z, lo, hi] of CHECKS) {
    const h = at(x, z);
    if (!(h >= lo && h <= hi)) bad.push(`${name} ${h.toFixed(1)} m (want ${lo}..${hi})`);
  }
  if (bad.length) {
    console.warn(`[carthage] ${bad.length} survey elevation(s) off docs/CARTHAGE.md §3.3: ${bad.join('; ')}`);
  }

  /**
   * And the one thing §5.1a exists to prevent: a Byrsa you cannot walk up.
   *
   * The approach face runs in +x from the forum flat at x −290 to the summit at x 0
   * (§5.3), and it has to take three stepped streets and terraced housing. The spec's
   * override targets 1:3.8. Anything past 1:2.5 is a cliff and the fabric workstream will
   * discover it as unbuildable geometry rather than as a number.
   */
  /**
   * Both ends of the land wall must die on water (§2.2) — there is no flank march on this
   * map, and that claim is a *terrain* claim before it is a wall claim. If either anchor
   * stands on dry ground the whole tactical shape of the map changes and nothing else would
   * report it.
   */
  for (const [name, x, z] of [
    ['north anchor, Sebkhet Ariana', WALL_X_MAX + 130, carthageWallZ(WALL_X_MAX + 130)],
    ['south anchor, Lake of Tunis', WALL_X_MIN - 90, carthageWallZ(WALL_X_MIN - 90)],
  ] as const) {
    const h = at(x, z);
    if (h > 2.5) {
      console.warn(
        `[carthage] the wall's ${name} stands on ${h.toFixed(1)} m of dry ground — §2.2 says ` +
          'both ends die on water and the map has no flank march because of it'
      );
    }
  }

  const faceRun = 170;
  const rise = at(BYRSA_X, BYRSA_Z) - at(BYRSA_X - faceRun, BYRSA_Z);
  const grad = rise / faceRun;
  if (grad > 0.4) {
    console.warn(
      `[carthage] the Byrsa's approach face is 1:${(1 / grad).toFixed(1)} — §5.1a overrides the ` +
        'projection precisely so it is not a cliff; three stepped streets cannot climb this'
    );
  }
}

/**
 * Did the harbours actually get dug, and does the quay clear its own water?
 *
 * **The figure that shamed this file into existing was prose.** `docs/ARCHITECTURE.md` carried
 * "51 % of the cothon's water area and 84 % of the merchant basin's stand under terrain that is
 * above their surface" as a sentence in a report, computed once by hand; nothing in the tree
 * could recompute it, so nothing could watch it move or catch it coming back. It is an
 * instrument now, it runs on every build of the field, and it prints its numbers whether they
 * are good or bad — an honest 84 % is worth more than a check that only speaks when it likes
 * the answer.
 *
 * The basins' plans and their datum come from `harbour.ts`, not from a copy of them, so this
 * grades the terrain against the masonry that will actually stand in it.
 */
function assertHarbourWorks(heights: Float32Array, res: number, spacing: number): void {
  const at = (x: number, z: number): number => sampleBilinear(heights, res, spacing, x, z);
  const mh = MERCHANT_HARBOUR;

  /** Fraction of a basin's water plan whose bed stands above the water, and the bed's depth. */
  const survey = (
    inside: (x: number, z: number) => boolean, x0: number, x1: number, z0: number, z1: number,
  ): { pct: number; ha: number; median: number } => {
    const beds: number[] = [];
    let buried = 0;
    for (let z = z0; z <= z1; z += 2) {
      for (let x = x0; x <= x1; x += 2) {
        if (!inside(x, z)) continue;
        const h = at(x, z);
        beds.push(h);
        if (h > BASIN_WATER_Y) buried++;
      }
    }
    beds.sort((a, b) => a - b);
    return {
      pct: (buried / Math.max(1, beds.length)) * 100,
      ha: (beds.length * 4) / 1e4,
      median: beds.length ? beds[beds.length >> 1] : 0,
    };
  };

  const R = COTHON.outerR;
  const cothon = survey((x, z) => {
    const r = Math.hypot(x - COTHON.x, z - COTHON.z);
    return r <= R && r >= COTHON.islandR;
  }, COTHON.x - R, COTHON.x + R, COTHON.z - R, COTHON.z + R);
  const merchant = survey(() => true, mh.x - mh.hw, mh.x + mh.hw, mh.z - mh.hd, mh.z + mh.hd);

  // The freeboards, sampled exactly where `harbour.ts` samples them, so the two cannot differ.
  const cothonFree = at(COTHON.x, COTHON.z) - BASIN_WATER_Y;
  const merchantFree = at(mh.x, mh.z) - BASIN_WATER_Y;

  /**
   * The steepest gradient the pathfinder will meet on the ring quay, over its own 7 m cell.
   *
   * The made ground has to be flat where men fight along it and a cliff where it meets the
   * gulf, and those two are 20 m apart. This measures the first. **Three exclusions, and each
   * of them is a slope that has to be there:** the outer face of the mole is deliberate and is
   * not quay; the two channels cut clean through the ring, so their banks grade at 0.96 and
   * are not a defect either; and the first 3.5 m inboard of `outerR` is inside the 7 m stencil
   * the pathfinder straddles the basin's own revetment with, so it reads the drop into the
   * water and refuses the cell — correctly, since the cell *is* the lip of a 5 m wall. That
   * costs the 20 m quay its innermost 3.5 m and leaves 15.5 m of colonnade a cohort walks.
   * Anything steep on what is left is 1 km of fighting ground nobody can use.
   */
  let quaySlope = 0;
  let quayAt = 'nothing steep';
  for (let a = 0; a < 360; a += 2) {
    const th = (a * Math.PI) / 180;
    for (let r = R + 5; r <= R + COTHON_QUAY - 1; r += 1.5) {
      const x = COTHON.x + Math.cos(th) * r;
      const z = COTHON.z + Math.sin(th) * r;
      if (channelNess(x, z) < 1.6) continue;
      const g = Math.hypot(
        (at(x + 3.5, z) - at(x - 3.5, z)) / 7,
        (at(x, z + 3.5) - at(x, z - 3.5)) / 7,
      );
      if (g > quaySlope) { quaySlope = g; quayAt = `(${x.toFixed(0)}, ${z.toFixed(0)})`; }
    }
  }

  console.info(
    `[carthage] harbours: cothon ${cothon.pct.toFixed(1)}% of ${cothon.ha.toFixed(1)} ha buried, `
      + `bed ${cothon.median.toFixed(2)} m, freeboard ${cothonFree.toFixed(2)} m; `
      + `merchant ${merchant.pct.toFixed(1)}% of ${merchant.ha.toFixed(1)} ha buried, `
      + `bed ${merchant.median.toFixed(2)} m, freeboard ${merchantFree.toFixed(2)} m; `
      + `want 0% buried, a ${BASIN_BED.toFixed(2)} m bed and ${FREEBOARD} m of freeboard. `
      + `Ring-quay slope worst ${quaySlope.toFixed(2)} at ${quayAt} (impassable past 0.62).`
  );

  const bad: string[] = [];
  // 1.2 %, not 0: `BASIN_EDGE` is one cell of ramp at the foot of each revetment and the field
  // is reconstructed bilinearly, so a perfect zero is not a number this instrument can return.
  // The allowance is a *measured* one — 0.5 m of ledge round a 1,414 m perimeter.
  if (cothon.pct > 1.2) bad.push(`${cothon.pct.toFixed(1)}% of the cothon's water is buried`);
  if (cothonFree < FREEBOARD) {
    bad.push(`the cothon's quay clears its water by ${cothonFree.toFixed(2)} m, under §6.2's ${FREEBOARD}`);
  }
  if (quaySlope > 0.62) {
    bad.push(`the ring quay reaches gradient ${quaySlope.toFixed(2)} at ${quayAt}, which the pathfinder refuses`);
  }
  if (CUT_MERCHANT_BASIN && merchant.pct > 1) {
    bad.push(`${merchant.pct.toFixed(1)}% of the merchant basin's water is buried`);
  }
  if (bad.length) {
    console.warn(`[carthage] harbour works off docs/CARTHAGE.md §6.2/§3.3: ${bad.join('; ')}`);
  }
}

/**
 * Was the ditch actually cut, how deep is it, and can an army still cross it?
 *
 * Three questions, because the ditch has three ways to be wrong and only the first is the
 * one it was reported for:
 *
 *  1. **Absent.** The state this stage was written to end. The instrument reports the
 *     achieved relief station by station, from the crest at the wall's face to the deepest
 *     ground within the profile's own width, so "cut" is a number and not a claim.
 *  2. **Flooded.** A dry ditch whose bottom falls below `SEA_LEVEL` is rendered as water by
 *     `WaterSurface` and is a moat. The depth cap prevents it; this checks the cap held.
 *  3. **Impassable.** The V's own sides run at gradient 0.667, over `SLOPE_IMPASSABLE`, and
 *     if the nav grid could see them at that angle the ditch would be a wall no assault
 *     could cross — the defence would work by deleting the battle. It cannot, because
 *     `Pathfinding.CELL` is 7 m and its gradient is central-differenced over 14, which is
 *     wider than the 9 m slope. **That is a prediction, so it is measured**: this walks the
 *     profile with the pathfinder's own 14 m stencil on the pathfinder's own 7 m lattice and
 *     reports the worst gradient the grid can actually read.
 *
 * The numbers print whether they are good or bad, in the same spirit as `assertHarbourWorks`.
 */
function assertDitchCut(heights: Float32Array, res: number, spacing: number): void {
  const at = (x: number, z: number): number => sampleBilinear(heights, res, spacing, x, z);
  const sec = CARTHAGE_DITCH_SECTION;
  const line = carthageDitchPath(CARTHAGE_WALL_LINE, 96);
  const gateX = CARTHAGE_WALL_LINE.gateX;

  /** Fieldward unit normal of the wall at x — the direction a transect runs. */
  const normalAt = (x: number): { nx: number; nz: number } => {
    const dz = (carthageWallZ(x + 1) - carthageWallZ(x - 1)) * 0.5;
    const len = Math.hypot(1, dz);
    return { nx: dz / len, nz: -1 / len };
  };

  let worstShortfall = 0;
  let shortfallAt = 0;
  let deepestBed = Infinity;
  let drowned = 0;
  let cut = 0;
  const reliefs: number[] = [];
  // Skip the two run-outs and the causeway: all three are deliberately not full depth and
  // grading them against 6 m would be grading the design against itself.
  for (const p of line) {
    if (Math.abs(p.x - gateX) < CAUSEWAY_HALF + CAUSEWAY_RAMP) continue;
    if (p.x < line[0].x + DITCH_RUNOUT || p.x > line[line.length - 1].x - DITCH_RUNOUT) continue;
    const n = normalAt(p.x);
    const cz = carthageWallZ(p.x);
    const crest = at(p.x + n.nx * 2, cz + n.nz * 2);
    const bed = at(p.x, p.z);
    const relief = crest - bed;
    reliefs.push(relief);
    if (relief > 0.5) cut++;
    if (bed < deepestBed) deepestBed = bed;
    if (bed < SEA_LEVEL) drowned++;
    // Shortfall against 6 m is only a fault where the ground had 6 m of freeboard to give.
    const affordable = Math.min(sec.depth, Math.max(0, crest - (SEA_LEVEL + DITCH_DRY_MARGIN)));
    if (affordable - relief > worstShortfall) {
      worstShortfall = affordable - relief;
      shortfallAt = p.x;
    }
  }
  reliefs.sort((a, b) => a - b);
  const median = reliefs.length ? reliefs[reliefs.length >> 1] : 0;

  /**
   * The worst gradient the nav grid can read across the profile, measured its way.
   *
   * `Pathfinding` samples on a 7 m lattice anchored at the field's own origin and takes a
   * central difference over two cells. The lattice phase relative to a 20 m trench matters,
   * so this sweeps every station rather than trusting one.
   */
  const CELL = 7;
  let worstGrad = 0;
  let gradAt = '';
  for (const p of line) {
    const n = normalAt(p.x);
    const cz = carthageWallZ(p.x);
    for (let d = -CELL; d <= sec.offset + sec.width; d += 1) {
      // Snap to the nav lattice so the stencil straddles the same cells the pathfinder uses.
      const x = Math.round((p.x + n.nx * d) / CELL) * CELL;
      const z = Math.round((cz + n.nz * d) / CELL) * CELL;
      const g = Math.hypot(
        (at(x + CELL, z) - at(x - CELL, z)) / (CELL * 2),
        (at(x, z + CELL) - at(x, z - CELL)) / (CELL * 2),
      );
      if (g > worstGrad) {
        worstGrad = g;
        gradAt = `(${x.toFixed(0)}, ${z.toFixed(0)})`;
      }
    }
  }

  // The causeway has to be a road and not a saddle nobody can use.
  const gn = normalAt(gateX);
  const gz = carthageWallZ(gateX);
  const causewayBed = at(gateX + gn.nx * sec.offset, gz + gn.nz * sec.offset);
  const causewayCrest = at(gateX + gn.nx * 2, gz + gn.nz * 2);

  console.info(
    `[carthage] ditch: ${cut}/${reliefs.length} stations cut, relief median ${median.toFixed(2)} m ` +
      `(spec ${sec.depth} x ${sec.width} m), deepest bed ${deepestBed.toFixed(2)} m, ` +
      `${drowned} station(s) under the datum. Worst shortfall ${worstShortfall.toFixed(2)} m at ` +
      `x ${shortfallAt.toFixed(0)}. Causeway at the Porta Byrsae falls ` +
      `${(causewayCrest - causewayBed).toFixed(2)} m. Worst nav gradient ${worstGrad.toFixed(2)} ` +
      `at ${gradAt} (impassable past 0.62).`,
  );

  const bad: string[] = [];
  if (cut < reliefs.length) bad.push(`${reliefs.length - cut} station(s) have no cut at all`);
  if (median < sec.depth - 0.6) {
    bad.push(`the median relief is ${median.toFixed(2)} m against §4.2's ${sec.depth}`);
  }
  if (drowned > 0) bad.push(`${drowned} station(s) of a *dry* ditch stand under the sea`);
  if (worstGrad > 0.62) {
    bad.push(
      `the nav grid reads gradient ${worstGrad.toFixed(2)} at ${gradAt}, so no formed unit can ` +
        'cross the ditch and the assault has been deleted rather than slowed',
    );
  }
  if (causewayCrest - causewayBed > 1.0) {
    bad.push(`the Porta Byrsae's causeway dips ${(causewayCrest - causewayBed).toFixed(2)} m`);
  }
  if (bad.length) {
    console.warn(`[carthage] ditch off docs/CARTHAGE.md §4.2: ${bad.join('; ')}`);
  }
}

/** Slope of the working grid at a cell, 0 flat .. 1 vertical. Central difference, clamped. */
function slopeOfWork(
  work: Float32Array, wres: number, wspacing: number, i: number, j: number,
): number {
  const im = i > 0 ? i - 1 : 0;
  const ip = i < wres - 1 ? i + 1 : wres - 1;
  const jm = j > 0 ? j - 1 : 0;
  const jp = j < wres - 1 ? j + 1 : wres - 1;
  const gx = (work[j * wres + ip] - work[j * wres + im]) / ((ip - im) * wspacing);
  const gz = (work[jp * wres + i] - work[jm * wres + i]) / ((jp - jm) * wspacing);
  const m = Math.hypot(gx, gz);
  return m > 1 ? 1 : m;
}

/** In-place box smoothing of a 1-D profile, used to grade the road and the wall bench. */
function smooth1D(a: Float32Array, radius: number): void {
  const n = a.length;
  const tmp = new Float32Array(n);
  const w = radius * 2 + 1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = i + k;
      s += a[x < 0 ? 0 : x >= n ? n - 1 : x];
    }
    tmp[i] = s / w;
  }
  a.set(tmp);
}
