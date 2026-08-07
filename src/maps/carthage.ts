import { CARTHAGE_AERIAL_MEAN, CARTHAGE_LAYERS, CARTHAGE_SPLAT_GLSL } from './carthage/ground';
import { buildCarthageTerrain } from './carthage/heightfield';
import { CARTHAGE_SCATTER } from './carthage/scatter';
import { CARTHAGE_TOPO_GLSL, SEA_LEVEL } from './carthage/topography';
import type { MapDefinition } from './types';

/**
 * Carthage, the summer of 147 BC — the isthmus, the land walls and the Byrsa behind them.
 *
 * ## Why this battle
 *
 * Because it is the *other* siege, and the project only had one.
 *
 * Everything the siege machinery does — wall traversal, escalade, a ram at a gate, a garrison
 * on a parapet, artillery shooting at a battlement — was built against Rome and is graded on
 * Rome. That is one sample. A second besiegeable city is the only way to find out which of it
 * is siege mechanics and which of it is the Aurelian Wall's particular geometry, and the
 * finding is already paying: standing this map up is what turned `hidesCity: boolean` into
 * `city: CityPlan | null` and what showed that `CitySystem` contains almost no Rome.
 *
 * It is also unlike both existing maps in every axis the rubric grades. Red soil and salt pan
 * against the Campus Martius' green pasture and Pydna's straw; a 62 m citadel hill behind the
 * curtain against a flat plain and a distant mountain front; a triple wall thirteen and a half
 * metres high against an unfinished one; the highest ground albedo and the highest turbidity
 * in the table; a 21.9 deg sun at 36.85 deg north in August against a 26 deg one at 40.35 in
 * June and a 34 deg one at 41.9 in November.
 *
 * ## The frame
 *
 * **The isthmus, looking north-east up the peninsula at the land walls.** Appian gives the
 * isthmus as twenty-five stades — about 4.6 km — with a triple wall across it. The playable
 * field is 2.8 km, so the sea is off the edge on both flanks, which is not a dodge: from
 * Scipio's siege line you could not see both shores at once either. What the field does carry
 * is the *approach* to both — the ground falls to a little over the datum at each x edge, the
 * Lake of Tunis' salt pan on the left and the Gulf's shell beach on the right, and the
 * clipmap's `farHeight` carries the horizon out flat at 2 m from there. That is a peninsula
 * from any camera on the map.
 *
 * ## Why 147 and not 146
 *
 * The city fell in the spring of 146 after six days of street fighting, which is the famous
 * date. It is the wrong one for this map twice over: a spring North African coast is *green*,
 * which would throw away the parched red-and-white palette that makes this map a different
 * place, and the final assault was fought from the harbour inward through streets, which is
 * not a field this engine can stage.
 *
 * The summer of 147 is Scipio's, and it is a wall battle: he closed the blockade, threw the
 * mole across the harbour mouth, and stormed the Megara — the great walled suburb of orchards
 * behind the land wall — in a night attack Appian describes at length. The obstacle that
 * nearly stopped him was not the garrison, it was the gardens: hedges, ditches and irrigation
 * channels that broke his columns up in the dark. That is a besieged city with a real
 * landscape behind its curtain, and it is what this map is built to be.
 *
 * ## The light
 *
 * Latitude 36.85 N, declination +17 (early August). Default hour 17:00, which puts the sun at
 * **elevation 21.9 deg, bearing 275.3 deg** — a shade north of due west, and therefore about
 * 85 deg off the axis of a camera looking up the isthmus at the wall.
 *
 * Broadside, and lower than either other map. That is the whole lighting design in two
 * numbers. The clipmap does not cast shadows, so N.L is the only cue the relief has, and at
 * 21.9 deg a 1.75 m man throws a 4.4 m shadow, a 0.5 m irrigation channel throws a metre of
 * shadow line clean across the frame, and the Byrsa's south-western face — the one turned to
 * the besieger — is lit while its shoulder is not. At noon on this latitude in August the sun
 * reaches 70 deg and the whole map goes flat; the hour is doing real work.
 */
export const CARTHAGE: MapDefinition = {
  id: 'carthage',
  label: 'Carthage',
  subtitle: 'The Siege of Carthage &middot; 147 BC',
  blurb:
    'The isthmus under the land walls, between the salt flats of the lake and the gulf. ' +
    'Red earth, burnt stubble and irrigated gardens, with the Byrsa citadel rising behind ' +
    'the curtain. Low August sun.',
  site: {
    latitudeDeg: 36.85,
    // Early August: the fourth summer of the siege and Scipio's first as commander. +17 deg
    // is the declination in the first week of the month, and at this latitude it puts the
    // sun 70 deg up at noon — which is why the default hour is 17:00 and not midday.
    declinationDeg: 17,
    season: 'high summer, 147 BC',
  },
  sky: {
    // 17:00. Elevation 21.9 deg, bearing 275.3 deg. Lower than Pydna's 26.0 and far lower
    // than the Campus Martius' November noon, and broadside to the viewing axis in the same
    // way Pydna's is — which on a map whose terrain casts no shadows is the only source of
    // relief there is.
    defaultHour: 17,
    dayCycle: ['carthageMorning', 'carthageNoon', 'carthageAfternoon', 'carthageEvening'],
    // Bounce off red soil, salt crust and shell sand: warmer than Pydna's bleached straw and
    // much paler than the Campus Martius' damp plain. This is the ground colour that comes
    // back up into the hemisphere fill, so it wants to be the map's mean and not its
    // dominant hue.
    groundBounce: 0x9a8564,
  },
  terrain: {
    seedLabel: 'carthage-147bc',
    waterLevel: SEA_LEVEL,
    /**
     * 2.0 m: sea level, or as near as makes no difference.
     *
     * `farHeight` is where the clipmap drifts outside +/-HALF_EXTENT, in *every* direction,
     * and on a peninsula that is right in three of the four. The lagoon is off the left edge,
     * the gulf off the right, and the isthmus runs on to the mainland plain behind. Only the
     * fourth — past the Byrsa, up the peninsula toward Cape Gammarth — is high ground, and
     * the drift there ramps over 900 m into a fall to the sea, which is also what is actually
     * there. So the horizon on all four sides is a pale flat sheet at the water, and that is
     * the single cheapest thing on this map that says "peninsula".
     */
    farHeight: 2.0,
    build: (seedLabel) => buildCarthageTerrain(seedLabel),
    layers: CARTHAGE_LAYERS,
    splatGlsl: CARTHAGE_SPLAT_GLSL,
    splatCacheKey: 'carthage',
    aerialMean: CARTHAGE_AERIAL_MEAN,
    // 0.18, close to Pydna's 0.16 and far below the Campus Martius' 0.62. That map has a 94 m
    // rectilinear survey lattice to converge away; this one has organic land use and two
    // shorelines that must stay legible from altitude, and the splat rules already exempt the
    // salt pan and the beach from the aerial term for exactly that reason.
    aerialStrength: 0.18,
    // No open water surface. `RiverWater` is a ribbon built along the Tiber's centreline and
    // generalising it is a `src/terrain/` change; more to the point, neither shore is inside
    // the field. See `carthage/topography.ts`.
    hasRiver: false,
    roadGlsl: `${CARTHAGE_TOPO_GLSL}\nfloat grassRoadCentreX(float z) { return carRoadCentreX(z); }`,
    /**
     * Short, thin and the driest of the three maps.
     *
     * This is grazed and reaped ground at the end of an African dry season, not Pydna's
     * ungrazed mat that seeded and went over. Height 0.8 and dryness 0.85 follow from that.
     *
     * Density is the number to watch. Pydna's first pass ran 0.88 and the sward read as
     * isolated tufts on bare earth — thinness, not colour, is what makes ground look like a
     * tech demo — so it was raised to 1.18. 1.02 here is deliberately *not* as low as that
     * failed pass: the stubble is meant to be short and pale, not sparse. If a frame comes
     * back reading as tufts on soil, raise this before touching the albedos.
     */
    grass: { heightScale: 0.8, densityScale: 1.02, dryness: 0.85 },
    scatter: CARTHAGE_SCATTER,
  },
  /**
   * No city on it yet, so no city of anyone else's either.
   *
   * The map ships as open ground first and deliberately: it gives the wall and fabric
   * workstreams a real heightfield to build against a commit earlier than they would
   * otherwise have had one. Everything the curtain needs is already here — the wall line is
   * published by `carthage/topography.ts:carthageWallZ`, the terrain has graded a bench under
   * it, and the scatter clears its glacis — so the masonry drops onto a heightfield that is
   * expecting it.
   *
   * **This field is on its way out.** `src/city/cityPlan.ts` records the decision:
   * `hidesCity: boolean` becomes `city: CityPlan | null`, because a flag you must remember to
   * set is what put Rome's wall across the plain of Pydna, blocking movement on a map where
   * it was nowhere on screen. When that lands this becomes `city: CARTHAGE_PLAN`.
   */
  hidesCity: true,
};
