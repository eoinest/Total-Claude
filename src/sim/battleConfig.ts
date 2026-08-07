/**
 * Battle configuration — the vocabulary shared by the pre-battle menu and the deployment.
 *
 * This module is the seam between UI and simulation, so it imports neither. `MainMenu`
 * produces a `BattleConfig`, `deploySiegeOfRome` consumes one, and nothing else needs to
 * know how the other half works. Keeping the defaults here rather than in the menu means a
 * harness run (which never opens the menu) and a player run share one definition of what
 * the battle *is*.
 *
 * Modelled on Total War's custom-battle setup, which splits the same decision in two:
 *   - **Unit size** is a global multiplier on every unit's establishment, set once and
 *     applied to both armies. It is a graphics/scale setting, not a tactical one.
 *   - **Army composition** is per side, chosen unit by unit from that faction's roster.
 * Both are reproduced below. What is deliberately *not* reproduced is Rome II's "funds"
 * budget: it exists to stop a player fielding twenty elite units in a campaign context
 * where cost matters, and here there is no campaign for it to matter in.
 */

import type { QualityTier } from '../core/Engine';
import { DEFAULT_MAP_ID, getMap, isMapId, type MapId } from '../maps';
import { formation } from './formations';
import { Faction } from './types';
import { unitType } from '../units/roster';

export type Difficulty = 'easy' | 'normal' | 'hard' | 'legendary';

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/**
 * Which battle is being fought.
 *
 * `field` is the one the game has always opened on: two armies drawn up on the Campus
 * Martius with the wall a distant backdrop. `assault` is the storming of the curtain — a
 * garrison on the parapet, towers, ladders and a ram coming at it.
 *
 * Declared here rather than in `scenario.ts` because `scenario.ts` imports this module and
 * the dependency must not run both ways. `scenario.ts` re-exports it as `ScenarioVariant`,
 * which is the name its deployment functions have always used.
 */
export type ScenarioId = 'field' | 'assault';

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  subtitle: string;
  blurb: string;
  /**
   * True when the battle needs a walled city on the map.
   *
   * `main.ts` only registers `CitySystem` when the map carries a `CityPlan`, so on Pydna
   * there is no curtain, no gate and no parapet — an assault there would deploy a garrison
   * onto nothing. `sanitiseConfig` enforces the pairing rather than leaving it to the menu,
   * so a hand-made `?battle=` token cannot ask for the impossible one either.
   */
  needsCity: boolean;
}

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'field',
    label: 'Field Battle',
    subtitle: 'The Campus Martius',
    blurb: 'Two armies in the open north of the city. Aurelian’s field army stands between '
      + 'the Juthungi host and the unfinished wall behind it.',
    needsCity: false,
  },
  {
    id: 'assault',
    label: 'Assault',
    subtitle: 'Storming the Aurelian Wall',
    blurb: 'The host comes at the curtain itself: siege towers against the finished bays, '
      + 'ladders where the parapet has not been raised, a ram at the Porta Flaminia, and a '
      + 'garrison of ballistarii shooting down into it.',
    needsCity: true,
  },
];

export const scenarioDef = (id: ScenarioId): ScenarioDef =>
  SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

// ---------------------------------------------------------------------------
// Unit size
// ---------------------------------------------------------------------------

export type UnitSizeId = 'small' | 'normal' | 'large' | 'ultra' | 'extreme';

export interface UnitSizePreset {
  id: UnitSizeId;
  label: string;
  /** Multiplier on every non-artillery unit's roster strength. */
  scale: number;
}

/**
 * Total War's unit-size ladder, in its naming.
 *
 * The multipliers are expressed against this project's roster strengths rather than copied
 * from Rome II's database, because the two rosters are not the same: a `legio-cohort` here
 * has a base establishment of 160, so `ultra` at 2.0 fields the 320-man cohort the game has
 * always shipped and every measurement in docs/ was taken at. `ultra` is therefore the
 * default, and the ladder is built around it rather than around `normal`.
 *
 * `extreme` is offered even though it does not fit the soldier pool at any tier — see
 * `fittedUnitScale`, which clamps it and reports the clamp so the menu can say so out loud.
 * Silently substituting a smaller battle for the one the player picked would be worse.
 */
export const UNIT_SIZES: readonly UnitSizePreset[] = [
  { id: 'small', label: 'Small', scale: 0.5 },
  { id: 'normal', label: 'Normal', scale: 1.0 },
  { id: 'large', label: 'Large', scale: 1.5 },
  { id: 'ultra', label: 'Ultra', scale: 2.0 },
  { id: 'extreme', label: 'Extreme', scale: 3.0 },
];

export const unitSizePreset = (id: UnitSizeId): UnitSizePreset =>
  UNIT_SIZES.find((p) => p.id === id) ?? UNIT_SIZES[3];

// ---------------------------------------------------------------------------
// Army composition
// ---------------------------------------------------------------------------

/** How many units of each roster type a side fields, keyed by roster id. */
export type ArmyComposition = Readonly<Record<string, number>>;

/**
 * The roster rows the menu offers per side, in the order they are drawn up.
 *
 * Order matters twice: it is the order of the menu rows, and it is the order the deployment
 * walks, which fixes spawn order and therefore which units get men first if the pool runs
 * short. Main line before reserves before flanks, so a truncated army still has a line.
 */
export const ROME_ROSTER: readonly string[] = [
  'legio-cohort', 'praetorian-cohort', 'urban-cohort', 'sagittarii', 'equites', 'scorpio',
];

export const JUTHUNGI_ROSTER: readonly string[] = [
  'juthungi-warband', 'juthungi-spears', 'juthungi-skirmishers',
  'juthungi-chosen', 'juthungi-berserkers', 'juthungi-riders',
];

/**
 * Carthage, in deployment order: line, then the reserve, then the screen and the wings.
 *
 * The elephants are last for a reason that is not cosmetic. Order decides which units get
 * men first when the pool runs short, and an elephant unit is eight pool slots against a
 * Libyan block's three hundred and twenty — so putting them last costs the army almost
 * nothing if it is truncated, where putting them first would guarantee eight animals and
 * then lose a whole spear block off the end.
 */
export const CARTHAGE_ROSTER: readonly string[] = [
  'libyan-spearmen', 'iberian-scutarii', 'gallic-mercenaries', 'sacred-band',
  'iberian-caetrati', 'balearic-slingers', 'numidian-cavalry', 'war-elephants',
];

/**
 * The assault's own orders of battle, which share almost nothing with the field's.
 *
 * A siege is not the same army doing something else. Rome fields wall troops — short-reach
 * missile units the siege system pins along the parapet, plus carroballistae behind it and a
 * cohort or two inside the gate to plug a breach; there is no cavalry on a wall-walk and no
 * use for a wedge. The Juthungi field the machines and the parties that serve them, and their
 * warbands stand in the open waiting their turn. Offering a player ram crews for a battle on
 * open grass, or refusing them one for a storm, would be worse than offering no editor at all,
 * so the roster rows follow the scenario and `rosterFor` takes it as an argument rather than
 * defaulting — a wrong default here is silent and the typecheck would not catch it.
 *
 * Order is deployment order, as in the field rosters: for Rome the bays nearest the gate are
 * filled first, so the row order decides which type holds the finished curtain and which the
 * unfinished stretch.
 */
export const SIEGE_ROME_ROSTER: readonly string[] = [
  'ballistarii', 'wall-slingers', 'carroballista', 'legio-cohort',
];

export const SIEGE_JUTHUNGI_ROSTER: readonly string[] = [
  'tower-assault', 'escalade-party', 'ram-crew', 'onager',
  'juthungi-warband', 'juthungi-riders',
];

export const rosterFor = (f: Faction, s: ScenarioId): readonly string[] => {
  if (s === 'assault') return f === Faction.Rome ? SIEGE_ROME_ROSTER : SIEGE_JUTHUNGI_ROSTER;
  if (f === Faction.Carthage) return CARTHAGE_ROSTER;
  return f === Faction.Rome ? ROME_ROSTER : JUTHUNGI_ROSTER;
};

/**
 * Hard cap on units per side.
 *
 * Twenty is Total War's own limit and the reason for it is not technical: past twenty a
 * player cannot hold the order of battle in their head, and the unit cards stop fitting
 * across the screen. This project already hit the second half of that — an earlier pass at
 * unit-size 1.6 needed 48 units to reach the same headcount and the card bar ate a third of
 * the viewport. The menu enforces it per side rather than per army group.
 */
export const MAX_UNITS_PER_SIDE = 20;

/** Per-type ceiling, so one row cannot consume the whole army allowance on its own. */
export const MAX_PER_TYPE = 12;

// ---------------------------------------------------------------------------
// The configuration itself
// ---------------------------------------------------------------------------

export interface BattleConfig {
  /**
   * Which battlefield. Defaults to the Campus Martius, so an existing player's stored
   * preference and every harness run that does not ask for anything else get exactly the
   * battle the game shipped with.
   */
  map: MapId;
  /**
   * Which battle. Defaults to `field`, so a stored preference written by a build that
   * predates this field, and every `?battle=` token already in the wild, decode to exactly
   * the battle they always did.
   */
  scenario: ScenarioId;
  unitSize: UnitSizeId;
  /**
   * Who Rome is fighting.
   *
   * Two factions needed no such field: the enemy was whoever Rome was not. Three do, and it
   * has to be a stored choice rather than something inferred from which composition happens
   * to be non-empty, because both are always carried — see `siegeRome`/`siegeJuthungi` for
   * the same argument. Defaults to `Germanic`, so every `?battle=` token written before this
   * field existed, and `DEFAULT_CONFIG` itself, still describe the battle they always did.
   *
   * `assault` ignores it: storming the Aurelian Wall is a Juthungi operation and a
   * Carthaginian army has no business on the Campus Martius in 271.
   */
  opponent: Faction;
  rome: ArmyComposition;
  juthungi: ArmyComposition;
  carthage: ArmyComposition;
  /**
   * The assault's compositions, held separately rather than reusing `rome`/`juthungi`.
   *
   * The two rosters are disjoint, so one pair of fields could not hold both: switching
   * scenario would zero every row and the player would lose the order of battle they had
   * just built on the other side of the switch. Two pairs cost eight numbers in the token
   * and mean a player can flip between the two battles without losing either.
   */
  siegeRome: ArmyComposition;
  siegeJuthungi: ArmyComposition;
  quality: QualityTier;
  difficulty: Difficulty;
  /** Hour of day, 4..21, matching the SkySystem's own range. */
  timeOfDay: number;
  /** Seed for the battle's random streams. Same seed and config replays identically. */
  seed: number;
}

/**
 * The historical order of battle, and the default.
 *
 * These counts reproduce the deployment the game shipped with exactly, so a player who
 * presses Begin without touching anything gets the battle every screenshot and every
 * measurement in docs/ was taken from. Rome is deliberately outnumbered and out-fronted:
 * 3,784 against 4,860, 248 m of frontage against 334 m.
 */
export const DEFAULT_CONFIG: BattleConfig = {
  map: DEFAULT_MAP_ID,
  scenario: 'field',
  unitSize: 'ultra',
  opponent: Faction.Germanic,
  rome: {
    'legio-cohort': 6,
    'praetorian-cohort': 2,
    'urban-cohort': 2,
    sagittarii: 2,
    equites: 3,
    scorpio: 1,
  },
  juthungi: {
    'juthungi-warband': 6,
    'juthungi-spears': 3,
    'juthungi-skirmishers': 3,
    'juthungi-chosen': 2,
    'juthungi-berserkers': 2,
    'juthungi-riders': 3,
  },
  /**
   * A Punic order of battle in Hannibal's proportions rather than in Rome's.
   *
   * Four line units of three different nationalities, a citizen reserve of one, a screen of
   * skirmishers and slingers, four squadrons of Numidian horse and two units of elephants.
   * The mercenary contingents outnumber the citizens seven to one, which is the correct
   * ratio and is the single fact about this army that matters most.
   *
   * Only ever deployed when `opponent` is `Carthage`, so it costs the shipped battle nothing.
   */
  carthage: {
    'libyan-spearmen': 4,
    'iberian-scutarii': 3,
    'gallic-mercenaries': 3,
    'sacred-band': 1,
    'iberian-caetrati': 2,
    'balearic-slingers': 2,
    'numidian-cavalry': 3,
    'war-elephants': 2,
  },
  /**
   * The assault's default order of battle, which is the one `deployAssault` hardcoded before
   * the menu could reach it: eight units of wall troops holding the eight bays either side of
   * the Porta Flaminia, two carroballistae behind the parapet and two cohorts inside the gate.
   */
  siegeRome: {
    ballistarii: 5,
    'wall-slingers': 3,
    carroballista: 2,
    'legio-cohort': 2,
  },
  /**
   * And the storm: four towers, four ladder parties at three ladders apiece (the twelve
   * `tools/probe-siege.mjs` measures), one ram, three onager batteries and the host behind.
   *
   * Twenty units is exactly `MAX_UNITS_PER_SIDE`, so the Juthungi start the assault full: a
   * player adding a fifth tower has to give up something, which is the correct shape for the
   * decision and not an accident of the numbers.
   */
  siegeJuthungi: {
    'tower-assault': 4,
    'escalade-party': 4,
    'ram-crew': 1,
    onager: 3,
    'juthungi-warband': 6,
    'juthungi-riders': 2,
  },
  quality: 'ultra',
  difficulty: 'hard',
  timeOfDay: 10,
  // `Rng.hashString('battle-271')`, which is the seed the battle used before it was
  // configurable. Pinned to the literal so the default battle is bit-identical to the one
  // every figure in docs/ and the README was measured from — contact at t+80 with 444 men
  // engaged, a passive Rome losing 37%. Moving it to a tidier number silently invalidated all
  // of those, which is a poor trade for a rounder default.
  seed: 4265438264,
};

/**
 * A side's composition for one scenario. Defaults to the config's own scenario, which is
 * what every display path wants; the deployment passes the variant explicitly because
 * `deployAssault` falls back to the field battle on a map with no wall and must then read
 * the field's composition rather than the siege one.
 */
export const compositionFor = (
  c: BattleConfig, f: Faction, s: ScenarioId = c.scenario
): ArmyComposition => {
  if (s === 'assault') return f === Faction.Rome ? c.siegeRome : c.siegeJuthungi;
  if (f === Faction.Carthage) return c.carthage;
  return f === Faction.Rome ? c.rome : c.juthungi;
};

/**
 * The two factions actually on the field, Rome first.
 *
 * Everywhere that used to write `[Faction.Rome, Faction.Germanic]` should ask this instead:
 * that literal is correct for the shipped battle and silently wrong for any other, and it
 * appeared in enough places — strength tallies, pool fitting, the menu's army panels — that
 * a shared accessor is the only way they stay in step.
 */
export const belligerents = (c: BattleConfig): readonly [Faction, Faction] =>
  [Faction.Rome, c.scenario === 'assault' ? Faction.Germanic : c.opponent] as const;

/** Units in a side's composition, ignoring rows set to zero. */
export const unitCount = (comp: ArmyComposition): number =>
  Object.values(comp).reduce((a, n) => a + Math.max(0, n), 0);

/**
 * Flattened spawn list for a side: one entry per unit, in roster order.
 *
 * The deployment and the pool-fitting maths both walk this, which is what keeps them from
 * disagreeing about how many men the battle needs.
 */
export function spawnList(c: BattleConfig, f: Faction, s: ScenarioId = c.scenario): string[] {
  const comp = compositionFor(c, f, s);
  const out: string[] = [];
  for (const id of rosterFor(f, s)) {
    for (let k = 0; k < Math.max(0, comp[id] ?? 0); k++) out.push(id);
  }
  return out;
}

/** Unscaled establishment of a whole battle, both sides, artillery included. */
export function baseStrength(c: BattleConfig, s: ScenarioId = c.scenario): number {
  let sum = 0;
  for (const f of belligerents(c)) {
    for (const id of spawnList(c, f, s)) sum += unitType(id).strength;
  }
  return sum;
}

/**
 * The largest unit-size scale whose battle still fits the quality tier's soldier pool.
 *
 * This matters more than it looks. `spawnUnit` stops allocating when the pool is full, and
 * Rome deploys first — so at `low` (1,600 men) and `medium` (3,200) the default order of
 * battle exhausted the pool partway through the Roman line and **the entire Juthungi army
 * spawned with zero men**. The two sides then stood 130 m apart for the whole battle with
 * nobody in contact, which read as a broken AI rather than a broken pool.
 *
 * Scaling every unit down keeps all units present and the tactical picture intact at every
 * tier; losing an army does not. The 6% headroom absorbs the artillery crews, which
 * `spawnUnit` deliberately does not scale.
 */
export function fittedUnitScale(
  c: BattleConfig, maxSoldiers: number, s: ScenarioId = c.scenario
): number {
  const asked = scaleAppliesTo(s) ? unitSizePreset(c.unitSize).scale : 1;
  const base = baseStrength(c, s);
  if (base <= 0) return asked;
  return Math.min(asked, (maxSoldiers * 0.94) / base);
}

/**
 * Whether the battle-size multiplier means anything for this scenario. It does not for the
 * assault, and that is a measurement rather than an opinion.
 *
 * A garrison is not laid out in a formation; `Siege.layOutGarrison` packs it along the
 * wall-walk, one continuous run per unit, at `WALL_RANK_PITCH` 0.72 m in at most
 * `MAX_WALL_RANKS` = 3 ranks, and a bay run is about 28 stations — roughly 84 places. A
 * 108-man ballistarii unit already fills that. Doubling it to 216 at `ultra` does not put
 * more men on the wall, because `slotAt` clamps a man's offset between the walkway's inner
 * and outer edges: the surplus ranks all resolve to the same inner line and the unit renders
 * as men standing inside each other. The wall holds what it holds.
 *
 * So the assault deploys at establishment and the size knob is greyed with a reason. The
 * customisation that *is* real for a storm is how many units — more ballistarii hold more
 * bays, more ladder parties pitch more ladders — and that is exactly what the roster rows do.
 */
export const scaleAppliesTo = (s: ScenarioId): boolean => s !== 'assault';

/** True when the pool forced a smaller battle than the menu asked for. */
export const isScaleClamped = (
  c: BattleConfig, maxSoldiers: number, s: ScenarioId = c.scenario
): boolean =>
  scaleAppliesTo(s)
  && fittedUnitScale(c, maxSoldiers, s) < unitSizePreset(c.unitSize).scale - 1e-6;

/**
 * Headcount above which the 60 fps floor has been measured to fail.
 *
 * The soldier pool bounds the battle at roughly 11,280 men, but the *frame budget* gives out
 * well before the pool does, and docs/ARCHITECTURE.md calls 60 fps at 1920x1080 on an M4 Max
 * non-negotiable. Measured on the `rout` shot, which is the only fixed-camera heavy frame in
 * the pass and therefore the only one comparable across configurations — `melee` auto-frames
 * on the contact centroid, so it lands somewhere different for every order of battle and its
 * numbers cannot be compared:
 *
 *     men      rout ms    fps
 *     8,644     13.44      74     <- the historical default
 *     9,584     16.14      62
 *    11,255     19.21      52     <- the largest the menu can produce
 *
 * 16.67 ms is crossed just under 10,000, so 9,000 is the line with a margin for the heavier
 * local density a melee camera finds. The menu warns past it rather than refusing: the point
 * of the menu is to configure the battle, and Total War likewise warns about unit size rather
 * than capping it. Anyone who wants a 40 fps battle of eleven thousand men may have one, but
 * they should not be surprised by it.
 */
export const PERF_VALIDATED_MEN = 9000;

/** Total men both sides field at the fitted scale. */
export const totalMen = (
  c: BattleConfig, maxSoldiers: number, s: ScenarioId = c.scenario
): number =>
  belligerents(c).reduce((n, f) => n + summarise(c, f, maxSoldiers, s).men, 0);

/**
 * The types that stand in the main battle line, for the line-width figure.
 *
 * Mirrors the deployment in `scenario.ts`, and the duplication is deliberate: summing *every*
 * unit's width reported 514 m against 598 m, which told the player their army was twice as
 * wide as the front it can actually present. Reserves, screens, wings and artillery are
 * excluded because none of them holds ground in the line.
 *
 * This is **combined unit width — how much line an army can form — and not the same number
 * as the "out-fronted 248 m to 334 m" in the README**, which is *deployed span*: the Roman
 * line stands on 64 m centres with deliberate half-cohort intervals, so it covers more ground
 * than the sum of its shields, while the Juthungi at 46 m centres stand nearly shoulder to
 * shoulder. The two figures agree for the Juthungi (336 against 334) and diverge for Rome
 * (324 against 248) for exactly that reason. Do not "fix" either to match the other; they
 * measure different things and the menu wants this one, because it is the figure that
 * responds to adding a cohort.
 */
const LINE_TYPES: ReadonlySet<string> = new Set([
  'legio-cohort', 'urban-cohort',
  'juthungi-warband', 'juthungi-spears',
  // Carthage's battle line is the three heavy contingents. The Sacred Band is a reserve of
  // one unit, the caetrati and slingers are a screen, and the elephants stand in front of
  // the line rather than in it — none of them holds frontage.
  'libyan-spearmen', 'iberian-scutarii', 'gallic-mercenaries',
]);

/**
 * The same idea for the assault, where "the line" means two different things per side.
 *
 * Rome's line is the garrison strung along the parapet, and its width is the useful figure a
 * player is actually choosing: **how many metres of curtain they can hold**. The reserve
 * cohorts and the carroballistae are behind it and hold no wall. The Juthungi's line is the
 * warbands waiting in the open; the towers, ladder parties, ram and onagers are the assault
 * itself and stand in no line at all, so counting them would report a front the host never
 * forms. `MainMenu` labels the two cases differently for the same reason.
 */
const SIEGE_LINE_TYPES: ReadonlySet<string> = new Set([
  'ballistarii', 'wall-slingers',
  'juthungi-warband',
]);

export const lineTypesFor = (s: ScenarioId): ReadonlySet<string> =>
  s === 'assault' ? SIEGE_LINE_TYPES : LINE_TYPES;

export interface SideSummary {
  units: number;
  men: number;
  /** Width in metres of the main battle line, excluding reserves, wings and artillery. */
  frontage: number;
}

/**
 * What the menu displays, computed the same way the sim will compute it.
 *
 * Strength uses the *fitted* scale and the same `Math.max(1, Math.round(...))` and
 * artillery exemption as `spawnUnit`, and frontage asks the real `formation` table rather
 * than approximating, so the numbers on the menu are the numbers the battle produces. An
 * earlier draft estimated both and was out by 400 men at `small`.
 */
export function summarise(
  c: BattleConfig, f: Faction, maxSoldiers: number, sc: ScenarioId = c.scenario
): SideSummary {
  const scale = fittedUnitScale(c, maxSoldiers, sc);
  const line = lineTypesFor(sc);
  let men = 0;
  let frontage = 0;
  const list = spawnList(c, f, sc);
  for (const id of list) {
    const def = unitType(id);
    const s = Math.max(1, Math.round(def.strength * (def.unitClass === 'artillery' ? 1 : scale)));
    men += s;
    if (line.has(id)) frontage += formation(def.formations[0]).width(s);
  }
  return { units: list.length, men, frontage: Math.round(frontage) };
}

// ---------------------------------------------------------------------------
// Validation and persistence
// ---------------------------------------------------------------------------

const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

/**
 * Coerce anything into a usable config.
 *
 * Everything here can arrive from a URL a stranger typed or from a localStorage entry
 * written by an older build, so no field is trusted. A side that ends up with no units at
 * all is refilled from the default, because a battle with an empty army is not a battle —
 * it hits the `battleEnded` path on the first tick and the player sees a results screen
 * instead of a game.
 */
export function sanitiseConfig(raw: unknown): BattleConfig {
  const o = (raw ?? {}) as Partial<BattleConfig>;
  const side = (v: unknown, f: Faction, sc: ScenarioId): ArmyComposition => {
    const src = (v ?? {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    let total = 0;
    for (const id of rosterFor(f, sc)) {
      const n = clampInt(src[id], 0, MAX_PER_TYPE, 0);
      // Respect the per-side cap even if the input ignored it, trimming later rows first.
      const room = Math.max(0, MAX_UNITS_PER_SIDE - total);
      out[id] = Math.min(n, room);
      total += out[id];
    }
    if (total === 0) return compositionFor(DEFAULT_CONFIG, f, sc);
    return out;
  };
  // Resolved first: the map decides the default hour, because 10:00 is the right opening
  // light on the Campus Martius and a high, flat, shadowless one over a Macedonian plain on
  // the solstice. An *explicitly supplied* hour is always respected — only an absent one
  // falls back to the map's own.
  const map: MapId = isMapId(o.map) ? o.map : DEFAULT_MAP_ID;
  const defaultHour = getMap(map).sky.defaultHour;
  /**
   * The scenario, and the one pairing that cannot exist.
   *
   * Absent means `field`, which is what makes every `?battle=` token written before this
   * field existed decode to the battle it always described. An assault is then refused on any
   * map that hides the city: `main.ts` does not register `CitySystem` there, so Pydna has no
   * curtain, no gate and no parapet, and `deployAssault` would find zero garrison bays. It
   * already falls back to the field battle in that case, but silently — the player would ask
   * for a storm and be given a field battle with no explanation. Resolving it here means the
   * config never carries the impossible pairing at all, so the menu can *show* the constraint
   * instead of the deployment quietly working around it.
   */
  const askedScenario: ScenarioId = o.scenario === 'assault' ? 'assault' : 'field';
  const scenario: ScenarioId =
    askedScenario === 'assault' && !getMap(map).city ? 'field' : askedScenario;
  const sizes = UNIT_SIZES.map((p) => p.id) as string[];
  const tiers: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
  const diffs: Difficulty[] = ['easy', 'normal', 'hard', 'legendary'];
  return {
    map,
    scenario,
    unitSize: sizes.includes(String(o.unitSize)) ? (o.unitSize as UnitSizeId) : DEFAULT_CONFIG.unitSize,
    // Both orders of battle are always sanitised and always carried, whichever one is being
    // fought, so switching scenario in the menu never destroys the other one.
    opponent: o.opponent === Faction.Carthage ? Faction.Carthage : Faction.Germanic,
    rome: side(o.rome, Faction.Rome, 'field'),
    juthungi: side(o.juthungi, Faction.Germanic, 'field'),
    carthage: side(o.carthage, Faction.Carthage, 'field'),
    siegeRome: side(o.siegeRome, Faction.Rome, 'assault'),
    siegeJuthungi: side(o.siegeJuthungi, Faction.Germanic, 'assault'),
    quality: tiers.includes(o.quality as QualityTier) ? (o.quality as QualityTier) : DEFAULT_CONFIG.quality,
    difficulty: diffs.includes(o.difficulty as Difficulty)
      ? (o.difficulty as Difficulty)
      : DEFAULT_CONFIG.difficulty,
    timeOfDay: o.timeOfDay === undefined ? defaultHour : clampInt(o.timeOfDay, 4, 21, defaultHour),
    // Full unsigned 32-bit: the generator's state is a uint32 and the historical default
    // seed (4,265,438,264) is above 0x7fffffff, so a signed clamp silently rewrote it.
    seed: clampInt(o.seed, 0, 0xffffffff, DEFAULT_CONFIG.seed),
  };
}

const STORE_KEY = 'total-claude.battle';

export function loadStoredConfig(): BattleConfig | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? sanitiseConfig(JSON.parse(raw)) : null;
  } catch {
    // Private browsing, a quota error or hand-edited JSON. A missing preference is not
    // worth failing a boot over.
    return null;
  }
}

export function storeConfig(c: BattleConfig): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    /* nothing to do — the battle still runs, it just will not be remembered */
  }
}

/**
 * Encode a config for the URL so a setup can be shared or replayed.
 *
 * base64url of JSON rather than a field-per-param: the composition alone is twelve numbers,
 * and twelve query parameters that must all agree with each other is a worse thing to hand
 * someone than one opaque token. `?quality=` and `?difficulty=` are still read separately
 * by main.ts for the harness, and those win over anything in here.
 */
export function encodeConfig(c: BattleConfig): string {
  const json = JSON.stringify(c);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfig(token: string): BattleConfig | null {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    return sanitiseConfig(JSON.parse(atob(b64)));
  } catch {
    return null;
  }
}
