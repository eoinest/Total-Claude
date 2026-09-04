/**
 * Who stands where, when the shape moves.
 *
 * ## The bug this exists for
 *
 * `formations.ts` gives a slot's offset **in the unit's own frame**, and
 * `BattleSystem.steerSoldiers` turns that into a world position by rotating it through
 * `u.facing`. A soldier's slot index, meanwhile, was written once in `spawnUnit` and never
 * again: `p.slot[i]` had exactly two writers in the whole tree, both of them at birth.
 *
 * So a change of facing moved every slot in the world and left every man bound to the slot
 * he was born in. A 180-degree order reflected the lattice through the anchor — and because
 * the anchor is the **centre of the front rank**, not the centre of the block, the reflection
 * also threw the whole body forward by its own depth. The men then walked to wherever their
 * own slot had gone, which for a front-rank flanker is the far corner of the formation plus
 * the length of it again.
 *
 * Measured before this file existed (`tools/probe-aboutface.mjs`, tree 4364c00), one 160-man
 * legionary cohort standing at ease and ordered to about-face: **median man walked 20.45 m
 * and 92 of 160 ended up further from where they stood than half their own unit is wide**,
 * with the block's centroid 4.75 m from where it started and its along-facing extent moved
 * from -5.21..0.10 to -0.16..5.28 — the whole slab, forward by its own depth. Sixty Roman
 * cavalry: median 27.50 m, 38 of 60 across the block. A real squadron of the shipped field
 * battle, in wedge, with the two AIs silenced so the order under test is the only order it
 * has: **median 48.28 m walked, 108 of 120 across, centroid 33.59 m**.
 *
 * The same squadron with the AIs left running walked 85.85 m and moved its centroid 85.19 m,
 * and that figure is written down here because it is the one the *owner* would see and
 * because it nearly wasted the measurement: the first cut of `--live` did not stop the
 * generals, so it was watching a unit execute its own attack order and reported 85 m before
 * and 85 m after. A probe whose subject is being commanded by somebody else is not measuring
 * the order it issued.
 *
 * That is the owner's first report — "my friend was trying to control the cavalry but they
 * kept running away; they were not routed, but they would not turn around to face" — with
 * nothing in it about cavalry except that cavalry are the fastest thing on the field and so
 * cover the same wrong distance soonest.
 *
 * ## What it does instead
 *
 * Re-solves which man holds which slot so that the men **already standing on the ground the
 * new shape wants** keep it. For a 180-degree turn of a rectangular block about its own
 * centre the answer is exact and free: slot (rank r, file f) becomes slot (ranks-1-r,
 * width-1-f), which is a slot that exists and whose world position is where the man is
 * already standing. Nobody walks. Everybody turns.
 *
 * ## Why each man asks for a place rather than being dealt one
 *
 * The optimal assignment is the linear assignment problem, which is O(n^3) for 320 men and
 * would have to be re-run whenever the shape moved. The two point sets here are a *lattice*
 * and *men who are nearly on that lattice*, so something much cheaper will do — but the
 * obvious cheap thing does not work, and it is worth writing down why, because it was
 * written, measured and thrown away.
 *
 * **The obvious cheap thing.** Sort the men the way the slots are sorted — by rank, then by
 * file — and hand out slots in that order. It is O(n log n) and it is exactly right when
 * every rank is full. **A unit's last rank is almost never full.** A 160-man cohort 29 wide
 * is five ranks of 29 and one of 15, and `line.offset` puts that short rank at the *back*,
 * left-aligned. Reflect the block and the short rank is at the *front*, where the lattice
 * wants 29 men — so the sorted hand-out puts fifteen men in the front rank and then shifts
 * **every one of the remaining 145 by fourteen slots**, which inside a rank is fourteen
 * files, which is twelve metres. Measured: median travel 10.45 m on a turn whose right
 * answer is nought. The sort minimises the difference in *slot number*, and slot number is
 * a terrible proxy for distance — one file is 0.86 m and one whole rank is 1.02 m, but they
 * are 1 and 29 apart in the index.
 *
 * **What it does instead.** Each man works out the rank and file he is *standing in* and
 * asks for that slot. Almost every man gets it, because after a 180-degree turn about the
 * block's own centre almost every man is already standing on a slot. The few who cannot —
 * the fourteen the short rank displaces — are matched to what is left over in lattice
 * order, which sends them the one place there is room, a rank at a time rather than a
 * frontage at a time. Same O(n log n), and the median man does not move.
 *
 * ## Determinism, which is the whole reason this is written the way it is
 *
 * Multiplayer is lockstep, so both peers must compute the identical permutation from the
 * identical state. Three rules, all of them visible in `assignSlots` below:
 *
 * 1. **No identity-keyed iteration.** No `Set`, no `Map`, no object keys. The inputs are the
 *    unit's own `members` array and the pool's typed arrays, both of which have a fixed order.
 *
 * 2. **The sort key is an integer, and the sort is total.** The rank and file it is built
 *    from are `Math.round` of a lattice coordinate, and the tie-break is the man's position
 *    in `members`, which is unique — so no two keys can be equal and stability never has to
 *    be relied on. The three are packed into a single float64 that is exactly representable
 *    (< 2^53), so the sort compares integers even though the array is `Float64Array`.
 *
 * 3. **The floats that become decisions are not near a boundary, by construction.** Two
 *    decisions are made from floats: which rank band a man is in (`Math.round(-lz/sz)`), and
 *    which slot in it is nearest him (a `<` on squared distance). A man standing exactly on
 *    a slot gives `-lz/sz = r` *exactly* and is nearer his own slot than any other by a
 *    whole cell. Dressing error moves him a fifth of a cell; the crowd solver a little more.
 *    The hazard is a cross-engine `Math.sin`/`Math.cos` disagreement, which
 *    `tools/check-determinism.mjs` measures at 1 ULP on 4% of calls: 1 ULP of a 20 m
 *    coordinate is 2e-15 m, so either decision can only flip for a man who is within
 *    2.5e-15 of a boundary — a half-rank line, or the perpendicular bisector of two slots.
 *    Across 8,632 men that is order 1e-9 per re-solve, the same bound the float32 pool
 *    firewall has always run at, and for the same reason it is a firewall and not a proof.
 *    The rank round is *biased away* from its boundary and the distance compare is not,
 *    which is why the rank band is the coarse decision and the slot is the fine one rather
 *    than the other way round.
 *
 * `Array.prototype.sort` is not used, and neither is a comparator: a typed array's own
 * `sort()` with no argument is numeric ascending, which is defined by the specification and
 * not by the engine.
 */

import type { FormationDef } from './formations';
import { SoldierState, type SoldierPool } from './types';

/**
 * Lattice coordinates are packed as `rank * FILE_STRIDE + file`, and both are clamped to
 * +-`COORD_LIMIT` cells first.
 *
 * 4096 cells of the tightest spacing in the game (testudo's 0.516 m file pitch) is 2.1 km,
 * which is past the 1.4 km half-extent of the world, so the clamp can only ever catch a man
 * whose position is already nonsense. It exists so the packed key stays inside the exactly
 * representable range rather than to express anything about formations.
 */
const COORD_LIMIT = 4096;
const FILE_STRIDE = 16384;
/** Keys are biased positive before packing so the man index can be recovered by remainder. */
const KEY_BIAS = COORD_LIMIT * FILE_STRIDE + COORD_LIMIT;
/** Men per unit the packed key can carry in its low digits. `SoldierPool.slot` is a Uint16. */
const MAN_STRIDE = 65536;

/** One cell of a formation, reused. `offset` writes into it and nothing keeps it. */
const CELL = { x: 0, z: 0 };

/** Scratch, grown on demand. One unit is resolved at a time and nothing is retained. */
let idxBuf = new Int32Array(0);
let slotBuf = new Int32Array(0);
let keyBuf = new Float64Array(0);
let wantBuf = new Int32Array(0);
let takenBuf = new Uint8Array(0);
let freeBuf = new Int32Array(0);
let leftBuf = new Int32Array(0);
/** The lattice itself, in the unit's own frame, one entry per slot. */
let latXBuf = new Float64Array(0);
let latZBuf = new Float64Array(0);
/** Slot indices grouped by rank band, and where each band starts. See `buildLattice`. */
let bandOfBuf = new Int32Array(0);
let bandOrderBuf = new Int32Array(0);
let bandStartBuf = new Int32Array(0);
let bandCursorBuf = new Int32Array(0);

const grow = (n: number): void => {
  if (idxBuf.length >= n) return;
  const cap = Math.max(64, 1 << (32 - Math.clz32(n - 1)));
  idxBuf = new Int32Array(cap);
  slotBuf = new Int32Array(cap);
  keyBuf = new Float64Array(cap);
  wantBuf = new Int32Array(cap);
  takenBuf = new Uint8Array(cap);
  freeBuf = new Int32Array(cap);
  leftBuf = new Int32Array(cap);
  latXBuf = new Float64Array(cap);
  latZBuf = new Float64Array(cap);
  bandOfBuf = new Int32Array(cap);
  bandOrderBuf = new Int32Array(cap);
  // One band per rank plus the end marker; a jittered formation cannot have more bands
  // than it has slots, so the slot capacity bounds this too.
  bandStartBuf = new Int32Array(cap + 2);
  bandCursorBuf = new Int32Array(cap + 2);
};

const clampCell = (v: number): number => (v < -COORD_LIMIT ? -COORD_LIMIT
  : v > COORD_LIMIT ? COORD_LIMIT : v);

/**
 * The middle of a formation's own footprint, in the unit's own frame.
 *
 * This is the point a body of men should turn **about**. The anchor cannot be it: `offset`
 * puts rank 0 at `z = 0` and every rank behind it at negative z, so `u.x, u.z` is the middle
 * of the front rank and a rotation about it walks the block forward by its own depth. That
 * is the measured 4.75 m of centroid drift on a cohort that was ordered to stand still and
 * face the other way.
 *
 * **The midpoint of the extent, and not the mean of the slots.** The two differ whenever the
 * last rank is short, which is nearly always — a 60-horse squadron 18 wide is three ranks of
 * 18 and one of 6, and `offset` left-aligns that short rank, which drags the mean 1.17 m to
 * the left. Turning about the mean therefore shifts the lattice sideways by 1.17 m, every
 * man's nearest slot becomes his neighbour's, and the assignment below has to resolve sixty
 * simultaneous collisions instead of none. Measured with the mean: a 180-degree order moved
 * the median trooper 10.9 m. The extent midpoint is 0 in x for every centred formation, so
 * the reflection maps the lattice onto itself exactly and nobody moves.
 *
 * It is also the better statement of the spec. "The block keeps its footprint" is a claim
 * about the ground the block covers, which is its extent.
 *
 * Computed over the slots rather than over the *living*, deliberately. Dead men keep their
 * slots (see `SoldierPool`), so a centre computed from the survivors would creep every time
 * somebody fell, and a unit taking casualties would drift across the field without ever
 * being given an order. This is a property of the shape, not of the crowd.
 */
export const formationCentroid = (
  f: FormationDef,
  slots: number,
  width: number,
  ranks: number,
  spacingX: number,
  spacingZ: number,
  out: { x: number; z: number }
): void => {
  if (slots <= 0) { out.x = 0; out.z = 0; return; }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let s = 0; s < slots; s++) {
    f.offset(CELL, s, width, ranks, spacingX, spacingZ);
    if (CELL.x < minX) minX = CELL.x;
    if (CELL.x > maxX) maxX = CELL.x;
    if (CELL.z < minZ) minZ = CELL.z;
    if (CELL.z > maxZ) maxZ = CELL.z;
  }
  out.x = (minX + maxX) * 0.5;
  out.z = (minZ + maxZ) * 0.5;
};

/**
 * Lay the formation's slots out in the unit's own frame and index them by rank band.
 *
 * The point of this is that **a formation is not always a grid**, and the code that decides
 * where a man belongs must not assume it is one. `line`, `shieldwall` and `testudo` are
 * grids, so `file = lx / spacingX + (width - 1) / 2` inverts them. `wedge` is rows of 2, 4,
 * 6 … each centred on *its own* width, so that expression is wrong by up to half a formation
 * for every man in it — measured, it made a 180-degree order on a squadron in wedge *worse*
 * than doing nothing. `loose`, `skirmish` and `horde` carry per-slot scatter, and `horde`
 * a sine bulge on top.
 *
 * So nothing is inverted. The slots are laid out, bucketed by the rank band they fall in,
 * and a man is given the nearest one in his own band or the band either side. That is exact
 * for every formation in the game and for anything added later, and it costs one `offset`
 * call per slot plus about three ranks' worth of distance compares per man — only on the
 * ticks where something actually re-formed.
 *
 * Returns the number of bands.
 */
const buildLattice = (
  f: FormationDef,
  slots: number,
  width: number,
  ranks: number,
  spacingX: number,
  spacingZ: number
): number => {
  const bands = ranks < 1 ? 1 : ranks;
  bandStartBuf.fill(0, 0, bands + 2);
  for (let s = 0; s < slots; s++) {
    f.offset(CELL, s, width, ranks, spacingX, spacingZ);
    latXBuf[s] = CELL.x;
    latZBuf[s] = CELL.z;
    const r = Math.round(-CELL.z / spacingZ);
    const b = r < 0 ? 0 : r >= bands ? bands - 1 : r;
    bandOfBuf[s] = b;
    bandStartBuf[b + 1]++;
  }
  for (let b = 0; b < bands; b++) bandStartBuf[b + 1] += bandStartBuf[b];
  for (let b = 0; b <= bands; b++) bandCursorBuf[b] = bandStartBuf[b];
  // Ascending slot index within each band, so a tie on distance always goes to the lower
  // slot and the result does not depend on the order the bands are scanned in.
  for (let s = 0; s < slots; s++) bandOrderBuf[bandCursorBuf[bandOfBuf[s]]++] = s;
  return bands;
};

/**
 * Re-bind this unit's living men to the slots they already hold, chosen so that the man
 * nearest each place in the new shape is the one who takes it.
 *
 * The *set* of slots is not changed — only who holds which. That matters: dead men keep
 * their slots, so the holes a unit has taken stay exactly where they were and this cannot
 * quietly re-pack a mauled cohort into a solid block.
 *
 * `ax, az, facing` are the frame the new shape will be laid out in, which is not necessarily
 * the unit's current one — the caller passes the frame it is about to adopt, so the men are
 * sorted against where the slots are *going* rather than where they have been.
 *
 * Returns the number of men re-bound, or 0 when there was nothing to do.
 */
export const assignSlots = (
  p: SoldierPool,
  members: readonly number[],
  f: FormationDef,
  ax: number,
  az: number,
  cosF: number,
  sinF: number,
  width: number,
  ranks: number,
  spacingX: number,
  spacingZ: number
): number => {
  const total = members.length;
  if (total < 2) return 0;
  grow(total);

  let n = 0;
  for (let k = 0; k < total; k++) {
    const i = members[k];
    const st = p.state[i] as SoldierState;
    if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
    idxBuf[n] = i;
    slotBuf[n] = p.slot[i];
    n++;
  }
  if (n < 2) return 0;

  // The slots these men hold, ascending. Reading them off the men rather than taking
  // 0..n-1 is what preserves the unit's holes: the dead keep their slots, so a mauled
  // cohort's gaps stay exactly where they were instead of being quietly re-packed.
  const slots = slotBuf.subarray(0, n);
  slots.sort();
  // 0 = not a slot this unit holds, 1 = held and free, 2 = claimed. Indexed by slot value.
  takenBuf.fill(0, 0, total);
  for (let k = 0; k < n; k++) takenBuf[slots[k]] = 1;

  const bands = buildLattice(f, total, width, ranks, spacingX, spacingZ);
  const half = (width - 1) * 0.5;
  for (let k = 0; k < n; k++) {
    const i = idxBuf[k];
    const dx = p.x[i] - ax;
    const dz = p.z[i] - az;
    // Into the frame the shape is about to be laid out in: +x is the unit's right, +z is
    // its facing. This is the inverse of `steerSoldiers`' `u.x + ox * c + oz * s`.
    const lx = dx * cosF - dz * sinF;
    const lz = dx * sinF + dz * cosF;
    // Ranks run backwards from the anchor, so the band rises as lz falls.
    const rank = Math.round(-lz / spacingZ);
    const b = rank < 0 ? 0 : rank >= bands ? bands - 1 : rank;
    // The slot he is asking for: the nearest one in his own band or the band either side.
    // Three bands and not one, because a man half a rank forward of his place must still be
    // able to see it, and not all of them, because a rank is 1.02 m and a frontage is 25.
    let lo = b > 0 ? b - 1 : 0;
    let hi = b + 1 < bands ? b + 1 : bands - 1;
    // Three bands can all be empty: `loose`, `skirmish` and `horde` scatter their slots in z
    // as well as x, so a rank band is a bucket that happens to be populated rather than a
    // row that must be. When it is not, ask the whole lattice — for the handful of men that
    // can happen to, and never for a ranked formation.
    if (bandStartBuf[hi + 1] === bandStartBuf[lo]) { lo = 0; hi = bands - 1; }
    let best = 0;
    let bestD2 = Infinity;
    for (let bb = lo; bb <= hi; bb++) {
      const end = bandStartBuf[bb + 1];
      for (let q = bandStartBuf[bb]; q < end; q++) {
        const s = bandOrderBuf[q];
        const ex = latXBuf[s] - lx;
        const ez = latZBuf[s] - lz;
        const d2 = ex * ex + ez * ez;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
      }
    }
    wantBuf[k] = best;
    // And his place in lattice order, which is the order requests are heard in and the
    // order the leftovers are dealt in. Deliberately the raw grid coordinate rather than
    // the slot he asked for: it is an *ordering*, front to back and left to right, and it
    // has to keep a straggler fifty metres off the flank out at the end of the queue
    // instead of sorting him in among the men who are actually in the block.
    keyBuf[k] = (clampCell(rank) * FILE_STRIDE
      + clampCell(Math.round(lx / spacingX + half)) + KEY_BIAS) * MAN_STRIDE + k;
  }

  const keys = keyBuf.subarray(0, n);
  keys.sort();

  const bind = (man: number, s: number): void => {
    const i = idxBuf[man];
    p.slot[i] = s;
    // `rank` and `file` are this man's place in the block and are read by `Projectiles`
    // (may he shoot over the men in front?) and `Combat` (is he close enough to the
    // fighting to want to be in it?). They are derived from the slot, so letting them
    // disagree with it would mean a cohort that had about-faced fought as though its rear
    // rank were still its front.
    p.rank[i] = Math.min(255, Math.floor(s / width));
    p.file[i] = Math.min(255, s % width);
  };

  // Pass one: everyone who can have the place he is standing in, has it. On a turn about
  // the block's own centre that is nearly the whole unit, and nearly the whole unit
  // therefore does not move at all.
  let nLeft = 0;
  for (let k = 0; k < n; k++) {
    const packed = keys[k];
    const man = packed - Math.floor(packed / MAN_STRIDE) * MAN_STRIDE;
    const w = wantBuf[man];
    if (takenBuf[w] === 1) {
      takenBuf[w] = 2;
      bind(man, w);
    } else {
      leftBuf[nLeft++] = man;
    }
  }

  // Pass two: what is left, dealt in lattice order to the places left over, also in lattice
  // order. Both lists are short — they are the men the shape has no room for where they
  // stand — and matching two sorted lists is the right answer for a one-dimensional
  // remainder even though it is the wrong answer for the whole problem.
  if (nLeft > 0) {
    let nFree = 0;
    for (let k = 0; k < n; k++) {
      const s = slots[k];
      if (takenBuf[s] === 1) freeBuf[nFree++] = s;
    }
    for (let k = 0; k < nLeft && k < nFree; k++) bind(leftBuf[k], freeBuf[k]);
  }
  return n;
};
