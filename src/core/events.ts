import type { QualitySettings } from './Engine';

/**
 * Why a wall order could not be carried out.
 *
 * Declared here rather than in `sim/Siege.ts` because it has two readers on opposite sides of
 * a seam and exactly one of them may own it: `Siege.traverseOfferAt` answers with it *before*
 * the click, so the cursor can refuse, and `orderRefused` carries it back *after* the click,
 * for the orders the cursor could not pre-judge. Both must be the same list of reasons or the
 * player gets two vocabularies for one rule.
 *
 * `src/ui/siege.ts` holds the sentence for each, in one total map, because a refusal the
 * player cannot read is the same defect as no refusal at all.
 *
 *  - `notOnWall`  — this unit has no garrison on the stonework to move along it.
 *  - `noWall`     — the point is not on a wall the simulation knows about.
 *  - `noRoute`    — the walk between here and there is broken: a construction step, a
 *                   gatehouse, a bay the great ram has brought down.
 *  - `noStair`    — there is no flight of steps joining this stretch to the ground.
 *  - `busy`       — the siege system is already placing these men and will not be interrupted.
 */
export type WallRefusal = 'notOnWall' | 'noWall' | 'noRoute' | 'noStair' | 'busy';

/**
 * Which wall order was asked for. Carried with the refusal because one reason reads two ways:
 * "no steps join that bay to the ground" is the right sentence for a descent and the wrong one
 * for a climb, and the first cut of this said the descent version over a cohort standing in the
 * street trying to get up. Same defect as the card naming the wrong condition, one size down.
 */
export type WallVerb = 'traverse' | 'descend' | 'ascend';

/**
 * The engine-wide event vocabulary. Every cross-subsystem signal is declared here
 * so the compiler catches typos and payload drift between producer and consumer.
 */
export interface GameEvents {
  /** Index signature so `EventBus<GameEvents>` satisfies its `Record` constraint. */
  [key: string]: unknown;

  resize: { w: number; h: number };
  /**
   * Emitted by `Engine.setQuality`. **Subscribe to this for anything tier-dependent.**
   *
   * For a long time it was declared here, emitted once, and consumed by nobody, while the
   * only thing that actually propagated a tier change was the `s.resize?.()` call on the
   * next line of `setQuality`. That is a trap: `resize` also fires on every window resize,
   * so a subsystem that scales itself there does expensive work for the wrong reason, and a
   * subsystem that does not implement `resize` at all silently keeps its boot-time tier
   * forever. Three did — VFX capacities, grass density and the audio detail level were all
   * frozen at whatever tier the game booted on, so dropping to `low` did not reduce their
   * cost by a single unit.
   */
  qualityChanged: { quality: QualitySettings };

  /** Loading progress for the splash screen. */
  loadProgress: { frac: number; label: string };
  loadComplete: Record<string, never>;

  // ---- Selection & orders (UI <-> sim) ----
  selectionChanged: { unitIds: number[] };
  /** Player issued a move/attack order. `formation` is a formation id or null to keep current. */
  orderIssued: {
    unitIds: number[];
    /**
     * `garrison` was already handled by `applyOrder` but never typed, and `gait` is new:
     * pressing R used to flip a UI latch that was only read at the *next* right-click, so
     * the key did nothing to a unit already marching. Both belong here or the emit sites
     * do not compile.
     */
    kind:
      | 'move' | 'attack' | 'attackMove' | 'halt' | 'formation' | 'facing' | 'ability'
      | 'gait' | 'garrison';
    /**
     * Who issued it. Required, so the compiler finds the sixteenth emit site.
     *
     * The channel carries the player's mouse and `src/ai/Orders.ts` on the same wire, and
     * the AI emits about 6,159 orders per 200 s of the field battle. Anything that records
     * "the player's orders" off this bus without a provenance test records all of those too,
     * and on playback the AI regenerates them from the same seed while the recorder re-emits
     * them — every order applied twice. That is why `src/sim/replay.ts` exists and why it
     * only ever records `local`.
     *
     * `deploy` is the halt `DeploymentSystem.place` raises so that `applyOrder` re-plants
     * `holdX/holdZ`. It is a consequence of a deployment operation that is recorded in its
     * own right, so recording it as well would apply it twice.
     */
    source: 'local' | 'ai' | 'deploy';
    x?: number;
    z?: number;
    facing?: number;
    /** Target unit for an attack order. */
    targetUnitId?: number;
    formation?: string;
    ability?: string;
    /** Men per rank, set by a right-click-drag frontage order. */
    width?: number;
    /** Shift-queued rather than replacing the current order. */
    queued?: boolean;
    /** Run instead of walk (double-click / Alt). */
    running?: boolean;
  };

  /**
   * A wall order was given and the simulation will not carry it out.
   *
   * The counterpart of `orderIssued`, and the reason it exists is measured: a garrison order
   * that `Siege` refuses was **eaten whole**. `interceptOrders` discarded the boolean
   * `moveAlongWall`/`sendToGround`/`sendToWall` return and set the unit back to `Garrison`
   * either way, so the unit stood still, `unitWallState.goal` never left `none`, `planAge`
   * stayed −1, and nothing anywhere said a word. A judge issued four orders the cursor had
   * offered — 407 m, 370 m, 37 m and 37 m — and closed 0 m of all four, including to the bay
   * next door.
   *
   * The cursor refuses what it can see coming (`traverseOfferAt`). This is for the rest: the
   * order point is decided a tick later from a point the UI pushed clear of the masonry, and
   * a predicate that runs on hover cannot always answer for it. **An order must execute or be
   * refused out loud; those are the only two acceptable outcomes.**
   *
   * The payload is a code, not a sentence: the wall verbs' words belong to the interface.
   */
  orderRefused: {
    unitId: number;
    verb: WallVerb;
    refusal: WallRefusal;
    /** The bay the order pointed at, or −1 when it was not on a bay. */
    bay: number;
  };

  // ---- Combat feedback (sim -> audio/vfx/ui) ----
  /** A melee blow landed. `kind` drives which impact sound and decal is used. */
  meleeHit: {
    x: number; y: number; z: number;
    kind: 'flesh' | 'shield' | 'armour' | 'parry' | 'miss';
    lethal: boolean;
    attackerFaction: number;
  };
  /** A volley was released. */
  volleyFired: {
    x: number; y: number; z: number;
    count: number;
    /**
     * `stone` is separate from `sling` because they are different objects with different
     * sounds and different litter. Without it a 26 kg onager boulder had to borrow `sling`,
     * so a siege engine landed with the crack of a lead bullet and left a bullet-sized mark.
     */
    kind: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt' | 'stone';
  };
  projectileImpact: {
    x: number; y: number; z: number;
    kind: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt' | 'stone';
    hitTarget: boolean;
    material: 'ground' | 'shield' | 'flesh' | 'armour' | 'stone' | 'wood';
  };
  /** Two formations collided — the moment for a big shield-crash sound and camera shake. */
  linesClashed: { x: number; z: number; intensity: number; attackerFaction: number };
  cavalryCharge: { x: number; z: number; intensity: number; unitId: number };

  /** An ability came into effect on a unit, or was toggled. */
  abilityActivated: { unitId: number; ability: string; active: boolean };
  abilityExpired: { unitId: number; ability: string };

  soldierDied: { x: number; y: number; z: number; unitId: number; faction: number; index: number };
  unitRouted: { unitId: number; faction: number };
  unitRallied: { unitId: number; faction: number };
  unitDestroyed: { unitId: number; faction: number };
  unitMoraleChanged: { unitId: number; morale: number; previous: number };

  // ---- Battle flow ----
  battleStarted: { seed: number; scenario: string };
  /**
   * Two reasons that are not `timeout`, because both can fire long before the clock runs
   * out and each means something else: `stalemate`, nobody has died anywhere on the field
   * for two minutes; `repulsed`, a storm has stopped reducing the garrison's hold on the
   * parapet, so the assault has failed while both armies are still standing.
   */
  battleEnded: {
    victor: number;
    reason: 'annihilation' | 'rout' | 'timeout' | 'objective' | 'stalemate' | 'repulsed';
  };
  /**
   * The pre-battle deployment phase opened, closed, or had a unit added or removed.
   *
   * `deploymentBegan` fires after the scenario has laid the armies out and the clock has
   * been stopped, which is the moment the HUD has to change mode; `deploymentEnded` fires
   * as the clock is released. Nothing in the simulation consumes these — they exist so the
   * interface and a headless driver can both observe the phase without polling.
   */
  deploymentBegan: { faction: number; units: number };
  deploymentEnded: { units: number };
  deploymentChanged: { unitId: number; added: boolean };
  /** Gates breached, walls scaled, capture points taken. */
  objectiveChanged: { id: string; holder: number; progress: number };

  // ---- Camera ----
  cameraShake: { amplitude: number; decay?: number };
  cameraFocusUnit: { unitId: number };

  // ---- Audio ----
  playSound: { id: string; x?: number; y?: number; z?: number; volume?: number; pitch?: number };
  musicCue: { id: 'calm' | 'tension' | 'battle' | 'victory' | 'defeat' };
}
