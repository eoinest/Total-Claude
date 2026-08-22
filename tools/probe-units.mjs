#!/usr/bin/env node
/**
 * Soldier material probe.
 *
 * Answers, with numbers rather than opinion, the two questions the unit pass keeps
 * guessing at:
 *
 *   1. What colour is a man's mail / tunic / skin / helmet / shield *actually* coming
 *      back off the GPU, in sun and in shadow?
 *   2. Is the soldier material receiving `scene.environment` at all, and what is the
 *      effective IBL gain?
 *
 * The colour question needs per-piece segmentation, which no screenshot gives you. So
 * each group is measured by difference: render the frame normally, render it again with
 * that group's kit bits cleared for every Roman, and take the pixels that moved. Those
 * pixels are that group's and nothing else's — shadows and ground are identical between
 * the two renders, so they cancel. Values are reported as display-linear (the inverse
 * sRGB transfer of the final framebuffer), which is what the eye is judging; the
 * material's own linear base colour is reported separately from the CPU side, because
 * that is the number the rubric's 0.22-0.34 skin band refers to.
 *
 *   node tools/probe-units.mjs --port=5215 --shot=romanline
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
const PORT = Number(args.get('port') ?? 5215);
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const SHOT = String(args.get('shot') ?? 'romanline');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (shot) => {
  const g = window.__game;
  const ctx = g.engine.ctx ?? g.engine.context;
  const b = g.battle;
  const p = b.pool;

  // ---- frame the shot, mirroring tools/shoot.mjs -------------------------
  const want = shot === 'germanhorde' ? 1 : 0;
  const at = 2;
  const need = at - g.simTime();
  if (need > 0) g.advance(need);
  let best = null;
  for (const u of b.units) {
    if (u.destroyed || u.faction !== want || u.alive === 0) continue;
    const cls = b.typeOf(u).unitClass;
    if (want === 0 ? cls !== 'heavy-infantry' : cls !== 'light-infantry') continue;
    if (!best || (want === 0 ? u.z < best.z : u.z > best.z)) best = u;
  }
  g.setCamera(best.x, best.z, 0.36, best.facing + Math.PI + 0.6);
  for (const el of document.querySelectorAll('body > *')) {
    const canvas = ctx.renderer.domElement;
    if (el !== canvas && !el.contains(canvas)) el.style.display = 'none';
  }

  const gl = ctx.renderer.getContext();
  const dw = gl.drawingBufferWidth;
  const dh = gl.drawingBufferHeight;
  const buf = new Uint8Array(dw * dh * 4);

  const render = (n) => {
    for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  };
  render(24);
  // The difference test needs two renders that differ *only* by the kit mask, so every
  // temporal effect has to go: TAA jitters the raster by a Halton offset and blends 88% of
  // last frame, motion blur keeps its own history, and any advancing clock moves dust,
  // grass and 8,900 playheads. Stepping with dt = 0 freezes the clock; dropping to no AA
  // removes the jitter and the history.
  ctx.quality.antialias = 'none';
  ctx.quality.motionBlur = false;
  const freeze = (n) => {
    for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000);
  };
  const grab = () => {
    freeze(3);
    ctx.renderer.setRenderTarget(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(dw * dh * 4);
    gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const toLin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  // ---- environment sanity ------------------------------------------------
  let soldierMat = null;
  ctx.scene.traverse((o) => {
    if (!soldierMat && o.isMesh && /^soldiers-.*lod0/.test(o.name || '')) soldierMat = o.material;
  });
  const env = {
    sceneEnvironment: !!ctx.scene.environment,
    environmentIntensity: ctx.scene.environmentIntensity,
    matEnvMapIntensity: soldierMat ? soldierMat.envMapIntensity : null,
    matEnvMap: soldierMat ? !!soldierMat.envMap : null,
    effectiveGain: soldierMat ? soldierMat.envMapIntensity * ctx.scene.environmentIntensity : null,
    metalness: soldierMat ? soldierMat.metalness : null,
    roughness: soldierMat ? soldierMat.roughness : null,
    aoMapIntensity: soldierMat ? soldierMat.aoMapIntensity : null,
    toneMapping: ctx.renderer.toneMapping,
    exposure: ctx.renderer.toneMappingExposure,
  };

  // ---- per-piece segmentation -------------------------------------------
  const ur = ctx.get('unitRender');
  const bitLo = (n) => 2 ** n;
  const GROUPS = {
    // Piece ids from src/units/kit.ts.
    helmet: { lo: bitLo(4) | bitLo(5) | bitLo(6) | bitLo(7), hi: 0 },
    armour: { lo: bitLo(16) | bitLo(17) | bitLo(18) | bitLo(19), hi: 0 },
    tunic: { lo: bitLo(13), hi: 0 },
    skinHead: { lo: bitLo(0), hi: 0 },
    skinLegs: { lo: bitLo(20), hi: 0 },
    shield: { lo: 0, hi: bitLo(0) | bitLo(1) | bitLo(2) },
  };

  const saveLo = ur.kitLo.slice();
  const saveHi = ur.kitHi.slice();
  const saveMel = ur.kitHiMelee.slice();
  const saveCoarse = ur.kitCoarse.slice();

  const baseline = grab();

  const stats = {};
  for (const [name, mask] of Object.entries(GROUPS)) {
    for (let i = 0; i < p.count; i++) {
      if (p.faction[i] !== want) continue;
      ur.kitLo[i] = saveLo[i] & ~mask.lo;
      ur.kitHi[i] = saveHi[i] & ~mask.hi;
      ur.kitHiMelee[i] = saveMel[i] & ~mask.hi;
      // LOD2's coarse mask is deliberately left alone: its eight silhouette groups do not
      // line up with the fine pieces, and an unchanged far tier cancels out of the
      // difference instead of contaminating it. The measurement is therefore of the
      // LOD0/LOD1 men, which is where the frame is being judged anyway.
    }
    const off = grab();
    ur.kitLo.set(saveLo);
    ur.kitHi.set(saveHi);
    ur.kitHiMelee.set(saveMel);
    ur.kitCoarse.set(saveCoarse);

    // Pixels the group actually painted.
    const lum = [];
    const rgb = [];
    for (let k = 0; k < dw * dh; k++) {
      const o = k * 4;
      const d = Math.abs(baseline[o] - off[o]) + Math.abs(baseline[o + 1] - off[o + 1]) +
        Math.abs(baseline[o + 2] - off[o + 2]);
      if (d < 24) continue;
      const r = toLin(baseline[o]);
      const gch = toLin(baseline[o + 1]);
      const bch = toLin(baseline[o + 2]);
      const l = 0.2126 * r + 0.7152 * gch + 0.0722 * bch;
      lum.push(l);
      rgb.push([r, gch, bch, l]);
    }
    if (rgb.length < 200) { stats[name] = { px: rgb.length, note: 'too few pixels' }; continue; }
    rgb.sort((a, c) => a[3] - c[3]);
    const bandMean = (a, bnd) => {
      const lo = Math.floor(rgb.length * a);
      const hi = Math.floor(rgb.length * bnd);
      let r = 0, gg = 0, bb = 0;
      for (let k = lo; k < hi; k++) { r += rgb[k][0]; gg += rgb[k][1]; bb += rgb[k][2]; }
      const n = Math.max(1, hi - lo);
      return [r / n, gg / n, bb / n];
    };
    const fmt = (v) => v.map((x) => Number(x.toFixed(4)));
    stats[name] = {
      px: rgb.length,
      coverage: Number((rgb.length / (dw * dh) * 100).toFixed(2)),
      shadow: fmt(bandMean(0.08, 0.28)),
      mid: fmt(bandMean(0.4, 0.6)),
      sun: fmt(bandMean(0.78, 0.96)),
      p05: Number(rgb[Math.floor(rgb.length * 0.05)][3].toFixed(4)),
      p50: Number(rgb[Math.floor(rgb.length * 0.5)][3].toFixed(4)),
      p95: Number(rgb[Math.floor(rgb.length * 0.95)][3].toFixed(4)),
    };
  }

  // ---- IBL A/B: what does the environment actually contribute? ----------
  const lumOf = (px) => {
    let s = 0;
    for (let k = 0; k < dw * dh; k++) {
      const o = k * 4;
      s += 0.2126 * toLin(px[o]) + 0.7152 * toLin(px[o + 1]) + 0.0722 * toLin(px[o + 2]);
    }
    return s / (dw * dh);
  };
  const savedEnvI = ctx.scene.environmentIntensity;
  ctx.scene.environmentIntensity = 0;
  const noEnv = lumOf(grab());
  ctx.scene.environmentIntensity = savedEnvI;
  const withEnv = lumOf(baseline);

  // ---- CPU-side base colours -------------------------------------------
  // Sampled off the pool so the numbers describe the men actually in frame.
  const swatch = [];
  for (let i = 0; i < p.count && swatch.length < 12; i++) {
    if (p.faction[i] !== want || p.state[i] > 9) continue;
    swatch.push({
      variant: Number(p.variant[i].toFixed(4)),
      tunic: [ur.kitTunic[i * 3], ur.kitTunic[i * 3 + 1], ur.kitTunic[i * 3 + 2]].map((v) => Number(v.toFixed(3))),
      leg: [ur.kitLeg[i * 3], ur.kitLeg[i * 3 + 1], ur.kitLeg[i * 3 + 2]].map((v) => Number(v.toFixed(3))),
      metal: Number(ur.kitMetal[i].toFixed(3)),
      emblem: ur.kitEmblem[i],
    });
  }

  // ---- soldier draw calls and triangles, isolated from the rest of the frame ----
  // Read off `renderer.info` with everything else hidden rather than derived from instance
  // counts: the authoritative number is what the driver was actually asked to draw, shadow
  // cascades included.
  ctx.quality.antialias = 'taa';
  render(4);
  const hidden = [];
  ctx.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
    if (/^soldiers|^horses/.test(o.name || '')) return;
    if (o.visible) { o.visible = false; hidden.push(o); }
  });
  render(2);
  const info = ctx.renderer.info.render;
  const soldier = { draws: info.calls, tris: info.triangles, meshes: [] };
  ctx.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (!/^soldiers|^horses/.test(o.name || '')) return;
    const n = o.geometry.instanceCount ?? 1;
    const idx = o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count;
    soldier.meshes.push({ name: o.name, instances: n, trisEach: idx / 3 });
  });
  for (const o of hidden) o.visible = true;

  const stat = g.engine.stats();
  return {
    env,
    stats,
    ibl: { withEnv: Number(withEnv.toFixed(4)), noEnv: Number(noEnv.toFixed(4)) },
    swatch,
    soldier,
    draws: stat.calls,
    tris: stat.triangles,
  };
}, SHOT);

console.log(JSON.stringify(out, null, 2));

await browser.close();
if (server) server.kill('SIGTERM');
