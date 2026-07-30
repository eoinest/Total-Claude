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

export const PAL = {
  /** Fired-clay brick face. Roman wall brick fires orange-red to buff. */
  brick: srgb(0xa96b47),
  brickPale: srgb(0xc09070),
  brickDark: srgb(0x8a5236),
  /** Lime mortar and the exposed *opus caementicium* core. */
  mortar: srgb(0xbdb49b),
  concrete: srgb(0x9d9682),
  /** Travertine — the cream Tivoli limestone of the footings and gate dressings. */
  travertine: srgb(0xc4b592),
  travertineDirty: srgb(0x93876c),
  /** Luna (Carrara) marble for temple orders and statuary. */
  marble: srgb(0xcdc6b2),
  marbleShadow: srgb(0xaaa494),
  /** Tufa and peperino, the cheap local volcanic building stones. */
  tufa: srgb(0xc4b189),
  peperino: srgb(0x8d8878),
  /** Painted stucco: the everyday street palette. */
  pompeianRed: srgb(0x9c2f26),
  romanRed: srgb(0xa8202a),
  ochre: srgb(0xc8974a),
  ochrePale: srgb(0xd9b878),
  limeWhite: srgb(0xe7dfc9),
  ochreDeep: srgb(0xa8763a),
  terraDirty: srgb(0xb08e6a),
  /** Terracotta roofing. */
  roofTile: srgb(0x9d5334),
  roofTileOld: srgb(0x82492f),
  roofTileDark: srgb(0x653c28),
  /** Terracotta bonding courses through the brick face. */
  tileCourse: srgb(0xa15c3a),
  /** Metals. Gilded bronze roof tiles crowned the Capitoline temple. */
  gilt: srgb(0xd0a52e),
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
