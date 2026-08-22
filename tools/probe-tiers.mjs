#!/usr/bin/env node
/**
 * Tier-switch regression test for the CSM cascade rebuild.
 *
 * `LightingSystem.rebuild()` once called `csm.dispose()` without `csm.remove()`. `dispose()`
 * only frees GPU resources; `remove()` is what detaches the cascade lights from the scene. So
 * every previous cascade set stayed parented to the world and the next `new CSM` added its
 * own on top — shadow-casting directional lights went 4 -> 7 on ultra -> medium, which
 * unrolled the shader's cascade loop `NUM_DIR_LIGHT_SHADOWS` = 7 times while `CSM_CASCADES`
 * had been rewritten to 3. Every lit material then failed to link with
 * "'[]' : array index out of range" and the entire world rendered empty — no terrain, no
 * city, no men, just the DOM HUD floating over grey.
 *
 * It is a nasty bug to catch by eye because it is switch-specific, not tier-specific:
 * ultra -> high never broke, both carrying 4 cascades, so it looked like a tier problem. The
 * transitions that matter are the ones that *change the cascade count*: 4 -> 3, 3 -> 2, and
 * back up again. This walks all of them and checks three things per step — that no shader
 * failed to link, that the light count matches the cascade count, and that the frame is not
 * flat grey.
 *
 *   node tools/probe-tiers.mjs --port=5651
 */

import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5651);
const W = Number(args.get('w') ?? 960);
const H = Number(args.get('h') ?? 540);
/** Every transition that changes cascade count, plus a round trip back to the boot tier. */
const ORDER = (args.get('order') ?? 'ultra,medium,ultra,low,ultra,high,low,medium,ultra').split(',');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}`;
let server = null;
const reused = await waitForServer(base, 1200);
if (!reused) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) throw new Error('vite did not start');
}
console.log(`source: ${base} — ${reused ? 'reused' : 'started my own'}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(300000);
/** Shader link failures surface here and nowhere else, so they must be collected. */
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  errors.push(`console: ${t.slice(0, 240)}`);
});
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&nohud=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

let fail = 0;
for (const tier of ORDER) {
  errors.length = 0;
  const info = await page.evaluate(async (t) => {
    window.__game.engine.setQuality(t);
    window.__game.engine.time.paused = true;
    for (let i = 0; i < 4; i++) window.__game.engine.advance(1e-6, 1e-3);
    const ctx = window.__game.engine.context;
    const lig = ctx.tryGet('lighting');
    // Count *every* shadow-casting directional light in the scene, not CSM's own list: the
    // bug's signature is orphaned lights CSM no longer knows about but the renderer still
    // uploads, which is exactly what pushes NUM_DIR_LIGHT_SHADOWS past CSM_CASCADES.
    let dirShadow = 0;
    ctx.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) dirShadow++; });
    // Read the canvas back and check the frame is a real image rather than flat grey.
    const cv = ctx.renderer.domElement;
    const g = document.createElement('canvas');
    g.width = 64; g.height = 36;
    const c2 = g.getContext('2d');
    c2.drawImage(cv, 0, 0, 64, 36);
    const px = c2.getImageData(0, 0, 64, 36).data;
    let mean = 0; const vals = [];
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      vals.push(l); mean += l;
    }
    mean /= vals.length;
    let sd = 0;
    for (const v of vals) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / vals.length);
    return {
      tier: ctx.quality.tier,
      cascades: ctx.quality.shadowCascades,
      csmLights: lig?.csm?.lights?.length ?? -1,
      dirShadow,
      mean: +mean.toFixed(1),
      sd: +sd.toFixed(1),
    };
  }, tier);

  // A world that failed to link renders as flat grey: near-zero spatial variance is the
  // signature, far more reliable than mean luminance which a grey clear colour also passes.
  const grey = info.sd < 4;
  const mismatch = info.dirShadow !== info.cascades || info.csmLights !== info.cascades;
  const linkErr = errors.filter((e) => /array index out of range|link|shader|WebGL/i.test(e));
  const bad = grey || mismatch || linkErr.length > 0;
  if (bad) fail++;
  console.log(
    `${bad ? 'FAIL' : 'ok  '} -> ${String(info.tier).padEnd(6)} cascades ${info.cascades}  csm.lights ${info.csmLights}  scene dir-shadow lights ${info.dirShadow}  frame mean ${info.mean} sd ${info.sd}`
    + (mismatch ? '   <-- LIGHT COUNT MISMATCH (the stale-cascade bug)' : '')
    + (grey ? '   <-- FLAT FRAME (shaders did not link)' : '')
  );
  for (const e of linkErr.slice(0, 3)) console.log(`      ${e}`);
}

console.log(fail === 0
  ? `\nPASS — ${ORDER.length} switches, cascade lights matched every time and no frame went flat.`
  : `\nFAIL — ${fail} of ${ORDER.length} switches broke.`);

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(fail === 0 ? 0 : 1);
