#!/usr/bin/env node
/**
 * QA: production build parity.
 *
 * Renders the same shot from the vite dev server and from `vite preview` over `dist/`, then
 * compares draw calls, triangle count and the pixels themselves. Also audits every network
 * request the built page makes under `/assets/`, because the build swaps 2K JPEGs for
 * resized WebP and a single 404 there silently drops the game to a procedural fallback that
 * still "works" — which is exactly how a broken deploy passes a smoke test.
 *
 * Usage: node tools/qa-preview.mjs [--devport=5229] [--previewport=4183] [--out=screenshots/qa]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const DEV_PORT = Number(args.get('devport') ?? 5229);
const PREVIEW_PORT = Number(args.get('previewport') ?? 4183);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/qa');
const W = 1280, H = 720;

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html missing — run `npm run build` first');
  process.exit(2);
}

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/** Recursive byte total and file count. */
async function measure(dir) {
  let bytes = 0, files = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { bytes += (await stat(p)).size; files++; }
    }
  };
  if (existsSync(dir)) await walk(dir);
  return { bytes, files };
}

const servers = [];
const start = async (cmd, argv, port, label) => {
  const url = `http://127.0.0.1:${port}`;
  if (await waitForServer(url, 1200)) { console.log(`• reusing ${label} on ${port}`); return url; }
  const p = spawn(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TC_NO_HMR: '1' } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  servers.push(p);
  if (!(await waitForServer(url, 60000))) { console.error(log.slice(-2000)); throw new Error(`${label} did not start`); }
  console.log(`• started ${label} on ${port}`);
  return url;
};

let browser = null;
let failed = 0;
const fail = (m) => { failed++; console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);
const report = {};

try {
  await mkdir(OUT, { recursive: true });

  // ---- payload accounting ----
  const dist = await measure(path.join(ROOT, 'dist'));
  const distAssets = await measure(path.join(ROOT, 'dist', 'assets'));
  const distBundle = await measure(path.join(ROOT, 'dist', 'bundle'));
  const pubAssets = await measure(path.join(ROOT, 'public', 'assets'));
  let mapBytes = 0, mapFiles = 0;
  for (const e of await readdir(path.join(ROOT, 'dist', 'bundle'))) {
    if (e.endsWith('.map')) { mapBytes += (await stat(path.join(ROOT, 'dist', 'bundle', e))).size; mapFiles++; }
  }
  const mb = (b) => (b / 1048576).toFixed(2);
  console.log('\n--- payload ---');
  console.log(`  public/assets (source)   ${mb(pubAssets.bytes).padStart(8)} MiB  ${pubAssets.files} files`);
  console.log(`  dist/assets  (deployed)  ${mb(distAssets.bytes).padStart(8)} MiB  ${distAssets.files} files`);
  console.log(`  dist/bundle              ${mb(distBundle.bytes).padStart(8)} MiB  ${distBundle.files} files ` +
    `(of which ${mb(mapBytes)} MiB in ${mapFiles} source map(s))`);
  console.log(`  dist TOTAL               ${mb(dist.bytes).padStart(8)} MiB  ${dist.files} files`);
  console.log(`  dist without source maps ${mb(dist.bytes - mapBytes).padStart(8)} MiB`);
  report.payload = { pubAssets, distAssets, distBundle, dist, mapBytes, mapFiles };
  if (mapFiles > 0) {
    console.log(`  ! vite.config.ts sets build.sourcemap = true, so ${mb(mapBytes)} MiB of source maps ` +
      `(and the full TypeScript source) are part of the deployed output.`);
  }

  const devBase = await start('npx', ['vite', '--port', String(DEV_PORT), '--host', '127.0.0.1', '--strictPort'], DEV_PORT, 'dev server');
  const prevBase = await start('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--host', '127.0.0.1', '--strictPort'], PREVIEW_PORT, 'preview server');

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });

  /** Boot, park the camera at a fixed shot, screenshot and read renderer stats. */
  async function shoot(base, label) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/assets/')) requests.push({ p: u.pathname.slice(8), status: r.status() });
    });
    await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
    const ok = await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 })
      .then(() => true).catch(() => false);
    if (!ok) {
      const txt = await page.evaluate(() => document.getElementById('load-text')?.textContent ?? null).catch(() => null);
      throw new Error(`${label} did not boot (loader: ${txt}); errors: ${errors.slice(0, 4).join(' | ')}`);
    }
    // Same shot in both: the `wide` viewpoint from tools/shoot.mjs.
    const info = await page.evaluate(() => {
      const g = window.__game;
      g.engine.stop();
      g.advance(2 - g.simTime());
      g.setCamera(0, 90, 0.72, Math.PI * 0.82);
      g.advance(0.25);
      const st = g.engine.stats();
      let men = 0;
      for (const u of g.battle.units) if (!u.destroyed) men += u.alive;
      const sky = g.engine.context.tryGet('sky');
      return {
        simTime: +g.simTime().toFixed(2), men, draws: st.calls, tris: st.tris,
        programs: st.programs, textures: st.textures, geometries: st.geometries,
        env: !!(sky && sky.environmentTexture),
      };
    });
    await page.evaluate(() => { const r = document.getElementById('hud-root'); if (r) r.style.display = 'none'; });
    const file = path.join(OUT, `parity-${label}.png`);
    await page.screenshot({ path: file, type: 'png' });
    await page.close();
    return { info, requests, errors: [...new Set(errors)], file };
  }

  console.log('\n--- dev ---');
  const dev = await shoot(devBase, 'dev');
  console.log(`  t+${dev.info.simTime}s  ${dev.info.men} men  ${dev.info.draws} draws  ` +
    `${(dev.info.tris / 1e6).toFixed(2)}M tris  ${dev.info.textures} textures  env=${dev.info.env}`);
  console.log(`  /assets/ requests: ${dev.requests.length}`);
  if (dev.errors.length) fail(`dev logged ${dev.errors.length} console error(s): ${dev.errors.slice(0, 4).join(' | ')}`);

  console.log('\n--- preview (dist) ---');
  const prev = await shoot(prevBase, 'preview');
  console.log(`  t+${prev.info.simTime}s  ${prev.info.men} men  ${prev.info.draws} draws  ` +
    `${(prev.info.tris / 1e6).toFixed(2)}M tris  ${prev.info.textures} textures  env=${prev.info.env}`);
  if (prev.errors.length) fail(`preview logged ${prev.errors.length} console error(s): ${prev.errors.slice(0, 4).join(' | ')}`);
  else pass('preview booted with zero console errors');

  // ---- asset request audit on the built bundle ----
  const byStatus = {};
  for (const r of prev.requests) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const bad = prev.requests.filter((r) => r.status !== 200 && r.status !== 304);
  const webp = prev.requests.filter((r) => r.p.endsWith('.webp')).length;
  const jpg = prev.requests.filter((r) => /\.(jpe?g|png)$/i.test(r.p)).length;
  const hdr = prev.requests.filter((r) => r.p.endsWith('.hdr')).length;
  console.log(`  /assets/ requests: ${prev.requests.length} ${JSON.stringify(byStatus)} ` +
    `— ${webp} webp, ${jpg} jpg/png, ${hdr} hdr, 1 manifest`);
  report.previewRequests = prev.requests;
  if (bad.length) fail(`${bad.length} asset request(s) did not return 200: ` +
    bad.slice(0, 8).map((r) => `${r.p} → ${r.status}`).join(', '));
  else pass(`every one of the ${prev.requests.length} /assets/ requests returned 200`);
  if (jpg > 0) fail(`${jpg} request(s) for un-optimised jpg/png in the built bundle: ` +
    prev.requests.filter((r) => /\.(jpe?g|png)$/i.test(r.p)).slice(0, 6).map((r) => r.p).join(', '));
  else if (webp > 0) pass(`all ${webp} texture requests are optimised WebP`);

  // ---- parity ----
  console.log('\n--- parity ---');
  const dDraw = prev.info.draws - dev.info.draws;
  const dTris = prev.info.tris - dev.info.tris;
  console.log(`  draws dev ${dev.info.draws} vs preview ${prev.info.draws} (Δ${dDraw})`);
  console.log(`  tris  dev ${dev.info.tris} vs preview ${prev.info.tris} (Δ${dTris}, ` +
    `${(Math.abs(dTris) / Math.max(1, dev.info.tris) * 100).toFixed(2)}%)`);
  console.log(`  textures dev ${dev.info.textures} vs preview ${prev.info.textures}`);
  if (dDraw !== 0) fail(`draw call count differs between dev and the built bundle (Δ${dDraw})`);
  else pass('identical draw call count');
  if (Math.abs(dTris) / Math.max(1, dev.info.tris) > 0.01) fail(`triangle count differs by more than 1% (Δ${dTris})`);
  else pass('triangle count within 1%');
  if (dev.info.env !== prev.info.env) fail(`sky.environmentTexture present in dev=${dev.info.env} but preview=${prev.info.env}`);

  // Pixel comparison. WebP re-encoding at a smaller resolution changes the ground, so this
  // is a "same picture" check, not a bit-exact one.
  const [a, b] = await Promise.all([
    sharp(dev.file).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
    sharp(prev.file).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
  ]);
  let diffPx = 0, sum = 0, maxD = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    sum += d;
    if (d > 24) diffPx++;
    if (d > maxD) maxD = d;
  }
  const px = n / 4;
  const pct = diffPx / px * 100;
  console.log(`  pixels differing by >24/765: ${diffPx}/${px} (${pct.toFixed(2)}%), mean Δ ${(sum / px).toFixed(2)}/765, max Δ ${maxD}`);
  report.pixels = { diffPx, px, pct, meanDelta: sum / px, maxDelta: maxD };
  if (pct > 12) fail(`${pct.toFixed(2)}% of pixels differ materially — the built bundle does not render like dev`);
  else pass(`built bundle renders like dev (${pct.toFixed(2)}% of pixels differ materially)`);

  report.dev = dev.info; report.preview = prev.info;
  await writeFile(path.join(OUT, 'preview-parity.json'), JSON.stringify(report, null, 2));
} catch (err) {
  failed++;
  console.error(`\nFATAL: ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) s.kill('SIGTERM');
}

console.log(failed ? `\n✗ ${failed} failure(s)` : '\n✓ production build parity holds');
process.exit(failed ? 1 : 0);
