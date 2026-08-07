import { CARTHAGE_PLAN } from '../city/carthage/plan';
import { CARTHAGE_AERIAL_MEAN, CARTHAGE_LAYERS, CARTHAGE_SPLAT_GLSL } from './carthage/ground';
import { buildCarthageTerrain } from './carthage/heightfield';
import { CARTHAGE_SCATTER } from './carthage/scatter';
import { CARTHAGE_TOPO_GLSL, SEA_LEVEL } from './carthage/topography';
import type { MapDefinition } from './types';

/**
 * Carthage, spring 146 BC — the isthmus, the triple wall and the Byrsa behind it.
 *
 * Built to `docs/CARTHAGE.md`; section references below are to that document. The survey, the
 * projection and every elevation live in `carthage/topography.ts`, and the built field is
 * graded against §3.3's table at load by `assertSurveyElevations`.
 *
 * ## Why this battle
 *
 * Because it is the *other* siege, and the project only had one. Everything the siege
 * machinery does — wall traversal, escalade, a ram at a gate, a garrison on a parapet — was
 * built against Rome and is graded on Rome. That is one sample, and a second besiegeable city
 * is the only way to find out which of it is siege mechanics and which is the Aurelian Wall's
 * particular geometry. The finding is already paying: standing this map up is what turned
 * `hidesCity: boolean` into `city: CityPlan | null` and showed that `CitySystem` contains
 * almost no Rome.
 *
 * ## Why spring 146 and not any other day of a three-year siege
 *
 * Not for the narrative. **It is the only day on which both of this map's attack routes
 * exist**: the triple wall still unbreached across the isthmus, and the Romans already
 * holding the harbour quay after the winter's work on the mole. One moment, two axes —
 * §8.3 — and no other date gives both.
 *
 * ## The frame
 *
 * **Map −Z is true west, +Z true east, +X true north, −X true south** (§2.2). Rome's map has
 * −Z = north; this one is rotated 90° anticlockwise and has to be, because `scenario.ts`
 * deploys the attacker at z −190 and the only land approach to Carthage is from the west.
 * What that buys: the Gulf of Tunis is the +Z edge so the defender's back is to the sea, the
 * Lake of Tunis is −X with the Taenia running along it, the Sebkhet Ariana is +X, and **both
 * ends of the land wall die on water.** There is no flank march on this map.
 *
 * Positions come through the survey projection at `KN = 0.45` and `KE = 0.22` — the latter
 * exactly Rome's `KZ`, so the two maps compress depth identically and a player's sense of
 * distance transfers. The attacker's line at z −190 is 640 m from the ditch lip against
 * Rome's 620: the two maps read at the same tempo.
 *
 * ## What is different about the ground
 *
 * **At Rome the wall stands on a hill; at Carthage it stands on nothing** (§3.1). Aurelian's
 * curtain sits on a 22–34 m rise and an attacker climbs 175 m of slope under fire. The
 * isthmus is a flat neck and the triple wall carries all of its defence in stone, which is
 * why it is 16 m tall behind a 20 m ditch. Do not improve this by putting the wall on a
 * ridge; the flatness is the design, and the terrain's wall bench levels the footing without
 * raising it.
 *
 * The one thing the ground does decide is the siege train (§3.4). Within ~300 real metres of
 * either lagoon it is sabkha and salt marsh — `softGround` publishes the margin — so **rams,
 * towers and heavy artillery have to go up the middle of the isthmus, where the wall is
 * strongest and where the defender knows they must come.** Infantry can still work the
 * margins. Rome has nothing like it.
 *
 * ## The light
 *
 * Latitude 36.85 N, declination +14 (late April). Default hour 17:00, which puts the sun at
 * **elevation 20.2°, bearing 272.6°** — broadside to a camera looking up the isthmus at the
 * wall, and the lowest default sun of the three maps. The clipmap casts no shadows, so N·L is
 * the only cue the relief has: at 20.2° a 1.75 m man throws a 4.8 m shadow, a 0.5 m
 * irrigation channel throws a metre of shadow line clean across the frame, and the Byrsa's
 * approach face is lit while its shoulder is not. At noon here in April the sun reaches 67°
 * and the whole map goes flat; the hour is doing real work.
 *
 * **One honest departure.** `SiteAstronomy` gives `atmosphere.ts` a latitude and a
 * declination and it computes a true compass bearing — but the engine plants bearing 0 at map
 * −Z, which on this map is west. So the sun's elevation and the shape of its arc are
 * physically right and its compass direction is 90° out. Nothing in a rendered frame can
 * tell; fixing it properly needs a bearing offset on `SiteAstronomy`, which is `src/render/`.
 */
export const CARTHAGE: MapDefinition = {
  id: 'carthage',
  label: 'Carthage',
  subtitle: 'The Siege of Carthage &middot; 146 BC',
  blurb:
    'The isthmus under the triple wall, between the salt flats of the lake and the gulf. ' +
    'Red earth, ripening barley and irrigated gardens, with the Byrsa citadel rising behind ' +
    'the curtain and the sea at the defender\'s back. Low April sun.',
  site: {
    latitudeDeg: 36.85,
    // Late April: the spring the city fell, and the only moment at which both of the map's
    // attack routes exist at once. +14 deg is the declination in the last week of the month,
    // and at this latitude it puts the sun 67 deg up at noon — which is why the default hour
    // is 17:00 and not midday.
    declinationDeg: 14,
    season: 'late April, 146 BC',
  },
  sky: {
    // 17:00. Elevation 20.2 deg, bearing 272.6 deg — the lowest default sun of the three
    // maps, and broadside to the viewing axis in the same way Pydna's is, which on a map
    // whose terrain casts no shadows is the only source of relief there is.
    defaultHour: 17,
    dayCycle: ['carthageMorning', 'carthageNoon', 'carthageAfternoon', 'carthageEvening'],
    // Bounce off red soil, salt crust and shell sand: warmer than Pydna's bleached straw and
    // much paler than the Campus Martius' damp plain. This is the ground colour that comes
    // back up into the hemisphere fill, so it wants to be the map's mean and not its
    // dominant hue.
    groundBounce: 0x94805e,
  },
  terrain: {
    seedLabel: 'carthage-147bc',
    waterLevel: SEA_LEVEL,
    /**
     * −1.0 m: under the datum, so the ring outside the map is water.
     *
     * `farHeight` is where the clipmap drifts outside ±HALF_EXTENT, in *every* direction, and
     * on a peninsula that is right on three sides of four: the Lake of Tunis runs off the −X
     * edge, the Gulf of Tunis off +Z, and the Sebkhet Ariana off +X. The fourth is the
     * mainland behind the attacker, which the drift takes from 6.5 m to −1 m over 900 m — an
     * 0.8 % grade, invisible, and behind the camera in every frame this map is shot from.
     *
     * Because the splat rules paint anything under the datum as water (`ground.ts` layer 3),
     * this is also the cheapest thing on the map that says "peninsula": the horizon on every
     * side is sea.
     */
    farHeight: -1.0,
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
     * Short and dry, but not as dead as a solstice plain.
     *
     * Late April on this coast is the turn: the last winter rain has fallen, the barley is
     * ripening rather than growing, and the hills are already going over — but it is not
     * August. Height 0.85 and dryness 0.72 follow from that, which puts it between Pydna's
     * 1.3/0.72 and a scorched field.
     *
     * Density is the number to watch. Pydna's first pass ran 0.88 and the sward read as
     * isolated tufts on bare earth — thinness, not colour, is what makes ground look like a
     * tech demo — so it was raised to 1.18. 1.02 here is deliberately *not* as low as that
     * failed pass: the stubble is meant to be short and pale, not sparse. If a frame comes
     * back reading as tufts on soil, raise this before touching the albedos.
     */
    grass: { heightScale: 0.85, densityScale: 1.05, dryness: 0.72 },
    scatter: CARTHAGE_SCATTER,
  },
  /**
   * The city — and this field is the only thing that selects one.
   *
   * `main.ts` builds whatever the map hands it and nothing when it hands nothing, so there is
   * no flag to forget and no second module singleton to disagree with this one. The plan
   * calls its own wall builder, `buildCarthageWall` on `CARTHAGE_WALL_LINE`, which *is*
   * `carthage/topography.ts:carthageWallZ` — so the masonry stands on the bench the terrain
   * graded for it, inside the glacis the scatter already clears, and the fabric behind it was
   * laid out against the same function. See `src/city/cityPlan.ts` for the argument and
   * `src/city/carthage/plan.ts` for the build order.
   *
   * The one consequence worth knowing about: this makes `scenario: 'assault'` selectable on
   * Carthage (`sanitiseConfig` refuses it only on a map with no city). `deploySiege` still
   * spawns Roman `ballistarii` and `wall-slingers` on the parapet whatever `plan.garrison`
   * says, because the roster has no Punic wall troops and no Roman siege train — the gap is
   * named in `scenario.ts` itself and closing it is the roster workstream's call.
   */
  city: CARTHAGE_PLAN,
};
