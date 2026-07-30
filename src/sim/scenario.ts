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

export function deploySiegeOfRome(battle: BattleSystem, ctx: EngineContext): ScenarioResult {
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];

  const push = (arr: DeployedUnit[], id: number, label: string) => {
    if (id >= 0) arr.push({ unitId: id, label });
  };

  // ---------------------------------------------------------------------
  // Roman line — anchored 90 m in front of the wall, facing north.
  // ---------------------------------------------------------------------
  const romanZ = 130;

  // Centre: four legionary cohorts shoulder to shoulder.
  const cohortSpacing = 62;
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * cohortSpacing;
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ, NORTH, 'line'), `Cohort ${['I', 'II', 'III', 'IV'][k]}`);
  }

  // Praetorians as the reserve behind the centre.
  push(roman, battle.spawnUnit('praetorian-cohort', -30, romanZ + 46, NORTH, 'line'), 'Praetorian Guard');

  // Urban cohorts refuse both flanks with spears.
  push(roman, battle.spawnUnit('urban-cohort', -132, romanZ - 6, NORTH, 'shieldwall'), 'Urban Cohort I');
  push(roman, battle.spawnUnit('urban-cohort', 132, romanZ - 6, NORTH, 'shieldwall'), 'Urban Cohort II');

  // Archers on the rise, shooting over the line.
  push(roman, battle.spawnUnit('sagittarii', -64, romanZ + 74, NORTH, 'loose'), 'Syrian Archers');
  push(roman, battle.spawnUnit('sagittarii', 64, romanZ + 74, NORTH, 'loose'), 'Cretan Archers');

  // Cavalry held wide on the Roman right, ready to take the flank.
  push(roman, battle.spawnUnit('equites', 214, romanZ + 30, NORTH, 'wedge'), 'Equites Singulares');

  // Bolt-throwers on the wall line.
  push(roman, battle.spawnUnit('scorpio', 0, romanZ + 116, NORTH, 'line'), 'Scorpion Battery');

  // ---------------------------------------------------------------------
  // Juthungi host — a deep, ragged mass 320 m out, facing the city.
  // ---------------------------------------------------------------------
  const germZ = -190;

  // Skirmishers screening in front.
  push(germanic, battle.spawnUnit('juthungi-skirmishers', -70, germZ + 62, SOUTH, 'skirmish'), 'Skirmishers');
  push(germanic, battle.spawnUnit('juthungi-skirmishers', 70, germZ + 62, SOUTH, 'skirmish'), 'Youths of the Host');

  // Main battle line: warbands with spear blocks stiffening them.
  push(germanic, battle.spawnUnit('juthungi-warband', -104, germZ, SOUTH, 'horde'), 'Warband of Semno');
  push(germanic, battle.spawnUnit('juthungi-spears', -34, germZ, SOUTH, 'line'), 'Ash-Spears');
  push(germanic, battle.spawnUnit('juthungi-warband', 36, germZ, SOUTH, 'horde'), 'Warband of Vadomar');
  push(germanic, battle.spawnUnit('juthungi-spears', 106, germZ, SOUTH, 'line'), 'Oath-Spears');

  // Chosen and fanatics form the striking wedge behind the centre.
  push(germanic, battle.spawnUnit('juthungi-chosen', 0, germZ - 52, SOUTH, 'wedge'), "Chieftain's Chosen");
  push(germanic, battle.spawnUnit('juthungi-berserkers', -62, germZ - 48, SOUTH, 'horde'), 'Naked Fanatics');

  // Horse raiders sweeping wide on both wings.
  push(germanic, battle.spawnUnit('juthungi-riders', -226, germZ + 34, SOUTH, 'loose'), 'Left-Wing Raiders');
  push(germanic, battle.spawnUnit('juthungi-riders', 226, germZ + 34, SOUTH, 'loose'), 'Right-Wing Raiders');

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
