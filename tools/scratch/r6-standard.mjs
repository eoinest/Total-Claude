// Scratch: park the camera on one unit's standard and photograph the cloth big.
//
// Successor to tools/scratch/bannerclose-r2.mjs, which aimed at a point 1.05 m behind the
// unit centre at a fixed 2.35 m and put the flag in the top-left corner. The standard's own
// anchor is published — `VFXSystem.standardOf(unitId, out)` returns the top of the staff —
// so the focus is read from the thing being photographed rather than reconstructed from the
// unit it belongs to. Falls back to the same arithmetic on a tree that has no `standardOf`,
// so the before arm of a pair can be shot with this file too.
//
//   node r6-standard.mjs --port=5396 --out=DIR --tag=after --hour=7.6 --sweep
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.TC_ROOT ?? process.cwd();
const arg = (k, d) => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`));
  return a === undefined ? d : a.slice(k.length + 3);
};
const has = (k) => process.argv.includes(`--${k}`);
const PORT = Number(arg('port', 5396));
const OUT = path.resolve(arg('out', '/tmp/r6shots/standard'));
const TAG = arg('tag', 'after');
const W = 1600, H = 1000;

const wait = async (u, ms) => {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
const base = `http://127.0.0.1:${PORT}`;
let srv = null;
if (!(await wait(base, 1000))) {
  srv = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await wait(base, 120000))) throw new Error('no vite');
}
console.log(`server ${base} root ${ROOT}`);
await mkdir(OUT, { recursive: true });

// hour, yawAdd, zoom
const CASES = has('sweep')
  ? [[8.8, 0.35, 0], [16.0, 0.35, 0], [7.6, 0.45, 0]]
  : [[Number(arg('hour', 7.6)), Number(arg('yawadd', 0.55)), Number(arg('zoom', 0.075))]];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const report = [];
for (const [hour, yawAdd, zoom] of CASES) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  const token = Buffer.from(JSON.stringify({ timeOfDay: hour })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&battle=${token}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
  await page.addStyleTag({ content: '#hud-root,#loading,#menu-root{display:none!important}' });
  await page.evaluate(() => {
    const h = window.__game?.engine?.context?.tryGet?.('hud');
    if (h?.overlay) h.overlay.visible = false;
  });
  const info = await page.evaluate(async ([yawAdd, zoom, hour]) => {
    const g = window.__game;
    const sky = g.engine.context.tryGet('sky');
    if (sky?.setTimeOfDay) sky.setTimeOfDay(hour);
    while (g.simTime() < 26) g.advance(0.5);
    const b = g.battle;
    let best = null;
    for (const u of b.units) {
      if (u.destroyed || u.alive === 0 || u.faction !== 0) continue;
      if (b.typeOf(u).unitClass !== 'heavy-infantry') continue;
      if (!best || u.alive > best.alive) best = u;
    }
    if (!best) return { error: 'no unit' };
    const vfx = g.engine.context.tryGet('vfx');
    const V = g.engine.rig.camera.position.constructor;
    const out = new V();
    let topY = null, ax = null, az = null;
    if (vfx?.standardOf && vfx.standardOf(best.id, out)) {
      ax = out.x; az = out.z; topY = out.y;
    } else {
      ax = best.x - Math.sin(best.facing) * 1.05;
      az = best.z - Math.cos(best.facing) * 1.05;
      topY = b.groundAt(ax, az) + 2.38;
    }
    const rig = g.engine.rig;
    const saved = rig.heightAt;
    /*
     * An explicit camera in metres, not a zoom scalar — the same override `tools/shoot.mjs`
     * uses for its `cam` shots and for the same reason. At `zoom: 0.055` the rig's own curves
     * put the eye at a standing man's height three metres away, and the standard is in rank
     * two: the first attempt photographed the back of a front-rank helmet at 1 m with the
     * flag behind it. What is needed is a long lens from a little above the cloth, which no
     * single zoom number can ask for.
     *
     * `aim` is the centre of the sheet, two-thirds of a metre under the crossbar. `eye` is
     * metres above that, `dist` metres back along the yaw, `fov` the focal length. The `- L`
     * cancels `place()`'s own lift so `aim` means what it says; zoom is pinned to 0 so that
     * lift is the known 1.55 m.
     */
    const L = 1.55;
    const eye = 1.05, dist = 8.0, fov = 17;
    const rise = eye + L;
    const R = Math.hypot(rise, dist);
    const P = Math.atan2(rise, dist);
    rig.zoom = 0; rig.zoomTarget = 0;
    const savedPitch = rig.pitchForZoom, savedFov = rig.fovForZoom;
    const savedRadius = Object.getOwnPropertyDescriptor(rig, 'radius') ?? null;
    rig.pitchForZoom = () => P;
    rig.fovForZoom = () => fov;
    Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
    rig.heightAt = () => (topY - 0.66) - L;
    // `place()` puts the eye at focus - (sin yaw, ., cos yaw) * r, so yaw = facing + PI
    // stands the camera off the face the cloth presents. `yawAdd` swings it three-quarter
    // and off the sun. `zoom` from the sweep is reused as a standoff multiplier.
    g.setCamera(ax, az, 0, best.facing + Math.PI + yawAdd);
    g.advance(0.5);
    /*
     * Re-aim on the anchor the settle produced, not the one that was read before it.
     *
     * `BannerSystem.anchor` follows the unit, the unit is marching, and half a second of it
     * is about a metre and a half of world — which at this focal length is a third of the
     * frame. The first version of this file put the standard in the left third for exactly
     * that reason and it looked like a yaw error.
     */
    if (vfx?.standardOf && vfx.standardOf(best.id, out)) {
      ax = out.x; az = out.z; topY = out.y;
      rig.heightAt = () => (topY - 0.66) - L;
      g.setCamera(ax, az, 0, best.facing + Math.PI + yawAdd);
    }
    g.advance(0.06);
    /*
     * The overrides are deliberately NOT put back before the shutter.
     *
     * `bannerclose-r2.mjs` restored them here and its frames came back at a front-rank man's
     * head height with the flag out of shot. The page keeps rendering after this call
     * returns, `RTSCamera.place` re-reads `heightAt` every frame, and a restored sampler
     * drops the eye back onto the terrain before the screenshot is taken. The page is closed
     * immediately afterwards, so nothing else can inherit them.
     */
    void saved; void savedPitch; void savedFov; void savedRadius; void zoom;
    return { unit: best.id, name: b.typeOf(best).name ?? '', ax: +ax.toFixed(1), az: +az.toFixed(1), topY: +topY.toFixed(2), sun: sky?.timeOfDay ?? null };
  }, [yawAdd, zoom, hour]);
  const file = path.join(OUT, `${TAG}-h${String(hour).replace('.', '')}-y${String(yawAdd).replace('.', '')}-z${String(zoom).replace('.', '')}.png`);
  await page.screenshot({ path: file, type: 'png' });
  console.log(`${path.basename(file)} ${JSON.stringify(info)} errors ${errs.length}`);
  report.push({ hour, yawAdd, zoom, file, info, errors: errs.slice(0, 3) });
  await page.close();
}
await writeFile(path.join(OUT, `${TAG}.json`), JSON.stringify(report, null, 2));
await browser.close();
if (srv) srv.kill('SIGTERM');
