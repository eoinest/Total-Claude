import { assertLayerSet } from '../terrain/groundTextures';
import { CAMPUS_MARTIUS } from './campusMartius';
import { CARTHAGE } from './carthage';
import { PYDNA } from './pydna';
import type { MapDefinition, MapId } from './types';

export type { MapDefinition, MapId, ScatterProfile, SiteAstronomy, TerrainProfile } from './types';

/**
 * The battle maps, in menu order.
 *
 * `campus-martius` is first and is the default, so a player who has never opened the map row
 * — and every harness run that does not ask for anything else — gets exactly the battle the
 * game shipped with.
 */
export const MAPS: readonly MapDefinition[] = [CAMPUS_MARTIUS, CARTHAGE, PYDNA];

export const DEFAULT_MAP_ID: MapId = 'campus-martius';

const BY_ID = new Map<MapId, MapDefinition>(MAPS.map((m) => [m.id, m]));

for (const m of MAPS) assertLayerSet(m.terrain.layers, m.id);

/** Resolve a map, falling back to the default for anything unrecognised. */
export const getMap = (id: MapId | string | undefined): MapDefinition =>
  BY_ID.get(id as MapId) ?? BY_ID.get(DEFAULT_MAP_ID)!;

export const isMapId = (v: unknown): v is MapId => BY_ID.has(v as MapId);

// ---------------------------------------------------------------------------
// The active map
// ---------------------------------------------------------------------------

/**
 * Which map this session is building, as a module singleton.
 *
 * **Why a singleton and not a constructor argument.** `main.ts` builds every subsystem with
 * zero arguments (`new SkySystem()`, `new TerrainSystem()`, …) and `EngineContext` carries no
 * configuration field. Neither file belongs to this workstream, so there is no existing
 * channel by which a menu choice can reach the terrain, and this is the only legal one.
 *
 * **Why the timing is safe.** `main.ts` is a top-level-`await` module and its order of
 * execution is: `resolveConfig()` → `sanitiseConfig()` → `await MainMenu.show()` →
 * `new Engine()` → `engine.add(new TerrainSystem())` → `await engine.initAll()`. The first
 * three are all in files this workstream owns, and every one of them completes before a
 * subsystem is so much as constructed. `resolveConfig` covers the harness and `?menu=0`
 * paths; `MainMenu.commit` covers a player changing the map in the menu. Both write here.
 *
 * The fallback is the shipped battlefield, so a code path that forgets to set it degrades to
 * the status quo rather than to a broken map.
 */
let active: MapDefinition = CAMPUS_MARTIUS;

export function setActiveMap(id: MapId | string | undefined): void {
  active = getMap(id);
}

export function activeMap(): MapDefinition {
  return active;
}
