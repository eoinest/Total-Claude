/**
 * Throwaway: what the city generator built, and where the ground inside the wall went.
 *
 * One page load gives both. Owns its own vite so it cannot grade a stale build or lose the
 * server to another agent mid-measurement, and captures `pageerror`/`console` so a failure
 * reports a reason rather than a timeout.
 *   TC_NO_HMR=1 node tools/scratch/city-audit.mjs --port=5487
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5487);
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) { server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } }); if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); } }

const b = await chromium.launch();
let code = 0;
try {
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  p.on('console', (m) => { const t = m.text(); if (t.startsWith('[city]') || m.type() === 'error') console.log(m.type().toUpperCase(), t); });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto(`${base}/?harness=1&quality=low&w=800&h=600`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try { await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 }); }
  catch (e) { console.log('NOT READY:', e.message.split('\n')[0]); code = 1; }
  if (!code) {
    const out = await p.evaluate(async () => {
      const L = await import('/src/city/layout.ts');
      const g = window.__game.engine;
      const city = g.ctx?.get ? g.ctx.get('city') : g.byName?.get('city');
      const terrain = g.ctx?.get ? g.ctx.get('terrain') : g.byName?.get('terrain');
      const st = city.stats();
      const obs = city.getObstacles();
      const built = obs.filter((o) => o.kind === 'building');
      const inBoxes = (list, x, z) => list.some((o) => {
        const dx = x - o.x, dz = z - o.z, cs = Math.cos(o.rot), sn = Math.sin(o.rot);
        return Math.abs(dx * cs + dz * sn) <= o.hw && Math.abs(-dx * sn + dz * cs) <= o.hd;
      });
      const mk = (fill) => { const k = new L.KeepOut(); fill(k); return k; };
      const koWays = mk((k) => { for (const w of L.WAYS) k.addPath(w.path, w.width * 0.5 + L.WAY_FRONTAGE[w.cls]); });
      const koMon = mk((k) => { for (const l of L.LANDMARKS) { k.addRect(l.x, l.z, l.hw, l.hd, l.rot); if (l.mound) k.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02); } });
      const koPlaza = mk((k) => { for (const pz of L.PLAZAS) k.addRect(pz.x, pz.z, pz.hw + 2, pz.hd + 2, pz.rot); });
      const STEP = 6, A = STEP * STEP;
      const t = { land: 0, pomerium: 0, ways: 0, monument: 0, plaza: 0, built: 0, free: 0 };
      for (let z = 400; z < 1400; z += STEP) for (let x = -1400; x < 1400; x += STEP) {
        const crest = L.wallCrestZ(x);
        if (z < crest || terrain.heightAt(x, z) < 0.2) continue;
        t.land += A;
        if (z < crest + L.POMERIUM) { t.pomerium += A; continue; }
        if (inBoxes(built, x, z)) { t.built += A; continue; }
        if (koWays.blocked(x, z, 0.1)) { t.ways += A; continue; }
        if (koMon.blocked(x, z, 0.1)) { t.monument += A; continue; }
        if (koPlaza.blocked(x, z, 0.1)) { t.plaza += A; continue; }
        t.free += A;
      }
      const pct = (v) => +((v / t.land) * 100).toFixed(1);
      return {
        buildings: built.length,
        stats: st,
        plazas: L.PLAZAS.length,
        land: { m2: t, pct: { pomerium: pct(t.pomerium), ways: pct(t.ways), monument: pct(t.monument), plaza: pct(t.plaza), built: pct(t.built), free: pct(t.free) } },
      };
    });
    console.log(JSON.stringify(out, null, 1));
  }
} finally { await b.close(); if (server) server.kill('SIGTERM'); }
process.exit(code);
