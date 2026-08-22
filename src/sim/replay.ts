import type { EngineContext, QualityTier, Subsystem } from '../core/Engine';
import type { GameEvents } from '../core/events';
import type { BattleConfig } from './battleConfig';
import { sanitiseConfig } from './battleConfig';
import type { BattleSystem } from './BattleSystem';
import { stateHashes } from './stateHash';

/**
 * The replay record: the seed, the config, and the order log stamped with execution ticks.
 *
 * ## Why this exists at all
 *
 * A record is a save, a share, a thing to watch, and "take command from here" — the last
 * falls out for free, because withholding the rest of the order log *is* taking over. But
 * the reason it is worth the sim changes is the fourth one: it is the only instrument in
 * this project that can notice somebody adding a twenty-fourth input path that writes
 * simulation state from outside a tick. A pixel probe cannot see that. A determinism gate
 * that compares a build with itself cannot see it either — both runs break the same way.
 * A recorded battle that will not replay can.
 *
 * ## The shape, and why
 *
 * The simulation is a pure function of `(config, seed, tick index)`. So a record is the
 * config, and a list of `(tick, order)` in a canonical sequence. Three properties are
 * load-bearing and each is here because of a measured hazard:
 *
 * 1. **Sequence is the array, not a sort key.** `BattleSystem.applyOrder` iterates
 *    `o.unitIds` and mutates as it goes, and `deployment.add` runs `nextUnitId++` *before*
 *    `rng.fork('unit' + id)` — so two orders touching one unit in a different sequence, or
 *    two deployment operations interleaved differently, give different unit ids, different
 *    RNG streams and different pool slots. `events` is an ordered array and nothing in this
 *    file ever sorts it. Ties within a tick are broken by position, which is canonical by
 *    construction.
 * 2. **A tick number, not a timestamp.** A player order is stamped with the tick at whose
 *    top it was drained, and fed back at the top of that same tick. So the record is
 *    independent of frame rate, of how many ticks shared a frame, and of `maxStepsPerFrame`
 *    shedding sim time on a stall.
 * 3. **The number that is recorded is the number that was applied.** `x`/`z` are quantised
 *    to int16 over ±1400 m — 4.3 cm — at the moment the order enters the queue, in live play
 *    exactly as in playback. Recording float64 and replaying int16 is the commonest real
 *    lockstep bug there is and it is invisible until the first move order; doing the round
 *    trip in one place, always, means there is no second path to disagree with.
 *
 * ## What is *not* recorded, and why that is the point
 *
 * The AI's orders are not recorded. `src/ai/Orders.ts` emits on the same `orderIssued`
 * channel the mouse does — 6,159 orders per 200 s of the field battle — and on playback the
 * AI regenerates every one of them from the same seed and the same state. Recording them
 * would double-apply them. That is why `orderIssued` now carries `source`, and why this
 * stage was never two days' work.
 *
 * Nor is anything the simulation does to itself. If a replay diverges, the cause is a
 * mutation that came from outside a tick and was not on this list. Finding that is the job.
 */

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Bumped whenever a wire change makes an older token unreadable. */
export const REPLAY_VERSION = 1;

/**
 * Quantisation range for ordered positions.
 *
 * `HALF_EXTENT` in `src/terrain/topography.ts`, repeated rather than imported so that
 * `src/sim` does not take a dependency on `src/terrain` for one number. If the map ever
 * grows past this the clamp below starts biting and the gate will say so loudly, because a
 * clamped order does not replay to the same place as the click that made it.
 */
export const ORDER_HALF_EXTENT = 1400;
const XZ_SCALE = 32767 / ORDER_HALF_EXTENT;
const ANG_SCALE = 32767 / Math.PI;

/** Metres per least-significant bit of a recorded position. 4.27 cm. */
export const ORDER_XZ_RESOLUTION = ORDER_HALF_EXTENT / 32767;

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32767 ? -32767 : v);
/**
 * "No coordinate here", one below the clamped range so it can never collide with a real one.
 *
 * `deployment.add(typeId)` with no position parks the unit at the rear of the zone by its
 * own arithmetic, and that is a different thing from `add(typeId, 0, 0, 0)`, which stands it
 * at the world origin. Encoding an absent coordinate as 0 put a regiment in the middle of
 * the map on playback and moved the t+0 pool hash — caught by this gate on its first run.
 */
const ABSENT = -32768;

/** Snap a world coordinate to the recorded grid. Applied live, not only on playback. */
export const quantXZ = (v: number): number => clamp16(Math.round(v * XZ_SCALE));
export const dequantXZ = (q: number): number => q / XZ_SCALE;
/**
 * Facing, wrapped into ±π first: `atan2` output is already in range, a raw field may not be.
 *
 * Wrapped by remainder rather than by `atan2(sin, cos)`, which is the usual idiom and is
 * banned in this scope for good reason: `sin`, `cos` and `atan2` are implementation-
 * approximated in ECMA-262 and disagree between browser engines on 4% to 17% of inputs. A
 * player order is the one place a 1-ULP disagreement is *not* absorbed by the float32 pool,
 * because it decides which int16 bucket the record carries — so two engines could encode one
 * click as two different orders. `%` and `-` are correctly rounded and cannot.
 */
const TAU = Math.PI * 2;
export const quantAngle = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return clamp16(Math.round(r * ANG_SCALE));
};
export const dequantAngle = (q: number): number => q / ANG_SCALE;

/** The nine order verbs, indexed. Position is the wire encoding — append, never reorder. */
export const ORDER_KINDS = [
  'move', 'attack', 'attackMove', 'halt', 'formation', 'facing', 'ability', 'gait', 'garrison',
] as const;

/** The deployment verbs a player can drive. Position is the wire encoding. */
export const DEPLOY_VERBS = ['add', 'place', 'remove', 'formation', 'commit'] as const;
export type DeployVerb = (typeof DEPLOY_VERBS)[number];

const F_QUEUED = 1;
const F_RUNNING = 2;
const F_WALL_COUNTERMAND = 4;
const F_HAS_XZ = 8;
const F_HAS_FACING = 16;
const F_HAS_WIDTH = 32;
const F_HAS_TARGET = 64;

/** A recorded player order, in the units the simulation will actually see. */
export interface OrderEvent {
  t: number;
  kind: (typeof ORDER_KINDS)[number];
  unitIds: number[];
  /** Quantised. Absent means the order carried no destination. */
  qx?: number;
  qz?: number;
  qf?: number;
  width?: number;
  targetUnitId?: number;
  /** `formation` id or `ability` id — only one verb uses it, so one slot serves both. */
  s?: string;
  queued?: boolean;
  running?: boolean;
  /**
   * `H` also countermands whatever the wall was told to do, and `Siege` must hear that
   * *before* `BattleSystem` hears the halt. See `ReplaySystem.dispatchOrder`.
   */
  countermandWall?: boolean;
}

/** A recorded siege-machine order — the one player command that is not on the bus. */
export interface MachineEvent {
  t: number;
  unitId: number;
  qx: number;
  qz: number;
}

/** A recorded deployment operation. The clock is stopped, so `t` is always 0. */
export interface DeployEvent {
  t: number;
  verb: DeployVerb;
  typeId?: string;
  unitId?: number;
  qx?: number;
  qz?: number;
  qf?: number;
  width?: number;
  formation?: string;
  /**
   * The unit id `add` returned when this was recorded.
   *
   * Checked on playback, and it is the sharpest assertion in the format. `deployment.add`
   * goes through `spawnUnit`, which does `nextUnitId++` before `rng.fork('unit' + id)` — so
   * a different interleaving of deployment operations mints different ids, which fork
   * different RNG streams, which take different pool slots. If this number comes back wrong
   * the battle is already a different battle and there is no point running it.
   */
  gotId?: number;
}

export type ReplayEvent =
  | ({ k: 'order' } & OrderEvent)
  | ({ k: 'machine' } & MachineEvent)
  | ({ k: 'deploy' } & DeployEvent);

/** A checkpoint, taken every 30 simulated seconds — the same grid the gate's pins use. */
export interface ReplayMark {
  tick: number;
  hash: string;
  uf64: string;
  uctl: string;
  alive: number;
  count: number;
}

/** `BattleFlowSystem.result`, flattened to what a record needs to make its claim. */
export interface ReplayResult {
  victor: number;
  reason: string;
  at: number;
  survivors: Record<number, number>;
  casualties: Record<number, number>;
}

export interface ReplayRecord {
  v: number;
  /** The battle setup. Stored as the object rather than as `encodeConfig`'s base64, because
   *  base64 does not compress and the object does — the token is recoverable either way. */
  cfg: BattleConfig;
  /**
   * The tier the record was made at.
   *
   * It was load-bearing and it is now provenance. `fittedUnitScale` fitted the army to
   * `quality.maxSoldiers`, so a record made at `high` was a different battle from the same
   * config at `low` — 8,632 men against 1,515 — and the tier had to travel with the record for
   * it to mean anything. The soldier pool is `SOLDIER_POOL_CAPACITY` now, one number at every
   * tier, so a record plays identically whatever the watcher's graphics are set to. Kept in the
   * format because it costs a word, because it says what the recorder was looking at, and
   * because removing a field from a wire format that is already in URLs buys nothing.
   */
  quality: QualityTier;
  /** Effective `unitSizeScale` after `fittedUnitScale` clamped it to the pool. */
  unitScale: number;
  /** `pool.count` at t+0. An army this build does not reproduce is refused, not silently fitted. */
  count0: number;
  /** Whether a pre-battle deployment phase ran. Drives `?deploy=` on playback. */
  deployPhase: boolean;
  /** Canonical order. Never sorted. */
  events: ReplayEvent[];
  marks: ReplayMark[];
  ticks: number;
  result: ReplayResult | null;
}

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------
/*
 * Tuples rather than objects, and gzip over the top.
 *
 * The design's estimate was 11–13 bytes per order, from a field-by-field binary layout. A
 * tuple of small integers in JSON is about three times that before compression and roughly
 * the same after it, because the shape repeats and DEFLATE is very good at repeated shape.
 * It is also readable in a debugger and versionable by appending, which a hand-rolled bit
 * layout is not. The measured size is in the gate's output; if it ever stops fitting in a
 * URL the answer is a `.tcr` file, which this already writes.
 */

type Tuple = (number | string | number[])[];

const encEvent = (e: ReplayEvent): Tuple => {
  if (e.k === 'machine') return [e.t, 1, e.unitId, e.qx, e.qz];
  if (e.k === 'deploy') {
    return [e.t, 2, DEPLOY_VERBS.indexOf(e.verb), e.typeId ?? '', e.unitId ?? -1,
      e.qx ?? ABSENT, e.qz ?? ABSENT, e.qf ?? ABSENT, e.width ?? 0,
      e.formation ?? '', e.gotId ?? -1];
  }
  let flags = 0;
  if (e.queued) flags |= F_QUEUED;
  if (e.running) flags |= F_RUNNING;
  if (e.countermandWall) flags |= F_WALL_COUNTERMAND;
  if (e.qx !== undefined) flags |= F_HAS_XZ;
  if (e.qf !== undefined) flags |= F_HAS_FACING;
  if (e.width !== undefined) flags |= F_HAS_WIDTH;
  if (e.targetUnitId !== undefined) flags |= F_HAS_TARGET;
  return [e.t, 0, ORDER_KINDS.indexOf(e.kind), e.unitIds.slice(), e.qx ?? 0, e.qz ?? 0,
    e.qf ?? 0, e.width ?? 0, e.targetUnitId ?? -1, e.s ?? '', flags];
};

const decEvent = (a: Tuple): ReplayEvent | null => {
  const t = a[0] as number;
  const k = a[1] as number;
  if (k === 1) return { k: 'machine', t, unitId: a[2] as number, qx: a[3] as number, qz: a[4] as number };
  if (k === 2) {
    const verb = DEPLOY_VERBS[a[2] as number];
    if (!verb) return null;
    const ev: DeployEvent & { k: 'deploy' } = { k: 'deploy', t, verb };
    if (a[3]) ev.typeId = a[3] as string;
    if ((a[4] as number) >= 0) ev.unitId = a[4] as number;
    if ((a[5] as number) !== ABSENT) ev.qx = a[5] as number;
    if ((a[6] as number) !== ABSENT) ev.qz = a[6] as number;
    if ((a[7] as number) !== ABSENT) ev.qf = a[7] as number;
    if (a[8]) ev.width = a[8] as number;
    if (a[9]) ev.formation = a[9] as string;
    if ((a[10] as number) >= 0) ev.gotId = a[10] as number;
    return ev;
  }
  const kind = ORDER_KINDS[a[2] as number];
  if (!kind) return null;
  const flags = (a[10] as number) | 0;
  const ev: OrderEvent & { k: 'order' } = { k: 'order', t, kind, unitIds: (a[3] as number[]).slice() };
  if (flags & F_HAS_XZ) { ev.qx = a[4] as number; ev.qz = a[5] as number; }
  if (flags & F_HAS_FACING) ev.qf = a[6] as number;
  if (flags & F_HAS_WIDTH) ev.width = a[7] as number;
  if (flags & F_HAS_TARGET) ev.targetUnitId = a[8] as number;
  if (a[9]) ev.s = a[9] as string;
  if (flags & F_QUEUED) ev.queued = true;
  if (flags & F_RUNNING) ev.running = true;
  if (flags & F_WALL_COUNTERMAND) ev.countermandWall = true;
  return ev;
};

/** The JSON a token compresses. Exported so a `.tcr` file and a URL carry the same bytes. */
export function replayToJson(r: ReplayRecord): string {
  return JSON.stringify({
    v: r.v,
    cfg: r.cfg,
    q: r.quality,
    us: r.unitScale,
    n0: r.count0,
    dp: r.deployPhase ? 1 : 0,
    ev: r.events.map(encEvent),
    mk: r.marks.map((m) => [m.tick, m.hash, m.uf64, m.uctl, m.alive, m.count]),
    tk: r.ticks,
    res: r.result,
  });
}

export function replayFromJson(json: string): ReplayRecord | null {
  try {
    const o = JSON.parse(json);
    if (!o || o.v !== REPLAY_VERSION) return null;
    const events: ReplayEvent[] = [];
    for (const a of o.ev ?? []) {
      const e = decEvent(a);
      if (!e) return null;
      events.push(e);
    }
    return {
      v: o.v,
      cfg: sanitiseConfig(o.cfg),
      quality: o.q,
      unitScale: o.us,
      count0: o.n0,
      deployPhase: !!o.dp,
      events,
      marks: (o.mk ?? []).map((m: [number, string, string, string, number, number]) => ({
        tick: m[0], hash: m[1], uf64: m[2], uctl: m[3], alive: m[4], count: m[5],
      })),
      ticks: o.tk ?? 0,
      result: o.res ?? null,
    };
  } catch {
    return null;
  }
}

const B64URL = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const UNB64URL = (token: string): Uint8Array => {
  const s = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

const through = async (data: Uint8Array, s: ReadableWritablePair): Promise<Uint8Array> => {
  const blob = new Blob([data as unknown as BlobPart]);
  const buf = await new Response(blob.stream().pipeThrough(s)).arrayBuffer();
  return new Uint8Array(buf);
};

/** gzip + base64url. Short battles fit in a URL; long ones become a `.tcr` download. */
export async function encodeReplay(r: ReplayRecord): Promise<string> {
  const raw = new TextEncoder().encode(replayToJson(r));
  return B64URL(await through(raw, new CompressionStream('gzip')));
}

export async function decodeReplay(token: string): Promise<ReplayRecord | null> {
  try {
    const gz = UNB64URL(token.trim());
    const raw = await through(gz, new DecompressionStream('gzip'));
    return replayFromJson(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/** The order a UI hands over. The same shape `orderIssued` carries, minus provenance. */
export interface PlayerOrder {
  unitIds: number[];
  kind: GameEvents['orderIssued']['kind'];
  x?: number;
  z?: number;
  facing?: number;
  targetUnitId?: number;
  formation?: string;
  ability?: string;
  width?: number;
  queued?: boolean;
  running?: boolean;
}

/** The two `Siege` countermands `H` has to fire before the halt reaches `BattleSystem`. */
export interface WallCountermand {
  cancelWallPlan?(unitId: number): void;
  releaseEscalade?(unitId: number): void;
}

interface MachineSink {
  requestMachineOrder(unitId: number, x: number, z: number): void;
}

interface DeployVerbs {
  active: boolean;
  add(typeId: string, x?: number, z?: number, facing?: number): number;
  place(unitId: number, x: number, z: number, facing: number, width?: number): boolean;
  remove(unitId: number): boolean;
  setFormation(unitId: number, formationId: string): boolean;
  commit(): void;
}

/** Ticks between checkpoints. 30 s at 30 Hz — the grid `determinism-baseline.json` uses. */
const MARK_EVERY = 900;

export type ReplayMode = 'record' | 'play' | 'commanded';

export class ReplaySystem implements Subsystem {
  readonly name = 'replay';
  /**
   * Ahead of `BattleSystem` (10), which is the first system in the tree with a
   * `fixedUpdate`. So the drain below is the first thing that happens in a tick, and every
   * order in the log lands at a point in the tick sequence that a frame boundary cannot move.
   */
  readonly order = 5;

  /** Index of the tick that is about to run. Zero before the first one. */
  tick = 0;

  /** What this run is doing. `commanded` means a replay the player has taken over. */
  mode: ReplayMode = 'record';

  /** Set when a record refuses to play, so the UI can say why in one sentence. */
  refusal = '';

  private ctx!: EngineContext;
  private battle: BattleSystem | null = null;
  private deployment: DeployVerbs | null = null;
  private machines: MachineSink | null = null;
  private wall: WallCountermand | null = null;

  private queued: ReplayEvent[] = [];
  private log: ReplayEvent[] = [];
  private marks: ReplayMark[] = [];
  private nextMark = 0;

  private feed: ReplayEvent[] = [];
  private feedAt = 0;
  private takeoverTick = Number.POSITIVE_INFINITY;

  private header: { quality: QualityTier; cfg: BattleConfig } | null = null;
  private unitScale = 1;
  private deployPhase = false;

  /** The played record's own checkpoints, compared as they come round. */
  private expect: ReplayMark[] = [];
  private expectAt = 0;
  /** First checkpoint at which a playback stopped matching its record. -1 while it holds. */
  divergedAt = -1;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    // `order` sorts this system's `init` ahead of everything it talks to, so these are
    // references taken now and dereferenced later rather than state read now.
    this.battle = (ctx.tryGet('battle') as unknown as BattleSystem) ?? null;
  }

  /**
   * Bind the record's header. Called from `main.ts` once the scenario has laid the armies
   * out, because `unitSizeScale` and `pool.count` are only final then.
   */
  begin(cfg: BattleConfig, quality: QualityTier, deployPhase: boolean): void {
    this.header = { cfg, quality };
    this.deployPhase = deployPhase;
    this.unitScale = this.battle?.unitSizeScale ?? 1;
  }

  /** Late binding for the three things the queue drives that are not the event bus. */
  bindDeployment(d: DeployVerbs): void { this.deployment = d; }
  bindMachines(m: MachineSink): void { this.machines = m; }
  bindWall(w: WallCountermand): void { this.wall = w; }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * A player order. Quantised here and applied at the top of the next tick.
   *
   * Both halves matter. Quantising here rather than at write time means live play and
   * playback push the identical float64 into `applyOrder`; deferring to the tick means the
   * order has a tick number rather than landing in the gap after a frame's ticks, which is
   * where every player order in this game has landed until now — tick-adjacent by accident
   * of subsystem ordering, never tick-numbered.
   *
   * For a player this is a behavioural no-op: `Engine.frame` runs every `fixedUpdate` before
   * any `update`, so an order raised in `update` already lands between the last tick of one
   * frame and the first of the next. This puts it at the top of that same tick.
   */
  issue(o: PlayerOrder, opts?: { countermandWall?: boolean }): void {
    // A record being watched is not being played. Orders arrive only after a takeover.
    if (this.mode === 'play') return;
    const e: ReplayEvent = { k: 'order', t: this.tick, kind: o.kind, unitIds: o.unitIds.slice() };
    if (o.x !== undefined && o.z !== undefined) { e.qx = quantXZ(o.x); e.qz = quantXZ(o.z); }
    if (o.facing !== undefined) e.qf = quantAngle(o.facing);
    if (o.width !== undefined) e.width = Math.max(1, Math.round(o.width));
    if (o.targetUnitId !== undefined) e.targetUnitId = o.targetUnitId;
    if (o.formation !== undefined) e.s = o.formation;
    else if (o.ability !== undefined) e.s = o.ability;
    if (o.queued) e.queued = true;
    if (o.running) e.running = true;
    if (opts?.countermandWall) e.countermandWall = true;
    this.push(e);
  }

  /** A siege-machine order — the one player command that has no `orderIssued` shape. */
  machineOrder(unitId: number, x: number, z: number): void {
    if (this.mode === 'play') return;
    this.push({ k: 'machine', t: this.tick, unitId, qx: quantXZ(x), qz: quantXZ(z) });
  }

  /**
   * A deployment operation, recorded but *not* deferred.
   *
   * The clock is stopped during deployment — that is what the phase is — so there is no
   * next tick to defer to and nothing to defer past. What has to be canonical here is the
   * sequence, and the sequence is the array.
   */
  noteDeploy(e: Omit<DeployEvent, 't'>): void {
    if (this.mode === 'play') return;
    this.log.push({ k: 'deploy', t: this.tick, ...e });
  }

  private push(e: ReplayEvent): void {
    /*
     * A paused clock will never reach another `fixedUpdate`, so queueing here would hold
     * the order until the player un-paused — which is not what pressing H while paused
     * means. Applied at once instead, and stamped with the tick that is about to run: with
     * no ticks in between, "now" and "the top of tick N" are the same point in the sequence,
     * which is exactly what playback will reproduce.
     */
    if (this.ctx.time.paused) { this.apply(e); return; }
    this.queued.push(e);
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  fixedUpdate(): void {
    this.mark();
    this.pump();
    if (this.queued.length) {
      // Spliced empty before dispatch: `applyOrder` can re-enter this system through a UI
      // probe, and an order issued by an order must go to the *next* tick, not to the tail
      // of the batch being drained.
      const batch = this.queued;
      this.queued = [];
      for (const e of batch) this.apply(e);
    }
    this.tick++;
  }

  /**
   * The deployment phase, driven from the render loop because the clock is stopped.
   *
   * Only while `deployment.active`, and only in playback: everything else waits for a tick.
   */
  update(): void {
    if (this.mode !== 'play') return;
    if (!this.deployment?.active) return;
    this.pump();
  }

  private pump(): void {
    if (this.mode !== 'play') return;
    /*
     * The handover, and it has to flip the mode rather than merely stop feeding.
     *
     * `issue` refuses a player order while the mode is `play`, because a click during a
     * playback is a mis-click rather than a command. If reaching the handover tick only
     * stopped the feed, the army would be nobody's: the log silent and the player ignored.
     */
    if (this.tick >= this.takeoverTick) { this.mode = 'commanded'; return; }
    while (this.feedAt < this.feed.length) {
      const e = this.feed[this.feedAt];
      if (e.t > this.tick) break;
      this.feedAt++;
      this.apply(e);
    }
    // The log has run out on its own. Anything after this is the player's, if they want it.
    if (this.feedAt >= this.feed.length) this.mode = 'commanded';
  }

  private apply(e: ReplayEvent): void {
    this.log.push(e);
    if (e.k === 'order') this.dispatchOrder(e);
    else if (e.k === 'machine') this.machines?.requestMachineOrder(e.unitId, dequantXZ(e.qx), dequantXZ(e.qz));
    else this.dispatchDeploy(e);
  }

  private dispatchOrder(e: OrderEvent): void {
    /*
     * The wall countermand, and why it is here rather than in the HUD.
     *
     * `SelectionController.issueHalt` used to call `cancelWallPlan` and `releaseEscalade`
     * itself, from the update phase, outside any tick — two writes to `Siege`'s private maps
     * that no recorder could see and no replay could reproduce. Moving them here puts them
     * inside the tick without inverting the ordering the original comment insists on: they
     * still run *before* the halt reaches `BattleSystem`, which is what makes the halt stick.
     */
    if (e.countermandWall && this.wall) {
      for (const id of e.unitIds) {
        this.wall.cancelWallPlan?.(id);
        this.wall.releaseEscalade?.(id);
      }
    }
    const p: GameEvents['orderIssued'] = { unitIds: e.unitIds, kind: e.kind, source: 'local' };
    if (e.qx !== undefined) { p.x = dequantXZ(e.qx); p.z = dequantXZ(e.qz!); }
    if (e.qf !== undefined) p.facing = dequantAngle(e.qf);
    if (e.width !== undefined) p.width = e.width;
    if (e.targetUnitId !== undefined) p.targetUnitId = e.targetUnitId;
    if (e.s !== undefined) {
      if (e.kind === 'ability') p.ability = e.s;
      else p.formation = e.s;
    }
    if (e.queued) p.queued = true;
    if (e.running) p.running = true;
    this.ctx.events.emit('orderIssued', p);
  }

  private dispatchDeploy(e: DeployEvent): void {
    const d = this.deployment;
    if (!d) return;
    switch (e.verb) {
      case 'add': {
        const got = d.add(e.typeId ?? '', e.qx === undefined ? undefined : dequantXZ(e.qx),
          e.qz === undefined ? undefined : dequantXZ(e.qz),
          e.qf === undefined ? undefined : dequantAngle(e.qf));
        if (e.gotId !== undefined && got !== e.gotId) {
          this.fail(`deployment minted unit ${got} where the record has ${e.gotId}`);
        }
        break;
      }
      case 'place':
        d.place(e.unitId ?? -1, dequantXZ(e.qx ?? 0), dequantXZ(e.qz ?? 0),
          dequantAngle(e.qf ?? 0), e.width || undefined);
        break;
      case 'remove': d.remove(e.unitId ?? -1); break;
      case 'formation': d.setFormation(e.unitId ?? -1, e.formation ?? ''); break;
      case 'commit': d.commit(); break;
    }
  }

  /**
   * A checkpoint, and — during a playback — the comparison that makes this a gate.
   *
   * The record carries a mark every 900 ticks and a playback recomputes them on the same
   * grid, so a divergence is named at the checkpoint it first appears at rather than at the
   * end of the battle. That is the whole instrument: an out-of-band mutation nobody
   * recorded shows up here, on a specific tick, in whichever of the three hashes it reached.
   */
  private mark(): void {
    if (this.tick < this.nextMark) return;
    this.nextMark = this.tick + MARK_EVERY;
    const m = this.snapshotMark();
    this.marks.push(m);

    while (this.expectAt < this.expect.length && this.expect[this.expectAt].tick < m.tick) {
      this.expectAt++;
    }
    const want = this.expect[this.expectAt];
    // Past a takeover the battle is legitimately a different one; comparing would be a lie.
    if (!want || want.tick !== m.tick || this.tick >= this.takeoverTick) return;
    this.expectAt++;
    if (want.hash === m.hash && want.uf64 === m.uf64 && want.uctl === m.uctl) return;
    if (this.divergedAt >= 0) return;
    this.divergedAt = m.tick;
    const which = want.hash !== m.hash ? 'pool'
      : want.uctl !== m.uctl ? 'unit control flow' : 'unit float64';
    this.fail(m.tick === 0
      ? `this record was made by a different build: the armies differ before a tick has run`
        + ` (${which}; recorded ${want.hash}/${want.uf64}/${want.uctl},`
        + ` here ${m.hash}/${m.uf64}/${m.uctl})`
      : `playback left the record at tick ${m.tick} (${which}; recorded`
        + ` ${want.hash}/${want.uf64}/${want.uctl}, here ${m.hash}/${m.uf64}/${m.uctl})`);
  }

  private snapshotMark(): ReplayMark {
    const b = this.battle!;
    const h = stateHashes(b.pool, b.units);
    return { tick: this.tick, hash: h.hash, uf64: h.uf64, uctl: h.uctl, alive: h.alive, count: h.count };
  }

  private fail(why: string): void {
    this.refusal = why;
    console.error(`[replay] ${why}`);
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /**
   * Play a record. Refuses rather than silently playing a different battle.
   *
   * The refusal is from §7.5 of the design and it caught two things: a build that produces a
   * different army for the same config, and a quality tier that could not hold the recorded
   * one. It now catches the first only, and that is the fix rather than a regression — the
   * second was a graphics setting changing the battle, and the soldier pool no longer depends
   * on the tier. A record made on a weak machine plays on a strong one and back again.
   */
  play(r: ReplayRecord, opts: { fromTick?: number } = {}): boolean {
    /*
     * The army refusal, before a tick has run.
     *
     * This used to fire on a tier mismatch: `fittedUnitScale` would cheerfully fit 1,515 men on
     * `low` where 8,632 were recorded on `high`, and the result was a battle that looked
     * entirely plausible and was not the one in the file. It cannot fire for that reason any
     * more — the pool is tier-independent — and the comparison is kept because the *build* can
     * still move the fitted scale: a roster strength edited, a unit added to a composition, a
     * `UNIT_SIZES` multiplier retuned. That is precisely the case where a silent substitution
     * would be worst, because nothing in the record's own name would say so.
     */
    if (Math.abs(r.unitScale - this.unitScale) > 1e-9) {
      this.fail(`this record was made at unit scale ${r.unitScale} (quality '${r.quality}');`
        + ` this build fits ${this.unitScale} for the same config.`
        + ` It would be ${r.count0} men against a different army.`);
      return false;
    }
    this.expect = r.marks;
    this.expectAt = 0;
    this.feed = r.events;
    this.feedAt = 0;
    this.takeoverTick = opts.fromTick ?? Number.POSITIVE_INFINITY;
    this.mode = this.takeoverTick <= 0 ? 'commanded' : 'play';
    // The player's own log starts empty and is rebuilt from the feed as it is applied, so a
    // finished playback yields a record equal to the one it played. A takeover yields that
    // prefix plus whatever the player then did, which is the whole of "take command".
    this.log = [];
    return true;
  }

  /** Stop feeding and hand the army over at the tick this is called on. */
  takeCommand(): void {
    if (this.mode !== 'play') return;
    this.takeoverTick = this.tick;
    this.mode = 'commanded';
  }

  /** How much of the feed is left, for the UI's scrub readout. */
  get remaining(): number { return Math.max(0, this.feed.length - this.feedAt); }
  get playing(): boolean { return this.mode === 'play'; }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** The record as it stands. Safe to call at any moment, including mid-battle. */
  record(): ReplayRecord | null {
    if (!this.header || !this.battle) return null;
    const marks = this.marks.slice();
    // Always close on the current state: a record whose last checkpoint is 29 s before the
    // end proves nothing about the end.
    if (!marks.length || marks[marks.length - 1].tick !== this.tick) marks.push(this.snapshotMark());
    const count0 = marks.length ? marks[0].count : 0;
    const flow = this.ctx.tryGet('battleFlow') as unknown as
      { result: null | { victor: number; reason: string; at: number;
        survivors: Record<number, number>; casualties: Record<number, number> } } | undefined;
    const res = flow?.result ?? null;
    return {
      v: REPLAY_VERSION,
      cfg: this.header.cfg,
      quality: this.header.quality,
      unitScale: this.unitScale,
      count0,
      deployPhase: this.deployPhase,
      events: this.log.slice(),
      marks,
      ticks: this.tick,
      result: res
        ? { victor: res.victor, reason: res.reason, at: res.at,
          survivors: res.survivors, casualties: res.casualties }
        : null,
    };
  }

  /** The shareable token: gzip, base64url. */
  async token(): Promise<string> {
    const r = this.record();
    return r ? encodeReplay(r) : '';
  }
}
