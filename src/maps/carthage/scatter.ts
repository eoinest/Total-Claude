import { sstep } from '../../terrain/noise';
import type { ScatterProfile } from '../types';
import {
  ROAD_HALF_WIDTH,
  WADI_HALF_WIDTH,
  WALL_CLEAR_OUT,
  battleCoreMask,
  carthageWallZ,
  coastZ,
  gardenField,
  lakeEdgeX,
  punicDeployMask,
  roadCentreX,
  romanDeployMask,
  softGround,
  wadiZ,
} from './topography';

/**
 * What grows on the isthmus of Carthage, and where. Built to `docs/CARTHAGE.md` §3 and §7.7.
 *
 * The species geometry is shared with the other two maps — olive, holm oak, Aleppo pine,
 * cypress and a weeping riparian tree are all as native to Cap Bon as to Latium or Pieria —
 * so this map needs no new tree meshes and therefore no new draw calls. What changes
 * completely is the distribution, and that is what a landscape actually is:
 *
 *  - **Olive is the tree of the map, and it is *planted in rows*.** Punic North Africa was
 *    the most intensively cultivated coast in the western Mediterranean; Mago's twenty-eight
 *    books on agriculture were the one thing the Senate ordered translated out of the city's
 *    libraries before it burned. This is orchard country, not scrub with trees in it.
 *  - **The Megara is a wall of green behind the curtain.** Appian says the great northern
 *    suburb of gardens and orchards obstructed Scipio's advance more than the defenders did.
 *    Everything inside the wall line is dense — which also does compositional work: from the
 *    siege lines the curtain has a dark mass behind it and the Byrsa rising out of that,
 *    instead of a wall standing against empty sky.
 *  - **The two shores are bare.** Nothing woody roots in an evaporite pan and nothing but
 *    marram holds a dune. A tree on the salt would be the loudest possible tell.
 *  - **The fighting ground is open.** The isthmus in front of the wall is the ground Scipio's
 *    lines stood on for three years, and it is swept and beaten. Emptiness is a feature: it
 *    has to read as ground two armies can form up on.
 *
 * `willow` stands in for **tamarisk**, which is the tree of a Tunisian wadi bed and sabkha
 * margin. There is no tamarisk mesh; the willow's weeping habit and grey-green foliage are
 * the closest of the five, and at battle range the difference is a species name.
 */

/** Garden threshold. Matches the ground shader's `smoothstep(0.56, 0.74, ...)` midpoint. */
const GARDEN_EDGE = 0.61;

/**
 * How near a water or a salt margin a point is, 0 inland .. 1 at the edge.
 *
 * Three waters on this map (§2.2): the Lake of Tunis at −X, the Gulf of Tunis at +Z, and the
 * Sebkhet Ariana salt pan at +X. Nothing woody roots in an evaporite pan, nothing but marram
 * holds a beach, and `softGround` already publishes the sabkha margin for the engine-mobility
 * rule — so the same function decides what grows.
 */
const shoreNess = (x: number, z: number): number =>
  Math.max(
    softGround(x, z),
    Math.max(
      1 - sstep(0, 300, x - lakeEdgeX(z)),
      1 - sstep(0, 220, coastZ(x) - z),
    ),
  );

export const CARTHAGE_SCATTER: ScatterProfile = {
  species: ['olive', 'oak', 'pine', 'cypress', 'willow'],
  // Calcarenite: warm yellow-white marine sandstone, authored well below its true albedo for
  // the same reason Pydna's karst is. `buildRock` produces an untextured flat-shaded convex
  // solid with no surface detail to break up a highlight, so a physically correct pale rock
  // renders as a white blob and is the most artificial-looking object in the frame.
  rockTint: [0.3, 0.276, 0.235],
  // 0.55: larger than Pydna's 0.3 and a quarter of Rome's 2.1. The Byrsa's flanks are cut
  // into soft sandstone that breaks off in blocks, and there is quarry spoil at its foot —
  // the city was built out of its own hill. On the plain the density term below holds them
  // down to almost nothing regardless.
  rockMaxScale: 0.55,

  excluded(x, z, h, slope, clearance) {
    // Nothing forms up in an orchard and nothing is planted where an army stands.
    if (Math.max(romanDeployMask(x, z), punicDeployMask(x, z)) > 0.12) return true;
    // And nothing in the ground between them. The deployment boxes stop at z −66 and z +30
    // and the lines actually meet in that gap, which neither box covers — at Pydna that gap
    // fell inside an olive grove and the melee camera resolved with a 5 m canopy a metre from
    // the lens, 62 % of the frame below 0.15 display. Same trap, same fix, one map earlier.
    if (battleCoreMask(x, z) > 0.5) return true;
    if (slope > 0.8) return true;
    if (Math.abs(x - roadCentreX(z)) < ROAD_HALF_WIDTH + 5.5) return true;
    // The wadi bed is scoured out every winter storm; nothing woody roots in it.
    if (Math.abs(z - wadiZ(x)) < WADI_HALF_WIDTH * 1.4) return true;
    // Salt and sand.
    if (shoreNess(x, z) > 0.42) return true;
    /**
     * The cleared glacis, outward only.
     *
     * A besieged city fells everything within bowshot of its curtain, and the frames on the
     * Campus Martius showed 20 m umbrella pines standing *through* the Aurelian Wall before
     * the equivalent rule went in there. Inward is the city's ground and the city plants it
     * — but until `src/city/carthage/` exists there is no city to do that, so the inward
     * clearance runs to the map edge and the Megara's trees are scattered here instead. See
     * `tree` below.
     */
    if (Math.abs(z - carthageWallZ(x)) < WALL_CLEAR_OUT + clearance) return true;
    return false;
  },

  tree(x, z, _h, slope, ctl, hash) {
    const dWadi = Math.abs(z - wadiZ(x));
    const wallZ = carthageWallZ(x);
    const inMegara = z > wallZ;

    // Tamarisk along the wadi. Kept under a third: a weeping crown is a wide alpha-tested
    // card and a solid thicket of them is the most expensive fill in the frame.
    if (dWadi < 68) {
      return { species: 'willow', density: 0.3 * (1 - sstep(34, 68, dWadi) * 0.55) };
    }

    /**
     * The Megara: everything behind the wall.
     *
     * Dense and continuous, which is both the historical record and the composition. The
     * hills are the exception — the Byrsa carried a citadel, a temple precinct and a quarter
     * of housing, not an orchard — so tree cover thins on anything steep and on the two
     * summits, leaving them to read as built ground.
     *
     * **This is provisional and is meant to be taken over.** When `src/city/carthage/`
     * builds the suburb it will plant its own garden trees through `TreeRequest`, as Rome's
     * `landmarks.ts` and `insulae.ts` already do, and this branch should shrink to the strip
     * between the wall and the built edge. Leaving the ground bare in the meantime would
     * make every frame of the map read as a wall with nothing behind it.
     */
    if (inMegara) {
      const onHill = sstep(0.1, 0.3, slope);
      const garden = gardenField(x, z);
      const s = hash < 0.74 ? 'olive' : hash < 0.9 ? 'cypress' : 'pine';
      const d = (garden > GARDEN_EDGE ? 0.6 : 0.34) * (1 - onHill * 0.75) * (1 - ctl.g * 0.7);
      return { species: s, density: d };
    }

    // The isthmus in front of the wall: gardens in blocks, and very little between them.
    const garden = gardenField(x, z);
    if (garden > GARDEN_EDGE) {
      // Denser toward the middle of a block, so a holding has a soft edge rather than a
      // shoreline: a real garden thins at its margin where the ploughing turns.
      // Cypress on the boundaries — a windbreak round an irrigated plot is standard practice
      // on this coast and it is what makes the blocks legible from altitude.
      const edge = sstep(GARDEN_EDGE, GARDEN_EDGE + 0.13, garden);
      const s = hash < 0.82 ? 'olive' : 'cypress';
      return { species: s, density: (0.22 + 0.36 * edge) * (1 - ctl.g * 0.6) };
    }
    // Field trees: the odd oak left for shade and a cypress by the road. 0.014 is deliberately
    // almost nothing — see the note about emptiness above.
    const nearRoad = 1 - sstep(26, 120, Math.abs(x - roadCentreX(z)));
    return {
      species: hash < 0.62 ? 'oak' : 'cypress',
      density: 0.014 + nearRoad * 0.09,
    };
  },

  understorey(x, z, _h, slope, ctl, hash) {
    const dWadi = Math.abs(z - wadiZ(x));
    const shore = shoreNess(x, z);

    // Reeds in the damp gravel at the very margin of the wadi bed, where the last pools sit
    // into August — and in the brackish fringe of the lagoon, which is where a real sabkha
    // grows its ring of salt-tolerant rush before it gives out to bare crust.
    if (dWadi > WADI_HALF_WIDTH * 1.3 && dWadi < WADI_HALF_WIDTH * 2.4 && hash < 0.4) {
      return { kind: 'reeds', density: 0.5 };
    }
    if (shore > 0.32 && shore < 0.58 && hash < 0.34) {
      return { kind: 'reeds', density: 0.42 };
    }
    // Nothing at all on the crust or the open sand.
    if (shore > 0.58) return null;

    // Salt-bush and thorny scrub: an overgrazed semi-arid coast, thin on the level plain and
    // holding on wherever the ground is broken.
    let d = 0.045;
    d += sstep(0.13, 0.46, slope) * 0.34;
    d *= 1 - ctl.g * 0.55;
    // Nothing takes hold in wadi shingle or in blown sand.
    d *= 1 - sstep(0.3, 0.62, ctl.a);
    return { kind: 'bush', density: d };
  },

  rock(x, z, _h, slope, ctl) {
    // Calcarenite shows on the hills, in the wadi bed, and as quarry spoil where the city
    // cut its own building stone out of the Byrsa's flank.
    const shingle = ctl.a * (1 - sstep(WADI_HALF_WIDTH * 2.2, 66, Math.abs(z - wadiZ(x))));
    // Held down hard on the level isthmus and to zero on both shores. Stone scattered across
    // a beaten parade ground reads as debris dropped on a lawn, and stone on a salt pan reads
    // as a bug.
    const onPlain = 1 - sstep(0.1, 0.26, slope);
    const shore = shoreNess(x, z);
    return (ctl.g * 0.55 + sstep(0.16, 0.55, slope) * 0.45 + shingle * 0.55)
      * (1 - onPlain * 0.7)
      * (1 - sstep(0.2, 0.5, shore));
  },
};
