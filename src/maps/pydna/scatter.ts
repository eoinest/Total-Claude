import { sstep } from '../../terrain/noise';
import type { ScatterProfile } from '../types';
import {
  LEUCUS_HALF_WIDTH,
  ROAD_HALF_WIDTH,
  TERRACE_X_INNER,
  TERRACE_X_OUTER,
  battleCoreMask,
  groveField,
  leucusZ,
  macedonianDeployMask,
  roadCentreX,
  romanDeployMask,
} from './topography';

/**
 * What grows on the plain of Pydna, and where.
 *
 * The species geometry is shared with the Campus Martius — olive, holm oak, pine, cypress,
 * willow are all as native to Pieria as to Latium, so this map needs no new tree meshes and
 * therefore no new draw calls. What changes completely is the *distribution*, and that is
 * what a landscape actually is:
 *
 *  - **Olive dominates.** On the Campus Martius the olive is one of five species scattered
 *    across centuriated arable. Here it is the tree of the map — in blocks on the plain and
 *    in continuous terraced groves up the lower Pierian slope. Pieria was olive country and
 *    the Rome II Pydna frame is three-quarters olive grove.
 *  - **The stream carries the only closed canopy.** Willow along the Leucus is the single
 *    line of tall dark foliage on an otherwise open plain, which is what gives the middle
 *    distance behind the Macedonian army a readable horizontal band.
 *  - **Maquis, not woodland, above the terraces.** Aleppo pine and kermes oak thinning into
 *    cistus scrub as the slope steepens — an open, stony, half-grazed hillside.
 *  - **Nothing on the plain between the groves but stone.** June pasture, grazed flat, with
 *    limestone showing through. Emptiness is a feature here: the plain has to read as ground
 *    a phalanx could cross, and a sprinkle of trees across it would say the opposite.
 */

/** Grove threshold. Matches the ground shader's `smoothstep(0.58, 0.76, ...)` midpoint. */
const GROVE_EDGE = 0.62;

export const PYDNA_SCATTER: ScatterProfile = {
  species: ['olive', 'oak', 'pine', 'cypress', 'willow'],
  // Weathered Pierian karst, authored at roughly the ground's own albedo rather than the
  // 0.52 a limestone really reflects.
  //
  // Physically that is wrong and it is right anyway. A boulder on a bleached plain catches
  // full sun on a face with nothing to shade it, and at a true limestone albedo every stone
  // on the field rendered above 0.85 display — white blobs, measured, and the single most
  // artificial-looking object in the first Pydna frames. An untextured convex solid has no
  // surface detail to break up a highlight the way real rock does, so it has to be authored
  // down to compensate.
  rockTint: [0.27, 0.262, 0.238],
  // 0.46 against Rome's 2.1, so the largest stone is under a metre. These are field
  // clearance stones and river shingle, not quarry spoil: the tail is cubed, so this caps the
  // rare biggest one and the typical stone is nearer 25 cm. Anything larger has to earn its
  // place with real geometry, and these do not have it.
  // Dropped again from 0.46. `buildRock` produces an untextured flat-shaded convex solid, and
  // at 0.46 the largest stones came out near a metre — big enough to read as *an object*, at
  // which point the eye starts asking what its surface is made of and gets no answer. A
  // faceted grey lump on open ground was the most artificial thing in the terrain frame. At
  // 0.3 the tail caps around 60 cm and stone reads as ground cover rather than as props.
  rockMaxScale: 0.3,

  excluded(x, z, _h, slope, _clearance) {
    // Nothing forms up in a wood and nothing is planted where an army stands.
    if (Math.max(macedonianDeployMask(x, z), romanDeployMask(x, z)) > 0.12) return true;
    // **And nothing is planted in the ground between them.** The deployment boxes stop at
    // z −66 and z +30; the lines actually meet in the gap, which neither box covers. On this
    // map that gap fell inside an olive grove, and the melee camera resolved with a 5 m
    // canopy a metre from the lens — measured, 62 % of that frame was below 0.15 display and
    // the 5th percentile clipped to pure black.
    //
    // It is also the right landscape. Perseus offered battle here because the plain was
    // open enough for a phalanx; the groves are what surround that ground, not what stands
    // in it, and r2-04 frames the phalanx *against* a grove rather than inside one.
    if (battleCoreMask(x, z) > 0.5) return true;
    if (slope > 0.8) return true;
    if (Math.abs(x - roadCentreX(z)) < ROAD_HALF_WIDTH + 4.5) return true;
    // The braid is scoured out every winter; nothing woody roots in it.
    if (Math.abs(z - leucusZ(x)) < LEUCUS_HALF_WIDTH * 1.5) return true;
    return false;
  },

  tree(x, z, _h, slope, ctl, hash) {
    const dLeucus = Math.abs(z - leucusZ(x));
    const onSlope = x < -420;

    // Willow on the stream terrace. Kept under a third: a willow crown is a wide
    // alpha-tested card and a solid thicket of them is the most expensive fill in the frame.
    if (dLeucus < 62 && !onSlope) {
      return { species: 'willow', density: 0.3 * (1 - sstep(30, 62, dLeucus) * 0.55) };
    }

    if (onSlope) {
      // The terraced belt: continuous olive, planted on the benches.
      if (x < TERRACE_X_INNER && x > TERRACE_X_OUTER && slope < 0.5) {
        return { species: 'olive', density: 0.58 * (1 - ctl.g * 0.6) };
      }
      // Above and beyond the terraces, open maquis woodland thinning with height.
      const thin = 1 - sstep(-900, -1340, x) * 0.55;
      const s = hash < 0.4 ? 'pine' : hash < 0.86 ? 'oak' : 'cypress';
      return { species: s, density: 0.3 * thin * (1 - ctl.g * 0.7) };
    }

    // The plain. Groves in blocks, and almost nothing between them.
    const grove = groveField(x, z);
    if (grove > GROVE_EDGE) {
      // Denser toward the middle of a block, so a grove has a soft edge rather than a
      // shoreline. A real holding thins at its margin where the ploughing turns.
      return { species: 'olive', density: 0.26 + 0.4 * sstep(GROVE_EDGE, GROVE_EDGE + 0.16, grove) };
    }
    // Field trees: the odd oak left for shade, a cypress by the road, and nothing else.
    // 0.018 is deliberately almost nothing — see the note about emptiness above.
    const nearRoad = 1 - sstep(30, 130, Math.abs(x - roadCentreX(z)));
    return {
      species: hash < 0.72 ? 'oak' : 'cypress',
      density: 0.018 + nearRoad * 0.1,
    };
  },

  understorey(x, z, _h, slope, ctl, hash) {
    const dLeucus = Math.abs(z - leucusZ(x));
    // Reeds only in the damp gravel at the very margin of the braid — there is standing
    // water in a few pools on the solstice and nowhere else on the map.
    if (dLeucus > LEUCUS_HALF_WIDTH * 1.4 && dLeucus < LEUCUS_HALF_WIDTH * 2.6 && hash < 0.42) {
      return { kind: 'reeds', density: 0.5 };
    }
    // Cistus and thorny burnet: the classic overgrazed Greek hillside, dense on the slope
    // and essentially absent from the plain, which is grazed to the roots by June.
    const onSlope = x < -400;
    let d = onSlope ? 0.34 : 0.035;
    d += sstep(0.14, 0.48, slope) * 0.32;
    d *= 1 - ctl.g * 0.55;
    // Nothing takes hold in river shingle.
    d *= 1 - sstep(0.3, 0.6, ctl.a);
    return { kind: 'bush', density: d };
  },

  rock(x, z, _h, slope, ctl) {
    // Limestone shows through everywhere on this map — the karst is a metre down. Slope and
    // scoured ground carry it, the braid is nothing but cobbles, and the terraces are held
    // up by dry-stone risers.
    const shingle = ctl.a * (1 - sstep(LEUCUS_HALF_WIDTH * 2.5, 70, Math.abs(z - leucusZ(x))));
    const terraceRiser =
      x < TERRACE_X_INNER && x > TERRACE_X_OUTER ? sstep(0.12, 0.4, slope) * 0.5 : 0;
    // Held down hard on the open plain. Stone belongs on the slope, in the braid and on the
    // terrace risers; scattered across level pasture it reads as debris dropped on a lawn.
    const onPlain = 1 - sstep(-380, -620, x);
    return (ctl.g * 0.55 + sstep(0.18, 0.58, slope) * 0.42 + shingle * 0.6 + terraceRiser)
      * (1 - onPlain * 0.62);
  },
};
