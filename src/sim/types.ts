/**
 * Core simulation data model.
 *
 * Soldiers live in a structure-of-arrays pool backed by typed arrays. At 6-10k
 * simultaneously simulated men, an array-of-objects layout spends most of its time
 * chasing pointers; SoA keeps each pass over the army linear in memory and lets the
 * renderer upload instance attributes with a single subarray copy per frame.
 *
 * Indices are stable for a soldier's lifetime. Dead soldiers keep their slot (their
 * corpse still renders), so `count` only grows during a battle.
 */

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

/**
 * Belligerents.
 *
 * **Append only.** `Faction` is written into `pool.faction` (a `Uint8Array`), read back by
 * the renderer to pick a geometry row, and used as a `Record` key in half a dozen tables.
 * Renumbering an existing member changes every one of those at once, and silently — the
 * determinism harness would report a different hash for the shipped battle with nothing in
 * the diff that looks like a cause. Carthage is 2 for that reason and no other.
 */
export enum Faction {
  Rome = 0,
  Germanic = 1,
  Carthage = 2,
}

export interface FactionDef {
  id: Faction;
  name: string;
  /** Short label for the HUD. */
  shortName: string;
  /** Primary banner / selection colour. */
  colour: number;
  /** Secondary trim colour. */
  accent: number;
  /** Tint applied to cloth on unit meshes. */
  clothColour: number;
  /** Latin or reconstructed battle cries, keyed for the audio system. */
  warCrySound: string;
}

export const FACTIONS: Record<Faction, FactionDef> = {
  [Faction.Rome]: {
    id: Faction.Rome,
    name: 'Senatus Populusque Romanus',
    shortName: 'ROME',
    colour: 0xa8202a,
    accent: 0xd4af37,
    clothColour: 0x9e2b2b,
    warCrySound: 'cry_roma',
  },
  [Faction.Germanic]: {
    id: Faction.Germanic,
    name: 'Juthungi Confederation',
    shortName: 'JUTHUNGI',
    colour: 0x2f5d8c,
    accent: 0xb7c4cc,
    clothColour: 0x4a5c46,
    warCrySound: 'cry_germanic',
  },
  [Faction.Carthage]: {
    id: Faction.Carthage,
    name: 'Carthaginian Empire',
    // Punic, not Latin. The city called itself Qart-Hadasht, "New City"; `QRT-HDST` is how
    // it appears on its own coinage, in an abjad with no written vowels.
    shortName: 'QART-HADASHT',
    // Tyrian purple, and it is the one faction colour here that is a *trade good* rather
    // than a heraldic choice: murex purple was Phoenicia's signature export and Carthage was
    // Tyre's colony. Pushed violet rather than to the true dye's near-black maroon (0x66023c)
    // because a HUD blip is three pixels and the true colour is indistinguishable from
    // Rome's oxblood at that size — the same reasoning as `litRaw` in `ui/theme.ts`.
    colour: 0x7a3d96,
    accent: 0xd9c07a,
    clothColour: 0x4a2f63,
    warCrySound: 'cry_carthage',
  },
};

/**
 * Who is fighting whom.
 *
 * With two factions this was a flip. With three it cannot be, because `enemyOf(Rome)` is no
 * longer a property of Rome — it depends on which army was deployed. The opponent is
 * therefore declared once, by the scenario, before the first tick.
 *
 * This is module state and that deserves justification against the determinism rule. It is
 * written exactly once per battle, during deployment, and never inside `fixedUpdate`; a given
 * config always produces the same value; and the default is `Germanic`, so the shipped battle
 * resolves to precisely what it did when this was a hard-coded ternary. The alternative —
 * threading the battle through `enemyOf` — would change a signature that `src/ai/*` calls, and
 * that file is owned by another workstream.
 */
let opposingFaction: Faction = Faction.Germanic;

/** Declare the non-Roman side. Called by the scenario at deploy time, never during a tick. */
export const setOpposingFaction = (f: Faction): void => {
  opposingFaction = f;
};

export const getOpposingFaction = (): Faction => opposingFaction;

export const enemyOf = (f: Faction): Faction =>
  f === Faction.Rome ? opposingFaction : Faction.Rome;

/**
 * Symmetric hostility test.
 *
 * Prefer this to `enemyOf(a) === b` anywhere a *predicate* is what is wanted: it is correct
 * for any number of factions, needs no notion of a current battle, and cannot be wrong in the
 * frame between a scenario being chosen and `setOpposingFaction` being called. No two factions
 * in this game are ever allied, so difference is enmity.
 */
export const areEnemies = (a: Faction, b: Faction): boolean => a !== b;

/** Every faction id, in enum order. Use instead of writing a two-element array literal. */
export const ALL_FACTIONS: readonly Faction[] = [Faction.Rome, Faction.Germanic, Faction.Carthage];

// ---------------------------------------------------------------------------
// Soldier state machine
// ---------------------------------------------------------------------------

export enum SoldierState {
  Idle = 0,
  Marching = 1,
  Running = 2,
  Charging = 3,
  /** Engaged in melee. */
  Fighting = 4,
  /** Shields up, braced for impact (testudo / receiving a charge). */
  Bracing = 5,
  /** Winding up or releasing a thrown weapon. */
  Throwing = 6,
  Shooting = 7,
  Reloading = 8,
  /** Knocked off balance by a charge or heavy blow. */
  Staggered = 9,
  /** Death animation playing. */
  Dying = 10,
  /** Corpse; no longer simulated. */
  Dead = 11,
  /** Broken and fleeing. */
  Routing = 12,
  /** Climbing a siege ladder. */
  Climbing = 13,
  /** Cheering after victory. */
  Cheering = 14,
}

/** States in which a soldier still occupies space and can be hit. */
export const isAlive = (s: SoldierState): boolean => s !== SoldierState.Dead && s !== SoldierState.Dying;
export const isFleeing = (s: SoldierState): boolean => s === SoldierState.Routing;
export const isMoving = (s: SoldierState): boolean =>
  s === SoldierState.Marching || s === SoldierState.Running ||
  s === SoldierState.Charging || s === SoldierState.Routing;

// ---------------------------------------------------------------------------
// Unit archetypes
// ---------------------------------------------------------------------------

export type UnitClass =
  | 'heavy-infantry'
  | 'light-infantry'
  | 'spear-infantry'
  | 'missile-infantry'
  | 'shock-infantry'
  | 'heavy-cavalry'
  | 'light-cavalry'
  | 'artillery'
  | 'general';

export type WeaponKind =
  | 'gladius' | 'spatha' | 'spear' | 'pike' | 'axe' | 'club'
  | 'bow' | 'sling' | 'javelin' | 'pilum' | 'framea' | 'bolt'
  /**
   * The Iberian forward-curving cleaver. Its own kind rather than a sword variant because
   * it fights differently — the mass is in the last third of the blade, so it chops rather
   * than thrusts — and because Livy has the Romans reacting to the wounds it left.
   */
  | 'falcata'
  /** A stone-thrower's shot. Not carried by a man — served by a crew. */
  | 'boulder'
  /** The head of a battering ram. Never launched; it exists so a ram can be a unit. */
  | 'ram';
export type ShieldKind =
  | 'scutum' | 'oval' | 'round' | 'hexagonal'
  /** The Greek aspis: 0.9 m, deeply dished, carried on a forearm band. Twice a round's area. */
  | 'hoplon'
  /** The Iberian caetra: a 0.35-0.5 m centre-gripped buckler, parried with rather than hidden behind. */
  | 'caetra'
  | 'none';
export type ArmourKind =
  | 'segmentata' | 'hamata' | 'squamata' | 'leather' | 'cloth'
  /** Glued layered-linen corslet with shoulder yokes and pteruges — the Hellenistic standard. */
  | 'linothorax'
  | 'none';
export type HelmetKind =
  | 'imperial-gallic' | 'intercisa' | 'coolus' | 'spangenhelm' | 'fur-cap'
  /** Bronze Attic/Phrygian bowl with a raised volute and hinged cheek pieces. */
  | 'attic'
  /** Iberian sinew or leather cap, sometimes with a horsehair topknot. */
  | 'iberian-sinew'
  | 'none';

/** What a mounted man rides. Absent means a horse, which is what every cavalryman rode until now. */
export type MountKind = 'horse' | 'elephant';

/**
 * Where a man's *habits* come from, as distinct from whose banner he fights under.
 *
 * Kit resolution used to key off a single `faction === Germanic` boolean, and for two armies
 * that was the same question asked twice: a Roman was clean-shaven and issued a tunic, a
 * Juthungi was long-haired and wore whatever he had dyed himself.
 *
 * It stops being the same question at Carthage. A Carthaginian army is a citizen core plus
 * six bought contingents, and its heterogeneity is not decoration — Polybius makes the point
 * himself when he says the Punic host had no common language. A Balearic slinger is
 * bare-headed and near-naked, a Libyan spearman is in captured Roman mail, an Iberian wears a
 * white linen tunic with a crimson border, a Gaul is long-haired and bare-chested. Rendering
 * all six as "the purple faction" would be a Roman legion in different colours, which is the
 * one thing this faction must not be.
 */
export type Culture = 'roman' | 'germanic' | 'punic' | 'libyan' | 'iberian' | 'celtic' | 'numidian';

export interface UnitTypeDef {
  id: string;
  name: string;
  /** Latin or native name shown under the unit card. */
  nativeName: string;
  faction: Faction;
  unitClass: UnitClass;
  /** Men per unit at full strength. */
  strength: number;

  // ---- Combat ----
  /** Chance-to-hit weighting in melee. */
  meleeAttack: number;
  /** Damage per successful blow before armour. */
  meleeDamage: number;
  /** Armour-piercing portion of damage, ignores armour. */
  apDamage: number;
  /** Defence skill — dodging and parrying. */
  meleeDefence: number;
  /** Flat damage reduction from armour. */
  armour: number;
  /** Extra defence while a shield faces the attacker. */
  shieldDefence: number;
  /** Bonus damage on the first seconds of a charge. */
  chargeBonus: number;
  /** Bonus damage against cavalry (spear walls). */
  bonusVsCavalry: number;
  /** Blows per second. */
  attackRate: number;
  /** Reach in metres — spears out-range swords. */
  reach: number;
  /**
   * Hit points of one pool entry. Absent means 100, which is every man in the game.
   *
   * **This exists because one pool entry is not always one man.** `strength` is a count of
   * *entries*, and for almost everything an entry is a soldier — so `BattleSystem.spawnUnit`
   * wrote a flat 100 and nothing had ever needed otherwise. `war-elephants` breaks that: its
   * own comment in `roster.ts` opens with "eight animals, not eight men" and says an entry is
   * "the beast, its mahout and the three men in the tower", and it was then given a
   * legionary's hit points. Four pila killed one.
   *
   * So this is not a buff knob bolted to the side of the roster; it is the second half of a
   * statement the roster already makes. Anything that is one entry and more than one life
   * says so here, and everything else keeps the 100 it always had — which is why no battle
   * without such a unit in it changes by a bit.
   */
  hitPoints?: number;

  // ---- Missiles ----
  missile?: {
    kind: WeaponKind;
    range: number;
    damage: number;
    apDamage: number;
    /** Shots per minute. */
    rate: number;
    ammo: number;
    /** Angular spread in radians. */
    accuracy: number;
    /** Arcing (arrows) vs flat (pila). */
    arc: 'high' | 'flat';
  };

  // ---- Movement ----
  walkSpeed: number;
  runSpeed: number;
  chargeSpeed: number;
  /** Kilograms; drives push resolution in the crush. */
  mass: number;
  /** Seconds of sprinting before fatigue bites. */
  stamina: number;

  // ---- Morale ----
  morale: number;
  /** Multiplier on incoming morale damage; disciplined troops resist better. */
  discipline: number;

  // ---- Appearance ----
  appearance: {
    weapon: WeaponKind;
    sidearm?: WeaponKind;
    shield: ShieldKind;
    armour: ArmourKind;
    helmet: HelmetKind;
    /** Crest on the helmet: transverse (centurion), longitudinal, plume, none. */
    crest: 'none' | 'transverse' | 'longitudinal' | 'plume' | 'horns' | 'feather';
    /** Cloak / sagum. */
    cloak: boolean;
    /** Bare-chested Germanic fanatics. */
    bareChested: boolean;
    /** Fraction of men who wear a cloak / have a beard etc. — adds visual variety. */
    variance: number;
    /** Base body scale; Germanic warriors read slightly taller and leaner. */
    heightScale: number;
    /** Shield facing emblem id, resolved by the texture atlas. */
    shieldEmblem: string;
    /** Primary cloth tint override. */
    tunicColour: number;
    /** Trouser / leg wrap tint. */
    legColour: number;
    /**
     * What a mounted unit rides. Only read when the unit is cavalry; absent means a horse.
     *
     * A discriminator here rather than a new `UnitClass` on purpose. `unitClass` is switched
     * on throughout `src/ai/*` — `isCavalryClass`, `isLineUnit`, the `matchup` table — and a
     * new member would need every one of those to grow a case before an elephant could take
     * a sensible order. Classing a war elephant as heavy cavalry is also what Rome II does,
     * and it is behaviourally right: charge home, ruin a soft flank, die on a braced spear
     * wall. So the animal changes and the tactics do not.
     */
    mount?: MountKind;
    /**
     * Grooming, dress and metalworking habits. Absent falls back to the faction's own —
     * Rome `roman`, the Juthungi `germanic`, Carthage `punic` — so no existing unit changes.
     */
    culture?: Culture;
  };

  /** Formation ids this unit may adopt. First entry is the default. */
  formations: string[];
  /** Special abilities, resolved by the ability system. */
  abilities: string[];
  /** One-line flavour text for the unit card tooltip. */
  description: string;
}

// ---------------------------------------------------------------------------
// Unit groups (the thing the player selects and orders)
// ---------------------------------------------------------------------------

export enum UnitOrder {
  Hold = 0,
  MoveTo = 1,
  AttackMove = 2,
  AttackUnit = 3,
  Withdraw = 4,
  Rout = 5,
  /** Holding a wall segment or gate. */
  Garrison = 6,
}

export interface UnitGroupState {
  id: number;
  typeId: string;
  faction: Faction;
  /** Soldier pool indices belonging to this unit. */
  members: number[];
  /** Living member count, refreshed each tick. */
  alive: number;
  initialStrength: number;

  // ---- Position ----
  /** Formation anchor (centre of the front rank's midpoint). */
  x: number;
  z: number;
  /** Facing in radians; 0 = +Z. */
  facing: number;
  /** Where the formation is heading. */
  targetX: number;
  targetZ: number;
  targetFacing: number;

  // ---- Orders ----
  order: UnitOrder;
  targetUnitId: number;
  /** Queued waypoints as flat [x,z,facing] triples. */
  waypoints: number[];
  running: boolean;

  // ---- Formation ----
  formationId: string;
  /** Men per rank. */
  width: number;
  /** Metres between men laterally and front-to-back. */
  spacingX: number;
  spacingZ: number;

  // ---- Condition ----
  morale: number;
  maxMorale: number;
  fatigue: number;
  ammo: number;
  /** True while the unit is in contact with an enemy. */
  engaged: boolean;
  /** Seconds since the charge began; drives the charge damage bonus. */
  chargeTimer: number;
  /**
   * Set by `BattleSystem` once this formation's front rank has met an enemy's. While
   * true the movement code must not translate the anchor — a unit locked shield to
   * shield stops advancing and only pivots, and only `Combat.resolvePush` may move it.
   * Without this the anchor keeps walking into the enemy, the two blocks interpenetrate,
   * and each ends up chasing a point inside the other: mutual pursuit, which spirals.
   */
  contactLock: boolean;
  /** True while the charge window is open, so movement uses `chargeSpeed` not `runSpeed`. */
  charging: boolean;
  /** Seconds the unit has been routing. */
  routTimer: number;
  /** Kills scored, for the post-battle report. */
  kills: number;
  /** Set when the unit has been wiped out or has fled the field. */
  destroyed: boolean;
  /** Selected in the UI. */
  selected: boolean;
  /** Unit is fully or partly hidden from the enemy (woods, night). */
  concealed: boolean;
}

/**
 * Has this unit stopped being able to work a machine, hold a place in its file, or hold
 * ground?
 *
 * The one predicate behind every "we are still driving men who have broken": the ram crew
 * that fled while the ram went on rolling, the tower gang, the escalade party that stood at
 * the foot of its own ladders playing a run cycle — and, since a routing man is not holding
 * ground either, the break-in census that decided both sieges. Each of those was written out
 * longhand at its own call site and the copies did not agree.
 *
 * It lived as `Siege.broken` while all three of its readers were inside `Siege`. It moved
 * here rather than gaining a fourth private copy in `BattleFlow`, which is what the last
 * three bugs of this shape in this project were.
 *
 * Deliberately **not** the negation of a type predicate like `Siege.mayBoard`. A false branch
 * that narrows `u` to `undefined` is exactly wrong here, because a live unit that is merely
 * routing is the case this exists for.
 */
export const isBroken = (u: UnitGroupState | undefined): boolean =>
  !u || u.destroyed || u.alive === 0 || u.order === UnitOrder.Rout;

// ---------------------------------------------------------------------------
// Soldier pool
// ---------------------------------------------------------------------------

/**
 * How many men a battle can hold. **One number, at every quality tier, on every machine.**
 *
 * This used to be `QUALITY_PRESETS[tier].maxSoldiers` — 1,600 at `low`, 3,200 at `medium`,
 * 10,000 at `high`, 12,000 at `ultra` — and that was a graphics setting reaching into the
 * simulation. `fittedUnitScale` fits the whole order of battle to the pool, so the tier fixed
 * the pool, the pool fixed `unitSizeScale`, and `unitSizeScale` is a simulation input. The
 * measured consequence, on one map, one scenario, one seed (Campus Martius assault, seed
 * 4265438264, hard):
 *
 *     quality   men     ram crew                     gate blows    gate opens
 *     ultra    3,074    dead at (68,514) by t+100    0 by t+520    never
 *     medium   3,009    reaches the gate             26 by t+240   t+180..240
 *
 * Different headcount, different battle, different result, from a shadow-quality dropdown. The
 * owner's ruling was that graphics settings must not change the outcome of a battle, and this
 * constant is the whole of the fix: nothing on the settings path can size an army any more.
 *
 * **12,000, because that is what `ultra` gave and `ultra` is the tier the game ships on.**
 * `main.ts` opens on ultra for players as well as for the harness, and `high` and `ultra` were
 * already bit-identical on all three pinned battles — `Math.min` in `fittedUnitScale` binds on
 * the *asked* unit size long before the pool cap does. So making every tier the ultra tier
 * leaves the shipped battle untouched to the bit, moves the recorded baseline not at all, and
 * changes only `low` and `medium`, which were the tiers quietly fielding a different war. Every
 * one of the 21 pinned checkpoints was re-measured across this change and none of them moved.
 *
 * **What a low tier gives up instead.** Resolution (`renderScale`, `maxPixelRatio`), shadow
 * cascades and map size, SSAO, motion blur, volumetric light, depth of field, grass density and
 * the LOD/impostor switch distance — the whole of `RenderQuality`, which is what a graphics
 * setting is allowed to spend. Fewer men is not a graphics concession; it is a smaller battle
 * wearing a graphics setting's clothes. A machine that genuinely cannot run 8,632 men has an
 * explicit lever for that: the menu's **battle size** row, which is a `BattleConfig` field, is
 * greyed with a reason where it does not apply, travels in the `?battle=` token and is carried
 * by every replay record. `small` fields about 2,150 men on the field battle. That is a choice
 * the player makes and can see, which is the difference that matters.
 *
 * **The cost of holding it at every tier is memory, once, and not frame time.** At 12,000 the
 * simulation-side typed arrays are about 3.5 MB and the soldier instance buffers about 12.5 MB
 * (9 tiers × 12,000 × 116 B — the figure `docs/tech/RENDERING.md` §2 already quotes for ultra),
 * plus about 2 MB of per-man render state. A `low` machine used to allocate those at 1,600, so
 * this asks it for roughly **16 MB more, allocated once at boot**. That is a real cost and it is
 * a small one in absolute terms; more to the point it is the *right* cost, because
 * `geometry.instanceCount` is set to the men actually drawn on every frame, so an unfilled
 * buffer is never traversed and never uploaded. What used to scale with the tier was the
 * *battle*, and that is precisely the thing that must not.
 *
 * `fittedUnitScale` still exists and still clamps, against `* 0.94` of this number — 11,280 men,
 * with the 6% headroom absorbing the unscaled artillery crews. It is now a bound on how large a
 * battle the engine will hold, identical everywhere, rather than a bound on how large a battle
 * your graphics card is deemed worthy of.
 *
 * What would change my mind: a measurement showing the allocation itself — not the simulation
 * of the men, not the drawing of them — is what fails on real weak hardware. Then the pool
 * becomes a pure function of the `BattleConfig` (`spawnList` already computes the exact figure)
 * and is sized to the battle rather than to a ceiling, which is still tier-independent and
 * still satisfies the ruling. It would cost `BattleSystem` a constructor argument and
 * `UnitRenderSystem` an init-order dependency, which is why it is not the first answer.
 */
export const SOLDIER_POOL_CAPACITY = 12000;

/**
 * Every per-soldier field the sim and renderer need, laid out as parallel typed
 * arrays. Allocate once at battle start with `SOLDIER_POOL_CAPACITY`.
 */
export class SoldierPool {
  readonly capacity: number;
  /** Number of slots ever allocated. Iterate `0..count`. */
  count = 0;

  // ---- Transform ----
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Previous-tick position, for render interpolation. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  /** Vertical velocity — only non-zero while falling or ragdolling. */
  readonly vy: Float32Array;
  /** Yaw in radians. */
  readonly facing: Float32Array;
  readonly prevFacing: Float32Array;
  /** Body lean, driven by acceleration; radians. */
  readonly lean: Float32Array;

  // ---- Identity ----
  /** Index into the unit group array. */
  readonly unitId: Int32Array;
  readonly faction: Uint8Array;
  /** Position within the formation: rank * width + file. */
  readonly slot: Uint16Array;
  /** Rank index from the front (0 = front rank). */
  readonly rank: Uint8Array;
  readonly file: Uint8Array;

  // ---- Condition ----
  readonly hp: Float32Array;
  readonly maxHp: Float32Array;
  readonly state: Uint8Array;
  /** Seconds spent in the current state. */
  readonly stateTime: Float32Array;
  /** Current melee opponent's pool index, or -1. */
  readonly target: Int32Array;
  /** Seconds until the next blow can land. */
  readonly attackCooldown: Float32Array;
  /** 0..1; slows attack rate and speed. */
  readonly fatigue: Float32Array;
  readonly ammo: Uint8Array;

  // ---- Animation ----
  /** Index into the animation clip table. */
  readonly animClip: Uint8Array;
  /** Normalised playhead 0..1 within the clip. */
  readonly animTime: Float32Array;
  /** Clip being blended out of, for cross-fades. */
  readonly animPrevClip: Uint8Array;
  readonly animPrevTime: Float32Array;
  /** 0..1 blend weight toward `animClip`. */
  readonly animBlend: Float32Array;
  /** Playback rate multiplier — desynchronises identical clips across the rank. */
  readonly animRate: Float32Array;

  // ---- Appearance variation ----
  /** Per-man height multiplier around 1.0. */
  readonly scale: Float32Array;
  /** Stable 0..1 hash used to pick skin tone, beard, shield emblem, kit variant. */
  readonly variant: Float32Array;
  /** Accumulated blood/dirt, 0..1; drives a detail-texture blend. */
  readonly grime: Float32Array;

  // ---- Ragdoll ----
  /** Death direction, so corpses fall away from the blow. */
  readonly deathDirX: Float32Array;
  readonly deathDirZ: Float32Array;
  /** Which death animation variant to play. */
  readonly deathVariant: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    const f32 = () => new Float32Array(capacity);
    const u8 = () => new Uint8Array(capacity);
    const u16 = () => new Uint16Array(capacity);
    const i32 = () => new Int32Array(capacity);

    this.x = f32(); this.y = f32(); this.z = f32();
    this.px = f32(); this.py = f32(); this.pz = f32();
    this.vx = f32(); this.vz = f32(); this.vy = f32();
    this.facing = f32(); this.prevFacing = f32(); this.lean = f32();

    this.unitId = i32(); this.faction = u8();
    this.slot = u16(); this.rank = u8(); this.file = u8();

    this.hp = f32(); this.maxHp = f32(); this.state = u8();
    this.stateTime = f32(); this.target = i32();
    this.attackCooldown = f32(); this.fatigue = f32(); this.ammo = u8();

    this.animClip = u8(); this.animTime = f32();
    this.animPrevClip = u8(); this.animPrevTime = f32();
    this.animBlend = f32(); this.animRate = f32();

    this.scale = f32(); this.variant = f32(); this.grime = f32();
    this.deathDirX = f32(); this.deathDirZ = f32(); this.deathVariant = u8();

    this.target.fill(-1);
  }

  /** Claim the next free slot. Returns -1 when the pool is exhausted. */
  alloc(): number {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  /** Snapshot positions for interpolation. Call at the start of every fixed step. */
  savePrevious(): void {
    const n = this.count;
    this.px.set(this.x.subarray(0, n));
    this.py.set(this.y.subarray(0, n));
    this.pz.set(this.z.subarray(0, n));
    this.prevFacing.set(this.facing.subarray(0, n));
  }

  setState(i: number, s: SoldierState): void {
    if (this.state[i] === s) return;
    this.animPrevClip[i] = this.animClip[i];
    this.animPrevTime[i] = this.animTime[i];
    this.animBlend[i] = 0;
    this.state[i] = s;
    this.stateTime[i] = 0;
  }

  aliveAt(i: number): boolean {
    const s = this.state[i];
    return s !== SoldierState.Dead && s !== SoldierState.Dying;
  }
}

// ---------------------------------------------------------------------------
// Animation clip table — the contract between the animation baker and the sim
// ---------------------------------------------------------------------------

export enum Clip {
  IdleRelaxed = 0,
  IdleAlert = 1,
  /** Shield up, weapon ready. */
  IdleBrace = 2,
  Walk = 3,
  March = 4,
  Run = 5,
  Charge = 6,
  AttackOverhead = 7,
  AttackThrust = 8,
  AttackSlash = 9,
  ShieldBash = 10,
  Block = 11,
  Parry = 12,
  Stagger = 13,
  ThrowPilum = 14,
  DrawBow = 15,
  ReleaseBow = 16,
  DeathBack = 17,
  DeathForward = 18,
  DeathSide = 19,
  DeathKneel = 20,
  Flee = 21,
  Cheer = 22,
  ClimbLadder = 23,
  /** Number of clips; keep last. */
  Count = 24,
}

/** Metadata the baker fills in and the sim reads for timing-sensitive logic. */
export interface ClipInfo {
  clip: Clip;
  name: string;
  /** Duration in seconds at rate 1.0. */
  duration: number;
  loop: boolean;
  /** Normalised time at which a blow lands / a missile releases. */
  hitFrame?: number;
  /** Metres travelled per second by the root, for foot-slide-free locomotion. */
  rootSpeed?: number;
}

// ---------------------------------------------------------------------------
// Battlefield spatial index — shared by combat, AI and collision
// ---------------------------------------------------------------------------

/**
 * Uniform-grid spatial hash over the battlefield. Rebuilt every fixed step; a full
 * rebuild of 10k entries costs far less than incremental maintenance and never drifts.
 */
export class SpatialHash {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  /** Start offset into `items` for each cell (length cols*rows + 1). */
  private starts: Int32Array;
  /** Per-cell counters reused during the two-pass build. */
  private counts: Int32Array;
  /** Soldier indices, bucketed by cell. */
  private items: Int32Array;
  /**
   * The cell rectangle `starts` describes, inclusive. Outside it the array is stale, so a
   * rebuild only clears and prefix-sums the ground the army is standing on: over a grid this
   * size, scanning every cell costs several times what bucketing 8,000 men does, and it is
   * what lets the cell size come down to something a 0.84 m body query can use.
   *
   * Empty is an inverted rectangle (`hi < lo`), which makes every query a no-op rather than
   * a read of stale offsets.
   */
  private cxLo = 0;
  private cxHi = -1;
  private czLo = 0;
  private czHi = -1;

  constructor(halfExtent: number, cellSize = 4) {
    this.cellSize = cellSize;
    this.originX = -halfExtent;
    this.originZ = -halfExtent;
    // One spare column on the right: `rebuild` writes each row's end offset at cxHi + 1, so
    // there has to be a column no man can ever occupy for that write to land in. `cellOf`
    // rejects it, so the accepted region is exactly what it was before the spare was added.
    this.cols = Math.ceil((halfExtent * 2) / cellSize) + 2;
    this.rows = this.cols;
    const n = this.cols * this.rows;
    this.starts = new Int32Array(n + 1);
    this.counts = new Int32Array(n);
    this.items = new Int32Array(0);
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.floor((x - this.originX) / this.cellSize);
    const cz = Math.floor((z - this.originZ) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cols - 1 || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  /**
   * Two-pass counting sort into contiguous buckets, over the occupied rectangle only.
   *
   * Bit-identical to a whole-grid rebuild: every cell outside the rectangle holds zero men
   * and so contributes zero to the prefix sum, which means the offsets inside it — and
   * therefore `items` and the order `query` walks it in — are exactly what they were.
   */
  rebuild(pool: SoldierPool): void {
    const n = pool.count;
    if (this.items.length < n) this.items = new Int32Array(Math.max(n, 1024));
    const counts = this.counts;
    const starts = this.starts;
    const cols = this.cols;
    // Outside the previous rectangle every counter is already zero, so this is the whole clear.
    for (let cz = this.czLo; cz <= this.czHi; cz++) {
      counts.fill(0, cz * cols + this.cxLo, cz * cols + this.cxHi + 1);
    }

    let cxLo = cols;
    let cxHi = -1;
    let czLo = this.rows;
    let czHi = -1;
    for (let i = 0; i < n; i++) {
      if (!pool.aliveAt(i)) continue;
      const cx = Math.floor((pool.x[i] - this.originX) / this.cellSize);
      const cz = Math.floor((pool.z[i] - this.originZ) / this.cellSize);
      if (cx < 0 || cz < 0 || cx >= cols - 1 || cz >= this.rows) continue;
      counts[cz * cols + cx]++;
      if (cx < cxLo) cxLo = cx;
      if (cx > cxHi) cxHi = cx;
      if (cz < czLo) czLo = cz;
      if (cz > czHi) czHi = cz;
    }
    this.cxLo = cxLo;
    this.cxHi = cxHi;
    this.czLo = czLo;
    this.czHi = czHi;
    if (czHi < 0) return;

    let acc = 0;
    for (let cz = czLo; cz <= czHi; cz++) {
      const row = cz * cols;
      for (let cx = cxLo; cx <= cxHi; cx++) {
        starts[row + cx] = acc;
        acc += counts[row + cx];
      }
      starts[row + cxHi + 1] = acc;
    }
    // Reuse counts as a write cursor.
    for (let cz = czLo; cz <= czHi; cz++) {
      counts.fill(0, cz * cols + cxLo, cz * cols + cxHi + 1);
    }
    for (let i = 0; i < n; i++) {
      if (!pool.aliveAt(i)) continue;
      const c = this.cellOf(pool.x[i], pool.z[i]);
      if (c < 0) continue;
      this.items[starts[c] + counts[c]++] = i;
    }
  }

  /**
   * Visit every indexed soldier within `radius` of (x,z). The callback receives the
   * candidate index and squared distance; it must do its own precise filtering.
   */
  query(x: number, z: number, radius: number, fn: (index: number, d2: number) => void): void {
    const r = Math.max(0, radius);
    // Clamped to the occupied rectangle: outside it `starts` is stale, and nothing is indexed
    // there in any case.
    const minCx = Math.max(this.cxLo, Math.floor((x - r - this.originX) / this.cellSize));
    const maxCx = Math.min(this.cxHi, Math.floor((x + r - this.originX) / this.cellSize));
    const minCz = Math.max(this.czLo, Math.floor((z - r - this.originZ) / this.cellSize));
    const maxCz = Math.min(this.czHi, Math.floor((z + r - this.originZ) / this.cellSize));
    const r2 = r * r;

    for (let cz = minCz; cz <= maxCz; cz++) {
      const row = cz * this.cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const c = row + cx;
        const s = this.starts[c];
        const e = this.starts[c + 1];
        for (let k = s; k < e; k++) {
          fn(this.items[k], r2);
        }
      }
    }
  }

  /** Nearest indexed soldier passing `accept`, or -1. */
  nearest(
    x: number,
    z: number,
    radius: number,
    px: Float32Array,
    pz: Float32Array,
    accept: (index: number) => boolean
  ): number {
    let best = -1;
    let bestD2 = radius * radius;
    this.query(x, z, radius, (i) => {
      if (!accept(i)) return;
      const dx = px[i] - x;
      const dz = pz[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    });
    return best;
  }
}
