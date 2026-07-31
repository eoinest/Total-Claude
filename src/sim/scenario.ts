import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { unitType } from '../units/roster';
import { Faction, UnitOrder } from './types';

/**
 * The Siege of Rome, 271 AD.
 *
 * The Juthungi host has come down the Via Flaminia and is deploying on the Campus
 * Martius, north of the city. Rome's field army is drawn up in front of the unfinished
 * Aurelian Wall: legionary cohorts in the centre, urban cohorts holding the flanks with
 * spears, archers on the rise behind, cavalry held back on the right for the counter-blow.
 *
 * Deployment convention: -Z is north (the attackers' side), +Z is the city.
 * A unit's `facing` is the compass bearing it looks along, so the Romans face -Z.
 */

export interface DeployedUnit {
  unitId: number;
  label: string;
}

export interface ScenarioResult {
  roman: DeployedUnit[];
  germanic: DeployedUnit[];
  /** Where the camera should open. */
  cameraFocus: { x: number; z: number; zoom: number; yaw: number };
}

const NORTH = Math.PI; // facing toward -Z
const SOUTH = 0; // facing toward +Z

/**
 * Unit-size multiplier, the analogue of Total War's unit-size setting. At 2.0 a legionary
 * cohort fields 320 men and the two armies together put about 9,500 on the field.
 *
 * Deliberately biased toward *fewer, larger* units rather than many small ones. Total War
 * caps an army at 20 units for a reason: beyond that a player cannot hold the whole order
 * of battle in their head, and the unit cards stop fitting on screen. An earlier pass at
 * 1.6 needed 48 units to reach the same headcount and the card bar ate a third of the
 * viewport.
 */
export const UNIT_SIZE_SCALE = 2.0;

/**
 * Every unit this scenario deploys, in spawn order, so the total headcount can be known
 * before the first man is created. Keep in step with the deployment below.
 */
const ORDER_OF_BATTLE: readonly string[] = [
  ...Array(6).fill('legio-cohort'),
  'praetorian-cohort', 'praetorian-cohort',
  'urban-cohort', 'urban-cohort',
  'sagittarii', 'sagittarii',
  'equites', 'equites', 'equites',
  'scorpio',
  ...Array(3).fill('juthungi-skirmishers'),
  'juthungi-warband', 'juthungi-spears', 'juthungi-warband',
  'juthungi-warband', 'juthungi-spears', 'juthungi-warband',
  'juthungi-warband', 'juthungi-spears', 'juthungi-warband',
  'juthungi-chosen', 'juthungi-chosen',
  'juthungi-berserkers', 'juthungi-berserkers',
  'juthungi-riders', 'juthungi-riders', 'juthungi-riders',
];

/**
 * The largest unit-size multiplier whose army still fits the quality tier's soldier pool.
 *
 * This matters more than it looks. `spawnUnit` stops allocating when the pool is full, and
 * Rome deploys first — so at `low` (1,600 men) and `medium` (3,200) an 8,944-man order of
 * battle exhausted the pool partway through the Roman line and **the entire Juthungi army
 * was spawned with zero men**. The two sides then stood 130 m apart for the whole battle
 * with nobody in contact, which read as a broken AI rather than a broken pool.
 *
 * Scaling every unit down keeps all 36 units present and the tactical picture intact at
 * every tier; losing an army does not. The 6% headroom absorbs the artillery crews, which
 * `spawnUnit` deliberately does not scale.
 */
export function fittedUnitScale(maxSoldiers: number): number {
  const base = ORDER_OF_BATTLE.reduce((sum, id) => sum + unitType(id).strength, 0);
  return Math.min(UNIT_SIZE_SCALE, (maxSoldiers * 0.94) / base);
}

export function deploySiegeOfRome(battle: BattleSystem, ctx: EngineContext): ScenarioResult {
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];
  battle.unitSizeScale = fittedUnitScale(ctx.quality.maxSoldiers);

  const push = (arr: DeployedUnit[], id: number, label: string) => {
    if (id >= 0) arr.push({ unitId: id, label });
  };

  // ---------------------------------------------------------------------
  // Roman line — a field army, not a garrison parade: one line of cohorts with
  // spears refusing both flanks, archers on the rise, the Praetorians held back
  // as the only reserve, cavalry on the wings.
  //
  // It is deliberately **outnumbered and out-fronted**. Aurelian's field army was a
  // detachment; the Juthungi came as a people. With Rome fielding 5,264 against 3,680
  // the battle had no question in it — Rome had more men, better armour, better morale
  // and better discipline, so it won on its own with the player asleep, which is what
  // the report of "Rome automatically wins immediately" was. The Roman answer to being
  // outnumbered is drill, ground and a reserve used at the right moment, and all three
  // of those are decisions the player has to make.
  // ---------------------------------------------------------------------
  const romanZ = 130;
  const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];

  // Six legionary cohorts. A 320-man cohort in `line` is about 35 m of frontage, so 64 m
  // centres leave a half-cohort interval — the seams a Germanic wedge will aim at. Six and
  // not seven: at seven the Roman line covered nearly the whole Germanic frontage, nothing
  // was left over to turn either flank, and a Rome that did literally nothing still won on
  // armour and archery alone. The overlap is the tactical problem the player is here to
  // solve.
  const cohortSpacing = 64;
  for (let k = 0; k < 6; k++) {
    const x = (k - 2.5) * cohortSpacing;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k]}`);
  }

  // Praetorians: the reserve proper, held behind the centre and committed by hand.
  push(roman, battle.spawnUnit('praetorian-cohort', -44, romanZ + 86, NORTH, 'line'), 'Praetorian Guard I');
  push(roman, battle.spawnUnit('praetorian-cohort', 44, romanZ + 86, NORTH, 'line'), 'Praetorian Guard II');

  // Urban cohorts refuse both flanks with a hedge of spears.
  push(roman, battle.spawnUnit('urban-cohort', -250, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort I');
  push(roman, battle.spawnUnit('urban-cohort', 250, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort II');

  // Archers on the rise, shooting over the line.
  push(roman, battle.spawnUnit('sagittarii', -104, romanZ + 78, NORTH, 'loose'), 'Syrian Archers');
  push(roman, battle.spawnUnit('sagittarii', 104, romanZ + 78, NORTH, 'loose'), 'Cretan Archers');

  // Cavalry on both wings. The right is the heavier, held for the counter-blow.
  push(roman, battle.spawnUnit('equites', 300, romanZ + 34, NORTH, 'wedge'), 'Equites Singulares');
  push(roman, battle.spawnUnit('equites', 352, romanZ + 60, NORTH, 'wedge'), 'Equites Promoti');
  push(roman, battle.spawnUnit('equites', -300, romanZ + 34, NORTH, 'wedge'), 'Equites Stablesiani');

  // Bolt-throwers sited to sweep the whole approach.
  push(roman, battle.spawnUnit('scorpio', 0, romanZ + 132, NORTH, 'line'), 'Scorpion Battery');

  // ---------------------------------------------------------------------
  // Juthungi host — a deep, ragged mass 320 m out, facing the city. Nine kindreds in
  // the battle line, which is half again the Roman frontage: the flanks are the whole
  // Germanic plan and refusing them is the whole Roman problem.
  // ---------------------------------------------------------------------
  const germZ = -190;

  // Skirmishers screening the whole frontage — the host's youths, sent to draw the first
  // volleys and then melt back through the intervals.
  for (let k = 0; k < 3; k++) {
    const x = (k - 1) * 180;
    push(germanic, battle.spawnUnit('juthungi-skirmishers', x, germZ + 68, SOUTH, 'skirmish'),
      ['Skirmishers of the Ford', 'Youths of the Host', 'Framea-Throwers'][k]);
  }

  // Main battle line: warbands massed in depth with spear blocks stiffening the joints.
  // Germanic armies fought by kindred, so the line is a row of named warbands rather than
  // an evenly-drilled front.
  const bandNames = [
    'Warband of Semno', 'Ash-Spears', 'Warband of Vadomar',
    'Warband of Hariobaud', 'Oath-Spears', 'Warband of Gundomad',
    'Warband of Suomar', 'Elm-Spears', 'Warband of Agenar',
  ];
  for (let k = 0; k < 9; k++) {
    const x = (k - 4) * 46;
    const spears = k % 3 === 1;
    push(germanic, battle.spawnUnit(
      spears ? 'juthungi-spears' : 'juthungi-warband',
      x, germZ + (spears ? 0 : 6), SOUTH, spears ? 'line' : 'horde'), bandNames[k]);
  }

  // Chosen and fanatics form the striking wedges behind the centre.
  push(germanic, battle.spawnUnit('juthungi-chosen', -70, germZ - 58, SOUTH, 'wedge'), "Chieftain's Chosen");
  push(germanic, battle.spawnUnit('juthungi-chosen', 70, germZ - 58, SOUTH, 'wedge'), 'Sworn Companions');
  push(germanic, battle.spawnUnit('juthungi-berserkers', -150, germZ - 52, SOUTH, 'horde'), 'Naked Fanatics');
  push(germanic, battle.spawnUnit('juthungi-berserkers', 150, germZ - 52, SOUTH, 'horde'), 'Wolf-Coats');

  // Horse raiders sweeping wide on both wings, looking for an open flank.
  push(germanic, battle.spawnUnit('juthungi-riders', -330, germZ + 46, SOUTH, 'loose'), 'Left-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', 330, germZ + 46, SOUTH, 'loose'), 'Right-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', 386, germZ + 12, SOUTH, 'loose'), 'Raiders of Vithimir');

  // Both sides start holding their ground; the AI takes it from here.
  for (const u of battle.units) u.order = UnitOrder.Hold;

  ctx.events.emit('battleStarted', { seed: battle.rng.getState(), scenario: 'siege-of-rome-271' });

  return {
    roman,
    germanic,
    // Open looking north from behind the Roman line — the classic Total War
    // "here is your army, there is theirs" establishing shot.
    //
    // This is derived from `romanZ` rather than hardcoded because the hardcoded version was
    // wrong and nothing caught it: at z 40 / zoom 0.66 the boom is 116 m long, which put the
    // eye at z 156 — *inside* the Roman deployment, which spans z 122 to 262. Measured with
    // live projection, ZERO of the player's 16 units had their centroid on screen, stable
    // over 24 s, and the only troops visible were enemy slivers at the top edge. A player
    // opened on empty grass and had to go looking for their own army. The graded
    // `establishing` shot never caught it because the harness auto-frames on `ownLine`
    // instead of using this value.
    //
    // Sweeping focus z against zoom and counting unit centroids inside the frustum: the eye
    // must sit behind z 122 for the line to be in frame at all, and because this camera
    // couples zoom to pitch (39 deg at 0.58, rising to 54 deg at 0.82) seeing the enemy
    // 320 m beyond the line needs at least 0.78. At 0.78 with the focus 10 m in front of the
    // front rank the eye lands at z 308: 15 of 16 own units in frame with men still reading
    // as ranked blocks rather than specks, and the leading Juthungi banners visible along the
    // top edge. 0.82 fits more of the enemy but shrinks the line and pushes their banners up
    // behind the top bar.
    cameraFocus: { x: 0, z: romanZ - 10, zoom: 0.78, yaw: Math.PI },
  };
}

/** Simple victory check used until the objective system lands. */
export function checkVictory(battle: BattleSystem): { over: boolean; victor: Faction | -1; reason: string } {
  const romans = battle.activeUnits(Faction.Rome);
  const germans = battle.activeUnits(Faction.Germanic);
  const romanMen = romans.reduce((a, u) => a + u.alive, 0);
  const germanMen = germans.reduce((a, u) => a + u.alive, 0);

  if (romanMen === 0 && germanMen === 0) return { over: true, victor: -1, reason: 'annihilation' };
  if (germanMen === 0) return { over: true, victor: Faction.Rome, reason: romans.length ? 'rout' : 'annihilation' };
  if (romanMen === 0) return { over: true, victor: Faction.Germanic, reason: germans.length ? 'rout' : 'annihilation' };
  return { over: false, victor: -1, reason: '' };
}
