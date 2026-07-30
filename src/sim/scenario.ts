import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
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
 * Unit-size multiplier, the analogue of Total War's unit-size setting. At 1.6 a legionary
 * cohort fields 256 men, which is close to Rome II's "ultra" infantry unit and puts about
 * 9,500 men on the field between the two armies — enough that the line of battle reads as
 * a mass rather than as a row of blocks.
 */
export const UNIT_SIZE_SCALE = 1.6;

export function deploySiegeOfRome(battle: BattleSystem, ctx: EngineContext): ScenarioResult {
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];
  battle.unitSizeScale = UNIT_SIZE_SCALE;

  const push = (arr: DeployedUnit[], id: number, label: string) => {
    if (id >= 0) arr.push({ unitId: id, label });
  };

  // ---------------------------------------------------------------------
  // Roman line — two legions drawn up in the classic triplex-derived depth:
  // a broad first line of cohorts, a second line covering its seams, spears
  // refusing both flanks, missiles on the rise, cavalry on the wings.
  // ---------------------------------------------------------------------
  const romanZ = 130;
  const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

  // First line: eight legionary cohorts shoulder to shoulder across ~560 m. A cohort in
  // `line` is about 27 m of frontage, so 70 m centres leave a deliberate interval — the
  // gaps the second line exists to plug.
  const cohortSpacing = 70;
  for (let k = 0; k < 8; k++) {
    const x = (k - 3.5) * cohortSpacing;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k]}`);
  }

  // Second line, offset half an interval so it covers the first line's seams.
  for (let k = 0; k < 5; k++) {
    const x = (k - 2) * cohortSpacing + cohortSpacing * 0.5;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ + 52, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k + 8] ?? String(k + 9)}`);
  }

  // Praetorians: the reserve proper, held behind the centre and committed by hand.
  push(roman, battle.spawnUnit('praetorian-cohort', -46, romanZ + 104, NORTH, 'line'), 'Praetorian Guard I');
  push(roman, battle.spawnUnit('praetorian-cohort', 46, romanZ + 104, NORTH, 'line'), 'Praetorian Guard II');

  // Urban cohorts refuse both flanks with a hedge of spears.
  push(roman, battle.spawnUnit('urban-cohort', -318, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort I');
  push(roman, battle.spawnUnit('urban-cohort', -256, romanZ - 4, NORTH, 'shieldwall'), 'Urban Cohort II');
  push(roman, battle.spawnUnit('urban-cohort', 256, romanZ - 4, NORTH, 'shieldwall'), 'Urban Cohort III');
  push(roman, battle.spawnUnit('urban-cohort', 318, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort IV');

  // Archers on the rise, shooting over the line.
  push(roman, battle.spawnUnit('sagittarii', -140, romanZ + 82, NORTH, 'loose'), 'Syrian Archers');
  push(roman, battle.spawnUnit('sagittarii', -48, romanZ + 82, NORTH, 'loose'), 'Cretan Archers');
  push(roman, battle.spawnUnit('sagittarii', 48, romanZ + 82, NORTH, 'loose'), 'Osrhoene Archers');
  push(roman, battle.spawnUnit('sagittarii', 140, romanZ + 82, NORTH, 'loose'), 'Ituraean Archers');

  // Cavalry on both wings. The right is the heavier, held for the counter-blow.
  push(roman, battle.spawnUnit('equites', 402, romanZ + 34, NORTH, 'wedge'), 'Equites Singulares');
  push(roman, battle.spawnUnit('equites', 452, romanZ + 60, NORTH, 'wedge'), 'Equites Promoti');
  push(roman, battle.spawnUnit('equites', -402, romanZ + 34, NORTH, 'wedge'), 'Equites Stablesiani');

  // Bolt-throwers sited to sweep the whole approach.
  push(roman, battle.spawnUnit('scorpio', -80, romanZ + 138, NORTH, 'line'), 'Scorpion Battery I');
  push(roman, battle.spawnUnit('scorpio', 80, romanZ + 138, NORTH, 'line'), 'Scorpion Battery II');

  // ---------------------------------------------------------------------
  // Juthungi host — a deep, ragged mass 320 m out, facing the city.
  // ---------------------------------------------------------------------
  const germZ = -190;

  // Skirmishers screening the whole frontage — the host's youths, sent to draw the first
  // volleys and then melt back through the intervals.
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * 150;
    push(germanic, battle.spawnUnit('juthungi-skirmishers', x, germZ + 68, SOUTH, 'skirmish'),
      ['Skirmishers of the Ford', 'Youths of the Host', 'Framea-Throwers', 'Boys of Vadomar'][k]);
  }

  // Main battle line: warbands massed in depth with spear blocks stiffening the joints.
  // Germanic armies fought by kindred, so the line is a row of named warbands rather than
  // an evenly-drilled front.
  const bandNames = ['Warband of Semno', 'Ash-Spears', 'Warband of Vadomar', 'Oath-Spears',
    'Warband of Gundomad', 'Elm-Spears', 'Warband of Rando', 'Shield-Sworn'];
  for (let k = 0; k < 8; k++) {
    const x = (k - 3.5) * 82;
    const spears = k % 2 === 1;
    push(germanic, battle.spawnUnit(
      spears ? 'juthungi-spears' : 'juthungi-warband',
      x, germZ + (spears ? 0 : 6), SOUTH, spears ? 'line' : 'horde'), bandNames[k]);
  }

  // Chosen and fanatics form the striking wedges behind the centre.
  push(germanic, battle.spawnUnit('juthungi-chosen', -84, germZ - 58, SOUTH, 'wedge'), "Chieftain's Chosen");
  push(germanic, battle.spawnUnit('juthungi-chosen', 84, germZ - 58, SOUTH, 'wedge'), 'Sworn Companions');
  push(germanic, battle.spawnUnit('juthungi-berserkers', -170, germZ - 52, SOUTH, 'horde'), 'Naked Fanatics');
  push(germanic, battle.spawnUnit('juthungi-berserkers', 170, germZ - 52, SOUTH, 'horde'), 'Wolf-Coats');

  // Horse raiders sweeping wide on both wings, looking for an open flank.
  push(germanic, battle.spawnUnit('juthungi-riders', -404, germZ + 38, SOUTH, 'loose'), 'Left-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', -452, germZ + 66, SOUTH, 'loose'), 'Left-Wing Outriders');
  push(germanic, battle.spawnUnit('juthungi-riders', 404, germZ + 38, SOUTH, 'loose'), 'Right-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', 452, germZ + 66, SOUTH, 'loose'), 'Right-Wing Outriders');

  // Both sides start holding their ground; the AI takes it from here.
  for (const u of battle.units) u.order = UnitOrder.Hold;

  ctx.events.emit('battleStarted', { seed: battle.rng.getState(), scenario: 'siege-of-rome-271' });

  return {
    roman,
    germanic,
    // Open looking north from behind the Roman line — the classic Total War
    // "here is your army, there is theirs" establishing shot.
    cameraFocus: { x: 0, z: 40, zoom: 0.66, yaw: Math.PI },
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
