#!/usr/bin/env node
/**
 * Count the geometry, and re-derive the draw-call reference points, at one stated SHA.
 *
 * Two questions the published figures cannot currently answer, because three documents give
 * three different numbers for each and none of them names its camera:
 *
 *  1. **How many triangles is a soldier, per faction, per LOD?** Read off the live
 *     `InstancedBufferGeometry` (`index.count / 3`), which is the number the rasteriser is
 *     actually handed, independent of how many instances happen to be in the buffer.
 *  2. **How many draws is "the assault camera"?** Reported at *both* framings that go by that
 *     name — `probe-budget.mjs`'s boot framing (no `setCamera` at all) and `shoot.mjs`'s
 *     resolved `ab-*-wall` — because they are different places and disagree by ~20 draws.
 *
 * The draw split is taken from the real frame: `renderer.shadowMap.render` and
 * `renderer.render` are wrapped, and the scene pass is distinguished from a post blit by
 * whether its first argument is the world scene (`FullScreenQuad.render` also goes through
 * `renderer.render`).
 *
 *   node tools/scratch/gpucost-census.mjs --port=5921
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920), H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const AT = Number(args.get('at') ?? 170);

const SCENES = {
  rome: { cfg: { scenario: 'assault', timeOfDay: 14.3 }, wall: { x: 166, z: 435, zoom: 0.46, yaw: -0.53 } },
  carthage: { cfg: { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 }, wall: { x: 62, z: 433, zoom: 0.46, yaw: -0.49 } },
};

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['diff', 'HEAD', '--shortstat', '--', 'src/'], { cwd: ROOT, encoding: 'utf8' }).trim() || 'clean';
const load = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/)[1]; } catch { return '?'; } };

const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch {} await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) throw new Error('vite did not start');
}
const token = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

console.log(`# ${head} (${dirty})  ${W}x${H} ${QUALITY} dpr1  load ${load()}`);

const ONLY = args.get('only') ?? '';
for (const [name, sc] of Object.entries(SCENES)) {
  if (ONLY && name !== ONLY) continue;
  await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${token(sc.cfg)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

  const out = await page.evaluate(async (a) => {
    const g = window.__game, ctx = g.engine.context ?? g.engine.ctx, r = ctx.renderer, info = r.info;
    g.engine.stop();
    const acc = { shadow: 0, scene: 0, quad: 0 };
    const sm = r.shadowMap, os = sm.render.bind(sm);
    sm.render = (...z) => { const b = info.render.calls; os(...z); acc.shadow += info.render.calls - b; };
    const orr = r.render.bind(r);
    r.render = (...z) => { const b = info.render.calls; orr(...z); const d = info.render.calls - b; if (z[0] === ctx.scene) acc.scene += d; else acc.quad += d; };
    const gl = r.getContext(), px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const frame = () => g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
    const split = () => { acc.shadow = 0; acc.scene = 0; acc.quad = 0; frame(); sync(); const t = info.render.calls; return { draws: t, tris: info.render.triangles, shadow: acc.shadow, colour: acc.scene - acc.shadow, post: acc.quad }; };
    const men = () => { let m = 0, u = 0; for (const x of g.battle.units) if (!x.destroyed) { u++; m += x.alive; } return { men: m, units: u }; };

    // --- boot framing, the camera probe-budget.mjs calls "the assault camera" -------
    const bootCam = { x: ctx.rig.focus.x, z: ctx.rig.focus.z, zoom: ctx.rig.zoom, yaw: ctx.rig.yaw };
    for (let i = 0; i < 4; i++) frame();
    const boot0 = { ...split(), ...men(), simTime: g.simTime() };

    // --- geometry census: per-instance triangles off the live buffers ---------------
    const census = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!/soldier|horse|elephant|impostor|scorpio|onager|siege/i.test(o.name || '')) return;
      const gm = o.geometry, idx = gm.index, pos = gm.attributes?.position;
      const tris = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
      census.push({ name: o.name, tris, inst: o.isInstancedMesh ? o.count : (gm.instanceCount ?? 1) });
    });

    // --- advance, then both cameras -------------------------------------------------
    g.advance(a.at);
    for (let i = 0; i < 4; i++) frame();
    g.setCamera(bootCam.x, bootCam.z, bootCam.zoom, bootCam.yaw);
    for (let i = 0; i < 8; i++) frame();
    const bootLate = { ...split(), ...men(), simTime: g.simTime() };

    g.setCamera(a.wall.x, a.wall.z, a.wall.zoom, a.wall.yaw);
    for (let i = 0; i < 60; i++) frame();
    const wall = { ...split(), ...men(), simTime: g.simTime() };
    const census2 = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!/soldier|horse|elephant|impostor/i.test(o.name || '')) return;
      const gm = o.geometry, idx = gm.index;
      census2.push({ name: o.name, tris: idx ? idx.count / 3 : 0, inst: gm.instanceCount ?? (o.count ?? 1) });
    });
    return { bootCam, boot0, bootLate, wall, census, census2 };
  }, { at: AT, wall: sc.wall });

  console.log(`\n=== ${name} (assault) ===`);
  console.log(`  boot framing: x ${out.bootCam.x.toFixed(0)} z ${out.bootCam.z.toFixed(0)} zoom ${out.bootCam.zoom.toFixed(2)} yaw ${out.bootCam.yaw.toFixed(2)}`);
  const row = (lbl, s) => console.log(`  ${lbl.padEnd(26)} t+${String(Math.round(s.simTime)).padStart(3)}s ${String(s.men).padStart(5)} men  `
    + `draws ${String(s.draws).padStart(4)} = ${String(s.shadow).padStart(3)} shadow + ${String(s.colour).padStart(3)} colour + ${String(s.post).padStart(2)} post`
    + `   ${(s.tris / 1e6).toFixed(2)}M tris`);
  row('boot framing, t+0', out.boot0);
  row(`boot framing, t+${AT}`, out.bootLate);
  row(`ab-${name === 'rome' ? 'rome' : 'carth'}-wall`, out.wall);
  console.log('  --- per-instance triangles (index.count/3), live buffers ---');
  const seen = new Set();
  for (const c of out.census.concat(out.census2)) {
    if (seen.has(c.name)) continue; seen.add(c.name);
    console.log(`    ${c.name.padEnd(30)} ${String(c.tris).padStart(6)} tris/instance`);
  }
}
console.log(errs.length ? `\npageerror/console: ${errs.length}\n  ` + [...new Set(errs)].slice(0, 8).join('\n  ') : '\nno pageerror, no console error.');
console.log(`# load at end ${load()}`);
await browser.close();
if (server) server.kill('SIGTERM');
