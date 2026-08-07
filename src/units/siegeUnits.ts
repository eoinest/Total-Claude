/**
 * Siege engines and their crews, kept out of `roster.ts` on purpose.
 *
 * This file exists as an ownership seam. The siege workstream and the artillery workstream
 * both need to add unit types, and two agents editing one 320-line array in parallel is how
 * you lose an afternoon to a merge. `roster.ts` owns the field army and the `scorpio` entry;
 * this owns everything that assaults or defends a wall. They are concatenated in `ALL_UNITS`
 * and share one id namespace, so ids must still be unique across both.
 *
 * Anything added here is visible to `unitType()`, `unitsOf()` and the pre-battle menu's
 * roster rows with no further wiring.
 *
 * ---
 *
 * ## What a siege unit is, mechanically
 *
 * Four shapes, and they behave very differently:
 *
 *  1. **Wall troops** (`ballistarii`, `wall-slingers`). Ordinary missile units whose only
 *     unusual property is that `Siege` places them along a wall-walk instead of in a
 *     formation. Short reach and little shield value, because a man shooting over a merlon
 *     is not in a shield wall. Their real advantage is that nothing on the ground can reach
 *     them at all, and `SAME_LEVEL_DY` in `BattleSystem` is what makes that true.
 *
 *  2. **Machine crews** (`onager`, `carroballista`). `unitClass: 'artillery'`, so
 *     `BattleSystem.spawnUnit` exempts them from the unit-size multiplier and the AI
 *     stations them and leaves them there. Strength is *engines times crew*, following the
 *     convention `scorpio` established.
 *
 *  3. **Assault parties** (`tower-assault`, `escalade-party`). Ordinary infantry with one
 *     job: get up a crossing and fight on the walkway. Smaller than a line unit because a
 *     tower deck holds about forty men, not a hundred and sixty.
 *
 *  4. **Ram crew** (`ram-crew`). Infantry escorting a machine that is itself the weapon.
 *     No missile at all — under the shed you have both hands on the trunk.
 *
 * Damage follows `roster.ts`'s calibration, where a matched pair grinds for two to four
 * minutes. Nothing here is tuned to win, and both assault types are deliberately *worse*
 * in a straight fight than the Roman troops they will meet on the walkway: the attacker's
 * advantage is meant to be numbers and initiative, not statistics.
 */

import { Faction, type UnitTypeDef } from '../sim/types';

export const SIEGE_UNITS: UnitTypeDef[] = [
  // -------------------------------------------------------------------------
  // Rome — the garrison
  // -------------------------------------------------------------------------
  {
    id: 'ballistarii',
    name: 'Wall Ballistarii',
    nativeName: 'Ballistarii Murales',
    faction: Faction.Rome,
    unitClass: 'missile-infantry',
    /**
     * Enough men to hold a bay and a half of curtain.
     *
     * A bay is 35.5 m between towers, of which about 28 m is clear of the tower footprint.
     * Men stand at 0.86 m centres in three staggered ranks, so a bay takes roughly 96 men.
     * 108 fills one bay and spills into the next, which is the frontage a garrison unit
     * should hold and keeps a wall looking manned rather than picketed.
     */
    strength: 108,
    meleeAttack: 26, meleeDamage: 9, apDamage: 2, meleeDefence: 30,
    armour: 40, shieldDefence: 12, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.62, reach: 1.0,
    // A hand-spanned *manuballista*: slower than a bow, far harder hitting, and the
    // late-Roman wall weapon of choice. The range is generous because it is being shot
    // downward off 6.5 m of masonry.
    missile: { kind: 'bolt', range: 155, damage: 62, apDamage: 40, rate: 5, ammo: 60, accuracy: 0.028, arc: 'flat' },
    walkSpeed: 1.4, runSpeed: 3.0, chargeSpeed: 3.4, mass: 88, stamina: 55,
    morale: 66, discipline: 1.18,
    appearance: {
      weapon: 'bolt', sidearm: 'spatha', shield: 'oval', armour: 'hamata',
      helmet: 'intercisa', crest: 'none', cloak: true, bareChested: false,
      variance: 0.4, heightScale: 1.0, shieldEmblem: 'legio-thunderbolt',
      tunicColour: 0x9d2b2b, legColour: 0x8f8064,
    },
    formations: ['line', 'loose'],
    abilities: [],
    description: 'Crossbowmen of the wall garrison. Shoot down from the parapet with hand-spanned ballistae that punch through any shield.',
  },
  {
    id: 'wall-slingers',
    name: 'Wall Slingers',
    nativeName: 'Funditores Murales',
    faction: Faction.Rome,
    unitClass: 'missile-infantry',
    strength: 90,
    meleeAttack: 20, meleeDamage: 7, apDamage: 1, meleeDefence: 24,
    armour: 16, shieldDefence: 6, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.7, reach: 0.9,
    // Height is everything to a sling: from the walk they out-range anything on the plain.
    missile: { kind: 'sling', range: 175, damage: 30, apDamage: 20, rate: 11, ammo: 90, accuracy: 0.052, arc: 'high' },
    walkSpeed: 1.7, runSpeed: 3.9, chargeSpeed: 4.2, mass: 74, stamina: 74,
    morale: 52, discipline: 0.98,
    appearance: {
      weapon: 'sling', shield: 'none', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.55, heightScale: 0.98, shieldEmblem: 'none',
      tunicColour: 0xb9a884, legColour: 0x7d6f56,
    },
    formations: ['loose', 'skirmish'],
    abilities: [],
    description: 'City levy with slings and a pouch of lead shot. Worth little on the field and a great deal on a parapet.',
  },
  {
    id: 'carroballista',
    name: 'Carroballista',
    nativeName: 'Carroballistae',
    faction: Faction.Rome,
    unitClass: 'artillery',
    /** Four cart-mounted bolt-throwers of three crew. See `scorpio` for the convention. */
    strength: 12,
    meleeAttack: 14, meleeDamage: 6, apDamage: 1, meleeDefence: 16,
    armour: 24, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    missile: { kind: 'bolt', range: 300, damage: 96, apDamage: 74, rate: 3.4, ammo: 44, accuracy: 0.013, arc: 'flat' },
    walkSpeed: 1.1, runSpeed: 1.7, chargeSpeed: 1.7, mass: 240, stamina: 40,
    morale: 42, discipline: 1.05,
    appearance: {
      weapon: 'bolt', sidearm: 'spatha', shield: 'none', armour: 'hamata',
      helmet: 'intercisa', crest: 'none', cloak: false, bareChested: false,
      variance: 0.3, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0x9d2b2b, legColour: 0x8f8064,
    },
    formations: ['line'],
    abilities: [],
    description: "Bolt-throwers on mule carts, sited behind the parapet. Trajan's Column shows them accompanying the legion into the field.",
  },

  // -------------------------------------------------------------------------
  // The Juthungi — the assault
  // -------------------------------------------------------------------------
  {
    id: 'tower-assault',
    name: 'Tower Assault Party',
    nativeName: 'Turmwart',
    faction: Faction.Germanic,
    unitClass: 'heavy-infantry',
    /**
     * A tower deck holds about forty men and the file crossing the ramp is single. 72 is
     * two decks' worth: enough that men are still coming up while the first are already
     * fighting, which is the whole texture of a boarding action.
     */
    strength: 72,
    meleeAttack: 44, meleeDamage: 14, apDamage: 5, meleeDefence: 34,
    armour: 38, shieldDefence: 26, chargeBonus: 18, bonusVsCavalry: 0,
    attackRate: 0.66, reach: 1.0,
    walkSpeed: 1.5, runSpeed: 3.4, chargeSpeed: 4.2, mass: 100, stamina: 70,
    // High morale: these are the men who volunteered to go first, and the ones who did not
    // are pushing the tower. Rome gave the *corona muralis* to the first man over the wall
    // for a reason.
    morale: 82, discipline: 1.1,
    appearance: {
      weapon: 'axe', sidearm: 'framea', shield: 'round', armour: 'hamata',
      helmet: 'spangenhelm', crest: 'horns', cloak: true, bareChested: false,
      variance: 0.5, heightScale: 1.04, shieldEmblem: 'juthungi-sun',
      tunicColour: 0x4b5a44, legColour: 0x6a5a41,
    },
    formations: ['line', 'wedge', 'horde'],
    abilities: [],
    description: 'Picked warriors who go up the tower first. Axes for the parapet fight, and a name worth dying for.',
  },
  {
    id: 'escalade-party',
    name: 'Ladder Party',
    nativeName: 'Leiterfolk',
    faction: Faction.Germanic,
    unitClass: 'light-infantry',
    strength: 96,
    meleeAttack: 34, meleeDamage: 11, apDamage: 3, meleeDefence: 24,
    armour: 18, shieldDefence: 16, chargeBonus: 12, bonusVsCavalry: 0,
    attackRate: 0.72, reach: 0.95,
    walkSpeed: 1.75, runSpeed: 4.1, chargeSpeed: 4.7, mass: 84, stamina: 82,
    // Well below the tower party: escalade is where an assault breaks, and they know it.
    morale: 56, discipline: 0.9,
    appearance: {
      weapon: 'axe', shield: 'round', armour: 'leather',
      helmet: 'fur-cap', crest: 'none', cloak: false, bareChested: false,
      variance: 0.62, heightScale: 1.02, shieldEmblem: 'juthungi-wolf',
      tunicColour: 0x5d5238, legColour: 0x6a5a41,
    },
    formations: ['loose', 'horde', 'skirmish'],
    abilities: [],
    description: 'Light warriors carrying the ladders. Fast, barely armoured, and horribly exposed on the rungs.',
  },
  {
    id: 'ram-crew',
    name: 'Ram Crew',
    nativeName: 'Widderfolk',
    faction: Faction.Germanic,
    unitClass: 'heavy-infantry',
    /** Sixteen on the trunk under the shed, sixteen pushing behind it. */
    strength: 32,
    meleeAttack: 30, meleeDamage: 12, apDamage: 4, meleeDefence: 26,
    armour: 30, shieldDefence: 10, chargeBonus: 4, bonusVsCavalry: 0,
    attackRate: 0.6, reach: 1.0,
    // No missile: under the shed you have both hands on the trunk and a roof over you.
    walkSpeed: 1.1, runSpeed: 2.0, chargeSpeed: 2.2, mass: 104, stamina: 90,
    morale: 62, discipline: 1.0,
    appearance: {
      weapon: 'axe', shield: 'none', armour: 'leather',
      helmet: 'spangenhelm', crest: 'none', cloak: false, bareChested: false,
      variance: 0.55, heightScale: 1.05, shieldEmblem: 'none',
      tunicColour: 0x4b4436, legColour: 0x6a5a41,
    },
    formations: ['line', 'loose'],
    abilities: [],
    description: 'The gang on the trunk. Roofed in green hide against the fire dropped on them from the gatehouse.',
  },
  {
    id: 'onager',
    name: 'Onager Battery',
    nativeName: 'Onagri',
    faction: Faction.Germanic,
    unitClass: 'artillery',
    /**
     * Three machines of four crew. Ammianus XXIII.4 gives the *onager* eight men to wind
     * and one to lay; four is the visible working party and keeps the battery to a
     * sensible number of instanced machines.
     *
     * That the Juthungi have artillery at all is a liberty. The defensible version is that
     * these are captured Roman engines with Roman deserters laying them, which is how a
     * third-century barbarian army got artillery when it had any — and it is why the unit
     * is expensive in crew and very short of ammunition.
     *
     * **The machine's geometry is a placeholder.** A parallel workstream owns artillery
     * models in `src/units/engines.ts`; the unit definition here is what the siege systems
     * need to exist and shoot, and the mesh should be replaced by theirs.
     */
    strength: 12,
    meleeAttack: 12, meleeDamage: 6, apDamage: 1, meleeDefence: 14,
    armour: 12, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    // A one-talent stone: enormous damage, armour-piercing because there is no armour
    // against a 26 kg rock, two shots a minute, twenty stones per machine.
    missile: { kind: 'boulder', range: 220, damage: 150, apDamage: 120, rate: 1.6, ammo: 20, accuracy: 0.045, arc: 'high' },
    /**
     * An onager does not walk, run or charge. All three are zero.
     *
     * A one-talent stone-thrower is a timber frame with a torsion bundle in it, sited by
     * gangs with levers and rollers over hours, and it does not move again until the siege
     * is over. The previous 0.7 / 1.1 / 1.1 let a battery drift across the field at a
     * shambling walk and — worse — let it *charge*, which is a stone-thrower running at
     * infantry.
     *
     * Checked rather than assumed, because a zero speed is exactly the sort of value that
     * divides by itself somewhere. Both steering paths in `BattleSystem` compute
     * `k = 1 - exp(-(accel / Math.max(0.2, maxSpeed)) * dt)` with `accel = maxSpeed * 5.5`,
     * so at zero the guard makes `k` exactly 0: velocity is never updated, the machine sits
     * still, and no NaN reaches the pool. `steerToSlots` takes the same shape.
     *
     * The remaining hazard is the one this workstream already hit with the ram, and it is
     * reported rather than papered over here: **a siege instrument that routs cannot flee.**
     * `BattleSystem` retires a broken unit once `routTimer > 18` *and* it is either at the
     * map edge or 260 m from the nearest enemy, and a machine with zero speed can never
     * satisfy either, so it is ground on for ever by an enemy that can never finish it. The
     * ram's answer was to hand the crew back to the ordinary rout path and leave the machine
     * standing; artillery needs the equivalent, and the exact patch is in this workstream's
     * report because the rule lives in `BattleSystem`, not here.
     */
    walkSpeed: 0, runSpeed: 0, chargeSpeed: 0, mass: 300, stamina: 40,
    morale: 44, discipline: 0.92,
    appearance: {
      weapon: 'boulder', sidearm: 'axe', shield: 'none', armour: 'leather',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.5, heightScale: 1.02, shieldEmblem: 'none',
      tunicColour: 0x5d5238, legColour: 0x6a5a41,
    },
    formations: ['line'],
    abilities: [],
    description: 'Captured Roman stone-throwers. Two shots a minute, and a one-talent stone that takes a merlon and the man behind it together.',
  },
];
