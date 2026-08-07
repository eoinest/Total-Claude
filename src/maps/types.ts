import type { CityPlan } from '../city/cityPlan';
import type { GroundLayerSpec } from '../terrain/groundTextures';
import type { TerrainData } from '../terrain/heightfield';
import type { WaterProfile } from '../terrain/WaterSurface';

/**
 * What a battle map is, as far as the engine is concerned.
 *
 * The game shipped with exactly one battlefield and every part of it — topography, ground
 * palette, splat rules, vegetation, sun position — was a module constant somewhere under
 * `src/terrain/` or `src/render/`. This interface is the seam those constants were lifted
 * behind so a second map can differ in all of them without forking the systems that consume
 * them.
 *
 * **What a map may not change.** `HALF_EXTENT` stays 1400 m: it is read at module-evaluation
 * time by `src/city/*`, `src/ai/Pathfinding.ts` and `src/ui/Minimap.ts`, none of which this
 * workstream owns. The deployment boxes stay centred near z −196 (attacker) and z +150
 * (defender) because `src/sim/scenario.ts` hardcodes `germZ = -190` and `romanZ = 130` and is
 * likewise not ours. A map therefore moves the *world* under a fixed order of battle rather
 * than moving the armies, which is a real constraint but not a limiting one — every criterion
 * in docs/VISUAL-RUBRIC.md that a map can influence is about the ground, the plants and the
 * light.
 */

/** Registry key. Also the value persisted in `BattleConfig.map` and the `?battle=` token. */
export type MapId = 'campus-martius' | 'pydna' | 'carthage';

/**
 * Where and when the battle is, for the scattering integral.
 *
 * `src/render/atmosphere.ts` turns these into a sun direction via the real
 * equatorial-to-horizontal transform, so a map states its site and its season and gets a
 * physically correct sun arc rather than a hand-placed light.
 */
export interface SiteAstronomy {
  /** Degrees north. Rome 41.9, Pydna 40.35. */
  latitudeDeg: number;
  /**
   * Solar declination for the campaign season, degrees. −14 is early November; +23.4 is the
   * summer solstice. This is the single number that decides how low the sun can get, and
   * therefore how long the shadows are and whether the frame has any relief in it at all.
   */
  declinationDeg: number;
  /** Human note on why those two numbers, surfaced in the map blurb. */
  season: string;
}

/**
 * Named weather/hour look for a map, resolved against `SKY_PRESETS`.
 *
 * A map supplies its own preset table rather than an index into the shared one because
 * turbidity, haze scale height and exposure are all site properties: a June afternoon over a
 * Macedonian coastal plain is not a November afternoon over the Tiber flood plain, and
 * pretending otherwise is how two maps end up looking like one map with the trees moved.
 */
export interface SkyProfile {
  /** Hour the map opens at when the player has not chosen one. */
  defaultHour: number;
  /** Preset names, in ascending hour order, blended by `presetForHour`. */
  readonly dayCycle: readonly string[];
  /** Hemisphere-light ground colour: the bounce off this map's own ground. */
  groundBounce: number;
}

/** A vegetation or scatter species this map plants, with its own placement rule. */
export interface ScatterProfile {
  /**
   * Decide what grows at a candidate point, or null to reject it.
   *
   * Called once per lattice cell at load. `h` is ground height, `slope` 0..1, `ctl` the
   * baked control channels, and `hash` a stable per-cell 0..1 for variation. Returning a
   * density lets the caller apply its own acceptance test, which keeps the rejection
   * bookkeeping in one place.
   */
  tree(
    x: number,
    z: number,
    h: number,
    slope: number,
    ctl: { r: number; g: number; b: number; a: number },
    hash: number,
  ): { species: string; density: number } | null;
  /** Understorey: scrub and reeds. Same contract. */
  understorey(
    x: number,
    z: number,
    h: number,
    slope: number,
    ctl: { r: number; g: number; b: number; a: number },
    hash: number,
  ): { kind: 'bush' | 'reeds'; density: number } | null;
  /** Loose stone density, 0..1. */
  rock(
    x: number,
    z: number,
    h: number,
    slope: number,
    ctl: { r: number; g: number; b: number; a: number },
  ): number;
  /** Species this map may plant, so only their geometry is built. */
  readonly species: readonly string[];
  /** Linear base colour of loose stone. See `buildRock`. */
  readonly rockTint: readonly [number, number, number];
  /**
   * Upper bound on a boulder's half-width in metres. The tail is cubed, so this is the size
   * of the rare largest stone rather than a typical one.
   */
  readonly rockMaxScale: number;
  /** True where nothing at all may be planted — deployment boxes, water, roads, city glacis. */
  excluded(x: number, z: number, h: number, slope: number, clearance: number): boolean;
}

/** Everything the ground stack needs that differs between maps. */
export interface TerrainProfile {
  /** Deterministic content seed. Changing it regenerates the landscape. */
  seedLabel: string;
  /** Height of the open water surface, metres. The Tiber's low water; the Aegean's mean. */
  waterLevel: number;
  /**
   * Height the clipmap drifts to outside ±HALF_EXTENT, so the world reads as continuing
   * countryside rather than ending at the battlefield boundary.
   */
  farHeight: number;
  /** Build the heightfield and the control texture. */
  build(seedLabel: string): TerrainData;
  /** The eight splat layers, in the fixed order the shader's rule set indexes. */
  readonly layers: readonly GroundLayerSpec[];
  /**
   * GLSL that fills `float w[8]` from the surface terms the shader has already computed.
   * See `TerrainMaterial.ts` for the variables in scope. Compiled into the program, so it
   * costs nothing at runtime and the two maps never branch per pixel.
   */
  splatGlsl: string;
  /** Distinguishes this map's shader program in three's cache. */
  splatCacheKey: string;
  /**
   * Area-weighted mean linear colour of this map's ground, which distant terrain converges
   * on. A real aerial view resolves mixed sub-pixel ground to its mean; without this the
   * strategic camera reads a patchwork as camouflage.
   */
  readonly aerialMean: readonly [number, number, number];
  /** How hard distant ground converges on that mean. See `TerrainShading.aerialStrength`. */
  readonly aerialStrength: number;
  /**
   * The open water this map carries, or null for none.
   *
   * **This replaced `hasRiver: boolean`, for the reason `city: CityPlan | null` replaced
   * `hidesCity`.** Under the flag there was exactly one water surface in the engine — a
   * ribbon of geometry built along the Tiber's own meander train — so a map could say "yes,
   * water" and get the Tiber's channel, or say "no" and get nothing. Carthage, which is a
   * peninsula, had to say no: its gulf, its lagoon and its harbours shipped as terrain under
   * the datum painted by the splat, and the owner's report on the finished map was *"I see
   * the ocean but no lagoon, it's just the beach."* A flat diffuse surface with no specular,
   * no animation and no depth cue reads as wet sand.
   *
   * A map now describes its water and `WaterSurface` renders it — one draw call for all of
   * it, with the wetted extent taken from the map's own heightfield rather than from an
   * authored polyline, so a coast cannot disagree with its own bathymetry. The Leucus on 22
   * June is a dry shingle braid and still says null, which still costs nothing.
   */
  water: WaterProfile | null;
  /**
   * GLSL defining `float grassRoadCentreX(float z)`: the road the sward keeps off. The grass
   * shader needs the centreline analytically so the verge stays crisp at any zoom.
   */
  roadGlsl: string;
  /** Grass tint and height. Macedonian summer pasture is taller, drier and paler than Latian turf. */
  grass: { heightScale: number; densityScale: number; dryness: number };
  scatter: ScatterProfile;
}

export interface MapDefinition {
  readonly id: MapId;
  /** Menu button label. */
  readonly label: string;
  /** Menu sub-label and the heading under the game title. */
  readonly subtitle: string;
  /** One sentence for the menu, explaining what makes this battlefield different. */
  readonly blurb: string;
  readonly site: SiteAstronomy;
  readonly sky: SkyProfile;
  readonly terrain: TerrainProfile;
  /**
   * The city standing on this map, or null for open ground.
   *
   * **This replaced `hidesCity: boolean`, and the replacement is the point.** Under the flag,
   * `CitySystem` planned the Aurelian circuit against the Tiber, built it onto whatever
   * heightfield was loaded, and was then merely made invisible — so Rome's wall blocked
   * movement across the plain of Pydna while being nowhere on screen. Skipping registration
   * fixed that instance and left the shape of the error alive: a flag is something a third
   * map can forget.
   *
   * A city is now something a map *carries*, not something it hides. `main.ts` does
   * `if (plan) engine.add(new CitySystem(plan))` and builds exactly what it was handed. The
   * absence of a city is the absence of data, and there is no field left to forget.
   *
   * Anything downstream asking "does this map have a wall" asks `map.city !== null`. Nothing
   * may reintroduce a test on the map's *identity* — if a consumer needs to know which city,
   * it reads `plan.id`.
   */
  readonly city: CityPlan | null;
}
