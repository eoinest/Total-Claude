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
  /**
   * Fraction of `width` that is actually standing in the front rank, used for the
   * contact test. A line's front rank *is* its width; a wedge's is two men at the point,
   * and treating a wedge as if its widest row were its front made it "in contact" with
   * anything within twenty metres either side of its tip.
   */
  frontMul: number;
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

/**
 * Metres between men before a formation's multipliers, so every system that estimates a
 * footprint agrees with the one that actually places the men.
 */
export const BASE_SPACING_X = { foot: 0.95, mounted: 1.95 } as const;
export const BASE_SPACING_Z = { foot: 1.32, mounted: 3.1 } as const;

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
    // Frontage decides how many men can reach the enemy, so it decides the fight. A
    // Rome II line unit is four to six ranks deep, not nine: sqrt(s*5.2) puts a 320-man
    // cohort 41 across and 8 deep, about 35 m of front.
    width: (s) => Math.max(8, Math.round(Math.sqrt(s * 5.2))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      out.x = centredX(file, width, sx);
      out.z = -rank * sz;
    },
    frontMul: 1,
    mods: { shield: 1, attack: 1, speed: 1, missileTaken: 1, charge: 1, morale: 0 },
    idlePose: 'alert',
  },

  shieldwall: {
    id: 'shieldwall',
    name: 'Shield Wall',
    description: 'Shields locked edge to edge. Far tougher to break, but slow and rigid.',
    // Tight, but never inside the 0.84 m body the separation pass enforces: at 0.74 the
    // slot a man was sent to was closer than his own shoulders, so the wall spent the
    // whole battle being shoved back out of itself and the men interpenetrated.
    spacingXMul: 0.9,
    spacingZMul: 0.9,
    width: (s) => Math.max(8, Math.round(Math.sqrt(s * 3.0))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      // Alternate ranks offset half a man so shields overlap rather than stack.
      out.x = centredX(file, width, sx) + (rank % 2 ? sx * 0.5 : 0);
      out.z = -rank * sz;
    },
    frontMul: 1,
    mods: { shield: 1.55, attack: 0.86, speed: 0.5, missileTaken: 0.6, charge: 0.3, morale: 8 },
    idlePose: 'brace',
  },

  testudo: {
    id: 'testudo',
    name: 'Testudo',
    description: 'The tortoise. Shields to the front and overhead — near-immune to missiles, nearly helpless in melee.',
    // The tightest formation in the game and still not tighter than a man is wide.
    spacingXMul: 0.9,
    spacingZMul: 0.68,
    width: (s) => Math.max(6, Math.round(Math.sqrt(s * 1.5))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      out.x = centredX(file, width, sx);
      out.z = -rank * sz;
    },
    frontMul: 1,
    mods: { shield: 2.3, attack: 0.42, speed: 0.36, missileTaken: 0.16, charge: 0, morale: 4 },
    idlePose: 'brace',
  },

  wedge: {
    id: 'wedge',
    name: 'Wedge',
    description: 'A blunt spearhead built to punch through a line. Concentrates the charge, exposes the flanks.',
    spacingXMul: 0.92,
    spacingZMul: 0.95,
    // A wedge fills rows of 2, 4, 6 … so it is inherently deep; too narrow a `width` and
    // it becomes a column. At sqrt(s*1.9) a 60-horse wedge was eight rows and 24 m deep.
    width: (s) => Math.max(6, Math.round(Math.sqrt(s * 3.0))),
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
    frontMul: 0.35,
    mods: { shield: 0.9, attack: 1.12, speed: 1.04, missileTaken: 1.1, charge: 1.45, morale: 4 },
    idlePose: 'alert',
  },

  loose: {
    id: 'loose',
    name: 'Loose',
    description: 'Spread out to blunt arrows and artillery. Weak in a shoving match.',
    // The scattered orders set their own spacing, so these multipliers hold the absolute
    // figure across the change to the base: their jitter scales with it, and a mob 30% deeper
    // has 30% fewer men per metre of seam, which quietly emptied the fighting line.
    spacingXMul: 1.77,
    spacingZMul: 1.4,
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
    frontMul: 1,
    mods: { shield: 0.8, attack: 0.94, speed: 1.1, missileTaken: 0.52, charge: 0.85, morale: -2 },
    idlePose: 'alert',
  },

  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    description: 'A thin screen with room to throw and run. Nothing to hold a line with.',
    spacingXMul: 2.17,
    spacingZMul: 1.63,
    width: (s) => Math.max(10, Math.round(Math.sqrt(s * 6.5))),
    offset(out, slot, width, _ranks, sx, sz) {
      const rank = Math.floor(slot / width);
      const file = slot % width;
      const jx = (hash01(slot, 31) - 0.5) * sx * 1.15;
      const jz = (hash01(slot, 47) - 0.5) * sz * 1.15;
      out.x = centredX(file, width, sx) + jx;
      out.z = -rank * sz + jz;
    },
    frontMul: 1,
    mods: { shield: 0.7, attack: 0.85, speed: 1.18, missileTaken: 0.42, charge: 0.6, morale: -4 },
    idlePose: 'alert',
  },

  horde: {
    id: 'horde',
    name: 'Horde',
    description: 'No order at all — a mass of men pressing forward. Fast, ferocious, uncontrollable.',
    spacingXMul: 1.05,
    spacingZMul: 0.78,
    // A mob is broad, not a column. At sqrt(s*1.5) a 360-man warband was 23 men across
    // and *sixteen* ranks deep, so barely a third of the men a Roman cohort of the same
    // size could bring to bear ever reached the fighting — a warband lost every melee on
    // geometry before a single stat was compared.
    width: (s) => Math.max(10, Math.round(Math.sqrt(s * 4.0))),
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
    frontMul: 1,
    mods: { shield: 0.72, attack: 1.06, speed: 1.14, missileTaken: 1.22, charge: 1.2, morale: 6 },
    idlePose: 'relaxed',
  },
};

export const formation = (id: string): FormationDef => FORMATIONS[id] ?? FORMATIONS.line;

/** Ranks needed to fit `n` men at the given width. */
export const ranksFor = (n: number, width: number): number => Math.max(1, Math.ceil(n / Math.max(1, width)));

/** Approximate frontage in metres — used for collision extents and UI banners. */
export const frontageOf = (width: number, spacingX: number): number => width * spacingX;

// ---------------------------------------------------------------------------
// Front-rank geometry
//
// A formation's front rank is a *segment*, not a point, and every question about two
// formations meeting — are they touching, which way is the enemy, how far do I still
// have to walk — is wrong if it is asked about the anchors. Two cohorts 22 m wide
// standing shoulder to shoulder have anchors 22 m apart and front ranks in contact.
// These live here because they are formation geometry, and both the sim and the AI
// need exactly the same answer.
// ---------------------------------------------------------------------------

export interface Segment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export const makeSegment = (): Segment => ({ x1: 0, z1: 0, x2: 0, z2: 0 });

/** Write the front-rank segment of a body of men centred at (x,z) facing `facing`. */
export const frontSegment = (
  x: number,
  z: number,
  facing: number,
  halfFront: number,
  out: Segment
): void => {
  // The unit's right-hand vector: facing rotated +90 degrees.
  const rx = Math.cos(facing);
  const rz = -Math.sin(facing);
  out.x1 = x - rx * halfFront;
  out.z1 = z - rz * halfFront;
  out.x2 = x + rx * halfFront;
  out.z2 = z + rz * halfFront;
};

/** Squared distance from point P to segment AB. */
export const pointSegDist2 = (
  px: number, pz: number, ax: number, az: number, bx: number, bz: number
): number => {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((px - ax) * abx + (pz - az) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
};

/** Distance between two segments; zero if they cross. */
export const segmentDistance = (a: Segment, b: Segment): number => {
  const d1x = a.x2 - a.x1;
  const d1z = a.z2 - a.z1;
  const d2x = b.x2 - b.x1;
  const d2z = b.z2 - b.z1;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) > 1e-9) {
    const sx = b.x1 - a.x1;
    const sz = b.z1 - a.z1;
    const t = (sx * d2z - sz * d2x) / denom;
    const s = (sx * d1z - sz * d1x) / denom;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  let best = pointSegDist2(a.x1, a.z1, b.x1, b.z1, b.x2, b.z2);
  best = Math.min(best, pointSegDist2(a.x2, a.z2, b.x1, b.z1, b.x2, b.z2));
  best = Math.min(best, pointSegDist2(b.x1, b.z1, a.x1, a.z1, a.x2, a.z2));
  best = Math.min(best, pointSegDist2(b.x2, b.z2, a.x1, a.z1, a.x2, a.z2));
  return Math.sqrt(best);
};

/**
 * Closest point on segment `s` to (px,pz), written into `out`.
 *
 * This is the aim point an attack order must use. Aiming at the target's *centre*
 * makes two laterally-offset formations each crab sideways onto the other's centre
 * while the other does the same — mutual pursuit, whose solution curve is a spiral.
 * Projecting onto the enemy's frontage instead gives an aim point that stops moving
 * the moment you are square on to it, so the approach converges head-on.
 */
export const closestPointOnSegment = (
  px: number, pz: number, s: Segment, out: { x: number; z: number }
): void => {
  const abx = s.x2 - s.x1;
  const abz = s.z2 - s.z1;
  const len2 = abx * abx + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((px - s.x1) * abx + (pz - s.z1) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.x = s.x1 + abx * t;
  out.z = s.z1 + abz * t;
};
