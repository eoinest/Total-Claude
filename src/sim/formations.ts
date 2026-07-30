/**
 * Formation definitions.
 *
 * A formation is a function from (slot index, unit width, ranks) to a local offset in
 * the unit's own frame, where +Z is the facing direction and +X is the unit's right.
 * Keeping them as pure functions means the movement code can ask for a target slot
 * position at any time without storing per-soldier layout data.
 */

import { hash01 } from '../util/rand';

export interface FormationDef {
  id: string;
  name: string;
  /** Tooltip shown in the HUD. */
  description: string;
  /** Multiplier on the unit type's base lateral spacing. */
  spacingXMul: number;
  /** Multiplier on the unit type's base front-to-back spacing. */
  spacingZMul: number;
  /**
   * Preferred men per rank as a function of unit strength. Returning 0 means
   * "keep the unit's current width".
   */
  width(strength: number): number;
  /** Local-space offset for a soldier. Writes into `out`. */
  offset(
    out: { x: number; z: number },
    slot: number,
    width: number,
    ranks: number,
    spacingX: number,
    spacingZ: number
  ): void;
  /** Combat modifiers applied while this formation is held. */
  mods: {
    /** Multiplier on effective shield defence. */
    shield: number;
    /** Multiplier on melee attack. */
    attack: number;
    /** Multiplier on movement speed. */
    speed: number;
    /** Multiplier on incoming missile damage. */
    missileTaken: number;
    /** Multiplier on charge bonus. */
    charge: number;
    /** Flat morale bonus. */
    morale: number;
  };
  /** Animation the idle pose should use while in this formation. */
  idlePose: 'relaxed' | 'alert' | 'brace';
}

/** Centre a rank so the formation's anchor sits at the middle of its front. */
const centredX = (file: number, width: number, spacingX: number): number =>
  (file - (width - 1) * 0.5) * spacingX;

export const FORMATIONS: Record<string, FormationDef> = {
  line: {
    id: 'line',
    name: 'Line',
    description: 'Standard battle line. Broad frontage, four ranks deep.',
    spacingXMul: 1,
    spacingZMul: 1,
    width: (s) => Math.max(8, Math.round(Math.sqrt(s * 4.2))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      out.x = centredX(file, width, sx);
      out.z = -rank * sz;
    },
    mods: { shield: 1, attack: 1, speed: 1, missileTaken: 1, charge: 1, morale: 0 },
    idlePose: 'alert',
  },

  shieldwall: {
    id: 'shieldwall',
    name: 'Shield Wall',
    description: 'Shields locked edge to edge. Far tougher to break, but slow and rigid.',
    spacingXMul: 0.74,
    spacingZMul: 0.86,
    width: (s) => Math.max(8, Math.round(Math.sqrt(s * 3.0))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      // Alternate ranks offset half a man so shields overlap rather than stack.
      out.x = centredX(file, width, sx) + (rank % 2 ? sx * 0.5 : 0);
      out.z = -rank * sz;
    },
    mods: { shield: 1.55, attack: 0.86, speed: 0.5, missileTaken: 0.6, charge: 0.3, morale: 8 },
    idlePose: 'brace',
  },

  testudo: {
    id: 'testudo',
    name: 'Testudo',
    description: 'The tortoise. Shields to the front and overhead — near-immune to missiles, nearly helpless in melee.',
    spacingXMul: 0.6,
    spacingZMul: 0.62,
    width: (s) => Math.max(6, Math.round(Math.sqrt(s * 1.5))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      out.x = centredX(file, width, sx);
      out.z = -rank * sz;
    },
    mods: { shield: 2.3, attack: 0.42, speed: 0.36, missileTaken: 0.16, charge: 0, morale: 4 },
    idlePose: 'brace',
  },

  wedge: {
    id: 'wedge',
    name: 'Wedge',
    description: 'A blunt spearhead built to punch through a line. Concentrates the charge, exposes the flanks.',
    spacingXMul: 0.92,
    spacingZMul: 0.95,
    width: (s) => Math.max(6, Math.round(Math.sqrt(s * 1.9))),
    offset(out, slot, width, _ranks, sx, sz) {
      // A triangle has to be filled by walking the slot index through rows of
      // increasing width, not by bucketing a fixed-width grid. The old version took
      // `slot % width` for the file and then wrapped it into the row with
      // `file % rankWidth`, so every man in row 0 of a 22-wide cavalry wedge landed on
      // one of two x positions and crowd separation had to untangle the pile.
      let rank = 0;
      let remaining = slot;
      let rowWidth = 2;
      while (remaining >= rowWidth) {
        remaining -= rowWidth;
        rank++;
        rowWidth = Math.min(width, 2 + rank * 2);
      }
      out.x = centredX(remaining, rowWidth, sx);
      out.z = -rank * sz;
    },
    mods: { shield: 0.9, attack: 1.12, speed: 1.04, missileTaken: 1.1, charge: 1.45, morale: 4 },
    idlePose: 'alert',
  },

  loose: {
    id: 'loose',
    name: 'Loose',
    description: 'Spread out to blunt arrows and artillery. Weak in a shoving match.',
    spacingXMul: 1.95,
    spacingZMul: 1.8,
    width: (s) => Math.max(8, Math.round(Math.sqrt(s * 3.4))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      // Deterministic scatter so the block reads as irregular but never re-shuffles.
      const jx = (hash01(slot, 11) - 0.5) * sx * 0.85;
      const jz = (hash01(slot, 23) - 0.5) * sz * 0.85;
      out.x = centredX(file, width, sx) + jx;
      out.z = -rank * sz + jz;
    },
    mods: { shield: 0.8, attack: 0.94, speed: 1.1, missileTaken: 0.52, charge: 0.85, morale: -2 },
    idlePose: 'alert',
  },

  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    description: 'A thin screen with room to throw and run. Nothing to hold a line with.',
    spacingXMul: 2.4,
    spacingZMul: 2.1,
    width: (s) => Math.max(10, Math.round(Math.sqrt(s * 6.5))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      const jx = (hash01(slot, 31) - 0.5) * sx * 1.15;
      const jz = (hash01(slot, 47) - 0.5) * sz * 1.15;
      out.x = centredX(file, width, sx) + jx;
      out.z = -rank * sz + jz;
    },
    mods: { shield: 0.7, attack: 0.85, speed: 1.18, missileTaken: 0.42, charge: 0.6, morale: -4 },
    idlePose: 'alert',
  },

  horde: {
    id: 'horde',
    name: 'Horde',
    description: 'No order at all — a mass of men pressing forward. Fast, ferocious, uncontrollable.',
    spacingXMul: 1.15,
    spacingZMul: 1.0,
    width: (s) => Math.max(10, Math.round(Math.sqrt(s * 1.5))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      const jx = (hash01(slot, 61) - 0.5) * sx * 1.5;
      const jz = (hash01(slot, 71) - 0.5) * sz * 1.5;
      // Bulge in the middle so the mass reads as an organic blob, not a grid.
      const bulge = Math.sin((file / Math.max(1, width - 1)) * Math.PI) * sz * 1.4;
      out.x = centredX(file, width, sx) + jx;
      out.z = -rank * sz + jz + bulge;
    },
    mods: { shield: 0.72, attack: 1.06, speed: 1.14, missileTaken: 1.22, charge: 1.2, morale: 6 },
    idlePose: 'relaxed',
  },
};

export const formation = (id: string): FormationDef => FORMATIONS[id] ?? FORMATIONS.line;

/** Ranks needed to fit `n` men at the given width. */
export const ranksFor = (n: number, width: number): number => Math.max(1, Math.ceil(n / Math.max(1, width)));

/** Approximate frontage in metres — used for collision extents and UI banners. */
export const frontageOf = (width: number, spacingX: number): number => width * spacingX;
