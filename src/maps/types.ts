import type { GroundLayerSpec } from '../terrain/groundTextures';
import type { TerrainData } from '../terrain/heightfield';

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
export type MapId = 'campus-martius' | 'pydna';

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
   * Whether this map carries an open water surface. The Tiber does; the Leucus on 22 June is
   * a dry shingle braid and does not, which saves `RiverWater`'s draw call and its
   * reflection work outright.
   */
  hasRiver: boolean;
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
   * True when this map is not the Campus Martius and the procedural city of Rome must not
   * appear on it.
   *
   * `main.ts` registers `CitySystem` unconditionally and `CitySystem.init` has no early-out,
   * neither of which this workstream owns. Until that one line becomes conditional the city
   * is built and then hidden through its own public `setDebugVisible`, which costs its build
   * time at boot and leaves its wall segments stamped into the AI nav grid beyond z ≈ 500.
   * Both are invisible on this map — nothing fights up there — but neither is right, and the
   * fix is one line in `main.ts`. See the hand-off notes.
   */
  readonly hidesCity: boolean;
}
