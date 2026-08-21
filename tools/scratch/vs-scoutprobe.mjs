// scratch: run the studio's own scout against the Rome assault and watch the predicate.
import { chromium } from 'playwright';
import { PAGE_LIB } from '../lib/shot-page.mjs';

const PORT = process.argv[2] ?? '5209';
const Q = process.argv[3] ?? 'ultra';
const WIDE = process.argv[4] !== 'small';
const TOK = process.argv[5] !== 'notoken';
const W = WIDE ? 1920 : 960; const H = WIDE ? 1080 : 540;
const base = `http://127.0.0.1:${PORT}`;
const cfg = {
  map: 'campus-martius', scenario: 'assault', opponent: 1, unitSize: 'ultra',
  difficulty: 'hard', timeOfDay: 14.3, seed: 4265438264,
};
const token = Buffer.from(JSON.stringify(cfg)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`${base}/?harness=1&quality=${Q}&w=${W}&h=${H}&map=campus-martius&scenario=assault&enemy=juthungi${TOK ? `&battle=${token}` : ''}`,
  { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
await p.evaluate(() => window.__game.engine.stop());
await p.evaluate((h) => window.__game.engine.context.tryGet('sky').setTimeOfDay(h), 14.3);
await p.evaluate(PAGE_LIB);
console.log('args', Q, W + 'x' + H, TOK ? 'token' : 'no-token', 'men', await p.evaluate(() => window.__game.battle.pool.count), 'units', await p.evaluate(() => window.__game.battle.units.length));
for (const t of [20, 30, 40, 50, 60, 80, 100, 140, 180, 240]) {
  console.log(JSON.stringify(await p.evaluate((tt) => {
    window.__tc.runTo(tt);
    const g = window.__game;
    const gr = g.battle.siege.gateReport();
    const er = g.battle.siege.engineReport();
    const crews = g.battle.units.filter((u) => /ram/.test(g.battle.typeOf(u).id))
      .map((u) => `${g.battle.typeOf(u).id}:${u.alive}${u.destroyed ? '/dead' : ''}@${u.x.toFixed(0)},${u.z.toFixed(0)}`);
    const p2 = g.battle.pool;
    let fighting = 0, climbing = 0, dead = 0, routing = 0;
    for (let i = 0; i < p2.count; i++) {
      const st = p2.state[i];
      if (st === 4) fighting++; else if (st === 13) climbing++;
      else if (st === 10 || st === 11) dead++; else if (st === 12) routing++;
    }
    return { t: +g.simTime().toFixed(1), blows: gr.blows, ramBlows: er.ramBlows,
      crossed: er.laddersCrossed, fighting, climbing, dead, routing,
      ram: crews.join('') };
  }, t)));
}
await b.close();
