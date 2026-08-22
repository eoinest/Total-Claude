#!/usr/bin/env node
/**
 * Where are the men condition B is counting, in world coordinates?
 *
 * `censusWall` finds a man's bay by arithmetic and **clamps** the index to the ends of the
 * circuit: `k = clamp(round((x - x0) / pitch), 0, last)`. Then it measures his depth along
 * *that* bay's outward normal. For a man standing beyond the end of the wall there is no bay
 * behind him, and the clamp gives him the end bay's normal anyway.
 *
 * This asks the pool directly, at the tick B fires, and prints for every counted man: his
 * world position, the unclamped index, the clamped bay, the nearest bay and how far away its
 * midpoint is, and the depth read both ways.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5964);
const MAP = process.argv[3] ?? 'campus-martius';
const SEED = Number(process.argv[4] ?? 4265438264);
const base = `http://127.0.0.1:${PORT}`;
const cfg = { map: MAP, scenario: 'assault', quality: 'high', seed: SEED };
const token = Buffer.from(JSON.stringify(cfg)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(`${base}/?harness=1&w=480&h=270&quality=high&scenario=assault&autoplay=1&battle=${token}`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(() => window.__game.engine.stop());

const span = await page.evaluate(() => {
  const city = window.__game.engine.context.tryGet('city');
  const bays = city.getGarrisonBays();
  const n = bays.length;
  return {
    n,
    x0: (bays[0].x0 + bays[0].x1) / 2,
    xN: (bays[n - 1].x0 + bays[n - 1].x1) / 2,
    ends: [bays[0].x0, bays[0].x1, bays[n - 1].x0, bays[n - 1].x1].map((v) => +v.toFixed(1)),
    wallReport: window.__game.battle.siege.wallReport?.() ?? null,
  };
});
console.log(`bays ${span.n}, bay-0 mid x ${span.x0.toFixed(1)}, bay-${span.n - 1} mid x ${span.xN.toFixed(1)}`);
console.log(`circuit x extent from bay corners: ${JSON.stringify(span.ends)}`);

let fired = null;
for (let t = 0; t < 400 && !fired; t += 2) {
  fired = await page.evaluate(() => {
    window.__game.engine.advance(2, 166);
    const ctx = window.__game.engine.context;
    const b = window.__game.battle;
    const flow = ctx.get('battleFlow');
    const o = flow.objective;
    if (!o || o.stormInside < o.needInside) return null;
    const city = ctx.tryGet('city');
    const bays = city.getGarrisonBays();
    const n = bays.length;
    const mx = bays.map((x) => (x.x0 + x.x1) / 2);
    const mz = bays.map((x) => (x.z0 + x.z1) / 2);
    const pitch = (mx[n - 1] - mx[0]) / (n - 1);
    const p = b.pool;
    const rows = [];
    for (let i = 0; i < p.count; i++) {
      if (p.faction[i] !== o.storm || b.elevated[i] !== 0 || !p.aliveAt(i)) continue;
      const raw = Math.round((p.x[i] - mx[0]) / pitch);
      const k = Math.max(0, Math.min(n - 1, raw));
      const depth = (p.x[i] - mx[k]) * bays[k].nx + (p.z[i] - mz[k]) * bays[k].nz;
      if (depth >= -o.insideMargin) continue;
      let nk = 0; let nd = Infinity;
      for (let j = 0; j < n; j++) {
        const d2 = (p.x[i] - mx[j]) ** 2 + (p.z[i] - mz[j]) ** 2;
        if (d2 < nd) { nd = d2; nk = j; }
      }
      const trueDepth = (p.x[i] - mx[nk]) * bays[nk].nx + (p.z[i] - mz[nk]) * bays[nk].nz;
      const u = b.units.find((q) => q.members.includes(i));
      rows.push({
        x: +p.x[i].toFixed(0), z: +p.z[i].toFixed(0), raw, k,
        clamped: raw !== k, depth: +depth.toFixed(0),
        nk, nd: +Math.sqrt(nd).toFixed(0), trueDepth: +trueDepth.toFixed(0),
        stage: bays[k].stage, type: u ? u.typeId : '?',
      });
    }
    return {
      t: +ctx.time.simTime.toFixed(0),
      stormInside: o.stormInside, stormHolding: o.stormHolding, stormOnWall: o.stormOnWall,
      garrisonOnWall: o.garrisonOnWall, rows,
    };
  });
}
if (!fired) { console.log('condition B never reached inside 400 s'); await browser.close(); process.exit(0); }

console.log(`\ncondition B satisfied at t+${fired.t}: stormInside ${fired.stormInside}, ` +
  `stormHolding ${fired.stormHolding}, stormOnWall ${fired.stormOnWall}, garrisonOnWall ${fired.garrisonOnWall}`);
const off = fired.rows.filter((r) => r.clamped);
console.log(`counted inside: ${fired.rows.length}; of those **${off.length} are off the end of the ` +
  `circuit** (the arithmetic index was clamped)`);
const byType = {};
for (const r of fired.rows) {
  const key = `${r.type} ${r.clamped ? '(off the end)' : `(behind bay ${r.k} ${r.stage})`}`;
  byType[key] = (byType[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log('\n  a sample, worst-clamped first');
console.log('     x      z   rawIdx  bay  depth   nearestBay  distToMid  depthFromNearest  type');
for (const r of [...fired.rows].sort((a, b) => Math.abs(b.raw - b.k) - Math.abs(a.raw - a.k)).slice(0, 12)) {
  console.log(`  ${String(r.x).padStart(5)} ${String(r.z).padStart(6)}  ${String(r.raw).padStart(6)}  ` +
    `${String(r.k).padStart(3)}  ${String(r.depth).padStart(5)}  ${String(r.nk).padStart(10)}  ` +
    `${String(r.nd).padStart(9)}  ${String(r.trueDepth).padStart(16)}  ${r.type}`);
}
await browser.close();
