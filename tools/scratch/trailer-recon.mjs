#!/usr/bin/env node
/**
 * Reconnaissance for the trailer cut: how long does the world take to build, how fast can
 * this machine render and capture a frame, and what is actually happening on the field at
 * each second of an assault.
 *
 * Writes nothing to the repo; prints JSON.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5219);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const MAP = args.get('map') ?? 'campus-martius';
const SCEN = args.get('scenario') ?? 'assault';
const ENEMY = args.get('enemy') ?? '';
const UNTIL = Number(args.get('until') ?? 320);
const QUALITY = args.get('quality') ?? 'ultra';
const OUT = args.get('out') ?? `/tmp/tc-trailer-recon-${MAP}-${SCEN}.json`;
const SHOTDIR = args.get('shotdir') ?? '';

const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
    '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const url = `${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&scenario=${SCEN}&map=${MAP}`
  + (ENEMY ? `&enemy=${ENEMY}` : '');
console.log(`• ${url}`);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
const bootMs = Date.now() - t0;
console.log(`• ready in ${(bootMs / 1000).toFixed(1)} s`);

await page.addStyleTag({ content: '#hud-root,#loading,#menu-root{display:none!important;visibility:hidden!important}' });
await page.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  if (hud && hud.overlay) hud.overlay.visible = false;
  window.__game.engine.stop();
});

// Static world facts.
const world = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.context.tryGet('city');
  const out = { hasCity: !!city, bays: null, gates: null, bounds: null };
  if (city) {
    const bays = city.getGarrisonBays?.() ?? [];
    out.bays = { n: bays.length, gateIdx: bays.findIndex((b) => b.isGate) };
    const g0 = bays[bays.findIndex((b) => b.isGate)];
    if (g0) out.gateBay = { x: (g0.x0 + g0.x1) / 2, z: (g0.z0 + g0.z1) / 2, nx: g0.nx, nz: g0.nz,
      walkY: g0.walkY, crestY: g0.crestY, dx: g0.dx, dz: g0.dz };
    out.gates = (city.getGates?.() ?? []).map((q) => ({ id: q.id, x: q.x, z: q.z }));
    out.wallSegs = (city.getWallSegments?.() ?? []).length;
  }
  const terr = g.engine.context.tryGet('terrain');
  out.waterLevel = terr?.waterLevel ?? null;
  out.units = g.battle.units.filter((u) => !u.destroyed).map((u) => ({
    id: u.id, f: u.faction, type: g.battle.typeOf(u).id, cls: g.battle.typeOf(u).unitClass,
    alive: u.alive, x: +u.x.toFixed(1), z: +u.z.toFixed(1),
  }));
  return out;
});

// Timeline.
const timeline = await page.evaluate(async (until) => {
  const g = window.__game, b = g.battle, s = b.siege;
  const rows = [];
  const snap = () => {
    const p = b.pool;
    let alive = [0, 0, 0], onWall = 0, fighting = 0, minZ = 1e9, maxZ = -1e9;
    let hiY = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 11 || st === 10) continue;
      alive[p.faction[i]]++;
      if (st === 4) fighting++;
      const y = p.y ? p.y[i] : 0;
      if (y > 3) { onWall++; if (y > hiY) hiY = y; }
      if (p.z[i] < minZ) minZ = p.z[i];
      if (p.z[i] > maxZ) maxZ = p.z[i];
    }
    const rams = s?.ramReport ? s.ramReport() : [];
    const gate = s?.gateReport ? s.gateReport() : null;
    const towers = s?.towerReport ? s.towerReport() : null;
    const eng = s?.engineReport ? s.engineReport() : null;
    return {
      t: +g.simTime().toFixed(1), alive, fighting, onWall, hiY: +hiY.toFixed(1),
      zRange: [+minZ.toFixed(0), +maxZ.toFixed(0)],
      gate: gate ? { blows: gate.blows, hp: +(gate.hp ?? 0).toFixed(2), open: gate.open, breached: gate.breached } : null,
      rams: rams.map((r) => ({ id: r.id, kind: r.kind, st: r.state, blows: r.blows,
        d: +r.distFromTarget.toFixed(0), crew: r.crewAlive, x: r.x !== undefined ? +r.x.toFixed(0) : null,
        z: r.z !== undefined ? +r.z.toFixed(0) : null })),
      towers: towers ? towers.map((t2) => ({ id: t2.id, st: t2.state, d: +t2.dist.toFixed(0),
        docked: t2.docked, ramp: t2.rampDrawn, crossed: t2.crossed,
        x: +t2.x.toFixed(0), z: +t2.z.toFixed(0), deckY: +t2.deckY.toFixed(1) })) : null,
      eng: eng ? { shots: eng.shots, hits: eng.hits, kills: eng.kills,
        ladders: eng.ladders, laddersCrossed: eng.laddersCrossed } : null,
    };
  };
  rows.push(snap());
  for (let t = 10; t <= until; t += 10) {
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
    rows.push(snap());
  }
  return rows;
}, UNTIL);

// Capture speed at the current (late) state, wide camera.
const speed = await (async () => {
  await page.evaluate(() => {
    const g = window.__game;
    g.setCamera(0, 60, 0.60, Math.PI * 0.82);
  });
  const t = [];
  for (let i = 0; i < 6; i++) {
    const a = Date.now();
    await page.evaluate(() => window.__game.engine.advance(1 / 30, 1000 / 30));
    const b = Date.now();
    await page.screenshot({ type: 'jpeg', quality: 90 });
    t.push({ frameMs: b - a, shotMs: Date.now() - b });
  }
  return t;
})();

if (SHOTDIR) {
  await page.screenshot({ path: `${SHOTDIR}/recon-${MAP}-${SCEN}.jpg`, type: 'jpeg', quality: 92 });
}

const out = { url, bootMs, world, timeline, speed, errs: [...new Set(errs)].slice(0, 20) };
await writeFile(OUT, JSON.stringify(out, null, 1));
console.log(`→ ${OUT}`);
console.log(JSON.stringify({ bootMs, speed, errs: out.errs }, null, 1));
await browser.close();
