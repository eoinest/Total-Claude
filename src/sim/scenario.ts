import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import {
  type BattleConfig, type ScenarioId, DEFAULT_CONFIG, belligerents, compositionFor,
  fittedUnitScale,
} from './battleConfig';
import { Faction, UnitOrder, getOpposingFaction, setOpposingFaction } from './types';

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
  /**
   * The non-Roman side, whoever it is.
   *
   * Kept under this name rather than renamed: `main.ts` is the only consumer and it reads
   * nothing but `cameraFocus`, so a rename would be churn in a file this workstream does not
   * own. It holds the Carthaginian order of battle when Carthage is the opponent.
   */
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

// Carthage's contingents, named for where they were recruited rather than numbered, because
// that is how Polybius and Livy list them and because the point of this army is that its
// parts came from different places.
const LIBYAN_NAMES = [
  'Libyan Foot of Byrsa', 'Foot of Utica', 'Foot of Hadrumetum', 'Foot of Thapsus',
  'Foot of Leptis', 'Foot of Hippo',
];
const SCUTARII_NAMES = [
  'Scutarii of the Baetis', 'Scutarii of Ilergetia', 'Oretani Scutarii',
  'Carpetani Scutarii', 'Edetani Scutarii',
];
const GALLIC_NAMES = [
  'Boii Warband', 'Insubres Warband', 'Cenomani Warband', 'Taurini Warband',
  'Lingones Warband',
];
const CAETRATI_NAMES = [
  'Lusitani Caetrati', 'Celtiberian Caetrati', 'Vettones Caetrati', 'Turdetani Caetrati',
];
const BALEARIC_NAMES = [
  'Slingers of Ebusus', 'Slingers of Majorica', 'Slingers of Minorica', 'Gymnesian Slingers',
];
const NUMIDIAN_NAMES = [
  'Horse of Massylii', 'Horse of Masaesyli', 'Horse of Cirta', 'Horse of Zama',
  'Horse of Thugga', 'Horse of Vaga',
];
const ELEPHANT_NAMES = [
  'Elephants of the Bagradas', 'Elephants of Zama', 'Elephants of the Catabathmos',
  'Elephants of Theveste',
];
const SACRED_BAND_NAMES = ['The Sacred Band', 'Second Sacred Band'];

// The assault's own names. The first entries reproduce the labels the hardcoded deployment
// used, so the frames in screenshots/siege still name the units a critic saw in them.
const BALLISTARII_NAMES = [
  'Ballistarii of the Gate', 'Ballistarii II', 'Ballistarii III', 'Ballistarii IV',
  'Ballistarii V', 'Ballistarii VI', 'Ballistarii VII', 'Ballistarii VIII',
];
const SLINGER_NAMES = [
  'Slingers of the Suburra', 'Slingers of the Aventine', 'Slingers of Trastevere',
  'Slingers of the Caelian', 'Slingers of the Esquiline',
];
/** A ram is a named beast. *Widder* is the Germanic word the Romans wrote down. */
const RAM_NAMES = ['The Widder', 'The Boar', 'The Ash-Head'];

/** `names[k]`, falling back to a numbered variant once the hand-written list runs out. */
const nameAt = (names: readonly string[], k: number, stem: string): string =>
  names[k] ?? `${stem} ${ROMAN_NUMERALS[k] ?? k + 1}`;

/**
 * Which order of battle to deploy.
 *
 * `field` is the historical one this file has always produced: Rome's field army drawn up
 * on the Campus Martius at z 130, the Juthungi host at z −190, and the wall a distant
 * backdrop 400 m further south. `assault` is the storming of the curtain itself.
 *
 * They are separate scenarios and not two phases of one because the measured geometry says
 * they have to be: **the wall stands at z 430 to 555 and both armies of the field battle
 * deploy between z −248 and +262.** Nothing in the shipped deployment is within 170 m of
 * the masonry, so a garrison placed on it would spend the battle shooting at nothing and a
 * siege tower would need twenty-five minutes of real time to reach it. Making the assault a
 * later phase of the same battle is the right eventual answer and it is a scenario-design
 * problem, not a siege-mechanics one.
 */
export type ScenarioVariant = ScenarioId;

export function deployBattle(
  battle: BattleSystem,
  ctx: EngineContext,
  config: BattleConfig = DEFAULT_CONFIG,
  /**
   * Which order of battle to lay out. Defaults to the config's own choice, which is now a
   * first-class menu field; it used to be read out of `location.search` here because the
   * agent that wrote the assault could not edit `main.ts`. `main.ts` passes it explicitly.
   */
  variant: ScenarioVariant = config.scenario
): ScenarioResult {
  if (variant === 'assault') return deployAssault(battle, ctx, config);
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];
  // Always the *field* composition, whatever `config.scenario` says: `deployAssault` falls
  // back through here when there is no wall on the map, and it must then lay out a field
  // battle from the field's order of battle rather than from the siege one.
  battle.unitSizeScale = fittedUnitScale(config, ctx.quality.maxSoldiers, 'field');

  /**
   * Who Rome is fighting, and the one place the whole battle learns it.
   *
   * Set before anything else, because `enemyOf` reads it and the AI and combat both call
   * that. It is written exactly once per battle, here, outside any fixed step — see the
   * note on `setOpposingFaction` in `sim/types.ts` for why that is compatible with the
   * determinism rule.
   */
  const foe = belligerents(config)[1];
  setOpposingFaction(foe);

  const rome = compositionFor(config, Faction.Rome, 'field');
  const juth = compositionFor(config, foe, 'field');
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

  // ---------------------------------------------------------------------
  // Carthage, when Carthage is the enemy.
  //
  // A deliberately different shape from the Juthungi host, because it was a deliberately
  // different army. Hannibal's line at Cannae is the model: the mercenary contingents in
  // the centre where they were expected to give ground, the Libyan foot on their flanks
  // where they would close in on a legion that had pushed too far, the Numidians wide, and
  // the elephants out in front of the whole line rather than in it.
  // ---------------------------------------------------------------------
  if (foe === Faction.Carthage) {
    const punZ = germZ;
    // The battle line, alternating nationality rather than grouping it. A Punic line was
    // brigaded by contingent, and interleaving is what makes that legible from the air: a
    // player looking down sees white Iberian tunics between the Libyan and Gallic blocks
    // instead of three homogeneous slabs.
    const line: string[] = [];
    {
      let lib = n(juth, 'libyan-spearmen');
      let ibe = n(juth, 'iberian-scutarii');
      let gal = n(juth, 'gallic-mercenaries');
      while (lib > 0 || ibe > 0 || gal > 0) {
        if (gal > 0) { line.push('gallic-mercenaries'); gal--; }
        if (ibe > 0) { line.push('iberian-scutarii'); ibe--; }
        if (lib > 0) { line.push('libyan-spearmen'); lib--; }
      }
    }
    const counters = new Map<string, number>();
    const nameFor = (id: string): string => {
      const k = counters.get(id) ?? 0;
      counters.set(id, k + 1);
      switch (id) {
        case 'libyan-spearmen': return nameAt(LIBYAN_NAMES, k, 'Libyan Foot');
        case 'iberian-scutarii': return nameAt(SCUTARII_NAMES, k, 'Scutarii');
        case 'gallic-mercenaries': return nameAt(GALLIC_NAMES, k, 'Gallic Warband');
        case 'iberian-caetrati': return nameAt(CAETRATI_NAMES, k, 'Caetrati');
        case 'balearic-slingers': return nameAt(BALEARIC_NAMES, k, 'Slingers');
        case 'numidian-cavalry': return nameAt(NUMIDIAN_NAMES, k, 'Numidian Horse');
        case 'war-elephants': return nameAt(ELEPHANT_NAMES, k, 'Elephants');
        default: return nameAt(SACRED_BAND_NAMES, k, 'Sacred Band');
      }
    };
    for (const [k, x] of centred(line.length, 52).entries()) {
      const id = line[k];
      push(germanic, battle.spawnUnit(id, x, punZ, SOUTH, 'line'), nameFor(id));
    }

    // The Sacred Band behind the centre — the only reserve in the army and the only unit in
    // it whose men are fighting for their own city.
    for (const [k, x] of centred(n(juth, 'sacred-band'), 90).entries()) {
      void k;
      push(germanic, battle.spawnUnit('sacred-band', x, punZ - 62, SOUTH, 'shieldwall'),
        nameFor('sacred-band'));
    }

    // Screen: caetrati and slingers ahead of the line. The Balearics stand furthest out
    // because their 180 m sling out-ranges everything Rome has except the scorpions.
    for (const [k, x] of centred(n(juth, 'iberian-caetrati'), 150).entries()) {
      void k;
      push(germanic, battle.spawnUnit('iberian-caetrati', x, punZ + 58, SOUTH, 'skirmish'),
        nameFor('iberian-caetrati'));
    }
    for (const [k, x] of centred(n(juth, 'balearic-slingers'), 170).entries()) {
      void k;
      push(germanic, battle.spawnUnit('balearic-slingers', x, punZ + 40, SOUTH, 'loose'),
        nameFor('balearic-slingers'));
    }

    /**
     * The elephants, in front of the line and not in it.
     *
     * This is how they were actually used and it is also the only sensible place to put
     * them here: `resolveCrowding` splits every separation by inverse mass, and at 4,200 kg
     * against a man's 90 an elephant standing *inside* the battle line would shove its own
     * infantry aside 47 to 1 before the enemy ever arrived. In front, that same physics is
     * the whole point of the unit.
     */
    const eleHalf = Math.max(70, (line.length * 52) / 4);
    for (const [k, x] of centred(n(juth, 'war-elephants'), eleHalf).entries()) {
      void k;
      push(germanic, battle.spawnUnit('war-elephants', x, punZ + 96, SOUTH, 'loose'),
        nameFor('war-elephants'));
    }

    // Numidians wide on both wings — the arm that won Cannae, and the fastest thing here.
    const punHalf = Math.max(210, (line.length * 52) / 2 + 118);
    for (const [k, x] of flanking(n(juth, 'numidian-cavalry'), punHalf, 58).entries()) {
      push(germanic, battle.spawnUnit('numidian-cavalry',
        x, punZ + 52 - Math.floor(k / 2) * 30, SOUTH, 'loose'), nameFor('numidian-cavalry'));
    }

    /**
     * Both sides advance rather than hold.
     *
     * The Juthungi battle opens with everyone on `Hold` and lets the AI take it from there.
     * That cannot work here yet: `AIWorld.attach` registers perception views for Rome and
     * the Juthungi only, and `buildPerception` takes a single target faction — so with
     * Carthage on the field neither army can see the other and both stand still for the
     * whole battle. The exact patch is in this workstream's report; until it lands, the
     * deployment issues the order the AI would have. This is a scenario decision and not a
     * workaround hidden in a system: a player who takes command overrides it immediately.
     */
    for (const u of battle.units) {
      u.order = UnitOrder.AttackMove;
      u.targetX = u.faction === Faction.Rome ? 0 : 0;
      u.targetZ = u.faction === Faction.Rome ? punZ + 40 : romanZ - 40;
    }

    ctx.events.emit('battleStarted', { seed: battle.rng.getState(), scenario: 'carthage-271' });
    return {
      roman,
      germanic,
      cameraFocus: { x: 0, z: romanZ - 10, zoom: 0.78, yaw: Math.PI },
    };
  }


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

// ---------------------------------------------------------------------------
// The assault — storming the unfinished curtain
// ---------------------------------------------------------------------------

/**
 * The Juthungi storm the Aurelian Wall either side of the Porta Flaminia.
 *
 * Everything about this deployment is read from the wall itself at run time rather than
 * written down here, because the wall's geometry is generated: the bays are on a 35.5 m
 * pitch from a `WALL_X_MIN` that is solved from where the Tiber happens to run, their
 * construction stages are a function of their distance from the gate, and the wall-walk
 * steps in height with the ground under it. A hardcoded x would be wrong the first time
 * anything upstream changed, and would be wrong silently.
 *
 * The tactical picture:
 *
 *  - Rome holds the finished bays either side of the gate with ballistarii and slingers,
 *    with two cohorts in reserve inside the walls to plug whatever gets over.
 *  - The Juthungi bring four towers against the finished curtain, ladders against the
 *    no-parapet stretch west of the gate — the obvious weak point, and visibly so — and a
 *    ram at the gate itself.
 *  - The onagers stand off at 200 m and shoot at the parapet.
 *  - The rest of the host waits in the open behind them, which is what an assault
 *    reserve actually looks like and is also what fills the frame.
 */
function deployAssault(
  battle: BattleSystem, ctx: EngineContext, config: BattleConfig
): ScenarioResult {
  const roman: DeployedUnit[] = [];
  const germanic: DeployedUnit[] = [];
  /**
   * Establishment, not the menu's battle-size multiplier — but still fitted to the pool.
   *
   * `scaleAppliesTo('assault')` is false, so `fittedUnitScale` asks for x1 and then only ever
   * lowers it to make the battle fit the quality tier's soldier pool. See its comment for the
   * measurement behind that: a wall-walk run holds about 84 men and a ballistarii unit is
   * already 108, so doubling establishment puts nobody new on the parapet, it stacks men
   * inside each other at the inner edge. This is strictly better than the flat `= 1` it
   * replaces, which overflowed the pool at the `low` tier and lost whole units off the end of
   * the deployment.
   */
  battle.unitSizeScale = fittedUnitScale(config, ctx.quality.maxSoldiers, 'assault');

  const rome = compositionFor(config, Faction.Rome, 'assault');
  const juth = compositionFor(config, Faction.Germanic, 'assault');
  const n = (comp: Readonly<Record<string, number>>, id: string): number =>
    Math.max(0, comp[id] ?? 0);

  const siege = battle.siege;
  /**
   * The city, through the narrowest view that will do the job.
   *
   * A structural type rather than an import of `CitySystem`: `src/sim/` must not depend on
   * `src/city/`, and it does not have to — everything an assault needs is four accessors and
   * three scalars. **Nothing here names Rome**, which is the point. `cityPlan` carries the
   * display name, the gate the ram drives at, and which faction holds the wall; the storming
   * side is whichever belligerent is not that one.
   */
  const city = ctx.tryGet('city') as unknown as {
    getGarrisonBays?: () => readonly {
      index: number; x0: number; z0: number; x1: number; z1: number;
      nx: number; nz: number; walkY: number; garrisonable: boolean;
      isGate: boolean; stage: string;
    }[];
    getGates?: () => { id: string; x: number; z: number; facing: number }[];
    cityPlan?: { id: string; name: string; siegeGateId: string; garrison: Faction };
  } | undefined;
  const bays = city?.getGarrisonBays?.() ?? [];
  const plan = city?.cityPlan;
  const gates = city?.getGates?.() ?? [];
  // The gate the ram drives at, named by the plan rather than taken as "the first one". A
  // circuit with three gates (Carthage has three) would otherwise be stormed at whichever one
  // the wall builder happened to emit first, which is not a decision anyone made.
  const gate = gates.find((g) => g.id === plan?.siegeGateId) ?? gates[0];
  const cityName = plan?.name ?? 'the city';
  /**
   * Who holds the wall, and who storms it.
   *
   * `deployAssault` put `Faction.Rome` on the parapet because Rome was the only city there
   * was. At Carthage that is the wrong army on the wrong side of its own wall: Rome is the
   * besieger there. The garrison side comes from the plan and the storming side is derived,
   * so this function never learns a list of cities.
   */
  const garrisonSide = plan?.garrison ?? Faction.Rome;
  const stormSide = belligerents(config).find((f) => f !== garrisonSide) ?? Faction.Germanic;
  setOpposingFaction(garrisonSide === Faction.Rome ? stormSide : garrisonSide);
  /**
   * **The one thing this generalisation does not do, named rather than guessed.**
   *
   * The two siege orders of battle are still keyed to Rome-garrisons-and-the-Juthungi-storm,
   * because the roster has no Punic wall troops and no Roman siege train — `ballistarii`,
   * `wall-slingers` and `carroballista` are Roman, `tower-assault`, `escalade-party`,
   * `ram-crew` and `onager` are Juthungi, and inventing Punic equivalents is the roster
   * workstream's call, not this file's. Guessing at another workstream's table is how work
   * gets lost.
   *
   * It is not currently reachable: a map with no `CityPlan` cannot host an assault
   * (`sanitiseConfig`), Carthage has no plan yet, and so `garrisonSide` is always
   * `Faction.Rome` today. When Carthage's plan lands, `rosterFor` needs a *role* argument —
   * garrison or storm — instead of a faction, and `SIEGE_CARTHAGE_ROSTER` and a Roman siege
   * train need to exist. Everything else below already follows `garrisonSide`.
   */
  const garrisonComp = garrisonSide === Faction.Rome ? rome : juth;
  const stormComp = garrisonSide === Faction.Rome ? juth : rome;
  void garrisonComp;
  void stormComp;

  const push = (arr: DeployedUnit[], id: number, label: string) => {
    if (id >= 0) arr.push({ unitId: id, label });
  };

  // Fall back to the field battle if there is no wall to storm.
  //
  // `sanitiseConfig` already refuses `assault` on a map that hides the city, so a player can
  // no longer reach this by choosing Pydna; what is left is a harness or an embed with no
  // `CitySystem` registered at all. The player's own field order of battle is used rather
  // than `DEFAULT_CONFIG`, which is what they would have got had they picked the field
  // battle themselves.
  if (bays.length === 0 || !gate) return deployBattle(battle, ctx, config, 'field');

  const gateBay = bays.find((b) => b.isGate) ?? bays[Math.floor(bays.length / 2)];
  const at = (k: number) => bays[Math.max(0, Math.min(bays.length - 1, gateBay.index + k))];
  /** Midpoint of a bay, which is where anything aimed at it should be aimed. */
  const mid = (k: number): { x: number; z: number; y: number; nx: number; nz: number } => {
    const b = at(k);
    return { x: (b.x0 + b.x1) * 0.5, z: (b.z0 + b.z1) * 0.5, y: b.walkY, nx: b.nx, nz: b.nz };
  };
  /** A point `d` metres out from the middle of bay `k`, on the attackers' side. */
  const out = (k: number, d: number): [number, number] => {
    const m = mid(k);
    return [m.x + m.nx * d, m.z + m.nz * d];
  };
  /** Whether bay offset `k` from the gate exists on this circuit at all. */
  const real = (k: number): boolean =>
    gateBay.index + k >= 0 && gateBay.index + k < bays.length;

  /**
   * The first `count` bay offsets at or beyond `from`, fanning out alternately either side
   * of the gate, skipping any the predicate rejects.
   *
   * The bay lists this replaces were written out by hand — `[-1, 1, 2, -2, 3]` for the
   * ballistarii, `[-3, -4, 3, 5]` for the ladders — which was fine while the counts were
   * fixed and is not once the menu owns them. Fanning outward is the rule those lists were
   * reaching for: hold the gate first and work along the curtain. It also *delivers* the
   * count the player asked for, where the hand-written version silently dropped a unit whose
   * bay happened not to be garrisonable, so a menu that promised five units of ballistarii
   * could have put four on the wall.
   *
   * The one thing it does not reproduce is the left/right tie-break at each distance, which
   * no consistent rule produces from those lists: bays +-3 swap which type holds them. The
   * set of bays occupied at the default composition is unchanged, and so is the intent —
   * ballistarii on the finished curtain near the gate, slingers on the unfinished stretch
   * beyond. `scenario.ts` already carries the same note about the equites.
   */
  const fanOut = (count: number, from: number, ok: (k: number) => boolean): number[] => {
    const picked: number[] = [];
    for (let d = from; d < from + bays.length && picked.length < count; d++) {
      for (const s of [-1, 1]) {
        if (picked.length >= count) break;
        if (ok(s * d)) picked.push(s * d);
      }
    }
    return picked;
  };
  /** A bay that can carry men on its walk, which is what a garrison and a ladder both need. */
  const holdable = (k: number): boolean => real(k) && at(k).garrisonable;

  // ---- Rome: the garrison ------------------------------------------------
  // Wall troops fill the bays either side of the gate, working outward, in roster order:
  // ballistarii take the finished curtain nearest the gate and slingers what is left, which
  // is the unfinished stretch where there is no parapet to shoot from — but a sling does not
  // need one. `SIEGE_ROME_ROSTER`'s order is what decides that, so it is deployment order.
  const wallTypes: [string, readonly string[], string][] = [
    ['ballistarii', BALLISTARII_NAMES, 'Ballistarii'],
    ['wall-slingers', SLINGER_NAMES, 'Slingers'],
  ];
  {
    const bayFor = fanOut(
      n(rome, 'ballistarii') + n(rome, 'wall-slingers'), 1, holdable
    );
    let next = 0;
    for (const [type, names, stem] of wallTypes) {
      for (let i = 0; i < n(rome, type); i++) {
        const k = bayFor[next++];
        if (k === undefined) break;
        const m = mid(k);
        // Spawned on the ground under the bay and then lifted onto it: `spawnUnit` snaps every
        // man to the terrain, and `Siege.garrison` is the only thing in the sim that can put
        // him anywhere else.
        const id = battle.spawnUnit(type, m.x, m.z, Math.atan2(m.nx, m.nz), 'line');
        const u = battle.unitById(id);
        if (!u) continue;
        if (!siege.garrison(u, m.x, m.z)) continue;
        push(roman, id, nameAt(names, i, stem));
      }
    }
  }

  // Carroballistae behind the parapet, on the flanks of the gate bay.
  for (const [i, k] of fanOut(n(rome, 'carroballista'), 2, real).entries()) {
    const [cx, cz] = out(k, -14);
    push(roman, battle.spawnUnit('carroballista', cx, cz, Math.atan2(mid(k).nx, mid(k).nz), 'line'),
      `Carroballista ${ROMAN_NUMERALS[i] ?? i + 1}`);
  }

  // Cohorts in reserve 46 m inside the walls, to plug whatever gets over. They stand behind
  // the same bays the towers come at, fanned out in the same order, because that is where a
  // breach will be: a reserve posted anywhere else is a reserve that arrives late.
  for (const [i, k] of fanOut(n(rome, 'legio-cohort'), 1, real).entries()) {
    const m = mid(k);
    const [rx, rz] = out(k, -46);
    push(roman, battle.spawnUnit('legio-cohort', rx, rz, Math.atan2(m.nx, m.nz), 'line'),
      `Cohort ${ROMAN_NUMERALS[i] ?? i + 1}`);
  }

  // ---- The Juthungi: the assault -----------------------------------------
  // Towers against the finished curtain, where the parapet fight will be worth watching.
  // Echeloned back 9 m apiece so four machines converging on four adjacent bays do not
  // arrive in one rank and foul each other.
  for (const [i, k] of fanOut(n(juth, 'tower-assault'), 1, real).entries()) {
    const m = mid(k);
    const [sx, sz] = out(k, 74 + i * 9);
    const id = battle.spawnUnit('tower-assault', sx, sz - m.nz * 12, Math.atan2(-m.nx, -m.nz), 'line');
    if (id < 0) continue;
    siege.spawnTower(sx, sz, m.x, m.z, id);
    push(germanic, id, `Tower Party ${ROMAN_NUMERALS[i] ?? i + 1}`);
  }

  // Ladders against the stretch with no parapet raised yet — beyond the bays the towers are
  // taking. It is the obvious place to go over and it is obvious from the ground, which is
  // the point of building the wall unfinished in the first place.
  // Beyond bay +-2 while there are towers, because those bays are the towers' — but a player
  // who fields no towers at all should get their ladders against the gate bays rather than
  // sending every party to the far end of the circuit for no reason.
  const ladderStart = n(juth, 'tower-assault') === 0 ? 1 : 3;
  for (const [i, k] of fanOut(n(juth, 'escalade-party'), ladderStart, holdable).entries()) {
    const m = mid(k);
    const [sx, sz] = out(k, 26);
    const id = battle.spawnUnit('escalade-party', sx, sz, Math.atan2(-m.nx, -m.nz), 'loose');
    if (id < 0) continue;
    // Three ladders per party, spread across the bay's frontage.
    for (let j = -1; j <= 1; j++) {
      siege.spawnLadder(m.x + (-m.nz) * j * 7, m.z + m.nx * j * 7, id);
    }
    push(germanic, id, `Ladder Party ${ROMAN_NUMERALS[i] ?? i + 1}`);
  }

  // The ram, on the axis of the Via Flaminia. A second crew queues 18 m behind the first
  // rather than beside it: there is one gate, and two rams abreast of it would occupy the
  // same ground and beat on the same timber.
  for (let i = 0; i < n(juth, 'ram-crew'); i++) {
    const reach = 62 + i * 18;
    const gx = gate.x + Math.sin(gate.facing) * reach;
    const gz = gate.z + Math.cos(gate.facing) * reach;
    const id = battle.spawnUnit('ram-crew', gx, gz, gate.facing + Math.PI, 'line');
    if (id < 0) continue;
    siege.spawnRam(gx, gz, id);
    push(germanic, id, nameAt(RAM_NAMES, i, 'Ram'));
  }

  // Onagers standing off at 196 m, shooting at the parapet. Spread along the wall rather
  // than by bay, so the battery keeps its spacing however many there are.
  {
    const m = mid(0);
    const [ox, oz] = out(0, 196);
    for (const [i, along] of centred(n(juth, 'onager'), 71).entries()) {
      const id = battle.spawnUnit('onager',
        ox + -m.nz * along, oz + m.nx * along, Math.atan2(-m.nx, -m.nz), 'line');
      if (id < 0) continue;
      const u = battle.unitById(id);
      if (u) siege.registerArtillery(u);
      push(germanic, id, `Onager Battery ${ROMAN_NUMERALS[i] ?? i + 1}`);
    }
  }

  // The host, waiting its turn in the open. An assault is mostly men standing about
  // watching other men die on a ladder, and leaving them out makes the field look empty.
  {
    const m = mid(0);
    const [bx, bz] = out(0, 132);
    for (const [i, along] of centred(n(juth, 'juthungi-warband'), 62).entries()) {
      push(germanic, battle.spawnUnit('juthungi-warband',
        bx + -m.nz * along, bz + m.nx * along, Math.atan2(-m.nx, -m.nz), 'horde'),
        nameAt(BAND_NAMES, i, 'Warband'));
    }
  }
  {
    const m = mid(0);
    const [bx, bz] = out(0, 178);
    for (const [i, along] of flanking(n(juth, 'juthungi-riders'), 240, 70).entries()) {
      push(germanic, battle.spawnUnit('juthungi-riders',
        bx + -m.nz * along, bz + m.nx * along, Math.atan2(-m.nx, -m.nz), 'loose'),
        nameAt(RAIDER_NAMES, i, 'Raiders'));
    }
  }

  for (const u of battle.units) {
    // The garrison keeps the order the siege system gave it; everyone else holds until
    // the AI or the player says otherwise.
    if (u.order !== UnitOrder.Garrison) u.order = UnitOrder.Hold;
  }

  ctx.events.emit('battleStarted', {
    seed: battle.rng.getState(),
    scenario: `assault-of-${plan?.id ?? 'city'}`,
  });

  const focus = mid(1);
  return {
    roman,
    germanic,
    /*
     * Outside the wall looking at it, from about where the towers are coming from: the
     * curtain across the frame, the gate to one side, the assault in the middle distance.
     * Yaw 0 looks toward +Z, which is the city on every map — that is a fixed engine
     * convention, not a fact about Rome (`scenario.ts` deploys the attacker at z −190 and the
     * defender at z +130 whatever the compass says), so this framing carries to any city.
     *
     * The offset is taken from the bay's own outward normal rather than as `−96` in z, so a
     * curtain that runs at an angle — Carthage's falls 121 m of z across its length — is
     * still framed square rather than obliquely.
     */
    cameraFocus: {
      x: focus.x + focus.nx * 96,
      z: focus.z + focus.nz * 96,
      zoom: 0.52,
      yaw: 0,
    },
  };
}

/**
 * Simple victory check used until the objective system lands.
 *
 * Faction-agnostic on purpose and in two senses. It counts Rome against *everyone who is not
 * Rome* rather than against `Faction.Germanic`, because the exact form would have reported a
 * Carthaginian army as annihilated on the first tick and handed Rome an instant win against
 * an army still standing there. And it takes the engine context rather than the battle alone,
 * so it can name the city and say what actually happened at a wall: "the storm was thrown
 * back from Carthage" is a different result from "the Juthungi routed", and the two need
 * different words even when the arithmetic is identical.
 *
 * `ctx` is optional so every existing caller and every probe keeps working; without it the
 * reason is the bare one it always was.
 */
export function checkVictory(
  battle: BattleSystem,
  ctx?: EngineContext,
): { over: boolean; victor: Faction | -1; reason: string } {
  const romans = battle.activeUnits(Faction.Rome);
  const others = battle.activeUnits().filter((u) => u.faction !== Faction.Rome);
  const romanMen = romans.reduce((a, u) => a + u.alive, 0);
  const otherMen = others.reduce((a, u) => a + u.alive, 0);
  if (romanMen > 0 && otherMen > 0) return { over: false, victor: -1, reason: '' };

  /**
   * Who was defending a wall, if anyone. Read through the same narrow structural view the
   * deployment uses; `src/sim/` does not import `src/city/`.
   *
   * This is what makes the result mean something on a siege map. A besieger who kills the
   * garrison has *taken the city*; a garrison that kills the besieger has *held the wall*.
   * Both are the same two numbers being zero and they are not the same event.
   */
  const city = ctx?.tryGet('city') as unknown as {
    cityPlan?: { name: string; garrison: Faction };
    getGateDoor?: () => { open: boolean } | null;
  } | undefined;
  const plan = city?.cityPlan;

  const outcome = (victor: Faction | -1, survivors: number): string => {
    if (victor === -1) return 'annihilation';
    if (!plan) return survivors > 0 ? 'rout' : 'annihilation';
    if (victor === plan.garrison) return `${plan.name} holds`;
    return city?.getGateDoor?.()?.open ? `${plan.name} is stormed` : `${plan.name} falls`;
  };

  if (romanMen === 0 && otherMen === 0) return { over: true, victor: -1, reason: 'annihilation' };
  if (otherMen === 0) {
    return { over: true, victor: Faction.Rome, reason: outcome(Faction.Rome, romans.length) };
  }
  const victor = others[0]?.faction ?? getOpposingFaction();
  return { over: true, victor, reason: outcome(victor, others.length) };
}
