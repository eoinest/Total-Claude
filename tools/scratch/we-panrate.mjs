import { chromium } from 'playwright';
const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'assault' }))
  .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(`http://127.0.0.1:5347/?harness=1&quality=high&autoplay=0&hud=0&scenario=assault&w=1280&h=720&battle=${token}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
for (const secs of [1, 2, 3]) {
  const s0 = await p.evaluate(() => { const r = window.__game.engine.rig;
    r.jumpTo(0, 400, 0, 0); window.__fc = 0;
    const t = window.__game.engine.time; window.__t0 = t.simTime;
    return { x: r.focus.x, z: r.focus.z }; });
  await p.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, secs * 1000));
  await p.keyboard.up('KeyW');
  const s1 = await p.evaluate(() => { const r = window.__game.engine.rig;
    return { x: r.focus.x, z: r.focus.z, sim: window.__game.engine.time.simTime - window.__t0,
             fps: window.__game.engine.lastFrameMs }; });
  const d = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  console.log(`hold ${secs}s -> ${d.toFixed(2)} m  (${(d/secs).toFixed(2)} m/s), sim advanced ${s1.sim.toFixed(2)} s, lastFrameMs ${s1.fps.toFixed(1)}`);
}
await b.close();
