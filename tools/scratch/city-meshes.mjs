/**
 * Throwaway: which city chunk owns which draw call.
 *
 * `probe-draws.mjs` attributes by top-level scene node and truncates its mesh list at eight
 * names, which is enough to say "the city" and not enough to say "the streets chunk". This
 * walks the city group's visible LOD groups at a named camera and lists every mesh.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { spawnVite } from '../lib/devtree.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5487);
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) { server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } }); if (!(await up(90000))) { console.error('no vite'); process.exit(1); } }
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto(`${base}/?harness=1&quality=ultra&w=1600&h=900`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
  const out = await p.evaluate(() => {
    const g = window.__game;
    // The `city` shot from tools/shoot.mjs.
    g.setCamera(40, 620, 0.74, Math.PI * 0.06);
    g.engine.frame(performance.now());
    const cam = g.engine.context.camera;
    const THREE = g.engine.context.scene.constructor;
    const root = g.engine.context.scene.getObjectByName('city');
    const rows = [];
    const m = new (cam.projectionMatrix.constructor)();
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const planes = [];
    const e = m.elements;
    const push = (a, bb, c, d) => { const l = Math.hypot(a, bb, c); planes.push([a / l, bb / l, c / l, d / l]); };
    push(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
    push(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
    push(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
    push(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
    push(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
    push(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
    for (const grp of root.children) {
      if (!grp.visible) continue;
      for (const mesh of grp.children) {
        if (!mesh.isMesh) continue;
        mesh.geometry.computeBoundingSphere();
        const s = mesh.geometry.boundingSphere;
        let inside = true;
        for (const pl of planes) if (pl[0] * s.center.x + pl[1] * s.center.y + pl[2] * s.center.z + pl[3] < -s.radius) { inside = false; break; }
        if (!inside) continue;
        rows.push({ name: mesh.name || grp.name, group: grp.name, tris: Math.round(mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3), shadow: mesh.castShadow });
      }
    }
    return rows;
  });
  const byGroup = new Map();
  for (const r of out) { const k = r.group; byGroup.set(k, (byGroup.get(k) ?? []).concat(r)); }
  console.log(`visible+in-frustum city meshes: ${out.length}  (casters ${out.filter((r) => r.shadow).length})`);
  for (const [k, v] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(2)}  ${k.padEnd(26)} ${v.map((r) => r.name.replace(k + '-', '')).join(' ')}`);
  }
} finally { await b.close(); if (server) server.kill('SIGTERM'); }
