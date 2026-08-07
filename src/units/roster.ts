import { Faction, type UnitTypeDef } from '../sim/types';
import { SIEGE_UNITS } from './siegeUnits';

/**
 * Unit roster for the Siege of Rome, 271 AD.
 *
 * Historical setting: the Juthungi and Alemanni broke into Italy in 270-271. Aurelian
 * caught and beat them at Placentia, Fano and Pavia, but the panic they caused in the
 * capital is exactly why he began the Aurelian Walls that same year. This roster is
 * that campaign's "what if they had reached the city" — late-third-century Roman kit
 * (ring mail and the longer spatha are displacing segmentata and gladius, oval shields
 * are replacing the rectangular scutum) against a Germanic confederation fighting in
 * deep wedges with framea javelins and long spears.
 *
 * Stat scale: melee attack/defence are unbounded weights compared against each other;
 * damage is hit points per blow against a man's 100; armour is fed through a
 * diminishing-returns curve in `combatShared.ts`, not subtracted flat; morale is 0-100
 * and `discipline` divides all incoming morale pressure.
 *
 * **Melee lethality is calibrated, not guessed.** `tools/matchup.mjs` fights isolated
 * pairs and reports how long they take. Damage and attack rates here are set so that a
 * matched pair of line units grinds for two to four minutes and a favourable matchup
 * still takes a minute — the measured pacing of a Rome II line engagement. An earlier
 * pass had a legionary cohort destroy a warband in eighteen seconds, killing 5.8 men a
 * second, which is roughly four times the rate at which a Total War melee kills.
 *
 * `discipline` spread is deliberately narrower than it looks like it should be. At 1.42
 * against 0.82 a legionary cohort took barely half the morale damage a warband did from
 * the same event, and combined with higher base morale that made Roman units almost
 * twice as hard to break — so the Juthungi could never win a morale contest they should
 * sometimes win by weight of numbers and a good charge.
 */

export const ROMAN_UNITS: UnitTypeDef[] = [
  {
    id: 'legio-cohort',
    name: 'Legionary Cohort',
    nativeName: 'Cohors Legionaria',
    faction: Faction.Rome,
    unitClass: 'heavy-infantry',
    strength: 160,
    meleeAttack: 40, meleeDamage: 13, apDamage: 3, meleeDefence: 40,
    armour: 52, shieldDefence: 34, chargeBonus: 14, bonusVsCavalry: 6,
    attackRate: 0.6, reach: 1.1,
    missile: { kind: 'pilum', range: 26, damage: 44, apDamage: 22, rate: 6, ammo: 2, accuracy: 0.09, arc: 'flat' },
    walkSpeed: 1.55, runSpeed: 3.5, chargeSpeed: 4.3, mass: 96, stamina: 62,
    morale: 68, discipline: 1.2,
    appearance: {
      weapon: 'gladius', sidearm: 'pilum', shield: 'scutum', armour: 'segmentata',
      helmet: 'imperial-gallic', crest: 'none', cloak: false, bareChested: false,
      variance: 0.35, heightScale: 1.0, shieldEmblem: 'legio-thunderbolt',
      tunicColour: 0xa8262b, legColour: 0xb5a483,
    },
    formations: ['line', 'testudo', 'wedge', 'loose', 'shieldwall'],
    abilities: ['testudo', 'pilum-volley'],
    description: 'The backbone of the legions. Throws a pilum volley, then closes with the gladius behind a wall of shields.',
  },
  {
    id: 'praetorian-cohort',
    name: 'Praetorian Guard',
    nativeName: 'Cohors Praetoria',
    faction: Faction.Rome,
    unitClass: 'heavy-infantry',
    strength: 120,
    meleeAttack: 54, meleeDamage: 16, apDamage: 5, meleeDefence: 48,
    armour: 60, shieldDefence: 38, chargeBonus: 18, bonusVsCavalry: 7,
    attackRate: 0.66, reach: 1.1,
    missile: { kind: 'pilum', range: 27, damage: 46, apDamage: 24, rate: 6, ammo: 2, accuracy: 0.08, arc: 'flat' },
    walkSpeed: 1.5, runSpeed: 3.4, chargeSpeed: 4.2, mass: 104, stamina: 74,
    morale: 86, discipline: 1.42,
    appearance: {
      weapon: 'gladius', sidearm: 'pilum', shield: 'oval', armour: 'squamata',
      helmet: 'intercisa', crest: 'longitudinal', cloak: true, bareChested: false,
      variance: 0.22, heightScale: 1.03, shieldEmblem: 'praetorian-scorpion',
      tunicColour: 0x8d1c22, legColour: 0xc2b391,
    },
    formations: ['line', 'testudo', 'wedge', 'shieldwall'],
    abilities: ['testudo', 'pilum-volley', 'inspire'],
    description: "The emperor's own. Scale armour, gilded helmets, and morale that does not break.",
  },
  {
    id: 'urban-cohort',
    name: 'Urban Cohort',
    nativeName: 'Cohors Urbana',
    faction: Faction.Rome,
    unitClass: 'spear-infantry',
    strength: 150,
    meleeAttack: 30, meleeDamage: 11, apDamage: 2, meleeDefence: 36,
    armour: 40, shieldDefence: 30, chargeBonus: 6, bonusVsCavalry: 36,
    attackRate: 0.52, reach: 2.4,
    walkSpeed: 1.5, runSpeed: 3.3, chargeSpeed: 3.9, mass: 88, stamina: 50,
    morale: 55, discipline: 1.05,
    appearance: {
      weapon: 'spear', sidearm: 'gladius', shield: 'oval', armour: 'hamata',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.5, heightScale: 0.99, shieldEmblem: 'urban-wreath',
      tunicColour: 0xb2543c, legColour: 0xab9c7d,
    },
    formations: ['line', 'shieldwall', 'loose'],
    abilities: ['brace'],
    description: 'The city garrison. Second-line troops, but a hedge of spears holds a street or a gate.',
  },
  {
    id: 'sagittarii',
    name: 'Auxiliary Archers',
    nativeName: 'Sagittarii Auxiliares',
    faction: Faction.Rome,
    unitClass: 'missile-infantry',
    strength: 100,
    meleeAttack: 16, meleeDamage: 7, apDamage: 1, meleeDefence: 20,
    armour: 18, shieldDefence: 0, chargeBonus: 2, bonusVsCavalry: 0,
    attackRate: 0.48, reach: 0.9,
    missile: { kind: 'bow', range: 165, damage: 20, apDamage: 4, rate: 9, ammo: 26, accuracy: 0.05, arc: 'high' },
    walkSpeed: 1.65, runSpeed: 3.9, chargeSpeed: 4.1, mass: 72, stamina: 66,
    morale: 45, discipline: 1.0,
    appearance: {
      weapon: 'bow', sidearm: 'gladius', shield: 'none', armour: 'cloth',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.65, heightScale: 0.98, shieldEmblem: 'none',
      tunicColour: 0xcfc09a, legColour: 0x9c8f74,
    },
    formations: ['loose', 'line', 'skirmish'],
    abilities: ['fire-at-will', 'arrow-storm'],
    description: 'Eastern auxiliaries with composite bows. Devastating against unarmoured tribesmen in the open.',
  },
  {
    id: 'equites',
    name: 'Roman Cavalry',
    nativeName: 'Equites Legionis',
    faction: Faction.Rome,
    unitClass: 'heavy-cavalry',
    strength: 60,
    meleeAttack: 44, meleeDamage: 15, apDamage: 4, meleeDefence: 38,
    armour: 46, shieldDefence: 26, chargeBonus: 46, bonusVsCavalry: 8,
    attackRate: 0.58, reach: 2.1,
    walkSpeed: 2.6, runSpeed: 7.4, chargeSpeed: 9.6, mass: 520, stamina: 58,
    morale: 68, discipline: 1.15,
    appearance: {
      weapon: 'spatha', sidearm: 'spear', shield: 'round', armour: 'hamata',
      helmet: 'intercisa', crest: 'plume', cloak: true, bareChested: false,
      variance: 0.3, heightScale: 1.01, shieldEmblem: 'equites-star',
      tunicColour: 0x9d2a2f, legColour: 0xa89878,
    },
    formations: ['wedge', 'line', 'loose'],
    abilities: ['charge'],
    description: 'Shock cavalry for the flanks. Ruinous against archers and broken infantry, wasted on a spear wall.',
  },
  {
    id: 'scorpio',
    name: 'Scorpion Battery',
    nativeName: 'Scorpiones',
    faction: Faction.Rome,
    unitClass: 'artillery',
    /**
     * Four engines of three men, not two dozen infantrymen.
     *
     * This was 24 with a `bow` appearance, and it rendered as what it said: two dozen
     * archers standing in a line with no machine anywhere. A Rome II artillery unit is a
     * *small number of engines* each with a crew — the men exist to serve the machine, and
     * the machine is the unit. `engines.ts` divides the strength by `CREW_PER_ENGINE`, so
     * this number and the number of scorpions on the field are the same fact.
     *
     * `BattleSystem.spawnUnit` exempts artillery from the unit-size multiplier, so a battery
     * is four engines at every battle-size setting, which is right: a legion's artillery
     * establishment did not scale with how many men you felt like fielding.
     */
    strength: 12,
    meleeAttack: 14, meleeDamage: 6, apDamage: 1, meleeDefence: 16,
    armour: 22, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    missile: { kind: 'bolt', range: 320, damage: 90, apDamage: 70, rate: 3, ammo: 40, accuracy: 0.014, arc: 'flat' },
    walkSpeed: 0.9, runSpeed: 1.5, chargeSpeed: 1.5, mass: 240, stamina: 40,
    morale: 40, discipline: 1.05,
    appearance: {
      // `bolt` means "his weapon is the machine": `resolveKit` gives him a sheathed spatha
      // and empty hands, because a man working a windlass is not also holding a bow. The
      // whole reason this unit read as archers was that `weapon: 'bow'` put a composite bow
      // and a quiver on all twenty-four of them.
      weapon: 'bolt', sidearm: 'spatha', shield: 'none', armour: 'leather',
      // Artillerymen were legionary immunes — skilled tradesmen excused fatigues — so they
      // wear the legion's issue tunic rather than an auxiliary's undyed one, over a leather
      // subarmalis with the mail off while they work.
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      // High for a Roman unit, and deliberately. A blind critic reading a battery frame said
      // "the same helmet/tunic/pose triple repeats verbatim across all three weapon crews",
      // and at 0.55 with only twelve men the helmet roll lands on a Coolus for most of them.
      // Artillerymen were immunes seconded out of different centuries rather than a cohort
      // issued together, so a mixed kit is the more accurate reading as well as the fix.
      variance: 0.85, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0x9e3026, legColour: 0x8e8266,
    },
    formations: ['line'],
    abilities: ['fire-at-will'],
    description: 'Torsion bolt-throwers served by legionary immunes. A single shot punches through a shield, the man behind it, and the man behind him.',
  },
];

/**
 * No `onager` entry here on purpose.
 *
 * One was written and then removed: `siegeUnits.ts` already defines `onager` as a *Germanic*
 * battery of captured Roman engines, and because `ALL_UNITS` concatenates `SIEGE_UNITS` last,
 * two entries under one id means the later one silently wins and the earlier one is dead code
 * that still typechecks. That file's own comment asks for this workstream's geometry to render
 * it, which is exactly what happens: `engineKindOf` reads `missile.arc === 'high'` and
 * `UnitRenderSystem` draws `buildOnagerGeometry` for it. The stats live there, the machine
 * lives here, and neither file has to know about the other.
 *
 * `carroballista`, in the same file, comes out as a scorpio for the same reason — its arc is
 * flat. That is right as far as it goes; see this workstream's report for the one thing it
 * still needs, which is wheels instead of a tripod.
 */
export const GERMANIC_UNITS: UnitTypeDef[] = [
  {
    id: 'juthungi-warband',
    name: 'Tribal Warband',
    nativeName: 'Juthungi Harjis',
    faction: Faction.Germanic,
    unitClass: 'light-infantry',
    strength: 180,
    meleeAttack: 39, meleeDamage: 14, apDamage: 3, meleeDefence: 26,
    armour: 20, shieldDefence: 22, chargeBonus: 30, bonusVsCavalry: 2,
    attackRate: 0.7, reach: 1.0,
    missile: { kind: 'framea', range: 22, damage: 34, apDamage: 12, rate: 7, ammo: 2, accuracy: 0.13, arc: 'flat' },
    walkSpeed: 1.72, runSpeed: 4.2, chargeSpeed: 5.3, mass: 84, stamina: 70,
    morale: 64, discipline: 0.98,
    appearance: {
      weapon: 'axe', sidearm: 'framea', shield: 'round', armour: 'leather',
      helmet: 'none', crest: 'none', cloak: true, bareChested: false,
      variance: 0.9, heightScale: 1.04, shieldEmblem: 'germanic-spiral',
      tunicColour: 0x5c6349, legColour: 0x6b5a44,
    },
    formations: ['loose', 'wedge', 'line', 'horde'],
    abilities: ['warcry', 'framea-volley'],
    description: 'Free tribesmen who fight for plunder and reputation. A furious first charge; little staying power.',
  },
  {
    id: 'juthungi-spears',
    name: 'Tribal Spearmen',
    nativeName: 'Juthungi Gaizaharjis',
    faction: Faction.Germanic,
    unitClass: 'spear-infantry',
    strength: 170,
    meleeAttack: 32, meleeDamage: 12, apDamage: 2, meleeDefence: 32,
    armour: 22, shieldDefence: 28, chargeBonus: 16, bonusVsCavalry: 44,
    attackRate: 0.54, reach: 2.6,
    walkSpeed: 1.62, runSpeed: 3.8, chargeSpeed: 4.6, mass: 86, stamina: 64,
    morale: 62, discipline: 1.02,
    appearance: {
      weapon: 'spear', sidearm: 'axe', shield: 'round', armour: 'leather',
      helmet: 'spangenhelm', crest: 'none', cloak: false, bareChested: false,
      variance: 0.8, heightScale: 1.03, shieldEmblem: 'germanic-sunwheel',
      tunicColour: 0x4f5a44, legColour: 0x6e5c45,
    },
    formations: ['line', 'shieldwall', 'wedge', 'loose'],
    abilities: ['brace', 'warcry'],
    description: 'Long ash spears in a deep block. The one Germanic formation that can stop Roman horse cold.',
  },
  {
    id: 'juthungi-chosen',
    name: "Chieftain's Chosen",
    nativeName: 'Gadrauhts',
    faction: Faction.Germanic,
    unitClass: 'shock-infantry',
    strength: 100,
    meleeAttack: 56, meleeDamage: 19, apDamage: 8, meleeDefence: 38,
    armour: 38, shieldDefence: 24, chargeBonus: 44, bonusVsCavalry: 6,
    attackRate: 0.72, reach: 1.3,
    walkSpeed: 1.78, runSpeed: 4.4, chargeSpeed: 5.7, mass: 98, stamina: 80,
    morale: 82, discipline: 1.15,
    appearance: {
      weapon: 'axe', sidearm: 'spatha', shield: 'round', armour: 'hamata',
      helmet: 'spangenhelm', crest: 'horns', cloak: true, bareChested: false,
      variance: 0.55, heightScale: 1.08, shieldEmblem: 'germanic-wolf',
      tunicColour: 0x3f4738, legColour: 0x5f5040,
    },
    formations: ['wedge', 'line', 'loose'],
    abilities: ['warcry', 'frenzy'],
    description: "The chieftain's sworn companions, mailed and battle-rich. Their wedge breaks shield walls.",
  },
  {
    id: 'juthungi-berserkers',
    name: 'Naked Fanatics',
    nativeName: 'Berhtjos',
    faction: Faction.Germanic,
    unitClass: 'shock-infantry',
    strength: 80,
    meleeAttack: 62, meleeDamage: 21, apDamage: 10, meleeDefence: 14,
    armour: 4, shieldDefence: 0, chargeBonus: 54, bonusVsCavalry: 0,
    attackRate: 0.92, reach: 1.2,
    walkSpeed: 1.95, runSpeed: 5.0, chargeSpeed: 6.4, mass: 78, stamina: 92,
    morale: 96, discipline: 0.62,
    appearance: {
      weapon: 'axe', sidearm: 'club', shield: 'none', armour: 'none',
      helmet: 'fur-cap', crest: 'none', cloak: false, bareChested: true,
      variance: 1.0, heightScale: 1.06, shieldEmblem: 'none',
      tunicColour: 0x8a7255, legColour: 0x7d6a4f,
    },
    formations: ['loose', 'horde', 'wedge'],
    abilities: ['frenzy', 'warcry', 'unbreakable'],
    description: 'Fighting stripped to the waist to show they do not expect to come back. Terrifying, and paper-thin.',
  },
  {
    id: 'juthungi-skirmishers',
    name: 'Tribal Skirmishers',
    nativeName: 'Framjos',
    faction: Faction.Germanic,
    unitClass: 'missile-infantry',
    strength: 110,
    meleeAttack: 20, meleeDamage: 8, apDamage: 2, meleeDefence: 20,
    armour: 8, shieldDefence: 14, chargeBonus: 6, bonusVsCavalry: 0,
    attackRate: 0.58, reach: 1.0,
    missile: { kind: 'javelin', range: 34, damage: 30, apDamage: 14, rate: 11, ammo: 7, accuracy: 0.1, arc: 'flat' },
    walkSpeed: 1.9, runSpeed: 4.8, chargeSpeed: 5.2, mass: 68, stamina: 88,
    morale: 42, discipline: 0.8,
    appearance: {
      weapon: 'javelin', sidearm: 'axe', shield: 'round', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 1.0, heightScale: 1.0, shieldEmblem: 'germanic-plain',
      tunicColour: 0x6d6a4e, legColour: 0x7a6749,
    },
    formations: ['skirmish', 'loose'],
    abilities: ['fire-at-will', 'skirmish-mode'],
    description: 'Youths with a fistful of framea. They harry the legion, then melt away before it can answer.',
  },
  {
    id: 'juthungi-riders',
    name: 'Tribal Horse Raiders',
    nativeName: 'Marharjis',
    faction: Faction.Germanic,
    unitClass: 'light-cavalry',
    strength: 50,
    meleeAttack: 40, meleeDamage: 13, apDamage: 3, meleeDefence: 26,
    armour: 20, shieldDefence: 18, chargeBonus: 40, bonusVsCavalry: 6,
    attackRate: 0.62, reach: 2.0,
    walkSpeed: 2.9, runSpeed: 8.2, chargeSpeed: 10.2, mass: 460, stamina: 72,
    morale: 55, discipline: 0.88,
    appearance: {
      weapon: 'spear', sidearm: 'axe', shield: 'round', armour: 'leather',
      helmet: 'fur-cap', crest: 'none', cloak: true, bareChested: false,
      variance: 0.85, heightScale: 1.02, shieldEmblem: 'germanic-spiral',
      tunicColour: 0x55604a, legColour: 0x6a5943,
    },
    formations: ['loose', 'wedge', 'line'],
    abilities: ['charge', 'warcry'],
    description: 'Fast, unarmoured horsemen who exist to find an open flank and a fleeing enemy.',
  },
];

/**
 * Carthage — a citizen core and six bought contingents.
 *
 * **The heterogeneity is the faction, not decoration on it.** Polybius says the Punic army
 * had no common language, and Livy lists the contingents by name because their differences
 * were the interesting thing about the army. Carthage was a mercantile oligarchy that would
 * far rather spend money than citizens: at Cannae the only Carthaginians in Hannibal's line
 * of battle were the officers. So this roster is deliberately *not* a legion in purple. Six
 * of the eight entries below have a `culture` other than `punic`, and that one field drives
 * hair, beard, trousers, boots, dye lot, metal and shield-painting style through `kit.ts` —
 * so an Iberian, a Gaul, a Numidian and a Libyan standing in the same battle line are four
 * visibly different armies that happen to be paid by the same treasury.
 *
 * **Dating.** The core is the Second Punic War, 218-202 BC, which is the army everyone means
 * by "Carthaginian". The Sacred Band is the one anachronism and it is a deliberate one: the
 * citizen phalanx was cut to pieces at the Krimisos in 341 and does not appear after the
 * Mercenary War, so a strict 218 roster would have no Carthaginian infantry in it at all.
 * Rome II makes the same choice, and a faction whose own citizens never appear on its own
 * battle line is worse history than a fifty-year stretch.
 *
 * **This is not the army that defends the Carthage map, and it must not be edited to become
 * one.** The map is spring 146 BC (`docs/CARTHAGE.md` §1) and there is no overlap worth
 * pretending about: the 201 treaty forbade Carthage war elephants, the city surrendered its
 * arms wholesale in 149, and what held the triple wall for the next three years was a
 * citizen levy, freed slaves, engines re-made out of temple timber and nine hundred Roman
 * deserters. That order of battle is in `siegeUnits.ts` under `punic-*`, where the rest of
 * the siege rosters live. §1 asks for exactly this split — state the map's year, state the
 * roster's, and let a player who wants elephants at Carthage field this army in a *field*
 * battle and make the anachronism deliberately. **Do not renumber the roster to suit the map,
 * and do not renumber the map to suit the roster.**
 *
 * **Stat scale is the one already established** — see the note at the top of this file.
 * Damage and rates here were set against `tools/matchup.mjs` and not by eye: the target is a
 * two-to-four-minute grind for a matched pair of line units and about a minute for a
 * favourable matchup. `discipline` stays inside the narrow band the Roman/Germanic pass
 * settled on (0.98-1.2 for line troops), because a wide spread is what previously made one
 * side unable to ever win a morale contest.
 */
export const CARTHAGINIAN_UNITS: UnitTypeDef[] = [
  {
    id: 'libyan-spearmen',
    name: 'Libyan Heavy Spearmen',
    nativeName: 'Libues Hoplitai',
    faction: Faction.Carthage,
    unitClass: 'spear-infantry',
    strength: 160,
    // The dependable middle of the army: better armoured than a Juthungi spear block because
    // the kit is Roman, worse in the attack than a legionary cohort because a long spear in
    // a deep block is a defensive instrument. Sits deliberately between `urban-cohort`
    // (30/11/40) and `legio-cohort` (40/13/52) — see the matchup table in the report.
    meleeAttack: 34, meleeDamage: 12, apDamage: 3, meleeDefence: 38,
    armour: 46, shieldDefence: 32, chargeBonus: 10, bonusVsCavalry: 40,
    attackRate: 0.54, reach: 2.5,
    walkSpeed: 1.52, runSpeed: 3.4, chargeSpeed: 4.0, mass: 92, stamina: 58,
    morale: 64, discipline: 1.14,
    appearance: {
      // Livy, xxii.46: after Trasimene Hannibal re-equipped the African foot out of captured
      // Roman arms, and at Cannae they were "Romans in everything but the shield". That is
      // why this unit wears mail, a Montefortino and an oval shield and still reads Punic —
      // the tunic, the beard and the bare legs are the tell, not the armour.
      weapon: 'spear', sidearm: 'gladius', shield: 'oval', armour: 'hamata',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.4, heightScale: 1.0, shieldEmblem: 'punic-horse',
      tunicColour: 0xb9ac8e, legColour: 0xa89a7c,
      culture: 'libyan',
    },
    formations: ['line', 'shieldwall', 'wedge', 'loose'],
    abilities: ['brace'],
    description: 'African veterans in armour stripped from the Roman dead. The one part of the host that will stand all day.',
  },
  {
    id: 'sacred-band',
    name: 'Sacred Band',
    nativeName: 'Hieros Lochos',
    faction: Faction.Carthage,
    unitClass: 'spear-infantry',
    strength: 120,
    // Elite, and elite differently from the Praetorians: the aspis is the largest shield on
    // the field, so their defence is in the shield (40, above the Praetorians' 38) where a
    // Praetorian's is in his scale (60 armour against this linen corslet's 44). Two elite
    // units with the same total defence distributed to opposite sides of the same sum, which
    // means missiles and armour-piercing blows tell against them very differently.
    meleeAttack: 46, meleeDamage: 14, apDamage: 4, meleeDefence: 46,
    armour: 44, shieldDefence: 40, chargeBonus: 14, bonusVsCavalry: 42,
    attackRate: 0.56, reach: 2.7,
    walkSpeed: 1.46, runSpeed: 3.2, chargeSpeed: 3.9, mass: 100, stamina: 70,
    morale: 84, discipline: 1.3,
    appearance: {
      weapon: 'spear', sidearm: 'gladius', shield: 'hoplon', armour: 'linothorax',
      helmet: 'attic', crest: 'longitudinal', cloak: true, bareChested: false,
      variance: 0.2, heightScale: 1.02, shieldEmblem: 'punic-tanit',
      // Tyrian purple on the men whose city made it. Murex dye cost more than its weight in
      // silver and only the citizen body would have been wearing it on a battlefield.
      tunicColour: 0x6b3a86, legColour: 0xc9bda0,
      culture: 'punic',
    },
    formations: ['line', 'shieldwall', 'wedge'],
    abilities: ['brace', 'inspire'],
    description: 'The citizen phalanx of Carthage, drawn from the great houses. Bronze, linen and purple, and the only men in the host fighting for a home.',
  },
  {
    id: 'iberian-scutarii',
    name: 'Iberian Scutarii',
    nativeName: 'Scutati Hispani',
    faction: Faction.Carthage,
    unitClass: 'heavy-infantry',
    strength: 150,
    // The falcata is the point of this unit: heavy in the last third of the blade, so a high
    // damage and a fast rate but poor defence, because a man swinging a cleaver two-handed
    // is not behind his shield. Against a legionary cohort it wins the exchange and loses
    // the grind, which is what a Roman line was for.
    meleeAttack: 42, meleeDamage: 14, apDamage: 4, meleeDefence: 34,
    armour: 30, shieldDefence: 30, chargeBonus: 26, bonusVsCavalry: 8,
    attackRate: 0.64, reach: 1.1,
    // The soliferrum: a javelin forged in one piece out of iron, four feet of it, which went
    // through a shield and the arm behind it. Short-ranged and carried two at a time, so it
    // is the Iberian answer to the pilum and priced like one — heavy AP, almost no range.
    missile: { kind: 'javelin', range: 24, damage: 38, apDamage: 20, rate: 7, ammo: 2, accuracy: 0.11, arc: 'flat' },
    walkSpeed: 1.66, runSpeed: 3.9, chargeSpeed: 4.9, mass: 88, stamina: 68,
    morale: 66, discipline: 1.02,
    appearance: {
      weapon: 'falcata', sidearm: 'javelin', shield: 'oval', armour: 'leather',
      helmet: 'iberian-sinew', crest: 'none', cloak: false, bareChested: false,
      variance: 0.45, heightScale: 1.0, shieldEmblem: 'iberian-white',
      tunicColour: 0xc9c1ab, legColour: 0xb0a68c,
      culture: 'iberian',
    },
    formations: ['line', 'wedge', 'loose', 'shieldwall'],
    abilities: ['warcry'],
    description: 'Spanish swordsmen in white linen bordered with crimson. The falcata takes a limb off at a stroke; Livy says the wounds frightened the legions more than the losses.',
  },
  {
    id: 'iberian-caetrati',
    name: 'Iberian Caetrati',
    nativeName: 'Caetrati',
    faction: Faction.Carthage,
    unitClass: 'light-infantry',
    strength: 130,
    meleeAttack: 26, meleeDamage: 10, apDamage: 2, meleeDefence: 26,
    armour: 10, shieldDefence: 16, chargeBonus: 12, bonusVsCavalry: 2,
    attackRate: 0.62, reach: 1.0,
    missile: { kind: 'javelin', range: 32, damage: 28, apDamage: 12, rate: 10, ammo: 6, accuracy: 0.1, arc: 'flat' },
    walkSpeed: 1.92, runSpeed: 4.9, chargeSpeed: 5.4, mass: 68, stamina: 88,
    morale: 46, discipline: 0.86,
    appearance: {
      weapon: 'javelin', sidearm: 'falcata', shield: 'caetra', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.9, heightScale: 1.0, shieldEmblem: 'iberian-white',
      tunicColour: 0xc4bda6, legColour: 0x9d8f74,
      culture: 'iberian',
    },
    formations: ['skirmish', 'loose'],
    abilities: ['fire-at-will', 'skirmish-mode'],
    description: 'Hill men with a fistful of javelins and a buckler the size of a dinner plate. They fight the battle before the battle.',
  },
  {
    id: 'balearic-slingers',
    name: 'Balearic Slingers',
    nativeName: 'Funditores Baliares',
    faction: Faction.Carthage,
    unitClass: 'missile-infantry',
    strength: 100,
    meleeAttack: 14, meleeDamage: 6, apDamage: 1, meleeDefence: 18,
    armour: 4, shieldDefence: 0, chargeBonus: 2, bonusVsCavalry: 0,
    attackRate: 0.46, reach: 0.9,
    /**
     * The best missile troops in the ancient world, and priced as a genuine alternative to
     * the bow rather than a worse one.
     *
     * Longer ranged than the `sagittarii`'s 165 m — a trained slinger out-ranges a bow and
     * the sources say so plainly — but slower to loose (7 a minute against 9) and much less
     * total damage per shot. What makes it a real choice is where that damage goes: a lead
     * *glans* is blunt trauma, and mail is nearly useless against it, so 11 of the 17 is
     * armour-piercing where an arrow's is 4 of 20. Against unarmoured tribesmen the archers
     * are the better unit; against a legionary cohort in mail these are, by a wide margin.
     */
    /**
     * `apDamage` 18, up from 11, and only the armour-piercing half moves.
     *
     * Measured against a legionary cohort: 393 stones struck a man over 98 seconds and killed
     * four of a hundred and sixty. At 17/11 a stone does about 17 points to armour 52 out of a
     * hundred hit points, so it takes six hits on the *same* man, and the hits are spread over
     * the whole cohort. Two structural faults were fixed first and neither was enough on its
     * own: the stones could not physically reach 180 m at all, and the scutum was stopping 87%
     * of them outright.
     *
     * Raising `damage` would have made the unit stronger against everything. Raising only the
     * armour-piercing half sharpens exactly the matchup the weapon is famous for and leaves it
     * where it already was against unarmoured tribesmen, which is what the roster note below
     * claims for it and what Livy and Xenophon both describe: a weapon that beats the shielded,
     * armoured man other missiles bounce off.
     */
    missile: { kind: 'sling', range: 180, damage: 17, apDamage: 18, rate: 7, ammo: 22, accuracy: 0.055, arc: 'high' },
    walkSpeed: 1.7, runSpeed: 4.2, chargeSpeed: 4.4, mass: 64, stamina: 80,
    morale: 44, discipline: 0.9,
    appearance: {
      weapon: 'sling', sidearm: 'gladius', shield: 'none', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.95, heightScale: 0.98, shieldEmblem: 'none',
      tunicColour: 0xb4a98e, legColour: 0x8f8368,
      culture: 'punic',
    },
    formations: ['loose', 'skirmish', 'line'],
    abilities: ['fire-at-will'],
    description: 'Islanders who were given a sling before they were given bread. Three lengths of cord for three ranges, and a lead bullet that breaks bone through mail.',
  },
  {
    id: 'numidian-cavalry',
    name: 'Numidian Cavalry',
    nativeName: 'Equites Numidae',
    faction: Faction.Carthage,
    unitClass: 'light-cavalry',
    strength: 54,
    // The fastest thing in the game — faster than the Juthungi raiders at 8.2/10.2 — and the
    // flimsiest. No bridle, no saddle, no armour: this unit exists to find a flank, empty its
    // javelins into it and be gone, and it must lose badly to anything that catches it.
    meleeAttack: 32, meleeDamage: 11, apDamage: 2, meleeDefence: 24,
    armour: 6, shieldDefence: 12, chargeBonus: 26, bonusVsCavalry: 4,
    attackRate: 0.6, reach: 1.6,
    missile: { kind: 'javelin', range: 30, damage: 26, apDamage: 12, rate: 12, ammo: 6, accuracy: 0.12, arc: 'flat' },
    walkSpeed: 3.1, runSpeed: 8.8, chargeSpeed: 10.6, mass: 430, stamina: 86,
    morale: 52, discipline: 0.84,
    appearance: {
      weapon: 'javelin', sidearm: 'spear', shield: 'round', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.9, heightScale: 1.0, shieldEmblem: 'numidian-crescent',
      tunicColour: 0xc0b49a, legColour: 0xa2937a,
      culture: 'numidian',
    },
    formations: ['loose', 'skirmish', 'wedge'],
    abilities: ['fire-at-will', 'skirmish-mode', 'charge'],
    description: 'Riders who steer with a stick and their knees, on horses that have never worn a bit. They won Cannae by being where the legions were not.',
  },
  {
    id: 'gallic-mercenaries',
    name: 'Gallic Mercenaries',
    nativeName: 'Galli Mercennarii',
    faction: Faction.Carthage,
    unitClass: 'shock-infantry',
    strength: 160,
    // Almost the Juthungi Chosen's profile at a fraction of the discipline and morale, which
    // is exactly the unit Hannibal had: a first charge nothing in the Roman line could hold,
    // and no staying power at all. He put them in the centre at Cannae *because* he expected
    // them to give ground, which is the only time in ancient warfare a general planned a
    // battle around his own troops breaking.
    meleeAttack: 48, meleeDamage: 17, apDamage: 6, meleeDefence: 26,
    armour: 16, shieldDefence: 22, chargeBonus: 42, bonusVsCavalry: 4,
    attackRate: 0.72, reach: 1.2,
    walkSpeed: 1.8, runSpeed: 4.5, chargeSpeed: 5.6, mass: 90, stamina: 72,
    morale: 62, discipline: 0.88,
    appearance: {
      weapon: 'spatha', sidearm: 'javelin', shield: 'oval', armour: 'leather',
      helmet: 'spangenhelm', crest: 'none', cloak: true, bareChested: false,
      variance: 0.95, heightScale: 1.05, shieldEmblem: 'celtic-triskele',
      tunicColour: 0x8c3a2e, legColour: 0x5b4f3c,
      culture: 'celtic',
    },
    formations: ['wedge', 'horde', 'loose', 'line'],
    abilities: ['warcry', 'frenzy'],
    description: 'Boii and Insubres who came down out of the Po valley for Carthaginian silver and a chance at Rome. Their first charge is the heaviest blow the host can throw.',
  },
  {
    id: 'war-elephants',
    name: 'War Elephants',
    nativeName: 'Elephanti Africani',
    faction: Faction.Carthage,
    unitClass: 'heavy-cavalry',
    /**
     * Eight animals, not eight men.
     *
     * One entry in the soldier pool is one whole elephant — the beast, its mahout and the
     * three men in the tower — for the same reason a cavalryman is one entry and not a man
     * plus a horse: the thing the simulation needs to push, damage and kill is the animal.
     * `unitSizeScale` still multiplies this, so the shipped `ultra` battle fields sixteen,
     * which is what a Punic elephant line looked like.
     */
    strength: 8,
    /**
     * Terrifying in the charge and ruinous to unsupported infantry, which is two different
     * numbers.
     *
     * `chargeBonus` 90 is by far the highest in the game — the next is a legionary charge at
     * 14 and the Juthungi Chosen at 44 — because everything an elephant is worth happens in
     * the first six seconds. `apDamage` 20 of 30 is the other half: a four-tonne animal
     * treading on a man is not meaningfully resisted by mail, so armour is close to
     * irrelevant against it, and that is precisely why a Roman line could not simply stand.
     *
     * The counterweight is `bonusVsCavalry` 20 on top of every spear unit's 36-44 already
     * applying to it, a slow `attackRate`, and the discipline below.
     */
    meleeAttack: 44, meleeDamage: 30, apDamage: 20, meleeDefence: 30,
    armour: 50, shieldDefence: 0, chargeBonus: 90, bonusVsCavalry: 20,
    attackRate: 0.5, reach: 2.6,
    // The tower crew's javelins. Short-ranged and not many, because the tower is a fighting
    // platform rather than an artillery piece; it exists so the animal is not helpless while
    // it closes.
    missile: { kind: 'javelin', range: 34, damage: 30, apDamage: 14, rate: 8, ammo: 8, accuracy: 0.13, arc: 'flat' },
    // A charging elephant tops out near 25 km/h and cannot jump, so 6.2 m/s is both accurate
    // and a real tactical difference: it is markedly slower than the 9.6-10.6 m/s of horse,
    // so a general has time to see it coming and a screen has time to get out of the way.
    walkSpeed: 1.5, runSpeed: 4.6, chargeSpeed: 6.2, mass: 4200, stamina: 44,
    /**
     * **The famous drawback, and it is a mechanic rather than flavour text.**
     *
     * 0.55 is the lowest discipline in the game bar the naked fanatics' 0.62, and discipline
     * divides all incoming morale pressure — so an elephant unit takes nearly twice the
     * morale damage a legionary cohort does from the same event and breaks early and easily.
     * What makes that *dangerous to its own side* rather than merely disappointing is
     * `mass`: at 4,200 kg against a man's 90, `BattleSystem.resolveCrowding` splits every
     * separation by inverse mass and does not care whose side anyone is on. A routing
     * elephant turning about therefore ploughs straight back through the Punic line, shoving
     * men aside 47:1, and nothing had to be written into the combat code to make it happen.
     * See the report for the measurement.
     */
    morale: 50, discipline: 0.55,
    /**
     * **This block dresses the crew, not the animal.**
     *
     * The elephant's own geometry is `elephantMesh.ts` and takes none of it; the four men on
     * its back — a mahout on the neck and three in the tower — are the only things that read
     * `appearance` here, and `UnitRenderSystem.pushElephantCrew` resolves their kit from it.
     * So it is tuned entirely for how they look three metres up and silhouetted against the
     * sky, which is the least forgiving place on the field to put a man.
     *
     * A javelin bundle in hand because that is what the tower's `missile` throws and what
     * `r2-08` shows; Attic helmets and cloaks because with `helmet: 'none'` they rendered as
     * bare-armed men in sleeveless tunics and read as prisoners rather than as crew.
     */
    appearance: {
      weapon: 'javelin', sidearm: 'gladius', shield: 'none', armour: 'leather',
      helmet: 'attic', crest: 'none', cloak: true, bareChested: false,
      variance: 0.55, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0xb8a882, legColour: 0xa2947a,
      mount: 'elephant',
      culture: 'punic',
    },
    /**
     * Loose and skirmish only, and that is a spacing constraint rather than a doctrine.
     *
     * `BattleSystem.baseSpacing*` gives every cavalry unit 1.95 m laterally and 3.1 m
     * front-to-back. An elephant is about 2.0 m across and 4.5 m long with its tower, so a
     * `line` at 1.0x would have them literally inside one another and a `wedge` at 0.6x/0.62x
     * would be worse. `loose` at 1.95x/1.8x gives 3.80 m and 5.58 m, which leaves 1.8 m
     * between flanks and 1.1 m between the tail of one and the tusks of the next. Offering a
     * player a formation that renders as overlapping animals would be offering a bug.
     */
    formations: ['loose', 'skirmish'],
    abilities: ['charge', 'warcry'],
    description: 'North African forest elephants in bronze head-armour, with a crenellated tower and four men on the back of each. Nothing in a battle line stands in front of them, and nothing behind them is safe once they turn.',
  },
];

// Siege engines live in their own module purely as an ownership seam — see siegeUnits.ts.
export const ALL_UNITS: UnitTypeDef[] = [
  ...ROMAN_UNITS, ...GERMANIC_UNITS, ...CARTHAGINIAN_UNITS, ...SIEGE_UNITS,
];

const BY_ID = new Map<string, UnitTypeDef>(ALL_UNITS.map((u) => [u.id, u]));

export const unitType = (id: string): UnitTypeDef => {
  const u = BY_ID.get(id);
  if (!u) throw new Error(`[roster] unknown unit type "${id}"`);
  return u;
};

export const unitsOf = (faction: Faction): UnitTypeDef[] =>
  ALL_UNITS.filter((u) => u.faction === faction);

export const isCavalry = (u: UnitTypeDef): boolean =>
  u.unitClass === 'heavy-cavalry' || u.unitClass === 'light-cavalry';
