#!/usr/bin/env node
/**
 * Sub-pixel stability — an aliasing measure that a blur cannot fake.
 *
 * The harshness ratio (pixel-scale Laplacian energy over structure-scale) separates our
 * frames from Rome II's completely, but a Gaussian of sigma 0.7 px moves one of our frames
 * across the entire gap. So it measures how soft the final resolve is, and it cannot tell a
 * genuinely sharp frame from an aliased one — both carry energy at the pixel scale.
 *
 * What actually distinguishes them is behaviour under a sub-pixel camera move. Correctly
 * filtered detail translates: the image changes smoothly and by about as much at the pixel
 * scale as at the structure scale. Aliased detail flips: sub-pixel geometry appears and
 * disappears, and the change is concentrated entirely at the pixel scale. So:
 *
 *   shimmer = RMS(delta at full res) / RMS(delta after a 4x box downsample)
 *
 * A frame that is merely soft scores low on harshness and unchanged on shimmer. A frame
 * that is genuinely better filtered scores lower on both. Blur cannot buy this one.
 *
 * Also exercises a quality-tier switch, because a renderer change that survives a static
 * frame and dies on `rebuild()` has shipped in this project before.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const PORT = Number(arg('port', 5211));
const OUT = path.resolve(arg('out', 'out/shimmer'));
const LABEL = arg('label', 'run');

const CAMS = {
  terrain: { x: -560, z: -420, zoom: 0.42, yaw: 0.9 },
  romanline: { x: -100, z: 128, zoom: 0.1, yaw: 1.9 },
  horizon: { x: -420, z: -120, zoom: 0.16, yaw: 2.5 },
};

function luma(d, w, h, c) {
  const o = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += c) o[i] = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
  return o;
}
function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }
function decim(img, w, h, f) {
  const nw = (w / f) | 0, nh = (h / f) | 0, o = new Float64Array(nw * nh), iv = 1 / (f * f);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) { const r = (y * f + dy) * w + x * f; for (let dx = 0; dx < f; dx++) s += img[r + dx]; }
    o[y * nw + x] = s * iv;
  }
  return { img: o, w: nw, h: nh };
}
async function toLuma(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { img: luma(data, info.width, info.height, info.channels), w: info.width, h: info.height };
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=ultra&w=1920&h=1080`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// The options object is waitForFunction's THIRD parameter; the second is `arg`. Passing it
// second silently discards it and leaves the 30 s default, which is shorter than a cold
// boot of this scene and surfaces as an unexplained timeout.
await page.waitForFunction(() => window.__game && window.__game.ready === true, undefined, { timeout: 180000 });
await mkdir(OUT, { recursive: true });

console.log(`\n=== ${LABEL} ===`);
console.log('shot        shimmer  deltaFull  delta4x');
const results = {};
for (const [name, c] of Object.entries(CAMS)) {
  await page.evaluate((cc) => { window.__game.advance(2); window.__game.setCamera(cc.x, cc.z, cc.zoom, cc.yaw); }, c);
  await page.waitForTimeout(700);
  const a = await page.screenshot({ type: 'png' });
  // Roughly a third of a pixel of lateral camera motion at this framing. Small enough that
  // nothing genuinely new comes into view, large enough to flip anything sub-pixel.
  await page.evaluate((cc) => { window.__game.setCamera(cc.x + 0.06, cc.z + 0.06, cc.zoom, cc.yaw); }, c);
  await page.waitForTimeout(700);
  const b = await page.screenshot({ type: 'png' });
  const la = await toLuma(a);
  const lb = await toLuma(b);
  const d = new Float64Array(la.img.length);
  for (let i = 0; i < d.length; i++) d[i] = la.img[i] - lb.img[i];
  const full = rms(d);
  const dd = decim(d, la.w, la.h, 4);
  const low = rms(dd.img);
  const shimmer = low > 1e-9 ? full / low : 0;
  results[name] = { shimmer, full: full * 100, low: low * 100 };
  console.log(name.padEnd(11), shimmer.toFixed(3).padStart(7), (full * 100).toFixed(3).padStart(10), (low * 100).toFixed(3).padStart(8));
  await writeFile(path.join(OUT, `${LABEL}-${name}.png`), a);
}

// --- quality tier switch -----------------------------------------------------
// A CSM rebuild once disposed cascade lights without removing them, every lit shader
// failed to link, and the world rendered grey. Static frames never caught it.
console.log('\n-- tier switch --');
for (const tier of ['high', 'medium', 'ultra']) {
  const r = await page.evaluate(async (t) => {
    const e = window.__game.engine;
    e.setQuality ? e.setQuality(t) : (e.quality = { ...e.quality, tier: t });
    return new Promise((res) => setTimeout(() => {
      const c = document.querySelector('canvas');
      res({ tier: e.quality.tier, aa: e.quality.antialias, w: c.width, h: c.height });
    }, 900));
  }, tier);
  await page.waitForTimeout(400);
  const shot = await page.screenshot({ type: 'png' });
  const l = await toLuma(shot);
  // A grey world after a failed shader link has near-zero spatial variance.
  let mean = 0; for (const v of l.img) mean += v; mean /= l.img.length;
  let va = 0; for (const v of l.img) va += (v - mean) ** 2; va = Math.sqrt(va / l.img.length);
  await writeFile(path.join(OUT, `${LABEL}-tier-${tier}.png`), shot);
  console.log(`  ${tier.padEnd(7)} aa=${String(r.aa).padEnd(5)} canvas=${r.w}x${r.h} meanLuma=${mean.toFixed(3)} sd=${va.toFixed(3)} ${va > 0.03 ? 'OK' : 'SUSPECT-FLAT'}`);
}

console.log('\nerrors: ' + (errs.length ? errs.slice(0, 6).join(' | ') : 'none'));
console.log('JSON ' + JSON.stringify(results));
await browser.close();
