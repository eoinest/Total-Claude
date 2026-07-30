import { Faction, type UnitTypeDef } from '../sim/types';

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
 * damage is hit points per blow; armour subtracts flat damage; morale is 0-100.
 */

export const ROMAN_UNITS: UnitTypeDef[] = [
  {
    id: 'legio-cohort',
    name: 'Legionary Cohort',
    nativeName: 'Cohors Legionaria',
    faction: Faction.Rome,
    unitClass: 'heavy-infantry',
    strength: 160,
    meleeAttack: 42, meleeDamage: 26, apDamage: 6, meleeDefence: 40,
    armour: 58, shieldDefence: 34, chargeBonus: 12, bonusVsCavalry: 4,
    attackRate: 0.82, reach: 1.1,
    missile: { kind: 'pilum', range: 26, damage: 44, apDamage: 22, rate: 6, ammo: 2, accuracy: 0.09, arc: 'flat' },
    walkSpeed: 1.55, runSpeed: 3.5, chargeSpeed: 4.3, mass: 96, stamina: 62,
    morale: 72, discipline: 1.42,
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
    meleeAttack: 58, meleeDamage: 31, apDamage: 9, meleeDefence: 52,
    armour: 68, shieldDefence: 38, chargeBonus: 16, bonusVsCavalry: 5,
    attackRate: 0.9, reach: 1.1,
    missile: { kind: 'pilum', range: 27, damage: 46, apDamage: 24, rate: 6, ammo: 2, accuracy: 0.08, arc: 'flat' },
    walkSpeed: 1.5, runSpeed: 3.4, chargeSpeed: 4.2, mass: 104, stamina: 74,
    morale: 90, discipline: 1.7,
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
    meleeAttack: 30, meleeDamage: 22, apDamage: 4, meleeDefence: 36,
    armour: 40, shieldDefence: 30, chargeBonus: 6, bonusVsCavalry: 22,
    attackRate: 0.7, reach: 2.4,
    walkSpeed: 1.5, runSpeed: 3.3, chargeSpeed: 3.9, mass: 88, stamina: 50,
    morale: 58, discipline: 1.15,
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
    meleeAttack: 16, meleeDamage: 14, apDamage: 2, meleeDefence: 20,
    armour: 18, shieldDefence: 0, chargeBonus: 2, bonusVsCavalry: 0,
    attackRate: 0.62, reach: 0.9,
    missile: { kind: 'bow', range: 165, damage: 20, apDamage: 4, rate: 9, ammo: 26, accuracy: 0.05, arc: 'high' },
    walkSpeed: 1.65, runSpeed: 3.9, chargeSpeed: 4.1, mass: 72, stamina: 66,
    morale: 48, discipline: 1.1,
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
    meleeAttack: 46, meleeDamage: 30, apDamage: 8, meleeDefence: 38,
    armour: 52, shieldDefence: 26, chargeBonus: 44, bonusVsCavalry: 8,
    attackRate: 0.78, reach: 2.1,
    walkSpeed: 2.6, runSpeed: 7.4, chargeSpeed: 9.6, mass: 520, stamina: 58,
    morale: 70, discipline: 1.3,
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
    strength: 24,
    meleeAttack: 14, meleeDamage: 12, apDamage: 2, meleeDefence: 16,
    armour: 22, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    missile: { kind: 'bolt', range: 320, damage: 90, apDamage: 70, rate: 3, ammo: 40, accuracy: 0.014, arc: 'flat' },
    walkSpeed: 0.9, runSpeed: 1.5, chargeSpeed: 1.5, mass: 240, stamina: 40,
    morale: 45, discipline: 1.2,
    appearance: {
      weapon: 'bow', sidearm: 'gladius', shield: 'none', armour: 'leather',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.4, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0xb9a684, legColour: 0x8e8266,
    },
    formations: ['line'],
    abilities: ['fire-at-will'],
    description: 'Bolt-throwers on the wall. A single shot punches through a shield, the man behind it, and the man behind him.',
  },
];

export const GERMANIC_UNITS: UnitTypeDef[] = [
  {
    id: 'juthungi-warband',
    name: 'Tribal Warband',
    nativeName: 'Juthungi Harjis',
    faction: Faction.Germanic,
    unitClass: 'light-infantry',
    strength: 180,
    meleeAttack: 38, meleeDamage: 27, apDamage: 5, meleeDefence: 24,
    armour: 20, shieldDefence: 22, chargeBonus: 26, bonusVsCavalry: 2,
    attackRate: 0.95, reach: 1.0,
    missile: { kind: 'framea', range: 22, damage: 34, apDamage: 12, rate: 7, ammo: 2, accuracy: 0.13, arc: 'flat' },
    walkSpeed: 1.72, runSpeed: 4.2, chargeSpeed: 5.3, mass: 84, stamina: 70,
    morale: 62, discipline: 0.82,
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
    meleeAttack: 32, meleeDamage: 23, apDamage: 4, meleeDefence: 32,
    armour: 22, shieldDefence: 28, chargeBonus: 14, bonusVsCavalry: 30,
    attackRate: 0.72, reach: 2.6,
    walkSpeed: 1.62, runSpeed: 3.8, chargeSpeed: 4.6, mass: 86, stamina: 64,
    morale: 60, discipline: 0.95,
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
    meleeAttack: 56, meleeDamage: 38, apDamage: 16, meleeDefence: 38,
    armour: 38, shieldDefence: 24, chargeBonus: 40, bonusVsCavalry: 6,
    attackRate: 1.0, reach: 1.3,
    walkSpeed: 1.78, runSpeed: 4.4, chargeSpeed: 5.7, mass: 98, stamina: 80,
    morale: 84, discipline: 1.05,
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
    meleeAttack: 62, meleeDamage: 42, apDamage: 20, meleeDefence: 14,
    armour: 4, shieldDefence: 0, chargeBonus: 52, bonusVsCavalry: 0,
    attackRate: 1.28, reach: 1.2,
    walkSpeed: 1.95, runSpeed: 5.0, chargeSpeed: 6.4, mass: 78, stamina: 92,
    morale: 96, discipline: 0.45,
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
    meleeAttack: 20, meleeDamage: 16, apDamage: 3, meleeDefence: 20,
    armour: 8, shieldDefence: 14, chargeBonus: 6, bonusVsCavalry: 0,
    attackRate: 0.8, reach: 1.0,
    missile: { kind: 'javelin', range: 34, damage: 30, apDamage: 14, rate: 11, ammo: 7, accuracy: 0.1, arc: 'flat' },
    walkSpeed: 1.9, runSpeed: 4.8, chargeSpeed: 5.2, mass: 68, stamina: 88,
    morale: 44, discipline: 0.7,
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
    meleeAttack: 38, meleeDamage: 26, apDamage: 6, meleeDefence: 26,
    armour: 20, shieldDefence: 18, chargeBonus: 36, bonusVsCavalry: 6,
    attackRate: 0.85, reach: 2.0,
    walkSpeed: 2.9, runSpeed: 8.2, chargeSpeed: 10.2, mass: 460, stamina: 72,
    morale: 56, discipline: 0.8,
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

export const ALL_UNITS: UnitTypeDef[] = [...ROMAN_UNITS, ...GERMANIC_UNITS];

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
