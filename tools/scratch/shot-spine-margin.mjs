#!/usr/bin/env node
/**
 * Photograph a garrison standing off the stone, before and after the two-ended station clip.
 *
 * The subject is **not** a man crossing a tower. At `66b220b` `stepAcross` already refuses
 * the crossings this would have shown, so a before/after of a crossing shows an order being
 * declined, which is a true picture of a different defect. The defect here is quieter and
 * permanent: `buildSpine` clipped a bay's east end by 0.55 m instead of by the next tower's
 * half-footprint, so the last stations of every bay stood inside that tower at their own
 * bay's `walkY` — and a man posted to one of them stands in the air above the ramp
 * `CitySystem.walkableTopAt` reports, for the whole battle, without moving.
 *
 * So this censuses the **soldier pool**, not the station array: `Siege` can be told it has
 * put a station in the right place, and the question is where a man's feet end up. Every
 * living man on the wall is measured against `walkableTopAt` at his own position, the worst
 * one is found, and the camera is parked on him.
 *
 * The two arms must frame the same stone. The before arm prints the x it chose; pass it to
 * the after arm as `--at=`, where that man is standing somewhere else or is not there at all.
 *
 * Usage:
 *   node tools/scratch/shot-spine-margin.mjs --port=5954 --label=margin-before
 *   node tools/scratch/shot-spine-margin.mjs --port=5953 --label=margin-after --at=-134.6
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5953));
const LABEL = arg('label', 'shot');
const OUT = arg('out', 'screenshots/spine-margin');
const MAP = arg('map', 'campus-martius');
const ZOOM = Number(arg('zoom', 0.30));
const YAW = Number(arg('yaw', 0.5));
const AT = arg('at', '') === '' ? null : Number(arg('at', '0'));
/**
 * Post a cohort on the worst station rather than photographing whoever happens to be there.
 *
 * The shipped order of battle does not garrison Rome's bay 13 — run 12 is one of the
 * seventeen stranded from the ground at `66b220b` — so the worst station on the circuit has
 * nobody on it and a passive census photographs a 0.89 m error instead of a 3.16 m one. The
 * station is still wrong; a man is put on it to show what it does. `garrison` *places* and
 * does not route, so this cannot beg the question by using a link.
 *
 * `--post` with no value picks the worst station outside the gatehouse; `--post=<x>` posts at
 * a named x, which is how the after arm frames the same stone.
 */
const POST = process.argv.some((a) => a === '--post' || a.startsWith('--post='));
const POST_X = arg('post', '') === '' ? null : Number(arg('post', '0'));
const TIMES = arg('at-t', '20,60,120').split(',').map(Number);

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1600&h=900&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server on', PORT); process.exit(2); }
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});
await page.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  if (hud && hud.overlay) hud.overlay.visible = false;
});

await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const s = b.elevation ?? b.siege;
  window.__sm = {
    g, b, s,
    /** The station whose levelled height is furthest from the drawn walk, gatehouse aside. */
    worstStation() {
      const city = s.city;
      const gb = city.getGateBlock ? city.getGateBlock() : null;
      let best = -1; let worst = 0;
      for (let i = 0; i < s.nStations; i++) {
        if (s.sDead[i]) continue;
        if (gb) {
          const ex = s.sx[i] - gb.x; const ez = s.sz[i] - gb.z;
          if (Math.abs(ex * gb.dx + ez * gb.dz) <= gb.halfRun + 2
            && Math.abs(ex * gb.nx + ez * gb.nz) <= gb.halfDepth + 2) continue;
        }
        const top = city.walkableTopAt(s.sx[i], s.sz[i], s.sy[i] + 1.6);
        if (!isFinite(top)) continue;
        const d = s.sy[i] - top;
        if (Math.abs(d) > Math.abs(worst)) { worst = d; best = i; }
      }
      return best < 0 ? null
        : { station: best, x: +s.sx[best].toFixed(2), z: +s.sz[best].toFixed(2),
            sy: +s.sy[best].toFixed(2), off: +worst.toFixed(2), run: s.sRun[best], bay: s.sBay[best] };
    },
    /** Put the biggest defender not already on the stone at a named plan point. */
    post(x, z) {
      const st = s.stationNear(x, z);
      if (st < 0) return { fail: 'no station near' };
      const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction;
      let u = null;
      for (const q of b.units) {
        if (q.destroyed || q.alive < 8 || q.faction !== defender) continue;
        if (s.ownsUnit(q.id) || s.isGarrisoned(q.id)) continue;
        if (!u || q.alive > u.alive) u = q;
      }
      if (!u) return { fail: 'no unit available' };
      const ok = s.garrison(u, s.sx[st], s.sz[st]);
      return { unitId: u.id, alive: u.alive, type: u.typeId, station: st,
        x: +s.sx[st].toFixed(2), z: +s.sz[st].toFixed(2), sy: +s.sy[st].toFixed(2), ok };
    },
    /**
     * Every living man on the wall, against the surface the city says is under him.
     *
     * **Split at the gatehouse**, because two different defects live on this wall and only
     * one of them is the station clip's. `getGateBlock`'s own doc records men 6.574 m below
     * the block's crown, and `walkableTopAt` returns that crown across the whole 25 m
     * footprint — so the gate men swamp any ranking by depth and would have this tool
     * photographing somebody else's bug in both arms. They are counted and reported
     * separately and the camera never chooses one.
     */
    census() {
      const p = b.pool;
      const city = s.city;
      const gb = city.getGateBlock ? city.getGateBlock() : null;
      const inGate = (x, z) => {
        if (!gb) return false;
        const ex = x - gb.x; const ez = z - gb.z;
        return Math.abs(ex * gb.dx + ez * gb.dz) <= gb.halfRun + 2
          && Math.abs(ex * gb.nx + ez * gb.nz) <= gb.halfDepth + 2;
      };
      const rows = [];
      const gate = [];
      let n = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.state[i] === 10 || p.state[i] === 11) continue;
        if (!b.elevated[i]) continue;
        n++;
        const top = city.walkableTopAt(p.x[i], p.z[i], p.y[i] + 1.6);
        if (!isFinite(top)) continue;
        const air = p.y[i] - top;
        if (Math.abs(air) <= 0.05) continue;
        const row = { i, x: +p.x[i].toFixed(1), y: +p.y[i].toFixed(2), z: +p.z[i].toFixed(1),
          top: +top.toFixed(2), air: +air.toFixed(2), state: p.state[i] };
        (inGate(p.x[i], p.z[i]) ? gate : rows).push(row);
      }
      rows.sort((m, q) => Math.abs(q.air) - Math.abs(m.air));
      gate.sort((m, q) => Math.abs(q.air) - Math.abs(m.air));
      const over = (t) => rows.filter((m) => Math.abs(m.air) > t).length;
      return { onWall: n, off: rows.length, over05: over(0.5), over10: over(1.0),
        over20: over(2.0), worst: rows.slice(0, 6),
        gateOff: gate.length, gateWorst: gate.length ? gate[0].air : 0 };
    },
  };
});

const ws = await page.evaluate(() => window.__sm.worstStation());
console.log(`[${LABEL}] worst station off the drawn walk: ${JSON.stringify(ws)}`);

const shots = [];
let elapsed = 0;
let subject = AT;
let posted = null;
if (POST) {
  // Settle the deployment first; `garrison` overwrites whatever the order of battle did.
  await page.evaluate(() => window.__sm.g.fastForward(6));
  elapsed = 6;
  const px = POST_X !== null ? POST_X : (ws ? ws.x : 0);
  posted = await page.evaluate((x) => {
    const bays = window.__sm.s.city.getGarrisonBays();
    let best = bays[0];
    for (const q of bays) if (Math.abs(q.x0 - x) < Math.abs(best.x0 - x)) best = q;
    return window.__sm.post(x, best.z0);
  }, px);
  console.log(`[${LABEL}] posted at x ${px}: ${JSON.stringify(posted)}`);
  if (subject === null) subject = px;
}
if (process.argv.includes('--sweep')) {
  // Choose a framing once, in the arm that has something to see, then pin both arms to it.
  await page.evaluate((d) => window.__sm.g.fastForward(d), TIMES[0] - elapsed);
  const at = subject ?? 0;
  const z0 = await page.evaluate((x) => {
    const bays = window.__sm.s.city.getGarrisonBays();
    let best = bays[0];
    for (const q of bays) if (Math.abs(q.x0 - x) < Math.abs(best.x0 - x)) best = q;
    return best.z0;
  }, at);
  for (const zoom of [0.42, 0.50, 0.58]) {
    for (const yaw of [0, 0.5, 1.0, 1.5]) {
      await page.evaluate(([x, zz, zm, yw]) => window.__sm.g.setCamera(x, zz, zm, Math.PI * yw),
        [at, z0, zoom, yaw]);
      await page.evaluate(() => window.__sm.g.advance(1 / 60));
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/${LABEL}-sweep-z${zoom}-y${yaw}.png` });
      console.log(`  sweep zoom ${zoom} yaw ${yaw}pi`);
    }
  }
  await browser.close();
  process.exit(0);
}
for (const t of TIMES) {
  await page.evaluate((d) => window.__sm.g.fastForward(d), t - elapsed);
  elapsed = t;
  const c = await page.evaluate(() => window.__sm.census());
  if (subject === null && c.worst.length > 0) subject = c.worst[0].x;
  const at = subject === null ? 0 : subject;
  const z = await page.evaluate((x) => {
    // The wall's own z at this x, so the camera looks at the curtain and not at open ground.
    const bays = window.__sm.s.city.getGarrisonBays();
    let best = bays[0];
    for (const q of bays) if (Math.abs(q.x0 - x) < Math.abs(best.x0 - x)) best = q;
    return best.z0;
  }, at);
  await page.evaluate(([x, zz, zoom, yaw]) => window.__sm.g.setCamera(x, zz, zoom, yaw),
    [at, z, ZOOM, Math.PI * YAW]);
  await page.evaluate(() => window.__sm.g.advance(1 / 60));
  await page.waitForTimeout(350);
  const name = `${LABEL}-t${String(t).padStart(3, '0')}`;
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push({ t, at, ...c });
  console.log(`  t+${t}s  ${c.onWall} men on the wall, ${c.off} off the drawn walk `
    + `(>0.5 m ${c.over05}, >1 m ${c.over10}, >2 m ${c.over20}); worst `
    + `${c.worst.slice(0, 3).map((m) => `${m.air > 0 ? '+' : ''}${m.air} m at x ${m.x}`).join(', ') || 'none'}`
    + `; gatehouse (not this defect) ${c.gateOff} at ${c.gateWorst} m  -> ${name}.png`);
}

const rep = await page.evaluate(() => {
  const w = window.__sm.s.wallReport();
  return { runs: w.runs, stations: w.stations, reachable: w.reachable,
    links: w.links, unbridged: w.unbridged, refusedSteps: w.refusedSteps };
});
console.log(`[${LABEL}] camera x ${subject}; wallReport ${JSON.stringify(rep)}`);
if (errs.length) console.log(`[${LABEL}] PAGE ERRORS ${errs.length}: ${errs.join(' | ')}`);
await writeFile(`${OUT}/${LABEL}.json`,
  JSON.stringify({ map: MAP, subject, worstStation: ws, posted, shots, rep, errs }, null, 2));
await browser.close();
