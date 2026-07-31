/**
 * Siege engines and their crews, kept out of `roster.ts` on purpose.
 *
 * This file exists as an ownership seam. The siege workstream and the artillery workstream
 * both need to add unit types, and two agents editing one 320-line array in parallel is how
 * you lose an afternoon to a merge. `roster.ts` owns the field army and the `scorpio` entry;
 * this owns everything that assaults or defends a wall. They are concatenated in `ALL_UNITS`
 * and share one id namespace, so ids must still be unique across both.
 *
 * Starts empty. Anything added here is visible to `unitType()`, `unitsOf()` and the
 * pre-battle menu's roster rows with no further wiring.
 */

import type { UnitTypeDef } from '../sim/types';

export const SIEGE_UNITS: UnitTypeDef[] = [];
