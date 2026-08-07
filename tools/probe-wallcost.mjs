#!/usr/bin/env node
/**
 * What the wall doctrine costs the tactical layer, A/B in one session.
 *
 * `fixedUpdate` has 3.657 ms of a 4 ms budget at 8,632 men, so a new per-unit query that
 * walks a member list has to be priced rather than assumed. The two arms differ by one
 * field: `TacticalAISystem.wall` null disables both halves of the change at once — the
 * `moveTo` refusal and the `Parapet` behaviour — so the "before" arm is this tree with the
 * feature off rather than a different tree measured on a different day.
 *
 * A/B/A, because machine load is one-sided: it can only add time, so a base arm that does
 * not come back is the run telling you it was contended. The arms genuinely diverge as they
 * run (turning the doctrine off changes what the army does), so read this as a cost
 * measurement and nothing else.
 *
 * Usage: node tools/probe-wallcost.mjs --port=5391 [--map=carthage] [--warm=87] [--block=20]
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5391);
const MAP = args.get('map') ?? '';
const WARM = Number(args.get('warm') ?? 87);
const BLOCK = Number(args.get('block') ?? 20);

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${base}/?harness=1&scenario=assault&autoplay=1&quality=low${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

await page.evaluate(async () => {
  const g = window.__game;
  g.engine.stop();
  const prof = await import('/src/ai/profile.ts');
  const t = g.engine.context.get('tactical-ai');
  const keep = t.wall;
  window.__wc = {
    warm: (s) => g.engine.advance(s, 166),
    arm: (on, s) => {
      t.wall = on ? keep : null;
      prof.setAIProfiling(true);
      g.engine.advance(s, 166);
      const r = {
        tactical: +prof.AIProfile.avg.tactical.toFixed(3),
        peak: +prof.AIProfile.peak.tactical.toFixed(3),
        total: +prof.AIProfile.totalAvg().toFixed(3),
        orders: t.stats.wallOrders, descents: t.stats.descents, traverses: t.stats.traverses,
      };
      prof.setAIProfiling(false);
      return r;
    },
    men: () => g.battle.pool.count,
    t: () => +g.engine.time.simTime.toFixed(1),
  };
});

await page.evaluate(`window.__wc.warm(${WARM})`);
const men = await page.evaluate('window.__wc.men()');
const rows = [];
for (const [label, on] of [['doctrine ON ', true], ['doctrine off', false], ['doctrine ON ', true]]) {
  rows.push([label, await page.evaluate(`window.__wc.arm(${on}, ${BLOCK})`),
    await page.evaluate('window.__wc.t()')]);
}
console.log(`${MAP || 'campusMartius'}  ${men} men in the pool, ${BLOCK}s blocks from t+${WARM}`);
for (const [label, r, t] of rows) {
  console.log(`  ${label}  tactical avg ${String(r.tactical).padStart(6)} ms  peak ${String(r.peak).padStart(6)}`
    + `  ai total ${String(r.total).padStart(6)}  wall orders ${r.orders} (${r.descents} down / ${r.traverses} along)  to t+${t}`);
}
if (errs.length) console.error('page errors:', errs.slice(0, 3));
await browser.close();
