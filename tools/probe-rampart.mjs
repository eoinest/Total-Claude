#!/usr/bin/env node
/**
 * Does a formation asked to stand on a rampart fit the ground it is standing on?
 *
 * The owner's report, 3 Sep 2026:
 *
 *   > "soldiers get stuck on the walls because their formation boxes are too large for a
 *   >  wall. they cannot get into place because its the edge of the wall so they get stuck
 *   >  on top of the wall. the formation box on top (or i guess next to the wall bc the same
 *   >  principle applies) should reform to account for the edges of the walls. it should not
 *   >  go over the edge of the wall, it should not clip into the wall."
 *
 * That is a claim about **slots**, not about men, and this measures slots. A man who cannot
 * arrive is the symptom; a place he is being sent that is over thin air or inside stone is
 * the cause, and only one of the two can be counted without arguing about a threshold.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ## The predicate, and the reference it is measured against (rule 6)
 *
 * For every living man in the subject unit, take **the point the sim is actually steering
 * him at** — `BattleSystem.slotX/slotZ` for a man the elevation owner places, and the
 * formation offset rotated through `u.facing` plus his own `dress` jitter for everyone else,
 * which is `steerSoldiers`' own arithmetic. Then ask two questions **of the slot**:
 *
 *   - **`inStone`** — `BattleSystem.masonry.blocked(gx, gz, surf + 0.1, SOLDIER_RADIUS)`,
 *     where `surf` is the standing surface at the slot itself. The oriented-box field the
 *     integrator collides against says the slot is inside masonry. Nobody can reach it.
 *   - **`offEdge` / `overStone`** — a *membership*. `built` is true where the city has laid
 *     a standing surface more than a kerb above the ground: the wall-walk, a stair flight,
 *     the gatehouse crown. The block as a whole is on the works if a strict majority of its
 *     slots are. Then a slot **not** on the works under a block that is, is `offEdge` — it
 *     hangs over the ditch; and a slot **on** the works under a block that is not, is
 *     `overStone` — the box has climbed onto masonry nobody ordered it onto, which is the
 *     owner's "or next to the wall, because the same principle applies".
 *
 * `surf` is `max(CitySystem.walkableTopAt, terrain)`. `walkableTopAt` is the reference from
 * outside the mover — the city's own answer to "what could a body stand on here", written
 * for the camera rig, and **nothing in `src/sim` has ever called it**. `masonry` is the
 * mover's own. Two producers of the same fact (rule 11), reported separately.
 *
 * **Two earlier cuts of this predicate were wrong, and how they were wrong is the whole
 * reason it is a membership.** The first compared the slot's ground against *the man's own
 * feet*: a Carthaginian cohort 877 m from its destination, standing on the Byrsa, read
 * **96 of 96 slots "over a drop"** because the hill it was on is forty metres above the wall
 * it was walking to. Nothing about where a man happens to be standing belongs in a judgement
 * about a slot. The second compared each slot against the highest surface the block's own
 * slots touch, with a 0.9 m threshold — and fired **13 of 160** on the negative control, a
 * cohort ordered to stand exactly where it was already standing, because Rome's terrain has
 * metres of relief across a cohort's own frontage. A height rule cannot separate the Caelian
 * from a parapet at any threshold. Whether the city built a floor here can.
 *
 * ## Two readings, because the fault is permanent (rule 40)
 *
 * `probe-stuck` found a strict instantaneous census under-reporting a permanent trap by 20x,
 * because the qualifying predicate decays with the fault's own duration. The same trap is
 * here: a unit whose men cannot arrive is eventually re-tasked, wiped, or reverts to `Hold`,
 * and stops qualifying. So every count is taken twice:
 *
 *   - **strict** — at the end of the window: still commanded, still far from the slot, still
 *     not moving. Few false positives, blind to the standing population.
 *   - **occupancy** — per man, the *longest run of consecutive ticks* he was more than
 *     `GOAL_EPS` from his slot, as a fraction of the window. A man who never once stood on
 *     his slot in 240 s reads 1.00 whatever his unit's order says by then. Sees the
 *     population, admits men who are merely walking a long way.
 *
 * Both are printed. They bracket the truth from opposite sides.
 *
 * ## Controls, because a count of zero from a detector that cannot fire is worth nothing
 *
 * `--only=controls` runs three on the real battle, on real maps, against real stone. The
 * harness perturbs the *world* — it moves real men or aims a real order — and never the
 * probe's own thresholds.
 *
 *   | control    | perturbation                                          | must |
 *   |------------|-------------------------------------------------------|------|
 *   | `stayPut`  | ordered to the ground it is already standing on       | NOT fire |
 *   | `openField`| ordered 250 m out on the field side, clear of the city| NOT fire |
 *   | `intoWall` | ordered at the centreline of a curtain bay            | FIRE on `inStone` |
 *   | `onWalk`   | anchor teleported onto the wall-walk, still a formation| FIRE on `offEdge` |
 *
 * ## Stepping
 *
 * `advance(1/30, 1000/60, { render: false })` — two 60 Hz frames, exactly one 30 Hz fixed
 * tick, `__game.fastForward`'s own idiom and the one `qa-determinism` pins. A coarser step
 * is a different battle.
 *
 * Usage:
 *   node tools/probe-rampart.mjs --port=5951 [--battle='map=carthage&scenario=assault']
 *                                [--json=path] [--label=before] [--only=A,B,C,D,controls]
 */
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5951);
const BATTLE = args.get('battle') ?? '';
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? '';
const SECONDS = Number(args.get('seconds') ?? 240);
const ONLY = args.get('only') ? new Set(args.get('only').split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

const browser = await launchBrowser({ label: 'probe-rampart', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-rampart', slot: browser.budgetSlot,
});

// An expression, not a statement: `page.evaluate(string)` evaluates it and awaits the value,
// and top-level `await` is not available in that context. The IIFE is what makes the two
// dynamic imports below legal.
const HELPERS = `
(async () => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const city = g.engine.context.get('city');
  const FORM = await import('/src/sim/formations.ts');
  const RAND = await import('/src/util/rand.ts');
  g.engine.stop();

  /** Exactly one 30 Hz fixed tick, at the 60 Hz frame step the determinism pin uses. */
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  const run = (sec) => { const n = Math.round(sec * 30); for (let k = 0; k < n; k++) step(); };
  const click = (u, x, z) =>
    g.engine.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', x, z });

  const SOLDIER_R = 0.42;
  /**
   * Built surface standing this far proud of the ground counts as *on the works*.
   *
   * A kerb, deliberately, and not a wall height: the question is membership — is the city
   * carrying a body here, or is the terrain — and any threshold between a paving joint and
   * the lowest thing a man can be standing on top of gives the same partition. Rome's
   * shallowest walkable bay stands 1.4 m above the ground beside it.
   */
  const KERB = 0.5;
  /** Within this of his slot he has arrived. \`SLOT_ARRIVED\` in BattleSystem is 0.25. */
  const GOAL_EPS = 0.6;
  /** Not moving. */
  const CREEP = 0.08;
  /** LinkKind.Stair. */
  const STAIR = 2;

  const SC = { x: 0, z: 0 };
  /**
   * The point the sim is steering this man at, in world metres.
   *
   * Two producers because the sim has two: \`steerToSlots\` reads \`slotX/slotZ\` for a man
   * the elevation owner placed, and \`steerSoldiers\` computes the formation offset inline.
   * This is that same arithmetic — the rotation is \`u.x + ox*c + oz*s\`, \`u.z - ox*s + oz*c\`,
   * and the dress jitter uses the same two hash salts.
   */
  const goalOf = (u, i) => {
    if (s && s.ownsUnit(u.id)) return { x: b.slotX[i], z: b.slotZ[i], siege: 1 };
    const f = FORM.formation(u.formationId);
    const ranks = FORM.ranksFor(u.members.length, u.width);
    f.offset(SC, p.slot[i], u.width, ranks, u.spacingX, u.spacingZ);
    let ox = SC.x, oz = SC.z;
    if (f.dress > 0) {
      ox += (RAND.hash01(i, 0x5d4e) - 0.5) * u.spacingX * f.dress;
      oz += (RAND.hash01(i, 0x2b17) - 0.5) * u.spacingZ * f.dress;
    }
    const sn = Math.sin(u.facing), cs = Math.cos(u.facing);
    return { x: u.x + ox * cs + oz * sn, z: u.z - ox * sn + oz * cs, siege: 0 };
  };

  /** Where a man's feet are. */
  const standY = (i) => (b.elevated[i] !== 0 ? b.support[i] : p.y[i]);

  /**
   * The absolute Y of the topmost thing a body could stand on at a point.
   *
   * The city's answer where there is masonry, the terrain's where there is not. This is the
   * one query in the tree that knows a wall-walk has an *edge*, and it is the reference the
   * mover has never had.
   */
  const surfaceAt = (gx, gz) => {
    const wtop = city && city.walkableTopAt ? city.walkableTopAt(gx, gz) : -Infinity;
    const terr = b.groundAt(gx, gz);
    // \`built\` is the discriminator, and it is a *membership* rather than a height. Rome's
    // terrain has 15 m of relief across a cohort's own frontage, so a rule of the form "more
    // than N metres below the block's highest slot" fires on the Caelian and cannot be tuned
    // out without going blind to a 7 m parapet. Whether the city has built a surface here
    // that stands above the ground is exact, needs no threshold beyond a kerb, and is
    // precisely the thing "the edge of the wall" means.
    return { surf: wtop > terr ? wtop : terr, built: wtop > terr + KERB ? 1 : 0 };
  };

  /**
   * Is this slot inside stone? Asked **at the slot's own standing surface**, not at the
   * man's current one.
   *
   * The first cut asked it at the man's feet, and that is a different question: a cohort
   * 877 m from its destination, standing on the Byrsa, read 96 of 96 slots "over a drop"
   * because the hill it was on is 40 m above the wall it was walking to. A slot's fitness
   * is a property of the slot. Nothing about where the man happens to be standing belongs
   * in it.
   */
  const classify = (gx, gz) => {
    const a = surfaceAt(gx, gz);
    return {
      inStone: b.masonry.blocked(gx, gz, a.surf + 0.1, SOLDIER_R) ? 1 : 0,
      surf: a.surf, built: a.built,
    };
  };

  /**
   * Where a man is, in the only places the wall has. Read off the arrays the sim itself
   * branches on, so this cannot disagree with behaviour. Same reading as probe-wallstuck.
   */
  const where = (i) => {
    if (!s) return 'grass';
    if (s.crossOf[i] !== -1) return 'rungs';
    const st = s.stationOf[i];
    if (st >= 0) return 'parapet';
    if (st === -2) return 'pending';
    if (st === -3) return 'link';
    return 'grass';
  };

  /**
   * How far outside the station's own standing band a man on the parapet is, metres.
   *
   * The band is \`sInner..sOuter\` about the station's centreline along the outward normal —
   * the wall's own answer to where a body may stand. Measured against the station he is
   * *standing over*, not the one he is walking to, which is the distinction
   * \`standingStation\` exists for. Zero for a man not on the stone.
   */
  const outOfBand = (i) => {
    if (!s) return 0;
    const st = s.stationOf[i];
    if (st < 0 || st >= s.stationCount) return 0;
    const off = (p.x[i] - s.sx[st]) * s.snx[st] + (p.z[i] - s.sz[st]) * s.snz[st];
    return Math.max(s.sInner[st] - off, off - s.sOuter[st]);
  };

  /**
   * One tick's slot census for a unit.
   *
   * **\`offEdge\` is a statement about the slot set and about nothing else.** A body of men
   * stands on one thing. Ask each slot whether the city has built a standing surface there
   * — \`built\` — and take the majority as what the block is standing on. Then:
   *
   *   - a block standing on the works whose slots are *not* all on the works is hanging off
   *     the edge, and those slots are \`offEdge\`;
   *   - a block standing on the ground with slots *on* the works has climbed onto masonry
   *     nobody ordered it onto, and those are \`overStone\` — the owner's "or next to the
   *     wall, because the same principle applies".
   *
   * A membership and not a height, because Rome's terrain has fifteen metres of relief
   * across a cohort's own frontage and a height rule cannot separate the Caelian from a
   * parapet. No man's current position enters it; \`inStone\` needs no reference at all.
   */
  const census = (u, outBad) => {
    if (outBad) outBad.clear();
    const g = [];
    let builtCount = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const gpt = goalOf(u, i);
      const c = classify(gpt.x, gpt.z);
      builtCount += c.built;
      g.push({ i, x: gpt.x, z: gpt.z, surf: c.surf, built: c.built, inStone: c.inStone });
    }
    const n = g.length;
    if (n === 0) {
      return { n: 0, inStone: 0, offEdge: 0, overStone: 0, badSlots: 0, onWorks: 0,
        spanY: 0, distinctSlots: 0, worstPile: 0, menSharingASlot: 0, pileAt: null,
        locus: { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0 },
        far: 0, stillAndFar: 0, onWall: 0, farOnWall: 0, stuckOnWall: 0,
        outBand: 0, worstOut: 0, meanToSlot: 0, maxToSlot: 0,
        order: u.order, width: u.width, owned: false, garr: false };
    }
    let topSurf = -Infinity, loSurf = Infinity;
    for (const e of g) { if (e.surf > topSurf) topSurf = e.surf; if (e.surf < loSurf) loSurf = e.surf; }
    // What the block as a whole is standing on. A strict majority, so a block exactly half
    // on and half off is judged as being on the ground and its wall slots read \`overStone\`
    // — which is the more conservative of the two readings and the one that does not
    // require a tie-break.
    const blockOnWorks = builtCount * 2 > n;

    let inStone = 0, offEdge = 0, overStone = 0, bad = 0, far = 0, still = 0, sumD = 0, maxD = 0;
    let onWall = 0, farOnWall = 0, stuckOnWall = 0, outBand = 0, worstOut = 0;
    const seats = new Map();
    const locus = { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0 };
    for (const e of g) {
      const i = e.i;
      const loc = where(i);
      locus[loc]++;
      inStone += e.inStone;
      const off = blockOnWorks && !e.built ? 1 : 0;
      const over = !blockOnWorks && e.built ? 1 : 0;
      offEdge += off;
      overStone += over;
      if (e.inStone || off || over) { bad++; if (outBad) outBad.add(i); }
      const key = Math.round(e.x * 4) + ':' + Math.round(e.z * 4);
      const cell = seats.get(key);
      if (cell) { cell.n++; cell.who[loc]++; }
      else seats.set(key, { n: 1, x: e.x, z: e.z,
        who: { parapet: 0, rungs: 0, pending: 0, link: 0, grass: 0, [loc]: 1 } });
      const d = Math.hypot(e.x - p.x[i], e.z - p.z[i]);
      const slow = Math.hypot(p.vx[i], p.vz[i]) < CREEP;
      sumD += d; if (d > maxD) maxD = d;
      if (d > GOAL_EPS) { far++; if (slow) still++; }
      // The owner's sentence is about men who *are* on the wall, so count them apart.
      if (loc === 'parapet') {
        onWall++;
        if (d > GOAL_EPS) { farOnWall++; if (slow) stuckOnWall++; }
        const o = outOfBand(i);
        if (o > 0.02) { outBand++; if (o > worstOut) worstOut = o; }
      }
    }
    let worstPile = 0, sharing = 0, top = null;
    for (const v of seats.values()) {
      if (v.n > worstPile) { worstPile = v.n; top = v; }
      if (v.n > 1) sharing += v.n;
    }
    // Where the biggest pile is, and whether the stone says it is on the parapet. A pile of
    // men queueing at a stair foot and a pile of men given one place on the walk are the
    // same number and completely different faults, and only this tells them apart.
    const pileAt = top ? {
      x: +top.x.toFixed(1), z: +top.z.toFixed(1), n: top.n, who: top.who,
      onWall: s ? s.wallTargetAt(top.x, top.z) >= 0 : false,
    } : null;
    return {
      n, inStone, offEdge, overStone, badSlots: bad,
      onWorks: builtCount, blockOnWorks,
      spanY: +(topSurf - loSurf).toFixed(2), distinctSlots: seats.size,
      worstPile, menSharingASlot: sharing, pileAt, locus,
      far, stillAndFar: still,
      onWall, farOnWall, stuckOnWall, outBand, worstOut: +worstOut.toFixed(2),
      meanToSlot: +(sumD / n).toFixed(2), maxToSlot: +maxD.toFixed(2),
      order: u.order, width: u.width,
      owned: s ? s.ownsUnit(u.id) : false, garr: s ? s.isGarrisoned(u.id) : false,
    };
  };

  const q = (arr, f) => {
    if (arr.length === 0) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(3);
  };

  /** Trace a unit for \`sec\` seconds. Both readings. */
  const trace = (u, sec, every = 30) => {
    const ticks = Math.round(sec * 30);
    const samples = [];
    const farRun = new Map(), farMax = new Map(), badRun = new Map(), badMax = new Map();
    const wallRun = new Map(), wallMax = new Map(), wallTicks = new Map();
    const start = new Map(), prev = new Map(), travel = new Map();
    let settleTick = -1;
    for (const i of u.members) {
      farRun.set(i, 0); farMax.set(i, 0); badRun.set(i, 0); badMax.set(i, 0);
      wallRun.set(i, 0); wallMax.set(i, 0); wallTicks.set(i, 0);
      start.set(i, [p.x[i], p.z[i]]); prev.set(i, [p.x[i], p.z[i]]); travel.set(i, 0);
    }
    // One census a tick: the slot set has to be built whole before any slot can be judged
    // against it, and the alternative is two producers of the same classification.
    const badSet = new Set();
    for (let k = 0; k < ticks; k++) {
      step();
      const c = census(u, badSet);
      let live = 0, near = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        live++;
        const pv = prev.get(i);
        travel.set(i, travel.get(i) + Math.hypot(p.x[i] - pv[0], p.z[i] - pv[1]));
        prev.set(i, [p.x[i], p.z[i]]);
        const gpt = goalOf(u, i);
        const d = Math.hypot(gpt.x - p.x[i], gpt.z - p.z[i]);
        if (d > GOAL_EPS) {
          const r = farRun.get(i) + 1;
          farRun.set(i, r);
          if (r > farMax.get(i)) farMax.set(i, r);
        } else { farRun.set(i, 0); near++; }
        if (badSet.has(i)) {
          const r = badRun.get(i) + 1;
          badRun.set(i, r);
          if (r > badMax.get(i)) badMax.set(i, r);
        } else badRun.set(i, 0);
        // Standing on the stone and not on his slot: "stuck on top of the wall", as a
        // hold time rather than as a count per tick. See rule 40.
        if (where(i) === 'parapet') {
          wallTicks.set(i, wallTicks.get(i) + 1);
          if (d > GOAL_EPS) {
            const r = wallRun.get(i) + 1;
            wallRun.set(i, r);
            if (r > wallMax.get(i)) wallMax.set(i, r);
          } else wallRun.set(i, 0);
        } else wallRun.set(i, 0);
      }
      // Settled: nine in ten men on their slot, and it stays true to the end of the window.
      if (live > 0 && near >= live * 0.9) { if (settleTick < 0) settleTick = k; }
      else settleTick = -1;
      if (k % every === 0 || k === ticks - 1) samples.push({ t: +(k / 30).toFixed(1), ...c });
    }
    const farFrac = [], badFrac = [], moved = [], walked = [], wallHold = [];
    let neverArrived = 0, alwaysBad = 0, alive = 0, everOnWall = 0, stuckOnWall = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      alive++;
      const ff = farMax.get(i) / ticks, bf = badMax.get(i) / ticks;
      farFrac.push(ff); badFrac.push(bf);
      const st = start.get(i);
      moved.push(Math.hypot(p.x[i] - st[0], p.z[i] - st[1]));
      walked.push(travel.get(i));
      if (ff > 0.98) neverArrived++;
      if (bf > 0.98) alwaysBad++;
      const wt = wallTicks.get(i);
      if (wt > 0) {
        everOnWall++;
        // Of the time he spent on the stone, the longest unbroken stretch off his slot.
        const wh = wallMax.get(i) / wt;
        wallHold.push(wh);
        if (wh > 0.9) stuckOnWall++;
      }
    }
    const last = samples[samples.length - 1] ?? {};
    return {
      samples,
      settleSec: settleTick >= 0 ? +(settleTick / 30).toFixed(1) : null,
      alive,
      strict: { far: last.far ?? 0, stillAndFar: last.stillAndFar ?? 0,
        inStone: last.inStone ?? 0, offEdge: last.offEdge ?? 0, badSlots: last.badSlots ?? 0 },
      occupancy: {
        neverArrived, neverArrivedPct: alive ? +(100 * neverArrived / alive).toFixed(1) : 0,
        farFracMed: q(farFrac, 0.5), farFracP90: q(farFrac, 0.9),
        alwaysBadSlot: alwaysBad,
        badFracMed: q(badFrac, 0.5), badFracP90: q(badFrac, 0.9),
        everOnWall, stuckOnWall,
        stuckOnWallPct: everOnWall ? +(100 * stuckOnWall / everOnWall).toFixed(1) : 0,
        wallHoldMed: q(wallHold, 0.5), wallHoldP90: q(wallHold, 0.9),
      },
      netMovedMed: q(moved, 0.5), netMovedMax: q(moved, 1),
      walkedMed: q(walked, 0.5), walkedMax: q(walked, 1),
    };
  };

  /** Is any stair's wall end on a run the walk joins to \`r\`? */
  const runHasStair = (r) => {
    for (const l of s.links) {
      if (l.kind !== STAIR || l.stationB < 0) continue;
      if (isFinite(s.walkDistance(l.stationB, r))) return true;
    }
    return false;
  };

  /** The wall's own arithmetic, per run: how many men the stone can seat. */
  const runTable = () => {
    if (!s || s.stationCount === 0) return [];
    const lo = new Map(), hi = new Map();
    for (let st = 0; st < s.stationCount; st++) {
      const r = s.sRun[st];
      if (!lo.has(r) || st < lo.get(r)) lo.set(r, st);
      if (!hi.has(r) || st > hi.get(r)) hi.set(r, st);
    }
    const rows = [];
    for (const r of [...lo.keys()].sort((a, c) => a - c)) {
      const a = lo.get(r), c = hi.get(r);
      let ranks = 99, bandMin = Infinity, bandMax = -Infinity;
      for (let k = a; k <= c; k++) {
        const band = s.sOuter[k] - s.sInner[k];
        if (band < bandMin) bandMin = band;
        if (band > bandMax) bandMax = band;
        const n = Math.max(1, Math.min(5, Math.floor(band / 0.72) + 1));
        if (n < ranks) ranks = n;
      }
      const stations = c - a + 1;
      rows.push({ run: r, lo: a, hi: c, stations, ranks, seats: stations * ranks,
        bandMin: +bandMin.toFixed(2), bandMax: +bandMax.toFixed(2), stair: runHasStair(r) });
    }
    return rows;
  };

  /** A free defender standing inside the city, biggest first. */
  const freeDefender = (nearX, nearZ) => {
    const defender = b.units.find((x) => s.isGarrisoned(x.id))?.faction;
    let best = null, bestScore = -Infinity;
    for (const x of b.units) {
      if (x.destroyed || x.faction !== defender || x.alive < 40) continue;
      if (s.ownsUnit(x.id) || s.isGarrisoned(x.id)) continue;
      if (s.wallSideAt(x.x, x.z) !== -1) continue;
      const score = nearX === undefined ? x.alive
        : -Math.hypot(x.x - nearX, x.z - nearZ);
      if (score > bestScore) { bestScore = score; best = x; }
    }
    return best;
  };

  window.__rp = { g, b, s, p, city, FORM, RAND, step, run, click, goalOf, standY, classify,
    census, trace, runTable, runHasStair, freeDefender, where, q,
    GOAL_EPS, KERB, SOLDIER_R, STAIR };
  return true;
})()
`;

const errs = [];
async function arm(name, fn, argObj) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => errs.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`[${name}] console: ${m.text()}`); });
  const q = `${base}/?harness=1&autoplay=0&quality=high&w=480&h=270${BATTLE ? `&${BATTLE}` : ''}`;
  await page.goto(q, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
  await page.evaluate(HELPERS);
  const r = await page.evaluate(fn, argObj);
  await page.close();
  return r;
}

const out = { rev, label: LABEL, battle: BATTLE || '(default)', seconds: SECONDS };

// ---------------------------------------------------------------------------
// A — the arithmetic. What the stone can seat against what the roster is.
// ---------------------------------------------------------------------------
if (want('A')) {
  out.A = await arm('A', () => {
    const w = window.__rp, s = w.s, b = w.b;
    w.run(2);
    const runs = w.runTable();
    const garrisons = [];
    for (const u of b.units) {
      if (u.destroyed || !s || !s.isGarrisoned(u.id)) continue;
      const g = s.garrisons.get(u.id);
      garrisons.push({ id: u.id, type: u.typeId, alive: u.alive,
        from: g ? g.from : -1, span: g ? g.span : -1, ranks: g ? g.ranks : -1,
        seats: g ? g.span * g.ranks : -1, overflow: g ? g.overflow : -1, ...w.census(u) });
    }
    let unreachableStations = 0;
    const unreachableRuns = [];
    for (const r of runs) {
      if (!r.stair) { unreachableStations += r.stations; unreachableRuns.push(r.run); }
    }
    // What a field cohort's footprint would be, against the strip it is being asked onto.
    const boxes = [];
    for (const u of b.units) {
      if (u.destroyed || u.alive < 40) continue;
      const f = w.FORM.formation(u.formationId);
      const ranks = w.FORM.ranksFor(u.members.length, u.width);
      boxes.push({ type: u.typeId, alive: u.alive, width: u.width, ranks,
        frontage: +(u.width * u.spacingX).toFixed(1), depth: +(ranks * u.spacingZ).toFixed(1),
        formation: u.formationId, dress: f.dress });
    }
    const seen = new Set();
    const shapes = boxes.filter((x) => { const k = x.type + x.width; if (seen.has(k)) return false; seen.add(k); return true; });
    return { stationCount: s ? s.stationCount : 0, runCount: runs.length, runs,
      unreachableStations, unreachableRuns, garrisons, shapes };
  });
}

// ---------------------------------------------------------------------------
// B — a cohort on the ground inside the city, ordered onto a reachable parapet.
// ---------------------------------------------------------------------------
if (want('B')) {
  out.B = await arm('B', (sec) => {
    const w = window.__rp, s = w.s;
    w.run(2);
    const u = w.freeDefender();
    if (!u) return { fail: 'no free defender on the city side' };
    let dest = -1, bd = Infinity;
    for (let k = 0; k < s.stationCount; k++) {
      if (!w.runHasStair(s.sRun[k])) continue;
      const d = (s.sx[k] - u.x) ** 2 + (s.sz[k] - u.z) ** 2;
      if (d < bd) { bd = d; dest = k; }
    }
    if (dest < 0) return { fail: 'no stair-reachable station' };
    const before = w.census(u);
    w.click(u, s.sx[dest], s.sz[dest]);
    w.step();
    const t = w.trace(u, sec, 300);
    return { unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      destStation: dest, destRun: s.sRun[dest],
      accepted: s.ownsUnit(u.id) || s.isGarrisoned(u.id), before, ...t, after: w.census(u) };
  }, SECONDS);
}

// ---------------------------------------------------------------------------
// C — the same order aimed at a run no flight of steps reaches.
// ---------------------------------------------------------------------------
if (want('C')) {
  out.C = await arm('C', (sec) => {
    const w = window.__rp, s = w.s;
    w.run(2);
    let dest = -1;
    for (let st = 0; st < s.stationCount; st++) {
      if (!w.runHasStair(s.sRun[st])) { dest = st; break; }
    }
    if (dest < 0) return { fail: 'every run on this map has a flight' };
    const u = w.freeDefender(s.sx[dest], s.sz[dest]);
    if (!u) return { fail: 'no free defender on the city side' };
    const before = w.census(u);
    w.click(u, s.sx[dest], s.sz[dest]);
    w.step();
    const t = w.trace(u, sec, 300);
    return { unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      destStation: dest, destRun: s.sRun[dest],
      accepted: s.ownsUnit(u.id) || s.isGarrisoned(u.id), before, ...t, after: w.census(u) };
  }, SECONDS);
}

// ---------------------------------------------------------------------------
// D — a cohort ordered to stand on the ground beside the wall. Same principle.
// ---------------------------------------------------------------------------
if (want('D')) {
  out.D = await arm('D', (sec) => {
    const w = window.__rp, s = w.s;
    w.run(2);
    const u = w.freeDefender();
    if (!u) return { fail: 'no free defender on the city side' };
    let st = -1, bd = Infinity;
    for (let k = 0; k < s.stationCount; k++) {
      const d = (s.sx[k] - u.x) ** 2 + (s.sz[k] - u.z) ** 2;
      if (d < bd) { bd = d; st = k; }
    }
    // Six metres inboard of the standing band: a legal place to be, next to the wall.
    const off = s.sInner[st] - 6;
    const gx = s.sx[st] + s.snx[st] * off, gz = s.sz[st] + s.snz[st] * off;
    const before = w.census(u);
    w.click(u, gx, gz);
    w.step();
    const t = w.trace(u, Math.min(sec, 180), 300);
    return { unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      station: st, gx: +gx.toFixed(1), gz: +gz.toFixed(1), before, ...t, after: w.census(u) };
  }, SECONDS);
}

// ---------------------------------------------------------------------------
// E — a garrison ordered along its own wall. The shape moves on the stone.
// ---------------------------------------------------------------------------
if (want('E')) {
  out.E = await arm('E', (sec) => {
    const w = window.__rp, s = w.s, b = w.b;
    w.run(2);
    // The biggest settled garrison with no plan already running.
    let u = null;
    for (const x of b.units) {
      if (x.destroyed || x.alive < 20 || !s.isGarrisoned(x.id) || s.plans.has(x.id)) continue;
      if (!u || x.alive > u.alive) u = x;
    }
    if (!u) return { fail: 'no settled garrison' };
    const here = s.stationNear(u.x, u.z);
    const hereRun = s.sRun[here];
    // Somewhere else on a run this one joins to, as far along as the walk allows.
    let dest = -1, bestD = -1;
    for (let k = 0; k < s.stationCount; k++) {
      const d = s.walkDistance(here, s.sRun[k]);
      if (!isFinite(d)) continue;
      const along = Math.abs(k - here);
      if (along > bestD && along < 120) { bestD = along; dest = k; }
    }
    if (dest < 0) return { fail: 'nowhere to traverse to' };
    const before = w.census(u);
    w.click(u, s.sx[dest], s.sz[dest]);
    w.step();
    const t = w.trace(u, Math.min(sec, 300), 300);
    return { unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      fromStation: here, fromRun: hereRun, destStation: dest, destRun: s.sRun[dest],
      before, ...t, after: w.census(u) };
  }, SECONDS);
}

// ---------------------------------------------------------------------------
// F — the owner's sentence, aimed. A body **already on the wall** ordered onto the
//     shortest stretch of it that it can walk to, whose seat count is provably
//     smaller than the roster.
//
//     Already on the wall, deliberately. The first cut ordered a cohort up from the
//     ground onto the smallest run on the map, and the smallest run is nowhere near a
//     free cohort: it spent 300 s measuring an 838 m march and never reached the stone
//     at all. Starting from a garrison removes the march and leaves only the fit.
// ---------------------------------------------------------------------------
if (want('F')) {
  out.F = await arm('F', (sec) => {
    const w = window.__rp, s = w.s, b = w.b;
    w.run(2);
    let u = null;
    for (const x of b.units) {
      if (x.destroyed || x.alive < 20 || !s.isGarrisoned(x.id) || s.plans.has(x.id)) continue;
      if (!u || x.alive > u.alive) u = x;
    }
    if (!u) return { fail: 'no settled garrison' };
    const here = s.stationNear(u.x, u.z);
    // The smallest run the walk joins this one to.
    const runs = w.runTable().filter((r) => isFinite(s.walkDistance(here, r.run))
      && r.run !== s.sRun[here]);
    if (runs.length === 0) return { fail: 'nowhere to traverse to' };
    runs.sort((a, c) => a.seats - c.seats);
    const target = runs[0];
    const dest = (target.lo + target.hi) >> 1;
    const before = w.census(u);
    w.click(u, s.sx[dest], s.sz[dest]);
    w.step();
    const t = w.trace(u, sec, 300);
    return { unitId: u.id, type: u.typeId, alive: u.alive, width: u.width,
      fromStation: here, fromRun: s.sRun[here],
      run: target.run, runStations: target.stations, runRanks: target.ranks,
      runSeats: target.seats, surplus: Math.max(0, u.alive - target.seats),
      destStation: dest, accepted: s.plans.has(u.id),
      before, ...t, after: w.census(u) };
  }, SECONDS);
}

// ---------------------------------------------------------------------------
// controls — the detector must fire, and must not.
// ---------------------------------------------------------------------------
if (want('controls')) {
  out.controls = await arm('controls', () => {
    const w = window.__rp, s = w.s, b = w.b, p = w.p;
    w.run(2);
    const res = {};

    /*
     * stayPut — ordered to stand exactly where it already stands.
     *
     * The one negative control that is available on every map without choosing a point.
     * The block is on ground it is provably standing on, so a detector that fires here is
     * wrong about something, and it needs no argument about what "open ground" means inside
     * a city. Must read 0 / 0 and settle.
     */
    {
      const u = w.freeDefender();
      if (!u) res.stayPut = { fail: 'no free defender' };
      else {
        w.click(u, u.x, u.z);
        w.step();
        const t = w.trace(u, 90, 90);
        res.stayPut = { unitId: u.id, alive: t.alive, ...t.strict,
          settleSec: t.settleSec, neverArrived: t.occupancy.neverArrived,
          verdict: (t.strict.inStone === 0 && t.strict.offEdge === 0) ? 'quiet' : 'FIRED' };
      }
    }

    /*
     * openField — 250 m out on the *field* side of the curtain, where the besiegers form up.
     *
     * The city is inside the wall, so this is the one direction on both maps in which 250 m
     * of clear ground exists. A besieging cohort is used, so nothing routes it at the wall.
     */
    {
      const defender = b.units.find((x) => s.isGarrisoned(x.id))?.faction;
      const rows = [];
      let fired = 0, seen = 0;
      for (const x of b.units) {
        if (x.destroyed || x.faction === defender || x.alive < 20) continue;
        if (s.wallSideAt(x.x, x.z) !== 1) continue;
        const c = w.census(x);
        seen++;
        if (c.badSlots > 0) { fired++; rows.push({ id: x.id, type: x.typeId, n: c.n,
          inStone: c.inStone, offEdge: c.offEdge, overStone: c.overStone, spanY: c.spanY }); }
      }
      res.openField = { units: seen, unitsFiring: fired, rows,
        verdict: fired === 0 ? 'quiet' : 'FIRED' };
    }

    /*
     * intoWall — the anchor put on the curtain's own centreline at ground level.
     *
     * A teleport rather than an order, and the first cut was the order: aimed at the same
     * point, the sim behaved *correctly* — `holdShortOfSolid` pushed the anchor a body clear
     * of the face and the block settled on clean ground with 0 slots in stone. A control
     * that the code under test defeats by working is not a control, so the perturbation is
     * moved to the world.
     */
    {
      const u = w.freeDefender();
      if (!u) res.intoWall = { fail: 'no free defender' };
      else {
        const st = s.stationNear(u.x, u.z);
        u.facing = Math.atan2(s.snx[st], s.snz[st]);
        u.x = s.sx[st]; u.z = s.sz[st];
        u.targetX = u.x; u.targetZ = u.z;
        const c = w.census(u);
        res.intoWall = { unitId: u.id, alive: c.n, inStone: c.inStone, offEdge: c.offEdge,
          overStone: c.overStone, badSlots: c.badSlots, onWorks: c.onWorks,
          blockOnWorks: c.blockOnWorks, spanY: c.spanY,
          verdict: c.inStone > 0 ? 'FIRED' : 'silent' };
      }
    }

    // onWalk — a cohort's anchor teleported onto the wall-walk, still a formation.
    // Must FIRE on offEdge: a field frontage laid across a 3 m strip hangs off both sides.
    {
      const u = w.freeDefender();
      if (!u) res.onWalk = { fail: 'no free defender' };
      else {
        const st = Math.min(s.stationCount - 1, Math.max(0, s.stationNear(u.x, u.z)));
        const mid = (s.sInner[st] + s.sOuter[st]) * 0.5;
        const cx = s.sx[st] + s.snx[st] * mid, cz = s.sz[st] + s.snz[st] * mid;
        // Along the wall, so the frontage lies along the run and the depth crosses it.
        u.facing = Math.atan2(s.snx[st], s.snz[st]);
        u.x = cx; u.z = cz; u.targetX = cx; u.targetZ = cz;
        let n = 0;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          n++;
          const gpt = w.goalOf(u, i);
          p.x[i] = gpt.x; p.z[i] = gpt.z; p.px[i] = gpt.x; p.pz[i] = gpt.z;
          p.y[i] = s.sy[st]; p.py[i] = s.sy[st];
          b.elevated[i] = 1; b.support[i] = s.sy[st];
        }
        const c = w.census(u);
        res.onWalk = { unitId: u.id, placed: n, station: st,
          band: +(s.sOuter[st] - s.sInner[st]).toFixed(2),
          frontage: +(u.width * u.spacingX).toFixed(1),
          inStone: c.inStone, offEdge: c.offEdge, overStone: c.overStone,
          badSlots: c.badSlots, onWorks: c.onWorks, blockOnWorks: c.blockOnWorks, spanY: c.spanY,
          verdict: c.offEdge > 0 ? 'FIRED' : 'silent' };
      }
    }
    return res;
  });
}

await browser.close();
await closeServer();

for (const [k, v] of Object.entries(out)) {
  if (k === 'rev' || k === 'label' || k === 'battle' || k === 'seconds') continue;
  console.log(`\n===== ARM ${k} =====`);
  console.log(JSON.stringify(v, null, 1));
}
console.log(`\nrev ${out.rev}  label ${out.label}  battle ${out.battle}  window ${SECONDS}s`);
if (errs.length) { console.log('\npage errors:'); for (const e of errs) console.log('  ' + e); }
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ ...out, errs }, null, 1));
