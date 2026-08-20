/** Who on Carthage's wall can even reach the ram, and what are they shooting instead? */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5493);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&map=carthage&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
await p.evaluate(() => window.__game.engine.advance(120, 166));
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__game, bt = g.battle;
  const r = bt.siege.ramReport().filter((x) => x.kind === 'gate')[0];
  const garr = bt.units.filter((u) => !u.destroyed && u.faction === 2 && u.alive > 0);
  return {
    ram: { x: +r.x.toFixed(0), z: +r.z.toFixed(0), crew: r.crewAlive },
    garrison: garr.map((u) => {
      const def = bt.typeOf(u);
      return { id: u.id, type: u.typeId, alive: u.alive, kills: u.kills,
        d: +Math.hypot(u.x - r.x, u.z - r.z).toFixed(0),
        range: def.missile ? def.missile.range : null, arc: def.missile ? def.missile.arc : null,
        target: u.targetUnitId, ammo: u.ammo };
    }).sort((a, c) => a.d - c.d),
    crewUnit: r.unitId,
  };
}), null, 1));
await b.close();
