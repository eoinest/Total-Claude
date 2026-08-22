/**
 * Throwaway: do the wall stairs stop a man on the ground, *without* stopping the garrison
 * that has to climb them?
 *
 * Boots the page and reads `window.__game.ready`, capturing `pageerror` and `console` —
 * a typecheck cannot see a temporal dead zone or a missing runtime method behind `?.`, and
 * three commits have been stacked on a tree that white-screened.
 *
 *   TC_NO_HMR=1 node tools/scratch/stair-block.mjs --port=5893
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5893);
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) { server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } }); if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); } }

const b = await chromium.launch();
let code = 0;
const errs = [];
try {
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { const t = m.text(); if (!/three|WebGL|deprecat/i.test(t)) errs.push(`${m.type()}: ${t}`); } });
  p.on('pageerror', (e) => { errs.push(`PAGEERROR: ${e.message}`); });
  await p.goto(`${base}/?harness=1&quality=low&w=800&h=600`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try { await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 }); console.log('BOOT: window.__game.ready === true'); }
  catch (e) { console.log('BOOT FAILED:', e.message.split('\n')[0]); code = 1; }
  if (errs.length) console.log('PAGE MESSAGES:\n  ' + errs.join('\n  '));
  if (!code) {
    const out = await p.evaluate(() => {
      const g = window.__game.engine;
      const city = g.ctx?.get ? g.ctx.get('city') : g.byName?.get('city');
      const stairs = city.getWallStairs();
      const obs = city.getObstacles();
      // Box containment, which is what actually shoves a man: `BattleSystem` collides
      // against `getObstacles()`. `blocksMovement` is the 4 m raster the pathfinder stamps,
      // and it bleeds half a cell plus a body radius past every solid — so the curtain's own
      // stamp already covers ground a man can stand on. The two answer different questions
      // and only the box set can push anybody off a staircase.
      const inBox = (x, z) => obs.some((o) => {
        const dx = x - o.x, dz = z - o.z, cs = Math.cos(o.rot), sn = Math.sin(o.rot);
        return Math.abs(dx * cs + dz * sn) <= o.hw && Math.abs(-dx * sn + dz * cs) <= o.hd;
      });
      const rows = stairs.map((s) => {
        const dx = s.headX - s.footX, dz = s.headZ - s.footZ;
        const at = (t) => ({ x: s.footX + dx * t, z: s.footZ + dz * t });
        const probe = (t) => { const q = at(t); return city.blocksMovement(q.x, q.z, q.x, q.z); };
        const boxAt = (t) => { const q = at(t); return inBox(q.x, q.z); };
        // A body radius out from the foot, along the ground, away from the rake: where a
        // man queueing for his turn actually stands.
        const len = Math.hypot(dx, dz) || 1;
        const qx = s.footX - (dx / len) * 2.5, qz = s.footZ - (dz / len) * 2.5;
        return {
          bay: s.bay, run: +s.run.toFixed(1), rise: +s.rise.toFixed(2), width: s.width, side: s.side,
          footOpen: !city.blocksMovement(s.footX, s.footZ, s.footX, s.footZ),
          queueOpen: !city.blocksMovement(qx, qz, qx, qz),
          at10pct: probe(0.1), at25pct: probe(0.25), mid: probe(0.5), at90pct: probe(0.9),
          // The box set — the only view that can shove a man.
          boxFoot: inBox(s.footX, s.footZ), boxQueue: inBox(qx, qz),
          box10: boxAt(0.1), box25: boxAt(0.25), boxMid: boxAt(0.5), box90: boxAt(0.9),
        };
      });
      return {
        stairs: stairs.length,
        obstacles: obs.length,
        wallBoxes: obs.filter((o) => o.kind === 'wall').length,
        rows,
        summary: {
          raster: {
            footsOpen: rows.filter((r) => r.footOpen).length,
            queuesOpen: rows.filter((r) => r.queueOpen).length,
            midsBlocked: rows.filter((r) => r.mid).length,
            upperBlocked: rows.filter((r) => r.at90pct).length,
          },
          boxes: {
            footsFree: rows.filter((r) => !r.boxFoot).length,
            queuesFree: rows.filter((r) => !r.boxQueue).length,
            tenthFree: rows.filter((r) => !r.box10).length,
            quarterFree: rows.filter((r) => !r.box25).length,
            midsSolid: rows.filter((r) => r.boxMid).length,
            uppersSolid: rows.filter((r) => r.box90).length,
          },
        },
      };
    });
    console.log(JSON.stringify(out, null, 1));
  }
} finally { await b.close(); if (server) server.kill('SIGTERM'); }
process.exit(code);
