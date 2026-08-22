/**
 * Throwaway: *where* the unbuilt ground inside the circuit is, and why nothing stands on it.
 *
 * The land ledger says 35.6 % of the walled city is free. That is a number, not a diagnosis:
 * it does not say whether the quarters are thin or whether there are no quarters there. This
 * splits every free cell by district coverage and by the first rule that would reject a plot
 * standing on it, so a density change can be aimed instead of guessed.
 *
 *   TC_NO_HMR=1 node tools/scratch/free-land.mjs --port=5893
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5893);
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 300)); } return false; };
let server = null;
if (!(await up(1200))) { server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } }); if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); } }

const b = await chromium.launch();
let code = 0;
try {
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text()); });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto(`${base}/?harness=1&quality=low&w=800&h=600`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try { await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 }); }
  catch (e) { console.log('NOT READY:', e.message.split('\n')[0]); code = 1; }
  if (!code) {
    const out = await p.evaluate(async () => {
      // §15 task 0 split `city/layout.ts` into the generic part and `city/rome/`.
      // `KeepOut` is still the shared one; the plan and the circuit are Rome's.
      const L = {
        ...(await import('/src/city/layout.ts')),
        ...(await import('/src/city/rome/circuit.ts')),
        ...(await import('/src/city/rome/layout.ts')),
      };
      const { Rng, hash2 } = await import('/src/util/rand.ts');
      const g = window.__game.engine;
      const city = g.ctx?.get ? g.ctx.get('city') : g.byName?.get('city');
      const terrain = g.ctx?.get ? g.ctx.get('terrain') : g.byName?.get('terrain');
      const obs = city.getObstacles();
      const built = obs.filter((o) => o.kind === 'building');
      const inBoxes = (list, x, z) => list.some((o) => {
        const dx = x - o.x, dz = z - o.z, cs = Math.cos(o.rot), sn = Math.sin(o.rot);
        return Math.abs(dx * cs + dz * sn) <= o.hw && Math.abs(-dx * sn + dz * cs) <= o.hd;
      });
      const mk = (fill) => { const k = new L.KeepOut(); fill(k); return k; };
      /**
       * The **whole** street network: the named armature *and* the 38 km of lanes each
       * quarter cut for itself. `L.WAYS` is only the twenty-two viae; scoring against it
       * alone counted every vicus in Rome as unbuilt ground.
       */
      const lanes = city.getLanes ? city.getLanes() : [];
      const koWays = mk((k) => {
        for (const w of L.WAYS) k.addPath(w.path, w.width * 0.5 + L.WAY_FRONTAGE[w.cls]);
        for (const l of lanes) k.addPath(l.path, l.width * 0.5 + L.WAY_FRONTAGE[l.cls]);
      });
      const koMon = mk((k) => { for (const l of L.LANDMARKS) { k.addRect(l.x, l.z, l.hw, l.hd, l.rot); if (l.mound) k.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02); } });
      const koPlaza = mk((k) => { for (const pz of L.PLAZAS) k.addRect(pz.x, pz.z, pz.hw + 2, pz.hd + 2, pz.rot); });

      // District mask, replicated from city/rome/fabric.ts's `districtMask`.
      const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      const maskOf = (d, u, v) => {
        const tu = Math.abs(u) / d.hw, tv = Math.abs(v) / d.hd;
        const t = Math.pow(Math.pow(tu, 4) + Math.pow(tv, 4), 0.25);
        const seed = Rng.hashString(d.id);
        const ph1 = hash2(seed & 0xff, 1, 0x3a) * Math.PI * 2;
        const ph2 = hash2(seed & 0xff, 2, 0x3b) * Math.PI * 2;
        const ang = Math.atan2(v * d.hw, u * d.hd);
        const lobe = d.fray * (0.17 * Math.sin(ang * 3 + ph1) + 0.1 * Math.sin(ang * 7 + ph2));
        const outer = 1 + d.fray * 0.34 + lobe;
        const inner = outer - (0.12 + d.fray * 0.26);
        const s = clamp((outer - t) / Math.max(0.05, outer - inner), 0, 1);
        return s * s * (3 - 2 * s);
      };
      // World -> district local. `districtFrame` maps (u,v) -> (x,z); invert it.
      const localOf = (d, x, z) => {
        const cs = Math.cos(d.rot), sn = Math.sin(d.rot);
        const dx = x - d.x, dz = z - d.z;
        return { u: dx * cs - dz * sn, v: dx * sn + dz * cs };
      };
      const bestMask = (x, z) => {
        let best = 0, id = null;
        for (const d of L.DISTRICTS) {
          const { u, v } = localOf(d, x, z);
          if (Math.abs(u) > d.hw * 1.6 || Math.abs(v) > d.hd * 1.6) continue;
          const m = maskOf(d, u, v);
          if (m > best) { best = m; id = d.id; }
        }
        return { m: best, id };
      };

      const STEP = 6, A = STEP * STEP;
      const t = { land: 0, pomerium: 0, ways: 0, monument: 0, plaza: 0, built: 0, free: 0 };
      // Free-land breakdown.
      const fr = { noDistrict: 0, fringe: 0, coreFree: 0 };
      // Per-district: ground inside its plateau (mask>0.5) that is neither street,
      // monument, plaza nor pomerium — and how much of it is roofed.
      const per = new Map();
      for (const d of L.DISTRICTS) per.set(d.id, { net: 0, roof: 0 });
      let coreNet = 0, coreRoof = 0;

      for (let z = 400; z < 1400; z += STEP) for (let x = -1400; x < 1400; x += STEP) {
        const crest = L.wallCrestZ(x);
        if (z < crest || terrain.heightAt(x, z) < 0.2) continue;
        t.land += A;
        if (z < crest + L.POMERIUM) { t.pomerium += A; continue; }
        const isBuilt = inBoxes(built, x, z);
        if (!isBuilt) {
          if (koWays.blocked(x, z, 0.1)) { t.ways += A; continue; }
          if (koMon.blocked(x, z, 0.1)) { t.monument += A; continue; }
          if (koPlaza.blocked(x, z, 0.1)) { t.plaza += A; continue; }
        }
        // Net buildable ground between street lines: not street, monument, plaza, pomerium.
        const bm = bestMask(x, z);
        if (bm.id) {
          const rec = per.get(bm.id);
          if (bm.m > 0.5) { rec.net += A; if (isBuilt) rec.roof += A; coreNet += A; if (isBuilt) coreRoof += A; }
        }
        if (isBuilt) { t.built += A; continue; }
        t.free += A;
        if (bm.m <= 0.04) fr.noDistrict += A;
        else if (bm.m < 0.5) fr.fringe += A;
        else fr.coreFree += A;
      }
      // ---- figure-ground map, 40 m cells ---------------------------------------
      // '#' roof, ':' street, 'M' monument, 'p' pomerium, '-' free inside a quarter,
      // ' ' free with no quarter over it at all, '.' off the buildable land.
      const MX0 = -1400, MX1 = 1400, MZ0 = 400, MZ1 = 1400, MC = 40;
      const cols = Math.round((MX1 - MX0) / MC), rowsN = Math.round((MZ1 - MZ0) / MC);
      const mapRows = [];
      for (let r = 0; r < rowsN; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const x = MX0 + c * MC + MC / 2, z = MZ0 + r * MC + MC / 2;
          const crest = L.wallCrestZ(x);
          if (z < crest || terrain.heightAt(x, z) < 0.2) { line += '.'; continue; }
          if (z < crest + L.POMERIUM) { line += 'p'; continue; }
          if (inBoxes(built, x, z)) { line += '#'; continue; }
          if (koWays.blocked(x, z, 0.1)) { line += ':'; continue; }
          if (koMon.blocked(x, z, 0.1) || koPlaza.blocked(x, z, 0.1)) { line += 'M'; continue; }
          line += bestMask(x, z).m <= 0.04 ? ' ' : '-';
        }
        mapRows.push(line);
      }

      const pct = (v, d = t.land) => +((v / d) * 100).toFixed(1);
      const districts = [...per.entries()]
        .map(([id, r]) => ({ id, netHa: +(r.net / 1e4).toFixed(1), roofPct: r.net ? +((r.roof / r.net) * 100).toFixed(1) : 0 }))
        .sort((a, b) => a.roofPct - b.roofPct);
      return {
        buildings: built.length,
        land: { m2: t, pct: { pomerium: pct(t.pomerium), ways: pct(t.ways), monument: pct(t.monument), plaza: pct(t.plaza), built: pct(t.built), free: pct(t.free) } },
        freeSplit: { noDistrictPct: pct(fr.noDistrict), fringePct: pct(fr.fringe), corePct: pct(fr.coreFree),
          asShareOfFree: { noDistrict: pct(fr.noDistrict, t.free), fringe: pct(fr.fringe, t.free), core: pct(fr.coreFree, t.free) } },
        roofBetweenStreetLines: { netHa: +(coreNet / 1e4).toFixed(1), roofPct: coreNet ? +((coreRoof / coreNet) * 100).toFixed(1) : 0 },
        districts, mapRows,
      };
    });
    const { mapRows, ...rest } = out;
    console.log(JSON.stringify(rest, null, 1));
    console.log("\n=== figure-ground, 40 m cells, x -1400..1400, z 400..1400 ===");
    console.log("# roof   : street   M monument   p pomerium   - free in a quarter   (space) free, no quarter");
    for (const r of mapRows) console.log(r);
  }
} finally { await b.close(); if (server) server.kill('SIGTERM'); }
process.exit(code);
