#!/usr/bin/env node
/**
 * Does a dying elephant turn on the spot?
 *
 * `UnitRenderSystem.preRender` turns a man who has no ragdoll pose toward his own death
 * direction, so his authored fall clip points where the blow pushed him. An elephant has no
 * ragdoll pose by design, so it takes that branch too — and the question is how far four
 * tonnes rotates while it collapses, and whether the drawn heading still agrees with the
 * heading `BattleSystem.partCarcasses` builds its capsule on.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5691);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=low&enemy=carthage`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  g.engine.advance(8, 166);
  const u = b.units.find((x) => x.typeId === 'war-elephants' && !x.destroyed);
  const v = u.members.find((i) => p.aliveAt(i));
  const rows = [];
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const wrap = (r) => { let d = r % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  const snap = (t) => {
    // Reproduce exactly what `preRender` computes for this animal.
    let facing = b.renderFacing(v, 1);
    const raw = facing;
    if ((p.state[v] === 10 || p.state[v] === 11) && (p.deathDirX[v] !== 0 || p.deathDirZ[v] !== 0)) {
      const target = Math.atan2(-p.deathDirX[v], -p.deathDirZ[v]);
      facing += wrap(target - facing) * Math.min(1, p.animTime[v] * 2.5);
    }
    rows.push({
      t, state: p.state[v], animTime: +p.animTime[v].toFixed(3),
      poolFacing: deg(p.facing[v]), renderRaw: deg(raw), drawn: deg(facing),
      turnFromPool: deg(wrap(facing - p.facing[v])),
    });
  };
  snap(-0.01);
  // Kill it from dead astern, so the death direction is a full half-turn from its heading.
  const f = p.facing[v];
  b.damage(v, 1e6, p.x[v] - Math.sin(f) * 6, p.z[v] - Math.cos(f) * 6, -1);
  snap(0);
  let acc = 0;
  for (const m of [0.1, 0.2, 0.35, 0.6, 1.0, 1.6, 3.0]) {
    g.engine.advance(m - acc, 33);
    acc = m;
    snap(m);
  }
  return { victim: v, rows };
});

console.log('   t state animT  poolFacing  renderRaw  drawn  turnFromPool');
for (const r of out.rows) {
  console.log(`${String(r.t).padStart(5)} ${String(r.state).padStart(5)} ${String(r.animTime).padStart(5)} `
    + `${String(r.poolFacing).padStart(11)} ${String(r.renderRaw).padStart(10)} ${String(r.drawn).padStart(6)} `
    + `${String(r.turnFromPool).padStart(13)}`);
}
await browser.close();
