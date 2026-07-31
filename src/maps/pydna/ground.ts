import type { GroundLayerSpec } from '../../terrain/groundTextures';
import { PYDNA_TOPO_GLSL } from './topography';

/**
 * The ground of the Pierian plain on the summer solstice.
 *
 * Two things separate this palette from the Campus Martius one, and both are the point of
 * building a second map rather than re-skinning the first:
 *
 *  1. **The dominant state is inverted.** On the Tiber flood plain in November the ground
 *     state is green pasture and burnt-off straw is the exception. Here it is the other way
 *     round: 22 June in Pieria is the height of the summer drought, the plain is bleached
 *     straw, and green survives only in the bottoms of the runnels and along the braid.
 *     That single inversion changes the whole colour of the map.
 *  2. **There is no survey grid.** The Campus Martius is centuriated — a 94 m rectilinear
 *     lattice of arable strips — and from a strategic camera that reads as hard-edged
 *     painted rectangles, which is the most visible weakness in the frames it produces.
 *     Macedonian hill agriculture followed the contour: groves in soft irregular blocks,
 *     terraces cut along the slope. Nothing here is rectangular, and the map gets a
 *     coherent aerial read for free rather than having to converge one away with distance.
 *
 * Albedos are authored, not photographed: `recolourLayer` divides out each source plate's
 * own mean and substitutes these, so the palette is decided here and only here. Linear
 * luminance runs 0.09 (terra rossa) to 0.31 (Pierian limestone) — a wider spread than the
 * Rome set, because a karst landscape genuinely does put pale rock against dark red soil,
 * and criterion G2b wants that range present in the frame.
 *
 * **These are a fifth darker than the first pass, which was measured wrong.** That pass put
 * the dominant grass at 0.31 linear and the whole plain rendered at a median display
 * luminance of 0.72 against the Rome II Pydna frame's 0.31 — over two stops hot, with the
 * 5th-to-95th percentile spanning only 0.21 against the reference's 0.58. Bright ground
 * under a strong sun does not read as bright, it reads as blown.
 */
export const PYDNA_LAYERS: readonly GroundLayerSpec[] = [
  // 0. The ground state of the whole plain. Brighter and yellower than the Rome set's dry
  //    grass (linear luminance 0.31 against 0.26): this is not last year's thatch showing
  //    through a sward, it is a standing crop of grass that went over in May.
  {
    name: 'sun-burnt grass', kind: 'dryGrass', manifestId: 'dry-grass',
    farScale: 4.6, detailScale: 1.24, detailMix: 0.5, roughness: 0.95,
    albedo: [150, 132, 82], contrast: 1.36, chroma: 0.58, heightBias: 0.0,
  },
  // 1. What is left of the pasture: the runnel bottoms and the braid margin. A deeper,
  //    bluer green than the Rome meadow, because the grass that survives a Mediterranean
  //    summer is the coarse rush and sedge of a damp bottom, not upland turf.
  {
    name: 'summer pasture', kind: 'meadowGrass', manifestId: 'meadow-grass',
    // Muted to a khaki olive from [92,116,54]/chroma 0.62. Where green does survive a
    // Pierian June it is coarse sedge going over, not spring turf, and a saturated green
    // here is what made the plain read as camouflage even after its *area* was cut — a
    // minority state that loud is still the thing the eye finds first.
    farScale: 3.7, detailScale: 1.02, detailMix: 0.5, roughness: 0.9,
    albedo: [100, 110, 66], contrast: 1.42, chroma: 0.44, heightBias: 0.03,
  },
  // 2. The plain's own soil where the grass has been walked off it. Warm buff, sun-bleached
  //    — a stop lighter than the Rome path's trampled dirt, which is a wetter red-brown.
  {
    name: 'dry earth', kind: 'compactedEarth', manifestId: null,
    farScale: 4.4, detailScale: 1.26, detailMix: 0.45, roughness: 0.95,
    albedo: [134, 106, 74], contrast: 1.3, chroma: 0.48, heightBias: 0.06,
  },
  // 3. Terra rossa: the red residual clay of Mediterranean karst, which is what the olive
  //    terraces are cut into and what the plough turns up on the lower slope. The darkest
  //    and most saturated thing on the map, and the counterweight to the limestone.
  {
    name: 'terra rossa', kind: 'mud', manifestId: 'mud',
    farScale: 3.0, detailScale: 0.86, detailMix: 0.45, roughness: 0.88,
    albedo: [118, 72, 50], contrast: 1.24, chroma: 0.55, heightBias: 0.05,
  },
  // 4. The braid: pale water-worn shingle, cool against everything around it. Small tile —
  //    these are fist-sized cobbles and the camera gets down among them in the melee.
  {
    name: 'shingle', kind: 'gravel', manifestId: 'dirt-gravel',
    farScale: 2.2, detailScale: 0.6, detailMix: 0.5, roughness: 0.94,
    albedo: [144, 138, 124], contrast: 1.5, chroma: 0.55, heightBias: 0.14,
  },
  // 5. Pierian limestone. Deliberately the brightest material on the field: bare karst on a
  //    Greek hillside really is near-white in full sun, and it is the only thing on this map
  //    that can carry a genuine highlight without the sun disc being in frame.
  {
    name: 'limestone', kind: 'limestone', manifestId: null,
    farScale: 6.4, detailScale: 1.8, detailMix: 0.4, roughness: 0.82,
    albedo: [156, 152, 138], contrast: 1.4, chroma: 0.38, heightBias: 0.24,
  },
  // 6. Mountain scree. Cooler and two stops darker than the limestone it broke off, because
  //    a talus slope is shadowed between every block and reads grey rather than white.
  {
    name: 'scree', kind: 'sand', manifestId: 'sand',
    farScale: 2.9, detailScale: 0.8, detailMix: 0.45, roughness: 0.93,
    albedo: [120, 115, 104], contrast: 1.32, chroma: 0.4, heightBias: 0.1,
  },
  // 7. The coast road. Macedonia in 168 BC had no paved highway — the Via Egnatia was
  //    twenty years off — so this is packed earth polished by cart wheels, not basalt.
  {
    name: 'worn track', kind: 'compactedEarth', manifestId: null,
    farScale: 2.6, detailScale: 0.74, detailMix: 0.35, roughness: 0.86,
    albedo: [140, 124, 98], contrast: 1.36, chroma: 0.36, heightBias: 0.3,
  },
];

/**
 * Area-weighted mean linear colour of the above, at the coverage the rules below actually
 * produce (roughly 50 % burnt grass, 18 % pasture, 14 % dry earth, 8 % shingle, 6 %
 * limestone, 4 % terra rossa). Distant ground converges on it — see the aerial term.
 */
export const PYDNA_AERIAL_MEAN: readonly [number, number, number] = [0.326, 0.266, 0.12];

/**
 * The splat rule set.
 *
 * Contract with `TerrainMaterial.ts`: everything below runs after the shared preamble has
 * established `wp`, `tGeoN`, `tSlope`, `tCurv`, `tAbove`, the four control channels
 * (`cWet` `cBare` `cTramp` `cSilt`), the three macro bands (`macroFar` `macroMid` `nzSmall`
 * `nzBig`), `grassKill`, `hollow`, `nose` and `camDist`. It must declare and fill
 * `float w[8]` and `float aerial`.
 */
export const PYDNA_SPLAT_GLSL = /* glsl */ `
${PYDNA_TOPO_GLSL}

void tcMapSplat(
  vec3 wp, vec3 tGeoN, float tSlope, float tCurv, float tAbove,
  float cWet, float cBare, float cTramp, float cSilt,
  vec4 macroMid, float nzSmall, float nzBig,
  float grassKill, float hollow, float nose, float camDist,
  out float w[8], out float aerial
) {
  // --- The coast road ------------------------------------------------------
  // Edge broken up along its length by the fine macro band: after a century of carts the
  // margin of an unmetalled road is ragged, and a mathematically straight one looks printed.
  float roadD = abs(wp.x - pydRoadCentreX(wp.z));
  float rut = PYD_ROAD_HALF + 0.5 * (nzSmall - 0.5) * 2.0;
  float track = 1.0 - smoothstep(rut, rut + 1.3, roadD);
  float verge = 1.0 - smoothstep(PYD_ROAD_HALF + 0.8, PYD_ROAD_HALF + 7.5, roadD);

  // --- The Leucus, dry on the solstice -------------------------------------
  // Two bands: the shingle braid itself, and the wash of fines either side of it that
  // floods once or twice a winter and carries nothing but a crust of silt in June.
  float leucusD = abs(wp.z - pydLeucusZ(wp.x));
  float braid = 1.0 - smoothstep(PYD_LEUCUS_HALF * 0.7, PYD_LEUCUS_HALF * 2.3, leucusD);
  float wash = 1.0 - smoothstep(PYD_LEUCUS_HALF * 2.0, 60.0, leucusD);

  // --- Worked land ---------------------------------------------------------
  // Olive groves in soft irregular blocks, and terraces cut along the contour of the
  // Pierian slope. There is no lattice anywhere on this map, which is the whole reason its
  // aerial view holds together where the Campus Martius' patchwork has to be converged away.
  //
  // pydGroveField is the same closed form the vegetation scatter plants from, so the swept
  // earth below is under the actual trees. The macro band only softens the boundary by a
  // few metres — it must not move it, or the two disagree.
  float grove = smoothstep(0.58, 0.76, pydGroveField(wp.xz) + (macroMid.a - 0.5) * 0.09);
  // The terraced belt. Its bounds are thresholds on x, which — taken literally — draws the
  // edge of the olive terraces as a perfectly straight north-south meridian 2.8 km long, and
  // a straight line that long across a landscape is unmistakably machine-drawn. It showed in
  // the frames as a hard diagonal with a squared corner where it met the grove sweep. The
  // belt edge now wanders +-90 m on the macro bands, which is the width a real cultivation
  // limit varies by as it follows the break of slope. Wobbling only the shader and not
  // PYDNA_SCATTER.tree's own terrace test is safe in a way the grove field is not: this
  // term feeds the terra rossa and limestone weights, not where a tree stands, so the two
  // disagreeing by less than a grove's width costs nothing visible.
  float terraceX = wp.x + (macroMid.a - 0.5) * 130.0 + (nzBig - 0.5) * 50.0;
  float terrace = smoothstep(-490.0, -650.0, terraceX) * (1.0 - smoothstep(-1120.0, -1310.0, terraceX));

  // --- Aridity, the master variable ----------------------------------------
  //
  // 22 June in Pieria: dry ground is the majority state and green the minority, the inverse
  // of the Campus Martius. Two earlier passes got the *distribution* wrong in opposite ways
  // and both are worth recording, because they are the two failure modes of this term.
  //
  //  1. Driving it almost entirely off the drainage channel clamped green to zero across the
  //     open plain: one flat sheet of straw, 97 % of the frame's pixels in a single hue
  //     bucket, measured.
  //  2. Fixing that by making smooth macro noise the *leading* term produced free-floating
  //     soft blobs of green on tan with no cause behind them — which is precisely the DPM
  //     camouflage read the Campus Martius shader was rewritten to escape. Noise cannot
  //     decide land use. It can only modulate it.
  //
  // So the drivers here are all structural, and the most important one is **aspect**. In the
  // northern hemisphere a north-facing slope holds moisture into the summer and a west-facing
  // one takes the full afternoon sun and burns off first. On a plain whose relief is 2-4 m
  // swells at a 130 m wavelength that paints green on one face of every swell and gold on the
  // other — which does two jobs at once: it gives the land use a reason, and it makes the
  // relief legible through *albedo* rather than only through shading. A 3 % grade moves N·L
  // by about 5 % at this sun elevation, which is nearly invisible; it moves this term by 0.4,
  // which is not.
  // +X is east, -Z is north. East-facing and north-facing hold water; west-facing bakes.
  float aspect = clamp((tGeoN.x * 0.45 - tGeoN.z * 0.9) * 9.0, -1.0, 1.0);
  float wetness = cWet * 1.5 + hollow * 0.55;
  // Noise is a modulation, and its *scale* matters as much as its weight. The 620 m band
  // (nzBig) is demoted hard: at that wavelength it paints regions the size of the swells'
  // envelope rather than of the swells, and from a strategic camera those read as free-
  // floating blotches with nothing under them. The 96 m band is close to the relief's own
  // wavelength, so it varies the colour *within* a swell, which is what real ground does.
  float drift = (nzBig - 0.5) * 0.16 + (macroMid.a - 0.5) * 0.4;
  //
  //  3. And a third failure mode, which is the one that was actually shipping. Demoting the
  //     620 m noise band was right but it was not sufficient, because it left *aspect* as the
  //     leading term — and on a plain whose relief is 2-4 m swells at a 130 m wavelength,
  //     aspect paints blobs at 130 m. The mechanism changed and the picture did not. Measured
  //     on the frames: green averaged ~0.35, which puts w[0]:w[1] near 64:36, so the plain
  //     rendered as two nearly equal-weight hues alternating at the swell wavelength. Frame
  //     hue histograms came back 20-26 % yellow-green; r2-03, r2-04 and r2-09 all carry
  //     **0 %**. Not "less green than we thought" — none.
  //
  // So green is now a genuine minority and it is driven by *water*: the runnel bottoms, the
  // braid wash and the hollows. Aspect and noise are left in at a third of their old weight,
  // enough to keep the boundary organic, not enough to decide land use.
  float green = clamp(0.02 + aspect * 0.17 + wetness * 0.92 + drift * 0.45
                    - smoothstep(0.12, 0.36, tSlope) * 0.34, 0.0, 1.0);
  green = max(green, wash * 0.5);
  // The relief still has to read from a strategic camera, and under the old rules it read
  // because aspect switched between two saturated hues. It now reads through the *bare-earth*
  // fraction instead: the west-facing crown of a swell takes the full afternoon sun and burns
  // through to soil first, so the same 2 m swell is still legible from altitude. Straw against
  // buff soil is a low-chroma contrast, which is what a dry plain actually looks like; straw
  // against saturated pasture is camouflage.
  float bake = clamp(-aspect, 0.0, 1.0);

  // --- Aerial convergence ---------------------------------------------------
  // A real aerial view resolves mixed sub-pixel ground to its mean. Weaker than the Rome
  // path needs (0.55 against 0.78) because without a survey lattice there is far less
  // variance to converge away in the first place. Track and bare rock are exempt: a worn
  // road really is a pale line from altitude and a limestone scarp really is a white one.
  // The ramp starts at 340 m, which is inside the fighting ground, and a blind critic named
  // the result exactly: "fog is a uniform sepia wash with no depth-dependent variation —
  // everything past mid-distance is the same beige". Convergence onto a single mean is the
  // right idea and it was reaching too near the camera to be depth *information*; by 600 m
  // the whole middle distance had already arrived at one colour, so there was nothing left
  // for the next kilometre to do. Pushed out to 750-2400 m, which is where a real aerial view
  // stops resolving ground detail, and paired with a weaker strength in pydna.ts.
  aerial = smoothstep(750.0, 2400.0, camDist) * (1.0 - track) * (1.0 - smoothstep(0.20, 0.46, tSlope));

  // --- Weights -------------------------------------------------------------
  // 0 burnt grass is the ground state and 1 pasture the exception — the inverse of the
  // Campus Martius, and the single change that makes this map a different colour.
  float dry = 1.0 - green;
  w[0] = (0.35 + 2.9 * dry) * (1.0 - grassKill) * (1.0 - track) * (1.0 - braid);
  w[1] = (0.20 + 3.0 * green) * (1.0 - grassKill) * (1.0 - track) * (1.0 - braid);
  // 2 dry earth: trodden ground, road margins, and the swept floor of an olive grove, which
  // is kept bare so the fruit can be netted off it. Raised from 0.6 to 1.5 on the grove
  // term — a Mediterranean grove floor is properly bare, and this is the third tone the
  // plain needs so that green and gold are not the only two things in the frame.
  w[2] = cTramp * 1.75 + verge * 1.0 + grove * 1.5 * (1.0 - terrace) + nose * 0.45
       // Sun-scorched crowns of the swells: the driest ground on the plain burns through to
       // soil by midsummer, and it is the one term that follows the relief, so it is also
       // what makes a 2 m swell legible from a strategic camera.
       //
       // **Both thresholds are keyed to where dry actually sits, and it moved.** Under the
       // old green rules dry averaged 0.65, so a ramp starting at 0.72 fired only on the
       // genuinely scorched crowns. Cutting the green mosaic pushed dry to ~0.90 across the
       // whole plain, which turned these two terms on everywhere at once and swapped one
       // failure for another: the sward came back as thin olive tufts standing on open sand.
       // Re-keyed to the new distribution, so they mean what they say again.
       + smoothstep(0.80, 1.0, dry) * nose * 2.0
       + smoothstep(0.90, 1.0, dry) * 0.5
       // The west-facing faces, which is what now carries the relief. See bake, above.
       // 0.45 and not the 0.95 this started at: at the higher weight the plain came back as
       // dark olive tufts standing on pale bare buff, which is the "isolated tufts on bare
       // earth" failure the grass density was raised to 1.18 to escape in the first place.
       // The relief still reads; the sward stays a continuous mat, which is what the
       // reference frames show.
       + bake * 0.3;
  // 3 terra rossa: the terraces, and the red clay the plough turns on the lower slope.
  // Held off the braid, where any fines are grey river silt rather than residual clay.
  w[3] = (terrace * 1.9 + smoothstep(0.22, 0.50, tSlope) * 0.85 + grove * macroMid.b * 0.5)
       * (1.0 - braid) * (1.0 - cBare * 0.5);
  // 4 shingle: the braid, the fans at the break of slope, and stones the plough turned up.
  w[4] = braid * 3.4 + cSilt * 1.6 + wash * 0.55
       + smoothstep(0.13, 0.40, tSlope) * 0.9 + verge * 0.7
       // Traffic wears the fines out of a track and leaves the stones standing; without this
       // every trodden surface on the map is a sheet of featureless buff.
       + smoothstep(0.14, 0.58, cTramp) * 1.15;
  // 5 limestone: steep faces, the noses of the spurs, and the risers of the terraces —
  // which is where a dry-stone wall of the stuff is literally what holds the bench up.
  w[5] = smoothstep(0.29, 0.56, tSlope) * 3.1 + cBare * 1.5 + nose * 0.65
       + terrace * smoothstep(0.15, 0.38, tSlope) * 1.4;
  // 6 scree: the mountain front proper, where the rock has broken down into talus.
  w[6] = cBare * smoothstep(0.16, 0.44, tSlope) * 2.5 + smoothstep(0.40, 0.66, tSlope) * 1.9;
  // 7 the road.
  w[7] = track * 7.5;
}
`;
