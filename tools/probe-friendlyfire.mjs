#!/usr/bin/env node
/**
 * Missile friendly fire: how much of it there is, and which of three faults produced it.
 *
 * `segmentVisit` has no faction test, so a shaft hits whoever is on its line. That is one
 * sentence and at least three separable bugs, and a single "73 % of hits are on our own men"
 * cannot be acted on because each fault wants a different fix:
 *
 *   1. **The shot arms inside the file it was loosed from.** `ARM_TIME` is 0.06 *seconds*,
 *      which is 1.3 m for a pilum and 4.7 m for a ballista bolt — a different window for
 *      every weapon, and for some of them deeper than the formation.
 *   2. **The lane test does not see the man in front.** Ground probes step at 1.5 m over
 *      ranks that stand 0.86 m apart, and a lofted weapon probes exactly once.
 *   3. **A genuinely stray shot.** Scatter, or a friendly unit that walked into the lane
 *      after release. This one is meant to happen.
 *
 * The instrument that separates them is the distance from the release point to the hit, so
 * `Projectiles` carries the release point on every shot and bins each friendly casualty by
 * it. Bands and the shooter's own arc are printed with the numbers.
 *
 * Read only: no unit is spawned, no order issued, no system stubbed, so the census is of the
 * battle the player would see. Two independent views are printed side by side and must agree
 * — the projectile census, and the strength/kill ledger off `BattleSystem` — because a
 * counter that agrees with itself has never caught anything on this project.
 *
 * **Read it in slices.** The friendly-fire picture is not one number per battle, it is a
 * different number in every phase: Rome's assault opens at 49 % of hits on its own men while
 * the garrison is packed and the attackers are still out of reach, falls to 8 % once the
 * slingers stop, and climbs back past 40 % as the ranks thin and the bolt-throwers depress.
 * A single window lands wherever it lands. `--slices=N` walks the whole battle in one boot,
 * resetting the census at each step, and is the only honest way to compare two trees.
 *
 * Usage:
 *   node tools/probe-friendlyfire.mjs --port=5417
 *   node tools/probe-friendlyfire.mjs --port=5417 --map=carthage --warm=45 --window=60
 *   node tools/probe-friendlyfire.mjs --port=5417 --slices=8 --window=30
 *   node tools/probe-friendlyfire.mjs --port=5417 --json=/tmp/mff-rome-before.json
 *
 * Requires a dev server you started on `--port`; it does not start one. A probe that falls
 * back to a stale `dist/` reports a tree nobody is editing. Read the provenance line.
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5417);
const MAP = args.get('map') ?? 'rome';
const SCENARIO = args.get('scenario') ?? 'assault';
const QUALITY = args.get('quality') ?? 'ultra';
const WARM = Number(args.get('warm') ?? 60);
const WINDOW = Number(args.get('window') ?? 60);
const CHUNK = Number(args.get('chunk') ?? 5);
/** Walk the battle in this many consecutive windows instead of measuring one. */
const SLICES = Number(args.get('slices') ?? 0);
const JSON_OUT = args.get('json') ?? null;
const TIMEOUT = Number(args.get('timeout') ?? 240000);

const base = `http://127.0.0.1:${PORT}`;

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const url =
  `${base}/?harness=1&quality=${QUALITY}&autoplay=0&scenario=${SCENARIO}` +
  `&w=640&h=400&battle=${token}`;

const served = await fetch(`${base}/src/sim/Projectiles.ts`).then((r) => r.text()).catch(() => '');
if (!served) {
  console.error(`FATAL: nothing served at ${base}/src/sim/Projectiles.ts — is vite up on ${PORT}?`);
  process.exit(2);
}
if (!served.includes('debugFriendlyFire')) {
  console.error('FATAL: served source has no debugFriendlyFire — every number below would be void');
  process.exit(2);
}
const fingerprint = served.includes('SEG_FRIENDLY_ARM2')
  ? 'AFTER arm — the sweep knows whose men are on the line'
  : 'BEFORE arm — census only, segmentVisit still faction-blind';
console.log(`source:      ${base}  (dev server started outside this probe)`);
console.log(`served tree: ${fingerprint}  (${served.length} bytes)`);
console.log(`plan:        map=${MAP} scenario=${SCENARIO} warm=${WARM}s window=${WINDOW}s`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: TIMEOUT });
} catch {
  console.error(`FATAL: __game.ready never became true after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const l of logs.slice(-40)) console.error(`  console ${l}`);
  await browser.close();
  process.exit(3);
}
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (errors.length) {
  console.log(`page errors during boot (${errors.length}):`);
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

const advance = async (seconds) => {
  let left = seconds;
  while (left > 1e-6) {
    const step = Math.min(CHUNK, left);
    await page.evaluate((s) => window.__game.engine.advance(s, 166), step);
    left -= step;
  }
};

/**
 * The independent view. `u.kills` is `BattleSystem.damage`'s own attribution counter, so a
 * faction credited with more kills than the other side has losses is, on its face, shooting
 * itself — and that is a statement the projectile census plays no part in.
 */
const ledger = async () =>
  page.evaluate(() => {
    const b = window.__game.battle;
    const p = b.pool;
    const perFaction = {};
    for (const u of b.units) {
      const f = u.faction;
      perFaction[f] ??= { alive: 0, kills: 0, elevated: 0, elevatedKills: 0 };
      perFaction[f].kills += u.kills ?? 0;
      let elev = 0;
      let alive = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        alive++;
        if (b.elevated[i] !== 0) elev++;
      }
      perFaction[f].alive += alive;
      perFaction[f].elevated += elev;
      // A unit counts as garrison if most of its living men are on masonry.
      if (elev > alive * 0.5) perFaction[f].elevatedKills += u.kills ?? 0;
    }
    return { t: window.__game.simTime(), strength: { ...b.strength }, perFaction };
  });

const census = async () =>
  page.evaluate(() => {
    const pr = window.__game.engine.context.get('projectiles');
    return { ff: pr.debugFriendlyFire(), wall: pr.debugWallShots(), kinds: pr.debugProjectiles() };
  });

await advance(WARM);

if (SLICES > 0) {
  console.log('');
  console.log('slice-by-slice. ff = friendly, ahead = victim in the shooter\'s own unit and'
    + ' in front of him');
  const slices = [];
  for (let k = 0; k < SLICES; k++) {
    await page.evaluate(() => window.__game.engine.context.get('projectiles').debugResetCensus());
    const a = await ledger();
    await advance(WINDOW);
    const b2 = await ledger();
    const cc = await census();
    const T = cc.ff.total;
    slices.push({ t0: a.t, t1: b2.t, total: T, dist: cc.ff, ledger: { before: a, after: b2 } });
    console.log(
      `t ${a.t.toFixed(0).padStart(4)}-${b2.t.toFixed(0).padStart(4)}`
      + `  hits ${String(T.hitsOnMen).padStart(5)}`
      + `  ff ${String(T.friendlyHits).padStart(5)} (${String(T.friendlyPct).padStart(5)} %)`
      + `  ffKill ${String(T.friendlyKills).padStart(4)}`
      + `  enKill ${String(T.enemyKills).padStart(4)}`
      + `  same/other/ahead ${T.sameUnit}/${T.otherFriendlyUnit}/${T.sameUnitAhead}`
      + `  wall ${T.fromWallHits}/${T.fromWallKills}`
      + `  refused lane ${T.refusedLane} melee ${T.refusedMeleeTargets}`
    );
  }
  const sum = (k) => slices.reduce((s2, x) => s2 + x.total[k], 0);
  const mins = (slices.at(-1).t1 - slices[0].t0) / 60;
  console.log('');
  console.log(`pooled over ${mins.toFixed(2)} min:`
    + `  hits ${sum('hitsOnMen')}  friendly ${sum('friendlyHits')}`
    + ` (${((100 * sum('friendlyHits')) / Math.max(1, sum('hitsOnMen'))).toFixed(1)} %)`
    + `  friendly kills/min ${(sum('friendlyKills') / mins).toFixed(1)}`
    + `  enemy kills/min ${(sum('enemyKills') / mins).toFixed(1)}`);
  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify({ map: MAP, scenario: SCENARIO, slices }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  await browser.close();
  process.exit(0);
}

await page.evaluate(() => window.__game.engine.context.get('projectiles').debugResetCensus());
const before = await ledger();
await advance(WINDOW);
const after = await ledger();
const c = await census();

const mins = Math.max(1e-6, (after.t - before.t) / 60);
const row = (label, v) => console.log(`  ${label.padEnd(26)} ${v}`);
const arr = (a) => a.map((v) => String(v).padStart(5)).join(' ');

console.log('');
console.log(`window: ${(after.t - before.t).toFixed(1)} s of sim (${mins.toFixed(2)} min)`);
console.log('');
console.log('friendly fire, by distance from the release point (m)');
console.log(`  bands            ${['<0.9', '<1.8', '<2.7', '<3.6', '<4.7', '<7', '<12', '12+']
  .map((s) => s.padStart(5)).join(' ')}`);
console.log(`  flat  friendly   ${arr(c.ff.shaft.friendlyByDist)}`);
console.log(`  flat  all hits   ${arr(c.ff.shaft.allHitsByDist)}`);
console.log(`  loft  friendly   ${arr(c.ff.lofted.friendlyByDist)}`);
console.log(`  loft  all hits   ${arr(c.ff.lofted.allHitsByDist)}`);
console.log('');
console.log('friendly fire, by flight time at impact (s)');
console.log(`  bands            ${['<.06', '<.12', '<.20', '<.35', '<.60', '<1.0', '<2.0', '2+']
  .map((s) => s.padStart(5)).join(' ')}`);
console.log(`  flat             ${arr(c.ff.shaft.friendlyByTime)}`);
console.log(`  loft             ${arr(c.ff.lofted.friendlyByTime)}`);
console.log('');
console.log('totals');
const T = c.ff.total;
row('hits on men', T.hitsOnMen);
row('friendly hits', `${T.friendlyHits}  (${T.friendlyPct} %)`);
row('friendly kills/min', (T.friendlyKills / mins).toFixed(1));
row('enemy kills/min', (T.enemyKills / mins).toFixed(1));
row('same unit / other / ahead', `${T.sameUnit} / ${T.otherFriendlyUnit} / ${T.sameUnitAhead}`);
row('from a wall (hit/kill)', `${T.fromWallHits} / ${T.fromWallKills}`);
row('blast hits (all/friendly)', `${T.blastHits} / ${T.blastFriendlyHits}`);
row('blast kills (all/friendly)', `${T.blastKills} / ${T.blastFriendlyKills}`);
console.log('');
console.log('ledger — independent of the census above');
for (const f of Object.keys(after.perFaction).sort()) {
  const a = after.perFaction[f];
  const b0 = before.perFaction[f] ?? { alive: a.alive, kills: 0, elevatedKills: 0 };
  console.log(
    `  faction ${f}: alive ${String(b0.alive).padStart(5)} -> ${String(a.alive).padStart(5)}`
    + `  (lost ${String(b0.alive - a.alive).padStart(4)})`
    + `   credited kills ${String(a.kills - b0.kills).padStart(4)}`
    + `   of which garrison ${String(a.elevatedKills - b0.elevatedKills).padStart(4)}`
    + `   elevated now ${a.elevated}`
  );
}
const w = c.wall.total;
console.log('');
console.log(`wall shots: launched ${w.launched}  hitMan ${w.hitMan}  ownSide ${w.hitOwnSide}`
  + `  killed ${w.killed}  selfWall ${w.selfWall} (${w.selfWallPct} %)`);
console.log(`kinds: ${c.kinds.kinds.filter((k) => k.launched > 0)
  .map((k) => `${k.kind} ${k.launched}/${k.hitMan}/${k.killed}`).join('  ')}`);
console.log(`unreachable: ${c.kinds.kinds.filter((k) => k.unreachable > 0)
  .map((k) => `${k.kind} ${k.unreachable} of ${k.launched + k.unreachable}`).join('  ') || 'none'}`);

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({
    map: MAP, scenario: SCENARIO, warm: WARM, window: WINDOW,
    simSeconds: after.t - before.t, before, after, census: c,
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
