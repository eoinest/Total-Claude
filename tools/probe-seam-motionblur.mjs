#!/usr/bin/env node
/**
 * Probe: does camera motion blur actually run, on the tiers that ask for it?
 *
 * The claim under test is that it never has. `PostFX.render` gated the pass on
 * `historyValid`, which is written in exactly one place — inside the `q.antialias === 'taa'`
 * branch of the anti-aliasing step — and no `QUALITY_PRESETS` entry selects `taa`: low is
 * `fxaa` and medium, high and ultra are `smaa`. So `motionBlur: true` at high and ultra, and
 * every `dropMotionBlur` rung in `AdaptiveQuality`'s envelopes, gated a pass that could not
 * execute.
 *
 * Three measurements, per tier, with the camera panning the whole time:
 *
 *   1. `historyValid` — the old gate. If this is false for the whole run then the old code
 *      could not have blurred a frame, whatever the preset said.
 *   2. `motionBlurFrames` — the new gate, counted at the blit itself.
 *   3. Pixels. The same frame rendered with `motionBlur` on and off, differenced. A counter
 *      that increments proves the branch was taken; only pixels prove it did something.
 *
 * Usage: node tools/probe-seam-motionblur.mjs [--port=5385] [--tiers=low,high,ultra]
 *                                             [--frames=600] [--json=path]
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5385);
const TIERS = (args.get('tiers') ?? 'low,medium,high,ultra').split(',');
const FRAMES = Number(args.get('frames') ?? 600);
const JSON_OUT = args.get('json') ?? null;

const waitForServer = async (b, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(b, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; }
    catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  console.log(`• starting vite on ${PORT}`);
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }
} else console.log(`• reusing dev server on ${PORT}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const rows = [];
for (const tier of TIERS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const log = [];
  page.on('console', (m) => log.push(m.text()));
  page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
  const url = `${base}/?harness=1&quality=${tier}&w=1280&h=720&scenario=assault`;
  console.log(`\n=== ${tier} ===`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });

  const row = await page.evaluate(async ([n]) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const post = ctx.tryGet('postfx');
    const q = ctx.quality;
    const out = { tier: q.tier, antialias: q.antialias, motionBlurSetting: !!q.motionBlur };
    post.debugResetPasses();
    // Pan the whole time: a still camera has no velocity and the pass would correctly do
    // nothing. `jumpTo` per frame, then one synthetic frame, so the reprojection has
    // something to reproject.
    const r = g.engine.rig;
    const x0 = r.target ? r.target.x : 0;
    const z0 = r.target ? r.target.z : 0;
    let historyEverValid = false;
    for (let i = 0; i < n; i++) {
      g.setCamera(x0 + i * 0.6, z0 + i * 0.35, 140, 0.6 + i * 0.0015);
      g.advance(1 / 60);
      if (post.debugPasses().historyValid) historyEverValid = true;
    }
    const p = post.debugPasses();
    out.frames = p.frames;
    out.motionBlurFrames = p.motionBlurFrames;
    out.prevViewProjValid = p.prevViewProjValid;
    out.historyEverValid = historyEverValid;
    out.motionBlurMaterial = p.motionBlurMaterial;
    return out;
  }, [FRAMES]);

  /*
   * Pixels, with a control.
   *
   * A bare "are the two frames different" is worthless here: the final pass stirs grain with
   * `uTime`, so two frames of the *same* settings differ too. So three shots — blur off,
   * blur off again, blur on — and the question is whether MAD(off, on) stands clear of
   * MAD(off, off). Each shot re-runs the same two-frame camera schedule from the same place,
   * so the reprojection has the same velocity every time.
   */
  // The clock is stopped for this arm. Otherwise the control pair differs by two ticks of
  // 2 500 men marching, which is far larger than the effect being measured and would bury it.
  await page.evaluate(() => { window.__game.engine.time.paused = true; });
  const shot = async (on) => {
    await page.evaluate(async (want) => {
      const g = window.__game;
      g.engine.context.quality.motionBlur = want;
      g.setCamera(0, 0, 140, 0.6);
      g.advance(1 / 60);
      g.setCamera(60, 34, 140, 0.66);
      g.advance(1 / 60);
    }, on);
    return page.screenshot({ type: 'png' });
  };
  const off1 = await shot(false);
  const off2 = await shot(false);
  const on = await shot(true);
  const grey = async (buf) => {
    const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    return data;
  };
  /*
   * Two statistics, because grain and blur live at different amplitudes. MAD is dominated by
   * the grain, which touches every pixel by a level or two; `pctOver8` counts pixels that
   * moved by more than 8 of 255, which grain does not do and a smear across a contrast edge
   * does. The second is the one that separates them.
   */
  const stats = (a, b) => {
    let s = 0, over = 0, max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      s += d; if (d > 8) over++; if (d > max) max = d;
    }
    return { mad: +(s / a.length).toFixed(4), pctOver8: +((100 * over) / a.length).toFixed(3), max };
  };
  const [g1, g2, g3] = await Promise.all([grey(off1), grey(off2), grey(on)]);
  row.control = stats(g1, g2);
  row.blur = stats(g1, g3);
  row.pageerrors = log.filter((l) => l.startsWith('PAGEERROR')).length;
  await page.evaluate(() => { window.__game.engine.time.paused = false; });

  console.log(JSON.stringify(row));
  rows.push(row);
  await page.close();
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
await browser.close();
if (server) server.kill('SIGTERM');
