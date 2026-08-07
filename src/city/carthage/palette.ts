import * as THREE from 'three';

/**
 * The colour of Punic Carthage.
 *
 * Carthage is **not** Rome with different street names, and the palette is the first place
 * that has to show. Rome here is fired brick over travertine: orange-red, cream, cool grey
 * mortar. Carthage is the local *grès de Carthage* — a soft yellow-buff shelly sandstone
 * quarried at El Haouaria and Sidi Bou Said — laid as *opus africanum*: upright ashlar piers
 * with rubble panels between them, the whole rendered in lime and, on any wall a household
 * cared about, painted. Floors are *pavimenta punica*: crushed terracotta in lime, the pink
 * that the Byrsa excavations are known for. Roofs are terracotta pantile. Above a stone
 * socle, a great deal of a Punic house is mudbrick, which weathers to the ground colour.
 *
 * The result should read **warmer, paler and more monochrome** than Rome: one stone, one
 * render, one earth, with red and Tyrian purple as the only saturated notes. Rome's tell is
 * red brick against grey; Carthage's is the absence of that contrast.
 *
 * Values are authored as sRGB hex and converted to linear, matching `city/palette.ts`, and
 * hold the same albedo discipline: linear luminance targets from measured materials, and
 * HSV saturation in the 0.24-0.35 band that Rome's stone family was re-authored into after
 * it measured 0.15-0.27 against Rome II's 0.32-0.33 and read as concrete.
 */

const srgb = (hex: number): THREE.Color => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export const PUN = {
  /** *Grès de Carthage*: the yellow-buff shelly sandstone every ashlar course is cut from. */
  sandstone: srgb(0xbfa172),
  sandstonePale: srgb(0xd2b98e),
  /** Weathered and lichened, on a north face or a footing course. */
  sandstoneDark: srgb(0x94794f),
  /** Lime render over rubble. The everyday street surface of the city. */
  render: srgb(0xcfbf9d),
  renderWorn: srgb(0xb0a184),
  /** Lime wash, the cheapest finish. Deliberately near-neutral: see the note in Rome's. */
  limewash: srgb(0xd9d2bd),
  /**
   * The painted red of a Punic house front. Iron-oxide, the same pigment as Pompeian red
   * but laid over a warmer ground, so it sits browner. Used sparingly — a dado, a doorcase.
   */
  ochreRed: srgb(0x9c4a34),
  ochreYellow: srgb(0xbf8f42),
  /** *Pavimentum punicum*: crushed terracotta in lime. Courtyards and the Byrsa cisterns. */
  signinum: srgb(0xa5705c),
  /** Terracotta pantile. Fires darker and browner than Italian tile. */
  tile: srgb(0x9a5a3c),
  tileWorn: srgb(0x7f4e37),
  /** Mudbrick above the socle, unrendered on a back wall or an outbuilding. */
  mudbrick: srgb(0xb59a72),
  /** Cedar and cypress: shutters, balconies, the ship sheds' roof timbers. */
  timber: srgb(0x6b5236),
  timberDark: srgb(0x4e3c28),
  /** Punic ashlar at its best: the Byrsa revetment and the harbour quays, dressed and clean. */
  ashlar: srgb(0xc8ae82),
  /** Beaten earth of a lane, and the harbour hard standing. */
  earth: srgb(0x9d8862),
  /** Paved carriageway: limestone slabs, greyer than the sandstone around them. */
  paving: srgb(0xa79c85),
  /** Water in a basin, seen as a dark plane. See `harbour.ts` for why this exists at all. */
  basin: srgb(0x3c4a44),
  /** Bronze: temple doors, the rams displayed on the cothon island, gate furniture. */
  bronze: srgb(0x6e5a30),
  /** Tyrian purple — Carthage's own trade. One awning, one banner, nothing more. */
  purple: srgb(0x50283f),
  /** Olive and fig canopy in the Megara gardens. */
  olive: srgb(0x6d7247),
  cypress: srgb(0x3f4a30),
} as const;

/** A colour varied deterministically about its authored value, for per-building spread. */
export function tinted(base: THREE.Color, h: number, spread = 0.14): THREE.Color {
  return base.clone().multiplyScalar(1 - spread * 0.5 + h * spread);
}
