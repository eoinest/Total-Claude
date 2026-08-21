import type { SoldierPool, UnitGroupState } from './types';

/**
 * The determinism marks, in the product rather than in the harness.
 *
 * `tools/qa-determinism.mjs` used to inject all of this as a template string through
 * `page.evaluate`, so the only copy of the project's canonical state hash lived in a test
 * tool and nothing in `src/` could compute it. That is this project's recurring failure
 * mode — the capability is in the instrument — and it bites the moment a second consumer
 * appears. `tools/qa-replay.mjs` is that second consumer, and a replay gate that hashes
 * with its own private copy of these forty lines is a gate that can pass while the other
 * one fails.
 *
 * So the arithmetic moved here verbatim and both tools now read it off `window.__game`.
 *
 * ## Do not tidy the arithmetic
 *
 * `poolHash` multiplies with `h = (h * 0x01000193) >>> 0`, and above 2^53 that float
 * product rounds — about 87.5% of the products do — so it is **not FNV-1a**, whatever it
 * looks like. It is deterministic, its avalanche measured clean, and twenty-one recorded
 * hashes in `tools/determinism-baseline.json` are keyed to it. Replacing it with
 * `Math.imul` for a few percent silently invalidates every one of them. `unitHash` below
 * *is* real FNV-1a, via `Math.imul`, because it was written later and had nothing pinned
 * to it at the time; the two being different is deliberate and load-bearing.
 */

/** Both halves of a checkpoint: the float32 pool and the float64 unit layer. */
export interface StateHashes {
  /** FNV-ish over the float32 pool: x, z, state, hp. The pinned one. */
  hash: string;
  /** Pool slots in use. */
  count: number;
  /** Men not dying and not dead. */
  alive: number;
  /** Exact float64 bits of every continuous `UnitGroupState` field, plus the waypoints. */
  uf64: string;
  /** The discrete half — what the battle decided rather than where the arithmetic put it. */
  uctl: string;
  /** Units in `battle.units`, whose array order is itself hashed. */
  units: number;
}

/**
 * The continuous fields. Integrated in place with no quantisation step, which is why they
 * drift between browser engines within a second of simulated time while the float32 pool
 * holds for six thousand ticks.
 */
export const UNIT_F64_FIELDS = [
  'x', 'z', 'facing', 'targetX', 'targetZ', 'targetFacing',
  'morale', 'maxMorale', 'fatigue', 'ammo', 'chargeTimer', 'routTimer',
  'spacingX', 'spacingZ',
] as const;

/**
 * The discrete half. Robust to exactly the thing `uf64` is brittle to: a 1-ULP libm
 * difference at the true measured magnitude moves the pool hash at frame 3,519 and produces
 * no control-flow difference at all in 6,000 frames.
 *
 * `selected` is deliberately absent from both lists: it is UI state, written by
 * `SelectionController` outside any fixed step, and hashing it would make a mouse click
 * look like a desync.
 */
export const UNIT_CTL_FIELDS = [
  'id', 'typeId', 'faction', 'order', 'targetUnitId', 'width', 'alive',
  'initialStrength', 'kills', 'formationId',
  'running', 'engaged', 'contactLock', 'charging', 'destroyed', 'concealed',
] as const;

/** `SoldierState.Dying` and `SoldierState.Dead`, spelled as the numbers the gate pins. */
const DYING = 10;
const DEAD = 11;

const POOL_DV = new DataView(new ArrayBuffer(4));

/**
 * The pinned pool hash. Reads the exact float32 bit patterns through a DataView rather than
 * any decimal rendering, so a 1-ULP drift is caught rather than rounded away.
 */
export function poolHash(p: SoldierPool): { hash: string; count: number; alive: number } {
  let h = 0x811c9dc5;
  const mix = (u: number): void => {
    h ^= u & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (u >>> 8) & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0;
  };
  const f = (v: number): void => { POOL_DV.setFloat32(0, v); mix(POOL_DV.getUint32(0)); };
  let alive = 0;
  for (let i = 0; i < p.count; i++) {
    f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]);
    if (p.state[i] !== DYING && p.state[i] !== DEAD) alive++;
  }
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: p.count, alive };
}

const UNIT_DV = new DataView(new ArrayBuffer(8));

interface Fnv {
  u32(u: number): void;
  f64(v: number): void;
  bool(v: boolean): void;
  str(s: unknown): void;
  hex(): string;
}

const fnv = (): Fnv => {
  let h = 0x811c9dc5;
  const b = (u: number): void => { h = Math.imul(h ^ (u & 0xff), 0x01000193) >>> 0; };
  const u32 = (u: number): void => { b(u); b(u >>> 8); b(u >>> 16); b(u >>> 24); };
  return {
    u32,
    f64: (v) => { UNIT_DV.setFloat64(0, v); u32(UNIT_DV.getUint32(0)); u32(UNIT_DV.getUint32(4)); },
    bool: (v) => b(v ? 1 : 0),
    str: (s) => { const t = String(s); for (let k = 0; k < t.length; k++) u32(t.charCodeAt(k)); b(0); },
    hex: () => (h >>> 0).toString(16).padStart(8, '0'),
  };
};

/**
 * The two unit-layer hashes.
 *
 * Array order is hashed, not sorted away: `battle.units` is iterated in place by the tick
 * loop, so its order is simulation state in the same way a `Map`'s insertion order is, and
 * sorting by id here would hide a reordering rather than report it.
 */
export function unitHash(units: readonly UnitGroupState[]): {
  uf64: string; uctl: string; units: number;
} {
  const f = fnv();
  const c = fnv();
  for (const u of units) {
    const rec = u as unknown as Record<string, unknown>;
    for (const k of UNIT_F64_FIELDS) f.f64(rec[k] as number);
    const wp = u.waypoints ?? [];
    f.u32(wp.length);
    for (let i = 0; i < wp.length; i++) f.f64(wp[i]);

    for (const k of UNIT_CTL_FIELDS) {
      const v = rec[k];
      if (typeof v === 'string') c.str(v);
      else if (typeof v === 'boolean') c.bool(v);
      else c.f64(v as number);
    }
    const mem = u.members ?? [];
    c.u32(mem.length);
    for (let i = 0; i < mem.length; i++) c.u32(mem[i]);
  }
  return { uf64: f.hex(), uctl: c.hex(), units: units.length };
}

/** Both halves at once. About 0.15 ms for the pool and 0.1 ms for the units at 8,632 men. */
export function stateHashes(p: SoldierPool, units: readonly UnitGroupState[]): StateHashes {
  return { ...poolHash(p), ...unitHash(units) };
}
