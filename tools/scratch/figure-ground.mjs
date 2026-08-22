/**
 * Throwaway: a true top-down plate of the fabric, for figure-ground grading against the
 * AGEA orthophoto.
 *
 * `plan.ts` draws *footprints* as SVG, which cannot answer the question a figure-ground asks
 * — how much of the ground between street lines is under a roof — because a perimeter block's
 * footprint is the whole block, courtyard included. This photographs the actual geometry from
 * directly overhead with an orthographic camera, so what is measured is roof.
 *
 *   TC_NO_HMR=1 node tools/scratch/figure-ground.mjs --port=5893 --cx=300 --cz=780 --span=1200
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5893);
const CX = Number(args.get('cx') ?? 300);
const CZ = Number(args.get('cz') ?? 780);
const SPAN = Number(args.get('span') ?? 1200);      // metres across the frame
const PX = Number(args.get('px') ?? 1000);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/plan');
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) { server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } }); if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); } }

await mkdir(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let code = 0;
try {
  const p = await b.newPage({ viewport: { width: PX, height: PX }, deviceScaleFactor: 1 });
  p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text()); });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto(`${base}/?harness=1&w=${PX}&h=${PX}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try { await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 }); }
  catch (e) { console.log('NOT READY:', e.message.split('\n')[0]); code = 1; }

  if (!code) {
    const info = await p.evaluate(async ({ cx, cz, span, px }) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const g = window.__game.engine;
      const r = g.renderer;
      const scene = g.scene;
      // Straight down, orthographic, so the plate is a plan and not a perspective.
      const cam = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 4000);
      cam.position.set(cx, 1500, cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(cx, 0, cz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      // Force every LOD to its full level: a plan shot from 1.5 km would otherwise
      // photograph the far silhouettes and grade the wrong geometry.
      const city = g.ctx?.get ? g.ctx.get('city') : g.byName?.get('city');
      if (city && city.debugForceLod) city.debugForceLod(0);
      r.setSize(px, px, false);
      r.render(scene, cam);
      // Read the canvas back **in the same synchronous block as the render**. A
      // `page.screenshot()` lands a frame or more later, by which time the game's own
      // RAF loop has re-rendered its perspective view over the top — which is exactly
      // what the first attempt photographed, HUD and all.
      const url = r.domElement.toDataURL('image/png');
      return { mPerPx: span / px, draws: r.info.render.calls, forced: !!(city && city.debugForceLod), url };
    }, { cx: CX, cz: CZ, span: SPAN, px: PX });
    const name = `ours-plan-cx${CX}-cz${CZ}-span${SPAN}.png`;
    console.log(JSON.stringify({ ...info, url: `${info.url.length} bytes` }));
    await writeFile(path.join(OUT, name), Buffer.from(info.url.split(',')[1], 'base64'));
    console.log(`wrote ${path.join(OUT, name)}  (${info.mPerPx.toFixed(3)} m/px)`);
  }
} finally { await b.close(); if (server) server.kill('SIGTERM'); }
process.exit(code);
