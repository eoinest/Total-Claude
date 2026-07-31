#!/usr/bin/env node
/**
 * Numerical acceptance tests for siege mechanics.
 *
 * A screenshot cannot show whether a man is standing *on* a wall-walk or hovering ten
 * centimetres above it, sunk into the masonry, or standing on the terrain 8 m below with
 * the wall drawn in front of him. That is what this measures. Every assertion here is a
 * number with a tolerance, taken from the live simulation through `window.__game`.
 *
 * Usage:
 *   node tools/probe-siege.mjs --port=5252
 *   node tools/probe-siege.mjs --port=5252 --json
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  })
);

const PORT = Number(args.get('port') ?? 5252);
const QUALITY = args.get('quality') ?? 'ultra';
const AS_JSON = args.has('json');
const ROOT = resolve(process.cwd());

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream',
  '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

/**
 * Reuse a running dev server if one answers, otherwise serve `dist/`.
 *
 * The dev server is detected by asking for a source module, not for `/`. A vite server
 * that is mid-recompile still answers `/` with an index page while returning 500 for every
 * module behind it, and the first version of this probe took that as "no dev server", fell
 * through to `dist/`, and silently measured a build several hours old — reporting that the
 * garrison API did not exist and that the assault scenario had not deployed, both of which
 * were true of that build and of nothing else. A stale pass is worse than a failure.
 */
async function ensureServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      console.log(`• using the dev server at ${base}`);
      return { base, close: () => {}, live: true };
    }
    console.error(`! dev server at ${base} answered ${r.status} for /src/main.ts — it is ` +
      'mid-compile or another workstream has broken a module. Refusing to fall back to a ' +
      'stale dist/; fix the server and re-run.');
    process.exit(2);
  } catch {
    /* fall through to the static server */
  }
  console.log('• no dev server; serving dist/ (which may be stale)');
  const dist = join(ROOT, 'dist');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') p = join(dist, 'index.html');
    try {
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((ok) => server.listen(PORT + 1, ok));
  return { base: `http://127.0.0.1:${PORT + 1}`, close: () => server.close(), live: false };
}

// ---------------------------------------------------------------------------

const checks = [];
/** Record one assertion. `ok` decides pass/fail; `detail` is printed either way. */
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

function report() {
  const pass = checks.filter((c) => c.ok).length;
  if (AS_JSON) {
    console.log(JSON.stringify({ pass, total: checks.length, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}\n          ${c.detail}`);
    }
    console.log(`\n${pass}/${checks.length} assertions passed`);
  }
  return pass === checks.length;
}

// ---------------------------------------------------------------------------

let browser = null;
let srv = null;
try {
  srv = await ensureServer();
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const url = `${srv.base}/?harness=1&quality=${QUALITY}&w=1280&h=720&scenario=assault`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, {}, { timeout: 180000 });

  // Fail fast and loudly on a build that predates this work, rather than reporting eight
  // confusing failures that all mean "you measured the wrong bytes".
  const fresh = await page.evaluate(() => {
    const c = window.__game.engine.context.tryGet('city');
    return {
      city: !!(c && typeof c.getGarrisonBays === 'function'),
      siege: !!window.__game.battle.siege,
      scenario: new URLSearchParams(location.search).get('scenario'),
    };
  });
  if (!fresh.city || !fresh.siege) {
    console.error(`! the page is running a build without the siege systems ` +
      `(city API ${fresh.city}, battle.siege ${fresh.siege}). Stale bundle — not a test failure.`);
    process.exit(3);
  }

  // -----------------------------------------------------------------------
  // 1. Wall geometry: what does the city actually report?
  // -----------------------------------------------------------------------
  const geo = await page.evaluate(() => {
    const city = window.__game.engine.context.get('city');
    const bays = city.getGarrisonBays ? city.getGarrisonBays() : null;
    return {
      hasApi: !!bays,
      segments: city.getWallSegments().length,
      bays: bays ? bays.map((b) => ({
        index: b.index, stage: b.stage, walkY: b.walkY, isGate: b.isGate,
        x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1,
        groundY: b.groundY, innerOff: b.innerOff, outerOff: b.outerOff,
        garrisonable: b.garrisonable,
      })) : [],
    };
  });

  check('city exposes a garrison-bay API',
    geo.hasApi,
    geo.hasApi ? `${geo.bays.length} bays, ${geo.segments} wall segments`
      : 'CitySystem.getGarrisonBays() is missing');

  if (geo.hasApi) {
    const g = geo.bays.filter((b) => b.garrisonable);
    const rises = g.map((b) => b.walkY - b.groundY);
    // The bays that actually matter: the ones either side of the gate, which is where the
    // assault goes and the only place a siege tower has to be able to reach. The circuit as
    // a whole crosses forty metres of hillside and some bays are legitimately enormous.
    const gateIdx = geo.bays.findIndex((b) => b.isGate);
    const near = g.filter((b) => Math.abs(b.index - gateIdx) <= 5);
    const nearRise = near.map((b) => b.walkY - b.groundY);
    check('the assaulted bays stand a storm-able height above their own ground',
      near.length > 0 && Math.min(...nearRise) > 4 && Math.max(...nearRise) < 14,
      `${near.length} bays within 5 of the gate rise ${Math.min(...nearRise).toFixed(2)}..` +
      `${Math.max(...nearRise).toFixed(2)} m; whole circuit ` +
      `${Math.min(...rises).toFixed(2)}..${Math.max(...rises).toFixed(2)} m over ${g.length}/${geo.bays.length} garrisonable bays`);

    // Clear standing band: outer is toward the enemy and is the larger offset.
    const widths = near.map((b) => b.outerOff - b.innerOff);
    check('the assaulted bays have a walkway wide enough for two ranks',
      widths.length > 0 && Math.min(...widths) >= 0.75,
      `clear band ${Math.min(...widths).toFixed(2)}..${Math.max(...widths).toFixed(2)} m ` +
      `(a rank pitch is 0.72 m; ${widths.filter((w) => w >= 1.44).length}/${widths.length} bays take three ranks)`);
  }

  // -----------------------------------------------------------------------
  // 2. Garrison: put men on the wall and measure where their feet are.
  // -----------------------------------------------------------------------
  await page.evaluate(() => window.__game.advance(6));

  const stand = await page.evaluate(() => {
    const b = window.__game.battle;
    const s = b.siege;
    if (!s) return { ok: false };
    const p = b.pool;
    const rows = [];
    for (const u of b.units) {
      if (!s.isGarrisoned(u.id)) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const d = s.probeMan(i);
        rows.push({
          i, unit: u.id, y: p.y[i], surf: d.surfaceY, terr: d.terrainY,
          off: d.lateralOffset, inside: d.insideMasonry, bay: d.bay,
        });
      }
    }
    return { ok: true, rows, count: rows.length };
  });

  if (!stand.ok) {
    check('battle exposes the siege system', false, 'battle.siege is undefined');
  } else {
    const rows = stand.rows;
    check('men are garrisoned on the wall', rows.length > 0, `${rows.length} men reported garrisoned`);

    if (rows.length) {
      const err = rows.map((r) => Math.abs(r.y - r.surf));
      const worst = Math.max(...err);
      const mean = err.reduce((a, v) => a + v, 0) / err.length;
      check('every garrisoned man\'s feet are within 5 cm of the walkway surface',
        worst <= 0.05,
        `worst |y - walkY| = ${(worst * 100).toFixed(2)} cm, mean ${(mean * 100).toFixed(2)} cm over ${rows.length} men`);

      const floating = rows.filter((r) => r.y - r.surf > 0.05).length;
      const sunk = rows.filter((r) => r.surf - r.y > 0.05).length;
      check('nobody floats above or sinks into the masonry',
        floating === 0 && sunk === 0,
        `${floating} floating, ${sunk} sunk`);

      const onGround = rows.filter((r) => Math.abs(r.y - r.terr) < 0.2).length;
      check('no garrisoned man is standing on the terrain instead of the wall',
        onGround === 0,
        `${onGround} men at terrain height; wall stands ${(rows[0].surf - rows[0].terr).toFixed(2)} m above it`);

      const offWorst = Math.max(...rows.map((r) => Math.abs(r.off)));
      check('nobody has walked off the edge of the walkway',
        rows.every((r) => !r.inside) && offWorst <= 1.9,
        `worst lateral offset from the wall centreline ${offWorst.toFixed(2)} m ` +
        `(walkway half-width 1.75 m + 0.15 tolerance)`);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Shooting down: do wall archers kill attackers below?
  // -----------------------------------------------------------------------
  const before = await page.evaluate(() => {
    const b = window.__game.battle;
    return { germ: b.strength[1], rome: b.strength[0], kills: b.siege ? b.siege.wallKills : -1 };
  });
  await page.evaluate(() => window.__game.advance(50));
  const after = await page.evaluate(() => {
    const b = window.__game.battle;
    const s = b.siege;
    return {
      germ: b.strength[1], rome: b.strength[0],
      kills: s ? s.wallKills : -1,
      shots: s ? s.wallShots : -1,
      stats: s ? s.stats() : null,
    };
  });

  check('men on the wall shoot at the enemy below',
    after.shots > 0,
    `${after.shots} missiles released from the wall-walk`);
  check('those shots kill attackers',
    after.kills > 0,
    `${after.kills} attackers killed by wall-top fire; Juthungi ${before.germ} -> ${after.germ}`);

  // -----------------------------------------------------------------------
  // 4. Continuity: nobody teleports or falls.
  // -----------------------------------------------------------------------
  const motion = await page.evaluate(async () => {
    const b = window.__game.battle;
    const p = b.pool;
    const s = b.siege;
    const watch = [];
    for (const u of b.units) {
      if (!s || !s.isGarrisoned(u.id)) continue;
      for (const i of u.members) if (p.aliveAt(i)) watch.push(i);
    }
    let worstJump = 0;
    let worstDrop = 0;
    let jumpIdx = -1;
    const prev = new Map();
    for (const i of watch) prev.set(i, [p.x[i], p.y[i], p.z[i]]);
    for (let step = 0; step < 90; step++) {
      window.__game.advance(1 / 30);
      for (const i of watch) {
        if (!p.aliveAt(i)) continue;
        const q = prev.get(i);
        const d = Math.hypot(p.x[i] - q[0], p.z[i] - q[2]);
        const dy = q[1] - p.y[i];
        if (d > worstJump) { worstJump = d; jumpIdx = i; }
        if (dy > worstDrop) worstDrop = dy;
        prev.set(i, [p.x[i], p.y[i], p.z[i]]);
      }
    }
    return { watched: watch.length, worstJump, worstDrop, jumpIdx };
  });

  // A man may run at most ~6 m/s; one 1/30 s tick is 0.2 m. 0.6 m allows for
  // crowd-separation pushes stacking on top of a full-speed step.
  check('no garrisoned man teleports',
    motion.worstJump < 0.6,
    `worst single-tick horizontal step ${(motion.worstJump * 100).toFixed(1)} cm over ` +
    `${motion.watched} men x 90 ticks (limit 60 cm)`);
  check('no garrisoned man falls off the wall',
    motion.worstDrop < 1.0,
    `worst single-tick descent ${(motion.worstDrop * 100).toFixed(1)} cm (a fall would be >200 cm)`);

  // -----------------------------------------------------------------------
  // 5. Siege towers: ramp lands on the walkway, men cross it.
  // -----------------------------------------------------------------------
  // A tower rolls at 0.42 m/s and starts 74-101 m out, so it needs three to four minutes
  // to arrive. That is the pace the sources give and it is not going to be shortened to
  // suit a test; the test waits instead.
  await page.evaluate(() => window.__game.advance(210));

  const towers = await page.evaluate(() => {
    const s = window.__game.battle.siege;
    return s ? s.towerReport() : null;
  });
  if (!towers) {
    check('siege towers exist', false, 'battle.siege.towerReport() unavailable');
  } else {
    check('siege towers are on the field',
      towers.length > 0,
      towers.map((t) => `#${t.id} ${t.state} at ${t.dist.toFixed(1)} m from the wall`).join('; '));
    const docked = towers.filter((t) => t.docked);
    check('at least one tower has docked against the wall',
      docked.length > 0,
      `${docked.length}/${towers.length} docked`);
    if (docked.length) {
      const worst = Math.max(...docked.map((t) => Math.abs(t.rampY - t.walkY)));
      check('a docked tower\'s ramp lands level with the walkway',
        worst <= 0.35,
        `worst |rampY - walkY| = ${(worst * 100).toFixed(1)} cm across ${docked.length} docked tower(s)`);

      // Boarding takes as long as it takes: one man at a time up an internal stair.
      await page.evaluate(() => window.__game.advance(90));
      const after2 = await page.evaluate(() => window.__game.battle.siege.towerReport());
      const crossed = after2.reduce((a, t) => a + t.crossed, 0);
      const queued = after2.reduce((a, t) => a + t.queued, 0);
      check('infantry cross the ramp onto the wall',
        crossed > 0,
        `${crossed} men across a boarding ramp onto the wall-walk, ${queued} still on the paths`);

      // And once they are up there, they must be on the stonework like anybody else.
      const boarders = await page.evaluate(() => {
        const b = window.__game.battle;
        const s = b.siege;
        const p = b.pool;
        const rows = [];
        for (const u of b.units) {
          if (u.faction !== 1 || !s.isGarrisoned(u.id)) continue;
          for (const i of u.members) {
            if (!p.aliveAt(i)) continue;
            const d = s.probeMan(i);
            if (d.station < 0) continue;
            rows.push({ dy: p.y[i] - d.surfaceY, off: d.lateralOffset });
          }
        }
        return rows;
      });
      if (boarders.length) {
        const worstDy = Math.max(...boarders.map((r) => Math.abs(r.dy)));
        check('men who boarded stand on the walkway as correctly as the garrison does',
          worstDy <= 0.05,
          `${boarders.length} attackers now on the wall, worst |y - walkY| = ${(worstDy * 100).toFixed(2)} cm`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. Artillery and the ram.
  // -----------------------------------------------------------------------
  const engines = await page.evaluate(() => {
    const s = window.__game.battle.siege;
    return s ? { ...s.engineReport(), stats: s.stats() } : null;
  });
  if (engines) {
    check('artillery has fired',
      engines.shots > 0,
      `${engines.shots} artillery shots, ${engines.hits} impacts, ${engines.kills} kills`);
    check('the ram has reached and struck the gate',
      engines.ramBlows > 0,
      `${engines.ramBlows} blows on the gate, gate integrity ${(engines.gateHp * 100).toFixed(0)}%`);
    check('ladders are pitched and men are going up them',
      engines.laddersCrossed > 0,
      `${engines.ladders} ladders, ${engines.laddersCrossed} men over the parapet by escalade`);
  }

  check('no runtime errors', errors.length === 0, errors.slice(0, 4).join(' | ') || 'clean');
} catch (err) {
  check('probe ran to completion', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser?.close();
  srv?.close();
}

process.exit(report() ? 0 : 1);
