import { hash01 } from '../util/rand';
import { Faction, type UnitTypeDef } from '../sim/types';
import { isCavalry } from './roster';

/**
 * Kit resolution: which pieces of the union mesh a given man actually wears.
 *
 * The soldier geometry for a faction contains every kit piece that faction can field —
 * five helmet shells, four armour types, three shield shapes, seven weapons — and the
 * vertex shader collapses the ones this man is not wearing. That is what keeps every
 * unit type of a faction inside one draw call: the alternative, a geometry per unit type,
 * would be twelve draw calls before LODs even enter the picture.
 *
 * Every choice is driven by `pool.variant[i]`, the stable per-man hash, so a man's kit is
 * fixed for life. Nothing here may read frame state.
 */

/**
 * Piece ids. Order is arbitrary but must stay under 48 so the mask fits in two floats
 * (a float32 holds integers exactly to 2^24, hence 24 bits per lane).
 */
export const enum Piece {
  Head = 0,
  HairShort = 1,
  HairLong = 2,
  Beard = 3,
  HelmGallic = 4,
  HelmRidge = 5,
  HelmCoolus = 6,
  HelmSpangen = 7,
  HelmFur = 8,
  CrestTransverse = 9,
  CrestLongitudinal = 10,
  CrestPlume = 11,
  CrestHorns = 12,
  Tunic = 13,
  Focale = 14,
  TorsoBare = 15,
  ArmourSegmentata = 16,
  ArmourMail = 17,
  ArmourScale = 18,
  ArmourLeather = 19,
  LegsBare = 20,
  LegsTrousers = 21,
  Boots = 22,
  Cloak = 23,
  // ---- second mask lane, bits 24..47 ----
  ShieldScutum = 24,
  ShieldOval = 25,
  ShieldRound = 26,
  WeaponSword = 27,
  WeaponSpear = 28,
  WeaponAxe = 29,
  WeaponBow = 30,
  Quiver = 31,
  Pilum = 32,
  JavelinBundle = 33,
  Torc = 34,
  /** Gladius in its scabbard on the right hip, worn while the pilum is in the hand. */
  SwordSheathed = 35,
  Count = 36,
}

/**
 * Coarse piece ids used by LOD2 only.
 *
 * Past 130 m a helmet is two pixels and a francisca is one, so the far mesh drops the
 * catalogue and keeps eight silhouette groups. Each man carries a second, coarse mask
 * alongside his fine one and the render system hands whichever the tier wants — the same
 * instance data path, a tenth of the triangles.
 */
export const enum Coarse {
  Body = 0,
  Helmet = 1,
  Armour = 2,
  ShieldBig = 3,
  ShieldRound = 4,
  Pole = 5,
  Blade = 6,
  Cloak = 7,
  Count = 8,
}

/** Which per-instance colour a vertex takes. Mirrors the branch ladder in the shader. */
export const enum Tint {
  /** Use the atlas colour untouched: iron, bronze, wood, mail, leather. */
  Atlas = 0,
  Tunic = 1,
  Legs = 2,
  Skin = 3,
  Hair = 4,
  Cloak = 5,
  /** Shield facing: the fragment shader substitutes the emblem tile. */
  Emblem = 6,
  /** Iron with per-man wear. */
  Metal = 7,
}

/** Emblem tile order in the atlas; index is what the shader receives. */
export const EMBLEMS = [
  'legio-thunderbolt',
  'praetorian-scorpion',
  'urban-wreath',
  'equites-star',
  'germanic-spiral',
  'germanic-sunwheel',
  'germanic-wolf',
  'germanic-plain',
] as const;

const EMBLEM_INDEX = new Map<string, number>(EMBLEMS.map((e, i) => [e, i]));

export interface ResolvedKit {
  /** Bits 0..23 of the piece mask. */
  maskLo: number;
  /** Bits 24..47. */
  maskHi: number;
  /** `maskHi` with the melee weapon drawn and the missile gone. */
  maskHiMelee: number;
  /** Eight-group mask for LOD2. */
  maskCoarse: number;
  emblem: number;
  tunic: [number, number, number];
  leg: [number, number, number];
  /** 0 rusty .. 1 bright, for the metal tint slot. */
  wear: number;
}

const bit = (p: number): number => (p < 24 ? 2 ** p : 2 ** (p - 24));
const isHi = (p: number): boolean => p >= 24;

/** Linear RGB from a hex colour, matching THREE's sRGB -> linear working space. */
const srgbToLinear = (c: number): [number, number, number] => {
  const f = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [f(((c >> 16) & 255) / 255), f(((c >> 8) & 255) / 255), f((c & 255) / 255)];
};

/**
 * Resolve one man's kit.
 *
 * `variant` is his stable hash; the several `hash01` re-hashes of it give independent
 * decisions from the one stored number, so helmet choice does not correlate with beard
 * choice and produce visible stripes across a rank.
 */
export function resolveKit(def: UnitTypeDef, variant: number, out: ResolvedKit): ResolvedKit {
  let lo = 0;
  let hi = 0;
  const add = (p: number): void => {
    if (isHi(p)) hi |= bit(p);
    else lo |= bit(p);
  };

  // Decorrelated draws from the one stored hash.
  const seed = Math.floor(variant * 16777216);
  const r = (salt: number): number => hash01(seed, salt);

  const ap = def.appearance;
  const germanic = def.faction === Faction.Germanic;
  const variance = ap.variance;

  add(Piece.Head);

  // ---- head ----------------------------------------------------------------
  // Third-century Roman soldiers wore beards more often than not — the fashion runs
  // from Hadrian to the Severans — but kept the hair short. Germanic warriors are
  // described by every Roman source as long-haired and bearded, which is exactly why
  // the Romans kept saying it.
  if (germanic) {
    add(r(1) < 0.86 ? Piece.HairLong : Piece.HairShort);
    if (r(2) < 0.82) add(Piece.Beard);
  } else {
    add(Piece.HairShort);
    if (r(2) < 0.42) add(Piece.Beard);
  }

  let helmet: Piece | -1 = -1;
  switch (ap.helmet) {
    case 'imperial-gallic':
      // 271 AD is mid-transition: the older Imperial Gallic bowl is still in the ranks
      // alongside the new two-piece ridge helmet the reforms brought in.
      helmet = r(3) < 0.62 ? Piece.HelmGallic : Piece.HelmRidge;
      break;
    case 'intercisa':
      helmet = Piece.HelmRidge;
      break;
    case 'coolus':
      helmet = r(3) < 0.75 ? Piece.HelmCoolus : Piece.HelmGallic;
      break;
    case 'spangenhelm':
      // Iron was expensive in the barbaricum; even a chosen man's warband is not
      // uniformly helmeted.
      helmet = r(3) < 0.72 ? Piece.HelmSpangen : -1;
      break;
    case 'fur-cap':
      helmet = r(3) < 0.55 ? Piece.HelmFur : -1;
      break;
    case 'none':
      // A minority of tribesmen have looted or inherited a helmet.
      helmet = r(3) < variance * 0.22 ? Piece.HelmSpangen : -1;
      break;
  }
  if (helmet >= 0) add(helmet);

  if (helmet >= 0) {
    switch (ap.crest) {
      case 'transverse': add(Piece.CrestTransverse); break;
      case 'longitudinal': add(Piece.CrestLongitudinal); break;
      case 'plume': add(Piece.CrestPlume); break;
      case 'horns': if (r(4) < 0.45) add(Piece.CrestHorns); break;
      case 'feather': add(Piece.CrestPlume); break;
      case 'none': break;
    }
  }

  // ---- torso ---------------------------------------------------------------
  if (ap.bareChested) {
    add(Piece.TorsoBare);
    if (r(5) < 0.75) add(Piece.Torc);
  } else {
    add(Piece.Tunic);
    if (!germanic) add(Piece.Focale);
  }

  switch (ap.armour) {
    case 'segmentata':
      // The banded cuirass is on its way out; a good third of the cohort is in mail.
      add(r(6) < 0.66 ? Piece.ArmourSegmentata : Piece.ArmourMail);
      break;
    case 'hamata': add(Piece.ArmourMail); break;
    case 'squamata': add(Piece.ArmourScale); break;
    case 'leather':
      // "Leather" for a tribesman means a hide jerkin, and plenty have nothing.
      if (r(6) < 0.55 + variance * 0.2) add(Piece.ArmourLeather);
      break;
    case 'cloth': break;
    case 'none': break;
  }

  if (ap.cloak && r(7) < 0.55 + variance * 0.4) add(Piece.Cloak);
  else if (!ap.cloak && germanic && r(7) < variance * 0.28) add(Piece.Cloak);

  // ---- legs ----------------------------------------------------------------
  // Bracae reached Italy with the auxiliaries and by the late third century were normal
  // even in the legions, so the line is a mix of bare-legged and trousered men.
  const trousers = germanic ? r(8) < 0.94 : r(8) < 0.38;
  add(trousers ? Piece.LegsTrousers : Piece.LegsBare);
  if (!ap.bareChested || r(9) < 0.6) add(Piece.Boots);

  // ---- shield --------------------------------------------------------------
  switch (ap.shield) {
    case 'scutum': add(Piece.ShieldScutum); break;
    case 'oval': add(Piece.ShieldOval); break;
    case 'round': add(Piece.ShieldRound); break;
    case 'hexagonal': add(Piece.ShieldOval); break;
    case 'none': break;
  }

  // ---- weapons -------------------------------------------------------------
  // A man has one thing in his right hand. Before contact that is his missile — the
  // pilum, the bundle of framea — and the sword stays in its scabbard on the hip; in
  // melee the missile is gone and the blade is out. `maskHiMelee` is the same mask with
  // that swap already applied, so the renderer only has to choose between two numbers.
  const meleeOf = (kind: string): Piece => {
    switch (kind) {
      case 'spear': case 'pike': return Piece.WeaponSpear;
      case 'axe': return Piece.WeaponAxe;
      default: return Piece.WeaponSword;
    }
  };
  const thrownOf = (kind: string | undefined): Piece | -1 => {
    switch (kind) {
      case 'pilum': return Piece.Pilum;
      case 'javelin': case 'framea': return Piece.JavelinBundle;
      default: return -1;
    }
  };

  let melee: Piece;
  let inHand: Piece | -1;
  if (ap.weapon === 'bow' || ap.weapon === 'sling') {
    add(Piece.WeaponBow);
    add(Piece.Quiver);
    // An archer's sidearm stays sheathed until something reaches him.
    melee = meleeOf(ap.sidearm ?? 'gladius');
    inHand = -1;
    add(Piece.SwordSheathed);
  } else {
    const thrownPrimary = thrownOf(ap.weapon);
    if (thrownPrimary >= 0) {
      inHand = thrownPrimary;
      melee = meleeOf(ap.sidearm ?? 'gladius');
    } else {
      melee = meleeOf(ap.weapon);
      const thrown = thrownOf(ap.sidearm);
      inHand = thrown >= 0 ? thrown : melee;
    }
    if (melee === Piece.WeaponSword && inHand !== Piece.WeaponSword) add(Piece.SwordSheathed);
  }
  if (inHand >= 0) add(inHand);

  // The melee variant: drop whatever was in the hand, draw the melee weapon, and put the
  // scabbard away only if the sword itself is what comes out of it.
  let meleeHi = hi;
  if (inHand >= 0 && isHi(inHand) && inHand !== melee) meleeHi &= ~bit(inHand);
  if (isHi(melee)) meleeHi |= bit(melee);
  if (melee === Piece.WeaponSword) meleeHi &= ~bit(Piece.SwordSheathed);

  // ---- colour --------------------------------------------------------------
  const tunic = srgbToLinear(ap.tunicColour);
  const leg = srgbToLinear(ap.legColour);
  // Cloth was dyed in small lots from whatever was to hand, and a tribal host had no dyer
  // at all. The spread is therefore scaled by the unit's `variance`: a praetorian cohort
  // drifts a few percent and reads as issued kit, a warband drifts a third and reads as
  // two hundred men who each dressed themselves.
  const spread = 0.08 + variance * 0.34;
  const d0 = (r(10) - 0.5) * spread;
  const d1 = (r(11) - 0.5) * spread;
  const d2 = (r(12) - 0.5) * spread;
  const dl = (r(13) - 0.5) * spread;
  out.tunic = [
    Math.max(0.01, tunic[0] * (1 + d0)),
    Math.max(0.01, tunic[1] * (1 + d1)),
    Math.max(0.01, tunic[2] * (1 + d2)),
  ];
  out.leg = [
    Math.max(0.01, leg[0] * (1 + dl)),
    Math.max(0.01, leg[1] * (1 + dl * 0.6)),
    Math.max(0.01, leg[2] * (1 - dl * 0.4)),
  ];
  // Praetorians and cavalry keep their kit bright; a tribesman's iron is pitted.
  const polish = germanic ? 0.32 : def.armour > 60 ? 0.95 : 0.68;
  out.wear = Math.max(0, Math.min(1, polish * (0.6 + r(14) * 0.8)));

  out.maskLo = lo;
  out.maskHi = hi;
  out.maskHiMelee = meleeHi;

  // Collapse to silhouette groups for the far tier.
  let coarse = 1 << Coarse.Body;
  const HELMETS = bit(Piece.HelmGallic) | bit(Piece.HelmRidge) | bit(Piece.HelmCoolus) |
    bit(Piece.HelmSpangen) | bit(Piece.HelmFur);
  const ARMOURS = bit(Piece.ArmourSegmentata) | bit(Piece.ArmourMail) |
    bit(Piece.ArmourScale) | bit(Piece.ArmourLeather);
  if (lo & HELMETS) coarse |= 1 << Coarse.Helmet;
  if (lo & ARMOURS) coarse |= 1 << Coarse.Armour;
  if (lo & bit(Piece.Cloak)) coarse |= 1 << Coarse.Cloak;
  if (hi & (bit(Piece.ShieldScutum) | bit(Piece.ShieldOval))) coarse |= 1 << Coarse.ShieldBig;
  if (hi & bit(Piece.ShieldRound)) coarse |= 1 << Coarse.ShieldRound;
  if (hi & (bit(Piece.WeaponSpear) | bit(Piece.Pilum) | bit(Piece.JavelinBundle) | bit(Piece.WeaponBow))) {
    coarse |= 1 << Coarse.Pole;
  }
  if (hi & (bit(Piece.WeaponSword) | bit(Piece.WeaponAxe) | bit(Piece.SwordSheathed))) {
    coarse |= 1 << Coarse.Blade;
  }
  out.maskCoarse = coarse;
  out.emblem = EMBLEM_INDEX.get(ap.shieldEmblem) ?? EMBLEMS.length - 1;
  // Germanic shields were individually painted; give the host four devices to draw from.
  if (germanic && ap.shield !== 'none') {
    const pool = [4, 5, 6, 7];
    out.emblem = pool[Math.floor(r(15) * pool.length)];
  }
  return out;
}

export const emptyKit = (): ResolvedKit => ({
  maskLo: 0, maskHi: 0, maskHiMelee: 0, maskCoarse: 0, emblem: 0,
  tunic: [1, 1, 1], leg: [1, 1, 1], wear: 0.7,
});

/** Pieces a routing man throws away. Shields first — every source says so. */
export const ROUT_DROP_HI =
  bit(Piece.ShieldScutum) | bit(Piece.ShieldOval) | bit(Piece.ShieldRound) |
  bit(Piece.Pilum) | bit(Piece.JavelinBundle);

/** Whether this unit type is drawn mounted. */
export const mounted = (def: UnitTypeDef): boolean => isCavalry(def);
