import type { Subsystem } from '../core/Engine';
import { UNIT_F64_FIELDS } from './stateHash';
import type { BattleSystem } from './BattleSystem';
import type { UnitGroupState } from './types';

/**
 * The unit layer's quantisation firewall — the one the soldier pool has always had.
 *
 * ## Why this exists
 *
 * `SoldierPool` is typed arrays. Every tick reads float32, computes in float64, writes float32
 * back. That round trip is a firewall: a 1-ULP double disagreement between two browser engines
 * (2.2e-16 relative) survives the write to float32 (quantum 1.19e-7) only when the two doubles
 * straddle a rounding boundary, which is roughly 2e-9 of the time. It is the entire reason three
 * engines agree bit-for-bit on eight thousand men for six thousand ticks.
 *
 * `UnitGroupState` is on the other side of it. `x`, `z`, `facing`, `targetX`, `targetZ`,
 * `targetFacing`, `morale`, `fatigue`, `ammo`, `chargeTimer`, `routTimer`, `spacingX`,
 * `spacingZ` are plain JavaScript doubles, integrated in place, with **no quantisation step
 * anywhere**. So the simulation's own state has been engine-dependent from about one second of
 * simulated time, and only its float32 projection was not — which is the only thing any gate
 * here hashed until `uf64` was added.
 *
 * Measured with `tools/qa-xengine.mjs` on the default field battle at 8,632 men, after
 * `Math.hypot` had been removed from every scanned directory: the pool hash and `uctl` are
 * **identical in Chromium 151, Firefox 153 and WebKit 26.5 at t+0, 30, 90, 150 and 200**, and
 * all three are apart by t+250 — 5,849 against 5,560 against 5,886 survivors by t+400. And
 * `uf64` was already apart at **t+30**, one hundred and seventy simulated seconds before the
 * pool hash could see it. The leak is this layer, and the fix is not a smaller epsilon
 * somewhere: it is to give this layer the firewall the other one has.
 *
 * `docs/MULTIPLAYER.md` §3 Stage 3 names it and prices it inside a 3–5 week vendored-libm
 * project. It is not a 3–5 week job. It is this file.
 *
 * ## Why order 60
 *
 * It has to be the last thing in the tick that touches a unit. The systems that write
 * `UnitGroupState` inside `fixedUpdate` are `BattleSystem` (10), `Combat` (20), `Projectiles`
 * (25), `Morale` (30), `Abilities` (35), and the two AIs at 42 and 45 — which emit
 * `orderIssued` *synchronously*, so their orders land through `BattleSystem`'s handler after
 * `BattleSystem` itself has run. `BattleFlow` reads at 50. So 60 is after every writer and
 * before `Ragdoll` (120) and everything render-side.
 *
 * Running it earlier would leave whatever the AI wrote afterwards unquantised, which is the
 * failure mode where a firewall exists and does nothing — and it would be invisible, because
 * the pool hash would still hold for thousands of ticks.
 *
 * ## Why the field list is imported and not written here
 *
 * `UNIT_F64_FIELDS` is the list `uf64` hashes. Importing it makes one invariant true by
 * construction: **the float64 state that is hashed is exactly the float64 state that is
 * quantised.** A local copy would drift, and it would drift in the direction that hides the
 * problem — a field added to the hash but not to the firewall reads as a portability failure
 * with no cause, and a field added to the firewall but not the hash is never checked at all.
 *
 * ## What this costs, and what would change my mind
 *
 * It is a behaviour change to three shipped battles and it moves every pinned checkpoint hash,
 * on purpose. Float32 quantum at these magnitudes: **0.12 mm** on a position bounded by
 * `HALF_EXTENT = 1400` (against a 0.72 m rank pitch), **1.2e-7 rad** on a bearing, **6e-8** on a
 * morale or fatigue value in 0..1. Every one of those is far below anything a player or a
 * balance number can resolve, which is why this is the cheap fix rather than an expensive one.
 *
 * What it does *not* buy is exactness through a discrete decision. A unit whose morale sits
 * within 6e-8 of a break threshold can still break in one engine and hold in the other, because
 * quantising reduces the probability of a straddle to about 2e-9 per field per tick rather than
 * to zero. This is the same bound the pool has always had, and the pool held for six thousand
 * ticks, so the bound is worth having. **It is a firewall, not a proof.**
 *
 * What would change my mind about doing it this way: a measurement showing the fork merely
 * moves later rather than going away — say the field battle identical to t+400 and apart by
 * t+600. That would mean quantisation is buying time rather than portability, and the answer
 * would be the vendored transcendentals of Stage 3 after all, with this kept as the cheap half.
 */
/**
 * Snap one unit's float64 state to float32. The rule is **quantised at birth and at the end of
 * every tick it survives**, and `spawnUnit` is the birth half.
 *
 * Birth is not a detail. `deployBattle` runs in `main.ts`'s `boot()` *after* `engine.initAll`,
 * so a firewall that only existed inside `fixedUpdate` — or inside this system's own `init` —
 * left the whole deployed order of battle unquantised at t+0, which is the checkpoint a lobby
 * handshake and the replay record's refusal both key on. Measured: it left 26 float64 fields on
 * the Carthage assault, all `facing` and `targetFacing`, differing by 1 ULP between Chromium and
 * Firefox, from thirteen boot-time `Math.atan2(m.nx, m.nz)` calls in `deployAssault`. Quantising
 * in `spawnUnit` closes it wherever a unit comes from — the scenario, the deployment phase, or
 * anything added later — instead of at the one call site somebody remembered.
 */
export function quantiseUnit(u: UnitGroupState): void {
  const rec = u as unknown as Record<string, number>;
  for (let k = 0; k < UNIT_F64_FIELDS.length; k++) {
    const f = UNIT_F64_FIELDS[k];
    rec[f] = Math.fround(rec[f]);
  }
  /*
   * The waypoint queue is hashed by `uf64` too, and an order's coordinates are already
   * snapped to int16 over ±1400 m on the way in, so these do not drift. Quantising them
   * anyway is what makes the invariant total: everything `uf64` reads is float32.
   */
  const wp = u.waypoints;
  if (wp) for (let j = 0; j < wp.length; j++) wp[j] = Math.fround(wp[j]);
}

/*
 * ## The one writer that is outside this firewall, and why it does not need to be inside it
 *
 * `DeploymentSystem` is order **690** — after this system — and it writes `x`, `z`, `facing` and
 * `targetFacing` straight onto an existing unit in `place()`. It also has no `fixedUpdate` at
 * all: the clock is stopped for the whole deployment phase, so those writes happen outside any
 * tick, and **t+0 is hashed before this system has ever run once**. A unit the player dragged is
 * therefore in the t+0 hash carrying a plain double.
 *
 * That is safe, and it is safe for a reason rather than by luck. Every coordinate reaching
 * `place()` has been through `dequantXZ(quantXZ(v))` and every bearing through
 * `dequantAngle(quantAngle(a))`, and both dequantisers are a single division by a constant.
 * IEEE-754 requires `/` to be correctly rounded, so every engine computes the identical double
 * from the identical int16 — which is the same argument that makes `Math.sqrt` a control in
 * `qa-xengine`'s libm probe while `Math.hypot` is a hazard. The value is not float32, and it does
 * not need to be: portability here comes from the wire format, not from this file.
 *
 * If a future deployment verb ever writes a coordinate that did **not** come through the int16
 * round trip — a snap to terrain, a formation re-fit, anything with a transcendental in it —
 * that reasoning stops holding and this system's order, or a `quantiseUnit` call in `place()`,
 * becomes load-bearing.
 */

/** The same, over the whole order of battle. */
export function quantiseUnits(units: readonly UnitGroupState[]): void {
  for (let i = 0; i < units.length; i++) quantiseUnit(units[i]);
}

export class UnitQuantiseSystem implements Subsystem {
  readonly name = 'unit-quantise';

  /** After every writer of `UnitGroupState` in a tick, before anything render-side. */
  readonly order = 60;

  constructor(private readonly battle: BattleSystem) {}

  /*
   * Boot is `BattleSystem.spawnUnit`'s job, not this one's. A pass in `init` here would run at
   * the right *order* and the wrong *time*: `deployBattle` is called from `boot()` after
   * `engine.initAll` has returned, so at `init` there is no order of battle to quantise. That
   * was tried, measured, and left 26 boot-time float64 fields differing across engines at t+0.
   */
  fixedUpdate(): void {
    quantiseUnits(this.battle.units);
  }
}
