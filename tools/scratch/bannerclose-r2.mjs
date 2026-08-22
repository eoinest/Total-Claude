// Scratch: park the camera on a standard and photograph it big, for the round-2 cloth work.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnVite } from '../lib/devtree.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5417);
const HOUR = Number(process.argv.find((a) => a.startsWith('--hour='))?.slice(7) ?? 15.5);
const TAG = process.argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'a';
const OUT = path.join(ROOT, 'screenshots/r2-banner');
await mkdir(OUT, { recursive: true });
const wait = async (u, ms) => { const d = Date.now() + ms; while (Date.now() < d) { try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {} await new Promise(r => setTimeout(r, 300)); } return false; };
const base = `http://127.0.0.1:${PORT}`;
let srv = null;
if (!(await wait(base, 1000))) {
  srv = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await wait(base, 90000))) throw new Error('no vite');
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
const token = Buffer.from(JSON.stringify({ timeOfDay: HOUR })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
await page.goto(`${base}/?harness=1&quality=ultra&w=1600&h=1000&battle=${token}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root,#loading,#menu-root{display:none!important}' });
await page.evaluate(() => { const h = window.__game?.engine?.context?.tryGet?.('hud'); if (h?.overlay) h.overlay.visible = false; });
const info = await page.evaluate(async () => {
  const g = window.__game;
  while (g.simTime() < 30) g.advance(0.5);
  // Nearest living Roman heavy-infantry unit, and put the eye on its standard.
  const b = g.battle;
  let best = null;
  for (const u of b.units) { if (u.destroyed || u.alive === 0 || u.faction !== 0) continue; if (b.typeOf(u).unitClass !== 'heavy-infantry') continue; if (!best || u.alive > best.alive) best = u; }
  const fx = best.x - Math.sin(best.facing) * 1.05, fz = best.z - Math.cos(best.facing) * 1.05;
  const rig = g.engine.rig;
  const saved = rig.heightAt;
  const y = saved(fx, fz) + 2.35;
  rig.heightAt = () => y;
  g.setCamera(fx, fz, 0.055, best.facing + Math.PI + 0.9);
  g.advance(0.4);
  rig.heightAt = saved;
  return { unit: best.id, x: Math.round(fx), z: Math.round(fz) };
});
await page.screenshot({ path: path.join(OUT, `close-${TAG}.png`), type: 'png' });
console.log(JSON.stringify(info), 'errors:', errs.length, errs.slice(0, 5));
await browser.close();
if (srv) srv.kill('SIGTERM');
