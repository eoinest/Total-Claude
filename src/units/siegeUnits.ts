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
 *
 * ---
 *
 * ## Two sieges, four orders of battle
 *
 * This file held one siege: Rome garrisons, the Juthungi storm. When Carthage landed as a
 * second besiegeable city, `deployAssault` followed `CityPlan.garrison` correctly and then
 * had nothing Punic to put on the parapet, so **storming Carthage put Roman auxiliaries on
 * Carthage's wall being attacked by Juthungi tribesmen.** The gap was here, not there.
 *
 * There are now four:
 *
 * | map | garrison | storm |
 * |---|---|---|
 * | Campus Martius, 271 AD | Rome — `ballistarii`, `wall-slingers`, `carroballista` | the Juthungi — `tower-assault`, `escalade-party`, `ram-crew`, `onager` |
 * | Carthage, 146 BC | Carthage — `punic-levy`, `punic-freedmen`, `punic-catapults`, `punic-deserters` | Rome — `legio-tower-party`, `legio-escalade`, `legio-ram-crew`, `legio-ballista`, `carroballista` |
 *
 * `battleConfig.ts` holds which id fills which tactical slot (`GARRISON_PLANS`,
 * `STORM_PLANS`); `scenario.ts` reads the plan rather than a list of unit ids, so it never
 * learns a city's name. **Rome is the only faction with both**, which is why those tables are
 * keyed by faction *and* role: a faction is not a side.
 *
 * **No new geometry.** Every entry below is a kit mask over meshes that already exist — the
 * two Punic machines resolve through `engineKindOf`'s `missile.arc` test to the scorpio and
 * onager already built for Rome and the Juthungi, and every man wears a helmet, shield,
 * armour and weapon already in the `HelmetKind` / `ShieldKind` / `ArmourKind` / `WeaponKind`
 * unions. Draw calls are per faction and LOD, not per unit type, so this table costs none.
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

  // -------------------------------------------------------------------------
  // Carthage — the garrison of 146 BC
  //
  // **Read `docs/CARTHAGE.md` §1 before changing anything here, and do not import the
  // Second Punic War.** `roster.ts`'s Carthaginian army is dated 218-202 BC by its own
  // header: Libyan veterans in captured mail, Iberian falcata-men, Balearic slingers,
  // Numidian horse and sixteen elephants. None of that is on this wall, and the reasons are
  // documented rather than aesthetic:
  //
  //  - **The 201 BC treaty forbade Carthage to train war elephants**, and there is therefore
  //    no moment in the Third Punic War with Carthaginian war elephants. The elephant stalls
  //    in the lower casemate are fourth- or third-century architecture standing empty
  //    (§4.4) — a wall built for an empire, held by a city that no longer has one.
  //  - **In 149 the city surrendered its arms**: Appian gives 200,000 panoplies and 2,000
  //    catapults handed to Censorinus, after which Rome told them to abandon the site.
  //  - What held the wall for the next three years was **the citizen body, the freed slaves
  //    and weapons re-forged from scratch**. Appian: a hundred shields, three hundred
  //    swords, five hundred spears and javelins and a thousand catapult bolts a day, public
  //    buildings broken up for timber, and the women cutting off their hair for the torsion
  //    skeins because there was no more sinew in the city.
  //
  // So this is not a Hellenistic field force in Punic colours and it must not read like one.
  // It is a levy with a spear, freedmen with a sling, home-made engines — and the one hard
  // unit on the wall is Roman.
  //
  // The map states its year and the field roster states its own; a player who wants
  // elephants at Carthage may field the 218 army in a field battle and make the anachronism
  // deliberately. §1 asks for exactly that and asks us not to renumber either to suit the
  // other.
  // -------------------------------------------------------------------------
  {
    id: 'punic-levy',
    name: 'Citizen Levy',
    nativeName: 'Bne Qart-Hadasht',
    faction: Faction.Carthage,
    unitClass: 'spear-infantry',
    /**
     * A bay of the Punic wall, and why this is larger than a Roman garrison unit.
     *
     * `carthageWall.ts` cuts garrison bays at half the 59.2 m tower interval, so a bay is
     * 29.6 m — close to Rome's 35.5 m. What differs is the walk: Appian's 30-ft thickness
     * leaves a **7.1 m clear band** against Rome's widened 2.21-4.06 m, so `layOutGarrison`
     * reaches its `MAX_WALL_RANKS` of 5 rather than three or four. 29.6 m at 0.86 m centres
     * is 34 stations a rank, five ranks is 170, and 150 fills a bay without pushing men into
     * the run the next unit wants.
     *
     * That is the wall doing what §4.3 says it does: the Carthaginian wall-walk is a street,
     * and a garrison unit on it is a formation rather than a picket line.
     */
    strength: 150,
    /**
     * Deliberately just under `urban-cohort` (30/11/2/36, armour 40), which is this game's
     * existing second-line spear block, and the gap is all in the armour.
     *
     * A citizen called up in 149 has a re-forged spearhead, a hide-faced shield and whatever
     * his household owned. He is not worse at holding a line than a Roman garrison
     * spearman — a spear in a deep block is a spear in a deep block — he is worse protected,
     * so 26 against 40. `shieldDefence` stays high because a shield is the one thing a city
     * making a hundred a day was certain to have.
     */
    meleeAttack: 30, meleeDamage: 11, apDamage: 2, meleeDefence: 36,
    armour: 26, shieldDefence: 30, chargeBonus: 6, bonusVsCavalry: 34,
    attackRate: 0.5, reach: 2.4,
    /**
     * Five hundred spears and javelins a day, and they are thrown *down*.
     *
     * 30 m is short enough that this unit contributes nothing while the towers are still
     * crossing the open ground and everything once they are in the ditch, which is the
     * correct shape for the weapon and gives the two wall types genuinely different jobs:
     * the freedmen's slings answer the approach, the levy answers the escalade.
     */
    missile: { kind: 'javelin', range: 30, damage: 30, apDamage: 14, rate: 6, ammo: 5, accuracy: 0.12, arc: 'flat' },
    walkSpeed: 1.5, runSpeed: 3.2, chargeSpeed: 3.7, mass: 86, stamina: 48,
    /**
     * 60/1.0 — decent morale, no drill.
     *
     * Higher base morale than the `urban-cohort`'s 55 and lower discipline than its 1.05,
     * which is the honest reading of a militia standing on its own city's wall with the sea
     * behind it: they will not run early, and once they do go they go all at once. Inside
     * the 0.98-1.2 band the Roman/Germanic calibration pass settled on for line troops.
     */
    morale: 60, discipline: 1.0,
    appearance: {
      // No helmet and leather rather than mail: the panoplies went to Censorinus in 149 and
      // what the city could make again in a year was blades and boards, not armour.
      weapon: 'spear', sidearm: 'javelin', shield: 'oval', armour: 'leather',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      // The highest variance of any formed unit in the game, and it is the unit's whole
      // point: a levy has no issue kit, so no two men were dressed by the same hand.
      variance: 0.9, heightScale: 1.0, shieldEmblem: 'punic-palm',
      tunicColour: 0xb0a181, legColour: 0x9a8b6d,
      culture: 'punic',
    },
    formations: ['line', 'shieldwall', 'loose'],
    abilities: ['brace'],
    description: 'Every man in Carthage who could hold a spear, on the wall his city rebuilt its weapons behind. Re-forged points, hide-faced boards, and no armour worth the name.',
  },
  {
    id: 'punic-freedmen',
    name: 'Freedmen Slingers',
    nativeName: 'Funditores Liberti',
    faction: Faction.Carthage,
    unitClass: 'missile-infantry',
    strength: 110,
    meleeAttack: 18, meleeDamage: 7, apDamage: 1, meleeDefence: 22,
    armour: 6, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.62, reach: 0.9,
    /**
     * A sling, and the sling is the point: it is the one missile weapon a man freed this
     * morning can be handed and be useful with by evening, because the ammunition is the
     * beach.
     *
     * Priced *below* both of the game's trained slingers on every axis that training buys.
     * The `balearic-slingers` are 180 m at 0.055 rad and Rome's `wall-slingers` 175 m at
     * 0.052; these are 168 m at 0.075, which is a 40% wider cone. Total damage 38 sits
     * between the Balearics' 35 and the Roman city levy's 50, and the *armour-piercing*
     * share is 14 of 38 against the Balearics' 18 of 35 — because what makes a lead glans
     * beat mail is the man's ability to put it on the same plate twice, and that is the part
     * that takes a lifetime.
     */
    missile: { kind: 'sling', range: 168, damage: 24, apDamage: 14, rate: 9, ammo: 80, accuracy: 0.075, arc: 'high' },
    walkSpeed: 1.72, runSpeed: 4.0, chargeSpeed: 4.2, mass: 70, stamina: 76,
    // The lowest discipline on the wall. Freedom granted on the condition that you stand on
    // a parapet is a thin thing to hold a man with, and Appian has the slaves enrolled only
    // when there was nobody else left.
    morale: 44, discipline: 0.85,
    appearance: {
      weapon: 'sling', sidearm: 'club', shield: 'none', armour: 'cloth',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 1.0, heightScale: 0.98, shieldEmblem: 'none',
      tunicColour: 0x9d8d6f, legColour: 0x84765c,
      culture: 'punic',
    },
    formations: ['loose', 'skirmish', 'line'],
    abilities: ['fire-at-will'],
    description: 'Slaves freed to hold the wall, with a cord and a pouch of beach stones. The city could arm them in an afternoon and could not train them at all.',
  },
  {
    id: 'punic-catapults',
    name: 'Wall Catapults',
    nativeName: 'Catapultae Crinales',
    faction: Faction.Carthage,
    unitClass: 'artillery',
    /** Four engines of three crew, following the convention `scorpio` established. */
    strength: 12,
    meleeAttack: 12, meleeDamage: 5, apDamage: 1, meleeDefence: 14,
    armour: 14, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    /**
     * The engines Carthage built after it had given its engines away, and they are worse
     * than a legion's in every direction at once.
     *
     * `carroballista` is 300 m at 0.013 rad, 3.4 shots a minute; `scorpio` 320 m at 0.014.
     * These are 240 m at 0.022 and 2.6 a minute — a machine framed out of temple roof timber
     * in a courtyard, strung with hair because the city had no more sinew, and laid by men
     * who were shipwrights last year. Still lethal: a bolt is a bolt.
     *
     * `arc: 'flat'` is not decoration. `engineKindOf` reads exactly that field, so this
     * renders as the scorpio already built for Rome and needs no geometry of its own.
     */
    missile: { kind: 'bolt', range: 240, damage: 78, apDamage: 58, rate: 2.6, ammo: 34, accuracy: 0.022, arc: 'flat' },
    // Trestle-mounted and shifted along the walk by their own crew, so they take the
    // `carroballista`'s speeds rather than the `onager`'s zeroes — which also keeps them
    // clear of the standing hazard recorded on that entry, where a machine that cannot move
    // can never satisfy the rout-retirement test.
    walkSpeed: 1.0, runSpeed: 1.6, chargeSpeed: 1.6, mass: 220, stamina: 40,
    morale: 40, discipline: 0.95,
    appearance: {
      weapon: 'bolt', sidearm: 'gladius', shield: 'none', armour: 'leather',
      helmet: 'none', crest: 'none', cloak: false, bareChested: false,
      variance: 0.8, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0xa89574, legColour: 0x8d7f63,
      culture: 'punic',
    },
    formations: ['line'],
    abilities: ['fire-at-will'],
    description: 'Bolt-shooters framed out of temple timber and strung with the hair the women of Carthage cut off, because the city had given Rome its catapults and had no sinew left.',
  },
  {
    id: 'punic-deserters',
    name: 'Roman Deserters',
    nativeName: 'Transfugae Romani',
    faction: Faction.Carthage,
    unitClass: 'heavy-infantry',
    /**
     * Appian's nine hundred, at this game's scale.
     *
     * They are the reason this roster is not simply a weaker army. Deserters from Rome could
     * expect crucifixion and knew it, so they fought where nobody else would and they made
     * the last stand in the temple of Eshmun on the seventh day, firing it over themselves
     * (`docs/CARTHAGE.md` §5.2). **The best troops on Carthage's wall are Roman**, which is
     * true, is the single best fact in the siege, and costs nothing to model — they are a
     * legionary kit mask on `Faction.Carthage` with `culture: 'roman'`, which is precisely
     * what that field exists for.
     */
    strength: 96,
    /**
     * A `legio-cohort` (40/13/3/40, armour 52) with more attack and slightly less protection:
     * these are experienced men in kit they have kept up for years, without a legion's
     * quartermaster behind them. They must be the hardest thing the storming party meets, or
     * the rule at the head of this file stops being true from the attacker's side.
     */
    meleeAttack: 44, meleeDamage: 14, apDamage: 5, meleeDefence: 40,
    armour: 50, shieldDefence: 32, chargeBonus: 12, bonusVsCavalry: 6,
    attackRate: 0.62, reach: 1.1,
    // No missile. Whatever they came over with, they have been in this city for years.
    walkSpeed: 1.5, runSpeed: 3.3, chargeSpeed: 4.0, mass: 98, stamina: 70,
    /**
     * `unbreakable`, and it is the mechanic rather than the flavour.
     *
     * Every other unit in this game routs when the arithmetic says so. These cannot, because
     * the alternative on offer is a cross — and the ability already exists on the naked
     * fanatics, so it costs no code. Discipline 1.34 is the highest on the wall and just
     * under the `sacred-band`'s 1.3... which it exceeds deliberately: the Band fought for a
     * city, these men are fighting for the ten minutes before they are caught.
     */
    morale: 92, discipline: 1.34,
    appearance: {
      // Republican legionary, because that is what they are: mail, a Montefortino, a scutum
      // and the board still painted with the device of the legion they left.
      weapon: 'gladius', sidearm: 'spear', shield: 'scutum', armour: 'hamata',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.5, heightScale: 1.0, shieldEmblem: 'legio-thunderbolt',
      // A tunic that has been dyed in Carthage and washed in Carthage for years. Close
      // enough to Roman red to be recognised from the ditch, which is the intent.
      tunicColour: 0x8f5a4c, legColour: 0xa5977a,
      culture: 'roman',
    },
    formations: ['line', 'shieldwall', 'testudo', 'wedge'],
    abilities: ['unbreakable', 'testudo'],
    description: 'Nine hundred men who deserted the legions and cannot go back. They held the temple on the Byrsa on the seventh day and burned it over themselves rather than be taken.',
  },

  // -------------------------------------------------------------------------
  // Rome — the siege train at Carthage, 146 BC
  //
  // Scipio Aemilianus' army: a consular force with the engines that go with it. Everything
  // here except the two parties is either an existing unit reused (`legio-cohort` waits in
  // the open, `equites` on the wings, `carroballista` shoots at the parapet) or the same
  // machine the Juthungi already field under a Roman crew.
  //
  // The rule at the head of this file holds from this side too, and it is the same rule
  // read the right way round: these parties are not elite. A tower party is a legionary
  // cohort with its pila left behind and no room for a shield wall, and it is a worse unit
  // than the `punic-deserters` waiting for it on the walk. What the attacker brings is four
  // towers, a ram, two batteries and six cohorts — numbers and position.
  // -------------------------------------------------------------------------
  {
    id: 'legio-tower-party',
    name: 'Legionary Tower Party',
    nativeName: 'Manus Turrium',
    faction: Faction.Rome,
    unitClass: 'heavy-infantry',
    /** Two decks' worth, as `tower-assault` is; a Roman tower deck is a little larger. */
    strength: 80,
    /**
     * A `legio-cohort` (40/13/3/40, armour 52, shield 34) minus what a boarding action takes
     * away. Attack up two points because these are volunteers and the *corona muralis* is
     * real; defence down six and shield down ten, because the whole value of a legionary's
     * defence is the man either side of him and a drawbridge delivers you alone.
     *
     * Set against what it meets: the `punic-deserters` at 44/14/5/40 with armour 50 beat it
     * man for man, and the `punic-levy`'s 2.4 m reach off a five-rank walk beats its 1.0 m
     * until the party is on the walk with them.
     */
    meleeAttack: 42, meleeDamage: 13, apDamage: 4, meleeDefence: 34,
    armour: 48, shieldDefence: 24, chargeBonus: 16, bonusVsCavalry: 0,
    attackRate: 0.64, reach: 1.0,
    // No pilum: it is thrown at twenty paces from a standing throw, and there is neither the
    // room nor the hand free for it on a tower deck.
    walkSpeed: 1.5, runSpeed: 3.3, chargeSpeed: 4.1, mass: 100, stamina: 68,
    // 82/1.26 mirrors `tower-assault`'s 82/1.1 with Roman drill on top: the men who
    // volunteered to go first, and a discipline that keeps them there.
    morale: 82, discipline: 1.26,
    appearance: {
      weapon: 'gladius', sidearm: 'spear', shield: 'scutum', armour: 'hamata',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.4, heightScale: 1.0, shieldEmblem: 'legio-thunderbolt',
      tunicColour: 0xa8262b, legColour: 0xb5a483,
    },
    formations: ['line', 'testudo', 'wedge'],
    abilities: ['testudo'],
    description: 'Volunteers for the drawbridge, in mail and without their pila. Rome gave the mural crown to the first man over the wall because of what the second one usually saw.',
  },
  {
    id: 'legio-escalade',
    name: 'Velite Ladder Party',
    nativeName: 'Velites Scalarii',
    faction: Faction.Rome,
    unitClass: 'light-infantry',
    /**
     * The velites are the ladder party, and that is not a costume decision.
     *
     * The Republican legion's light infantry were its youngest and poorest men, carried a
     * 0.9 m round *parma*, a handful of light javelins and a sword, wore a wolfskin over the
     * helmet so their centurion could see who had done well, and were expressly the troops
     * sent where a formation could not go. That is the escalade, and every piece of it is
     * kit this project already has: `round`, `fur-cap`, `javelin`, `cloth`.
     */
    strength: 104,
    // Below `tower-assault`'s Juthungi counterpart in armour (12 against 18) and above it in
    // discipline: a velite is a poor man, not a bad soldier. Well under the tower party on
    // every line, because escalade is where an assault breaks.
    meleeAttack: 32, meleeDamage: 11, apDamage: 3, meleeDefence: 26,
    armour: 12, shieldDefence: 14, chargeBonus: 10, bonusVsCavalry: 0,
    attackRate: 0.68, reach: 0.95,
    // The *hasta velitaris*: a light shaft with a soft iron head that bent on a shield so it
    // could not be thrown back. Four of them, 26 m, and no use at all once he is climbing.
    missile: { kind: 'javelin', range: 26, damage: 24, apDamage: 10, rate: 9, ammo: 4, accuracy: 0.12, arc: 'flat' },
    walkSpeed: 1.78, runSpeed: 4.3, chargeSpeed: 4.7, mass: 84, stamina: 84,
    morale: 56, discipline: 1.05,
    appearance: {
      weapon: 'javelin', sidearm: 'gladius', shield: 'round', armour: 'cloth',
      helmet: 'fur-cap', crest: 'none', cloak: false, bareChested: false,
      variance: 0.7, heightScale: 0.98, shieldEmblem: 'legio-thunderbolt',
      tunicColour: 0xbc5a44, legColour: 0xa8997a,
    },
    formations: ['loose', 'skirmish', 'line'],
    /**
     * `fire-at-will` but **not** `skirmish-mode`, and that is a measurement rather than a
     * judgement about velites.
     *
     * The first draft gave them both, because that is the pair every other light-missile unit
     * in the roster carries. `tools/matchup.mjs velites-vs-levy` then ran the full 300 s with
     * **zero casualties on either side and zero men in melee**: the front gap goes 999 → 39.5
     * → 36.4 → 46.6 and freezes there for four minutes. `AbilitySystem.statesOf` starts every
     * toggle engaged, so `runSkirmish` was holding them at `SKIRMISH_FALLBACK` — outside their
     * own 26 m javelin range, so they could not even shoot — for the whole battle.
     *
     * A skirmisher's job is to stay away from the enemy and a ladder party's job is to get on
     * top of him, and those cannot be the same unit. Dropping the toggle is the fix; the
     * Juthungi `escalade-party` carries no abilities at all for the same reason without
     * anybody having had to find out. **This is not a bug introduced here** — `iberian-caetrati`
     * and `juthungi-skirmishers` have the same pair and behave the same way — but a unit whose
     * whole purpose is to close must not have it.
     */
    abilities: ['fire-at-will'],
    description: 'The legion\'s youngest men, in wolfskins and with a wicker-faced parma, carrying the ladders. They empty their javelins into the parapet and then climb into it.',
  },
  {
    id: 'legio-ram-crew',
    name: 'Ram Crew',
    nativeName: 'Arietarii',
    faction: Faction.Rome,
    /** Sixteen on the trunk under the shed, sixteen pushing behind it, as `ram-crew` is. */
    unitClass: 'heavy-infantry',
    strength: 32,
    // A little better than the Juthungi crew in armour and steadiness and no better at
    // fighting, which is right: the difference between the two armies at a gate is the shed
    // over the men, not the men.
    meleeAttack: 32, meleeDamage: 12, apDamage: 4, meleeDefence: 28,
    armour: 34, shieldDefence: 10, chargeBonus: 4, bonusVsCavalry: 0,
    attackRate: 0.58, reach: 1.0,
    // No missile: under the shed you have both hands on the trunk.
    walkSpeed: 1.1, runSpeed: 2.0, chargeSpeed: 2.2, mass: 106, stamina: 92,
    morale: 66, discipline: 1.2,
    appearance: {
      weapon: 'gladius', shield: 'none', armour: 'hamata',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.5, heightScale: 1.02, shieldEmblem: 'none',
      tunicColour: 0x9c3630, legColour: 0xa89a7c,
    },
    formations: ['line', 'loose'],
    abilities: [],
    description: 'The gang on the trunk, roofed in green hide against what the gatehouse drops on them. A ram is worked by men who cannot see what is happening to them.',
  },
  {
    id: 'legio-ballista',
    name: 'Stone-Thrower Battery',
    nativeName: 'Ballistae Lapidariae',
    faction: Faction.Rome,
    unitClass: 'artillery',
    /**
     * Three machines of four crew, as the Juthungi battery is.
     *
     * **Named honestly.** The *onager* is a fourth-century AD machine and this is 146 BC; the
     * Republican stone-thrower is a two-armed torsion *ballista*, which is a different frame
     * with the same job. The mesh this project owns is the onager's, so the unit is called
     * what the geometry is not — a stone-thrower — and the discrepancy is written down here
     * rather than smuggled through in the name. `engineKindOf` selects that mesh purely on
     * `arc: 'high'`, so nothing had to be built for this entry.
     */
    strength: 12,
    meleeAttack: 13, meleeDamage: 6, apDamage: 1, meleeDefence: 15,
    armour: 20, shieldDefence: 0, chargeBonus: 0, bonusVsCavalry: 0,
    attackRate: 0.5, reach: 0.9,
    // Marginally better than the Juthungi's captured pieces (220/150/120 at 0.045, 1.6 a
    // minute, 20 stones) on every axis and by a hair on each: same machine, laid by the men
    // who built it, with a siege park behind it instead of a wagon.
    missile: { kind: 'boulder', range: 230, damage: 145, apDamage: 115, rate: 1.7, ammo: 22, accuracy: 0.04, arc: 'high' },
    // Zero, exactly as the Juthungi battery is, and for the same reason: a stone-thrower is
    // sited with levers and rollers over hours and does not move again. The standing hazard
    // recorded on that entry — a machine that cannot flee cannot satisfy the rout-retirement
    // test in `BattleSystem` — applies here too and is not made worse by matching it.
    walkSpeed: 0, runSpeed: 0, chargeSpeed: 0, mass: 300, stamina: 44,
    morale: 46, discipline: 1.1,
    appearance: {
      weapon: 'boulder', sidearm: 'gladius', shield: 'none', armour: 'leather',
      helmet: 'coolus', crest: 'none', cloak: false, bareChested: false,
      variance: 0.55, heightScale: 1.0, shieldEmblem: 'none',
      tunicColour: 0x9c3630, legColour: 0x8e8266,
    },
    formations: ['line'],
    abilities: ['fire-at-will'],
    description: 'A talent of stone at a time, thrown at the merlons until there is nothing to shoot from. Scipio had the whole siege park of a consular army and three years to use it.',
  },
];
