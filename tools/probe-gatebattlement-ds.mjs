#!/usr/bin/env node
/**
 * Does the gatehouse publish a battlement, and can the men beside it shoot across it?
 *
 * Three instruments, and they are deliberately independent because the defect has three
 * faces and a fix could move one without moving the others.
 *
 *  1. **The stone.** `CitySystem.masonryTopAt` is what every projectile is swept against.
 *     Along an ordinary bay's parapet it alternates merlon and crenel — that alternation is
 *     the battlement, as far as the sim is concerned. This walks the same line across the
 *     gatehouse and reports how many distinct heights come back. **One** distinct height
 *     over 25 m means the crenellation the gatehouse actually carries in stone is modelled
 *     as a solid parapet, and a shot from the bay next door breaks on it where in stone it
 *     would go through a gap.
 *  2. **The record.** `CitySystem.embrasureAt` is what a garrison's own shot reads to find
 *     its release point. This walks each bay near the gate at 0.25 m and reports the run
 *     over which it answers `null`, and how much of that run is *garrisonable bay* rather
 *     than the flagged gate bay.
 *  3. **The consequence.** With the assault running, `Projectiles.report().skips
 *     .noBattlement` counts every garrison shot discarded because the city said there was
 *     no battlement where the shooter stood. Alongside it, kills credited to the garrison
 *     units the scenario posts nearest the gate, against the ones further along — the
 *     number that says whether the fix reached the battle rather than only the geometry.
 *
 * The block's own offset band is found by scanning across the wall's normal rather than by
 * reading a constant, so this measures whatever is there.
 *
 *   node tools/probe-gatebattlement-ds.mjs --port=5437 --map=campus-martius --seconds=240
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5437);
const MAP = args.get('map') ?? 'campus-martius';
const SECONDS = Number(args.get('seconds') ?? 240);
const QUALITY = args.get('quality') ?? 'high';
const SEED = args.get('seed') ?? '';
const JSON_OUT = args.get('json') ?? '';

const cfg = { map: MAP, scenario: 'assault', quality: QUALITY };
if (SEED) cfg.seed = Number(SEED);
const token = Buffer.from(JSON.stringify(cfg))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

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

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const url =
  `${base}/?harness=1&w=640&h=360&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${token}`;
console.log(`[probe-gatebattlement] ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 300)}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, {
  timeout: 300000,
  polling: 250,
});

// ---- 1 and 2: geometry, before a single tick is run -------------------------
const geom = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const city = ctx.get('city');
  const bays = city.getGarrisonBays();
  const gates = city.getGates();
  const gate = gates[0];
  const r = { gate: { id: gate.id, x: +gate.x.toFixed(2), z: +gate.z.toFixed(2) } };

  const gateBay = bays.find((b) => b.isGate) ?? bays[0];
  const lo = Math.max(0, bays.indexOf(gateBay) - 2);
  const hi = Math.min(bays.length - 1, bays.indexOf(gateBay) + 2);
  const near = bays.slice(lo, hi + 1);

  r.bays = near.map((b) => ({
    index: b.index,
    x0: +b.x0.toFixed(1),
    x1: +b.x1.toFixed(1),
    isGate: b.isGate,
    garrisonable: b.garrisonable,
    walkable: b.walkable,
    walkY: +b.walkY.toFixed(2),
    sillY: +b.sillY.toFixed(2),
    crestY: +b.crestY.toFixed(2),
    parapetInner: +b.parapetInner.toFixed(2),
    parapetOuter: +b.parapetOuter.toFixed(2),
    halfThickness: +b.halfThickness.toFixed(2),
    outerOff: +b.outerOff.toFixed(2),
  }));

  /**
   * Cross-section of the masonry at the gate axis, along the wall's outward normal.
   * The gatehouse shows up as a plateau reaching further out than any bay's own
   * `halfThickness`, and its merlon band is wherever that plateau's top sits.
   */
  const b0 = gateBay;
  const atOff = (t, off) => ({
    x: b0.x0 + b0.dx * t + b0.nx * off,
    z: b0.z0 + b0.dz * t + b0.nz * off,
  });
  const tGate = (gate.x - b0.x0) * b0.dx + (gate.z - b0.z0) * b0.dz;
  const cross = [];
  for (let off = -9; off <= 9; off += 0.25) {
    const p = atOff(tGate, off);
    cross.push({ off: +off.toFixed(2), top: +city.masonryTopAt(p.x, p.z).toFixed(3) });
  }
  r.crossSection = cross;
  const solid = cross.filter((c) => c.top > -1e5);
  r.blockTopY = solid.length ? Math.max(...solid.map((c) => c.top)) : null;
  r.blockOffFrom = solid.length ? solid[0].off : null;
  r.blockOffTo = solid.length ? solid[solid.length - 1].off : null;

  /**
   * Along-run scans. Two offsets: the *bay's* parapet band (where its own merlons are)
   * and the outermost solid offset found above (where the gatehouse's merlons are).
   */
  const scanAlong = (off, label) => {
    const tops = [];
    const emb = [];
    for (const b of near) {
      const n = Math.round(b.length / 0.25);
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * b.length;
        const x = b.x0 + b.dx * t + b.nx * off;
        const z = b.z0 + b.dz * t + b.nz * off;
        tops.push({ bay: b.index, x: +x.toFixed(2), top: +city.masonryTopAt(x, z).toFixed(3) });
        const e = city.embrasureAt(x, z);
        emb.push({ bay: b.index, x: +x.toFixed(2), has: e !== null, walkY: e ? +e.walkY.toFixed(2) : null });
      }
    }
    return { label, off, tops, emb };
  };
  const bayOff = (b0.parapetInner + b0.parapetOuter) * 0.5;
  r.alongBayParapet = scanAlong(+bayOff.toFixed(2), 'bay parapet band');
  const siege = window.__game.battle.siege;
  r.alongBlockFace = scanAlong(
    r.blockOffTo !== null ? +(r.blockOffTo - 0.5).toFixed(2) : bayOff,
    'gatehouse merlon band',
  );

  /**
   * **Can a man on one side of the gatehouse see a man on the other?**
   *
   * The station-to-station line of sight, swept against `masonryTopAt` at 0.5 m — the same
   * surface every projectile in the game is swept against. Both endpoints are a real
   * `Siege` station at its rank-0 offset, raised to a shooter's shoulder, so this is not a
   * geometric abstraction: it is the pair of men, and the question is whether the gatehouse
   * frontage between them is a battlement or a wall.
   *
   * Only pairs that straddle the block are counted. A pair on the same side of it is not
   * shooting across anything.
   */
  const SHOULDER = 1.45;
  const los = { pairs: 0, clear: 0, blockedByGate: 0, blockedElsewhere: 0 };
  if (siege && siege.sx) {
    const st = [];
    for (let i = 0; i < siege.sx.length; i++) {
      const gt = (siege.sx[i] - gate.x) * b0.dx + (siege.sz[i] - gate.z) * b0.dz;
      if (Math.abs(gt) > 70) continue;
      const off = siege.sFace[i];
      st.push({
        x: siege.sx[i] + siege.snx[i] * off,
        z: siege.sz[i] + siege.snz[i] * off,
        y: siege.sy[i] + SHOULDER,
        gt,
      });
    }
    const gHalf = 12.5;
    for (const a of st) {
      for (const b of st) {
        // West of the block to east of it, once per ordered pair that straddles it.
        if (!(a.gt < -gHalf && b.gt > gHalf)) continue;
        los.pairs++;
        // **The gatehouse's own contribution, not the first thing in the way.** The first
        // revision of this test stopped at the first obstruction and reported the gatehouse
        // blocking 48 pairs of 2,832 — because a flat ray along a crenellated wall is
        // stopped by the *next bay's merlon* long before it reaches the gate, so the wall
        // masked the thing being measured. What matters here is whether the gatehouse
        // frontage is opaque to a line that reaches it, so the whole path is walked and the
        // segment inside the block is judged on its own.
        let hitGate = false;
        let hitOther = false;
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
        for (let k = 1; k < n; k++) {
          const u = k / n;
          const px = a.x + (b.x - a.x) * u;
          const pz = a.z + (b.z - a.z) * u;
          const py = a.y + (b.y - a.y) * u;
          if (city.masonryTopAt(px, pz) <= py) continue;
          const tt = (px - gate.x) * b0.dx + (pz - gate.z) * b0.dz;
          if (Math.abs(tt) <= gHalf) hitGate = true;
          else hitOther = true;
        }
        if (hitGate) los.blockedByGate++;
        if (!hitGate && !hitOther) los.clear++;
        if (!hitGate && hitOther) los.blockedElsewhere++;
      }
    }
  }
  r.los = los;

  // Siege's own stations, and how many of them fall inside the block's plan footprint.
  const stations = [];
  if (siege && siege.sx) {
    for (let i = 0; i < siege.sx.length; i++) {
      const x = siege.sx[i];
      const z = siege.sz[i];
      if (Math.abs(x - gate.x) > 40) continue;
      stations.push({
        x: +x.toFixed(2),
        y: +siege.sy[i].toFixed(2),
        bay: siege.sBay ? siege.sBay[i] : -1,
        // The city's own answer where this man will stand, at his rank-0 offset.
        emb: city.embrasureAt(x + siege.snx[i] * siege.sFace[i], z + siege.snz[i] * siege.sFace[i]) !== null,
      });
    }
  }
  r.stationsNearGate = stations;
  return r;
});

const nulls = (scan) => {
  const bad = scan.emb.filter((e) => !e.has);
  const byBay = new Map();
  for (const e of bad) byBay.set(e.bay, (byBay.get(e.bay) ?? 0) + 1);
  return { count: bad.length, metres: +(bad.length * 0.25).toFixed(2), byBay: [...byBay] };
};
const distinct = (scan, x0, x1) => {
  const s = new Set(scan.tops.filter((t) => t.x >= x0 && t.x <= x1).map((t) => t.top.toFixed(2)));
  return s.size;
};

console.log(`\n== ${MAP} ==  gate ${geom.gate.id} at x ${geom.gate.x}`);
console.log('\nbays around the gate');
console.log('  idx      x0      x1  gate  garr  walk   walkY   sillY  crestY  pIn   pOut  halfT');
for (const b of geom.bays) {
  console.log(
    `  ${String(b.index).padStart(3)} ${String(b.x0).padStart(7)} ${String(b.x1).padStart(7)} ` +
      `${String(b.isGate).padStart(5)} ${String(b.garrisonable).padStart(5)} ${String(b.walkable).padStart(5)} ` +
      `${b.walkY.toFixed(2).padStart(7)} ${b.sillY.toFixed(2).padStart(7)} ${b.crestY.toFixed(2).padStart(7)} ` +
      `${b.parapetInner.toFixed(2).padStart(5)} ${b.parapetOuter.toFixed(2).padStart(6)} ${b.halfThickness.toFixed(2).padStart(6)}`,
  );
}
console.log(
  `\ngatehouse cross-section: solid from off ${geom.blockOffFrom} to ${geom.blockOffTo}, ` +
    `top ${geom.blockTopY}`,
);

const gx = geom.gate.x;
for (const scan of [geom.alongBayParapet, geom.alongBlockFace]) {
  const overBlock = distinct(scan, gx - 12, gx + 12);
  const overBay = distinct(scan, gx - 45, gx - 20);
  const n = nulls(scan);
  console.log(
    `\n${scan.label} (off ${scan.off}):\n` +
      `   distinct masonryTopAt heights over the 24 m at the gate: ${overBlock}  ` +
      `(an ordinary 25 m of curtain 20 m away: ${overBay})\n` +
      `   embrasureAt is null over ${n.metres} m of the ${(geom.bays.length * 35.5).toFixed(0)} m scanned; by bay ${JSON.stringify(n.byBay)}`,
  );
}

console.log(
  `\nline of sight across the gatehouse, station to station at shoulder height:\n` +
    `   ${geom.los.pairs} straddling pairs — clear ${geom.los.clear}` +
    ` (${geom.los.pairs ? ((geom.los.clear / geom.los.pairs) * 100).toFixed(1) : '-'}%),` +
    ` stopped by the gatehouse ${geom.los.blockedByGate},` +
    ` stopped by other masonry ${geom.los.blockedElsewhere}`,
);

const st = geom.stationsNearGate;
const stBad = st.filter((s) => !s.emb);
console.log(
  `\nSiege stations within 40 m of the gate: ${st.length}, of which ${stBad.length} ` +
    `(${((stBad.length / Math.max(1, st.length)) * 100).toFixed(0)}%) stand where the city ` +
    'publishes no battlement',
);
if (stBad.length) {
  const bys = new Map();
  for (const s of stBad) bys.set(s.bay, (bys.get(s.bay) ?? 0) + 1);
  console.log(`   by bay: ${JSON.stringify([...bys])}`);
}

// ---- 3: the consequence -----------------------------------------------------
console.log(`\nrunning the assault ${SECONDS} s…`);
await page.evaluate(() => window.__game.engine.stop());
const CHUNK = 40;
for (let t = 0; t < SECONDS; t += CHUNK) {
  await page.evaluate((s) => window.__game.engine.advance(s, 166), Math.min(CHUNK, SECONDS - t));
}

const sim = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const battle = window.__game.battle;
  const proj = ctx.get('projectiles');
  const city = ctx.get('city');
  const gate = city.getGates()[0];
  const rep = proj.debugWallShots ? proj.debugWallShots() : null;
  const flow = ctx.tryGet('battleFlow');
  const units = battle.units
    .filter((u) => battle.siege?.isGarrisoned?.(u.id))
    .map((u) => ({
      id: u.id,
      typeId: u.typeId,
      alive: u.alive,
      initial: u.initialStrength,
      kills: u.kills,
      x: +u.x.toFixed(1),
      dxGate: +Math.abs(u.x - gate.x).toFixed(1),
    }))
    .sort((a, b) => a.dxGate - b.dxGate);
  return {
    t: +ctx.time.simTime.toFixed(1),
    skips: rep?.skips ?? null,
    total: rep?.total ?? null,
    garrison: units,
    strength: { ...battle.strength },
    objective: flow?.objective ?? null,
    result: flow?.result ?? null,
  };
});

console.log(`\nafter ${sim.t} s`);
console.log(`  skips: ${JSON.stringify(sim.skips)}`);
console.log(`  total: ${JSON.stringify(sim.total)}`);
console.log('\n  garrison units, nearest the gate first');
console.log('   dx    name                        alive/initial   kills');
for (const u of sim.garrison) {
  console.log(
    `  ${String(u.dxGate).padStart(5)}  ${u.typeId.padEnd(26)} ${String(u.alive).padStart(5)}/${String(u.initial).padEnd(5)} ` +
      `${String(u.kills).padStart(7)}`,
  );
}
const nearK = sim.garrison.filter((u) => u.dxGate <= 60).reduce((s, u) => s + u.kills, 0);
const farK = sim.garrison.filter((u) => u.dxGate > 60).reduce((s, u) => s + u.kills, 0);
const nearN = sim.garrison.filter((u) => u.dxGate <= 60).length;
const farN = sim.garrison.filter((u) => u.dxGate > 60).length;
console.log(
  `\n  kills within 60 m of the gate: ${nearK} over ${nearN} unit(s) = ` +
    `${nearN ? (nearK / nearN).toFixed(1) : '-'} each;  beyond: ${farK} over ${farN} = ` +
    `${farN ? (farK / farN).toFixed(1) : '-'} each`,
);
console.log(`  enemy strength: ${JSON.stringify(sim.strength)}`);
console.log(`  objective: ${JSON.stringify(sim.objective)}`);
console.log(`  result: ${JSON.stringify(sim.result)}`);

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
} else {
  console.log('\nno page errors');
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ geom, sim }, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}

await browser.close();
if (server) {
  server.kill('SIGTERM');
  console.log(`• killed vite pid ${server.pid}`);
}
