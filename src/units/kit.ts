import { hash01 } from '../util/rand';
import { Faction, type Culture, type UnitTypeDef } from '../sim/types';
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
  // ---- Carthaginian additions ----
  /** Bronze Attic bowl: raised volute over the brow, hinged cheek pieces, tall crest box. */
  HelmAttic = 36,
  /** Iberian sinew cap — boiled leather over a felt lining, with a horsehair topknot. */
  HelmIberian = 37,
  /** The Greek aspis: 0.9 m, deeply dished, offset rim. Twice the area of a round shield. */
  ShieldHoplon = 38,
  /** The Iberian caetra: a 0.4 m centre-gripped buckler with a domed iron boss. */
  ShieldCaetra = 39,
  /** The falcata — forward-curving, weight in the last third, knuckle guard looping to the pommel. */
  WeaponFalcata = 40,
  /** A sling: two cords and a leather cradle, held at the ready. Never a bow. */
  WeaponSling = 41,
  /** The bag of lead glandes and river stones on the hip, and the spare slings about the head. */
  SlingPouch = 42,
  /** Glued layered-linen corslet: shoulder yokes standing proud, pteruges at the skirt. */
  ArmourLinen = 43,
  /** Bronze greaves, moulded to the calf and sprung on. Hellenistic infantry, not Roman. */
  Greaves = 44,
  Count = 45,
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
  /**
   * The inside of a shield.
   *
   * Its own slot because it is, by a wide margin, the largest single surface a soldier
   * presents to a camera standing behind his line: measured by difference over the
   * `romanline` frame, shield pixels are 11.9% of the whole image — three times the armour
   * and four times the helmets. Left untinted it was one repeated tan plank texture across
   * every man in the cohort, which is the loudest uniformity tell the Roman frames had.
   * Real scuta were hide-faced front and back and the facing was whatever the owner could
   * get: oiled leather, red-brown paint carried round the rim, grey felt, bare limewood.
   */
  ShieldBack = 9,
  /**
   * Helmet crest, plume and feather.
   *
   * Its own slot because the atlas can only hold one strand texture and a crest is the most
   * conspicuous thing on a man: it sits above the helmet line where nothing occludes it. Left
   * on the atlas colour every crested legionary in the army wore the same madder-red
   * horsehair, where the reference frames show black feather pairs, white horsehair and red
   * within one cohort. The tile is therefore drawn neutral and coloured from here.
   */
  Crest = 10,
}

/**
 * Emblem tile order in the atlas; index is what the shader receives.
 *
 * **The order is load-bearing and the bands must stay contiguous.** `skinShader.ts` decides
 * how to paint a shield — both its face and its back — from this index alone, because the
 * instance attributes are full and there is no lane left for a style code. It used to be one
 * comparison, `iCol0.w > 3.5`, meaning "tiles 4 and up are tribal". There are now three
 * styles and therefore two comparisons, and they read the boundaries below:
 *
 *     0..3    ROMAN    an issued board: one field colour per unit, nudged per man, dark back
 *     4..8    TRIBAL   individually painted limewood, whitewash to pitch, pale back
 *     9..13   PUNIC    a bright uniform field with a bold device, and a plain hide back
 *
 * Appending inside a band is free. Moving a tile between bands silently repaints an army.
 */
export const EMBLEMS = [
  'legio-thunderbolt',
  'praetorian-scorpion',
  'urban-wreath',
  'equites-star',
  /*
   * Two more hands on the *same* device, appended inside the Roman band.
   *
   * Two blind graders, given the nine testudo plates independently, both named one thing as
   * the worst fault in the set and both reached for the same phrase — "the same picture,
   * recoloured". Per-man rotation, scale, offset and paint loss were already there and none
   * of them answered it, because they are transforms of one image and a grader is looking
   * for a different image.
   *
   * A legion's shields *did* carry one device, so giving a cohort four blazons would trade a
   * correct criticism for a wrong build. What a legion's shields did not have is one painter.
   * `resolveKit` draws a legionary's board from these three, all of which are a winged
   * thunderbolt on a red field and none of which is the same picture: different wing sweep,
   * a dropped or deepened middle covert, different bolt count and stroke weight. See
   * `drawEmblem` in `atlas.ts`; the first of the three is byte-for-byte the one that shipped.
   *
   * They sit here rather than at the end because the bands must stay contiguous and a Roman
   * board takes the Roman treatment — one field colour per unit, dark back. Appending them
   * after `numidian-crescent` would have given a legionary a bright uniform Punic field.
   * `EMBLEM_TRIBAL_FIRST` and `EMBLEM_PUNIC_FIRST` below move with them, and so do the two
   * tribal pools in `resolveKit`.
   */
  'legio-thunderbolt-b',
  'legio-thunderbolt-c',
  'germanic-spiral',
  'germanic-sunwheel',
  'germanic-wolf',
  'germanic-plain',
  // Still in the *tribal* band, and deliberately: Hannibal's Gauls painted their own boards
  // exactly as the Juthungi do, so they must take the individually-painted treatment rather
  // than a uniform Punic field. What separates them from the Juthungi on screen is their dye
  // lots and their kit, not a shield style — which is the truthful distinction, because at
  // the Trebia the difference between a Gaul in Roman service and a Gaul in Punic service
  // was who was paying.
  'celtic-triskele',
  // ---- Punic band ----
  // The sign of Tanit: a trapezoid body, a horizontal bar for arms, a disc for a head. It is
  // on stelae, mosaics and coins all over Punic North Africa and it is the one device that
  // says "Carthage" at forty metres without a caption.
  'punic-tanit',
  // The horse's head that Carthage put on its own silver, from the foundation legend: Dido's
  // men dug on Byrsa and turned up a horse's skull, which the augurs read as war and plenty.
  'punic-horse',
  // The palm — *phoinix* in Greek, the pun the Greeks made on "Phoenician", and the other
  // standing type on Carthaginian coinage.
  'punic-palm',
  // Iberians whitened their shields with chalk-and-size and ran a crimson border round the
  // rim; Livy singles out the linen tunics with purple edging at the Trebia.
  'iberian-white',
  // The Numidian crescent, which is on their kings' coinage and is still on the flags of the
  // countries that sit where Numidia was.
  'numidian-crescent',
] as const;

/** First index of each style band. See the comment on `EMBLEMS`, and `skinShader.ts`. */
export const EMBLEM_TRIBAL_FIRST = 6;
export const EMBLEM_PUNIC_FIRST = 11;

const EMBLEM_INDEX = new Map<string, number>(EMBLEMS.map((e, i) => [e, i]));

/** The issued legionary board, and the three hands that painted it. See `EMBLEMS`. */
const EMBLEM_LEGIO = EMBLEM_INDEX.get('legio-thunderbolt') ?? 0;
const LEGIO_HANDS = [
  EMBLEM_LEGIO,
  EMBLEM_INDEX.get('legio-thunderbolt-b') ?? EMBLEM_LEGIO,
  EMBLEM_INDEX.get('legio-thunderbolt-c') ?? EMBLEM_LEGIO,
];

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
  /**
   * Habits, not allegiance. See `Culture` in `sim/types.ts` for why these are separate.
   *
   * Every trait below is written so that `roman` reproduces the old `!germanic` branch and
   * `germanic` the old `germanic` branch, expression for expression and salt for salt. Kit
   * never touches the soldier pool so it cannot move a determinism hash, but a man's
   * appearance changing under the shipped battle would be a silent visual regression, and
   * the screenshots in docs/ are the record it would break.
   */
  const culture: Culture = ap.culture
    ?? (def.faction === Faction.Germanic ? 'germanic'
      : def.faction === Faction.Carthage ? 'punic' : 'roman');
  const germanic = culture === 'germanic';
  /** Long hair and a beard as the norm, rather than the exception. */
  const longHaired = germanic || culture === 'celtic' || culture === 'iberian';
  /** Bracae. Roman legs are bare more often than not even in 271; Mediterranean legs always. */
  const trousered = germanic || culture === 'celtic';
  /** The focale is a Roman article of dress and nobody else wore one. */
  const wearsFocale = culture === 'roman';
  /**
   * Clothed from dye lots the man got himself rather than from a quartermaster.
   *
   * True for every barbarian contingent and, importantly, false for `punic` and `libyan`:
   * Carthage did issue its citizen troops, and the Libyan foot were re-equipped wholesale
   * out of captured Roman stores after Trasimene, which is the opposite of self-supply.
   */
  const ownCloth = germanic || culture === 'celtic' || culture === 'iberian'
    || culture === 'numidian';
  /** Fights stripped often enough to be worth a hash draw. Gauls did; Livy is explicit. */
  const mayStrip = germanic || culture === 'celtic';
  const variance = ap.variance;

  add(Piece.Head);

  // ---- head ----------------------------------------------------------------
  // Third-century Roman soldiers wore beards more often than not — the fashion runs
  // from Hadrian to the Severans — but kept the hair short. Germanic warriors are
  // described by every Roman source as long-haired and bearded, which is exactly why
  // the Romans kept saying it.
  //
  // Iberians are in the long-haired list on Strabo's authority — he describes them wearing
  // the hair long and binding it back for battle — and Numidians are not, because Numidian
  // riders are shown cropped on the Trajanic and Severan reliefs.
  if (longHaired) {
    add(r(1) < 0.86 ? Piece.HairLong : Piece.HairShort);
    if (r(2) < 0.82) add(Piece.Beard);
  } else {
    add(Piece.HairShort);
    // Punic and Libyan men wore full beards — the votive stelae from the tophet are nearly
    // all bearded — where a third-century Roman is bearded rather more often than not and a
    // Numidian usually is not.
    const beardRate = culture === 'punic' || culture === 'libyan' ? 0.78
      : culture === 'numidian' ? 0.3 : 0.42;
    if (r(2) < beardRate) add(Piece.Beard);
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
    case 'attic':
      // The Hellenistic panoply Carthage's citizen troops bought into. A minority of a
      // wealthy body still turn out in an older Montefortino bought or taken from Italy —
      // Punic and Roman helmet finds from Sicily and Sardinia are frequently the same types.
      helmet = hr < 0.78 ? Piece.HelmAttic : Piece.HelmCoolus;
      break;
    case 'iberian-sinew':
      // Diodorus says the Iberians wore sinew caps; the bronze *montefortino* found across
      // the Meseta says the better-off did not. Both, in the proportion the graves suggest.
      helmet = hr < 0.6 ? Piece.HelmIberian : hr < 0.84 ? Piece.HelmCoolus : -1;
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
        // Crest boxes are near-universal on an Attic helmet — that is what the raised stalk
        // over the brow is *for* — so a Punic citizen line is far more crested than a
        // legionary one, and that difference is most of what tells the two lines apart
        // along a skyline.
        if (helmet === Piece.HelmAttic) {
          if (crestRoll < 0.52) add(Piece.CrestLongitudinal);
          else if (crestRoll < 0.72) add(Piece.CrestPlume);
        } else if (!germanic && culture !== 'iberian' && culture !== 'numidian') {
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
  const bare = ap.bareChested || (mayStrip && r(17) < variance * 0.15);
  if (bare) {
    add(Piece.TorsoBare);
    if (r(5) < 0.75) add(Piece.Torc);
  } else {
    add(Piece.Tunic);
    if (wearsFocale) add(Piece.Focale);
    // A torc is a mark of standing, not of nakedness. Celtic mercenaries wore them as
    // readily as any other Gaul — the Vachères warrior and the Dying Gaul both have one.
    else if (mayStrip && r(5) < variance * 0.24) add(Piece.Torc);
  }

  switch (ap.armour) {
    case 'segmentata':
      // The banded cuirass is on its way out; a good third of the cohort is in mail.
      add(r(6) < 0.66 ? Piece.ArmourSegmentata : Piece.ArmourMail);
      break;
    case 'hamata': add(Piece.ArmourMail); break;
    case 'squamata': add(Piece.ArmourScale); break;
    case 'linothorax':
      // A glued-linen corslet was the cheap end of a hoplite panoply and a bronze cuirass or
      // a mail shirt the expensive end, in one phalanx at the same time. Carthage was rich
      // and its citizen body bought its own kit, so a fifth of the Sacred Band is in
      // something better than linen.
      add(r(6) < 0.8 ? Piece.ArmourLinen : Piece.ArmourMail);
      break;
    case 'leather':
      // "Leather" for a tribesman means a hide jerkin, and plenty have nothing.
      if (r(6) < 0.55 + variance * 0.2) add(Piece.ArmourLeather);
      break;
    case 'cloth': break;
    case 'none': break;
  }

  // Bronze greaves are Hellenistic and Iberian, never Roman line kit in this period, and they
  // are worth their piece: a lit metal band at shin height is one of the few kit differences
  // that survives being seen from the front rank of an enemy line.
  if (ap.armour === 'linothorax' && r(21) < 0.72) add(Piece.Greaves);
  else if (culture === 'iberian' && r(21) < variance * 0.3) add(Piece.Greaves);

  // A cloak is bought, not issued. High `variance` makes it *less* certain, not more: a
  // warband where nine men in ten wear the same sagum reads as uniform, which is the one
  // thing a warband is not.
  if (ap.cloak && r(7) < (germanic ? 0.44 + variance * 0.18 : 0.55 + variance * 0.4)) {
    add(Piece.Cloak);
  } else if (!ap.cloak && mayStrip && r(7) < variance * 0.3) add(Piece.Cloak);

  // ---- legs ----------------------------------------------------------------
  // Bracae reached Italy with the auxiliaries and by the late third century were normal
  // even in the legions, so the line is a mix of bare-legged and trousered men.
  // Nobody around the Mediterranean rim wore them: an Iberian, a Libyan, a Numidian and a
  // Carthaginian are all bare-legged under a short tunic, and that alone changes the
  // read of a whole line at fifty metres.
  const trousers = trousered ? r(8) < 0.9 : culture === 'roman' ? r(8) < 0.42 : false;
  add(trousers ? Piece.LegsTrousers : Piece.LegsBare);
  // Numidians are described riding and fighting barefoot; everyone else is shod.
  if (culture === 'numidian') { if (r(9) < 0.35) add(Piece.Boots); }
  else if (!bare || r(9) < 0.6) add(Piece.Boots);

  // ---- shield --------------------------------------------------------------
  switch (ap.shield) {
    case 'scutum': add(Piece.ShieldScutum); break;
    case 'oval': add(Piece.ShieldOval); break;
    case 'round': add(Piece.ShieldRound); break;
    case 'hexagonal': add(Piece.ShieldOval); break;
    case 'hoplon': add(Piece.ShieldHoplon); break;
    case 'caetra': add(Piece.ShieldCaetra); break;
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
      case 'falcata': return Piece.WeaponFalcata;
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
  if (ap.weapon === 'bolt' || ap.weapon === 'boulder') {
    // An artilleryman's weapon is the machine. Both hands are on a handspike, a bolt or a
    // 26 kg stone, so he carries nothing: sidearm on the hip, nothing drawn until something
    // reaches the battery. `maskHiMelee` still draws it, so a crew overrun fights with it.
    //
    // `boulder` is here for the stone-thrower crews in `siegeUnits.ts`. Left out, they fell
    // through to the general case and served an onager with a drawn sword in one hand.
    melee = meleeOf(ap.sidearm ?? 'gladius');
    inHand = -1;
    if (melee === Piece.WeaponSword) add(Piece.SwordSheathed);
  } else if (ap.weapon === 'sling') {
    /**
     * A sling is not a bow, and this branch exists because the code said it was.
     *
     * `'sling'` used to fall in with `'bow'` and be given `Piece.WeaponBow` plus a quiver —
     * so a Balearic slinger would have rendered holding a composite bow with a quiver of
     * arrows on his hip. That is the identical defect the scorpio had, recorded in
     * `roster.ts`: a unit whose `appearance.weapon` named the wrong object rendered as the
     * wrong troop type entirely, and it survived because nothing about it fails to compile.
     *
     * What a Balearic actually carried, per Strabo: three slings of different lengths for
     * three ranges, one bound round the head, one round the waist and one in the hand, and a
     * bag of shot. He carried no shield and next to no armour, because the sling *is* the
     * armour — nobody closed with him if his side was doing its job.
     */
    add(Piece.WeaponSling);
    add(Piece.SlingPouch);
    melee = meleeOf(ap.sidearm ?? 'gladius');
    inHand = -1;
    if (melee === Piece.WeaponSword || melee === Piece.WeaponFalcata) add(Piece.SwordSheathed);
  } else if (ap.weapon === 'bow') {
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
    // A falcata hung in a scabbard on the hip exactly as a gladius did, so it takes the
    // sheath too — otherwise an Iberian with a javelin in his hand is carrying no blade at
    // all until the moment he needs one, and then it appears from nowhere.
    const bladed = melee === Piece.WeaponSword || melee === Piece.WeaponFalcata;
    if (bladed && inHand !== melee) add(Piece.SwordSheathed);
  }
  if (inHand >= 0) add(inHand);

  // The melee variant: drop whatever was in the hand, draw the melee weapon, and put the
  // scabbard away only if the sword itself is what comes out of it.
  let meleeHi = hi;
  if (inHand >= 0 && isHi(inHand) && inHand !== melee) meleeHi &= ~bit(inHand);
  if (isHi(melee)) meleeHi |= bit(melee);
  if (melee === Piece.WeaponSword || melee === Piece.WeaponFalcata) {
    meleeHi &= ~bit(Piece.SwordSheathed);
  }
  // A slinger who is fighting has dropped the sling, not tucked it away.
  if (hi & bit(Piece.WeaponSling)) meleeHi &= ~bit(Piece.WeaponSling);

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
  /**
   * A Gaulish dye lot, which is not a Germanic one.
   *
   * Both hosts dyed their own cloth, so both need a palette rather than a roster colour —
   * but running Hannibal's Gauls off `GERMANIC_CLOTH` would make the two barbarian armies
   * literally the same colour, and a player who fights both should not have to read a banner
   * to tell them apart. Gaulish textile finds and the Roman writers agree on the difference:
   * Diodorus describes bright checked and striped cloth, Pliny credits the Gauls with the
   * best woad and madder in the west. So this palette is more saturated and cooler than the
   * Juthungi's undyed and iron-mordanted browns.
   */
  const CELTIC_CLOTH: readonly number[] = [
    0x8c3a2e, 0x2f5347, 0x9a7a2c, 0x3d4f6b, 0x7c4a6a, 0x5f7040, 0xa8672c,
  ];
  const CELTIC_LEG: readonly number[] = [
    0x5b4f3c, 0x6d5a3e, 0x47523f, 0x7a6446, 0x554a44,
  ];
  /**
   * Iberian white, and it is the single most-cited detail about these troops.
   *
   * Livy at the Trebia and Polybius at Cannae both stop to describe it: linen tunics, white
   * or off-white, with a purple or crimson border. Chalk-and-size whitening was a real
   * treatment and it does not take evenly, so the palette is four shades of not-quite-white
   * rather than one.
   */
  const IBERIAN_CLOTH: readonly number[] = [
    0xd6cdb6, 0xc8bfa4, 0xdcd6c2, 0xbfb49a,
  ];
  const clothPool: readonly number[] | null =
    germanic ? GERMANIC_CLOTH
      : culture === 'celtic' ? CELTIC_CLOTH
        : culture === 'iberian' ? IBERIAN_CLOTH
          : null;
  const legPool: readonly number[] | null =
    germanic ? GERMANIC_LEG : culture === 'celtic' ? CELTIC_LEG : null;
  const tunic = desaturate(srgbToLinear(
    clothPool ? clothPool[Math.floor(r(18) * clothPool.length)] : ap.tunicColour
  // Pulled a good way toward its own luminance. A vegetable-dyed red at full saturation has
  // effectively no green or blue, and a channel that starts at zero stays at zero however it
  // is lit — which is measurably why a tunic read as black: the men's median rendered
  // luminance was 0.014 display-linear. Desaturating lifts the dead channels without
  // pretending the dye was brighter than it was.
  ), 0.34);
  const leg = desaturate(srgbToLinear(
    legPool ? legPool[Math.floor(r(19) * legPool.length)] : ap.legColour
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
  //   punic         a Hellenistic bronze culture and a rich one: Attic helmets, bronze
  //                 greaves and cuirass fittings are cast, not forged, so bronze leads.
  //   libyan        Roman iron, because the kit is Roman — taken at Trasimene and Cannae
  //                 and reissued, which is Livy's account and also why these men look
  //                 uncannily like the army they are fighting.
  //   iberian       the best iron in the west. The Romans thought so too: they adopted the
  //                 sword and called it the *gladius hispaniensis*.
  //   celtic        as the Juthungi — old, pitted iron with traded bronze fittings.
  //   numidian      almost no metal at all on a man who rides without even a bridle.
  const mr = r(16);
  let metalClass: number;
  if (germanic || culture === 'celtic') {
    metalClass = mr < 0.44 ? 2 : mr < 0.8 ? 0 : 1;
  } else if (culture === 'punic') {
    metalClass = mr < 0.58 ? 1 : mr < 0.84 ? 0 : 3;
  } else if (culture === 'iberian') {
    metalClass = mr < 0.7 ? 0 : mr < 0.88 ? 1 : 2;
  } else if (culture === 'numidian') {
    metalClass = mr < 0.6 ? 2 : mr < 0.9 ? 0 : 1;
  } else if (def.armour > 60) {
    metalClass = mr < 0.4 ? 3 : mr < 0.74 ? 1 : 0;
  } else if (def.armour > 45) {
    metalClass = mr < 0.54 ? 0 : mr < 0.74 ? 1 : mr < 0.88 ? 3 : 2;
  } else {
    metalClass = mr < 0.48 ? 0 : mr < 0.64 ? 1 : 2;
  }
  const polish = germanic || culture === 'celtic' || culture === 'numidian' ? 0.5
    : culture === 'punic' ? 0.95
      : def.armour > 60 ? 1 : 0.8;
  const kept = Math.max(0.05, Math.min(1, polish * (0.55 + r(14) * 0.85)));
  out.metal = metalClass + kept * 0.9;

  out.maskLo = lo;
  out.maskHi = hi;
  out.maskHiMelee = meleeHi;

  // Collapse to silhouette groups for the far tier.
  let coarse = 1 << Coarse.Body;
  // Every new helmet and armour piece has to be listed here or a man wearing only new kit
  // loses his silhouette group entirely past 130 m — he would go bare-headed and unarmoured
  // at exactly the distance where the coarse mesh is all a player has to read him by.
  const HELMETS = bit(Piece.HelmGallic) | bit(Piece.HelmRidge) | bit(Piece.HelmCoolus) |
    bit(Piece.HelmSpangen) | bit(Piece.HelmFur) | bit(Piece.HelmAttic) | bit(Piece.HelmIberian);
  const ARMOURS = bit(Piece.ArmourSegmentata) | bit(Piece.ArmourMail) |
    bit(Piece.ArmourScale) | bit(Piece.ArmourLeather) | bit(Piece.ArmourLinen);
  if (lo & HELMETS) coarse |= 1 << Coarse.Helmet;
  if (lo & ARMOURS) coarse |= 1 << Coarse.Armour;
  if (lo & bit(Piece.Cloak)) coarse |= 1 << Coarse.Cloak;
  // A hoplon is the largest shield on the field, so it belongs with the scutum and not with
  // the round; a caetra is a buckler and reads as the small group.
  if (hi & (bit(Piece.ShieldScutum) | bit(Piece.ShieldOval) | bit(Piece.ShieldHoplon))) {
    coarse |= 1 << Coarse.ShieldBig;
  }
  if (hi & (bit(Piece.ShieldRound) | bit(Piece.ShieldCaetra))) coarse |= 1 << Coarse.ShieldRound;
  if (hi & (bit(Piece.WeaponSpear) | bit(Piece.Pilum) | bit(Piece.JavelinBundle) | bit(Piece.WeaponBow))) {
    coarse |= 1 << Coarse.Pole;
  }
  if (hi & (bit(Piece.WeaponSword) | bit(Piece.WeaponAxe) | bit(Piece.SwordSheathed)
    | bit(Piece.WeaponFalcata))) {
    coarse |= 1 << Coarse.Blade;
  }
  out.maskCoarse = coarse;
  out.emblem = EMBLEM_INDEX.get(ap.shieldEmblem) ?? EMBLEMS.length - 1;
  // Tribal shields were individually painted, so the host draws a device per man rather than
  // carrying one. The Juthungi have four; Hannibal's Gauls draw from three, two of which are
  // shared with the Juthungi because a spiral and a sunwheel are pan-Celtic motifs that the
  // La Tène material shows from the Rhine to the Ebro. What separates the two hosts on screen
  // is the dye lot and the kit, not the device.
  if (ap.shield !== 'none') {
    /*
     * A legionary's board is drawn by one of three hands.
     *
     * The device is the unit's — this is not a per-man blazon, and see the note on `EMBLEMS`
     * for why that distinction is the whole point. What varies is which of the three painted
     * renderings of that device his board carries, from the same stable per-man hash
     * everything else about him comes from. `r(22)` is the first free draw: 1 to 21 are
     * taken, and reusing one would correlate a man's painter with his metal or his crest.
     *
     * Gated on the unit's *own* device being the thunderbolt rather than on culture, because
     * the alternates are two more thunderbolts: a praetorian cohort's scorpion has no second
     * hand drawn for it and must not be handed one.
     */
    if (out.emblem === EMBLEM_LEGIO) {
      out.emblem = LEGIO_HANDS[Math.floor(r(22) * LEGIO_HANDS.length)];
    } else if (germanic) {
      const pool = [6, 7, 8, 9];
      out.emblem = pool[Math.floor(r(15) * pool.length)];
    } else if (culture === 'celtic') {
      const pool = [6, 7, 10];
      out.emblem = pool[Math.floor(r(15) * pool.length)];
    }
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
  bit(Piece.ShieldHoplon) | bit(Piece.ShieldCaetra) |
  bit(Piece.Pilum) | bit(Piece.JavelinBundle);

/**
 * What leaves a dead man's hands.
 *
 * The VFX litter system already lays a dropped shield on the ground beside roughly three
 * deaths in five, so a corpse that also keeps the one on his arm double-counts — and the
 * result is the single loudest defect in the aftermath frame: a heap in which large flat
 * boards at every angle outnumber the bodies, so the eye reads a pile of parts rather than
 * a field of dead men. Dropping the arm shield at a matching rate leaves the same number of
 * shields on the ground and lets the men underneath read as men.
 */
export const CORPSE_DROP_HI =
  bit(Piece.ShieldScutum) | bit(Piece.ShieldOval) | bit(Piece.ShieldRound) |
  bit(Piece.ShieldHoplon) | bit(Piece.ShieldCaetra) |
  bit(Piece.Pilum) | bit(Piece.JavelinBundle);

/** A helmet comes off in a fall often enough to be worth the variety. */
export const CORPSE_DROP_LO =
  bit(Piece.HelmGallic) | bit(Piece.HelmRidge) | bit(Piece.HelmCoolus) |
  bit(Piece.HelmSpangen) | bit(Piece.HelmFur) |
  bit(Piece.HelmAttic) | bit(Piece.HelmIberian) |
  bit(Piece.CrestTransverse) | bit(Piece.CrestLongitudinal) |
  bit(Piece.CrestPlume) | bit(Piece.CrestHorns);

/** Coarse-tier equivalents of the two masks above, for the far mesh's eight groups. */
export const CORPSE_DROP_COARSE = (1 << Coarse.ShieldBig) | (1 << Coarse.ShieldRound);
export const CORPSE_DROP_COARSE_HELM = 1 << Coarse.Helmet;

/**
 * What a man in a testudo puts away, and why he has to.
 *
 * A testudo holds the scutum with **both hands** — see the pose block in
 * `anim/authored.ts` — and a hand cannot be on the board and on a pilum at once. That is
 * the honest reason, but it is not the reason this mask was written.
 *
 * The reason is that a legionary carries a 2.1 m pilum shouldered, and a shouldered pilum
 * on a man whose shield is now over his head goes **straight through the roof**. Two
 * hundred of them is a hedgehog, and it is the single loudest thing wrong with a testudo
 * that has had its arms fixed and nothing else: the surface reads for about a second and
 * then the eye finds the shafts and it is a crowd again. Polearms are in the list for the
 * same reason and not because a spearman's grip was thought about.
 *
 * `SwordSheathed` goes back **on**, so the gladius is visibly on the hip rather than
 * nowhere. Every faction's mesh carries the piece — the geometry is the union of
 * everything a faction can field and the shader collapses what a man is not wearing — so
 * setting the bit is free and cannot reference geometry that is absent.
 */
export const TESTUDO_STOW_HI =
  bit(Piece.Pilum) | bit(Piece.JavelinBundle) |
  bit(Piece.WeaponSword) | bit(Piece.WeaponSpear) | bit(Piece.WeaponAxe) |
  bit(Piece.WeaponFalcata) | bit(Piece.WeaponBow) | bit(Piece.WeaponSling);

/** Put back on when the hands go to the board. */
export const TESTUDO_WEAR_HI = bit(Piece.SwordSheathed);

/** The same for the far mesh's eight groups: no pole, no blade. */
export const TESTUDO_STOW_COARSE = (1 << Coarse.Pole) | (1 << Coarse.Blade);

/** Whether this unit type is drawn mounted. */
export const mounted = (def: UnitTypeDef): boolean => isCavalry(def);

/**
 * What the man is drawn on top of.
 *
 * Defaults to a horse, so every cavalry type written before elephants existed keeps its
 * animal without being edited. Only meaningful when `mounted(def)`.
 */
export const mountKind = (def: UnitTypeDef): 'horse' | 'elephant' =>
  def.appearance.mount ?? 'horse';

/** A war elephant is a mount that carries a crew, not a rider. */
export const ridesElephant = (def: UnitTypeDef): boolean =>
  mounted(def) && mountKind(def) === 'elephant';
