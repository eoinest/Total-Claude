#!/usr/bin/env node
/**
 * Are the soldier atlas's normal and ORM maps doing visible work on the isolated-model deck?
 *
 * Three blind critics independently reported "no normal map, no roughness map" on this model.
 * The maps demonstrably exist — `src/units/atlas.ts` bakes a normal and a packed AO/rough/metal
 * from a per-material height field, and both `UnitRenderSystem.ts:640-696` and
 * `viewer/soldierRig.ts:230-243` bind them — so either the critics are reading flatness as
 * absence, or something between the atlas and the screen is killing them. This settles it by
 * measurement rather than by argument.
 *
 * The technique is the one `tools/probe-masonry.mjs` proved: **remove one channel at a time
 * from the live material and difference frames of an identical paused world.** Every arm is
 * shot inside ONE page session (cross-session A/B is not a measurement on this project) and
 * the base arm is re-shot LAST, because that trailing shot is the only thing distinguishing
 * "my change did nothing" from "my arms did not restore".
 *
 * Arms:
 *   base       as shipped
 *   no-normal  normalMap = null
 *   no-rough   roughnessMap = null   (see the WARNING below — this arm is not clean)
 *   no-metal   metalnessMap = null
 *   no-ao      aoMap = null
 *   flat-all   all four null
 *   cav0       EXTRA arm, not requested: uKitCavity pinned to 0 with every map left in place.
 *   base2      everything restored — the drift check
 *
 * WARNING, and it is the reason `cav0` is here. `skinShader.ts` gates the whole kit-cavity
 * lighting term on `#ifdef USE_ROUGHNESSMAP` (KIT_CAVITY_PARS, KIT_CAVITY_SETUP,
 * KIT_CAVITY_AO all sit inside it, because `texelRoughness` is what the cavity is read from).
 * So dropping `roughnessMap` also silently deletes the direct-light cavity gate and the
 * indirect AO gate. `no-rough` is therefore "roughness texture AND cavity gate", and `cav0`
 * is the term that lets the two be told apart. `flat-all` inherits the same confound.
 *
 * Reported per arm against `base`, on FIGURE PIXELS ONLY — backdrop flood-filled from the four
 * corners with a local-step tolerance and the figure eroded 4 px, the same rule
 * `tools/probe-octave.mjs` uses, with the mask computed once on `base` and held fixed across
 * the arms so a brightness change cannot move the mask underneath the statistic:
 *
 *   meanAbs   mean absolute luma difference, in /255
 *   pct>1     percentage of figure pixels differing by more than 1/255
 *   E1, E2    DoG band energies at sigma 1 and 2 px, RMS x1000 (probe-octave's band code)
 *   R         E1 / E2
 *
 * Both a native-resolution (1800x2400, what the GPU actually wrote) and a working-resolution
 * (900x1200 lanczos, probe-octave's plane) figure statistic are printed, because a downsample
 * halves an uncorrelated 1/255 difference and would understate a real change.
 *
 * It also reports, separately:
 *   - the atlas texel density on screen for the praetorian torso, and therefore which mip the
 *     sampler is on — this decides whether a 128 px material tile can resolve at all at plate
 *     magnification;
 *   - whether the soldier geometry carries vertex tangents, read off the live geometry;
 *   - `normalScale` as it actually reaches the GPU, read back with `gl.getUniform`;
 *   - the `#define USE_*` block of the linked fragment program, read back with
 *     `gl.getShaderSource` — the definitive statement of which maps the compiler kept.
 *
 * Usage:  TC_NO_HMR=1 node tools/probe-kitmaps.mjs --port=5233
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5233);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/r3-arms');
/** CSS size and dpr of the shipped isolated-model deck (`tools/shoot-model.mjs`). */
const W = Number(args.get('w') ?? 900);
const H = Number(args.get('h') ?? 1200);
const DPR = Number(args.get('dpr') ?? 2);
/** probe-octave's working plane. Its "1 px band" is defined here, not at device resolution. */
const SW = W;
const SH = H;
const N = SW * SH;
const TOL = 0.006;
const ERODE = 4;
const SIGMAS = [1, 2];

const PLATES = [
  { name: 'legio-front', unit: 'legio-cohort', hash: 0.37, clip: 'idleAlertReady', phase: 0.32, az: -0.85, el: 0.05, fill: 0.88 },
  { name: 'praet-torso', unit: 'praetorian-cohort', hash: 0.29, clip: 'attackOverhead', phase: 0.18, az: -0.5, el: 0.02, fill: 1.9, aimY: 1.25 },
  { name: 'legio-shield', unit: 'legio-cohort', hash: 0.37, clip: 'idleBrace', phase: 0.5, az: 0.95, el: 0.03, fill: 0.86 },
];
const ARMS = ['base', 'no-normal', 'no-rough', 'no-metal', 'no-ao', 'flat-all', 'cav0', 'base2'];

// ---------------------------------------------------------------------------
// Image maths — lifted from tools/probe-octave.mjs so the numbers are directly
// comparable with the deck's own octave table.
// ---------------------------------------------------------------------------

function luma(data, channels, n) {
  const L = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    L[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }
  return L;
}

/** Separable Gaussian, edge-clamped. Radius 3.5 sigma. */
function gaussian(img, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3.5));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp((-i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const t = new Float64Array(N);
  const o = new Float64Array(N);
  for (let y = 0; y < SH; y++) {
    const row = y * SW;
    for (let x = 0; x < SW; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= SW ? SW - 1 : x + i; a += img[row + xx] * k[i + r]; }
      t[row + x] = a;
    }
  }
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= SH ? SH - 1 : y + i; a += t[yy * SW + x] * k[i + r]; }
      o[y * SW + x] = a;
    }
  }
  return o;
}

/** Chebyshev erosion by r, as two 1-D minimum passes. Off-frame counts as background. */
function erodeMask(m, r) {
  if (r <= 0) return m;
  const t = new Uint8Array(N);
  const o = new Uint8Array(N);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) { const xx = x + d; if (xx < 0 || xx >= SW || !m[y * SW + xx]) { v = 0; break; } }
      t[y * SW + x] = v;
    }
  }
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) { const yy = y + d; if (yy < 0 || yy >= SH || !t[yy * SW + x]) { v = 0; break; } }
      o[y * SW + x] = v;
    }
  }
  return o;
}

/** Backdrop flood from seeds; a neighbour is accepted on a local luma step, not a seed distance. */
function flood(L, seeds, tol) {
  const seen = new Uint8Array(N);
  const st = new Int32Array(N);
  let sp = 0;
  for (const s of seeds) if (!seen[s]) { seen[s] = 1; st[sp++] = s; }
  while (sp > 0) {
    const i = st[--sp];
    const x = i % SW;
    const y = (i / SW) | 0;
    const v = L[i];
    const step = (j) => {
      if (seen[j]) return;
      if (Math.abs(L[j] - v) > tol) return;
      seen[j] = 1; st[sp++] = j;
    };
    if (x + 1 < SW) step(i + 1);
    if (x > 0) step(i - 1);
    if (y + 1 < SH) step(i + SW);
    if (y > 0) step(i - SW);
  }
  return seen;
}

function figureMask(L) {
  const bg = flood(L, [0, SW - 1, (SH - 1) * SW, N - 1], TOL);
  const fig = new Uint8Array(N);
  for (let i = 0; i < N; i++) fig[i] = bg[i] ? 0 : 1;
  return erodeMask(fig, ERODE);
}

/** DoG band energies over the mask, RMS x1000. Bands computed on the whole plane first. */
function bandEnergies(L, mask) {
  const levels = [L];
  for (const s of SIGMAS) levels.push(gaussian(L, s));
  const out = [];
  for (let k = 0; k < SIGMAS.length; k++) {
    const a = levels[k];
    const b = levels[k + 1];
    let acc = 0;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const d = a[i] - b[i];
      acc += d * d; n++;
    }
    out.push(n ? Math.sqrt(acc / n) * 1000 : 0);
  }
  return out;
}

async function loadWorking(file) {
  const { data, info } = await sharp(file).removeAlpha()
    .resize(SW, SH, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  return luma(data, info.channels, N);
}
async function loadNative(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

/** Nearest-neighbour upscale of the working mask to the native grid. */
function upMask(mask, nw, nh) {
  const o = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(SH - 1, Math.floor((y * SH) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(SW - 1, Math.floor((x * SW) / nw));
      o[y * nw + x] = mask[sy * SW + sx];
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error(`No dev server on ${PORT}. A probe that silently falls back to a stale dist/`);
  console.error('has reported 5/12 on a tree that scored 12/12 — start a server and pass --port.');
  process.exit(2);
}
{
  const r = await fetch(`${BASE}/src/units/atlas.ts`).then((x) => x.ok).catch(() => false);
  console.log(`probe-kitmaps — ${BASE}  (src/units/atlas.ts served: ${r ? 'yes, a dev server' : 'NO — stale dist?'})`);
  if (!r) process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.setDefaultTimeout(300000);

await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 240000 });
await page.evaluate(() => {
  for (const s of ['#viewer-panel', '#viewer-readout', '#viewer-boot']) document.querySelector(s)?.remove();
  for (const t of document.querySelectorAll('.vw-tag')) t.remove();
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.position = 'absolute'; c.style.inset = '0'; c.style.width = '100%'; c.style.height = '100%'; }
  window.dispatchEvent(new Event('resize'));
});

/*
 * Stop the clock, and this is not a nicety — the first run of this probe measured a base-vs-base2
 * drift floor of 17.1/255 over 63 % of figure pixels, LARGER than every arm it was meant to
 * validate.
 *
 * A "paused" plate is not still. `viewer/main.ts:1183` derives dt from the rAF timestamp and
 * feeds it to `soldierRig.ts:893-895`, which advances `uTime`; `anim/skinShader.ts:388` then adds
 *
 *     lean += sin( uTime * 0.55 + hash * 43.0 ) * 0.014 * bendT * bendT
 *
 * to every living man — a +-0.014 rad bend of the whole figure about his feet, which at
 * legio-front's 1112 px/m swings the head about +-27 device pixels. `skinShader.ts:345` waves the
 * cloak hem on the same clock. Two screenshots of the "same" plate are two different poses, and
 * differencing them measures the sway, not the material. (This is almost certainly the mechanism
 * behind the 50-70 % cross-run pixel difference `probe-kitcavity.mjs` records in its docstring.)
 *
 * Two independent locks, because one silently failing would put the floor back:
 *   1. rAF is handed a constant timestamp, so the viewer's dt is 0 for every frame from here on
 *      and nothing time-driven advances at all.
 *   2. the shared `uTime` uniform object is captured through the material's own
 *      `onBeforeCompile` and its `value` replaced by a constant getter, so even a write that
 *      got past (1) cannot move it.
 * Neither touches the material's maps, and every arm sees the identical pose.
 */
const froze = await page.evaluate(() => {
  const raf = window.requestAnimationFrame.bind(window);
  // 0, not `performance.now()`: `main.ts` clamps dt at zero from below, so a non-increasing
  // timestamp yields dt = 0 on the very first frame after the swap as well as every one after.
  window.requestAnimationFrame = (cb) => raf(() => cb(0));
  return true;
});
console.log(`• rAF timestamp pinned to 0 (viewer dt = 0 from here on): ${froze}`);

/*
 * Reaching the scene.
 *
 * `window.__viewer` exposes no scene handle and this probe is not allowed to add one, so the
 * render is intercepted instead: `three` is imported by the *same URL* Vite gave the app —
 * pulled out of the transformed `stage.ts` rather than guessed — which yields the identical
 * module record.
 *
 * NOT via `WebGLRenderer.prototype.render`: in r185 that is assigned as an *own* property in
 * the constructor (`this.render = function ...`), so the prototype has no `render` at all and
 * patching it is a silent no-op. `Object3D.prototype.onBeforeRender` genuinely is a prototype
 * method, and `WebGLRenderer.render` calls `scene.onBeforeRender( renderer, scene, camera, rt )`
 * on every scene it is handed. Every scene is recorded, not the last one: the grade pass
 * renders its own fullscreen quad scene after the world, so "the last scene" is the wrong one.
 */
const hook = await page.evaluate(async () => {
  const src = await (await fetch('/src/viewer/stage.ts')).text();
  const m = src.match(/from\s*["']([^"']*three\.js[^"']*)["']/);
  if (!m) return { ok: false, why: 'no three specifier in the transformed stage.ts' };
  const THREE = await import(/* @vite-ignore */ m[1]);
  if (!THREE.Object3D || typeof THREE.Object3D.prototype.onBeforeRender !== 'function') {
    return { ok: false, why: 'Object3D.prototype.onBeforeRender is not a prototype function' };
  }
  window.__caps = [];
  const orig = THREE.Object3D.prototype.onBeforeRender;
  THREE.Object3D.prototype.onBeforeRender = function (renderer, scene, camera) {
    // Cheap: this now runs for every object that has no own hook, so bail immediately
    // unless it is the once-per-render scene call.
    if (this.isScene === true) {
      let c = window.__caps.find((x) => x.scene === this);
      if (!c) { c = { scene: this }; window.__caps.push(c); }
      c.camera = camera;
      c.renderer = renderer;
    }
    return orig.apply(this, arguments);
  };
  window.__THREE = THREE;
  return { ok: true, revision: THREE.REVISION, spec: m[1] };
});
if (!hook.ok) { console.error(`REFUSED: ${hook.why}`); await browser.close(); process.exit(2); }
console.log(`• three r${hook.revision} hooked via ${hook.spec}`);

/** Two frames: one to apply the state, one to draw it. Repeat n times. */
const settle = async (n) => {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
};
await settle(4);

// The arm machinery, installed once. It restores from a snapshot before every arm, so an arm
// can never inherit the previous one, and it hands back the post-hoc state of every field so
// "the arm ran" is an assertion rather than a hope.
const install = await page.evaluate(() => {
  const pick = () => (window.__caps || []).find((c) => {
    let f = false;
    c.scene.traverse((o) => { if (o.name === 'viewer-soldiers') f = true; });
    return f;
  });
  const isSoldierMat = (m) => !!m && m.isMeshStandardMaterial === true && (
    (m.map && m.map.name === 'soldier-albedo')
    || (m.normalMap && m.normalMap.name === 'soldier-normal')
    || (m.roughnessMap && m.roughnessMap.name === 'soldier-orm')
    || (m.aoMap && m.aoMap.name === 'soldier-orm')
  );
  const collect = () => {
    const cap = pick();
    if (!cap) return null;
    const seen = new Map();
    cap.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (isSoldierMat(m)) seen.set(m.uuid, m);
      }
    });
    return [...seen.values()];
  };
  window.__pickCap = pick;
  window.__collect = collect;

  const mats = collect();
  if (!mats || mats.length === 0) return { ok: false, why: 'no soldier MeshStandardMaterial found in the scene' };
  window.__snap = mats.map((m) => ({
    m, uuid: m.uuid,
    normalMap: m.normalMap, roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap, aoMap: m.aoMap,
  }));
  window.__cav0 = (() => {
    for (const s of window.__snap) {
      const u = s.m.userData && s.m.userData.kitCavity;
      if (u) return u.value;
    }
    return null;
  })();

  /*
   * Second lock on the idle sway. `skinShader.patch` does `Object.assign(shader.uniforms,
   * uniforms)` in `onBeforeCompile`, so `shader.uniforms.uTime` IS the object the rig writes
   * to every frame. Wrapping the material's own `onBeforeCompile` hands that object over on
   * the next compile without touching a single source file, and a constant getter on `.value`
   * makes the rig's per-frame write a no-op. It survives the recompiles the arms force,
   * because each recompile re-assigns the same pinned object.
   */
  for (const s of window.__snap) {
    const m = s.m;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = function (shader, renderer) {
      const r = prev ? prev.call(this, shader, renderer) : undefined;
      window.__shaderUniforms = shader.uniforms;
      return r;
    };
    m.needsUpdate = true;
  }
  /*
   * ...except that the wrapper above only fires when three builds a *new* program, and the
   * base program is already in `materialProperties.programs` by the time this runs, so
   * `needsUpdate` alone will not call it. The live uniform block is reachable directly:
   * `renderer.properties.get(material).uniforms` is the object three passed to
   * `onBeforeCompile` as `shader.uniforms`, and `Object.assign` put the rig's own `uTime`
   * object into it. Every later recompile re-assigns that same object, so a pin here holds
   * across all eight arms.
   */
  window.__uniforms = () => {
    if (window.__shaderUniforms) return window.__shaderUniforms;
    const cap = window.__pickCap();
    for (const s of window.__snap) {
      try {
        const u = cap.renderer.properties.get(s.m).uniforms;
        if (u && u.uTime) return u;
      } catch { /* not reachable on this build */ }
    }
    return null;
  };
  window.__uTime = () => {
    const u = window.__uniforms();
    return u && u.uTime ? u.uTime.value : null;
  };
  window.__pinTime = () => {
    const u = window.__uniforms();
    if (!u || !u.uTime) return null;
    const v = u.uTime.value;
    Object.defineProperty(u.uTime, 'value', { get: () => v, set: () => {}, configurable: true });
    return v;
  };

  window.__arm = (name) => {
    // Re-collect: if `plate()` ever rebuilt a material set, the snapshot would be stale and
    // every arm after that point would be a silent no-op on the material actually drawn.
    const now = window.__collect() || [];
    const known = new Set(window.__snap.map((s) => s.uuid));
    const strays = now.filter((m) => !known.has(m.uuid)).map((m) => m.uuid);
    const missing = window.__snap.filter((s) => !now.some((m) => m.uuid === s.uuid)).map((s) => s.uuid);

    let touched = 0;
    for (const s of window.__snap) {
      const m = s.m;
      m.normalMap = s.normalMap;
      m.roughnessMap = s.roughnessMap;
      m.metalnessMap = s.metalnessMap;
      m.aoMap = s.aoMap;
      if (name === 'no-normal' || name === 'flat-all') m.normalMap = null;
      if (name === 'no-rough' || name === 'flat-all') m.roughnessMap = null;
      if (name === 'no-metal' || name === 'flat-all') m.metalnessMap = null;
      if (name === 'no-ao' || name === 'flat-all') m.aoMap = null;
      m.needsUpdate = true;
      touched++;
    }
    // The cavity uniform is shared between the shader and material.userData, so writing it
    // reaches the GPU next frame with no recompile.
    let cavSet = null;
    if (window.__cav0 !== null) {
      const want = name === 'cav0' ? 0 : window.__cav0;
      for (const s of window.__snap) {
        const u = s.m.userData && s.m.userData.kitCavity;
        if (u) { u.value = want; cavSet = want; }
      }
    }
    const state = window.__snap.map((s) => ({
      name: s.m.name || '(unnamed)',
      normalMap: !!s.m.normalMap, roughnessMap: !!s.m.roughnessMap,
      metalnessMap: !!s.m.metalnessMap, aoMap: !!s.m.aoMap,
    }));
    return { touched, strays, missing, cav: cavSet, state };
  };

  return {
    ok: true,
    count: mats.length,
    cavity: window.__cav0,
    mats: mats.map((m) => ({
      name: m.name || '(unnamed)', type: m.type,
      map: m.map ? `${m.map.name} ${m.map.image?.width}x${m.map.image?.height}` : null,
      normalMap: m.normalMap ? `${m.normalMap.name} ${m.normalMap.image?.width}x${m.normalMap.image?.height}` : null,
      roughnessMap: m.roughnessMap ? m.roughnessMap.name : null,
      metalnessMap: m.metalnessMap ? m.metalnessMap.name : null,
      aoMap: m.aoMap ? m.aoMap.name : null,
      normalScale: m.normalScale ? [m.normalScale.x, m.normalScale.y] : null,
      normalMapType: m.normalMapType,
      roughness: m.roughness, metalness: m.metalness,
      aoMapIntensity: m.aoMapIntensity, envMapIntensity: m.envMapIntensity,
      side: m.side, flatShading: m.flatShading,
      normalMapChannel: m.normalMap ? m.normalMap.channel : null,
      aoMapChannel: m.aoMap ? m.aoMap.channel : null,
      anisotropy: m.normalMap ? m.normalMap.anisotropy : null,
      minFilter: m.normalMap ? m.normalMap.minFilter : null,
      generateMipmaps: m.normalMap ? m.normalMap.generateMipmaps : null,
    })),
  };
});
if (!install.ok) { console.error(`REFUSED: ${install.why}`); await browser.close(); process.exit(2); }

console.log(`• soldier MeshStandardMaterials found: ${install.count}   uKitCavity as shipped: ${install.cavity}`);
for (const m of install.mats) {
  console.log(`    ${m.name.padEnd(18)} map=${m.map}  normalMap=${m.normalMap}  rough=${m.roughnessMap} metal=${m.metalnessMap} ao=${m.aoMap}`);
  console.log(`    ${''.padEnd(18)} normalScale=[${m.normalScale}] type=${m.normalMapType} rough=${m.roughness} metal=${m.metalness} aoI=${m.aoMapIntensity} envI=${m.envMapIntensity} aniso=${m.anisotropy} mips=${m.generateMipmaps}`);
}

// The uniform block only exists after a compile, so settle first, then pin, then prove the pin
// by letting several more frames run and reading `uTime` back.
await settle(4);
const tBefore = await page.evaluate(() => window.__uTime());
const tPinned = await page.evaluate(() => window.__pinTime());
await settle(6);
const tAfter = await page.evaluate(() => window.__uTime());
console.log(`• uTime captured ${tBefore}, pinned at ${tPinned}, still ${tAfter} after 6 more frames — ${tPinned !== null && tAfter === tPinned ? 'HELD' : 'NOT HELD'}`);
if (tPinned === null) {
  console.error('!! could not reach the uTime uniform, so only the rAF freeze is holding the sway.');
  console.error('   The base-vs-base2 drift floor at the bottom of each table is the check that matters:');
  console.error('   if it is not near zero, the run is measuring the idle lean and not the material.');
} else if (tAfter !== tPinned) {
  console.error('REFUSED: the sway clock is not frozen, so base and base2 are different poses and');
  console.error('every arm below would be measuring the idle lean rather than the material.');
  await browser.close();
  process.exit(2);
}

const applyPlate = async (p) => {
  await page.evaluate((spec) => {
    window.__viewer.plate({
      unit: spec.unit, hash: spec.hash, lod: 0, clip: spec.clip, phase: spec.phase,
      azimuth: spec.az, elevation: spec.el, fill: spec.fill, aimY: spec.aimY,
    });
  }, p);
  await settle(5);
};

// ---------------------------------------------------------------------------
// Interleaved capture. Arms outer, plates inner; `base2` last.
// ---------------------------------------------------------------------------

const armChecks = {};
for (const arm of ARMS) {
  for (const p of PLATES) {
    await applyPlate(p);
    const res = await page.evaluate((a) => window.__arm(a), arm);
    await settle(4);
    const file = path.join(OUT, `${p.name}--${arm}.png`);
    await page.screenshot({ path: file, type: 'png' });
    armChecks[`${p.name}/${arm}`] = res;
  }
  const r = armChecks[`${PLATES[0].name}/${arm}`];
  const want = {
    'base': [1, 1, 1, 1], 'base2': [1, 1, 1, 1], 'cav0': [1, 1, 1, 1],
    'no-normal': [0, 1, 1, 1], 'no-rough': [1, 0, 1, 1], 'no-metal': [1, 1, 0, 1],
    'no-ao': [1, 1, 1, 0], 'flat-all': [0, 0, 0, 0],
  }[arm];
  const got = r.state.map((s) => [+s.normalMap, +s.roughnessMap, +s.metalnessMap, +s.aoMap]);
  const bad = got.filter((g) => g.join() !== want.join()).length;
  console.log(
    `• arm ${arm.padEnd(10)} touched ${r.touched} materials, cavity=${r.cav}`
    + `  post-hoc field state ${bad === 0 ? 'MATCHES' : `MISMATCH on ${bad}`} the arm`
    + (r.strays.length ? `  STRAY MATERIALS ${r.strays.length}` : '')
    + (r.missing.length ? `  MISSING ${r.missing.length}` : '')
  );
  if (bad !== 0) {
    console.error(`  !! ${arm} did not take: wanted [${want}] got ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------------------------------
// Facts about the material as the GPU sees it. Taken after all the arms, with the
// world restored to `base2` (= base) so what is read back is the shipped state.
// ---------------------------------------------------------------------------

await applyPlate(PLATES[1]);
await page.evaluate(() => window.__arm('base'));
await settle(4);

const gpu = await page.evaluate(() => {
  const cap = window.__pickCap();
  const out = { meshes: [], programs: [], drawBuffer: null, camera: null };
  const r = cap.renderer;
  const dbs = new (window.__THREE.Vector2)();
  r.getDrawingBufferSize(dbs);
  out.drawBuffer = [dbs.x, dbs.y];
  out.pixelRatio = r.getPixelRatio();
  const cam = cap.camera;
  out.camera = {
    type: cam.type, fov: cam.fov, aspect: cam.aspect,
    pos: [cam.position.x, cam.position.y, cam.position.z],
  };

  const isSoldierMat = (m) => !!m && m.isMeshStandardMaterial === true && (
    (m.map && m.map.name === 'soldier-albedo') || (m.normalMap && m.normalMap.name === 'soldier-normal'));

  const gl = r.getContext();
  const seen = new Set();
  cap.scene.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some(isSoldierMat)) return;
    const g = o.geometry;
    out.meshes.push({
      name: o.name, type: o.type,
      instanceCount: o.count ?? null,
      visible: o.visible,
      attributes: Object.keys(g.attributes),
      hasTangent: !!g.attributes.tangent,
      hasNormal: !!g.attributes.normal,
      hasUv: !!g.attributes.uv,
      hasUv1: !!g.attributes.uv1,
      indexCount: g.index ? g.index.count : null,
      vertexCount: g.attributes.position ? g.attributes.position.count : null,
    });
    for (const m of ms) {
      if (!isSoldierMat(m) || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      const rec = { material: m.name || '(unnamed)', defines: null, normalScaleUniform: null, err: null };
      try {
        const props = r.properties.get(m);
        const prog = props.currentProgram;
        const glp = prog && prog.program;
        if (!glp) { rec.err = 'no linked program (mesh may not have drawn this frame)'; }
        else {
          const shaders = gl.getAttachedShaders(glp) || [];
          const srcs = shaders.map((s) => gl.getShaderSource(s));
          const frag = srcs.find((s) => s && s.includes('#define STANDARD') && s.includes('gl_FragCoord')) || srcs[srcs.length - 1];
          const vert = srcs.find((s) => s !== frag);
          rec.defines = (frag || '').split('\n').filter((l) => /^#define (USE_|STANDARD|FLAT_SHADED|TANGENTSPACE|OBJECTSPACE)/.test(l.trim())).map((l) => l.trim());
          rec.vertDefines = (vert || '').split('\n').filter((l) => /^#define USE_(TANGENT|UV|NORMAL|MAP)/.test(l.trim())).map((l) => l.trim());
          const loc = gl.getUniformLocation(glp, 'normalScale');
          if (loc) {
            const v = gl.getUniform(glp, loc);
            rec.normalScaleUniform = v ? Array.from(v) : null;
          } else {
            rec.normalScaleUniform = 'no such uniform in the linked program';
          }
          const rl = gl.getUniformLocation(glp, 'roughness');
          rec.roughnessUniform = rl ? gl.getUniform(glp, rl) : null;
          const al = gl.getUniformLocation(glp, 'aoMapIntensity');
          rec.aoMapIntensityUniform = al ? gl.getUniform(glp, al) : null;
        }
      } catch (e) { rec.err = String(e && e.message); }
      rec.materialNormalScale = m.normalScale ? [m.normalScale.x, m.normalScale.y] : null;
      out.programs.push(rec);
    }
  });
  return out;
});

/*
 * Texel density.
 *
 * Two independent halves, multiplied:
 *
 *   texels per metre   intrinsic to the mesh — for every triangle of a piece, the UV area in
 *                      atlas texels over the world area in m^2, square-rooted. Rest pose, so
 *                      skinning is the uncertainty (small on a torso, which barely deforms).
 *   pixels per metre   from the camera the viewer actually built: `framePlate` puts the aim
 *                      point at `dist = (0.95 / fill) / tan(fovY/2)`, so a metre at the aim
 *                      plane subtends drawBufferH / (2 * 0.95 / fill) device pixels exactly.
 *
 * texels/px = (tx/m) / (px/m) for a surface square to the camera; a surface slanted by theta
 * samples 1/cos(theta) coarser, so this is a lower bound and the frontal case. mip = log2 of
 * that: negative means the sampler is MAGNIFYING mip 0 and no mip below 0 exists.
 */
const uvd = await page.evaluate(async () => {
  const cap = window.__pickCap();
  const isSoldierMat = (m) => !!m && m.isMeshStandardMaterial === true && (
    (m.map && m.map.name === 'soldier-albedo') || (m.normalMap && m.normalMap.name === 'soldier-normal'));
  let mesh = null;
  cap.scene.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some(isSoldierMat)) return;
    if ((o.count ?? 0) > 0 && !mesh) mesh = o;
  });
  if (!mesh) cap.scene.traverse((o) => { if (!mesh && o.isMesh && (Array.isArray(o.material) ? o.material : [o.material]).some(isSoldierMat)) mesh = o; });
  if (!mesh) return { ok: false, why: 'no drawn soldier mesh' };
  const mat = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).find(isSoldierMat);
  const aw = mat.map.image.width;
  const ah = mat.map.image.height;

  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const pieceAttr = g.getAttribute('aPieceTint') || g.getAttribute('aPiece') || g.getAttribute('aPieceId');
  const idx = g.getIndex();
  if (!pos || !uv || !idx) return { ok: false, why: 'geometry is missing position/uv/index' };

  const per = new Map();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    const p = pieceAttr ? pieceAttr.getX(i0) : -1;
    const e1 = [pos.getX(i1) - pos.getX(i0), pos.getY(i1) - pos.getY(i0), pos.getZ(i1) - pos.getZ(i0)];
    const e2 = [pos.getX(i2) - pos.getX(i0), pos.getY(i2) - pos.getY(i0), pos.getZ(i2) - pos.getZ(i0)];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const wa = 0.5 * Math.hypot(cx, cy, cz);
    const du1 = (uv.getX(i1) - uv.getX(i0)) * aw, dv1 = (uv.getY(i1) - uv.getY(i0)) * ah;
    const du2 = (uv.getX(i2) - uv.getX(i0)) * aw, dv2 = (uv.getY(i2) - uv.getY(i0)) * ah;
    const ta = 0.5 * Math.abs(du1 * dv2 - du2 * dv1);
    if (wa < 1e-9) continue;
    let a = per.get(p);
    if (!a) { a = { piece: p, tris: 0, d: [], y0: Infinity, y1: -Infinity, uvArea: 0, worldArea: 0 }; per.set(p, a); }
    a.tris++;
    a.d.push(Math.sqrt(ta / wa));
    a.uvArea += ta;
    a.worldArea += wa;
    for (const i of [i0, i1, i2]) {
      const y = pos.getY(i);
      if (y < a.y0) a.y0 = y;
      if (y > a.y1) a.y1 = y;
    }
  }
  const pct = (xs, q) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
  const pieces = [...per.values()].map((a) => ({
    piece: a.piece, tris: a.tris,
    medianTxPerM: pct(a.d, 0.5), p10: pct(a.d, 0.1), p90: pct(a.d, 0.9),
    worldArea: a.worldArea, uvArea: a.uvArea,
    areaTxPerM: Math.sqrt(a.uvArea / a.worldArea),
    yMin: a.y0, yMax: a.y1,
  })).sort((x, y) => y.tris - x.tris);
  return { ok: true, atlas: [aw, ah], meshName: mesh.name, pieces, hasPieceAttr: !!pieceAttr };
});

/*
 * Empirical anchor for the texel-density arithmetic.
 *
 * Everything above is derived: px/m from `framePlate`'s own formula, tx/m from the live UV
 * attribute. Both can be checked at once by drawing ONE piece at the exact plate camera and
 * measuring how many pixels of frame it lands on. `solo()` re-aims the camera at the piece, so
 * `plateAim()` is called straight after to put the plate camera back — same azimuth, elevation,
 * fill and aim point as `praet-torso`, one piece in shot.
 *
 * The measured on-screen height over the piece's world height is px/m *observed*, including
 * skinning and perspective, which is the number the derivation has to match.
 */
const SOLO_IDS = [13, 15, 16, 17, 18, 19, 43];
const soloShots = [];
for (const id of SOLO_IDS) {
  await applyPlate(PLATES[1]);
  await page.evaluate((i) => window.__viewer.solo(i), id);
  await page.evaluate((p) => window.__viewer.plateAim(p.az, p.el, p.fill, p.aimY), PLATES[1]);
  await settle(4);
  const f = path.join(OUT, `solo-${id}.png`);
  await page.screenshot({ path: f, type: 'png' });
  soloShots.push({ id, file: f });
}

await browser.close();

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(112));
console.log('ARM DIFFERENCING — all arms one session, base re-shot last, mask fixed on base');
console.log('='.repeat(112));

const summary = {};
for (const p of PLATES) {
  const baseFile = path.join(OUT, `${p.name}--base.png`);
  const baseL = await loadWorking(baseFile);
  const mask = figureMask(baseL);
  let cov = 0;
  let x0 = SW, x1 = -1, y0 = SH, y1 = -1;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (!mask[y * SW + x]) continue;
      cov++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const baseE = bandEnergies(baseL, mask);
  const baseNat = await loadNative(baseFile);
  const natMask = upMask(mask, baseNat.w, baseNat.h);
  let natCov = 0;
  for (let i = 0; i < natMask.length; i++) if (natMask[i]) natCov++;

  console.log(`\n${p.name}  —  ${p.unit} hash ${p.hash} ${p.clip} phase ${p.phase} az ${p.az} el ${p.el} fill ${p.fill}${p.aimY !== undefined ? ` aimY ${p.aimY}` : ''}`);
  console.log(`  native ${baseNat.w}x${baseNat.h}; working ${SW}x${SH}; figure mask ${cov} px (${(100 * cov / N).toFixed(2)}% of frame), bbox x ${x0}..${x1} y ${y0}..${y1} (${x1 - x0 + 1}x${y1 - y0 + 1} working px)`);
  console.log(`  base   E1 ${baseE[0].toFixed(3)}   E2 ${baseE[1].toFixed(3)}   R ${(baseE[0] / baseE[1]).toFixed(4)}`);
  console.log('');
  console.log('  arm         | NATIVE 1800x2400 figure px      | WORKING 900x1200 figure px       | band energies on figure px');
  console.log('              |  meanAbs/255   pct>1/255   max  |  meanAbs/255   pct>1/255         |     E1      dE1%      E2      dE2%       R      dR%');
  console.log('  ' + '-'.repeat(140));

  const rows = {};
  for (const arm of ARMS) {
    const f = path.join(OUT, `${p.name}--${arm}.png`);
    const L = await loadWorking(f);
    const nat = await loadNative(f);

    // Native, on figure pixels: mean |dLuma| in /255, pct over 1/255, and the max.
    let sAbs = 0; let over = 0; let mx = 0; let n = 0;
    for (let i = 0; i < natMask.length; i++) {
      if (!natMask[i]) continue;
      const o = i * baseNat.c;
      const la = 0.2126 * baseNat.data[o] + 0.7152 * baseNat.data[o + 1] + 0.0722 * baseNat.data[o + 2];
      const lb = 0.2126 * nat.data[o] + 0.7152 * nat.data[o + 1] + 0.0722 * nat.data[o + 2];
      const d = Math.abs(la - lb);
      sAbs += d; if (d > 1) over++; if (d > mx) mx = d;
      n++;
    }
    const natMean = sAbs / Math.max(1, n);
    const natPct = (100 * over) / Math.max(1, n);

    // Working plane, same statistic, plus the bands.
    let wAbs = 0; let wOver = 0; let wn = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const d = Math.abs(baseL[i] - L[i]) * 255;
      wAbs += d; if (d > 1) wOver++; wn++;
    }
    const E = bandEnergies(L, mask);
    const R = E[0] / E[1];
    rows[arm] = {
      natMean, natPct, natMax: mx, natPx: n,
      wMean: wAbs / Math.max(1, wn), wPct: (100 * wOver) / Math.max(1, wn),
      E1: E[0], E2: E[1], R,
      dE1: (100 * (E[0] - baseE[0])) / baseE[0],
      dE2: (100 * (E[1] - baseE[1])) / baseE[1],
      dR: (100 * (R - baseE[0] / baseE[1])) / (baseE[0] / baseE[1]),
    };
    const r = rows[arm];
    console.log(
      `  ${arm.padEnd(11)} |  ${r.natMean.toFixed(4).padStart(11)}  ${r.natPct.toFixed(2).padStart(9)}  ${r.natMax.toFixed(0).padStart(4)}  |`
      + `  ${r.wMean.toFixed(4).padStart(11)}  ${r.wPct.toFixed(2).padStart(9)}        |`
      + `  ${r.E1.toFixed(3).padStart(6)}  ${(r.dE1 >= 0 ? '+' : '') + r.dE1.toFixed(2)}`.padEnd(20)
      + `  ${r.E2.toFixed(3).padStart(6)}  ${(r.dE2 >= 0 ? '+' : '') + r.dE2.toFixed(2)}`.padEnd(20)
      + `  ${r.R.toFixed(4)}  ${(r.dR >= 0 ? '+' : '') + r.dR.toFixed(2)}`
    );
  }
  const floor = rows.base2.natMean;
  console.log('  ' + '-'.repeat(140));
  console.log(`  DRIFT FLOOR (base vs base2, native figure px): meanAbs ${floor.toFixed(5)}/255, pct>1/255 ${rows.base2.natPct.toFixed(3)}%, max ${rows.base2.natMax}`);
  for (const arm of ARMS) {
    if (arm === 'base' || arm === 'base2') continue;
    const r = rows[arm];
    const ratio = floor > 1e-9 ? r.natMean / floor : Infinity;
    console.log(`    ${arm.padEnd(10)} is ${Number.isFinite(ratio) ? `${ratio.toFixed(0)}x` : '>>'} the drift floor`);
  }
  summary[p.name] = { coverage: cov, base: { E1: baseE[0], E2: baseE[1], R: baseE[0] / baseE[1] }, arms: rows };
}

// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(112));
console.log('THE MATERIAL AS THE GPU SEES IT');
console.log('='.repeat(112));
console.log(`drawing buffer ${gpu.drawBuffer[0]}x${gpu.drawBuffer[1]} at pixelRatio ${gpu.pixelRatio};  camera fov ${gpu.camera.fov} aspect ${gpu.camera.aspect.toFixed(4)}`);
console.log('\nsoldier meshes in the scene:');
for (const m of gpu.meshes) {
  console.log(`  ${(m.name || '(unnamed)').padEnd(26)} ${m.type.padEnd(20)} instances ${String(m.instanceCount).padStart(3)} visible ${m.visible}`);
  console.log(`  ${''.padEnd(26)} VERTEX TANGENTS: ${m.hasTangent ? 'YES' : 'NO'}   normal ${m.hasNormal}  uv ${m.hasUv}  uv1 ${m.hasUv1}  verts ${m.vertexCount}  idx ${m.indexCount}`);
  console.log(`  ${''.padEnd(26)} attributes: ${m.attributes.join(', ')}`);
}
console.log('\nlinked program, read back with gl.getShaderSource / gl.getUniform:');
for (const p of gpu.programs) {
  console.log(`  material ${p.material}`);
  if (p.err) console.log(`    ERROR: ${p.err}`);
  console.log(`    material.normalScale      = [${p.materialNormalScale}]`);
  console.log(`    GPU uniform normalScale   = ${JSON.stringify(p.normalScaleUniform)}`);
  console.log(`    GPU uniform roughness     = ${p.roughnessUniform}`);
  console.log(`    GPU uniform aoMapIntensity= ${p.aoMapIntensityUniform}`);
  if (p.defines) {
    console.log(`    fragment #defines (${p.defines.length}):`);
    for (const d of p.defines) console.log(`        ${d}`);
  }
  if (p.vertDefines && p.vertDefines.length) console.log(`    vertex: ${p.vertDefines.join('  ')}`);
}

console.log('\n' + '='.repeat(112));
console.log('ATLAS TEXEL DENSITY ON SCREEN');
console.log('='.repeat(112));
if (!uvd.ok) {
  console.log(`could not measure: ${uvd.why}`);
} else {
  const [aw, ah] = uvd.atlas;
  const dbh = gpu.drawBuffer[1];
  const fovY = (gpu.camera.fov * Math.PI) / 180;
  const NAMES = {
    0: 'Head+arms', 1: 'HairShort', 2: 'HairLong', 3: 'Beard', 4: 'HelmGallic', 5: 'HelmRidge',
    6: 'HelmCoolus', 7: 'HelmSpangen', 8: 'HelmFur', 9: 'CrestTransverse', 10: 'CrestLongitudinal',
    11: 'CrestPlume', 12: 'CrestHorns', 13: 'Tunic', 14: 'Focale', 15: 'TorsoBare',
    16: 'Segmentata', 17: 'Mail', 18: 'Scale', 19: 'Leather', 20: 'LegsBare', 21: 'Trousers',
    22: 'Boots', 23: 'Cloak', 24: 'ShieldScutum', 25: 'ShieldOval', 26: 'ShieldRound',
    27: 'Sword', 28: 'Spear', 29: 'Axe', 30: 'Bow', 31: 'Quiver', 32: 'Pilum',
    33: 'JavelinBundle', 34: 'Torc', 35: 'SwordSheathed', 36: 'HelmAttic', 37: 'HelmIberian',
    38: 'ShieldHoplon', 39: 'ShieldCaetra', 40: 'Falcata', 41: 'Sling', 42: 'SlingPouch',
    43: 'ArmourLinen', 44: 'Greaves',
  };
  console.log(`atlas ${aw}x${ah} (a material tile is 128 px); drawing buffer height ${dbh} px; fov ${gpu.camera.fov} deg`);
  console.log('framePlate: half-frame height at the aim plane = 0.95 / fill metres, so px/m = (drawBufferH/2) / (0.95/fill)\n');
  console.log('plate          fill   half-frame(m)   camera dist(m)   device px per metre');
  for (const p of PLATES) {
    const half = 0.95 / p.fill;
    const dist = half / Math.tan(fovY / 2);
    const ppm = (dbh / 2) / half;
    console.log(`${p.name.padEnd(14)} ${String(p.fill).padStart(4)}   ${half.toFixed(4).padStart(13)}   ${dist.toFixed(4).padStart(14)}   ${ppm.toFixed(1).padStart(19)}`);
  }
  const pt = PLATES[1];
  const ppm = (dbh / 2) / (0.95 / pt.fill);
  console.log(`\npraet-torso: ${ppm.toFixed(1)} device px per metre at the aim plane (aimY ${pt.aimY}).`);
  console.log('\npiece                tris   median tx/m   area tx/m   y span (m)     texels/px   mip lambda   px per texel');
  console.log('-'.repeat(118));
  const torsoish = new Set([13, 15, 16, 17, 18, 19, 43, 0, 4, 5, 6, 14, 23, 24]);
  const show = uvd.pieces.filter((q) => q.tris >= 8 && (torsoish.has(q.piece) || q.tris > 120)).slice(0, 18);
  for (const q of show) {
    const tpp = q.medianTxPerM / ppm;
    console.log(
      `${String(NAMES[q.piece] ?? q.piece).padEnd(18)} ${String(q.tris).padStart(5)}   ${q.medianTxPerM.toFixed(1).padStart(11)}   ${q.areaTxPerM.toFixed(1).padStart(9)}   `
      + `${q.yMin.toFixed(2)}..${q.yMax.toFixed(2)}   ${tpp.toFixed(4).padStart(11)}   ${Math.log2(tpp).toFixed(2).padStart(10)}   ${(1 / tpp).toFixed(2).padStart(12)}`
    );
  }
  console.log('-'.repeat(118));
  console.log('texels/px < 1 means the sampler is MAGNIFYING mip 0: lambda is negative, there is no mip below 0,');
  console.log('and one atlas texel is smeared over (1/texels-per-px) screen pixels by the LinearFilter magnifier.');
}

// Empirical check of the px/m model: one piece, drawn alone, at the exact plate camera.
if (uvd.ok) {
  const NAMES2 = { 13: 'Tunic', 15: 'TorsoBare', 16: 'Segmentata', 17: 'Mail', 18: 'Scale', 19: 'Leather', 43: 'ArmourLinen' };
  const dbh = gpu.drawBuffer[1];
  const ppmDerived = (dbh / 2) / (0.95 / PLATES[1].fill);
  console.log('\nEMPIRICAL CHECK — praet-torso, one piece soloed at the same plate camera');
  console.log(`derived px/m at the aim plane is ${ppmDerived.toFixed(1)}; "observed px/m" below is measured pixels over the piece's rest-pose world height\n`);
  console.log('piece            visible px    bbox (device px)     world y span   observed px/m   derived px/m   tx/px (observed)');
  console.log('-'.repeat(122));
  for (const s of soloShots) {
    const L = await loadWorking(s.file);
    const mask = figureMask(L);
    let cov = 0; let y0 = SH; let y1 = -1; let x0 = SW; let x1 = -1;
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        if (!mask[y * SW + x]) continue;
        cov++;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
      }
    }
    const name = NAMES2[s.id] ?? s.id;
    if (cov < 400) { console.log(`${String(name).padEnd(15)}  ${String(cov).padStart(9)}    (not on this man)`); continue; }
    const g = uvd.pieces.find((q) => q.piece === s.id);
    const hDev = (y1 - y0 + 1) * DPR;
    const wDev = (x1 - x0 + 1) * DPR;
    const covDev = cov * DPR * DPR;
    const world = g ? g.yMax - g.yMin : NaN;
    const obs = world > 0 ? hDev / world : NaN;
    // Visible surface is roughly the front half of a closed shell, so half the UV area lands
    // on the covDev pixels that were drawn. sqrt of that ratio is texels per pixel.
    const txpx = g ? Math.sqrt((g.uvArea / 2) / covDev) : NaN;
    console.log(
      `${String(name).padEnd(15)}  ${String(covDev).padStart(9)}    ${String(wDev).padStart(4)}x${String(hDev).padStart(4)} at y ${String(y0 * DPR).padStart(4)}   `
      + `${world.toFixed(3).padStart(11)}   ${obs.toFixed(0).padStart(13)}   ${ppmDerived.toFixed(0).padStart(12)}   ${txpx.toFixed(3).padStart(16)}`
    );
  }
  console.log('-'.repeat(122));
  console.log('"observed px/m" uses the rest-pose y span against a posed render, so it carries the pose error;');
  console.log('agreement with the derived figure to within that is what validates the derivation.');
}

if (errors.length) {
  console.error(`\n${errors.length} page error(s) / console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.error(`  ${e}`);
}
fs.writeFileSync(path.join(OUT, 'kitmaps.json'), `${JSON.stringify({ summary, gpu, uvd, armChecks: Object.fromEntries(Object.entries(armChecks).map(([k, v]) => [k, { touched: v.touched, cav: v.cav, state: v.state }])) }, null, 2)}\n`);
console.log(`\n→ ${path.join(OUT, 'kitmaps.json')}`);
