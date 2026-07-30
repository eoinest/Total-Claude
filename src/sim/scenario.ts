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
  // A cohort of 320 in `line` is about 38 m of frontage, so 96 m centres leave a real
  // interval — the gaps the second line exists to plug.
  const cohortSpacing = 96;
  for (let k = 0; k < 6; k++) {
    const x = (k - 2.5) * cohortSpacing;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k]}`);
  }

  // Second line, offset half an interval so it covers the first line's seams.
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * cohortSpacing + cohortSpacing * 0.5;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ + 58, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k + 6]}`);
  }

  // Praetorians: the reserve proper, held behind the centre and committed by hand.
  push(roman, battle.spawnUnit('praetorian-cohort', -46, romanZ + 104, NORTH, 'line'), 'Praetorian Guard I');
  push(roman, battle.spawnUnit('praetorian-cohort', 46, romanZ + 104, NORTH, 'line'), 'Praetorian Guard II');

  // Urban cohorts refuse both flanks with a hedge of spears.
  push(roman, battle.spawnUnit('urban-cohort', -330, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort I');
  push(roman, battle.spawnUnit('urban-cohort', 330, romanZ - 8, NORTH, 'shieldwall'), 'Urban Cohort II');

  // Archers on the rise, shooting over the line.
  push(roman, battle.spawnUnit('sagittarii', -136, romanZ + 92, NORTH, 'loose'), 'Syrian Archers');
  push(roman, battle.spawnUnit('sagittarii', 0, romanZ + 92, NORTH, 'loose'), 'Cretan Archers');
  push(roman, battle.spawnUnit('sagittarii', 136, romanZ + 92, NORTH, 'loose'), 'Ituraean Archers');

  // Cavalry on both wings. The right is the heavier, held for the counter-blow.
  push(roman, battle.spawnUnit('equites', 402, romanZ + 34, NORTH, 'wedge'), 'Equites Singulares');
  push(roman, battle.spawnUnit('equites', 452, romanZ + 60, NORTH, 'wedge'), 'Equites Promoti');
  push(roman, battle.spawnUnit('equites', -402, romanZ + 34, NORTH, 'wedge'), 'Equites Stablesiani');

  // Bolt-throwers sited to sweep the whole approach.
  push(roman, battle.spawnUnit('scorpio', 0, romanZ + 148, NORTH, 'line'), 'Scorpion Battery');

  // ---------------------------------------------------------------------
  // Juthungi host — a deep, ragged mass 320 m out, facing the city.
  // ---------------------------------------------------------------------
  const germZ = -190;

  // Skirmishers screening the whole frontage — the host's youths, sent to draw the first
  // volleys and then melt back through the intervals.
  for (let k = 0; k < 3; k++) {
    const x = (k - 1) * 210;
    push(germanic, battle.spawnUnit('juthungi-skirmishers', x, germZ + 68, SOUTH, 'skirmish'),
      ['Skirmishers of the Ford', 'Youths of the Host', 'Framea-Throwers'][k]);
  }

  // Main battle line: warbands massed in depth with spear blocks stiffening the joints.
  // Germanic armies fought by kindred, so the line is a row of named warbands rather than
  // an evenly-drilled front.
  const bandNames = ['Warband of Semno', 'Ash-Spears', 'Warband of Vadomar',
    'Oath-Spears', 'Warband of Gundomad', 'Elm-Spears'];
  for (let k = 0; k < 6; k++) {
    const x = (k - 2.5) * 112;
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
  push(germanic, battle.spawnUnit('juthungi-riders', -420, germZ + 46, SOUTH, 'loose'), 'Left-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', 420, germZ + 46, SOUTH, 'loose'), 'Right-Wing Raiders');

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
