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
  /**
   * The neck scarf. Its own slot rather than the tunic's, because it was the one piece of
   * kit a legionary bought for himself and twenty identical scarlet collars in a row is as
   * loud a uniformity tell as twenty identical helmets.
   */
  Focale = 8,
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
  /**
   * The man's metal, packed into one float for the shader's metal tint slot: the integer
   * part is the class (0 iron, 1 bronze, 2 blackened or pitted, 3 tinned or silvered) and
   * the fraction is `polish * 0.9`, 0 dull to 0.9 bright.
   *
   * Packed rather than given two lanes because the instance attributes are full, and
   * because the two are decided together — nobody polishes a rusted heirloom.
   */
  metal: number;
}

const bit = (p: number): number => (p < 24 ? 2 ** p : 2 ** (p - 24));
const isHi = (p: number): boolean => p >= 24;

/** Linear RGB from a hex colour, matching THREE's sRGB -> linear working space. */
const srgbToLinear = (c: number): [number, number, number] => {
  const f = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [f(((c >> 16) & 255) / 255), f(((c >> 8) & 255) / 255), f((c & 255) / 255)];
};

/**
 * Pull a colour part-way toward its own luminance.
 *
 * A hex value that looks like a good red on screen is a *display* colour; converted to
 * linear it is far more saturated than dyed wool ever is. Roman red at 0xa8262b comes out
 * as (0.40, 0.019, 0.025) linear — green and blue effectively zero — and a channel that is
 * zero stays zero however it is lit, so the tunic renders black in anything but direct sun.
 * A madder or kermes dye measured off surviving textile is nowhere near that pure.
 */
const desaturate = (c: [number, number, number], k: number): [number, number, number] => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] + (l - c[0]) * k, c[1] + (l - c[1]) * k, c[2] + (l - c[2]) * k];
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
  const hr = r(3);
  switch (ap.helmet) {
    case 'imperial-gallic':
      // 271 AD is mid-transition: the older Imperial Gallic bowl is still in the ranks
      // alongside the new two-piece ridge helmet the reforms brought in, and a few men
      // have dug an even older bronze Coolus out of stores.
      helmet = hr < 0.5 ? Piece.HelmGallic : hr < 0.9 ? Piece.HelmRidge : Piece.HelmCoolus;
      break;
    case 'intercisa':
      helmet = hr < 0.86 ? Piece.HelmRidge : Piece.HelmGallic;
      break;
    case 'coolus':
      helmet = hr < 0.62 ? Piece.HelmCoolus : hr < 0.9 ? Piece.HelmGallic : Piece.HelmRidge;
      break;
    case 'spangenhelm':
      // Iron was expensive in the barbaricum; even a chosen man's warband is not
      // uniformly helmeted, and a fur cap does duty for the rest.
      helmet = hr < 0.62 ? Piece.HelmSpangen : hr < 0.8 ? Piece.HelmFur : -1;
      break;
    case 'fur-cap':
      helmet = hr < 0.5 ? Piece.HelmFur : hr < 0.62 ? Piece.HelmSpangen : -1;
      break;
    case 'none':
      // A minority of tribesmen have looted, inherited or traded for a head covering.
      helmet = hr < variance * 0.2 ? Piece.HelmSpangen
        : hr < variance * 0.46 ? Piece.HelmFur : -1;
      break;
  }
  if (helmet >= 0) add(helmet);

  if (helmet >= 0) {
    const crestRoll = r(4);
    switch (ap.crest) {
      case 'transverse': if (crestRoll < 0.9) add(Piece.CrestTransverse); break;
      case 'longitudinal': if (crestRoll < 0.74) add(Piece.CrestLongitudinal); break;
      case 'plume': if (crestRoll < 0.82) add(Piece.CrestPlume); break;
      case 'horns': if (crestRoll < 0.45) add(Piece.CrestHorns); break;
      case 'feather': if (crestRoll < 0.7) add(Piece.CrestPlume); break;
      case 'none':
        // Crest boxes and feather tubes turn up on third-century helmets even where a plume
        // was not issue kit, and the Rome II reference frames show roughly a quarter of a
        // legionary line crested — some with a black feather pair, some with a horsehair
        // ridge. That proportion is what actually breaks up a helmet line.
        if (!germanic) {
          if (crestRoll < 0.16) add(Piece.CrestPlume);
          else if (crestRoll < 0.26) add(Piece.CrestLongitudinal);
        }
        break;
    }
  }

  // ---- torso ---------------------------------------------------------------
  // Some tribesmen fought stripped whatever their warband's habit; Tacitus and the
  // Antonine column both show it. It is the biggest single change to a silhouette
  // available for one hash draw.
  const bare = ap.bareChested || (germanic && r(17) < variance * 0.15);
  if (bare) {
    add(Piece.TorsoBare);
    if (r(5) < 0.75) add(Piece.Torc);
  } else {
    add(Piece.Tunic);
    if (!germanic) add(Piece.Focale);
    // A torc is a mark of standing, not of nakedness.
    else if (r(5) < variance * 0.24) add(Piece.Torc);
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

  // A cloak is bought, not issued. High `variance` makes it *less* certain, not more: a
  // warband where nine men in ten wear the same sagum reads as uniform, which is the one
  // thing a warband is not.
  if (ap.cloak && r(7) < (germanic ? 0.44 + variance * 0.18 : 0.55 + variance * 0.4)) {
    add(Piece.Cloak);
  } else if (!ap.cloak && germanic && r(7) < variance * 0.3) add(Piece.Cloak);

  // ---- legs ----------------------------------------------------------------
  // Bracae reached Italy with the auxiliaries and by the late third century were normal
  // even in the legions, so the line is a mix of bare-legged and trousered men.
  const trousers = germanic ? r(8) < 0.9 : r(8) < 0.42;
  add(trousers ? Piece.LegsTrousers : Piece.LegsBare);
  if (!bare || r(9) < 0.6) add(Piece.Boots);

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
  // A tribal host had no dyer and no quartermaster, so a Germanic man's cloth comes from a
  // palette of plausible dye lots rather than from one roster colour nudged a few percent:
  // undyed grey-brown wool, madder red-brown, weld ochre, woad-over-yellow green, and the
  // near-black of an iron-mordanted lot. Roman units keep the roster colour, because an
  // issued tunic is exactly what makes a cohort read as a cohort.
  const GERMANIC_CLOTH: readonly number[] = [
    0x6e6552, 0x7a4b34, 0x8a7440, 0x4e5a3f, 0x3b3730, 0x5c6349, 0x6b4a3a,
  ];
  const GERMANIC_LEG: readonly number[] = [
    0x6b5a44, 0x574b3c, 0x7b6448, 0x4a4034, 0x6e5f4a,
  ];
  const tunic = desaturate(srgbToLinear(
    germanic ? GERMANIC_CLOTH[Math.floor(r(18) * GERMANIC_CLOTH.length)] : ap.tunicColour
  // Pulled a good way toward its own luminance. A vegetable-dyed red at full saturation has
  // effectively no green or blue, and a channel that starts at zero stays at zero however it
  // is lit — which is measurably why a tunic read as black: the men's median rendered
  // luminance was 0.014 display-linear. Desaturating lifts the dead channels without
  // pretending the dye was brighter than it was.
  ), 0.34);
  const leg = desaturate(srgbToLinear(
    germanic ? GERMANIC_LEG[Math.floor(r(19) * GERMANIC_LEG.length)] : ap.legColour
  ), 0.1);
  // On top of the lot, per-man fading. Scaled by the unit's `variance`: a praetorian cohort
  // drifts a few percent and reads as issued kit, a warband drifts by half.
  const spread = 0.10 + variance * 0.5;
  const d0 = (r(10) - 0.5) * spread;
  const d1 = (r(11) - 0.5) * spread;
  const d2 = (r(12) - 0.5) * spread;
  const dl = (r(13) - 0.5) * spread;
  // Wool takes dye better than the display value suggests: 1.3x puts a madder tunic in the
  // 0.10-0.25 linear band that a surviving textile measures at.
  out.tunic = [
    Math.max(0.01, tunic[0] * (1 + d0) * 1.3),
    Math.max(0.01, tunic[1] * (1 + d1) * 1.3),
    Math.max(0.01, tunic[2] * (1 + d2) * 1.3),
  ];
  // Undyed wool and linen swatches are pale, but a legionary's bracae after three days on
  // the Via Flaminia are not. Soiling is a *warm* multiply, not a scalar one: road dust is
  // ochre, so dirty wool goes tan, and knocking all three channels down equally is exactly
  // what left these reading as pale grey trousers. The dust load varies per man, because a
  // front-ranker's legs and a rear-ranker's are not equally filthy.
  const dust = 0.86 + r(20) * 0.3;
  const soil: [number, number, number] = [0.78 * dust, 0.7 * dust, 0.56 * dust];
  out.leg = [
    Math.max(0.01, leg[0] * (1 + dl) * soil[0]),
    Math.max(0.01, leg[1] * (1 + dl * 0.6) * soil[1]),
    Math.max(0.01, leg[2] * (1 - dl * 0.4) * soil[2]),
  ];

  // ---- metal ---------------------------------------------------------------
  // Which metal, and how well kept. A single dark iron for every helmet on the field is the
  // reason a Roman line reads as one man repeated two thousand times, and the fix is not
  // subtle shading — it is that these men genuinely did not all own the same helmet.
  //
  //   praetorians   tinned and silvered helmets, gilt fittings: the parade end.
  //   legionaries   mostly plain iron ridge helmets, but the older Imperial Gallic bowls
  //                 carry brass trim and a handful of Coolus helmets are solid bronze.
  //   second line   iron, going rusty, with whatever bronze was to hand.
  //   germanic      most iron in the barbaricum is a generation old and pitted; bronze
  //                 fittings arrive by trade and by looting.
  const mr = r(16);
  let metalClass: number;
  if (germanic) {
    metalClass = mr < 0.44 ? 2 : mr < 0.8 ? 0 : 1;
  } else if (def.armour > 60) {
    metalClass = mr < 0.4 ? 3 : mr < 0.74 ? 1 : 0;
  } else if (def.armour > 45) {
    metalClass = mr < 0.54 ? 0 : mr < 0.74 ? 1 : mr < 0.88 ? 3 : 2;
  } else {
    metalClass = mr < 0.48 ? 0 : mr < 0.64 ? 1 : 2;
  }
  const polish = germanic ? 0.5 : def.armour > 60 ? 1 : 0.8;
  const kept = Math.max(0.05, Math.min(1, polish * (0.55 + r(14) * 0.85)));
  out.metal = metalClass + kept * 0.9;

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
  tunic: [1, 1, 1], leg: [1, 1, 1], metal: 0.7,
});

/** Pieces a routing man throws away. Shields first — every source says so. */
export const ROUT_DROP_HI =
  bit(Piece.ShieldScutum) | bit(Piece.ShieldOval) | bit(Piece.ShieldRound) |
  bit(Piece.Pilum) | bit(Piece.JavelinBundle);

/** Whether this unit type is drawn mounted. */
export const mounted = (def: UnitTypeDef): boolean => isCavalry(def);
