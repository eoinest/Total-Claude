import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import {
  type BattleConfig, DEFAULT_CONFIG, compositionFor, fittedUnitScale,
} from './battleConfig';
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
 *
 * The deployment is driven by a `BattleConfig` rather than hardcoded, so the pre-battle menu
 * can change the order of battle. The historical order of battle is `DEFAULT_CONFIG`, not a
 * special case in the code.
 *
 * At `DEFAULT_CONFIG` every unit stands on the same x and z, in the same formation, with the
 * same name as the hardcoded deployment this replaced — verified position for position. The
 * one thing that is *not* identical is spawn order within the equites block, which the old
 * code listed by hand as +300, +352, -300; no consistent placement rule produces that, so
 * those three squadrons now spawn in a different order and carry different unit ids. Since
 * each man's jitter comes from `rng.fork('unit' + id)`, the battle is the same battle on the
 * same ground but not bit-identical to the pre-menu one, and outcome statistics quoted in
 * docs/ (contact around t+80, a passive Rome losing roughly a third of its strength) shift by
 * a few percent rather than holding exactly. Determinism itself is unaffected: any given
 * config and seed still replays identically, which is what the contract actually requires.
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
 * Centred positions for `n` units on `spacing` centres.
 *
 * Every block in the deployment is symmetric about the Via Flaminia, so this is the only
 * placement rule the line units need and it keeps the army centred whatever the count. At
 * the default six cohorts on 64 m centres it reproduces the shipped x of -160..+160.
 */
const centred = (n: number, spacing: number): number[] =>
  Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * spacing);

/**
 * Positions fanning outward in pairs from `first`: left, then right, and a trailing odd unit
 * to the right.
 *
 * Wing units are placed this way rather than centred because a flank guard belongs on the
 * flank. **Left before right is not cosmetic.** The first draft emitted right first, which put
 * `Left-Wing Raiders` at x +330 — on the right — and `Right-Wing Raiders` on the left, because
 * the name lists are indexed by spawn order. It also reproduces the shipped order exactly for
 * the urban cohorts (-250, +250), the chosen (-70, +70), the fanatics (-150, +150) and the
 * raiders (-330, +330, +386), so those blocks are position-for-position and name-for-name what
 * the game shipped with.
 *
 * The trailing single goes right because the right is the heavier wing, held for the
 * counter-blow. The one block this does not reproduce in order is the equites: the shipped code
 * listed them +300, +352, -300 by hand, which no consistent rule produces. It occupies the same
 * three positions with the same formations, so the deployment is geometrically identical, but
 * those three units spawn in a different order and therefore carry different ids.
 */
const flanking = (n: number, first: number, step: number): number[] => {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const pair = Math.floor(k / 2);
    const x = first + pair * step;
    const lastAndOdd = k === n - 1 && n % 2 === 1;
    out.push(k % 2 === 0 && !lastAndOdd ? -x : x);
  }
  return out;
};

const ROMAN_NUMERALS = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
];

const PRAETORIAN_NAMES = ['Praetorian Guard', 'Praetorian Guard'];
const ARCHER_NAMES = [
  'Syrian Archers', 'Cretan Archers', 'Palmyrene Archers', 'Osrhoene Archers',
];
const EQUITES_NAMES = [
  'Equites Singulares', 'Equites Promoti', 'Equites Stablesiani', 'Equites Dalmatae',
  'Equites Mauri', 'Equites Sagittarii',
];
const SKIRMISHER_NAMES = [
  'Skirmishers of the Ford', 'Youths of the Host', 'Framea-Throwers',
  'Boys of the Kindred', 'Stone-Slingers',
];
const BAND_NAMES = [
  'Warband of Semno', 'Warband of Vadomar', 'Warband of Hariobaud',
  'Warband of Gundomad', 'Warband of Suomar', 'Warband of Agenar',
  'Warband of Ariovist', 'Warband of Mederic', 'Warband of Chrocus',
  'Warband of Vithicab', 'Warband of Serapio', 'Warband of Ursicin',
];
const SPEAR_NAMES = [
  'Ash-Spears', 'Oath-Spears', 'Elm-Spears', 'Thorn-Spears', 'Hearth-Spears', 'Grave-Spears',
];
const CHOSEN_NAMES = [
  "Chieftain's Chosen", 'Sworn Companions', 'Hall-Companions', 'Shield-Sworn',
];
const FANATIC_NAMES = ['Naked Fanatics', 'Wolf-Coats', 'Bear-Shirts', 'Wode-Runners'];
const RAIDER_NAMES = [
  'Left-Wing Raiders', 'Right-Wing Raiders', 'Raiders of Vithimir',
  'Raiders of Hunimund', 'Horse-Thieves', 'Ford-Riders',
];

/** `names[k]`, falling back to a numbered variant once the hand-written list runs out. */
const nameAt = (names: readonly string[], k: number, stem: string): string =>
  names[k] ?? `${stem} ${ROMAN_NUMERALS[k] ?? k + 1}`;

export function deploySiegeOfRome(
  battle: BattleSystem,
  ctx: EngineContext,
  config: BattleConfig = DEFAULT_CONFIG
): ScenarioResult {
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];
  battle.unitSizeScale = fittedUnitScale(config, ctx.quality.maxSoldiers);

  const rome = compositionFor(config, Faction.Rome);
  const juth = compositionFor(config, Faction.Germanic);
  const n = (comp: Readonly<Record<string, number>>, id: string): number =>
    Math.max(0, comp[id] ?? 0);

  const push = (arr: DeployedUnit[], id: number, label: string) => {
    if (id >= 0) arr.push({ unitId: id, label });
  };

  // ---------------------------------------------------------------------
  // Roman line — a field army, not a garrison parade: one line of cohorts with
  // spears refusing both flanks, archers on the rise, the Praetorians held back
  // as the only reserve, cavalry on the wings.
  //
  // It is deliberately **outnumbered and out-fronted** at the default composition.
  // Aurelian's field army was a detachment; the Juthungi came as a people. With Rome
  // fielding 5,264 against 3,680 the battle had no question in it — Rome had more men,
  // better armour, better morale and better discipline, so it won on its own with the
  // player asleep, which is what the report of "Rome automatically wins immediately" was.
  // The Roman answer to being outnumbered is drill, ground and a reserve used at the right
  // moment, and all three of those are decisions the player has to make. A player who
  // reverses the odds in the menu is welcome to; that is what the menu is for.
  // ---------------------------------------------------------------------
  const romanZ = 130;

  // A 320-man cohort in `line` is about 35 m of frontage, so 64 m centres leave a
  // half-cohort interval — the seams a Germanic wedge will aim at.
  for (const [k, x] of centred(n(rome, 'legio-cohort'), 64).entries()) {
    push(roman, battle.spawnUnit('legio-cohort', x, romanZ, NORTH, 'line'),
      `Cohort ${ROMAN_NUMERALS[k] ?? k + 1}`);
  }

  // Praetorians: the reserve proper, held behind the centre and committed by hand.
  for (const [k, x] of centred(n(rome, 'praetorian-cohort'), 88).entries()) {
    push(roman, battle.spawnUnit('praetorian-cohort', x, romanZ + 86, NORTH, 'line'),
      `${nameAt(PRAETORIAN_NAMES, k, 'Praetorian Guard')} ${ROMAN_NUMERALS[k] ?? k + 1}`);
  }

  // Urban cohorts refuse both flanks with a hedge of spears. Placed outward from the line's
  // own edge so they still stand on the flank when the cohort count changes.
  // 58 rather than a rounder number so that six cohorts put this at exactly 250, the
  // shipped x of the urban cohorts, and 300 for the equites one line below. The default
  // composition has to reproduce the shipped deployment position for position, or every
  // figure in docs/ and the README quietly stops describing the battle that ships.
  const lineHalf = Math.max(120, (n(rome, 'legio-cohort') * 64) / 2 + 58);
  for (const [k, x] of flanking(n(rome, 'urban-cohort'), lineHalf, 70).entries()) {
    push(roman, battle.spawnUnit('urban-cohort', x, romanZ - 8, NORTH, 'shieldwall'),
      `Urban Cohort ${ROMAN_NUMERALS[k] ?? k + 1}`);
  }

  // Archers on the rise, shooting over the line.
  for (const [k, x] of centred(n(rome, 'sagittarii'), 208).entries()) {
    push(roman, battle.spawnUnit('sagittarii', x, romanZ + 78, NORTH, 'loose'),
      nameAt(ARCHER_NAMES, k, 'Archers'));
  }

  // Cavalry on both wings, outside the spears. The right is the heavier, held for the
  // counter-blow, which is why odd counts weight it.
  // Depth steps with the outward pair, not with left/right: the shipped pair at +/-300 both
  // stood at romanZ + 34 and only the third squadron at 352 was echeloned back to + 60.
  for (const [k, x] of flanking(n(rome, 'equites'), lineHalf + 50, 52).entries()) {
    push(roman, battle.spawnUnit('equites', x, romanZ + 34 + Math.floor(k / 2) * 26, NORTH, 'wedge'),
      nameAt(EQUITES_NAMES, k, 'Equites'));
  }

  // Bolt-throwers sited to sweep the whole approach.
  for (const [k, x] of centred(n(rome, 'scorpio'), 60).entries()) {
    push(roman, battle.spawnUnit('scorpio', x, romanZ + 132, NORTH, 'line'),
      n(rome, 'scorpio') > 1 ? `Scorpion Battery ${ROMAN_NUMERALS[k] ?? k + 1}` : 'Scorpion Battery');
  }

  // ---------------------------------------------------------------------
  // Juthungi host — a deep, ragged mass 320 m out, facing the city. Warbands and spear
  // blocks share one battle line, which at the default composition is half again the Roman
  // frontage: the flanks are the whole Germanic plan and refusing them is the whole Roman
  // problem.
  // ---------------------------------------------------------------------
  const germZ = -190;

  // Skirmishers screening the whole frontage — the host's youths, sent to draw the first
  // volleys and then melt back through the intervals.
  for (const [k, x] of centred(n(juth, 'juthungi-skirmishers'), 180).entries()) {
    push(germanic, battle.spawnUnit('juthungi-skirmishers', x, germZ + 68, SOUTH, 'skirmish'),
      nameAt(SKIRMISHER_NAMES, k, 'Skirmishers'));
  }

  // Main battle line: warbands massed in depth with spear blocks stiffening the joints.
  // Germanic armies fought by kindred, so the line is a row of named warbands rather than
  // an evenly-drilled front.
  //
  // The two types are interleaved rather than grouped — spears every third place, as the
  // shipped nine-unit line had them — so that changing the mix in the menu still produces
  // a line with its joints stiffened instead of one homogeneous block beside another.
  const bands = n(juth, 'juthungi-warband');
  const spears = n(juth, 'juthungi-spears');
  const lineOrder: Array<'band' | 'spear'> = [];
  {
    let b = bands;
    let s = spears;
    // band, SPEAR, band per triple — the shipped line tested `k % 3 === 1`, so the spear
    // block sat in the middle of each group of three and stiffened both joints, rather
    // than trailing it. Emitting band, band, spear instead moved every joint.
    while (b > 0 || s > 0) {
      if (b > 0) { lineOrder.push('band'); b--; }
      if (s > 0) { lineOrder.push('spear'); s--; }
      if (b > 0) { lineOrder.push('band'); b--; }
      if (b === 0 && s > 0) { while (s-- > 0) lineOrder.push('spear'); }
      if (s === 0 && b > 0) { while (b-- > 0) lineOrder.push('band'); }
    }
  }
  let bandIdx = 0;
  let spearIdx = 0;
  for (const [k, x] of centred(lineOrder.length, 46).entries()) {
    const isSpear = lineOrder[k] === 'spear';
    push(germanic, battle.spawnUnit(
      isSpear ? 'juthungi-spears' : 'juthungi-warband',
      x, germZ + (isSpear ? 0 : 6), SOUTH, isSpear ? 'line' : 'horde'),
      isSpear
        ? nameAt(SPEAR_NAMES, spearIdx++, 'Spears')
        : nameAt(BAND_NAMES, bandIdx++, 'Warband'));
  }

  // Chosen and fanatics form the striking wedges behind the centre.
  for (const [k, x] of flanking(n(juth, 'juthungi-chosen'), 70, 84).entries()) {
    push(germanic, battle.spawnUnit('juthungi-chosen', x, germZ - 58, SOUTH, 'wedge'),
      nameAt(CHOSEN_NAMES, k, 'Chosen'));
  }
  for (const [k, x] of flanking(n(juth, 'juthungi-berserkers'), 150, 90).entries()) {
    push(germanic, battle.spawnUnit('juthungi-berserkers', x, germZ - 52, SOUTH, 'horde'),
      nameAt(FANATIC_NAMES, k, 'Fanatics'));
  }

  // Horse raiders sweeping wide on both wings, looking for an open flank. Placed outside
  // the battle line's own edge so they stay on the wing as the line grows.
  // 123 so that a nine-unit line puts the first pair at exactly +/-330, as shipped.
  const hostHalf = Math.max(200, (lineOrder.length * 46) / 2 + 123);
  for (const [k, x] of flanking(n(juth, 'juthungi-riders'), hostHalf, 56).entries()) {
    push(germanic, battle.spawnUnit('juthungi-riders', x, germZ + 46 - Math.floor(k / 2) * 34, SOUTH, 'loose'),
      nameAt(RAIDER_NAMES, k, 'Raiders'));
  }

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
