/**
 * PASSIVE AGAINST PLAYED — the judge's §3 test, and the only question that decides whether
 * the verb exists or the game does.
 *
 * Two arms over the same seed set, on the same tree, through the same menu:
 *
 *   passive   boot, BEGIN, watch. Not one order crosses the bus with `source: 'local'`.
 *   played    the same, plus one thing a player does: when men get onto my wall, the
 *             nearest cohorts of mine that are already up there are sent at them.
 *
 * The played arm is deliberately **one verb, mechanically applied**. It does not spend the
 * unused deployment pool, does not reposition before contact and does not micro-manage; the
 * point is to measure what the one mechanic under repair is worth, not to measure how well a
 * script can play. A cleverer arm would confound the two.
 *
 * ## What it records, and why dispersion is beside every location
 *
 * The judge's own note on this rig: *"every location test in this file said RESHUFFLE on a
 * change whose real effect was half the spread"*. So every column below is reported as mean,
 * sd, median and range, and the arms are also compared **per seed** — a sign test across the
 * pairs, because two distributions that overlap can still move every single seed the same
 * way, and that is a thing a player would feel and a mean would hide.
 *
 * Columns:
 *   decidedAt     the clock the product itself prints on the result panel
 *   verdict       Victory / Defeat, from `.rs-verdict`
 *   mine/theirs   living men at the end
 *   wallSeconds   seconds of the battle with any enemy man standing on my wall
 *   worstLodge    the most enemy men on the wall at once
 *   ordersLocal   orders with `source: 'local'` — the passive arm's must be zero
 *
 * ## Traps this file is written against
 *
 *   - **The seed is a menu field.** `boot()` types it and re-reads it, and throws if it did
 *     not take. A seed passed as a URL parameter is silently ignored.
 *   - **Serialised, one browser at a time.** A 12-seed comparison is the most tempting shape
 *     in the repository to parallelise and the machine has already been taken down once by
 *     exactly that. `boot()` goes through `launchBrowser`, so the cap holds even if this
 *     file is wrong.
 *   - **A sampled column only tells the truth if the thing it samples outlasts the interval.**
 *     `wallSeconds` and `worstLodge` are sampled every 5 s of sim; a lodgement lasts minutes.
 *     `decidedAt` is not sampled at all — it is read off the panel the game draws.
 *
 *   node tools/judge/jg-arms.mjs --arm=passive --runs=12 --tag=before --port=5944
 *   node tools/judge/jg-arms.mjs --arm=played  --runs=12 --tag=before --port=5944
 */
import { argsOf, boot, ledger, dump, ff, ended, aim, leftClick, rightClick, ROOT } from './jg-lib.mjs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const A = argsOf();
const ARM = A.get('arm') ?? 'played';
const MAP = A.get('map') ?? 'campus-martius';
const RUNS = Number(A.get('runs') ?? 12);
const UNTIL = Number(A.get('until') ?? 600);
const STEP = Number(A.get('step') ?? 5);
/** Sim seconds between command cycles in the played arm. A player is not a clock, but a
 *  fixed cadence is the only one that is the same in the before tree and the after tree. */
const CADENCE = Number(A.get('cadence') ?? 20);
const TAG = A.get('tag') ?? 'run';
const PORT = Number(A.get('port') ?? 5944);
const OUT = path.join(ROOT, 'screenshots/judge/arms');
const L = ledger(`arms ${MAP} ${ARM} ${TAG}`);

const SEEDS = [4265438264, 1, 7, 99, 12345, 777777, 2718281828, 31415926,
  8675309, 424242, 1000003, 4000000000].slice(0, RUNS);

let head = '?';
let srcHash = '?';
try { head = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
catch (e) { console.error(`[arms] could not read HEAD: ${e.message}`); }
try {
  srcHash = execSync("find src -type f \\( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \\) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16",
    { cwd: ROOT, shell: '/bin/sh' }).toString().trim();
} catch (e) { console.error(`[arms] could not hash src/: ${e.message}`); }
L.say(`tree ${head.slice(0, 10)}  src ${srcHash}  arm ${ARM}  ${SEEDS.length} seeds`);

/** Page helpers: the wall's occupancy, and a counter for orders the player issued. */
const HELPERS = () => {
  const g = window.__game, ctx0 = g.engine.context;
  window.__LOCAL = 0;
  ctx0.events.on('orderIssued', (e) => { if (e.source === 'local') window.__LOCAL++; });
  const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  window.__stone = (id) => {
    const u = g.battle.unitById(id); if (!u) return null;
    const p = g.battle.pool, e = g.battle.elevated;
    const xs = [], ys = [], zs = [];
    for (const i of u.members) {
      if (p.hp[i] <= 0 || !e || !e[i]) continue;
      xs.push(p.x[i]); ys.push(p.y[i]); zs.push(p.z[i]);
    }
    return { n: xs.length, x: med(xs), y: med(ys), z: med(zs) };
  };
  /** Who is on the stone, from the sim. Faction 0 is the player (`ui/theme.ts` l.85). */
  window.__wallRoll = () => {
    const s = g.battle.siege; if (!s) return { mine: [], theirs: [] };
    const mine = [], theirs = [];
    for (const u of g.battle.units) {
      if (u.destroyed || u.alive === 0) continue;
      const w = s.unitWallState(u.id);
      if (w.onWall === 0) continue;
      const row = { id: u.id, f: u.faction, alive: u.alive, onWall: w.onWall,
        goal: w.goal, routing: u.order === 5 || u.routTimer > 0 };
      if (u.faction === 0) mine.push(row); else theirs.push(row);
    }
    return { mine, theirs, local: window.__LOCAL };
  };
};

/** One command cycle: send whoever of mine is nearest at the biggest lodgement. */
async function commandCycle(page, seen) {
  const roll = await page.evaluate(() => window.__wallRoll());
  const lodge = roll.theirs.filter((t) => t.onWall >= 5).sort((a, b) => b.onWall - a.onWall)[0];
  if (!lodge) return 0;
  const ts = await page.evaluate((i) => window.__stone(i), lodge.id);
  if (!ts || ts.n === 0) return 0;
  const tp = await aim(page, ts.x, ts.y + 1.0, ts.z, { zoom: 0.55 });
  if (!tp) return 0;

  // My nearest two on the stone that are neither routing nor already at it.
  const cands = [];
  for (const m of roll.mine) {
    if (m.routing || m.onWall < 10 || m.goal === 'assault') continue;
    const s = await page.evaluate((i) => window.__stone(i), m.id);
    if (!s || s.n === 0) continue;
    cands.push({ id: m.id, ...s, d: Math.hypot(s.x - ts.x, s.z - ts.z) });
  }
  cands.sort((a, b) => a.d - b.d);
  let issued = 0;
  for (const c of cands.slice(0, 2)) {
    // Do not re-order the same pairing every cadence: a player gives an order once and
    // watches it, and re-clicking would reset the plan every twenty seconds.
    const key = `${c.id}:${lodge.id}`;
    if (seen.has(key)) continue;
    const p = await page.evaluate(([x, y, z]) => window.__P(x, y, z), [c.x, c.y + 1.0, c.z]);
    if (!p || p.x < 20 || p.x > 1580 || p.y < 120 || p.y > 750) continue;
    await leftClick(page, p);
    const sel = await page.evaluate(() => window.__sel());
    if (!sel || !sel.includes(c.id)) continue;
    await rightClick(page, tp, { hold: 260 });
    seen.add(key);
    issued++;
  }
  return issued;
}

const rows = [];
for (const seed of SEEDS) {
  let browser = null;
  const t0 = Date.now();
  try {
    const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
      out: OUT, label: `${ARM}-${seed}`, seed });
    browser = r.browser;
    const page = r.page;
    await page.mouse.move(800, 770); await page.waitForTimeout(300);
    await page.click('.dep-begin'); await page.waitForTimeout(600);
    await page.evaluate((src) => { (0, eval)(`(${src})`)(); }, HELPERS.toString());

    let t = 0, wallSeconds = 0, worstLodge = 0, issued = 0, next = CADENCE;
    const seen = new Set();
    let fin = null;
    while (t < UNTIL) {
      await ff(page, STEP); t += STEP;
      const roll = await page.evaluate(() => window.__wallRoll());
      const up = roll.theirs.reduce((s, x) => s + x.onWall, 0);
      if (up > 0) wallSeconds += STEP;
      if (up > worstLodge) worstLodge = up;
      fin = await ended(page);
      if (fin) break;
      if (ARM === 'played' && t >= next) {
        next += CADENCE;
        issued += await commandCycle(page, seen);
      }
    }
    const hud = await page.evaluate(() => window.__HUD());
    const truth = await page.evaluate(() => window.__TRUTH());
    const local = await page.evaluate(() => window.__LOCAL);
    const row = {
      seed, arm: ARM,
      verdict: fin ? fin.verdict : 'unfinished',
      reason: fin ? fin.reason : '',
      clock: hud.result?.clock ?? null,
      decidedAt: truth.t,
      mine: truth.strength[0] ?? 0,
      theirs: (truth.strength[1] ?? 0) + (truth.strength[2] ?? 0),
      wallSeconds, worstLodge, ordersLocal: local, issued,
      errs: r.errs.length, cerrs: r.cerrs.length,
    };
    rows.push(row);
    L.say(`  seed ${String(seed).padStart(10)}  ${row.verdict.padEnd(9)} at t+${String(row.decidedAt).padStart(6)}`
      + `  mine ${String(row.mine).padStart(5)}  theirs ${String(row.theirs).padStart(5)}`
      + `  wall-held ${String(wallSeconds).padStart(4)} s  worst ${String(worstLodge).padStart(4)}`
      + `  orders ${local}  (${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (e) {
    L.say(`  seed ${seed}: THREW ${String(e).slice(0, 200)}`);
    rows.push({ seed, arm: ARM, verdict: 'threw', error: String(e).slice(0, 300) });
  } finally { if (browser) await browser.close(); }
}

const num = (k) => rows.map((r) => r[k]).filter((x) => typeof x === 'number');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => (a.length > 1
  ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0);
const median = (a) => { const b = [...a].sort((x, y) => x - y); const h = b.length >> 1;
  return b.length ? (b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2) : null; };
const r1 = (x) => (x === null ? 'n/a' : Math.round(x * 10) / 10);

L.say(`\n=== ${ARM} ${TAG} — ${rows.length} seeds ===`);
for (const k of ['decidedAt', 'mine', 'theirs', 'wallSeconds', 'worstLodge', 'ordersLocal']) {
  const a = num(k);
  L.say(`  ${k.padEnd(12)} mean ${String(r1(mean(a))).padStart(8)}  sd ${String(r1(sd(a))).padStart(7)}`
    + `  median ${String(r1(median(a))).padStart(8)}  range ${r1(Math.min(...a))}–${r1(Math.max(...a))}`);
}
const wins = rows.filter((r) => /victor|held|repuls/i.test(r.verdict ?? '')).length;
L.say(`  verdicts: ${JSON.stringify(rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {}))}`);
L.ck(`the ${ARM} arm issued ${ARM === 'passive' ? 'no' : 'some'} player orders`,
  ARM === 'passive' ? num('ordersLocal').every((n) => n === 0) : num('ordersLocal').some((n) => n > 0),
  ARM === 'passive' ? 'all zero' : 'at least one seed with orders',
  JSON.stringify(num('ordersLocal')));
L.ck('every seed reached a verdict', rows.every((r) => r.verdict && r.verdict !== 'threw' && r.verdict !== 'unfinished'),
  `${rows.length} finished`, JSON.stringify(rows.map((r) => r.verdict)));
await dump(OUT, `${MAP}-${ARM}-${TAG}`, { map: MAP, arm: ARM, tag: TAG, head, srcHash, wins, rows, log: L.log });
L.say(`\nwritten: screenshots/judge/arms/${MAP}-${ARM}-${TAG}.json`);
L.summary();
