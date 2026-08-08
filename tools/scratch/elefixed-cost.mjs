#!/usr/bin/env node
/**
 * What the tick costs with a field of carcasses on it, and what `partCarcasses` costs.
 *
 * `fixedUpdate` has a 4 ms budget and the only thing this workstream puts inside it is
 * `BattleSystem.partCarcasses` — one broadphase query per dead animal per tick. Priced by an
 * interleaved A/B in one page load, alternating blocks, because cross-session timing is not a
 * measurement on this box: the `full` arm is the battle as it stands with every elephant
 * dead, the `none` arm is the same instant with the carcass list emptied. Best block as well
 * as median, because contention here is one-sided and can only add time.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5691);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=ultra&enemy=carthage`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;

  // Run into the melee, then kill every animal, so the arm with carcasses has the most of
  // them the game can produce.
  g.engine.advance(70, 166);
  const eles = b.units.filter((u) => u.typeId === 'war-elephants')
    .flatMap((u) => [...u.members]);
  for (const i of eles) if (p.aliveAt(i)) b.damage(i, 1e6, p.x[i], p.z[i] - 5, -1);
  g.engine.advance(6, 166);

  // Instrument every subsystem's fixedUpdate in place. Timing the sum rather than the
  // battle alone, because the 4 ms line in ARCHITECTURE is on the whole tick.
  // `Engine.systems` is `private` in TypeScript, which is compile-time only.
  const list = (g.engine.systems ?? []).filter((s) => s && typeof s.fixedUpdate === 'function');
  if (list.length === 0) return { error: 'could not reach the subsystem list' };

  let acc = 0;
  let ticks = 0;
  const originals = new Map();
  for (const s of list) {
    const fn = s.fixedUpdate.bind(s);
    originals.set(s, s.fixedUpdate);
    s.fixedUpdate = (dt, ctx) => {
      const t0 = performance.now();
      fn(dt, ctx);
      acc += performance.now() - t0;
    };
  }
  const battle = list.find((s) => s.name === 'battle');
  const bfn = battle.fixedUpdate;
  battle.fixedUpdate = (dt, ctx) => { ticks++; bfn(dt, ctx); };

  const carc = b.elephantCarcasses;
  const saved = [...carc];
  const block = (withCarcasses) => {
    // `elephantCarcasses` returns the live array, so emptying it is how the `none` arm runs
    // the identical world with the pass switched off. Restored from `saved` every time.
    carc.length = 0;
    if (withCarcasses) for (const i of saved) carc.push(i);
    acc = 0; ticks = 0;
    g.engine.advance(2.0, 33);
    return { ms: ticks ? acc / ticks : -1, ticks };
  };

  const arms = { full: [], none: [] };
  // Warm one block of each before recording, then alternate six times.
  block(true); block(false);
  for (let k = 0; k < 6; k++) {
    arms.full.push(block(true).ms);
    arms.none.push(block(false).ms);
  }
  for (const [s, fn] of originals) s.fixedUpdate = fn;
  carc.length = 0;
  for (const i of saved) carc.push(i);

  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { best: +s[0].toFixed(3), median: +s[Math.floor(s.length / 2)].toFixed(3), n: a.length };
  };
  return {
    men: p.count,
    alive: (() => { let n = 0; for (let i = 0; i < p.count; i++) if (p.aliveAt(i)) n++; return n; })(),
    carcasses: saved.length,
    subsystems: list.length,
    full: stat(arms.full), none: stat(arms.none),
    fullRaw: arms.full.map((x) => +x.toFixed(3)),
    noneRaw: arms.none.map((x) => +x.toFixed(3)),
  };
});

console.log(JSON.stringify(out, null, 2));
if (!out.error) {
  console.log(`\nmen in pool ${out.men} (${out.alive} alive), carcasses ${out.carcasses}`);
  console.log(`fixedUpdate ms/tick, whole tick, ${out.subsystems} subsystems:`);
  console.log(`  with ${out.carcasses} carcasses: best ${out.full.best}  median ${out.full.median}`);
  console.log(`  with 0 carcasses:  best ${out.none.best}  median ${out.none.median}`);
  console.log(`  partCarcasses costs best ${(out.full.best - out.none.best).toFixed(3)} ms, `
    + `median ${(out.full.median - out.none.median).toFixed(3)} ms per tick`);
}
await browser.close();
