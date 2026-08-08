/**
 * Does the model deck now compile the game's shadow shader?
 *
 * The recorded finding was: "`tcShadowGeom` appears in none of `viewer.html`'s 24 fragment
 * programs", so the deck graded soldiers under three's stock PCF with one non-cascaded sun
 * while the battle graded them under `tcSoftShadow` across four cascades. That is a
 * *measurement over the compiled programs*, not an assertion about which module is imported,
 * and it is the only form of it worth trusting: a `LightingSystem` that is constructed but
 * whose `installShaderChunks` silently no-ops would pass any import check.
 *
 * Read off `gl.getShaderSource` for every program three has cached, per preset, in one page
 * session — because the interesting number is the *difference* between the arms.
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 5866);
console.log(`[eleview-shaders] port ${PORT}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
await page.goto(`http://127.0.0.1:${PORT}/viewer.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__viewer, null, { timeout: 90000 });

await page.evaluate(() => {
  // A handle on the renderer, purely for this probe. Everything else goes through `__viewer`.
  const c = document.getElementById('viewer-canvas');
  window.__gl = c.getContext('webgl2');
});

const settle = (n = 40) => page.evaluate((k) => new Promise((r) => {
  let i = 0;
  const s = () => (++i >= k ? r() : requestAnimationFrame(s));
  requestAnimationFrame(s);
}), n);

const scan = () => page.evaluate(() => {
  const gl = window.__gl;
  // three keeps its cached programs on the renderer; reach them through the canvas's own
  // WebGL context instead, which is provider-agnostic: every shader the page ever linked is
  // still attached to a live program object.
  const r = window.__viewerRenderer;
  const progs = r.info.programs ?? [];
  let frags = 0;
  let withGeom = 0;
  let withSoft = 0;
  let withCsm = 0;
  for (const p of progs) {
    for (const sh of gl.getAttachedShaders(p.program) ?? []) {
      const src = gl.getShaderSource(sh) ?? '';
      if (!src.includes('gl_FragColor') && !src.includes('pc_fragColor') && !src.includes('out highp vec4')) continue;
      frags++;
      if (src.includes('tcShadowGeom')) withGeom++;
      if (src.includes('tcSoftShadow')) withSoft++;
      if (src.includes('CSM_CASCADES')) withCsm++;
    }
  }
  return { programs: progs.length, frags, withGeom, withSoft, withCsm };
});

const rows = [];
for (const preset of ['studio', 'field', 'battle']) {
  await page.evaluate((p) => {
    const v = window.__viewer;
    v.setUnit('war-elephants');
    v.setMode('single');
    v.setLight(p);
    v.frame();
  }, preset);
  await settle(60);
  const s = await scan();
  rows.push({ preset, ...s });
  console.log(
    `${preset.padEnd(7)} programs ${String(s.programs).padStart(3)}  fragment ${String(s.frags).padStart(3)}` +
    `  tcShadowGeom ${String(s.withGeom).padStart(3)}  tcSoftShadow ${String(s.withSoft).padStart(3)}` +
    `  CSM_CASCADES ${String(s.withCsm).padStart(3)}`
  );
}

const shadow = await page.evaluate(() => {
  const r = window.__viewerRenderer;
  return { type: r.shadowMap.type, enabled: r.shadowMap.enabled };
});
// 0 Basic, 1 PCF, 2 PCFSoft, 3 VSM.
console.log(`shadowMap.type = ${shadow.type} (1 = PCFShadowMap, the mode Engine sets; 2 = PCFSoft, the third mode the viewer used to set)`);
console.log(`pageerrors/console errors: ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
await browser.close();
