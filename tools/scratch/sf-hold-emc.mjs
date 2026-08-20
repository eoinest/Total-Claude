/**
 * Once the storm has a lodgement, does the defence ever take it back?
 *
 * `WALL_HOLD_SECONDS = 20` is the whole of Rome's assault: 9 of the 24 seeds measured end on
 * it, and the other conditions barely fire. Twenty seconds is shorter than the time it takes
 * a player to *select a unit and give it an order* — so if the answer here is "the lodgement
 * never breaks", then the constant is a pure delay in an AI-vs-AI battle and lengthening it
 * costs the attacker nothing while handing a human defender the only window he has.
 *
 * The measurement suppresses `BattleFlow.finish` on the instance — a private TypeScript
 * method is an ordinary JavaScript property — records what it *would* have declared, and
 * then keeps running so `parapetHeldFor` can go on accumulating past the twenty seconds the
 * rules stop it at. Nothing in `src/` is touched.
 *
 *   node tools/scratch/sf-hold-emc.mjs --port=5491 --seeds=12 --until=1200
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5491);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'high';
const UNTIL = Number(A.get('until') ?? 1200);
const SEEDS = Number(A.get('seeds') ?? 12);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const LABEL = A.get('label') ?? 'hold';
const K = 0x9e3779b1;
/** An explicit comma-separated seed list, for re-asking the question of the seeds that lodge. */
const LIST = A.has('seedlist') ? String(A.get('seedlist')).split(',').map(Number) : null;
const OUT = path.join(ROOT, 'screenshots/siegefun');
await mkdir(OUT, { recursive: true });
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const out = [];
const SEEDLIST = LIST ?? Array.from({ length: SEEDS }, (_, i) => (SEED0 + i * K) >>> 0);
for (let i = 0; i < SEEDLIST.length; i++) {
  const seed = SEEDLIST[i];
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed })}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
  await p.evaluate(() => window.__game.engine.stop());
  await p.evaluate(() => {
    const flow = window.__game.engine.context.get('battleFlow');
    window.__calls = [];
    flow.finish = function (_ctx, victor, reason) {
      window.__calls.push({ victor, reason, at: +this.elapsed.toFixed(0) });
    };
  });
  const series = [];
  for (let t = 0; t < UNTIL; t += 5) {
    series.push(await p.evaluate(() => {
      const g = window.__game, ctx = g.engine.context;
      g.engine.advance(5, 166);
      const flow = ctx.get('battleFlow');
      const o = flow.objective ?? {};
      return { t: +ctx.time.simTime.toFixed(0), holding: o.stormHolding ?? 0, held: +(o.heldFor ?? 0).toFixed(0),
        onWall: o.stormOnWall ?? 0, garr: o.garrisonOnWall ?? 0, inside: o.stormInside ?? 0,
        calls: window.__calls.length };
    }));
  }
  const calls = await p.evaluate(() => window.__calls.slice(0, 4));
  await p.close();
  const firstWould = calls.find((c) => c.reason === 'objective') ?? calls[0] ?? null;
  const maxHeld = Math.max(0, ...series.map((r) => r.held));
  // Did the hold ever break after passing 20 s? A reset to 0 after held >= 20 is the defence
  // taking the stretch back, which is the only thing a longer window could cost the storm.
  let brokeAfter20 = null;
  for (let k = 1; k < series.length; k++) {
    if (series[k - 1].held >= 20 && series[k].held === 0) { brokeAfter20 = series[k].t; break; }
  }
  out.push({ seed, wouldEnd: firstWould, allCalls: calls, maxHeld, brokeAfter20, errs: errs.length });
  const o = out[out.length - 1];
  console.log(`  ${String(seed).padStart(11)}  would end: ${o.wouldEnd ? `${o.wouldEnd.victor === 1 ? 'STORM' : 'garr '} ${o.wouldEnd.reason} @${o.wouldEnd.at}` : 'never in window'}   maxHeldFor ${String(o.maxHeld).padStart(4)}s   hold broken after 20 s: ${o.brokeAfter20 === null ? 'no' : 't+' + o.brokeAfter20}`);
}
const lodged = out.filter((o) => o.maxHeld >= 20);
console.log(`\n# ${LABEL}: ${lodged.length}/${out.length} seeds form a lodgement that reaches 20 s inside ${UNTIL}s`);
console.log(`  of those, the defence takes the stretch back before 45 s: ${lodged.filter((o) => o.brokeAfter20 !== null && o.brokeAfter20 !== undefined).length}`);
console.log(`  max heldFor per lodging seed: ${lodged.map((o) => o.maxHeld).sort((a, c) => a - c).join(', ')}`);
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify(out, null, 1));
await b.close();
