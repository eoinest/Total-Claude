/**
 * Does covering the hole pay? The defender's one obvious move, measured.
 *
 * `probe-footing` established that Rome's garrison never puts a man within 60 m of a footing
 * bay, in fifteen samples over 568 s, while up to 138 attackers stand in one. On the Campus
 * Martius the player *is* Rome, so this is the defender's most obvious idea and nothing in
 * the game does it for him. This does it — by ordinary move orders through the same
 * `orderIssued` channel the mouse uses — and reports whether it changes anything.
 *
 * Arms:
 *   none   the shipped battle
 *   plug   Rome's reserve cohorts are sent to stand on the inner face of the open bays at t+0
 *
 *   node tools/scratch/sf-plug-emc.mjs --port=5491 --arm=plug --seeds=12
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5491);
const QUALITY = A.get('quality') ?? 'high';
const ARM = A.get('arm') ?? 'none';
const UNTIL = Number(A.get('until') ?? 2400);
const SEEDS = Number(A.get('seeds') ?? 12);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const K = 0x9e3779b1;
const OUT = path.join(ROOT, 'screenshots/siegefun');
await mkdir(OUT, { recursive: true });
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const out = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = (SEED0 + i * K) >>> 0;
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: 'campus-martius', scenario: 'assault', quality: QUALITY, seed })}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
  await p.evaluate(() => window.__game.engine.stop());

  const setup = await p.evaluate((arm) => {
    const g = window.__game, ctx = g.engine.context;
    const city = ctx.get('city');
    const flow = ctx.get('battleFlow');
    const garr = flow.objective ? flow.objective.garrison : 0;
    const bays = city.getGarrisonBays();
    const open = bays.filter((q) => !q.garrisonable);
    window.__pl = { open: open.map((q) => q.index), garr };
    if (arm !== 'plug') return { open: window.__pl.open, ordered: [] };
    /*
     * The reserve, and only the reserve. Taking men off the parapet to cover a hole is a
     * different decision with its own cost; this is the cheapest version of the idea, using
     * the units the scenario already calls "the reserve, to plug whatever gets over".
     */
    const reserve = g.battle.units.filter((u) => !u.destroyed && u.faction === garr
      && u.typeId === 'legio-cohort');
    const ordered = [];
    open.forEach((q, k) => {
      const u = reserve[k % Math.max(1, reserve.length)];
      if (!u) return;
      const cx = (q.x0 + q.x1) * 0.5, cz = (q.z0 + q.z1) * 0.5;
      // 18 m inside the line, square across the gap: a stopper, not a sally.
      ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'attackMove',
        x: cx - q.nx * 18, z: cz - q.nz * 18, facing: Math.atan2(q.nx, q.nz) });
      ordered.push({ unit: u.id, bay: q.index, men: u.alive });
    });
    return { open: window.__pl.open, ordered };
  }, ARM);

  let result = null; let peakInside = 0;
  for (let t = 0; t < UNTIL && result === null; t += 20) {
    const row = await p.evaluate(() => {
      const g = window.__game, ctx = g.engine.context;
      g.engine.advance(20, 166);
      const flow = ctx.get('battleFlow');
      const o = flow.objective ?? {};
      return { t: +ctx.time.simTime.toFixed(0), inside: o.stormInside ?? 0, holding: o.stormHolding ?? 0,
        result: flow.result ? { victor: flow.result.victor, reason: flow.result.reason, at: +flow.result.at.toFixed(0) } : null };
    });
    peakInside = Math.max(peakInside, row.inside);
    if (row.result) result = row.result;
  }
  await p.close();
  out.push({ seed, arm: ARM, ordered: setup.ordered, openBays: setup.open, peakInside, result, errs: errs.length });
  console.log(`  ${String(seed).padStart(11)}  peakInside ${String(peakInside).padStart(3)}  ${result ? `${result.victor === 1 ? 'STORM' : result.victor === 0 ? 'garr ' : 'draw '} ${result.reason} @${result.at}` : 'undecided'}`);
}
const wins = out.filter((o) => o.result && o.result.victor === 1).length;
console.log(`\n# plug arm=${ARM}: storm wins ${wins}/${out.length}   open bays ${JSON.stringify(out[0].openBays)}   ordered ${JSON.stringify(out[0].ordered)}`);
await writeFile(path.join(OUT, `plug-${ARM}.json`), JSON.stringify(out, null, 1));
await b.close();
