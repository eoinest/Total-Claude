import type { QualitySettings } from './Engine';

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
