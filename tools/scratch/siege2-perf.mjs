#!/usr/bin/env node
/**
 * `fixedUpdate` cost with the siege active, measured the way probe-nav does it: presenting
 * is suppressed so the number is sim cost and not render cost, and the clock is driven by
 * hand so every frame runs exactly one fixed step.
 *
 *   node tools/scratch/siege2-perf.mjs --port=5581 [--at=300] [--ticks=900] [--traverse]
 */
import { chromium } from 'playwright';

const arg = (k, d) => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const PORT = Number(arg('port', '5581'));
const AT = Number(arg('at', '300'));
const TICKS = Number(arg('ticks', '900'));
const TRAVERSE = process.argv.includes('--traverse');
const SCENARIO = arg('scenario', 'assault');

const base = `http://127.0.0.1:${PORT}`;
const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
if (!r || !r.ok) { console.error('NO LIVE DEV SERVER on', PORT); process.exit(2); }
const src = await (await fetch(`${base}/src/sim/Siege.ts`)).text();
if (!src.includes('MAX_WALL_RANKS = 5')) { console.error('STALE BUNDLE on', PORT); process.exit(3); }
console.log('• live dev server at', base, '(serving current Siege.ts)');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&scenario=${SCENARIO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, {}, { timeout: 420000 });

console.log(`• advancing to t+${AT} s…`);
await page.evaluate((t) => window.__game.advance(t), AT);

if (TRAVERSE) {
  const staged = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    const bays = g.engine.context.get('city').getGarrisonBays();
    const gi = bays.findIndex((x) => x.isGate);
    let up = 0;
    let along = 0;
    for (const u of b.units) {
      if (u.destroyed || u.alive < 5) continue;
      if (s.isGarrisoned(u.id)) {
        const st = s.unitWallState(u.id);
        if (!st.runs.length) continue;
        const w = s.wallReport();
        const link = w.linkUse.find((l) => (l.kind === 'towerPass' || l.kind === 'step')
          && (l.runA === st.runs[0] || l.runB === st.runs[0]));
        if (!link) continue;
        const want = link.runA === st.runs[0] ? link.runB : link.runA;
        const pt = s.stationWorld(want);
        if (pt.station >= 0 && s.moveAlongWall(u, pt.x, pt.z)) along++;
      } else if (u.faction === 0 && !s.ownsUnit(u.id)) {
        const bay = bays[gi + 2] ?? bays[gi];
        if (s.sendToWall(u, (bay.x0 + bay.x1) * 0.5, (bay.z0 + bay.z1) * 0.5)) up++;
      }
    }
    return { up, along };
  });
  console.log(`• staged: ${staged.up} unit(s) up a stair, ${staged.along} along the wall`);
  await page.evaluate(() => window.__game.advance(25));
}

const out = await page.evaluate((ticks) => {
  const g = window.__game;
  const engine = g.engine;
  const ctx = engine.context;
  const battle = g.battle;

  engine.stop();
  const savedRender = engine.renderOverride;
  engine.renderOverride = () => {};

  const samples = [];
  const orig = battle.fixedUpdate.bind(battle);
  battle.fixedUpdate = (dt, c) => {
    const t0 = performance.now();
    orig(dt, c);
    samples.push(performance.now() - t0);
  };

  ctx.time.resync();
  let clock = 0;
  engine.frame(clock);
  const FRAME_MS = (1000 / 30) * (1 + 1e-9);
  for (let i = 0; i < ticks; i++) { clock += FRAME_MS; engine.frame(clock); }

  battle.fixedUpdate = orig;
  engine.renderOverride = savedRender;

  const p = battle.pool;
  let men = 0;
  for (let i = 0; i < p.count; i++) if (p.aliveAt(i)) men++;
  const s = battle.siege;
  const st = s.stats();
  samples.sort((a, b) => a - b);
  const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  const mean = samples.reduce((a, v) => a + v, 0) / Math.max(1, samples.length);
  return {
    n: samples.length, men,
    mean, p50: pick(0.5), p95: pick(0.95), worst: samples[samples.length - 1],
    over4: samples.filter((v) => v > 4).length / Math.max(1, samples.length),
    garrisonMen: st.garrisonMen, crossing: st.crossing,
    links: s.wallReport().linkUse.filter((l) => l.used > 0).length,
  };
}, TICKS);

console.log(`\n=== fixedUpdate, ${out.n} ticks, ${out.men} living men ===`);
console.log(`  mean ${out.mean.toFixed(3)} ms   p50 ${out.p50.toFixed(3)}   p95 ${out.p95.toFixed(3)}   worst ${out.worst.toFixed(3)}`);
console.log(`  over 4 ms: ${(out.over4 * 100).toFixed(1)} % of ticks`);
console.log(`  ${out.garrisonMen} garrisoned, ${out.crossing} on crossings, ${out.links} links carrying traffic`);
await browser.close();
