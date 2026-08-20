/**
 * The ram's fate as a *distribution*, and the battle it is standing in.
 *
 * `so-ramline.mjs` prints one seed and never asks `BattleFlow` whether the battle is still
 * going. On the default seed — 4265438264, which is also the seed the pinned schedule in
 * `docs/tech/SIEGE.md` 5.1 was taken on — the Juthungi win the objective at **t+134**, and
 * every figure that schedule quotes after that (13 blows at t+160, 23 blows, the crew's rout
 * at t+215, the wreck at t+260) is read off a tableau in which `finish()` has already put
 * every standing Juthungi unit on Hold. This runs the same measurement over as many seeds as
 * you ask for and prints the result line beside the ram line, so a schedule cannot be quoted
 * out of a battle that is over.
 *
 *   node tools/scratch/sf-ram-emc.mjs --port=5491 --seeds=12 --until=420
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5491);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'high';
const UNTIL = Number(A.get('until') ?? 420);
const SEEDS = Number(A.get('seeds') ?? 12);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const LABEL = A.get('label') ?? 'ram';
const K = 0x9e3779b1;
const OUT = path.join(ROOT, 'screenshots/siegefun');
await mkdir(OUT, { recursive: true });
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const out = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = (SEED0 + i * K) >>> 0;
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed })}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
  await p.evaluate(() => window.__game.engine.stop());
  const series = [];
  for (let t = 0; t < UNTIL; t += 10) {
    series.push(await p.evaluate(() => {
      const g = window.__game, ctx = g.engine.context;
      g.engine.advance(10, 166);
      const flow = ctx.get('battleFlow');
      const s = g.battle.siege;
      const gr = s.gateReport();
      const rr = (s.ramReport() ?? []).filter((x) => x.kind === 'gate')[0] ?? {};
      const o = flow.objective ?? {};
      return { t: +ctx.time.simTime.toFixed(0), blows: gr.blows, open: gr.open, hp: +(gr.hp ?? 0).toFixed(2),
        state: rr.state, crew: rr.crewAlive ?? 0, rout: !!rr.crewRouting, owned: !!rr.owned,
        derelict: +(rr.derelictFor ?? 0).toFixed(0),
        onWall: o.stormOnWall ?? 0, holding: o.stormHolding ?? 0, inside: o.stormInside ?? 0,
        result: flow.result ? { victor: flow.result.victor, reason: flow.result.reason, at: +flow.result.at.toFixed(0) } : null };
    }));
  }
  await p.close();
  const last = series[series.length - 1];
  const maxBlows = Math.max(...series.map((r) => r.blows));
  const firstRout = series.find((r) => r.rout);
  const opened = series.find((r) => r.open);
  const res = series.find((r) => r.result)?.result ?? null;
  out.push({ seed, maxBlows, hpEnd: last.hp, opened: opened ? opened.t : null,
    crewRoutAt: firstRout ? firstRout.t : null, crewEnd: last.crew, state: last.state,
    result: res, errs: errs.length });
  const o = out[out.length - 1];
  console.log(`  ${String(seed).padStart(11)}  blows ${String(o.maxBlows).padStart(2)}/26  hp ${String(Math.round(o.hpEnd * 100)).padStart(3)}%  `
    + `gateOpen ${o.opened === null ? '  never' : 't+' + String(o.opened).padStart(4)}  crewRout ${o.crewRoutAt === null ? ' never' : 't+' + String(o.crewRoutAt).padStart(4)}  `
    + `battle ${o.result ? `${o.result.victor === 1 ? 'STORM' : 'garr '} ${o.result.reason} @${o.result.at}` : `live past t+${UNTIL}`}`);
}
const decidedBeforeRam = out.filter((o) => o.result && o.crewRoutAt !== null && o.result.at < o.crewRoutAt).length;
console.log(`\n# ${LABEL} ${MAP} q=${QUALITY} ${SEEDS} seeds, window ${UNTIL}s`);
console.log(`  gate opened in ${out.filter((o) => o.opened !== null).length}/${SEEDS};  median max blows ${[...out.map((o) => o.maxBlows)].sort((a, c) => a - c)[Math.floor(SEEDS / 2)]}`);
console.log(`  battle already decided before the ram crew broke in ${decidedBeforeRam}/${SEEDS}`);
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify(out, null, 1));
await b.close();
