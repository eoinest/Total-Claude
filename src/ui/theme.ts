/**
 * HUD colour and vocabulary tables.
 *
 * The CSS custom properties in `hud.css` are the source of truth for panel chrome;
 * this module mirrors the handful of values that canvas drawing (portraits, minimap)
 * and inline styling also need, plus the label vocabulary shown to the player.
 */

import { Faction, FACTIONS, UnitOrder, type UnitClass, type UnitGroupState } from '../sim/types';

export const hexOf = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

/** Mix two 0xRRGGBB colours; `t` = 0 gives `a`. */
export function mixHex(a: number, b: number, t: number): string {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

export interface FactionUI {
  id: Faction;
  /** Used as a `data-f` attribute so CSS can theme per side. */
  key: 'rome' | 'juthungi';
  short: string;
  long: string;
  colour: string;
  accent: string;
  /** Darkened plate colour behind portraits and blips. */
  deep: string;
  raw: number;
  /**
   * A lit version of the faction colour, mirroring `--rome-lit` / `--germanic-lit`.
   *
   * Canvas drawing brightens by strength, and mixing toward white for that turns Roman
   * oxblood into salmon and Juthungi blue into ice — at three pixels the two sides stop
   * being red and blue. Mixing toward this instead raises the value and leaves the hue.
   */
  litRaw: number;
}

export const FACTION_UI: Record<Faction, FactionUI> = {
  [Faction.Rome]: {
    id: Faction.Rome,
    key: 'rome',
    short: FACTIONS[Faction.Rome].shortName,
    long: 'Senatus Populusque Romanus',
    colour: hexOf(FACTIONS[Faction.Rome].colour),
    accent: hexOf(FACTIONS[Faction.Rome].accent),
    deep: '#3a1113',
    raw: FACTIONS[Faction.Rome].colour,
    litRaw: 0xd4444d,
  },
  [Faction.Germanic]: {
    id: Faction.Germanic,
    key: 'juthungi',
    short: FACTIONS[Faction.Germanic].shortName,
    long: 'Juthungi Confederation',
    colour: hexOf(FACTIONS[Faction.Germanic].colour),
    accent: hexOf(FACTIONS[Faction.Germanic].accent),
    deep: '#13212f',
    raw: FACTIONS[Faction.Germanic].colour,
    litRaw: 0x5b93c4,
  },
};

/** The side the player commands. Everything selectable belongs to it. */
export const PLAYER_FACTION = Faction.Rome;

/**
 * True when the page is being driven by `tools/shoot.mjs` rather than by a player.
 *
 * The harness is a measurement rig: every frame it grabs is used to judge the *battlefield*,
 * so nothing transient may cover it. Title card, results dispatch, hover tooltip and the
 * enemy order-of-battle strip are all suppressed under it. One flag, read once, so every
 * panel makes the same decision — an earlier pass had this test copied into a single module
 * and the panels added later did not get it.
 */
export const HARNESS =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('harness') === '1';

// ---------------------------------------------------------------------------
// Morale
// ---------------------------------------------------------------------------

export type MoraleState = 'steady' | 'wavering' | 'breaking' | 'routing';

export const MORALE_UI: Record<MoraleState, { label: string; colour: string }> = {
  steady: { label: 'Steady', colour: '#9dc57c' },
  wavering: { label: 'Wavering', colour: '#e3b64c' },
  breaking: { label: 'Breaking', colour: '#e07a2e' },
  routing: { label: 'Routing', colour: '#d94a3c' },
};

export function moraleStateOf(u: UnitGroupState): MoraleState {
  if (u.order === UnitOrder.Rout) return 'routing';
  const f = u.maxMorale > 0 ? u.morale / u.maxMorale : 0;
  if (f < 0.22) return 'breaking';
  if (f < 0.5) return 'wavering';
  return 'steady';
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const UNIT_CLASS_LABEL: Record<UnitClass, string> = {
  'heavy-infantry': 'Heavy Infantry',
  'light-infantry': 'Light Infantry',
  'spear-infantry': 'Spear Infantry',
  'missile-infantry': 'Missile Infantry',
  'shock-infantry': 'Shock Infantry',
  'heavy-cavalry': 'Heavy Cavalry',
  'light-cavalry': 'Light Cavalry',
  artillery: 'Artillery',
  general: 'General',
};

/** Ability ids appear in the roster as bare strings; give them player-facing prose. */
export const ABILITY_UI: Record<string, { name: string; desc: string; cooldown: number; duration: number }> = {
  testudo: { name: 'Testudo', desc: 'Shields to the front and overhead. Near-immune to missiles, nearly helpless in melee.', cooldown: 30, duration: 0 },
  'pilum-volley': { name: 'Pilum Volley', desc: 'Release the pila at the closing enemy — heavy armour-piercing damage at short range.', cooldown: 34, duration: 4 },
  inspire: { name: 'Inspire', desc: 'The standard is raised. Nearby friendly units recover morale.', cooldown: 70, duration: 22 },
  brace: { name: 'Brace', desc: 'Spear butts in the earth. Far stronger against a charge, immobile while held.', cooldown: 14, duration: 0 },
  'fire-at-will': { name: 'Fire at Will', desc: 'Shoot at targets of opportunity without waiting for the order.', cooldown: 6, duration: 0 },
  'arrow-storm': { name: 'Arrow Storm', desc: 'Every archer empties his quiver as fast as he can draw.', cooldown: 90, duration: 16 },
  charge: { name: 'Sound the Charge', desc: 'Spur to the gallop. Doubles the charge bonus, drains stamina hard.', cooldown: 46, duration: 10 },
  warcry: { name: 'War Cry', desc: 'The host bellows into its shields. Enemy morale falters, friendly morale surges.', cooldown: 54, duration: 14 },
  'framea-volley': { name: 'Framea Volley', desc: 'A hail of light throwing spears at close range.', cooldown: 30, duration: 4 },
  frenzy: { name: 'Frenzy', desc: 'Fight without regard for wounds — more damage taken, far more given.', cooldown: 80, duration: 20 },
  unbreakable: { name: 'Unbreakable', desc: 'These men will not run. They cannot be routed while it holds.', cooldown: 0, duration: 0 },
  'skirmish-mode': { name: 'Skirmish', desc: 'Fall back automatically rather than be caught in melee.', cooldown: 4, duration: 0 },
};

export const abilityUI = (id: string): { name: string; desc: string; cooldown: number; duration: number } =>
  ABILITY_UI[id] ?? { name: id.replace(/-/g, ' '), desc: '', cooldown: 20, duration: 0 };

export const ORDER_LABEL: Record<UnitOrder, string> = {
  [UnitOrder.Hold]: 'Holding',
  [UnitOrder.MoveTo]: 'Advancing',
  [UnitOrder.AttackMove]: 'Attack Move',
  [UnitOrder.AttackUnit]: 'Attacking',
  [UnitOrder.Withdraw]: 'Withdrawing',
  [UnitOrder.Rout]: 'Routing',
  [UnitOrder.Garrison]: 'Garrison',
};

/** Battle phase, derived from the field rather than tracked by the sim. */
export type Phase = 'deployment' | 'advance' | 'skirmish' | 'clash' | 'rout' | 'aftermath';

export const PHASE_UI: Record<Phase, { label: string; note: string }> = {
  deployment: { label: 'Deployment', note: 'The lines are dressing' },
  advance: { label: 'The Advance', note: 'Ground is being closed' },
  skirmish: { label: 'Missile Exchange', note: 'Arrows and pila in the air' },
  clash: { label: 'The Clash', note: 'Shield against shield' },
  rout: { label: 'The Rout', note: 'A line has broken' },
  aftermath: { label: 'Aftermath', note: 'The field is decided' },
};
