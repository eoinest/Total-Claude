#!/usr/bin/env node
/**
 * Masonry relief probe: is a recess *modelled* by the normal map, or *painted* into
 * the albedo?
 *
 * A blind grader named the separator as "every recess is painted rather than modelled —
 * the sharpest instance being brick coursing that shows **identical contrast in sunlit and
 * shadowed regions under raking light**". That last clause is a measurement, and this is it.
 *
 * The statistic is **relative micro-contrast**, `RC`:
 *
 *     hp  = bandpass(L)                  difference of two gaussians, sigma 1.2 and 4.0 px
 *     RC  = RMS(hp) / mean(lowpass(L))   normalised, so it is invariant to light *level*
 *
 * and the diagnostic is the ratio `RC(sunlit) / RC(shaded)` over the same surface.
 *
 * Why that ratio and not the contrast itself: an albedo-painted joint carries the same
 * *relative* contrast whether the sun is on it or not, because both the joint and the brick
 * beside it scale by the same illumination. A joint whose contrast comes from the normal
 * only exists while a directional light is on it. So
 *
 *     RC_sun / RC_shade  ->  1.00   pure paint, no relief
 *     RC_sun / RC_shade  >>  1      relief doing the work, which is what raking light means
 *
 * Two arms, because the renderer and the texture can each be wrong on their own:
 *
 *   `--offline`  Generate the maps in-page from `src/city/texgen.ts` and shade them
 *                analytically with a Lambert term. No renderer, no camera, no mip guessing
 *                except the explicit box-downsample ladder — this isolates *the texture*.
 *                It also reports how fast the normal's perturbation dies through the mip
 *                chain, which is the other half of "painted": a normal map that averages to
 *                flat by mip 3 is paint everywhere past 20 m no matter how it was authored.
 *
 *   live         Boot the game, park a camera, mask the brick material by emissive flash,
 *                split those pixels into sunlit and shaded by *differencing the sun out*
 *                rather than by thresholding luminance, and run the same statistic on the
 *                finished frame.
 *
 *   node tools/probe-masonry.mjs --offline
 *   node tools/probe-masonry.mjs --port=5733 --shots=wallraking
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5733);
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/masonry');
const TAG = args.get('tag') ?? '';
const OFFLINE_ONLY = args.has('offline');
const KEEP = args.has('keep');

/**
 * Cameras. `wallraking` is not in `shoot.mjs`: the shot table's `raking` frame is the
 * Roman line at zoom 0.22 and carries almost no masonry, while `wall` at zoom 0.62 puts
 * the curtain 90 m away where a 55 mm course is well under a pixel. Neither can answer a
 * question about coursing. These are picked for *masonry filling the frame with the sun
 * across it*, and each one's sun-versus-camera bearing is printed so the claim is checkable.
 */
/*
 * Two different things get called "raking" and they are not the same requirement.
 *
 *   - A raking *camera* is one where the sun is broadside to the view, so cast shadows
 *     fall across the frame instead of hiding behind their casters. Measured here,
 *     `sunRelDeg = 33.2 - yawDeg`, so yaw pi*1.62 gives +102 deg and yaw pi*0.06 (the
 *     shipped `wall` shot) gives only +22.
 *   - Raking *light on a surface* is the sun grazing that surface, which is what makes a
 *     course self-shadow at all. That is a property of the face, not the camera.
 *
 * On this wall those two pull apart, and the shipped `wall` shot satisfies neither. The sun
 * bears 33.2 deg; the curtain's inner face normal bears 21.5 deg, so the sun hits it 12 deg
 * off *normal* — the flattest possible light — and the outer face bears 201.5 deg and is in
 * full shade at every hour, exactly as the shot table's own comment says. The surfaces that
 * are genuinely raked are the ones turned 90 deg out of the curtain: **tower flanks and
 * merlon returns**, normal bearing ~111 deg, i.e. 78 deg off the sun. `walltowers` looks
 * straight down the wall line so those flanks face the camera, and puts the opposite flanks
 * of the same towers in shade — the same material, same tile, same distance, sunlit and
 * shaded side by side, which is the comparison the separator is about.
 */
const SHOTS = {
  wall: { x: -81, z: 503, zoom: 0.62, yaw: Math.PI * 0.06, at: 3 },
  walltowers: { x: -200, z: 470, zoom: 0.44, yaw: Math.PI * 1.619, at: 3 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2 },
};
const requested = args.get('shots') ? String(args.get('shots')).split(',') : ['walltowers', 'wall'];

/**
 * Attribution arms. The separator claims the coursing is paint; these decide it by removing
 * one channel at a time and re-measuring, rather than by argument.
 *
 *   base      as shipped
 *   nonormal  normalMap removed — whatever survives is paint (plus grain)
 *   nopaint   albedo detail removed, material.color rescaled to hold the level — whatever
 *             survives is relief (plus grain)
 *   flat      both removed — the grain, dither and geometry-edge floor the other three sit on
 */
const ARMS = args.get('arms') ? String(args.get('arms')).split(',') : ['base', 'nonormal', 'nopaint', 'flat'];

// ---------------------------------------------------------------------------
// The statistic. Shared by both arms so the numbers are directly comparable.
// ---------------------------------------------------------------------------

/** Separable gaussian blur over a Float64 plane, with a mask-aware normalisation. */
function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r * 2 + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    ks += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += src[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * Relative micro-contrast over a mask.
 *
 * `sigmaHi`/`sigmaLo` bracket the band the coursing lives in; `sigmaMean` is the local
 * illumination the band-pass is divided by. Pixels within `guard` of the mask edge are
 * dropped — a band-pass straddling a silhouette measures the silhouette, not the surface.
 */
function relContrast(lum, mask, w, h, { sigmaHi = 1.2, sigmaLo = 4.0, sigmaMean = 12.0, guard = 5 } = {}) {
  // Fill unmasked pixels with the mask's mean so the blur does not drag the edge.
  let m0 = 0;
  let mn = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { m0 += lum[i]; mn++; }
  if (mn < 500) return null;
  m0 /= mn;
  const filled = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = mask[i] ? lum[i] : m0;

  const hi = blur(filled, w, h, sigmaHi);
  const lo = blur(filled, w, h, sigmaLo);
  const mid = blur(filled, w, h, sigmaMean);

  // Erode the mask by `guard` so no band-pass window crosses a silhouette.
  let cur = mask;
  for (let p = 0; p < guard; p++) {
    const nxt = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) nxt[i] = 1;
      }
    }
    cur = nxt;
  }

  let se = 0;
  let sm = 0;
  let n = 0;
  let sabs = 0;
  for (let i = 0; i < w * h; i++) {
    if (!cur[i]) continue;
    const bp = hi[i] - lo[i];
    se += bp * bp;
    sabs += Math.abs(bp);
    sm += mid[i];
    n++;
  }
  if (n < 300) return null;
  const rms = Math.sqrt(se / n);
  const mean = sm / n;
  return { px: n, rms, absMean: sabs / n, mean, rc: rms / Math.max(1e-6, mean) };
}

// ---------------------------------------------------------------------------
// server / browser
// ---------------------------------------------------------------------------

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
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}
{
  let via = 'unknown';
  try {
    const r = await fetch(`${base}/src/city/texgen.ts`, { signal: AbortSignal.timeout(4000) });
    via = r.ok ? 'vite dev (src/city/texgen.ts served)' : `NOT a dev server (${r.status}) — probably a stale dist/`;
  } catch { via = 'unreachable'; }
  console.log(`source: ${base} — ${reused ? 'reused an existing server' : 'started my own'} — ${via}`);
  console.log(`cwd: ${ROOT}`);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(300000);
page.setDefaultNavigationTimeout(300000);
page.on('pageerror', (e) => console.error('  ! page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('  ! console:', m.text().slice(0, 240)); });

// ===========================================================================
// ARM 1 — offline: the texture on its own.
// ===========================================================================

const OFFLINE = async () => {
  await page.goto(`${base}/index.html?harness=1&nohud=1`, { waitUntil: 'domcontentloaded' });
  const res = await page.evaluate(async ([lightEl, lightAz, ambFracs, normalScale, gens]) => {
    const tg = await import('/src/city/texgen.ts');

    const srgbToLin = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

    /** Box-downsample RGBA bytes by 2, the way the GPU builds a mip. */
    const halve = (px, s) => {
      const o = new Uint8Array((s / 2) * (s / 2) * 4);
      for (let y = 0; y < s / 2; y++) {
        for (let x = 0; x < s / 2; x++) {
          for (let c = 0; c < 4; c++) {
            const a = px[((y * 2) * s + x * 2) * 4 + c];
            const b = px[((y * 2) * s + x * 2 + 1) * 4 + c];
            const d = px[((y * 2 + 1) * s + x * 2) * 4 + c];
            const e = px[((y * 2 + 1) * s + x * 2 + 1) * 4 + c];
            o[(y * (s / 2) + x) * 4 + c] = Math.round((a + b + d + e) / 4);
          }
        }
      }
      return o;
    };

    const out = {};
    for (const gname of gens) {
      const maps = tg[gname](gname === 'brickFace' ? 1024 : 512);
      let albedo = Uint8Array.from(maps.albedo.image.data);
      let normal = Uint8Array.from(maps.normal.image.data);
      let s = maps.albedo.image.width;
      const gain = maps.albedoGain;

      const levels = [];
      for (let mip = 0; mip < 6 && s >= 32; mip++) {
        const n = s * s;
        // Decode. Albedo is sRGB-encoded (the DataTexture carries SRGBColorSpace), so the
        // GPU linearises it *after* filtering, exactly as here.
        const alb = new Float64Array(n);
        const nx = new Float64Array(n);
        const ny = new Float64Array(n);
        const nz = new Float64Array(n);
        let nxyAbs = 0;
        for (let i = 0; i < n; i++) {
          alb[i] = srgbToLin(albedo[i * 4]) * gain;
          let x = (normal[i * 4] / 255) * 2 - 1;
          let y = (normal[i * 4 + 1] / 255) * 2 - 1;
          let z = (normal[i * 4 + 2] / 255) * 2 - 1;
          // three.js: mapN.xy *= normalScale, then normalize.
          x *= normalScale; y *= normalScale;
          const l = Math.hypot(x, y, z) || 1;
          nx[i] = x / l; ny[i] = y / l; nz[i] = z / l;
          nxyAbs += Math.hypot(nx[i], ny[i]);
        }

        // Tangent-space light. T = along the wall (u), B = up (v), N = out of the face.
        const el = lightEl * Math.PI / 180;
        const az = lightAz * Math.PI / 180;
        const L = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];

        const arms = {};
        for (const af of ambFracs) {
          // E_sun scaled so a *flat* facet receives 1.0 from the sun, and ambient is
          // `af` of that — so the two arms are directly comparable across light angles.
          const flatCos = Math.max(0, L[2]);
          const eSun = flatCos > 1e-4 ? 1 / flatCos : 0;
          const sun = new Float64Array(n);
          const shade = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            const c = Math.max(0, nx[i] * L[0] + ny[i] * L[1] + nz[i] * L[2]);
            sun[i] = alb[i] * (eSun * c + af);
            shade[i] = alb[i] * af;
          }
          arms[af] = { sun, shade };
        }
        levels.push({ mip, size: s, n, nxyAbs: nxyAbs / n, arms, alb });
        if (s <= 32) break;
        albedo = halve(albedo, s);
        normal = halve(normal, s);
        s /= 2;
      }
      out[gname] = levels;
    }

    // Ship only the reduced statistics back: full planes would be tens of MB.
    // The contrast reduction is done here to avoid a giant transfer.
    const bandRC = (plane, s) => {
      // 1-D separable box band-pass in *texel* units: hi = 1 texel (identity), lo = 3-texel
      // box. At the texel level a course is 17 texels at mip 0, so a 3-texel low-pass is
      // firmly inside the band and does not eat the course itself.
      const lo = new Float64Array(s * s);
      const tmp = new Float64Array(s * s);
      const R = 3;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let a = 0; let c = 0;
          for (let i = -R; i <= R; i++) { a += plane[y * s + ((x + i + s) % s)]; c++; }
          tmp[y * s + x] = a / c;
        }
      }
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let a = 0; let c = 0;
          for (let i = -R; i <= R; i++) { a += tmp[((y + i + s) % s) * s + x]; c++; }
          lo[y * s + x] = a / c;
        }
      }
      let se = 0; let sm = 0;
      for (let i = 0; i < s * s; i++) { const d = plane[i] - lo[i]; se += d * d; sm += plane[i]; }
      const rms = Math.sqrt(se / (s * s));
      const mean = sm / (s * s);
      return { rms, mean, rc: rms / Math.max(1e-9, mean) };
    };

    /*
     * Do the paint and the relief pull the same way?
     *
     * `corr` is the correlation between the band-passed *albedo* and the band-passed
     * *Lambert term*. Positive means the texel the albedo paints dark is also the texel the
     * normal map turns away from the sun — paint and relief reinforcing. Negative means they
     * cancel: the map is lighting the inside of the recess the albedo has just painted as a
     * shadow, and the two subtract on the way to the screen. This is the statistic that
     * catches a flipped green channel, which changes no magnitude anywhere and so is
     * invisible to every other number in this probe.
     */
    const bandOf = (plane, s) => {
      const tmp = new Float64Array(s * s);
      const lo = new Float64Array(s * s);
      const R = 3;
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        let a = 0;
        for (let i = -R; i <= R; i++) a += plane[y * s + ((x + i + s) % s)];
        tmp[y * s + x] = a / (2 * R + 1);
      }
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        let a = 0;
        for (let i = -R; i <= R; i++) a += tmp[((y + i + s) % s) * s + x];
        lo[y * s + x] = a / (2 * R + 1);
      }
      const bp = new Float64Array(s * s);
      for (let i = 0; i < s * s; i++) bp[i] = plane[i] - lo[i];
      return bp;
    };
    const corrOf = (a, b, n) => {
      let sa = 0; let sb = 0;
      for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
      sa /= n; sb /= n;
      let cab = 0; let ca = 0; let cb = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - sa; const y = b[i] - sb; cab += x * y; ca += x * x; cb += y * y; }
      return cab / Math.max(1e-12, Math.sqrt(ca * cb));
    };

    const report = {};
    for (const [g, levels] of Object.entries(out)) {
      report[g] = levels.map((lv) => {
        const per = {};
        for (const [af, a] of Object.entries(lv.arms)) {
          const s = bandRC(a.sun, lv.size);
          const h = bandRC(a.shade, lv.size);
          per[af] = { rcSun: s.rc, rcShade: h.rc, ratio: s.rc / Math.max(1e-9, h.rc) };
        }
        // shade = albedo * const, so its band-pass IS the albedo's. cos = sun/albedo - amb.
        const af0 = Object.keys(lv.arms)[0];
        const albBp = bandOf(lv.arms[af0].shade, lv.size);
        const cos = new Float64Array(lv.n);
        for (let i = 0; i < lv.n; i++) cos[i] = lv.arms[af0].sun[i] / Math.max(1e-9, lv.alb[i]);
        const cosBp = bandOf(cos, lv.size);
        // Sign convention: a *dark* albedo texel is negative in albBp, and a texel turned
        // away from the sun is negative in cosBp, so reinforcing => positive correlation.
        const corr = corrOf(albBp, cosBp, lv.n);
        return { mip: lv.mip, size: lv.size, nxyAbs: lv.nxyAbs, paintReliefCorr: corr, per };
      });
    }
    return report;
  }, [38, 72, [0.15, 0.30], 1.5, ['brickFace', 'travertineAshlar', 'basaltPaving']]);

  console.log('\n=== ARM 1 — texture only, analytic Lambert, sun 38 deg elevation, 72 deg off the face normal');
  console.log('    nxy = mean |tangent-space n.xy| after normalScale; 0 = perfectly flat');
  for (const [g, levels] of Object.entries(res)) {
    console.log(`\n  ${g}`);
    console.log('    mip  size   nxy   paint/relief corr    amb15%: RCsun  RCshade  ratio');
    for (const lv of levels) {
      const a = lv.per['0.15'];
      console.log(
        `    ${String(lv.mip).padStart(3)}  ${String(lv.size).padStart(4)}  ${lv.nxyAbs.toFixed(3)}` +
        `        ${lv.paintReliefCorr >= 0 ? '+' : ''}${lv.paintReliefCorr.toFixed(3)}` +
        `             ${a.rcSun.toFixed(4)}   ${a.rcShade.toFixed(4)}  ${a.ratio.toFixed(3)}`
      );
    }
  }
  await writeFile(path.join(OUT, `${TAG}offline.json`), JSON.stringify(res, null, 2));
  return res;
};

const offline = await OFFLINE();

// ===========================================================================
// ARM 2 — live frame.
// ===========================================================================

const live = {};
if (!OFFLINE_ONLY) {
  await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&nohud=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

  let curShot = null;
  const step = async (n = 6) => page.evaluate(([k, c]) => {
    for (let i = 0; i < k; i++) {
      if (c) window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
      window.__game.engine.advance(1e-6, 1e-3);
    }
  }, [n, curShot]);

  const shot = async (name) => {
    const p = path.join(OUT, `${TAG}${name}.png`);
    await page.screenshot({ path: p });
    const r = await sharp(p).raw().toBuffer({ resolveWithObject: true });
    return { p, ...r };
  };
  const lumOf = (r) => {
    const n = r.info.width * r.info.height;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * r.info.channels;
      out[i] = (0.2126 * r.data[o] + 0.7152 * r.data[o + 1] + 0.0722 * r.data[o + 2]) / 255;
    }
    return out;
  };

  const PIN_JS = `window.__pin = function (obj, prop, value) {
    const had = Object.getOwnPropertyDescriptor(obj, prop);
    Object.defineProperty(obj, prop, { get: () => value, set: () => {}, configurable: true });
    return () => Object.defineProperty(obj, prop, had ?? { value, writable: true, configurable: true, enumerable: true });
  };`;

  let simTime = 0;
  for (const name of requested) {
    const s = SHOTS[name];
    if (!s) { console.error(`unknown shot ${name}`); continue; }
    curShot = s;
    console.log(`\n=== ARM 2 — live: ${name}`);

    const need = s.at - simTime;
    await page.evaluate(async (dt) => {
      window.__game.engine.time.paused = false;
      if (dt > 0.05) await window.__game.advance(dt);
    }, need);
    if (need > 0.05) simTime = s.at;
    await page.evaluate(async (c) => {
      window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
      await window.__game.advance(0.25);
      window.__game.engine.time.paused = true;
    }, s);
    await step(8);

    const info = await page.evaluate(() => {
      const ctx = window.__game.engine.context;
      const cam = ctx.camera;
      const sky = ctx.tryGet('sky');
      const e = cam.matrixWorld.elements;
      const fwd = { x: -e[8], z: -e[10] };
      const sd = sky?.sunDirection;
      const sunRel = sd ? Math.atan2(sd.x * fwd.z - sd.z * fwd.x, sd.x * fwd.x + sd.z * fwd.z) : null;
      // Does anything in the scene carry vertex tangents? Without them three.js falls back
      // to a screen-space derivative frame, which is legal but worth knowing.
      let withTangent = 0; let brickMeshes = 0; let brickTris = 0;
      ctx.scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (!mats.some((m) => m && m.name === 'city-brick')) return;
        brickMeshes++;
        brickTris += (o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3;
        if (o.geometry?.attributes?.tangent) withTangent++;
      });
      const bm = (() => {
        let f = null;
        ctx.scene.traverse((o) => {
          if (f || !o.isMesh) return;
          for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
            if (m && m.name === 'city-brick') f = m;
          }
        });
        return f;
      })();
      return {
        camPos: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(1)),
        sunElevDeg: sd ? +((Math.asin(sd.y) * 180) / Math.PI).toFixed(1) : null,
        sunRelDeg: sunRel === null ? null : +((sunRel * 180) / Math.PI).toFixed(0),
        brickMeshes, brickTris, withTangent,
        mat: bm ? {
          normalScale: [bm.normalScale.x, bm.normalScale.y],
          normalMapType: bm.normalMapType,
          color: [bm.color.r, bm.color.g, bm.color.b].map((v) => +v.toFixed(3)),
          roughness: bm.roughness, metalness: bm.metalness,
          envMapIntensity: bm.envMapIntensity,
          aoMap: !!bm.aoMap, aniso: bm.normalMap?.anisotropy ?? null,
          hasOnBeforeCompile: !!bm.onBeforeCompile && bm.onBeforeCompile.toString().length > 30,
        } : null,
      };
    });
    console.log(`  cam ${info.camPos}  sun elev ${info.sunElevDeg} deg  sun-vs-camera ${info.sunRelDeg} deg (+-90 = raking)`);
    console.log(`  city-brick on ${info.brickMeshes} meshes, ${Math.round(info.brickTris)} tris, ${info.withTangent} with vertex tangents`);
    console.log(`  material ${JSON.stringify(info.mat)}`);

    const A = await shot(`${name}-base`);

    // Brick mask by emissive flash.
    const flashed = await page.evaluate(() => {
      window.__flash = [];
      window.__game.engine.context.scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!m || m.name !== 'city-brick' || window.__flash.some((f) => f.m === m)) continue;
          window.__flash.push({ m, e: m.emissive.clone(), i: m.emissiveIntensity ?? 1 });
          m.emissive.setRGB(1, 1, 1);
          m.emissiveIntensity = 60;
        }
      });
      return window.__flash.length;
    });
    await step(8);
    const F = await shot(`${name}-flash`);
    await page.evaluate(() => {
      for (const f of window.__flash ?? []) { f.m.emissive.copy(f.e); f.m.emissiveIntensity = f.i; }
      window.__flash = [];
    });
    await step(8);

    // Sun off — the classification, differenced rather than thresholded.
    await page.evaluate((js) => {
      // eslint-disable-next-line no-eval
      if (!window.__pin) eval(js);
      const lig = window.__game.engine.context.tryGet('lighting');
      window.__undo = lig.csm.lights.map((l) => window.__pin(l, 'intensity', 0));
    }, PIN_JS);
    await step(8);
    const N = await shot(`${name}-nosun`);
    await page.evaluate(() => { for (const u of window.__undo ?? []) u(); window.__undo = []; });
    await step(8);

    const w = A.info.width;
    const h = A.info.height;
    const npx = w * h;
    const lA = lumOf(A);
    const lN = lumOf(N);
    const lF = lumOf(F);

    // Brick mask: flashed and saturated, eroded twice for bloom/TAA ringing.
    let hot = new Uint8Array(npx);
    for (let i = 0; i < npx; i++) if (lF[i] > 0.78) hot[i] = 1;
    for (let p = 0; p < 2; p++) {
      const nx = new Uint8Array(npx);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (hot[i] && hot[i - 1] && hot[i + 1] && hot[i - w] && hot[i + w]) nx[i] = 1;
        }
      }
      hot = nx;
    }
    let brickPx = 0;
    for (let i = 0; i < npx; i++) if (hot[i]) brickPx++;

    // Sun contribution and the split.
    const gains = [];
    for (let i = 0; i < npx; i++) if (hot[i]) gains.push(lA[i] - lN[i]);
    gains.sort((a, b) => a - b);
    const p90 = gains.length ? gains[Math.floor(gains.length * 0.9)] : 0;
    const sunMask = new Uint8Array(npx);
    const shadeMask = new Uint8Array(npx);
    let sN = 0;
    let hN = 0;
    for (let i = 0; i < npx; i++) {
      if (!hot[i]) continue;
      const g = lA[i] - lN[i];
      if (g > 0.55 * p90) { sunMask[i] = 1; sN++; }
      else if (g < 0.10 * p90) { shadeMask[i] = 1; hN++; }
    }

    console.log(`  brick pixels ${brickPx} (${(100 * brickPx / npx).toFixed(2)}% of frame)  sunlit ${sN}  shaded ${hN}  p90 sun gain ${p90.toFixed(4)}`);
    if (sN < 3000 || hN < 3000) {
      console.log('  !! not enough brick pixels in one of the two classes — skipping');
      live[name] = { sunRelDeg: info.sunRelDeg, brickPx, sunPx: sN, shadePx: hN, mat: info.mat };
      continue;
    }

    /*
     * The statistic is reported in **display** units, not linear, and deliberately so. The
     * grader's claim is about a finished frame, and AgX compresses a 0.68-display sunlit
     * face far harder than a 0.17-display shaded one — so a relief signal that is honestly
     * stronger in linear light can still arrive at the eye the same size in both. Dividing
     * by the local mean (RC) would hide exactly that. Both are printed: `amp` is the display
     * amplitude the eye sees, `RC` is that divided by the local level.
     */
    const rows = {};
    for (const arm of ARMS) {
      // `base2` is a plain re-shoot of the unchanged world: the floor every isolated
      // difference below has to clear before it means anything.
      const mutates = arm !== 'base' && arm !== 'base2';
      if (mutates) {
        await page.evaluate((a) => {
          window.__marm = [];
          window.__game.engine.context.scene.traverse((o) => {
            if (!o.isMesh || !o.visible) return;
            for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
              if (!m || m.name !== 'city-brick' || window.__marm.some((f) => f.m === m)) continue;
              window.__marm.push({ m, map: m.map, nm: m.normalMap, col: m.color.clone() });
              if (a === 'nonormal' || a === 'flat') m.normalMap = null;
              if (a === 'nopaint' || a === 'flat') {
                // The detail map is mean-normalised with the gain in material.color, so
                // dropping it multiplies the surface by 1/mean. Rescale the colour by the
                // map's own linear mean to hold the level, or the arm changes brightness as
                // well as detail and the two are no longer separable.
                const img = m.map?.image;
                let mean = 1;
                if (img?.data) {
                  let s = 0;
                  const n = img.width * img.height;
                  for (let i = 0; i < n; i++) {
                    const c = img.data[i * 4] / 255;
                    s += c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                  }
                  mean = s / n;
                }
                m.map = null;
                m.color.multiplyScalar(mean);
              }
              m.needsUpdate = true;
            }
          });
          return window.__marm.length;
        }, arm);
        await step(8);
      }
      const S = arm === 'base' ? A : await shot(`${name}-${arm}`);
      const lS = lumOf(S);
      const rs = relContrast(lS, sunMask, w, h);
      const rh = relContrast(lS, shadeMask, w, h);
      rows[arm] = { sun: rs, shade: rh, lum: lS };
      if (mutates) {
        await page.evaluate(() => {
          for (const f of window.__marm ?? []) {
            f.m.map = f.map; f.m.normalMap = f.nm; f.m.color.copy(f.col); f.m.needsUpdate = true;
          }
          window.__marm = [];
        });
        await step(8);
      }
    }

    console.log('  arm        sunlit: amp      RC     meanL        shaded: amp      RC     meanL      amp_sun/amp_shade');
    for (const arm of ARMS) {
      const r = rows[arm];
      if (!r.sun || !r.shade) { console.log(`  ${arm.padEnd(9)} (insufficient)`); continue; }
      console.log(
        `  ${arm.padEnd(9)}          ${r.sun.rms.toFixed(5)}  ${r.sun.rc.toFixed(4)}  ${r.sun.mean.toFixed(4)}` +
        `                ${r.shade.rms.toFixed(5)}  ${r.shade.rc.toFixed(4)}  ${r.shade.mean.toFixed(4)}` +
        `        ${(r.sun.rms / r.shade.rms).toFixed(3)}`
      );
    }
    /*
     * The isolation that actually answers the question.
     *
     * Band-pass amplitude of the *whole* frame is dominated by things that are not the
     * texture at all — merlon shadows, string courses, the stair, TAA grain — so a 4 %
     * change in it is hard to read. Differencing two arms of an identical paused world
     * cancels every one of those and leaves exactly the channel that was removed:
     *
     *     base - nonormal  =  what the normal map contributes
     *     base - nopaint   =  what the albedo detail contributes
     *     base - flat      =  what the tile contributes at all
     *     base - base2     =  the reproducibility floor these three must clear
     *
     * Reported in display luminance, sunlit and shaded separately. If `base - nonormal`
     * is the same size in sun and in shade, the normal map is not responding to the sun,
     * which is the separator restated as an experiment.
     */
    const diffAmp = (a, bl, mask) => {
      if (!rows[a] || !rows[bl]) return null;
      const d = new Float64Array(npx);
      for (let i = 0; i < npx; i++) d[i] = rows[a].lum[i] - rows[bl].lum[i];
      const r = relContrast(d, mask, w, h);
      if (!r) return null;
      // `relContrast` divides by the local mean of the *difference*, which is near zero and
      // meaningless; only the amplitude is wanted here, plus the mean absolute offset.
      let s = 0;
      let n = 0;
      for (let i = 0; i < npx; i++) if (mask[i]) { s += Math.abs(d[i]); n++; }
      return { amp: r.rms, absMean: s / Math.max(1, n) };
    };
    const pairs = [['flat', 'the whole tile'], ['nonormal', 'the normal map'], ['nopaint', 'the albedo detail'], ['base2', 'REPRODUCIBILITY FLOOR']];
    console.log('  isolated by differencing arms (display band-pass amplitude of base minus arm):');
    const iso = {};
    for (const [arm, label] of pairs) {
      if (!rows[arm]) continue;
      const ds = diffAmp('base', arm, sunMask);
      const dh = diffAmp('base', arm, shadeMask);
      if (!ds || !dh) continue;
      iso[arm] = { sun: ds.amp, shade: dh.amp, sunAbs: ds.absMean, shadeAbs: dh.absMean };
      console.log(
        `    ${label.padEnd(23)} sunlit ${ds.amp.toFixed(5)}   shaded ${dh.amp.toFixed(5)}   sun/shade ${(ds.amp / Math.max(1e-9, dh.amp)).toFixed(3)}`
      );
    }
    const b = rows.base;
    if (b?.sun && iso.flat) {
      console.log(`  >>> the tile contributes ${(100 * iso.flat.sun / b.sun.rms).toFixed(1)}% of the sunlit brick's visible micro-structure`);
      if (iso.nonormal) {
        console.log(`  >>> RELIEF sun/shade = ${(iso.nonormal.sun / Math.max(1e-9, iso.nonormal.shade)).toFixed(3)}  (1.00 = the normal map is not responding to the sun)`);
      }
      console.log(`  >>> shaded mean / sunlit mean = ${(b.shade.mean / b.sun.mean).toFixed(3)}  (the ambient fraction)`);
    }
    live[name] = {
      sunRelDeg: info.sunRelDeg, brickPx, sunPx: sN, shadePx: hN,
      mat: info.mat, withTangent: info.withTangent,
      arms: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, {
        sunAmp: v.sun?.rms ?? null, sunRC: v.sun?.rc ?? null, sunMean: v.sun?.mean ?? null,
        shadeAmp: v.shade?.rms ?? null, shadeRC: v.shade?.rc ?? null, shadeMean: v.shade?.mean ?? null,
      }])),
    };
  }
  await writeFile(path.join(OUT, `${TAG}live.json`), JSON.stringify(live, null, 2));
}

await browser.close();
if (server && !KEEP) server.kill('SIGTERM');
console.log('\ndone');
