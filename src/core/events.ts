import type { QualitySettings } from './Engine';

/**
 * The engine-wide event vocabulary. Every cross-subsystem signal is declared here
 * so the compiler catches typos and payload drift between producer and consumer.
 */
export interface GameEvents {
  /** Index signature so `EventBus<GameEvents>` satisfies its `Record` constraint. */
  [key: string]: unknown;

  resize: { w: number; h: number };
  qualityChanged: { quality: QualitySettings };

  /** Loading progress for the splash screen. */
  loadProgress: { frac: number; label: string };
  loadComplete: Record<string, never>;

  // ---- Selection & orders (UI <-> sim) ----
  selectionChanged: { unitIds: number[] };
  /** Player issued a move/attack order. `formation` is a formation id or null to keep current. */
  orderIssued: {
    unitIds: number[];
    kind: 'move' | 'attack' | 'attackMove' | 'halt' | 'formation' | 'facing' | 'ability';
    x?: number;
    z?: number;
    facing?: number;
    /** Target unit for an attack order. */
    targetUnitId?: number;
    formation?: string;
    ability?: string;
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
    kind: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt';
  };
  projectileImpact: {
    x: number; y: number; z: number;
    kind: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt';
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
  battleEnded: { victor: number; reason: 'annihilation' | 'rout' | 'timeout' | 'objective' };
  /** Gates breached, walls scaled, capture points taken. */
  objectiveChanged: { id: string; holder: number; progress: number };

  // ---- Camera ----
  cameraShake: { amplitude: number; decay?: number };
  cameraFocusUnit: { unitId: number };

  // ---- Audio ----
  playSound: { id: string; x?: number; y?: number; z?: number; volume?: number; pitch?: number };
  musicCue: { id: 'calm' | 'tension' | 'battle' | 'victory' | 'defeat' };
}
