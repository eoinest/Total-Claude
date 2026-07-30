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

export enum Faction {
  Rome = 0,
  Germanic = 1,
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
};

export const enemyOf = (f: Faction): Faction => (f === Faction.Rome ? Faction.Germanic : Faction.Rome);

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
  | 'bow' | 'sling' | 'javelin' | 'pilum' | 'framea' | 'bolt';
export type ShieldKind = 'scutum' | 'oval' | 'round' | 'hexagonal' | 'none';
export type ArmourKind = 'segmentata' | 'hamata' | 'squamata' | 'leather' | 'cloth' | 'none';
export type HelmetKind = 'imperial-gallic' | 'intercisa' | 'coolus' | 'spangenhelm' | 'fur-cap' | 'none';

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

// ---------------------------------------------------------------------------
// Soldier pool
// ---------------------------------------------------------------------------

/**
 * Every per-soldier field the sim and renderer need, laid out as parallel typed
 * arrays. Allocate once at battle start with the quality tier's soldier cap.
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

  constructor(halfExtent: number, cellSize = 4) {
    this.cellSize = cellSize;
    this.originX = -halfExtent;
    this.originZ = -halfExtent;
    this.cols = Math.ceil((halfExtent * 2) / cellSize) + 1;
    this.rows = this.cols;
    const n = this.cols * this.rows;
    this.starts = new Int32Array(n + 1);
    this.counts = new Int32Array(n);
    this.items = new Int32Array(0);
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.floor((x - this.originX) / this.cellSize);
    const cz = Math.floor((z - this.originZ) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  /** Two-pass counting sort into contiguous buckets. */
  rebuild(pool: SoldierPool): void {
    const n = pool.count;
    if (this.items.length < n) this.items = new Int32Array(Math.max(n, 1024));
    this.counts.fill(0);

    for (let i = 0; i < n; i++) {
      if (!pool.aliveAt(i)) continue;
      const c = this.cellOf(pool.x[i], pool.z[i]);
      if (c >= 0) this.counts[c]++;
    }
    let acc = 0;
    for (let c = 0; c < this.counts.length; c++) {
      this.starts[c] = acc;
      acc += this.counts[c];
    }
    this.starts[this.counts.length] = acc;
    // Reuse counts as a write cursor.
    this.counts.fill(0);
    for (let i = 0; i < n; i++) {
      if (!pool.aliveAt(i)) continue;
      const c = this.cellOf(pool.x[i], pool.z[i]);
      if (c < 0) continue;
      this.items[this.starts[c] + this.counts[c]++] = i;
    }
  }

  /**
   * Visit every indexed soldier within `radius` of (x,z). The callback receives the
   * candidate index and squared distance; it must do its own precise filtering.
   */
  query(x: number, z: number, radius: number, fn: (index: number, d2: number) => void): void {
    const r = Math.max(0, radius);
    const minCx = Math.max(0, Math.floor((x - r - this.originX) / this.cellSize));
    const maxCx = Math.min(this.cols - 1, Math.floor((x + r - this.originX) / this.cellSize));
    const minCz = Math.max(0, Math.floor((z - r - this.originZ) / this.cellSize));
    const maxCz = Math.min(this.rows - 1, Math.floor((z + r - this.originZ) / this.cellSize));
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
