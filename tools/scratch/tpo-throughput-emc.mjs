/** Where the Carthage assault's casualties went: machine throughput under the harness URL. */
import { chromium } from 'playwright';
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=5613').slice(7));
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => console.log('!! PAGEERROR', String(e).slice(0, 200)));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&w=960&h=540&map=carthage&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await p.waitForTimeout(800);
for (const t of [30, 60, 60, 50]) {
  await p.evaluate((s) => window.__game.engine.advance(s, 166), t);
  const r = await p.evaluate(() => {
    const g = window.__game, s = g.battle.siege;
    const owners = new Map();
    for (const l of (s.ladders ?? [])) {
      const e = owners.get(l.unitId) ?? { crossed: 0, boarders: 0, rails: 0 };
      e.crossed += l.crossed; e.boarders = l.boarders.length; e.rails++;
      owners.set(l.unitId, e);
    }
    return {
      t: +g.simTime().toFixed(0),
      strength: { ...g.battle.strength },
      ladders: [...owners].map(([id, e]) => `u${id}:${e.crossed}x/${e.boarders}b`),
      towers: s.towerReport().map((x) => `${x.state}:${x.crossed}`),
      owned: s.ownsUnit ? g.battle.units.filter((u) => s.ownsUnit(u.id)).map((u) => u.id) : null,
      onWall: g.battle.units.filter((u) => u.faction === 0 && s.isGarrisoned(u.id))
        .map((u) => `u${u.id}:${s.unitWallState(u.id).onWall}`),
    };
  });
  console.log(JSON.stringify(r));
}
await b.close();
