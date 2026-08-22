#!/usr/bin/env node
/**
 * Where the draw calls go, split shadow / colour / post, and per cascade.
 *
 * `tools/probe-draws.mjs` reports a whole-frame `renderer.info.render.calls` and attributes
 * scene-graph meshes by hand-rolled frustum test. That answers "which subsystem" for the
 * *colour* pass and says nothing at all about the shadow pass, which is the claim under
 * test here: that 81 of 204 draws at the Rome assault camera are cascade re-draws.
 *
 * The split is taken from the real frame, not reconstructed:
 *   - `renderer.info.autoReset` is already false and `Engine.frame` resets once per frame,
 *     so `info.render.calls` accumulates shadow + colour + post across the whole frame.
 *   - `renderer.shadowMap.render` is wrapped to snapshot the counter either side of it.
 *   - `renderer.render` is wrapped the same way; the scene render contains the shadow
 *     render, so colour = (render delta) - (shadow delta).
 *   - post = (frame total) - colour - shadow.
 *
 * Per-cascade attribution uses three's own early-out at WebGLShadowMap.js:170
 * (`shadow.autoUpdate === false && shadow.needsUpdate === false` -> `continue`), which
 * skips one light's shadow render without touching any material define. Disabling all but
 * cascade i and re-reading the counter gives that cascade's own draw count, with no
 * recompile and no change to `NUM_DIR_LIGHT_SHADOWS`.
 *
 * Cameras are read from a `shoot.mjs` `report.json` so the frame is a *named* camera that
 * harness already resolved, never a hand-placed one.
 *
 *   node tools/scratch/gpucost-attrib.mjs --port=5921 \
 *     --report=screenshots/gpucost-base/report.json --shots=ab-rome-wall,ab-carth-wall
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const REPORT = path.resolve(ROOT, args.get('report') ?? 'screenshots/gpucost-base/report.json');
const WANT = String(args.get('shots') ?? 'ab-rome-wall,ab-carth-wall').split(',');

/** The per-shot scene config, mirroring shoot.mjs's own `SHOTS` entries for these names. */
const SCENE = {
  'ab-rome-wall': { scenario: 'assault', timeOfDay: 14.3 },
  'ab-carth-wall': { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 },
  'ab-rome-parapet': { scenario: 'assault', timeOfDay: 11.0 },
  'ab-carth-parapet': { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 12.2 },
};

const tree = (() => {
  const g = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '?'; } };
  return { head: g(['rev-parse', '--short', 'HEAD']), dirty: g(['diff', 'HEAD', '--shortstat', '--', 'src/']) || 'clean' };
})();
const loadAvg = () => {
  try {
    const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};

const rep = JSON.parse(await readFile(REPORT, 'utf8'));
const shotsInReport = new Map((rep.shots ?? rep.results ?? []).map((s) => [s.name, s]));

const base = `http://127.0.0.1:${PORT}`;
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}

const battleToken = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

console.log(`# ${tree.head} (${tree.dirty})  ${W}x${H} ${QUALITY} dpr1  load ${loadAvg()}`);

for (const name of WANT) {
  const cfg = SCENE[name];
  const rec = shotsInReport.get(name);
  if (!cfg || !rec) { console.error(`skip ${name}: no scene config or no report entry`); continue; }

  const url = `${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${battleToken(cfg)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

  const out = await page.evaluate(async (a) => {
    const g = window.__game;
    const eng = g.engine;
    const ctx = eng.context ?? eng.ctx;
    const renderer = ctx.renderer;

    // Same sim moment and the same camera the named shot resolved to.
    g.advance(a.at);
    g.setCamera(a.x, a.z, a.zoom, a.yaw);
    for (let i = 0; i < 4; i++) eng.frame(eng.time.elapsed * 1000 + 16.7);

    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // ---- split the frame ------------------------------------------------
    const info = renderer.info;
    let shadowDraws = 0, renderDraws = 0;
    const sm = renderer.shadowMap;
    const origShadow = sm.render.bind(sm);
    sm.render = (...z) => { const b = info.render.calls; origShadow(...z); shadowDraws += info.render.calls - b; };
    const origRender = renderer.render.bind(renderer);
    renderer.render = (...z) => { const b = info.render.calls; origRender(...z); renderDraws += info.render.calls - b; };

    shadowDraws = 0; renderDraws = 0;
    eng.frame(eng.time.elapsed * 1000 + 16.7);
    sync();
    const total = info.render.calls;
    const tris = info.render.triangles;
    const split = { total, tris, shadow: shadowDraws, colour: renderDraws - shadowDraws, post: total - renderDraws };

    // ---- per cascade ----------------------------------------------------
    const lighting = ctx.tryGet('lighting');
    const csm = lighting && lighting.csm;
    const perCascade = [];
    let cascadeInfo = null;
    if (csm && csm.lights) {
      cascadeInfo = {
        count: csm.lights.length,
        mapSize: csm.shadowMapSize,
        breaks: (csm.breaks ?? []).slice ? [...csm.breaks] : null,
        maxFar: csm.maxFar,
      };
      const lights = csm.lights;
      for (let i = 0; i < lights.length; i++) {
        for (let j = 0; j < lights.length; j++) {
          lights[j].shadow.autoUpdate = j === i;
          lights[j].shadow.needsUpdate = j === i;
        }
        shadowDraws = 0;
        eng.frame(eng.time.elapsed * 1000 + 16.7);
        sync();
        perCascade.push(shadowDraws);
      }
      for (const l of lights) { l.shadow.autoUpdate = true; l.shadow.needsUpdate = false; }
    }

    // ---- who casts, and who ignores the per-cascade frustum -------------
    const casters = [];
    ctx.scene.traverse((o) => {
      if (!o.castShadow) return;
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      let vis = true, n = o;
      while (n) { if (!n.visible) { vis = false; break; } n = n.parent; }
      if (!vis) return;
      if (o.isInstancedMesh && o.count === 0) return;
      const geo = o.geometry;
      const idx = geo?.index;
      const pos = geo?.attributes?.position;
      let t = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
      const inst = o.isInstancedMesh ? o.count : (geo?.instanceCount ?? 1);
      if (Number.isFinite(inst)) t *= inst;
      let top = o; while (top.parent && top.parent !== ctx.scene) top = top.parent;
      casters.push({
        name: o.name || o.type,
        top: top.name || top.type,
        frustumCulled: !!o.frustumCulled,
        instanced: !!o.isInstancedMesh,
        count: o.isInstancedMesh ? o.count : (geo?.instanceCount ?? 1),
        tris: Math.round(t),
      });
    });

    // ---- LOD / impostor state ------------------------------------------
    const units = ctx.tryGet('units');
    const cam = ctx.camera;
    const lod = units ? {
      lodDist: units.lodDist ? [...units.lodDist] : null,
      lodFarDistance: ctx.quality.lodFarDistance,
      camFovNow: cam.fov,
      viewH: ctx.viewH,
      zoom: ctx.rig.zoom,
      orbitRadius: ctx.rig.orbitRadius,
      tierCounts: (() => {
        const r = {};
        ctx.scene.traverse((o) => {
          if (o.isInstancedMesh && /soldier|horse|impostor|elephant/i.test(o.name || '') && o.count > 0) {
            r[o.name] = o.count;
          }
        });
        return r;
      })(),
    } : null;

    let men = 0, units2 = 0;
    for (const u of g.battle.units) if (!u.destroyed) { units2++; men += u.alive; }

    return {
      split, perCascade, cascadeInfo, lod, men, units: units2,
      simTime: g.simTime(),
      quality: {
        tier: ctx.quality.tier, shadowMapSize: ctx.quality.shadowMapSize,
        shadowCascades: ctx.quality.shadowCascades, motionBlur: ctx.quality.motionBlur,
        depthOfField: ctx.quality.depthOfField, ssao: ctx.quality.ssao,
        volumetricLight: ctx.quality.volumetricLight, bloom: ctx.quality.bloom,
        renderScale: ctx.quality.renderScale, maxPixelRatio: ctx.quality.maxPixelRatio,
      },
      casters: casters.sort((x, y) => y.tris - x.tris),
    };
  }, { at: rec.simTime ?? 170, x: rec.focusX, z: rec.focusZ, zoom: rec.zoom ?? 0.46, yaw: rec.yaw });

  console.log(`\n=== ${name} === t+${Math.round(out.simTime)}s  ${out.men} men / ${out.units} units`);
  console.log(`  quality: ${JSON.stringify(out.quality)}`);
  const s = out.split;
  console.log(`  draws ${s.total}  = shadow ${s.shadow} + colour ${s.colour} + post ${s.post}`
    + `   (shadow ${(100 * s.shadow / s.total).toFixed(0)}%)   tris ${(s.tris / 1e6).toFixed(2)}M`);
  console.log(`  cascades: ${JSON.stringify(out.cascadeInfo)}`);
  console.log(`  per-cascade draws: ${out.perCascade.join(' / ')}  (sum ${out.perCascade.reduce((a, b) => a + b, 0)})`);
  console.log(`  lod: ${JSON.stringify(out.lod)}`);
  const uncull = out.casters.filter((c) => !c.frustumCulled);
  console.log(`  shadow casters: ${out.casters.length}  (frustumCulled=false: ${uncull.length})`);
  for (const c of out.casters.slice(0, 18)) {
    console.log(`    ${c.frustumCulled ? ' ' : '!'} ${String(c.tris).padStart(9)}t  x${String(c.count).padStart(5)}  ${c.top.padEnd(20)} ${c.name}`);
  }
}

if (pageErrors.length) {
  console.error(`\npageerror x${pageErrors.length}:`);
  for (const e of [...new Set(pageErrors)].slice(0, 10)) console.error(`  ${e}`);
}
await browser.close();
if (server) server.kill('SIGTERM');
