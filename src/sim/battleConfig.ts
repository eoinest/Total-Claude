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
import { Faction, SOLDIER_POOL_CAPACITY } from './types';
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
    subtitle: 'In the open',
    blurb: 'Two armies drawn up on open ground, with whatever the map puts behind them.',
    needsCity: false,
  },
  {
    id: 'assault',
    label: 'Assault',
    subtitle: 'Storming the wall',
    blurb: 'The host comes at the curtain itself: siege towers against the finished bays, '
      + 'ladders where the parapet is weakest, a ram at the gate, and a garrison shooting '
      + 'down into it.',
    needsCity: true,
  },
];

export const scenarioDef = (id: ScenarioId): ScenarioDef =>
  SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

/**
 * The scenario's label and blurb *for a given map*, which is what the menu should show.
 *
 * The two scenario rows read "The Campus Martius" and "Storming the Aurelian Wall", which was
 * exact while there was one battlefield and one wall and is a lie on any other map: a player
 * who picks Pydna and reads "The Campus Martius" under Field Battle has been told the wrong
 * thing by the interface. The map already carries a subtitle and, if it has a city, that
 * city's name, so the specifics come from there and the scenario keeps only what is true of
 * every instance of it.
 */
export function scenarioFor(id: ScenarioId, mapId: MapId): ScenarioDef {
  const def = scenarioDef(id);
  const map = getMap(mapId);
  if (id === 'assault') {
    const city = map.city;
    return city
      ? { ...def, subtitle: `Storming ${city.name}`, blurb: `${def.blurb} The wall is ${city.name}’s.` }
      : def;
  }
  return { ...def, subtitle: map.label };
}

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
 * A siege is not the same army doing something else. A garrison is wall troops — the siege
 * system pins them along the parapet — plus artillery behind it and formed infantry inside
 * the gate to plug a breach; there is no cavalry on a wall-walk and no use for a wedge. The
 * storming side fields the machines and the parties that serve them, and its line units stand
 * in the open waiting their turn. Offering a player ram crews for a battle on open grass, or
 * refusing them one for a storm, would be worse than offering no editor at all, so the roster
 * rows follow the scenario, and `rosterFor` takes it as an argument rather than defaulting —
 * a wrong default here is silent and the typecheck would not catch it.
 *
 * **Keyed by faction *and* role, because a faction is not a side.** Rome garrisons the
 * Aurelian Wall in 271 AD and storms Carthage in 146 BC, and those are two different armies
 * out of one roster. Two flat lists per faction could not express that, which is why
 * `deployAssault` used to spawn Roman `ballistarii` onto Carthage's parapet whatever
 * `CityPlan.garrison` said.
 *
 * Order within each list is deployment order, as in the field rosters: for the wall it is the
 * order the bays are filled outward from the gate, so the row order decides which type holds
 * the curtain nearest the gate.
 */
export type SiegeRole = 'garrison' | 'storm';

/** Which unit types hold each part of a defended circuit. */
export interface GarrisonPlan {
  /** Troops the siege system pins along the wall-walk, in bay-filling order. */
  wall: readonly string[];
  /** Artillery sited behind the parapet. */
  engines: readonly string[];
  /** Formed infantry held inside the walls to plug whatever gets over. */
  reserve: readonly string[];
}

/** Which unit types do each job of a storm. */
export interface StormPlan {
  /** The party that rides a siege tower up to the walk. */
  tower: string;
  /** The party that pitches the ladders. */
  ladder: string;
  /** The gang on the ram. */
  ram: string;
  /**
   * The gang on the **great** ram, where this army brings one. Optional, and optional is
   * the point.
   *
   * A *testudo arietaria* at scale is not a machine every siege train has. Scipio's park in
   * 146 has four towers, four ladder parties, a ram and three batteries and is already at
   * `MAX_UNITS_PER_SIDE`; the Juthungi's is at the cap too and buys its great ram by giving
   * up a squadron of horse (see `siegeJuthungi`). Making the slot optional is what lets one
   * army field one without the other having to, and without a second table.
   *
   * `siegeRosterFor` emits it right after `ram`, so the menu row and the deployment order
   * agree, and an army without one simply has no row.
   */
  greatRam?: string;
  /** Batteries standing off and shooting at the parapet. */
  batteries: readonly string[];
  /** The host waiting its turn in the open, which is most of an assault. */
  host: readonly string[];
  /**
   * How the host stands while it waits, which is a real difference between the two armies:
   * a Germanic host is a `horde` and a consular army waiting to go in is in `line`.
   */
  hostFormation: string;
  /** Horse on the wings, with nothing to do until a gate opens. */
  horse: readonly string[];
}

export const GARRISON_PLANS: Partial<Record<Faction, GarrisonPlan>> = {
  // Rome, 271 AD: ballistarii take the finished curtain nearest the gate and the slingers
  // what is left, which is the unfinished stretch with no parapet — a sling does not need one.
  [Faction.Rome]: {
    wall: ['ballistarii', 'wall-slingers'],
    engines: ['carroballista'],
    reserve: ['legio-cohort'],
  },
  /*
   * Carthage, 146 BC: the levy holds the walk itself — Appian's 30-ft wall leaves 7.1 m of
   * clear standing band, so a Punic bay carries a formation rather than a picket — with the
   * freedmen's slings answering the approach. See `siegeUnits.ts` for why there are no
   * elephants and no Libyan veterans on this wall.
   *
   * **The order is deployment order, and it is why the Roman ram cannot be stopped.**
   * `deployAssault` concatenates this list and `fanOut`s it from the gate outward, so
   * "the freedmen's slings *behind* them", which this comment means in depth within a bay,
   * comes out as the freedmen *beyond* them, five bays along the curtain. Measured at
   * `cc72ea6`, 120 s into the assault: the nearest troops to the ram at the Porta Byrsae are
   * `punic-levy` at **29 m**, whose missile is a 30 m javelin with three per man, and the
   * `punic-freedmen` — the only real missile troops on this wall, 168 m slings — stand at
   * **113 to 158 m**, behind the levy and shooting at something else. So the Roman ram crew
   * takes **zero** damage: `tools/scratch/so-ramkill.mjs` reports `killed by: nobody,
   * damage by: none` over 140 s including forty of battering, and the machine goes 26 blows,
   * gate open at t+220, `spent` with all thirty-two men, on an unvarying schedule. The player
   * *is* the besieger on this map and has nothing to protect. Rome's own plan is the other
   * way round — `['ballistarii', 'wall-slingers']` puts 216 crossbows 53-60 m from the
   * Juthungi ram and kills its crew on every seed — so one siege has an invulnerable ram and
   * the other a doomed one, and the whole difference is which word comes first in these two
   * lists.
   *
   * **Swapping them was tried and is refused, on the measurement.** `['punic-freedmen',
   * 'punic-levy']` does exactly what it should to the ram — the freedmen reach it, 1,599
   * points of damage and three of the crew dead by t+100 — and it costs Carthage the wall.
   * Over 24 seeds, `probe-footing --only=battle` at `quality=high`, cap 2400 s:
   *
   *     wall order                     Rome (the storming player) wins   Carthage routs
   *     ['punic-levy','punic-freedmen']            15 / 24                     1
   *     ['punic-freedmen','punic-levy']            21 / 24                    11
   *
   * The bays either side of the gate are where `deployAssault` also lands the towers and the
   * ladders, so putting the slingers there takes the close-fighting troops off the ground the
   * escalade arrives on: the freedmen are killed on the parapet and the Punic army breaks.
   * The two jobs — shoot whatever is at the gate, and hold the walk the ramps come down on —
   * want different troops on the *same* bays, and a flat list fanned outward from the gate
   * cannot say that. Depth within a bay can, and that is a change to `deployAssault`, not to
   * this list.
   */
  [Faction.Carthage]: {
    wall: ['punic-levy', 'punic-freedmen'],
    engines: ['punic-catapults'],
    reserve: ['punic-deserters'],
  },
};

export const STORM_PLANS: Partial<Record<Faction, StormPlan>> = {
  [Faction.Germanic]: {
    tower: 'tower-assault',
    ladder: 'escalade-party',
    ram: 'ram-crew',
    greatRam: 'great-ram-crew',
    batteries: ['onager'],
    host: ['juthungi-warband'],
    hostFormation: 'horde',
    horse: ['juthungi-riders'],
  },
  // Scipio's train. Two battery types rather than one, because a Roman siege park had both
  // and both are already modelled: the stone-throwers work on the merlons and the
  // carroballistae — the same unit that garrisons the Aurelian Wall in the other siege —
  // shoot flat at whoever is standing behind them.
  [Faction.Rome]: {
    tower: 'legio-tower-party',
    ladder: 'legio-escalade',
    ram: 'legio-ram-crew',
    batteries: ['legio-ballista', 'carroballista'],
    host: ['legio-cohort'],
    hostFormation: 'line',
    horse: ['equites'],
  },
};

/** Whose city stands on this map. Rome's is the fallback for a map with no city at all. */
export const garrisonOf = (mapId: MapId): Faction =>
  getMap(mapId).city?.garrison ?? Faction.Rome;

/**
 * Which side of an assault a faction is on, for a given map.
 *
 * The single question the whole generalisation turns on, and the map already answers it:
 * `CityPlan.garrison` says whose wall it is and everyone else is storming it.
 */
export const siegeRoleOf = (f: Faction, mapId: MapId): SiegeRole =>
  f === garrisonOf(mapId) ? 'garrison' : 'storm';

/**
 * A side's assault roster in menu and deployment order, flattened from its plan.
 *
 * Derived rather than written out a second time: the menu rows and the deployment then
 * cannot disagree about which types exist, which is the failure the old pair of hand-written
 * constants was one edit away from. At `(Rome, 'garrison')` and `(Germanic, 'storm')` this
 * reproduces the two shipped lists exactly.
 */
export const siegeRosterFor = (f: Faction, role: SiegeRole): readonly string[] => {
  if (role === 'garrison') {
    const p = GARRISON_PLANS[f];
    return p ? [...p.wall, ...p.engines, ...p.reserve] : [];
  }
  const p = STORM_PLANS[f];
  return p
    ? [p.tower, p.ladder, p.ram, ...(p.greatRam ? [p.greatRam] : []),
      ...p.batteries, ...p.host, ...p.horse]
    : [];
};

/**
 * The roster rows a side may field.
 *
 * `mapId` is only consulted for an assault, and only because Rome plays both sides of one:
 * without it there is no way to tell "Rome holding the Aurelian Wall" from "Rome storming
 * Carthage". It defaults to the campaign's own map so every field-battle caller is unchanged.
 */
export const rosterFor = (
  f: Faction, s: ScenarioId, mapId: MapId = DEFAULT_MAP_ID
): readonly string[] => {
  if (s === 'assault') return siegeRosterFor(f, siegeRoleOf(f, mapId));
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
   *
   * **Four fields, not two, and they are keyed by *role* rather than by faction.**
   * `siegeRome` is Rome holding the Aurelian Wall; `siegeRomanTrain` is Rome storming
   * Carthage. Those are disjoint rosters belonging to one faction, so one field could not
   * carry both any more than one field could carry the field battle and the storm. All four
   * are always sanitised and always carried, for the same reason the first two were: a player
   * who changes map must not lose the army they built on the other one.
   */
  siegeRome: ArmyComposition;
  siegeJuthungi: ArmyComposition;
  siegeCarthage: ArmyComposition;
  siegeRomanTrain: ArmyComposition;
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
   * `tools/probe-siege.mjs` measures), one ram, **one great ram**, three onager batteries,
   * the host behind and one squadron of horse.
   *
   * Twenty units is exactly `MAX_UNITS_PER_SIDE`, so the Juthungi start the assault full: a
   * player adding a fifth tower has to give up something, which is the correct shape for the
   * decision and not an accident of the numbers.
   *
   * **The great ram is paid for out of the horse, and this is the trade rather than a
   * silent nineteenth-and-a-half unit.** The list was at twenty with two squadrons of
   * `juthungi-riders`, and `STORM_PLANS.horse`'s own comment says what they are for:
   * *"Horse on the wings, with nothing to do until a gate opens."* Measured on the shipped
   * assault at `5338249`, that is literally true — no cavalry unit is ever ordered at the
   * wall, they sit on the flanks for the whole battle, and one of the two spends it 98 m off
   * the west end of the circuit. 50 men of the least-employed unit in the order of battle
   * buy 48 men and the only machine in the game that can make a hole where the defence has
   * not prepared one. Headcount 3,074 -> 3,072, so the tier's `fittedUnitScale` clamp lands
   * in the same place it always did.
   *
   * The alternatives were weighed and are worse: a warband is 180 men and the host is the
   * only reserve the storm has; an `escalade-party` is a bank of three ladders and a bay of
   * frontage; an `onager` battery is twelve men but it is the artillery workstream's.
   */
  siegeJuthungi: {
    'tower-assault': 4,
    'escalade-party': 4,
    'ram-crew': 1,
    'great-ram-crew': 1,
    onager: 3,
    'juthungi-warband': 6,
    'juthungi-riders': 1,
  },
  /**
   * Carthage on its own wall: six bays of citizen levy, four of freedmen behind them, two
   * batteries of the hair-strung engines and the nine hundred Roman deserters in reserve.
   *
   * 14 units and 1,616 men against Rome's 12 and 1,154 at the Aurelian Wall, which is the
   * wall's own arithmetic rather than a thumb on the scale: Carthage's modelled curtain is
   * 1,984 m against Rome's 1,781, and its 7.1 m walk carries five ranks where Rome's carries
   * three or four. More wall and a deeper walk means more men standing on it.
   */
  siegeCarthage: {
    'punic-levy': 6,
    'punic-freedmen': 4,
    'punic-catapults': 2,
    'punic-deserters': 2,
  },
  /**
   * Scipio's train: four towers, four ladder parties, one ram at the Porta Byrsae, two
   * batteries of stone-throwers and one of carroballistae, six cohorts waiting and two
   * squadrons of horse.
   *
   * Twenty units is exactly `MAX_UNITS_PER_SIDE`, as the Juthungi assault is, so adding a
   * fifth tower means giving something up.
   */
  siegeRomanTrain: {
    'legio-tower-party': 4,
    'legio-escalade': 4,
    'legio-ram-crew': 1,
    'legio-ballista': 2,
    carroballista: 1,
    'legio-cohort': 6,
    equites: 2,
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
  if (s === 'assault') return c[assaultCompositionKey(f, c.map)];
  if (f === Faction.Carthage) return c.carthage;
  return f === Faction.Rome ? c.rome : c.juthungi;
};

/**
 * Which of the four assault compositions belongs to a faction on a given map.
 *
 * Exported because the menu's steppers write back into the config and must reach for the
 * same field this reads, and a second copy of the mapping in the UI is exactly how a player
 * ends up editing an army they are not looking at.
 */
export const assaultCompositionKey = (
  f: Faction, mapId: MapId
): 'siegeRome' | 'siegeJuthungi' | 'siegeCarthage' | 'siegeRomanTrain' => {
  if (f === Faction.Carthage) return 'siegeCarthage';
  if (f === Faction.Germanic) return 'siegeJuthungi';
  return siegeRoleOf(Faction.Rome, mapId) === 'garrison' ? 'siegeRome' : 'siegeRomanTrain';
};

/**
 * The two factions actually on the field, Rome first.
 *
 * Everywhere that used to write `[Faction.Rome, Faction.Germanic]` should ask this instead:
 * that literal is correct for the shipped battle and silently wrong for any other, and it
 * appeared in enough places — strength tallies, pool fitting, the menu's army panels — that
 * a shared accessor is the only way they stay in step.
 *
 * An assault used to hardcode the Juthungi as the second side, on the argument that storming
 * the Aurelian Wall is a Juthungi operation. True, and it stops being the whole story with a
 * second city: at Carthage the wall is Punic and Rome is the besieger, so the opponent comes
 * from `CityPlan.garrison` instead. It still resolves to the Juthungi at Rome, because
 * Rome's own plan names Rome as the garrison.
 */
export const belligerents = (c: BattleConfig): readonly [Faction, Faction] => {
  if (c.scenario !== 'assault') return [Faction.Rome, c.opponent] as const;
  const held = garrisonOf(c.map);
  return [Faction.Rome, held === Faction.Rome ? Faction.Germanic : held] as const;
};

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
  for (const id of rosterFor(f, s, c.map)) {
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
 * The largest unit-size scale whose battle still fits the soldier pool.
 *
 * This matters more than it looks. `spawnUnit` stops allocating when the pool is full, and
 * Rome deploys first — so when the pool was small the default order of battle exhausted it
 * partway through the Roman line and **the entire Juthungi army spawned with zero men**. The
 * two sides then stood 130 m apart for the whole battle with nobody in contact, which read as
 * a broken AI rather than a broken pool.
 *
 * Scaling every unit down keeps all units present and the tactical picture intact; losing an
 * army does not. The 6% headroom absorbs the artillery crews, which `spawnUnit` deliberately
 * does not scale.
 *
 * **It no longer takes the pool size as an argument, and that is the point rather than tidying.**
 * The pool used to be `quality.maxSoldiers`, so this function fitted the army to the graphics
 * tier and a shadow-quality dropdown decided how many men fought — measured as two entirely
 * different outcomes of one seeded assault. `SOLDIER_POOL_CAPACITY` is one number at every
 * tier on every machine, so the clamp is now a property of the engine rather than of the
 * settings, and the mistake cannot come back through a call site: there is no parameter left to
 * pass a setting into. See the constant's comment in `./types` for the measurement and for what
 * a low tier gives up instead.
 */
export function fittedUnitScale(c: BattleConfig, s: ScenarioId = c.scenario): number {
  const asked = scaleAppliesTo(s) ? unitSizePreset(c.unitSize).scale : 1;
  const base = baseStrength(c, s);
  if (base <= 0) return asked;
  return Math.min(asked, (SOLDIER_POOL_CAPACITY * 0.94) / base);
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
export const isScaleClamped = (c: BattleConfig, s: ScenarioId = c.scenario): boolean =>
  scaleAppliesTo(s)
  && fittedUnitScale(c, s) < unitSizePreset(c.unitSize).scale - 1e-6;

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
export const totalMen = (c: BattleConfig, s: ScenarioId = c.scenario): number =>
  belligerents(c).reduce((n, f) => n + summarise(c, f, s).men, 0);

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
 * A garrison's line is the wall troops strung along the parapet, and its width is the useful
 * figure a player is actually choosing: **how many metres of curtain they can hold**. The
 * reserve and the engines are behind it and hold no wall. A storming side's line is whatever
 * is waiting in the open; the towers, ladder parties, ram and batteries are the assault
 * itself and stand in no line at all, so counting them would report a front the host never
 * forms. `MainMenu` labels the two cases differently for the same reason.
 *
 * Read off the side's own plan rather than written out, which is what makes it work for four
 * armies instead of two — `legio-cohort` holds no wall as Rome's reserve at the Aurelian Wall
 * and *is* the line as Rome's host at Carthage, and one flat set cannot say both.
 */
export const lineTypesFor = (
  s: ScenarioId, f: Faction = Faction.Rome, mapId: MapId = DEFAULT_MAP_ID
): ReadonlySet<string> => {
  if (s !== 'assault') return LINE_TYPES;
  const role = siegeRoleOf(f, mapId);
  const ids = role === 'garrison'
    ? GARRISON_PLANS[f]?.wall ?? []
    : STORM_PLANS[f]?.host ?? [];
  return new Set(ids);
};

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
  c: BattleConfig, f: Faction, sc: ScenarioId = c.scenario
): SideSummary {
  const scale = fittedUnitScale(c, sc);
  const line = lineTypesFor(sc, f, c.map);
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
  /**
   * Clamp one composition against the rows it is allowed to carry.
   *
   * Takes the roster and the fallback rather than a faction and a scenario, because the four
   * assault compositions are no longer one per faction: `siegeRome` and `siegeRomanTrain` are
   * both Rome's, and resolving them through `compositionFor(DEFAULT_CONFIG, ...)` would have
   * asked the *default* map which one it meant and been wrong on the other.
   */
  const side = (
    v: unknown, ids: readonly string[], fallback: ArmyComposition
  ): ArmyComposition => {
    const src = (v ?? {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    let total = 0;
    for (const id of ids) {
      const n = clampInt(src[id], 0, MAX_PER_TYPE, 0);
      // Respect the per-side cap even if the input ignored it, trimming later rows first.
      const room = Math.max(0, MAX_UNITS_PER_SIDE - total);
      out[id] = Math.min(n, room);
      total += out[id];
    }
    if (total === 0) return fallback;
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
    // Every order of battle is always sanitised and always carried, whichever one is being
    // fought, so switching scenario — or map — in the menu never destroys another one.
    opponent: o.opponent === Faction.Carthage ? Faction.Carthage : Faction.Germanic,
    rome: side(o.rome, ROME_ROSTER, DEFAULT_CONFIG.rome),
    juthungi: side(o.juthungi, JUTHUNGI_ROSTER, DEFAULT_CONFIG.juthungi),
    carthage: side(o.carthage, CARTHAGE_ROSTER, DEFAULT_CONFIG.carthage),
    siegeRome:
      side(o.siegeRome, siegeRosterFor(Faction.Rome, 'garrison'), DEFAULT_CONFIG.siegeRome),
    siegeJuthungi:
      side(o.siegeJuthungi, siegeRosterFor(Faction.Germanic, 'storm'), DEFAULT_CONFIG.siegeJuthungi),
    siegeCarthage:
      side(o.siegeCarthage, siegeRosterFor(Faction.Carthage, 'garrison'), DEFAULT_CONFIG.siegeCarthage),
    siegeRomanTrain:
      side(o.siegeRomanTrain, siegeRosterFor(Faction.Rome, 'storm'), DEFAULT_CONFIG.siegeRomanTrain),
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
