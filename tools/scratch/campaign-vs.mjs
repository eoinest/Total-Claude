#!/usr/bin/env node
/**
 * The Rome assault, N seeds, with the parapet censused **per run** every 2 s.
 *
 * `probe-romewin-ds.mjs` reports the two totals the victory conditions actually read
 * (`stormOnWall`, `garrisonOnWall`) and those totals are the whole reason condition A is
 * unreachable: they are sums over a 1.78 km circuit, so a storming party that has cleared
 * the bay it climbed into still reads `garrisonOnWall = 640`. To choose a *scoped* rule I
 * need the distribution behind the sum — which stretch of walkway each side is standing on,
 * at a sampling interval finer than the 20 s hold the rule has to time.
 *
 * Rome's spine is 1695 stations in 45 runs, one run per garrisonable bay, ~38 m and ~38
 * stations each. So a run is the natural unit of "a stretch of wall", and this records
 * storm and garrison counts per run, plus exact station occupancy while anyone of the
 * storming side is up there at all.
 *
 *   node tools/scratch/campaign-vs.mjs --port=5481 --runs=12 --json=/tmp/before-vs.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5481);
const MAP = args.get('map') ?? 'campus-martius';
const RUNS = Number(args.get('runs') ?? 12);
const UNTIL = Number(args.get('until') ?? 2400);
const QUALITY = args.get('quality') ?? 'high';
const SEED0 = Number(args.get('seed0') ?? 4265438264);
const SAMPLE = Number(args.get('sample') ?? 2);
const JSON_OUT = args.get('json') ?? '';
const LABEL = args.get('label') ?? 'run';
/**
 * An order of battle for the garrison, as the menu would compose one.
 *
 * The shipped `siegeRome` puts eight wall units — 810 men — on the parapet, and no assault
 * in twelve seeded runs ever cleared a single bay of them. Whether that makes condition A
 * *unreachable* or merely *unreached* is answered by lightening the garrison and finding the
 * point at which the escalade does take a stretch of wall, so this is a real setting a player
 * can choose and not a thumb on the sim.
 */
const ROME = args.get('rome') ?? '';

async function up(url, ms) {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await up(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await up(base, 120000))) throw new Error('vite did not start');
  console.error(`• vite pid ${server.pid} on ${PORT} (${ROOT})`);
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const FACTION = { 0: 'Rome', 1: 'Juthungi', 2: 'Carthage' };

async function runOne(seed) {
  const cfg = { map: MAP, scenario: 'assault', quality: QUALITY, seed };
  if (ROME) cfg.siegeRome = JSON.parse(ROME);
  const token = Buffer.from(JSON.stringify(cfg)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(`${base}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${token}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.engine.stop());

  const setup = await page.evaluate(() => {
    const g = window.__game, b = g.battle, ctx = g.engine.context;
    const flow = ctx.get('battleFlow');
    const wr = b.siege.wallReport();
    return {
      seedUsed: b.config?.seed ?? null, strength: { ...b.strength }, units: b.units.length,
      stations: wr.stations, runs: wr.runs,
      garrison: flow.objective?.garrison ?? null, storm: flow.objective?.storm ?? null,
      garrisonOnWall0: flow.objective?.garrisonOnWall ?? 0,
    };
  });

  const series = [];
  let result = null;
  const t0 = Date.now();
  for (let t = 0; t < UNTIL && result === null; t += SAMPLE) {
    await page.evaluate((s) => window.__game.engine.advance(s, 166), SAMPLE);
    const row = await page.evaluate(() => {
      const g = window.__game, b = g.battle, ctx = g.engine.context;
      const flow = ctx.get('battleFlow');
      const s = b.siege;
      const o = flow.objective ?? {};
      const runStorm = {}, runGarr = {};
      let garrRoutOnWall = 0, stormRoutOnWall = 0;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const isG = u.faction === o.garrison, isS = u.faction === o.storm;
        if (!isG && !isS) continue;
        const ws = s.unitWallState(u.id);
        if (ws.onWall === 0) continue;
        if (u.order === 5) { if (isG) garrRoutOnWall += ws.onWall; else stormRoutOnWall += ws.onWall; }
        const tgt = isG ? runGarr : runStorm;
        for (const [r, n] of Object.entries(ws.runCounts)) tgt[r] = (tgt[r] ?? 0) + n;
      }
      // Exact stations, but only while the storm has anyone up there — that is the only
      // window in which a scoped rule can be decided, and it costs a probeMan per man.
      let stStorm = null, stGarr = null;
      if ((o.stormOnWall ?? 0) > 0) {
        stStorm = {}; stGarr = {};
        for (const u of b.units) {
          if (u.destroyed || u.alive === 0) continue;
          const isG = u.faction === o.garrison, isS = u.faction === o.storm;
          if (!isG && !isS) continue;
          if (s.unitWallState(u.id).onWall === 0) continue;
          const tgt = isG ? stGarr : stStorm;
          for (const i of u.members) {
            const pm = s.probeMan(i);
            if (pm.station >= 0) tgt[pm.station] = (tgt[pm.station] ?? 0) + 1;
          }
        }
      }
      const eng = s.engineReport?.() ?? {};
      return {
        t: +ctx.time.simTime.toFixed(1),
        stormOnWall: o.stormOnWall ?? 0, garrisonOnWall: o.garrisonOnWall ?? 0,
        stormInside: o.stormInside ?? 0, heldFor: +(o.heldFor ?? 0).toFixed(1),
        stormHolding: o.stormHolding ?? null, holdingRuns: o.holdingRuns ?? null,
        stalledFor: +(o.stalledFor ?? 0).toFixed(1),
        strength: { ...b.strength },
        runStorm, runGarr, stStorm, stGarr, garrRoutOnWall, stormRoutOnWall,
        laddersCrossed: eng.laddersCrossed ?? 0, ramBlows: eng.ramBlows ?? 0,
        result: flow.result,
      };
    });
    series.push(row);
    if (row.result) result = row.result;
  }
  const wallMs = Date.now() - t0;
  await page.close();
  return { seed, setup, series, result, errors, wallMs };
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const seed = (SEED0 + i * 0x9e3779b1) >>> 0;
  process.stderr.write(`  ${LABEL} ${i + 1}/${RUNS} seed ${seed} …`);
  const r = await runOne(seed);
  const v = r.result ? `${FACTION[r.result.victor] ?? r.result.victor} / ${r.result.reason} @${r.result.at.toFixed(0)}s`
    : `undecided @${(r.series.at(-1) ?? {}).t}s`;
  const peak = (f) => Math.max(0, ...r.series.map((s) => s[f] ?? 0));
  console.error(` ${v}  [onWall ${peak('stormOnWall')}, holding ${peak('stormHolding')}, inside ${peak('stormInside')},`
    + ` garrison0 ${r.series[0]?.garrisonOnWall ?? '-'}->${Math.min(...r.series.map((s) => s.garrisonOnWall))}]`
    + `  (${(r.wallMs / 1000).toFixed(0)}s wall, ${r.series.length} samples)`);
  runs.push(r);
  if (JSON_OUT) await writeFile(path.resolve(JSON_OUT), JSON.stringify({ map: MAP, sample: SAMPLE, runs }));
}
console.error('\noutcomes');
const out = new Map();
for (const r of runs) {
  const k = r.result ? `${FACTION[r.result.victor] ?? r.result.victor} / ${r.result.reason}` : 'undecided';
  out.set(k, (out.get(k) ?? 0) + 1);
}
for (const [k, v] of [...out].sort((a, b) => b[1] - a[1])) console.error(`  ${String(v).padStart(3)}/${RUNS}  ${k}`);
const allErr = runs.flatMap((r) => r.errors);
console.error(allErr.length ? `\n!! ${allErr.length} page errors: ${[...new Set(allErr)].slice(0, 5).join(' | ')}` : '\nno page errors');
await browser.close();
if (server) { server.kill('SIGTERM'); console.error(`• killed vite ${server.pid}`); }
