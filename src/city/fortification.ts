/**
 * Which circuit `CitySystem` builds.
 *
 * A module singleton for exactly the reason `src/maps/index.ts` gives for `setActiveMap`:
 * `main.ts` constructs every subsystem with zero arguments and `EngineContext` carries no
 * configuration field, so there is no existing channel by which a menu choice can reach the
 * city. This is the same seam, one level down — a map says *where* the battle is, a
 * fortification says *what stands on the crest*.
 *
 * Kept in its own file rather than in `CitySystem.ts` so that whoever wires Carthage into
 * the map registry writes one import and one call, and never has to touch a 56 KB file two
 * other workstreams are editing.
 */
export type FortificationId = 'aurelian' | 'carthage';

/**
 * `?fort=carthage` selects the Punic circuit.
 *
 * Read once at module evaluation, which runs before any subsystem is constructed (see the
 * ordering note in `src/maps/index.ts`). It exists so the probe harness can drive either
 * circuit against one dev server without a menu; a map definition that sets this in code
 * overrides it by calling `setFortification` later.
 */
const fromQuery = ((): FortificationId | null => {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('fort');
  return v === 'carthage' ? 'carthage' : v === 'aurelian' ? 'aurelian' : null;
})();

let active: FortificationId = fromQuery ?? 'aurelian';

export function setFortification(id: FortificationId): void {
  active = id;
}

export function activeFortification(): FortificationId {
  return active;
}
