import * as THREE from 'three';

/**
 * The colour of third-century Rome.
 *
 * Roman buildings were *not* bare grey stone. Street façades were rendered in lime
 * stucco and painted — the Pompeian and Ostian evidence gives deep iron-oxide reds,
 * yellow ochres, and cheap lime white as the everyday palette, with the reds and
 * ochres dominating insula frontages. Public monuments were faced in travertine or
 * Luna marble; the Aurelian curtain is brick (*opus testaceum*) over a rubble core.
 *
 * Values are authored as sRGB hex and converted to linear on construction, so they
 * can be written straight into vertex-colour attributes.
 */

const srgb = (hex: number): THREE.Color => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Albedo discipline. These are *reflectances*, and the numbers matter: a surface
 * authored two stops bright cannot be rescued by the tone mapper, it just goes chalky
 * and loses its shadow detail. Linear luminance targets, from measured values —
 * fired brick 0.10–0.14, travertine 0.35–0.45, Luna marble 0.50, terracotta 0.10,
 * lime stucco 0.55 at its whitest. An earlier revision put travertine at 0.47 linear
 * *red*, which read as bleached bone against the photographed ground.
 */
export const PAL = {
  /** Fired-clay brick face. Roman wall brick fires orange-red to buff. */
  brick: srgb(0x9a6242),
  brickPale: srgb(0xb08064),
  brickDark: srgb(0x7d4a31),
  /** Lime mortar and the exposed *opus caementicium* core. */
  mortar: srgb(0xb2a992),
  concrete: srgb(0x948d7a),
  /** Travertine — the cream Tivoli limestone of the footings and gate dressings. */
  travertine: srgb(0xb6a888),
  travertineDirty: srgb(0x8b7f66),
  /** Luna (Carrara) marble for temple orders and statuary. */
  // Luna marble. 0.44 linear luminance: bright, but a large sunlit temple front at the 0.49
  // an earlier value gave sat right on the shoulder of the tone curve and lost its cornice
  // and flute shadows to it.
  marble: srgb(0xb5ad99),
  // Marble in shade, and the default for large secondary surfaces — orchestras, stage
  // buildings, aisle walls. Kept *warm*: a neutral grey here is what made the monumental
  // core read as concrete rather than as stone in the first skyline pass.
  marbleShadow: srgb(0xa89e88),
  /** Tufa and peperino, the cheap local volcanic building stones. */
  tufa: srgb(0xb8a680),
  peperino: srgb(0x847f70),
  /** Painted stucco: the everyday street palette. */
  pompeianRed: srgb(0x9c2f26),
  romanRed: srgb(0xa8202a),
  ochre: srgb(0xbc8c44),
  ochrePale: srgb(0xcfae70),
  // Lime render, weathered. Fresh limewash measures about 0.75 linear; nothing on a
  // third-century street was fresh, and an earlier 0xe7dfc9 read as snow next to the
  // photographed ground.
  limeWhite: srgb(0xd8cfb6),
  ochreDeep: srgb(0x9d6d34),
  terraDirty: srgb(0xa58462),
  /** Terracotta roofing. */
  roofTile: srgb(0x94502f),
  roofTileOld: srgb(0x7c452b),
  roofTileDark: srgb(0x603824),
  /**
   * Terracotta bonding courses through the brick face. Deliberately *paler and more
   * orange* than the brick around them: the bipedales are a different, finer clay and
   * they are what gives the Aurelian curtain its horizontal rhythm. Matching them to the
   * brick, as an earlier pass did, left the string courses reading only as shadow lines.
   */
  tileCourse: srgb(0xb2734a),
  /** Metals. Gilded bronze roof tiles crowned the Capitoline temple. */
  // Gilded bronze, weathered. 0.18 linear luminance, not the 0.44 an earlier 0xd0a52e gave:
  // that is a *specular* metal's reflectance being authored as a diffuse albedo, and on the
  // Capitoline temple's 3,300 m² of sunward roof it clipped straight through the top of the
  // filmic curve — which desaturates as it rolls off, so the roof resolved to a blank white
  // sheet and was the one visibly broken building on the skyline from every city camera.
  gilt: srgb(0x907327),
  bronze: srgb(0x8a6a34),
  iron: srgb(0x4b4842),
  lead: srgb(0x6d6f70),
  /** Timber: scaffolding poles, crane frames, doors, palisade. */
  timber: srgb(0x8a6a45),
  timberDark: srgb(0x5d472e),
  /** Planting. Cypress is almost black-green; Italian pine is warmer. */
  cypress: srgb(0x3f5340),
  pine: srgb(0x455a34),
  vine: srgb(0x4c5c30),
  /** Ground surfaces owned by the city (streets, yards, ramps). */
  basalt: srgb(0x413f39),
  dust: srgb(0x8f8368),
  /** Deep shadow tint for recessed openings — cheaper than modelling interiors. */
  voidDark: srgb(0x161310),
  voidWarm: srgb(0x2a1f16),
} as const;

export type PaletteKey = keyof typeof PAL;

/** Scratch colour so builders never allocate inside a loop. */
export const tmpColor = new THREE.Color();

/**
 * Tint a palette colour by a multiplicative brightness and a hue drift, writing to
 * the shared scratch. Used to break up repeated modules without new materials.
 */
export function tint(base: THREE.Color, brightness: number, warm = 0): THREE.Color {
  tmpColor.copy(base).multiplyScalar(brightness);
  if (warm !== 0) {
    tmpColor.r *= 1 + warm * 0.16;
    tmpColor.g *= 1 + warm * 0.03;
    tmpColor.b *= 1 - warm * 0.14;
  }
  return tmpColor;
}
