#!/usr/bin/env node
/**
 * QA: the empty-assets fallback.
 *
 * docs/ARCHITECTURE.md §5: "treat a missing file as non-fatal and fall back to a procedural
 * substitute — the game must still run with an empty asset folder." Nobody had tested it.
 *
 * Two ways of taking the assets away, because they fail differently:
 *   1. `--intercept` (default, safe for parallel agents): Playwright aborts every
 *      `/assets/**` request, so `fetch` rejects with a network error.
 *   2. `--move`: `public/assets` is renamed aside for the duration, so vite answers
 *      `/assets/manifest.json` with a 404 and `res.json()` throws a parse error instead.
 *      Restored in a `finally` and on SIGINT/SIGTERM, so an abort cannot leave it moved.
 *
 * Either way the game must boot, run 60 s of battle and render, with zero console errors.
 *
 * Usage: node tools/qa-noassets.mjs [--port=5227] [--move] [--shot=path]
 */

import { chromium } from 'playwright';
import { rename, mkdir } from 'node:fs/promises';
import { existsSync, renameSync, rmdirSync } from 'node:fs';
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
const PORT = Number(args.get('port') ?? 5227);
const MOVE = args.has('move');
const SHOT = args.get('shot') ?? null;

const ASSETS = path.join(ROOT, 'public', 'assets');
const STASH = path.join(ROOT, 'public', '.assets-qa-stash');
let moved = false;

const restore = () => {
  if (moved && existsSync(STASH)) {
    // Synchronous: this also runs from a signal handler, where a promise never settles.
    try {
      // The placeholder empty dir has to go before the rename can land.
      if (existsSync(ASSETS)) rmdirSync(ASSETS);
      renameSync(STASH, ASSETS);
      moved = false;
      console.log('• public/assets restored');
    } catch (e) {
      console.error(`!! FAILED TO RESTORE public/assets — it is at ${STASH}: ${e.message}`);
    }
  }
};
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

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

let server = null;
let browser = null;
let failed = 0;
const fail = (m) => { failed++; console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

try {
  if (MOVE) {
    if (!existsSync(ASSETS)) { console.error('public/assets does not exist — nothing to move'); process.exit(2); }
    if (existsSync(STASH)) { console.error(`${STASH} already exists — refusing to overwrite`); process.exit(2); }
    await rename(ASSETS, STASH);
    moved = true;
    // Keep the directory present but empty: "empty asset folder" is the stated requirement,
    // and an absent parent would also break vite's public dir handling.
    await mkdir(ASSETS, { recursive: true });
    console.log(`• public/assets moved aside to ${path.relative(ROOT, STASH)} (empty dir left in place)`);
  }

  const base = `http://127.0.0.1:${PORT}`;
  if (!(await waitForServer(base, 1200))) {
    server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
      cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
    });
    if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
  }

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const warnings = [];
  const assetRequests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('response', (r) => {
    if (r.url().includes('/assets/')) assetRequests.push({ url: r.url().split('/assets/')[1], status: r.status() });
  });

  if (!MOVE) {
    await page.route('**/assets/**', (route) => route.abort('failed'));
    console.log('• every /assets/** request aborted at the network layer');
  }

  const t0 = Date.now();
  await page.goto(`${base}/?harness=1&quality=high&w=1280&h=720`, { waitUntil: 'domcontentloaded' });
  const booted = await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 })
    .then(() => true).catch(() => false);
  console.log(`• boot ${booted ? 'succeeded' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!booted) {
    const txt = await page.evaluate(() => document.getElementById('load-text')?.textContent ?? '(no loader text)');
    fail(`game did not reach ready with no assets; loader says: "${txt}"`);
  } else {
    pass('game reached window.__game.ready === true with no assets');

    const info = await page.evaluate(() => {
      const g = window.__game;
      g.advance(60);
      g.setCamera(0, 0, 0.4, Math.PI * 1.2);
      g.advance(1);
      const st = g.engine.stats();
      let men = 0;
      for (const u of g.battle.units) if (!u.destroyed) men += u.alive;
      const sky = g.engine.context.tryGet('sky');
      const terr = g.engine.context.tryGet('terrain');
      return {
        simTime: +g.simTime().toFixed(1), men, draws: st.calls, tris: st.tris, textures: st.textures,
        envTexture: !!(sky && sky.environmentTexture),
        heightAtCentre: terr ? +terr.heightAt(0, 0).toFixed(2) : null,
      };
    });
    console.log(`• ran to t+${info.simTime}s: ${info.men} men, ${info.draws} draws, ` +
      `${(info.tris / 1e6).toFixed(2)}M tris, ${info.textures} textures resident`);
    console.log(`  sky.environmentTexture present: ${info.envTexture}; terrain.heightAt(0,0) = ${info.heightAtCentre}`);
    if (info.men < 1000) fail(`only ${info.men} men alive — the scenario did not deploy`);
    if (info.draws === 0 || info.tris === 0) fail('nothing was drawn');
    else pass(`renders procedurally: ${info.draws} draws / ${(info.tris / 1e6).toFixed(2)}M tris`);

    if (SHOT) {
      await page.evaluate(() => { const r = document.getElementById('hud-root'); if (r) r.style.display = 'none'; });
      await page.screenshot({ path: path.resolve(ROOT, SHOT) });
      console.log(`  → ${SHOT}`);
    }
  }

  const byStatus = {};
  for (const r of assetRequests) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`• /assets/ requests observed: ${assetRequests.length} ${JSON.stringify(byStatus)}`);

  if (errors.length === 0) pass('zero console errors and zero uncaught exceptions');
  else fail(`${errors.length} console error(s): ${[...new Set(errors)].slice(0, 8).join(' | ')}`);
  const relevantWarnings = [...new Set(warnings)].filter((w) => /asset|manifest|texture|hdri|load/i.test(w));
  if (relevantWarnings.length) {
    console.log(`  ${relevantWarnings.length} asset-related warning(s) (allowed, but listed):`);
    for (const w of relevantWarnings.slice(0, 10)) console.log(`    ~ ${w}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  restore();
}

console.log(failed ? `\n✗ ${failed} failure(s)` : '\n✓ empty-assets fallback holds');
process.exit(failed ? 1 : 0);
