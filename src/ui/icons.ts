/**
 * Inline SVG glyph library.
 *
 * No UI art ships with the game, so every icon here is hand-authored path data on a
 * 24x24 grid. Icons are strings rather than elements because they are only ever
 * stamped into markup while a panel is being built, never in a per-frame path.
 *
 * Formation glyphs are generated from `FORMATIONS` itself, so the button picture is
 * literally the layout the sim will produce.
 */

import { FORMATIONS } from '../sim/formations';
import { Faction, type UnitClass } from '../sim/types';

const S = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const St = 'fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"';

// ---------------------------------------------------------------------------
// Unit classes
// ---------------------------------------------------------------------------

/** A scutum: tall rounded rectangle with a boss and a thunderbolt device. */
const SCUTUM =
  `<path d="M8 2.6h8a1.6 1.6 0 0 1 1.6 1.6v11.2C17.6 19 14.9 21.4 12 22.4 9.1 21.4 6.4 19 6.4 15.4V4.2A1.6 1.6 0 0 1 8 2.6z" opacity=".92"/>` +
  `<path d="M12.9 6.2 10 12h2.1l-1 5.6L14 11.8h-2.1z" fill="#1a140e" opacity=".55"/>`;

/** Round shield with a spiral boss plus a bearded axe behind it. */
const ROUNDSHIELD_AXE =
  `<path d="M19.6 2.2 8.6 13.2" ${S}/>` +
  `<path d="M18.4 1.1c1.9.2 3.6 1.5 4.2 3.4-1.7.5-3.3.2-4.6-.9-.5-.4-.5-1.2 0-1.8z" opacity=".9"/>` +
  `<circle cx="10" cy="14.6" r="7.2" opacity=".9"/>` +
  `<circle cx="10" cy="14.6" r="2.1" fill="#1a140e" opacity=".5"/>`;

/** A spear hedge behind an oval shield. */
const SPEARS =
  `<path d="M5.4 21.8 15.6 4.4M9.6 21.8 19.8 4.4" ${S}/>` +
  `<path d="M15.6 4.4 16.9 1l1.4 3.3zM19.8 4.4 21.1 1l1.4 3.3z"/>` +
  `<path d="M8.4 8.4c2.6 0 4.6 1.5 4.6 5.4 0 4.2-2.4 7.6-4.6 8.6-2.2-1-4.6-4.4-4.6-8.6 0-3.9 2-5.4 4.6-5.4z" opacity=".9"/>`;

/** Composite bow, drawn, with an arrow on the string. */
const BOW =
  `<path d="M7.4 2.6c5.6 2 9 6.6 9 11.4 0 3.2-1.3 6.2-3.6 8.4" ${S}/>` +
  `<path d="M7.4 2.6c1.4 3.9 1.4 8.5 0 12.4-.4 1.2-1 2.4-1.7 3.4" ${St} opacity=".65"/>` +
  `<path d="M6.6 3.4 20.4 20.6" ${St} opacity=".8"/>` +
  `<path d="M2.4 12.6h11.2" ${S}/><path d="M13.6 12.6 11.4 10.9v3.4z"/>`;

/** Two axes crossed — shock troops. */
const DOUBLE_AXE =
  `<path d="M4 21 20 5M20 21 4 5" ${S}/>` +
  `<path d="M19.2 3.6c2 .3 3.6 1.7 4.1 3.7-1.8.5-3.5.1-4.8-1.1-.5-.5-.4-1.3.1-1.9zM4.8 3.6c-2 .3-3.6 1.7-4.1 3.7 1.8.5 3.5.1 4.8-1.1.5-.5.4-1.3-.1-1.9z" opacity=".9"/>`;

/** Barded horse head with a couched lance. */
const HORSE_HEAVY =
  `<path d="M21.6 2.4 9.8 10.6" ${S}/>` +
  `<path d="M4.6 21.6c-.6-3.4.2-6.2 2.4-8.4 1-1 1.4-2 1.3-3.2-.1-1.5.6-2.8 2-3.8l1.6 2.2 3-1.4-.6 3c1.9 1 3 2.7 3.2 5.1.2 2.4-.6 4.6-2.3 6.5z" opacity=".92"/>` +
  `<circle cx="12.4" cy="8.9" r=".9" fill="#1a140e" opacity=".55"/>`;

/** Light horse head, unbarded, with a javelin. */
const HORSE_LIGHT =
  `<path d="M21.8 3.4 12.4 21.4" ${St} opacity=".85"/>` +
  `<path d="M5 21.6c-.5-3.2.4-5.8 2.6-7.8 1-.9 1.3-1.8 1.2-3-.1-1.4.6-2.6 1.9-3.6l1.5 2 2.8-1.3-.6 2.8c1.7.9 2.7 2.5 2.9 4.7.2 2.2-.5 4.3-2.1 6.2z" opacity=".85"/>`;

/** A scorpio: frame, torsion springs and a bolt in the groove. */
const SCORPIO =
  `<path d="M3 7.4h18M4.6 5.2v4.4M19.4 5.2v4.4" ${S}/>` +
  `<path d="M12 7.4v11.4M8 21.8l4-3 4 3" ${S}/>` +
  `<path d="M12 2.2v4.2" ${St}/><path d="M12 1.2 10.4 3.6h3.2z"/>`;

/** Laurel wreath for the commander. */
const WREATH =
  `<path d="M12 21.6c-4.6-1.6-7.6-5.6-7.6-10.2 0-3.4 1.6-6.4 4-8.2" ${S}/>` +
  `<path d="M12 21.6c4.6-1.6 7.6-5.6 7.6-10.2 0-3.4-1.6-6.4-4-8.2" ${S}/>` +
  `<path d="M12 18.6 10.4 21h3.2z"/>`;

export const UNIT_CLASS_ICON: Record<UnitClass, string> = {
  'heavy-infantry': SCUTUM,
  'light-infantry': ROUNDSHIELD_AXE,
  'spear-infantry': SPEARS,
  'missile-infantry': BOW,
  'shock-infantry': DOUBLE_AXE,
  'heavy-cavalry': HORSE_HEAVY,
  'light-cavalry': HORSE_LIGHT,
  artillery: SCORPIO,
  general: WREATH,
};

// ---------------------------------------------------------------------------
// Status / condition
// ---------------------------------------------------------------------------

export const ICON = {
  swords:
    // Two blades crossed corner to corner, tips out, guards near the grips.
    `<path d="M6.6 21.4 18.2 5.2M17.4 21.4 5.8 5.2" ${S}/>` +
    `<path d="M18.6 6.4 22.4 1.2l-.8 6z"/><path d="M5.4 6.4 1.6 1.2l.8 6z"/>` +
    `<path d="M3.4 16.8h6M14.6 16.8h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".85"/>` +
    `<circle cx="6.4" cy="22" r="1.3"/><circle cx="17.6" cy="22" r="1.3"/>`,
  charge:
    `<path d="M2.6 12h13" ${S}/><path d="M21.4 12 14 6.6v10.8z"/>` +
    `<path d="M3.4 6.8h7M3.4 17.2h7" ${St} opacity=".55"/>`,
  brace:
    `<path d="M12 2.4 4.8 5v7.2c0 4.3 3 7.9 7.2 9.4 4.2-1.5 7.2-5.1 7.2-9.4V5z" ${S}/>` +
    `<path d="M8.6 11.6l2.4 2.6 4.4-5" ${S}/>`,
  rout:
    `<path d="M6 21.6V3.4" ${S}/>` +
    `<path d="M6 4.2c3.4-1.6 6.2.8 9.4-.4l-1.4 5.4c-3.2 1.2-6-1.2-9.4.4z" opacity=".85"/>` +
    `<path d="M15.6 13.6l4.8 4.8M20.4 13.6l-4.8 4.8" ${S}/>`,
  volley:
    // Three pila in the air, heads leading.
    `<path d="M3.4 20.6 15.4 8.6M8 21.4 20 9.4M12.8 22 22.6 12.2" ${S}/>` +
    `<path d="M15.4 8.6 18.6 3.4l-.7 5.9zM20 9.4l3.2-5.2-.7 5.9zM22.6 12.2l1.8-3.1-.4 3.4z"/>` +
    `<path d="M3.4 20.6 1 23.4l3-.8zM8 21.4l-2.4 2.8 3-.8z" opacity=".7"/>`,
  quiver:
    `<path d="M8.4 21.4h7.2a1.4 1.4 0 0 0 1.4-1.5l-.7-9.5H7.7L7 19.9a1.4 1.4 0 0 0 1.4 1.5z" ${S}/>` +
    `<path d="M10 10.4V3.2M12 10.4V2.2M14 10.4V3.8" ${St}/>` +
    `<path d="M10 2.2l-1 1.6h2zM12 1.2l-1 1.6h2zM14 2.8l-1 1.6h2z"/>`,
  fatigue:
    `<path d="M12 2.6C9 6.6 6.4 9.8 6.4 13.6a5.6 5.6 0 0 0 11.2 0c0-3.8-2.6-7-5.6-11z" ${S}/>` +
    `<path d="M12 17.6a3.4 3.4 0 0 1-3.4-3.4" ${St}/>`,
  shield:
    `<path d="M12 2.4 4.8 5v7.2c0 4.3 3 7.9 7.2 9.4 4.2-1.5 7.2-5.1 7.2-9.4V5z" ${S}/>`,
  boots:
    `<path d="M6.6 3.4h3.6l.6 8.2 4.8 2.2a3 3 0 0 1 1.8 2.8v4h-11z" ${S}/>` +
    `<path d="M6.6 16.4h10.8" ${St}/>`,
  pause: `<path d="M7.4 4h3.2v16H7.4zM13.4 4h3.2v16h-3.2z"/>`,
  play: `<path d="M7 3.6 19.6 12 7 20.4z"/>`,
  ffwd: `<path d="M3 3.6 11.4 12 3 20.4zM12.6 3.6 21 12l-8.4 8.4z"/>`,
  ffwd4: `<path d="M1.4 4.6 7.6 12l-6.2 7.4zM8.9 4.6 15.1 12l-6.2 7.4zM16.4 4.6 22.6 12l-6.2 7.4z"/>`,
  cog:
    `<path d="m20.5 14.2-1.7-1a7.2 7.2 0 0 0 0-2.4l1.7-1a.8.8 0 0 0 .3-1l-1.4-2.5a.8.8 0 0 0-1-.3l-1.8.7a7.3 7.3 0 0 0-2-1.2l-.2-1.9a.8.8 0 0 0-.8-.7h-2.9a.8.8 0 0 0-.8.7l-.2 1.9a7.3 7.3 0 0 0-2 1.2l-1.8-.7a.8.8 0 0 0-1 .3L3.5 8.8a.8.8 0 0 0 .3 1l1.7 1a7.2 7.2 0 0 0 0 2.4l-1.7 1a.8.8 0 0 0-.3 1l1.4 2.5a.8.8 0 0 0 1 .3l1.8-.7a7.3 7.3 0 0 0 2 1.2l.2 1.9a.8.8 0 0 0 .8.7h2.9a.8.8 0 0 0 .8-.7l.2-1.9a7.3 7.3 0 0 0 2-1.2l1.8.7a.8.8 0 0 0 1-.3l1.4-2.5a.8.8 0 0 0-.3-1z" ${S}/>` +
    `<circle cx="12" cy="12" r="2.8" ${S}/>`,
  halt:
    `<path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7z" ${S}/>` +
    `<path d="M8.6 8.6h6.8v6.8H8.6z"/>`,
  run:
    `<path d="M13.4 2.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>` +
    `<path d="M13.6 7.6 10 10.4l1.6 3.6-1.2 3.4-3 4M11.6 14l4.4 1.4 1.8 5.6M13.6 9.8l4.2.6" ${S}/>` +
    `<path d="M2.4 8.4h4M1.4 12.4h3.4" ${St} opacity=".6"/>`,
  chevronUp: `<path d="M6 14.4 12 8.4l6 6" ${S}/>`,
  chevronDown: `<path d="M6 9.6 12 15.6l6-6" ${S}/>`,
  skull:
    `<path d="M12 2.6c-4.3 0-7.2 2.9-7.2 7 0 2.5 1 4 2.2 5.1.5.5.8 1.1.8 1.8v1.9c0 1.4 1.1 2.6 2.6 2.6h3.2c1.5 0 2.6-1.2 2.6-2.6v-1.9c0-.7.3-1.3.8-1.8 1.2-1.1 2.2-2.6 2.2-5.1 0-4.1-2.9-7-7.2-7z" ${S}/>` +
    `<circle cx="9.2" cy="10.4" r="1.5"/><circle cx="14.8" cy="10.4" r="1.5"/>`,
  flag:
    `<path d="M6 21.4V3.6" ${S}/>` +
    `<path d="M6 4.2c3.6-1.6 6.6.8 10 .2l-1.6 6c-3.4.6-6.4-1.8-8.4-.2z" opacity=".9"/>`,
  eye: `<path d="M12 5.4c5 0 9 4.2 10.4 6.6C21 14.4 17 18.6 12 18.6S3 14.4 1.6 12C3 9.6 7 5.4 12 5.4z" ${S}/><circle cx="12" cy="12" r="3" ${S}/>`,
  sun: `<circle cx="12" cy="12" r="4.4" ${S}/><path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3M4.6 4.6l2.2 2.2M17.2 17.2l2.2 2.2M19.4 4.6l-2.2 2.2M6.8 17.2l-2.2 2.2" ${S}/>`,
  // Three volumes on a shelf, the third leaning — the technical documentation. Spines
  // rather than an open book, because the docs are four volumes and a shelf says so.
  volumes:
    `<path d="M3.4 5.4h3.8v14.2H3.4zM8.8 5.4h3.8v14.2H8.8z" ${S}/>` +
    `<path d="m14.8 6.4 3.7-1 3.1 13.8-3.7 1z" ${S}/>` +
    `<path d="M3.4 9.2h3.8M8.8 9.2h3.8" ${St} opacity=".72"/>`,
  // An isometric case seen corner-on, for the model viewer: one object, turned.
  turntable:
    `<path d="M12 2.6 20.4 7.4v9.2L12 21.4 3.6 16.6V7.4z" ${S}/>` +
    `<path d="M3.6 7.4 12 12.2l8.4-4.8M12 12.2v9.2" ${St} opacity=".7"/>`,
} as const;

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

export const ABILITY_ICON: Record<string, string> = {
  testudo:
    `<path d="M2.6 9.4 12 4.2l9.4 5.2" ${S}/>` +
    `<path d="M4.6 12h3.2v8.4H4.6zM10.4 12h3.2v8.4h-3.2zM16.2 12h3.2v8.4h-3.2z" opacity=".9"/>`,
  'pilum-volley': ICON.volley,
  inspire:
    `<path d="M12 21.4V8.6" ${S}/>` +
    `<path d="M12 2.4 8.6 6.2h6.8z"/>` +
    `<path d="M5.4 12.6c2-1.2 4.4.6 6.6-.4M18.6 12.6c-2-1.2-4.4.6-6.6-.4" ${St}/>` +
    `<path d="M6.6 16.6c2-1.2 3.4.4 5.4-.6M17.4 16.6c-2-1.2-3.4.4-5.4-.6" ${St} opacity=".7"/>`,
  brace: ICON.brace,
  'fire-at-will': BOW,
  'arrow-storm':
    `<path d="M4 2.4v13M9.4 4.4v13M14.6 2.4v13M20 4.4v13" ${St}/>` +
    `<path d="M4 19.6 2.4 15.4h3.2zM9.4 21.6 7.8 17.4h3.2zM14.6 19.6 13 15.4h3.2zM20 21.6l-1.6-4.2h3.2z"/>`,
  charge: ICON.charge,
  warcry:
    `<path d="M9.4 9.4 3.6 6.4v11.2l5.8-3z" ${S}/>` +
    `<path d="M9.4 9.4c3.4 0 6.2-2.2 7.6-5.4v15.6c-1.4-3.2-4.2-5.4-7.6-5.4z" ${S}/>` +
    `<path d="M20.4 8.6c1 2.2 1 4.6 0 6.8" ${St}/>`,
  'framea-volley': ICON.volley,
  frenzy:
    DOUBLE_AXE +
    `<path d="M12 9.6 13 12h-2l1 2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`,
  unbreakable:
    `<path d="M12 2.4 4.8 5v7.2c0 4.3 3 7.9 7.2 9.4 4.2-1.5 7.2-5.1 7.2-9.4V5z" ${S}/>` +
    `<path d="M12 7.4v9M8.4 11h7.2" ${S}/>`,
  'skirmish-mode':
    `<path d="M7.4 3.6c1.6 0 2.6 1.2 2.6 3s-1 6-2.6 6-2.6-4.2-2.6-6 1-3 2.6-3z" opacity=".85"/>` +
    `<path d="M15.6 9c1.6 0 2.6 1.2 2.6 3s-1 6-2.6 6-2.6-4.2-2.6-6 1-3 2.6-3z" opacity=".85"/>` +
    `<path d="M7.4 15.4v2.4M15.6 20.4v1.2" ${St}/>`,
};

export const abilityIcon = (id: string): string => ABILITY_ICON[id] ?? ICON.flag;

// ---------------------------------------------------------------------------
// Faction standards
// ---------------------------------------------------------------------------

/** Aquila with a vexillum plaque — the Roman standard as a 24x24 silhouette. */
const AQUILA =
  `<path d="M11.1 7.4h1.8v15.4a.9.9 0 0 1-1.8 0z"/>` +
  // Spread wings, three feather steps each so the shape survives at 18 px.
  `<path d="M11.2 4.4C8.4 1.8 4.8.8 1 1.8c2.3 1 4 2.3 5.2 4-1.8-.2-3.4.2-4.8 1.2 2.6.8 5.4 1.9 8.3 3.4l1.9-3.6z"/>` +
  `<path d="M12.8 4.4C15.6 1.8 19.2.8 23 1.8c-2.3 1-4 2.3-5.2 4 1.8-.2 3.4.2 4.8 1.2-2.6.8-5.4 1.9-8.3 3.4l-1.9-3.6z"/>` +
  // Body, head and beak.
  `<path d="M12 1.4c1.4 0 2.5 1.1 2.5 2.5 0 1-.5 1.8-1.2 2.3l.9 4.6-2.2 1.9-2.2-1.9.9-4.6A2.5 2.5 0 0 1 9.5 3.9c0-1.4 1.1-2.5 2.5-2.5z"/>` +
  `<path d="M15.4 3.1 18 4.2l-2.6 1z"/>` +
  // Vexillum plaque with an SPQR-suggesting rule.
  `<path d="M7.6 13.4h8.8v5.8H7.6z"/>` +
  `<path d="M9.2 15.2h5.6M9.2 17h3.6" fill="none" stroke="#1a140e" stroke-width="1" opacity=".55"/>`;

/** Horned beast skull on a pole with cloth streamers — the Juthungi standard. */
const HORNED_STANDARD =
  `<path d="M11.1 8.4h1.8v14.2a.9.9 0 0 1-1.8 0z"/>` +
  `<path d="M1 1.4c4.1.4 7.3 2.4 9.1 5.4L7.2 8.6C5.8 5.9 3.6 4.3.4 3.8z"/>` +
  `<path d="M23 1.4c-4.1.4-7.3 2.4-9.1 5.4l2.9 1.8c1.4-2.7 3.6-4.3 6.8-4.8z"/>` +
  `<path d="M12 3.2c-2.7 0-4.4 1.8-4.4 4 0 1.8 1.1 3.1 2.1 4.1l2.3 2.7 2.3-2.7c1-1 2.1-2.3 2.1-4.1 0-2.2-1.7-4-4.4-4z"/>` +
  `<circle cx="10.2" cy="6.8" r=".95" fill="#0d1520"/><circle cx="13.8" cy="6.8" r=".95" fill="#0d1520"/>` +
  `<path d="M12.9 15.4c2.6-1.5 4.5.6 6.7-.7l-1.5 4.8c-2.2 1.3-4.1-.9-5.2.2zM11.1 15.4c-2.6-1.5-4.5.6-6.7-.7l1.5 4.8c2.2 1.3 4.1-.9 5.2.2z" opacity=".9"/>`;

/**
 * The sign of Tanit on a standard pole — Carthage's.
 *
 * Without it `standardGlyph` fell through to the Juthungi horned skull for every faction that
 * is not Rome, so the title card over the siege *of* Carthage flew a Germanic beast standard,
 * and so did every Punic row in the roll of honour. The device is the same
 * trapezoid-bar-and-disc that `atlas.ts` paints on Punic shields (`punic-tanit`), which is
 * deliberate: the glyph in the interface and the emblem on the board in front of the player
 * are one sign. The crescent and disc above it is the other standing type on the stelae.
 */
const TANIT_STANDARD =
  `<path d="M11.1 9.8h1.8v12.8a.9.9 0 0 1-1.8 0z"/>` +
  // Crescent cradling a disc: the finial above the device.
  `<path d="M7.9 3.4a4.3 4.3 0 0 0 8.2 0 5.4 5.4 0 0 1-8.2 0z"/>` +
  `<circle cx="12" cy="1.9" r="1.3"/>` +
  // The sign itself — a disc for the head, a bar for the arms, a triangular body.
  `<circle cx="12" cy="7.2" r="1.45"/>` +
  `<path d="M5.8 9.5h12.4V11H5.8z"/>` +
  `<path d="M12 11.5 8.4 19h7.2z"/>` +
  // Cloth below, so the silhouette reads as a carried standard rather than as a symbol.
  `<path d="M9 19.9h6l-1 2.5h-4z" opacity=".85"/>`;

export const standardGlyph = (f: Faction): string =>
  (f === Faction.Rome ? AQUILA : f === Faction.Carthage ? TANIT_STANDARD : HORNED_STANDARD);

// ---------------------------------------------------------------------------
// Formation glyphs, generated from the real formation functions
// ---------------------------------------------------------------------------

const GLYPH_CACHE = new Map<string, string>();

/**
 * Lay out ~24 men with the formation's own offset function, normalise into the
 * viewBox and emit them as dots. The icon and the sim can therefore never disagree.
 */
export function formationGlyph(id: string): string {
  const cached = GLYPH_CACHE.get(id);
  if (cached) return cached;

  const def = FORMATIONS[id];
  if (!def) return ICON.flag;

  const n = 24;
  const width = Math.max(3, Math.min(8, def.width(n)));
  const ranks = Math.ceil(n / width);
  const pts: Array<{ x: number; z: number }> = [];
  const out = { x: 0, z: 0 };
  for (let s = 0; s < n; s++) {
    def.offset(out, s, width, ranks, 1, 1);
    pts.push({ x: out.x, z: out.z });
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanZ = Math.max(0.001, maxZ - minZ);
  // Uniform scale keeps the aspect honest: a testudo block stays square, a line stays wide.
  const pad = 3.2;
  const k = Math.min((24 - pad * 2) / spanX, (18 - pad * 2) / spanZ);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const r = Math.max(1.05, Math.min(1.75, k * 0.4));

  let body = '';
  for (const p of pts) {
    const px = 12 + (p.x - cx) * k;
    // +Z is the facing direction in unit space, and the glyph faces up the icon.
    const py = 10.5 - (p.z - cz) * k;
    body += `<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${r.toFixed(2)}"/>`;
  }
  // A facing bar under the front rank so orientation is unambiguous.
  body += `<path d="M5.5 21.2h13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".45"/>`;
  body += `<path d="M12 18.2 10.2 20.6h3.6z" opacity=".65"/>`;

  GLYPH_CACHE.set(id, body);
  return body;
}
