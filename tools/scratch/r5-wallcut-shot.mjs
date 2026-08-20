/**
 * Scratch: a free camera on the city wall, for release illustration.
 *
 * The RTS rig cannot frame a 6 m opening square-on — at the zoom that gives a 17 m standoff
 * its own eye-clearance floor lifts the camera to 8 m and looks 23 degrees down. So the rig's
 * `update` is stubbed and the camera is placed directly, which is safe only because the sim
 * is paused and `frame()` is driven by hand.
 *
 * Same script is run on both trees of a pair so the two arms are the same camera.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const PORT = Number(A.get('port') ?? 5931);
const OUT = A.get('out') ?? '/private/tmp/tc-r5-shots';
const MAP = A.get('map') ?? 'carthage';
const TAG = A.get('tag') ?? 'r5';
const SHOTS = JSON.parse(A.get('shots'));
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&map=${MAP}&quality=ultra&w=1280&h=720&scenario=assault`,
  { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

// HUD off, the same way `tools/shoot.mjs` does it: strip the DOM *and* hide the
// world-space overlay group, which a DOM strip does not touch.
await p.addStyleTag({ content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }' });
const overlayHidden = await p.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  const ov = hud && hud.overlay;
  if (!ov) return 'absent';
  ov.visible = false; return ov.visible === false ? 'hidden' : 'refused';
});
console.log('HUD off; world overlay', overlayHidden);

await p.evaluate(() => {
  const g = window.__game;
  g.engine.stop();
  g.engine.time.paused = true;
  g.engine.rig.update = () => {};
});

const report = [];
for (const s of SHOTS) {
  const got = await p.evaluate((s) => {
    const g = window.__game;
    const city = g.engine.context.get('city');
    const gate = city.getGates().find((q) => q.id === s.gate);
    if (!gate) return { fail: `no ${s.gate}`, have: city.getGates().map((q) => q.id) };
    const ox = Math.sin(gate.facing), oz = Math.cos(gate.facing);
    const gy = g.engine.rig.heightAt ? g.engine.rig.heightAt(gate.x, gate.z) : 0;
    const ex = gate.x + ox * s.standoff, ez = gate.z + oz * s.standoff;
    const ey = (g.engine.rig.heightAt ? g.engine.rig.heightAt(ex, ez) : 0) + s.eye;
    const cam = g.engine.rig.camera;
    cam.fov = s.fov ?? 38; cam.near = 0.35; cam.far = 8000; cam.updateProjectionMatrix();
    cam.position.set(ex, ey, ez);
    cam.up.set(0, 1, 0);
    cam.lookAt(gate.x, gy + s.aim, gate.z);
    cam.updateMatrixWorld();
    return { gate: gate.id, gx: +gate.x.toFixed(2), gz: +gate.z.toFixed(2), gy: +gy.toFixed(2),
      eye: [ex, ey, ez].map((v) => +v.toFixed(2)), outward: [+ox.toFixed(3), +oz.toFixed(3)] };
  }, s);
  if (got.fail) { console.log('SKIP', s.name, got.fail, (got.have ?? []).join(',')); continue; }
  // A handful of hand-driven frames: TAA history, LOD hysteresis, shadow cascades.
  for (let i = 0; i < 18; i++) {
    await p.evaluate((i) => window.__game.engine.frame(1000 + i * 16.7), i);
    await p.waitForTimeout(20);
  }
  await p.screenshot({ path: `${OUT}/${TAG}-${s.name}.png` });
  console.log(`${TAG}-${s.name}`, JSON.stringify(got));
  report.push({ ...s, ...got });
}
writeFileSync(`${OUT}/${TAG}-report.json`, JSON.stringify({ port: PORT, map: MAP, errs, report }, null, 1));
console.log('pageerrors/console errors:', errs.length);
errs.slice(0, 6).forEach((e) => console.log('  ', e));
await b.close();
