import type { GroundLayerSpec } from '../../terrain/groundTextures';
import { CARTHAGE_TOPO_GLSL } from './topography';

/**
 * The ground of the isthmus of Carthage at the end of a North African summer.
 *
 * Three things separate this palette from the other two maps, and each is a *material* the
 * project has never had rather than a re-tint of one it has:
 *
 *  1. **Salt.** The margin of the Lake of Tunis in August is an evaporite pan — a near-white
 *     crust, faintly violet-grey in the shade, cracked into polygons. Nothing on the Campus
 *     Martius or at Pydna is anywhere near it, and it occupies the whole left flank of every
 *     wide frame. It is also the brightest thing on any of the three maps, which matters:
 *     the blind deck's standing complaint is that our frames have no smooth region and no
 *     tonal top end.
 *  2. **Shell sand.** The gulf beach is warm cream, a stop and a half above the isthmus and
 *     completely unlike Pydna's cool grey shingle.
 *  3. **Calcarenite.** The rock of the site — the soft yellow-white marine sandstone the
 *     Byrsa is cut from and the city is built out of — is warm where Pydna's limestone is
 *     cool. The two hills and the city walls are the same stone, which is what makes a real
 *     ancient site look like it grew out of its own ground.
 *
 * Against those, the dominant surface is a parched red-brown: this is *terre rouge* country,
 * the red Mediterranean soil over calcarenite that made Cap Bon the granary Rome fought three
 * wars for. So the map's central contrast is **red earth against white salt**, where Pydna's
 * is straw against limestone and the Campus Martius' is green against tufa.
 *
 * Albedos are authored, not photographed: `recolourLayer` divides out each source plate's own
 * mean and substitutes these. Linear luminance runs 0.075 (irrigated garden soil) to 0.42
 * (salt crust) — the widest spread of the three maps, deliberately, because a coast with an
 * evaporite pan on it genuinely has that range and criterion G2b wants it in frame.
 */
export const CARTHAGE_LAYERS: readonly GroundLayerSpec[] = [
  // 0. The ground state of the isthmus: burnt-off stubble and esparto over red soil. The
  //    grass here is *sparser* than Pydna's standing straw — this is grazed and reaped
  //    ground at the end of a dry summer, not an ungrazed seeded mat — so it is authored
  //    browner and the soil beneath it shows through as a matter of course.
  {
    name: 'parched stubble', kind: 'dryGrass', manifestId: 'dry-grass',
    farScale: 4.4, detailScale: 1.18, detailMix: 0.5, roughness: 0.95,
    albedo: [143, 118, 74], contrast: 1.34, chroma: 0.6, heightBias: 0.0,
  },
  // 1. Irrigated green: the market gardens of the Megara, the bottoms of the seguias, and
  //    the strip either side of the wadi. A deep bluish green, because what stays green in
  //    an African August is under a channel and being watered, not surviving on rainfall.
  //    Deliberately a small minority of the field — see the aridity note in the splat rules.
  {
    name: 'garden green', kind: 'meadowGrass', manifestId: 'meadow-grass',
    farScale: 3.4, detailScale: 0.98, detailMix: 0.5, roughness: 0.9,
    albedo: [82, 100, 58], contrast: 1.44, chroma: 0.5, heightBias: 0.03,
  },
  // 2. Terre rouge: the red Mediterranean soil of the Tunisian coast. The workhorse of the
  //    map — every ploughed garden, every bare patch between the stubble, every scrape a
  //    working party has made. Darker and more saturated than Pydna's dry earth, and it is
  //    what gives Carthage its colour from a strategic camera.
  {
    name: 'red earth', kind: 'compactedEarth', manifestId: null,
    farScale: 4.2, detailScale: 1.2, detailMix: 0.45, roughness: 0.94,
    albedo: [124, 82, 56], contrast: 1.3, chroma: 0.56, heightBias: 0.06,
  },
  // 3. Lagoon mud: the grey-violet clay under the salt, showing wherever the crust is broken
  //    or the pan is still damp. The darkest thing on the map and the only cool dark on it —
  //    it is what stops the sabkha reading as a sheet of paper.
  {
    name: 'lagoon mud', kind: 'mud', manifestId: 'mud',
    farScale: 3.2, detailScale: 0.88, detailMix: 0.42, roughness: 0.72,
    albedo: [96, 90, 92], contrast: 1.2, chroma: 0.3, heightBias: 0.04,
  },
  // 4. Salt crust. **The brightest surface in this project.** A sabkha in full sun is
  //    genuinely near-white and it is the one place a frame here can carry a highlight
  //    without the sun disc being in it. Low roughness because a crystalline crust has a
  //    real sheen — that is what makes it read as salt rather than as chalk.
  {
    name: 'salt crust', kind: 'limestone', manifestId: null,
    farScale: 5.2, detailScale: 1.5, detailMix: 0.34, roughness: 0.64,
    albedo: [188, 184, 179], contrast: 1.46, chroma: 0.16, heightBias: 0.2,
  },
  // 5. Shell sand: the gulf beach and the dune belt behind it. Warm cream, fine-grained, and
  //    the only surface on the map with no structure at all — which is the point. Nine of
  //    ten of our graded frames measure 0.00 % of tiles with a low local Laplacian; a beach
  //    is a large smooth region with a reason to be there.
  {
    name: 'shell sand', kind: 'sand', manifestId: 'sand',
    farScale: 3.6, detailScale: 0.92, detailMix: 0.4, roughness: 0.88,
    albedo: [166, 148, 118], contrast: 1.22, chroma: 0.34, heightBias: 0.16,
  },
  // 6. Calcarenite: the rock of the Byrsa and of every wall in the city. Warm yellow-white,
  //    and softer-looking than a hard limestone because that is what it is — a marine
  //    sandstone you can cut with a saw, which is why Carthage could build 34 km of wall.
  {
    name: 'calcarenite', kind: 'limestone', manifestId: null,
    farScale: 6.0, detailScale: 1.7, detailMix: 0.42, roughness: 0.86,
    albedo: [158, 143, 112], contrast: 1.4, chroma: 0.4, heightBias: 0.24,
  },
  // 7. The road from Tunes, and the beaten ground of the siege lines. Packed red earth with
  //    the stones standing proud of it after three years of traffic — a Punic trunk road was
  //    metalled, not paved, so this is gravel bound in clay rather than basalt slab.
  {
    name: 'metalled road', kind: 'gravel', manifestId: 'dirt-gravel',
    farScale: 2.4, detailScale: 0.68, detailMix: 0.38, roughness: 0.9,
    albedo: [132, 110, 88], contrast: 1.42, chroma: 0.4, heightBias: 0.3,
  },
];

/**
 * Area-weighted mean linear colour of the above, at the coverage the rules below produce:
 * roughly 34 % stubble, 8 % garden green, 24 % red earth, 5 % lagoon mud, 9 % salt, 8 %
 * sand, 7 % calcarenite, 5 % road. Distant ground converges on it.
 *
 * Warmer and a little brighter than Pydna's [0.326, 0.266, 0.12], which is the right
 * direction: a red-soil coast with two evaporite flanks resolves to a warm pale mean from
 * altitude, where a Macedonian straw plain resolves to an olive one.
 */
export const CARTHAGE_AERIAL_MEAN: readonly [number, number, number] = [0.318, 0.239, 0.155];

/**
 * The splat rule set.
 *
 * Contract with `TerrainMaterial.ts`: everything below runs after the shared preamble has
 * established `wp`, `tGeoN`, `tSlope`, `tCurv`, `tAbove`, the four control channels
 * (`cWet` `cBare` `cTramp` `cSilt`), the macro bands (`macroMid`, `nzSmall`, `nzBig`),
 * `grassKill`, `hollow`, `nose` and `camDist`. It must declare and fill `float w[8]` and
 * `float aerial`.
 *
 * **The lesson from Pydna's three rewrites is applied here from the start:** noise cannot
 * decide land use. Every term below is driven by a structure that has a reason behind it —
 * a channel, a shore, a slope, a road, a garden block — and noise only ever softens a
 * boundary. Two earlier Pydna passes were rejected for exactly this, one for painting the
 * plain a single flat sheet and one for producing free-floating soft blobs of green on tan
 * that a blind critic correctly named as DPM camouflage.
 */
export const CARTHAGE_SPLAT_GLSL = /* glsl */ `
${CARTHAGE_TOPO_GLSL}

void tcMapSplat(
  vec3 wp, vec3 tGeoN, float tSlope, float tCurv, float tAbove,
  float cWet, float cBare, float cTramp, float cSilt,
  vec4 macroMid, float nzSmall, float nzBig,
  float grassKill, float hollow, float nose, float camDist,
  out float w[8], out float aerial
) {
  // --- The road from Tunes -------------------------------------------------
  // Edge broken up along its length by the fine macro band: after three years of a siege
  // train the margin of a metalled road is ragged, and a straight one looks printed.
  float roadD = abs(wp.x - carRoadCentreX(wp.z));
  float rut = CAR_ROAD_HALF + 0.55 * (nzSmall - 0.5) * 2.0;
  float track = 1.0 - smoothstep(rut, rut + 1.5, roadD);
  float verge = 1.0 - smoothstep(CAR_ROAD_HALF + 0.9, CAR_ROAD_HALF + 8.5, roadD);

  // --- The wadi, dry in August ---------------------------------------------
  float wadiD = abs(wp.z - carWadiZ(wp.x));
  float braid = 1.0 - smoothstep(CAR_WADI_HALF * 0.7, CAR_WADI_HALF * 2.2, wadiD);
  float wash = 1.0 - smoothstep(CAR_WADI_HALF * 2.0, 64.0, wadiD);

  // --- The two shores ------------------------------------------------------
  // These are the terms that make this map a peninsula. Both edges wander on the macro band
  // by a few tens of metres, because a shoreline that follows an analytic curve exactly is
  // the most obviously machine-drawn thing a landscape can contain — and unlike the garden
  // field these do not have to agree with the scatter to the metre, because nothing is
  // planted within 200 m of either.
  float lagoon = carLagoonNess(wp.xz + vec2((macroMid.a - 0.5) * 120.0, 0.0));
  float gulf = carGulfNess(wp.xz + vec2((macroMid.b - 0.5) * 90.0, 0.0));
  // The pan proper: the inner two thirds of the lagoon ramp, where the crust is unbroken.
  float pan = smoothstep(0.42, 0.86, lagoon);
  // The strand line: the wet-looking band right at the water, where the crust is thin and
  // the grey clay shows through. Also where the beach is darkest.
  float strand = smoothstep(0.80, 1.0, lagoon);
  float beach = smoothstep(0.46, 0.92, gulf);
  // The dune crest, which is the only part of the gulf side that is not beach: it sits at
  // the middle of the ramp, so it is a band rather than an edge.
  float dune = 4.0 * gulf * (1.0 - gulf) * smoothstep(0.15, 0.4, gulf);

  // --- Worked land ---------------------------------------------------------
  // Market gardens and orchards in irregular blocks. carGardenField is the same closed form
  // the vegetation scatter plants from, so the swept earth below is under the actual trees.
  // The macro band only softens the boundary by a few metres — it must not move it, or the
  // two disagree and the map grows olives out of stubble.
  //
  // Suppressed on both shores: nobody irrigates a salt pan, and the term would otherwise put
  // orchards on the beach.
  float dryLand = (1.0 - smoothstep(0.15, 0.55, lagoon)) * (1.0 - smoothstep(0.15, 0.55, gulf));
  float garden = smoothstep(0.56, 0.74, carGardenField(wp.xz) + (macroMid.a - 0.5) * 0.08)
               * dryLand;

  // --- The glacis ----------------------------------------------------------
  // The cleared strip outside the wall. Swept to bare earth and beaten flat: a besieged city
  // leaves nothing standing within bowshot, and after three years of working parties the
  // ground in front of the curtain is the most worn on the field. It is also a strong
  // horizontal band across the frame, which is exactly what the composition wants under a
  // wall.
  float glacis = 1.0 - smoothstep(24.0, 150.0, abs(wp.z - carWallZ(wp.x)));

  // --- Aridity -------------------------------------------------------------
  //
  // Green is a *minority* and it is driven by water someone is paying for, not by noise and
  // not by aspect. On this coast that is literally true: the isthmus is 400 mm of winter
  // rain and nothing between May and September, so the only green in August is under a
  // channel. Aspect is left in at a third of the weight it carries at Pydna — enough to keep
  // a boundary organic, not enough to decide land use.
  //
  // +X is the gulf, -Z is the mainland. A north-facing slope holds what moisture there is.
  float aspect = clamp((tGeoN.x * 0.3 - tGeoN.z * 0.95) * 8.0, -1.0, 1.0);
  float watered = cWet * 1.65 + hollow * 0.4 + garden * 0.55;
  float drift = (nzBig - 0.5) * 0.12 + (macroMid.a - 0.5) * 0.3;
  float green = clamp(0.015 + aspect * 0.1 + watered * 0.95 + drift * 0.35
                    - smoothstep(0.12, 0.34, tSlope) * 0.4, 0.0, 1.0)
              * dryLand;
  float dry = 1.0 - green;

  // --- Aerial convergence ---------------------------------------------------
  // Pushed out to 780-2500 m, following the correction made at Pydna: convergence starting
  // inside the fighting ground is not depth information, it is a milky sheet. The two shores
  // are exempt — a salt pan really is a white line from altitude and a beach really is a
  // cream one, and converging them onto the map's warm mean would erase the single feature
  // that says "peninsula" from a strategic camera.
  aerial = smoothstep(780.0, 2500.0, camDist)
         * (1.0 - track) * (1.0 - max(pan, beach))
         * (1.0 - smoothstep(0.20, 0.46, tSlope));

  // --- Weights -------------------------------------------------------------
  // 0 stubble is the ground state of the isthmus, and it is thinner here than at Pydna:
  // grazed and reaped ground shows its soil. Killed outright on both shores.
  w[0] = (0.30 + 2.35 * dry) * (1.0 - grassKill) * (1.0 - track) * (1.0 - braid) * dryLand;
  // 1 garden green: channels, wadi margin, and the irrigated blocks.
  w[1] = (0.12 + 3.0 * green) * (1.0 - grassKill) * (1.0 - track) * (1.0 - braid);
  // 2 red earth: the swept floor of a garden, the ploughed ground between blocks, trodden
  //   ground, the glacis, and the crowns of the swells where the stubble has burnt through.
  //   This is the map's dominant tone and it carries the relief — a 2.4 m swell is legible
  //   from altitude because its crown is bare soil and its flank is not.
  w[2] = (cTramp * 1.6 + verge * 0.9 + garden * 1.7 + glacis * 1.5 + nose * 0.5
       + smoothstep(0.78, 1.0, dry) * nose * 1.8
       + smoothstep(0.88, 1.0, dry) * 0.6) * dryLand;
  // 3 lagoon mud: under the salt, at the strand line, and wherever the pan is broken. Held
  //   off the beach, where any fines are shell sand rather than clay.
  w[3] = strand * 2.4 + pan * (1.0 - smoothstep(0.3, 0.7, cSilt)) * 0.8
       + braid * 0.35 * (1.0 - dryLand);
  // 4 salt crust. The one term on this map allowed to be emphatic: a sabkha is not a subtle
  //   surface and painting it timidly would waste the only large bright region in the frame.
  w[4] = pan * 5.0 + lagoon * cSilt * 1.4;
  // 5 shell sand: the beach and the dune belt, plus the fines the wadi drops where it reaches
  //   the pan.
  w[5] = beach * 4.4 + dune * 2.2 + braid * 0.9 + cSilt * lagoon * 0.5;
  // 6 calcarenite: the two hills' scoured faces and noses, and the wave-cut platform under
  //   the gulf shore where the sea has stripped the dunes back to rock.
  w[6] = smoothstep(0.26, 0.52, tSlope) * 3.0 + cBare * 1.7 + nose * 0.7
       + gulf * cBare * 1.2;
  // 7 the road and the siege lines. Traffic wears the fines out and leaves the stones
  //   standing; without the trampling term every beaten surface on the map is featureless.
  w[7] = track * 7.0 + smoothstep(0.30, 0.72, cTramp) * 1.5 * dryLand;
}
`;
