#!/usr/bin/env node
/**
 * Can the Juthungi ever take Rome?
 *
 * Not "did they this time" — the open item says *unwinnable*, and an unwinnable battle and
 * a battle that is merely hard look identical in one playtest. So this runs the assault N
 * times on N seeds under autoplay and reports the **distribution**: what ended it, when,
 * and how close the attacker got to each of the two things that could have won it.
 *
 * ## What actually counts as a win, from `src/sim/BattleFlow.ts`
 *
 *   A.  `stormOnWall >= 24` **and** `garrisonOnWall === 0`, held 20 s.
 *   B.  `stormInside >= 60` — men on the ground more than 14 m past the curtain.
 *
 * and two ways to lose:
 *
 *   C.  180 s with no new all-time low in `garrisonOnWall` -> `repulsed`.
 *   D.  t+2400 -> `repulsed`.
 *
 * So the four numbers that decide it are `stormOnWall`, `garrisonOnWall`, `stormInside` and
 * the low-water mark, and this samples all four every 20 s of sim time for the whole battle.
 * A campaign that only reported the verdict would say "repulsed, repulsed, repulsed" and
 * leave the *reason* — which of the four gates bound — unmeasured.
 *
 * ## The machines
 *
 * Alongside, per sample: towers by state, whether each ever docked, ladder crossings, ram
 * blows and gate hp. If the assault dies because its ladders are destroyed that is one fix;
 * if it dies because 20 men reach the parapet and 720 defenders never leave it, that is a
 * completely different one, and the two are told apart here and not by argument.
 *
 *   node tools/probe-romewin-ds.mjs --port=5441 --runs=8 --until=2400
 *   node tools/probe-romewin-ds.mjs --port=5441 --map=carthage --runs=4
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5441);
const MAP = args.get('map') ?? 'campus-martius';
const RUNS = Number(args.get('runs') ?? 8);
const UNTIL = Number(args.get('until') ?? 2400);
const QUALITY = args.get('quality') ?? 'high';
const DIFFICULTY = args.get('difficulty') ?? '';
const SEED0 = Number(args.get('seed0') ?? 4265438264);
const JSON_OUT = args.get('json') ?? '';
const SAMPLE = 20;

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});

const FACTION = { 0: 'Rome', 1: 'Juthungi', 2: 'Carthage' };

/** One battle, start to verdict. */
async function runOne(seed) {
  const cfg = { map: MAP, scenario: 'assault', quality: QUALITY, seed };
  if (DIFFICULTY) cfg.difficulty = DIFFICULTY;
  const token = Buffer.from(JSON.stringify(cfg))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const url =
    `${base}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${token}`;

  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, {
    timeout: 300000,
    polling: 250,
  });
  await page.evaluate(() => window.__game.engine.stop());

  const setup = await page.evaluate(() => {
    const b = window.__game.battle;
    const ctx = window.__game.engine.context;
    const flow = ctx.get('battleFlow');
    return {
      seedUsed: b.config?.seed ?? null,
      strength: { ...b.strength },
      units: b.units.length,
      unitScale: b.unitSizeScale ?? null,
      garrisonFaction: flow.objective?.garrison ?? null,
      stormFaction: flow.objective?.storm ?? null,
    };
  });

  const series = [];
  let result = null;
  const t0 = Date.now();
  for (let t = 0; t < UNTIL && result === null; t += SAMPLE) {
    await page.evaluate((s) => window.__game.engine.advance(s, 166), SAMPLE);
    const row = await page.evaluate(() => {
      const ctx = window.__game.engine.context;
      const b = window.__game.battle;
      const flow = ctx.get('battleFlow');
      const s = b.siege;
      const towers = s?.towerReport?.() ?? [];
      const eng = s?.engineReport?.() ?? {};
      const gate = s?.gateReport?.() ?? {};
      const breach = s?.breachReport?.() ?? {};
      const o = flow.objective ?? {};
      /**
       * **Where the storm's men are, by the job the scenario gave them.**
       *
       * The pilot said the assault reaches 60 men on the parapet — well past the 24 it
       * needs — and then the whole army routs at 70 % losses. That can only be read one of
       * two ways, and they call for opposite fixes: either the escalade is being killed on
       * the ladders, or the two thirds of the host that never goes near a ladder is being
       * shot in the open and taking the army's cohesion down with it. So the census is by
       * role and by distance from the wall, not army-wide.
       */
      const storm = flow.objective?.storm;
      const city = ctx.tryGet('city');
      const wallZ = city ? city.getCircuitSamples(200) : [];
      const distToWall = (u) => {
        let best = Infinity;
        for (const p of wallZ) best = Math.min(best, Math.hypot(u.x - p.x, u.z - p.z));
        return best;
      };
      const byRole = {};
      for (const u of b.units) {
        if (u.faction !== storm) continue;
        const k = u.typeId;
        const r = (byRole[k] ??= { alive: 0, initial: 0, units: 0, routing: 0, dist: 0 });
        r.alive += u.alive;
        r.initial += u.initialStrength;
        r.units++;
        if (u.order === 5) r.routing++;
        r.dist += distToWall(u);
      }
      for (const k of Object.keys(byRole)) {
        byRole[k].dist = +(byRole[k].dist / byRole[k].units).toFixed(0);
      }
      return {
        stormByRole: byRole,
        t: +ctx.time.simTime.toFixed(0),
        stormOnWall: o.stormOnWall ?? 0,
        garrisonOnWall: o.garrisonOnWall ?? 0,
        stormInside: o.stormInside ?? 0,
        heldFor: +(o.heldFor ?? 0).toFixed(1),
        strength: { ...b.strength },
        towers: towers.map((x) => x.state),
        towersDocked: towers.filter((x) => x.docked).length,
        towersCrossed: towers.reduce((a, x) => a + (x.crossed ?? 0), 0),
        ladders: eng.ladders ?? 0,
        laddersCrossed: eng.laddersCrossed ?? 0,
        ramBlows: eng.ramBlows ?? 0,
        gateHp: gate.hp ?? null,
        gateBreached: gate.breached ?? false,
        breachBays: (breach.bays ?? []).length,
        result: flow.result,
      };
    });
    series.push(row);
    if (row.result) result = row.result;
  }
  const wallMs = Date.now() - t0;

  const tail = await page.evaluate(() => {
    const ctx = window.__game.engine.context;
    const b = window.__game.battle;
    const flow = ctx.get('battleFlow');
    const s = b.siege;
    return {
      t: +ctx.time.simTime.toFixed(0),
      result: flow.result,
      stats: s?.stats?.() ?? null,
      wall: s?.wallReport?.() ?? null,
      towers: s?.towerReport?.() ?? null,
      rams: s?.ramReport?.() ?? null,
      // Is a routed defender still counted as holding the wall? The claim that decides
      // whether win condition A is reachable at all.
      garrisonUnits: b.units
        .filter((u) => s?.isGarrisoned?.(u.id))
        .map((u) => ({
          id: u.id,
          typeId: u.typeId,
          alive: u.alive,
          initial: u.initialStrength,
          order: u.order,
          morale: +(u.morale ?? 0).toFixed(2),
          onWall: s?.unitWallState?.(u.id)?.onWall ?? 0,
        })),
    };
  });

  await page.close();
  return { seed, setup, series, result, tail, errors, wallMs };
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  // Seeds spread across the 32-bit space rather than seed0+i: `Rng` mixes its input, but a
  // run of consecutive integers is the one input pattern worth not trusting a hash on.
  const seed = (SEED0 + i * 0x9e3779b1) >>> 0;
  process.stdout.write(`  run ${i + 1}/${RUNS} seed ${seed} …`);
  const r = await runOne(seed);
  const last = r.series[r.series.length - 1] ?? {};
  const verdict = r.result
    ? `${FACTION[r.result.victor] ?? r.result.victor} by ${r.result.reason} at ${r.result.at.toFixed(0)}s`
    : `undecided at ${last.t}s`;
  console.log(
    ` ${verdict}  [maxOnWall ${Math.max(0, ...r.series.map((s) => s.stormOnWall))}` +
      `, minGarrison ${Math.min(...r.series.map((s) => s.garrisonOnWall))}` +
      `, maxInside ${Math.max(0, ...r.series.map((s) => s.stormInside))}]` +
      ` (${(r.wallMs / 1000).toFixed(0)}s wall)`,
  );
  runs.push(r);
}

// ---------------------------------------------------------------------------
// The distribution
// ---------------------------------------------------------------------------
console.log(`\n=== ${MAP}, ${RUNS} runs, ${QUALITY}, cap ${UNTIL}s ===`);
const s0 = runs[0].setup;
console.log(
  `order of battle: ${s0.units} units, strength ${JSON.stringify(s0.strength)}, ` +
    `unit scale ${s0.unitScale}; storm = ${FACTION[s0.stormFaction]}, garrison = ${FACTION[s0.garrisonFaction]}`,
);

const outcomes = new Map();
for (const r of runs) {
  const k = r.result
    ? `${FACTION[r.result.victor] ?? r.result.victor} / ${r.result.reason}`
    : 'undecided';
  outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
}
console.log('\noutcomes');
for (const [k, v] of [...outcomes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}/${RUNS}  ${k}`);
}

console.log('\nhow close the assault came, per run');
console.log(
  '  seed        ended            at    maxOnWall  needs24  garrisonLow  needs0  maxInside  needs60',
);
for (const r of runs) {
  const maxOn = Math.max(0, ...r.series.map((s) => s.stormOnWall));
  const minG = Math.min(...r.series.map((s) => s.garrisonOnWall));
  const maxIn = Math.max(0, ...r.series.map((s) => s.stormInside));
  console.log(
    `  ${String(r.seed).padStart(10)}  ${(r.result?.reason ?? 'undecided').padEnd(12)} ` +
      `${String(r.result ? r.result.at.toFixed(0) : '-').padStart(6)}  ` +
      `${String(maxOn).padStart(9)}  ${maxOn >= 24 ? '  MET' : '  no '}  ` +
      `${String(minG).padStart(11)}  ${minG === 0 ? '  MET' : '  no '}  ` +
      `${String(maxIn).padStart(9)}  ${maxIn >= 60 ? '  MET' : '  no '}`,
  );
}

console.log('\nthe machines, at the end of each run');
console.log('  seed        towers docked/4  crossed  ladders  crossed  ramBlows  gateHp  breached');
for (const r of runs) {
  const last = r.series[r.series.length - 1] ?? {};
  const maxDock = Math.max(0, ...r.series.map((s) => s.towersDocked));
  console.log(
    `  ${String(r.seed).padStart(10)}  ${String(maxDock).padStart(14)}  ` +
      `${String(last.towersCrossed ?? 0).padStart(7)}  ${String(last.ladders ?? 0).padStart(7)}  ` +
      `${String(last.laddersCrossed ?? 0).padStart(7)}  ${String(last.ramBlows ?? 0).padStart(8)}  ` +
      `${String(last.gateHp ?? '-').padStart(6)}  ${String(last.gateBreached ?? false).padStart(8)}`,
  );
}

// Where the storm's manpower went, by the job it was given. Averaged over the runs, at the
// last sample of each.
console.log('\nthe storm, by role, at the end — averaged over the runs');
console.log('  role                    units   alive/initial     lost%   mean dist to wall');
{
  const agg = new Map();
  for (const r of runs) {
    const last = r.series[r.series.length - 1];
    for (const [k, v] of Object.entries(last.stormByRole ?? {})) {
      const a = agg.get(k) ?? { alive: 0, initial: 0, units: 0, dist: 0, n: 0 };
      a.alive += v.alive; a.initial += v.initial; a.units += v.units; a.dist += v.dist; a.n++;
      agg.set(k, a);
    }
  }
  for (const [k, a] of [...agg].sort((x, y) => y[1].initial - x[1].initial)) {
    const lost = a.initial ? ((1 - a.alive / a.initial) * 100).toFixed(1) : '-';
    console.log(
      `  ${k.padEnd(22)} ${String((a.units / a.n).toFixed(0)).padStart(5)}   ` +
        `${String(Math.round(a.alive / a.n)).padStart(5)}/${String(Math.round(a.initial / a.n)).padEnd(6)} ` +
        `${String(lost).padStart(8)}   ${String(Math.round(a.dist / a.n)).padStart(8)} m`,
    );
  }
}

// The hypothesis that decides whether win A is reachable: are broken defenders still
// counted as holding the parapet?
console.log('\nat the final tick — is a broken garrison still on the wall?');
for (const r of runs.slice(0, 3)) {
  const g = r.tail.garrisonUnits ?? [];
  const routed = g.filter((u) => u.order === 5 /* UnitOrder.Rout */ || u.morale < 0.2);
  const routedOnWall = routed.reduce((a, u) => a + u.onWall, 0);
  console.log(
    `  seed ${r.seed}: ${g.length} garrison units, ${g.reduce((a, u) => a + u.onWall, 0)} men on the wall; ` +
      `${routed.length} unit(s) broken, still holding ${routedOnWall} stations`,
  );
}

// Where the wall census went over time, for the first run, so the shape is visible.
const r0 = runs[0];
console.log(`\ntime series, seed ${r0.seed} (every ${SAMPLE * 3}s)`);
console.log('     t   stormOnWall  garrisonOnWall  stormInside  heldFor  Juthungi  Rome');
for (let i = 0; i < r0.series.length; i += 3) {
  const s = r0.series[i];
  console.log(
    `  ${String(s.t).padStart(4)}  ${String(s.stormOnWall).padStart(11)}  ` +
      `${String(s.garrisonOnWall).padStart(14)}  ${String(s.stormInside).padStart(11)}  ` +
      `${String(s.heldFor).padStart(7)}  ${String(s.strength[1] ?? 0).padStart(8)}  ${String(s.strength[0] ?? 0).padStart(4)}`,
  );
}

const allErrors = runs.flatMap((r) => r.errors);
if (allErrors.length) {
  console.log(`\n!! ${allErrors.length} page error(s):`);
  for (const e of [...new Set(allErrors)].slice(0, 10)) console.log(`   ${e}`);
} else {
  console.log('\nno page errors in any run');
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ map: MAP, quality: QUALITY, runs }, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}

await browser.close();
if (server) {
  server.kill('SIGTERM');
  console.log(`• killed vite pid ${server.pid}`);
}
