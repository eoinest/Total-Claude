import { ROME_PLAN } from '../city/rome/plan';
import { CAMPUS_SHADING } from '../terrain/TerrainMaterial';
import { GROUND_LAYERS } from '../terrain/groundTextures';
import { buildTerrain } from '../terrain/heightfield';
import { fbm, sstep } from '../terrain/noise';
import {
  QUARRIES,
  TOPO_GLSL,
  WATER_LEVEL,
  crestZAt,
  germanDeployMask,
  riseToeZ,
  riverCentreX,
  roadCentreX,
  romanDeployMask,
  streamDistance,
} from '../terrain/topography';
import type { MapDefinition, ScatterProfile } from './types';

/**
 * The Campus Martius outside Rome, 271 AD — the battlefield the game shipped with.
 *
 * Every value here was previously a module constant inside `src/terrain/` or
 * `src/render/`. Nothing about the map has changed: this file exists so the second map has
 * something to be a peer of, and its correctness criterion is that the frames it produces
 * are pixel-identical to the ones the single-map build produced.
 */

/** Must match the centuriation lattice the heightfield banks the field edges on. */
const FIELD_ANGLE = 0.213;
const FIELD_COS = Math.cos(FIELD_ANGLE);
const FIELD_SIN = Math.sin(FIELD_ANGLE);
const FIELD_PERIOD = 94;

/**
 * Keep-out around the Aurelian Wall, measured from `crestZAt(x)` — the line the city agent
 * builds the curtain along.
 *
 * Outward: a besieged city clears its glacis. Aurelian's engineers demolished and felled
 * everything within bowshot of the new circuit, and the frames showed 20 m umbrella pines
 * standing *through* the curtain. Inward: everything behind the crest is the city's ground,
 * and `CitySystem` plants its own cypresses and garden trees there.
 */
export const WALL_CLEAR_OUT = 30;

const CAMPUS_SCATTER: ScatterProfile = {
  species: ['cypress', 'pine', 'oak', 'olive', 'willow'],
  // Travertine and tufa: warm pale grey.
  rockTint: [0.52, 0.5, 0.45],
  rockMaxScale: 2.1,

  excluded(x, z, h, slope, clearance) {
    if (h < WATER_LEVEL + 0.7) return true;
    if (slope > 0.78) return true;
    if (Math.max(germanDeployMask(x, z), romanDeployMask(x, z)) > 0.12) return true;
    if (Math.abs(x - roadCentreX(z)) < 10.5) return true;
    // Everything from the cleared glacis inward belongs to the city.
    if (z > crestZAt(x) - clearance) return true;
    for (const q of QUARRIES) {
      if (Math.hypot((x - q.x) / q.radius, (z - q.z) / (q.radius * 0.8)) < 1.25) return true;
    }
    return false;
  },

  tree(x, z, h, _slope, ctl, hash) {
    if (ctl.b > 0.5) return null; // heavily trodden ground

    const toe = riseToeZ(x);
    const onHill = z > toe - 50;
    const dRiver = Math.abs(x - riverCentreX(z));
    const dRoad = Math.abs(x - roadCentreX(z));
    const above = h - WATER_LEVEL;

    let species: string;
    let density: number;
    if (dRiver < 175 && above < 5.4) {
      // The Tiber's water meadow: willow and poplar thickets. Kept below a third because
      // willow crowns are wide alpha-tested cards and a solid thicket of them is the most
      // expensive fill in the frame.
      species = 'willow';
      density = 0.32;
    } else if (dRoad < 44 && dRoad > 10.5) {
      // A cypress avenue along the Via Flaminia — unmistakably Italian, and it gives the
      // road a readable line from a high camera.
      species = hash < 0.82 ? 'cypress' : 'oak';
      density = 0.5;
    } else if (onHill) {
      species = hash < 0.42 ? 'pine' : hash < 0.82 ? 'oak' : 'cypress';
      // Denser on the flanks, thinning on the crest where the city begins.
      density = 0.34 * (1 - sstep(toe + 260, toe + 620, z) * 0.6);
    } else {
      // The centuriated plain: olive groves in blocks, hedgerow trees along the field
      // boundaries, and copses in between. Uniform scatter over farmland is the clearest
      // tell that nobody has ever worked the ground.
      const grove = fbm(x, z, 2, 1 / 235, 9091) * 0.5 + 0.5;
      if (grove > 0.58) {
        species = 'olive';
        density = 0.42;
      } else {
        species = hash < 0.7 ? 'oak' : 'olive';
        // Same lattice the heightfield banks the field edges on, so the trees line up with
        // the boundaries rather than ignoring them.
        const u = x * FIELD_COS - z * FIELD_SIN;
        const v = x * FIELD_SIN + z * FIELD_COS;
        const du = Math.abs(((u % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
        const dv = Math.abs(((v % FIELD_PERIOD) + FIELD_PERIOD * 1.5) % FIELD_PERIOD - FIELD_PERIOD * 0.5);
        const hedge = 1 - sstep(3, 12, Math.min(du, dv));
        const copse = fbm(x, z, 3, 1 / 130, 7717) * 0.5 + 0.5;
        density = 0.02 + 0.34 * hedge + 0.22 * sstep(0.6, 0.85, copse);
      }
    }
    // Nothing grows on scoured bedrock.
    return { species, density: density * (1 - ctl.g * 0.75) };
  },

  understorey(x, z, h, slope, ctl, hash) {
    const above = h - WATER_LEVEL;
    const dRiver = Math.abs(x - riverCentreX(z));
    const dStream = z > -220 && z < 420 && x > -880 && x < 280 ? streamDistance(x, z) : 999;

    // Reeds stand in the water's edge and along the drainage stream, where the deployment
    // exclusion does not apply — nobody forms up in a reed bed anyway.
    if ((above > -0.4 && above < 1.15 && dRiver < 150) || (dStream < 9 && above > 0)) {
      return hash < 0.62 ? { kind: 'reeds', density: 1 } : null;
    }
    if (ctl.b > 0.45) return null;

    const toe = riseToeZ(x);
    const onHill = z > toe - 40;
    // Maquis clings to the broken ground of the slopes; the plain is grazed bare.
    let d = onHill ? 0.3 : 0.05;
    d += sstep(0.16, 0.5, slope) * 0.3;
    d *= 1 - ctl.g * 0.6;
    // Nothing woody roots in a river bar: those are reworked every flood.
    d *= 1 - sstep(0.25, 0.55, ctl.a);
    return { kind: 'bush', density: d };
  },

  rock(_x, _z, h, slope, ctl) {
    // Stone shows where the ground has been scoured, on steep faces, on the river's gravel
    // bars, and in the quarry spoil.
    const bar = ctl.a * (1 - sstep(0.2, 2.2, h - WATER_LEVEL));
    return ctl.g * 0.55 + sstep(0.2, 0.62, slope) * 0.4 + bar * 0.5;
  },
};

export const CAMPUS_MARTIUS: MapDefinition = {
  id: 'campus-martius',
  label: 'Campus Martius',
  subtitle: 'The Siege of Rome &middot; 271 AD',
  blurb:
    'The Tiber flood plain north of the city. Centuriated farmland, a graded consular road ' +
    'and the Aurelian Wall on the hills behind. Low November sun.',
  site: {
    latitudeDeg: 41.9,
    // The Juthungi were driven off Italy across the autumn of 271, so a declination of −14°
    // — roughly the first week of November — is period-correct. It is also the art
    // direction: at Rome's latitude it caps the sun at 34° even at local noon.
    declinationDeg: -14,
    season: 'early November, 271 AD',
  },
  sky: {
    defaultHour: 10,
    dayCycle: ['dawn', 'morning', 'noon', 'afternoon', 'goldenHour'],
    // Warm bounce off the dry plain.
    groundBounce: 0x6b5a3e,
  },
  terrain: {
    seedLabel: 'campus-martius-271',
    waterLevel: WATER_LEVEL,
    // Distant ground drifts to a little above the plain so the world reads as continuing
    // countryside rather than ending at the battlefield boundary.
    farHeight: 13.5,
    build: (seedLabel) => buildTerrain(seedLabel),
    layers: GROUND_LAYERS,
    splatGlsl: CAMPUS_SHADING.splatGlsl,
    splatCacheKey: CAMPUS_SHADING.cacheKey,
    aerialMean: CAMPUS_SHADING.aerialMean,
    aerialStrength: CAMPUS_SHADING.aerialStrength,
    hasRiver: true,
    roadGlsl: `${TOPO_GLSL}\nfloat grassRoadCentreX(float z) { return topoRoadCentreX(z); }`,
    grass: { heightScale: 1, densityScale: 1, dryness: 0 },
    scatter: CAMPUS_SCATTER,
  },
  city: ROME_PLAN,
};
