/**
 * With the camera nailed down, does anything move during the trailer's opening beat?
 *
 * That beat is five seconds of the Roman line standing to, and the capture log reports
 * *nobody* fighting, marching or dying in it — which is correct, the armies have not been
 * ordered forward yet, and is also exactly what a frozen simulation would report. This
 * project has shipped a battle that stopped for sixteen minutes and photographed perfectly,
 * so "the world is still running" is measured rather than asserted.
 *
 * The camera is placed identically for every sample, so the only thing that can differ
 * between two frames is the world. A one-frame sample is included as the floor: TAA jitters
 * the projection every frame and the wind moves the grass, so a nonzero delta at 1/30 s is
 * expected and is the number the rest are read against. What matters is that the delta grows
 * monotonically with elapsed simulated time.
 *
 * Usage: node tools/scratch/trailer-idlecheck.mjs   (needs a dev server on 5219)
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
const base = 'http://127.0.0.1:5219';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto(`${base}/?harness=1&quality=ultra&w=960&h=540&map=campus-martius&scenario=field`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await p.addStyleTag({ content: '#hud-root,#loading{display:none!important}' });
await p.evaluate(() => { const g = window.__game; g.engine.stop();
  const hud = g.engine.context.tryGet('hud'); if (hud?.overlay) hud.overlay.visible = false; });
const shots = [];
for (const t of [4.0, 4.0334, 4.1, 4.5, 9.0]) {
  await p.evaluate((tt) => { const g = window.__game;
    while (g.simTime() < tt - 1e-6) g.engine.advance(1/30, 1000/30);
    // Nailed camera: the same focus, zoom and yaw every time.
    g.setCamera(-107, 118, 0.14, 1.24);
    g.engine.advance(1/30, 1000/30);
  }, t);
  shots.push({ t, buf: await p.screenshot({ type: 'png' }) });
}
await b.close();
const raws = [];
for (const s of shots) raws.push(await sharp(s.buf).greyscale().raw().toBuffer());
for (let i = 1; i < raws.length; i++) {
  let diff = 0, n = raws[0].length, changed = 0;
  for (let k = 0; k < n; k++) { const d = Math.abs(raws[i][k] - raws[0][k]); diff += d; if (d > 8) changed++; }
  console.log(`t+${shots[i].t} vs t+${shots[0].t}: mean|delta| ${(diff/n).toFixed(3)}  pixels>8 ${(100*changed/n).toFixed(2)}%`);
}
