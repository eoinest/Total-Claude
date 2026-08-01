#!/usr/bin/env node
/**
 * Draw-call attribution probe.
 *
 * Renders each named camera and reports, per top-level scene node, how many meshes were
 * actually submitted and how many triangles they carried. The screenshot harness prints
 * a single whole-frame number; when that number is over budget the only useful question
 * is *which subsystem owns it*, and this answers that without guessing.
 *
 * Not part of the graded output — a diagnostic for the terrain/city agents.
 *
 *   node tools/probe-draws.mjs --port=5213 --shots=city,wall,skyline
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const SHOTS = {
  wide: { x: 0, z: 90, zoom: 0.95, yaw: Math.PI * 0.82 },
  city: { x: 60, z: 400, zoom: 0.62, yaw: 0.0 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
  skyline: { x: -180, z: 780, zoom: 0.8, yaw: Math.PI * 0.05 },
  deepcity: { x: -20, z: 1050, zoom: 0.86, yaw: Math.PI * 0.1 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4 },
  romanline: { x: -20, z: 128, zoom: 0.16, yaw: Math.PI * 1.42 },
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5213);
const requested = args.get('shots')
  ? String(args.get('shots')).split(',')
  : ['city', 'wall', 'skyline'];

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
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?harness=1&quality=ultra&w=1600&h=900`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 120000 });

for (const name of requested) {
  const s = SHOTS[name];
  if (!s) continue;
  const out = await page.evaluate(
    async ({ s }) => {
      const g = window.__game;
      g.setCamera(s.x, s.z, s.zoom, s.yaw);
      g.advance(0.3);
      const eng = g.engine;
      const scene = eng.ctx.scene;
      const cam = eng.ctx.camera;
      const renderer = eng.ctx.renderer;

      // Attribute each rendered mesh to the top-level ancestor it hangs from, which is
      // one per subsystem in this scene graph.
      const THREEfrustum = renderer.__probeFrustum ?? {};
      void THREEfrustum;
      const counts = new Map();
      const owner = (o) => {
        let n = o;
        while (n.parent && n.parent !== scene) n = n.parent;
        return n.name || n.type;
      };

      // Build the frustum by hand from the camera matrices so we do not need to import
      // three here.
      cam.updateMatrixWorld();
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
      const e = m.elements;
      const planes = [];
      const add = (a, b, c, d) => {
        const l = Math.hypot(a, b, c) || 1;
        planes.push([a / l, b / l, c / l, d / l]);
      };
      add(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
      add(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
      add(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
      add(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
      add(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
      add(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);

      const visibleChain = (o) => {
        let n = o;
        while (n) {
          if (!n.visible) return false;
          n = n.parent;
        }
        return true;
      };

      scene.traverse((o) => {
        if (!o.isMesh && !o.isLine && !o.isPoints) return;
        if (!visibleChain(o)) return;
        if (o.isInstancedMesh && o.count === 0) return;
        if (o.frustumCulled && o.geometry?.boundingSphere) {
          o.updateWorldMatrix(true, false);
          const c = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
          const sc = o.matrixWorld.getMaxScaleOnAxis();
          const r = o.geometry.boundingSphere.radius * sc;
          let out = false;
          for (const p of planes) {
            if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r) {
              out = true;
              break;
            }
          }
          if (out) return;
        }
        const key = owner(o);
        const idx = o.geometry?.index;
        const pos = o.geometry?.attributes?.position;
        let tris = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
        if (o.isInstancedMesh) tris *= o.count;
        const rec = counts.get(key) ?? { draws: 0, tris: 0, names: {} };
        rec.draws += 1;
        rec.tris += tris;
        rec.names[o.name || o.type] = (rec.names[o.name || o.type] ?? 0) + 1;
        counts.set(key, rec);
      });

      const city = eng.ctx.tryGet ? eng.ctx.tryGet('city') : null;
      return {
        rows: [...counts.entries()]
          .map(([k, v]) => ({ k, draws: v.draws, tris: Math.round(v.tris), names: v.names }))
          .sort((a, b) => b.draws - a.draws),
        cityStats: city && city.stats ? city.stats() : null,
        frame: { draws: renderer.info.render.calls, tris: renderer.info.render.triangles },
      };
    },
    { s }
  );

  console.log(`\n=== ${name} ===  renderer.info: ${out.frame.draws} draws / ${(out.frame.tris / 1e6).toFixed(2)}M tris`);
  if (out.cityStats) console.log(`  city.stats: ${JSON.stringify(out.cityStats)}`);
  for (const r of out.rows) {
    const detail = Object.entries(r.names)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([n, c]) => `${n}×${c}`)
      .join(' ');
    console.log(`  ${String(r.draws).padStart(4)}  ${(r.tris / 1000).toFixed(0).padStart(7)}k  ${r.k.padEnd(22)} ${detail}`);
  }
}

await browser.close();
if (server) server.kill('SIGTERM');
