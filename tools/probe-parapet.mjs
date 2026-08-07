#!/usr/bin/env node
/**
 * Where does a garrison's arrow actually die?
 *
 * The diagnosis arm of the merlon/embrasure workstream. It reads only — no unit is spawned,
 * no order is issued, no system is stubbed — so the census it prints is of the scenario the
 * player would see, and the same invocation re-run after a fix is a fair A/B.
 *
 * Three instruments, deliberately independent, because the rule on this project is that a
 * number which cannot be true given its neighbour is the best bug detector we have:
 *
 *   1. `projectiles.debugWallShots()`  — per-rank fate of every shot loosed from a walkway.
 *   2. `projectiles.debugProjectiles()` — per-weapon census, including `unreachable`, which
 *      is the counter that says whether the lofted-solve guard is refusing shots.
 *   3. `battle.strength[faction]`      — the attacker's headcount, sampled at both ends of
 *      the window. Kills read off the census must show up here too.
 *
 * The parapet profile is measured from the running game (`city.getGarrisonBays()` and
 * `city.masonryTopAt`), never from the source constants: the whole reason the merlon
 * question is open is that what the geometry builds and what the collider tests were derived
 * twice, and a probe that re-derives what it is testing cannot fail.
 *
 * Usage:
 *   node tools/probe-parapet.mjs --port=5301
 *   node tools/probe-parapet.mjs --port=5301 --map=carthage --warm=45 --window=60
 *   node tools/probe-parapet.mjs --port=5301 --json=/tmp/rome.json
 *
 * Requires a dev server you started on `--port`. It does NOT start one: a probe that falls
 * back to a stale `dist/` reports numbers from a tree nobody is editing, and that has cost
 * this project a day. The provenance line at the top of the output is the check — if it says
 * UNRECOGNISED, stop.
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5301);
const MAP = args.get('map') ?? 'rome';
const SCENARIO = args.get('scenario') ?? 'assault';
const QUALITY = args.get('quality') ?? 'ultra';
/** Seconds of sim advanced before the census is reset — the garrison must be engaged first. */
const WARM = Number(args.get('warm') ?? 60);
/** Seconds of the measured window. */
const WINDOW = Number(args.get('window') ?? 60);
/** Sim seconds per `advance` call. `engine.advance(s, 166)` is exact and 4x `__game.advance`. */
const CHUNK = Number(args.get('chunk') ?? 5);
const JSON_OUT = args.get('json') ?? null;
const TIMEOUT = Number(args.get('timeout') ?? 240000);

const base = `http://127.0.0.1:${PORT}`;

/**
 * The map is chosen by a base64 `?battle=` token, as every other probe on this project does.
 * `?map=carthage` loads a clean page that never starts a battle — an earlier agent lost a run
 * to it. See tools/probe-boot-carthage.mjs.
 */
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const url =
  `${base}/?harness=1&quality=${QUALITY}&autoplay=0&scenario=${SCENARIO}` +
  `&w=640&h=400&battle=${token}`;

// ---- provenance -----------------------------------------------------------------------
// Which *source* is on the wire, not which directory was asked for. The dev server
// transpiles from disk on request, so fetching the module and looking for a marker is the
// only statement about provenance that cannot be wrong.
const served = await fetch(`${base}/src/sim/Projectiles.ts`).then((r) => r.text()).catch(() => '');
if (!served) {
  console.error(`FATAL: nothing served at ${base}/src/sim/Projectiles.ts — is vite up on ${PORT}?`);
  process.exit(2);
}
const fingerprint = !served.includes('debugWallShots')
  ? 'UNRECOGNISED — no debugWallShots in the served source; every number below is void'
  : served.includes('embrasureAt')
    ? 'AFTER arm — debugWallShots + embrasureAt (the aim solve knows about the crenels)'
    : 'BEFORE arm — debugWallShots only, no embrasureAt';
console.log(`source:      ${base}  (dev server started outside this probe)`);
console.log(`served tree: ${fingerprint}  (${served.length} bytes of src/sim/Projectiles.ts)`);
console.log(`url:         ${url}`);
console.log(`plan:        map=${MAP} scenario=${SCENARIO} warm=${WARM}s window=${WINDOW}s chunk=${CHUNK}s`);
if (!served.includes('debugWallShots')) process.exit(2);

const browser = await chromium.launch({
  // Without ANGLE-on-Metal chromium software-rasterises and the boot looks exactly like a
  // hang. That cost an agent an hour.
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(`${m.type()}: ${t}`);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: TIMEOUT });
} catch (e) {
  console.error(`FATAL: __game.ready never became true after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const l of logs.slice(-40)) console.error(`  console ${l}`);
  await browser.close();
  process.exit(3);
}
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (errors.length) {
  console.log(`page errors during boot (${errors.length}):`);
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

/** Advance the sim in chunks, so a long window does not sit inside one 240 s evaluate. */
const advance = async (seconds) => {
  let left = seconds;
  while (left > 1e-6) {
    const step = Math.min(CHUNK, left);
    await page.evaluate((s) => window.__game.engine.advance(s, 166), step);
    left -= step;
  }
};

/**
 * Who is standing, who is elevated, and who has killed whom.
 *
 * `u.kills` is `BattleSystem.damage`'s own attribution counter — it increments on the unit
 * that owned the projectile or the blade — so a before/after pair of these separates *kills
 * by the garrison* from *deaths of the garrison*. That distinction turned out to matter:
 * `segmentVisit` has no faction test, so a projectile hits whoever is on its line.
 *
 * `aliveAt` is counted off the pool rather than read off `u.alive`, so the headcount does not
 * depend on `updateUnitCohesion` having run this tick.
 */
const snapshot = async () =>
  page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const perFaction = {};
    const units = [];
    let elevatedAlive = 0;
    for (const u of b.units) {
      const f = u.faction;
      perFaction[f] ??= { units: 0, alive: 0, poolAlive: 0, elevated: 0, kills: 0, elevAmmo: 0 };
      perFaction[f].units++;
      perFaction[f].alive += u.alive;
      perFaction[f].kills += u.kills ?? 0;
      let elev = 0;
      let poolAlive = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        poolAlive++;
        if (b.elevated[i] !== 0) { elev++; perFaction[f].elevAmmo += p.ammo[i]; }
      }
      perFaction[f].poolAlive += poolAlive;
      perFaction[f].elevated += elev;
      elevatedAlive += elev;
      units.push({
        id: u.id, type: u.typeId, faction: f, alive: u.alive, poolAlive,
        elevated: elev, kills: u.kills ?? 0, destroyed: !!u.destroyed,
      });
    }
    // Rank histogram over living elevated men, split by faction — the denominator for the
    // per-rank table, and the check on whether an attacker on a ladder is polluting it.
    const rankHist = {};
    for (const u of b.units) {
      for (const i of u.members) {
        if (!p.aliveAt(i) || b.elevated[i] === 0) continue;
        const r = p.rank[i];
        const k = `f${u.faction}r${r >= 0 && r < 5 ? r : 'X'}`;
        rankHist[k] = (rankHist[k] ?? 0) + 1;
      }
    }
    return {
      strength: { ...b.strength },
      wallKills: b.siege?.wallKills ?? null,
      perFaction,
      units,
      elevatedAlive,
      rankHist,
    };
  });

const census = async () =>
  page.evaluate(() => {
    const pr = window.__game.engine.context.get('projectiles');
    return { wall: pr.debugWallShots(), kinds: pr.debugProjectiles() };
  });

const resetCensus = async () =>
  page.evaluate(() => window.__game.engine.context.get('projectiles').debugResetCensus());

// ---- 4. the parapet profile, measured from the live city -------------------------------
const profile = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.context.tryGet('city');
  if (!city?.getGarrisonBays) return { error: 'no city system / no getGarrisonBays' };
  const bays = city.getGarrisonBays();
  const b = g.battle;
  const p = b.pool;

  // Which bays actually have men on them right now — profile the wall being shot from, not
  // an arbitrary garrisonable bay.
  const occupancy = new Map();
  for (const u of b.units) {
    if (u.destroyed) continue;
    for (const i of u.members) {
      if (!p.aliveAt(i) || b.elevated[i] === 0) continue;
      let best = -1;
      let bestD = 1e9;
      for (const bay of bays) {
        if (!bay.garrisonable) continue;
        const mx = (bay.x0 + bay.x1) * 0.5;
        const mz = (bay.z0 + bay.z1) * 0.5;
        const d = Math.hypot(p.x[i] - mx, p.z[i] - mz);
        if (d < bestD) { bestD = d; best = bay.index; }
      }
      if (best >= 0 && bestD < 40) occupancy.set(best, (occupancy.get(best) ?? 0) + 1);
    }
  }
  const busiest = [...occupancy.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3);

  const describe = (bay, men) => {
    const row = {
      index: bay.index,
      men,
      stage: bay.stage,
      garrisonable: bay.garrisonable,
      walkable: bay.walkable,
      isGate: bay.isGate,
      length: +bay.length.toFixed(2),
      walkY: +bay.walkY.toFixed(3),
      groundY: +bay.groundY.toFixed(3),
      crestY: +bay.crestY.toFixed(3),
      sillY: +bay.sillY.toFixed(3),
      parapetInner: +bay.parapetInner.toFixed(3),
      parapetOuter: +bay.parapetOuter.toFixed(3),
      innerOff: +bay.innerOff.toFixed(3),
      outerOff: +bay.outerOff.toFixed(3),
      halfThickness: +bay.halfThickness.toFixed(3),
      towerHalf: +bay.towerHalf.toFixed(3),
      hasTower: bay.hasTower,
      derived: {
        crestAboveWalk: +(bay.crestY - bay.walkY).toFixed(3),
        sillAboveWalk: +(bay.sillY - bay.walkY).toFixed(3),
        parapetThickness: +(bay.parapetOuter - bay.parapetInner).toFixed(3),
        standingBand: +(bay.outerOff - bay.innerOff).toFixed(3),
        // How far the front rank's chest stands inboard of the parapet's inner face.
        frontRankToParapet: +(bay.parapetInner - bay.outerOff).toFixed(3),
      },
    };
    // ---- crenellation period, sampled off `masonryTopAt` at 0.05 m ----
    // Along the bay's run, at the normal offset of the parapet's mid-thickness, so the
    // sample line is inside the parapet band and not over the walkway.
    const off = (bay.parapetInner + bay.parapetOuter) * 0.5;
    const step = 0.05;
    const n = Math.min(400, Math.floor(bay.length / step));
    const tops = [];
    for (let k = 0; k < n; k++) {
      const s = k * step;
      const x = bay.x0 + bay.dx * s + bay.nx * off;
      const z = bay.z0 + bay.dz * s + bay.nz * off;
      tops.push(+city.masonryTopAt(x, z).toFixed(3));
    }
    // A merlon is anything standing more than 1.3 m over the walk — the same 1.3 m the
    // census classifies `ownMerlon` with, so the two agree by construction.
    const hi = tops.map((t) => (Number.isFinite(t) && t - bay.walkY > 1.3 ? 1 : 0));
    const runs = [];
    let cur = hi[0];
    let len = 0;
    for (let k = 0; k < hi.length; k++) {
      if (hi[k] === cur) { len++; continue; }
      runs.push({ high: cur === 1, m: +(len * step).toFixed(2), startM: +((k - len) * step).toFixed(2) });
      cur = hi[k];
      len = 1;
    }
    runs.push({ high: cur === 1, m: +(len * step).toFixed(2), startM: +((hi.length - len) * step).toFixed(2) });
    // Drop the first and last run: they are clipped by the sample window, not real widths.
    const inner = runs.slice(1, -1);
    const merl = inner.filter((r) => r.high).map((r) => r.m);
    const gaps = inner.filter((r) => !r.high).map((r) => r.m);
    const mean = (a) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null);
    row.crenellation = {
      sampledAtNormalOffset: +off.toFixed(3),
      samples: n,
      distinctTops: [...new Set(tops)].sort((a, c) => a - c).slice(0, 8),
      merlonWidthM: mean(merl),
      gapWidthM: mean(gaps),
      periodM: mean(merl) !== null && mean(gaps) !== null ? +(mean(merl) + mean(gaps)).toFixed(3) : null,
      merlonFraction:
        mean(merl) !== null && mean(gaps) !== null
          ? +((100 * mean(merl)) / (mean(merl) + mean(gaps))).toFixed(1)
          : null,
      // Where the first merlon starts, measured from bay.x0 along the run.
      firstMerlonStartM: inner.find((r) => r.high)?.startM ?? null,
      runs: runs.slice(0, 14),
      // Highest and lowest masonry the sample line saw, absolute.
      topMin: +Math.min(...tops.filter(Number.isFinite)).toFixed(3),
      topMax: +Math.max(...tops.filter(Number.isFinite)).toFixed(3),
    };
    return row;
  };

  return {
    bayCount: bays.length,
    garrisonableCount: bays.filter((x) => x.garrisonable).length,
    occupiedBays: busiest.map(([i, n]) => ({ index: i, men: n })),
    profiled: busiest.map(([i, n]) => describe(bays.find((x) => x.index === i), n)),
  };
});

// ---- warm up ---------------------------------------------------------------------------
// The garrison must actually be engaged before the census means anything: at t=0 in the
// assault the attacker is still walking. Sampled every chunk so the report can state when
// the first garrison shot left, rather than asserting a warm-up length blind.
const warmTrace = [];
{
  let done = 0;
  while (done < WARM - 1e-6) {
    const step = Math.min(CHUNK, WARM - done);
    await page.evaluate((s) => window.__game.engine.advance(s, 166), step);
    done += step;
    const w = await page.evaluate(() => {
      const pr = window.__game.engine.context.get('projectiles');
      const t = pr.debugWallShots().total;
      const b = window.__game.battle;
      const p = b.pool;
      const alive = {};
      let ammo = 0;
      let ammoN = 0;
      for (const u of b.units) {
        let n = 0;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          n++;
          if (b.elevated[i] !== 0 && u.faction === 0) { ammo += p.ammo[i]; ammoN++; }
        }
        alive[u.faction] = (alive[u.faction] ?? 0) + n;
      }
      return {
        launched: t.launched, hitMan: t.hitMan, killed: t.killed, alive,
        // Mean quiver of the living garrison. The shot rate collapses after the opening
        // half-minute and this is the number that says whether it is ammunition or geometry.
        garrisonAmmo: ammoN ? +(ammo / ammoN).toFixed(2) : null, garrisonN: ammoN,
      };
    });
    warmTrace.push({ t: +done.toFixed(1), ...w });
  }
}
const preShot = await snapshot();

// ---- measure ---------------------------------------------------------------------------
await resetCensus();
const strengthBefore = (await page.evaluate(() => ({ ...window.__game.battle.strength })));
const garrisonBefore = preShot;
await advance(WINDOW);
const after = await census();
const strengthAfter = (await page.evaluate(() => ({ ...window.__game.battle.strength })));
const postShot = await snapshot();

// ---- report ------------------------------------------------------------------------------
const perMin = (n) => +((n * 60) / WINDOW).toFixed(1);
const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : 0);

const T = after.wall.total;
console.log('');
console.log(`=== 1. where a garrison arrow terminates — ${MAP}, ${WINDOW}s window ===`);
console.log(`launched ${T.launched}  (${perMin(T.launched)}/min)`);
const bucket = (k) => `${String(k).padEnd(16)} ${String(T[k]).padStart(6)}  ${String(pct(T[k], T.launched)).padStart(5)}%  ${String(perMin(T[k])).padStart(7)}/min`;
for (const k of ['hitMan', 'killed', 'intoGround', 'ownMerlon', 'ownSill', 'ownWalkway', 'ownCurtainFace', 'farMasonry', 'selfWall']) {
  console.log('  ' + bucket(k));
}
const accounted = T.hitMan + T.intoGround + T.selfWall + T.farMasonry;
console.log(`  accounted ${accounted} / ${T.launched} (${pct(accounted, T.launched)}%) — remainder still in flight or expired`);

console.log('');
console.log('=== 2. per rank on the walkway ===');
console.log('rank  launched  hitMan  killed  ground  merlon   sill   walk  curtain  farMas  selfLife  self%');
for (const r of after.wall.byRank) {
  const self = r.ownMerlon + r.ownSill + r.ownWalkway + r.ownCurtainFace;
  console.log(
    `${String(r.rank).padEnd(5)} ${String(r.launched).padStart(8)} ${String(r.hitMan).padStart(7)} ` +
      `${String(r.killed).padStart(7)} ${String(r.intoGround).padStart(7)} ${String(r.ownMerlon).padStart(7)} ` +
      `${String(r.ownSill).padStart(6)} ${String(r.ownWalkway).padStart(6)} ${String(r.ownCurtainFace).padStart(8)} ` +
      `${String(r.farMasonry).padStart(7)} ${String(r.meanSelfLifeS ?? '-').padStart(9)} ${String(pct(self, r.launched)).padStart(6)}%`
  );
}
console.log(`living elevated men by rank (denominator): ${JSON.stringify(postShot.rankHist)}`);

console.log('');
console.log('=== 3. the lofted solve: is the guard firing? ===');
const kindsFiring = after.kinds.kinds.filter((k) => k.launched > 0 || k.unreachable > 0);
console.log('kind          arc/maxRangeM  launched  unreachable  hitMan  killed  ground  masonry  meanMissM');
for (const k of kindsFiring) {
  console.log(
    `${String(k.kind).padEnd(13)} ${String(k.maxRangeM).padStart(13)} ${String(k.launched).padStart(9)} ` +
      `${String(k.unreachable).padStart(12)} ${String(k.hitMan).padStart(7)} ${String(k.killed).padStart(7)} ` +
      `${String(k.intoGround).padStart(7)} ${String(k.intoMasonry).padStart(8)} ${String(k.meanMissM ?? '-').padStart(10)}`
  );
}

console.log('');
console.log('=== 4. parapet profile, read off the live city ===');
console.log(JSON.stringify(profile, null, 1));

console.log('');
console.log('=== 5. kills per minute from the wall, three instruments ===');
console.log(`census:    killed ${T.killed} = ${perMin(T.killed)}/min   arrivals(hitMan) ${T.hitMan} = ${perMin(T.hitMan)}/min`);
console.log(`siege:     wallKills ${garrisonBefore.wallKills} -> ${postShot.wallKills}  (delta ${postShot.wallKills - garrisonBefore.wallKills} = ${perMin(postShot.wallKills - garrisonBefore.wallKills)}/min)`);
const drop = {};
for (const f of Object.keys(strengthBefore)) drop[f] = strengthBefore[f] - strengthAfter[f];
console.log(`strength:  before ${JSON.stringify(strengthBefore)}  after ${JSON.stringify(strengthAfter)}  drop ${JSON.stringify(drop)}`);

// Pool-truth headcount and per-unit kill attribution: who killed, and who died.
const byId = new Map(garrisonBefore.units.map((u) => [u.id, u]));
const killRows = [];
const factionKills = {};
const factionDeaths = {};
for (const a of postShot.units) {
  const b0 = byId.get(a.id);
  const dk = a.kills - (b0?.kills ?? 0);
  const dd = (b0?.poolAlive ?? a.poolAlive) - a.poolAlive;
  factionKills[a.faction] = (factionKills[a.faction] ?? 0) + dk;
  factionDeaths[a.faction] = (factionDeaths[a.faction] ?? 0) + dd;
  if (dk !== 0 || dd !== 0) {
    killRows.push({ id: a.id, type: a.type, f: a.faction, elevated: a.elevated, kills: dk, died: dd });
  }
}
console.log('');
console.log('per-unit over the window (kills = BattleSystem.damage attribution; died = pool headcount):');
console.log('  id  type                 f  elev  kills  died');
for (const r of killRows.sort((x, y) => y.kills - x.kills)) {
  console.log(
    `  ${String(r.id).padStart(2)}  ${String(r.type).padEnd(20)} ${r.f}  ${String(r.elevated).padStart(4)}  ` +
      `${String(r.kills).padStart(5)}  ${String(r.died).padStart(4)}`
  );
}
console.log(`faction kills ${JSON.stringify(factionKills)}   faction deaths ${JSON.stringify(factionDeaths)}`);
console.log(`per minute:   kills ${JSON.stringify(Object.fromEntries(Object.entries(factionKills).map(([f, v]) => [f, perMin(v)])))}` +
  `   deaths ${JSON.stringify(Object.fromEntries(Object.entries(factionDeaths).map(([f, v]) => [f, perMin(v)])))}`);
const garrisonIds = new Set(garrisonBefore.units.filter((u) => u.elevated > 0 && u.faction === 0).map((u) => u.id));
const garrisonKills = killRows.filter((r) => garrisonIds.has(r.id)).reduce((s, r) => s + r.kills, 0);
console.log(`garrison units (faction 0, elevated) killed ${garrisonKills} = ${perMin(garrisonKills)}/min`);
console.log(`garrison:  ${garrisonBefore.elevatedAlive} elevated men at census reset, ${postShot.elevatedAlive} at end`);
console.log(`per faction at reset: ${JSON.stringify(garrisonBefore.perFaction)}`);
console.log(`per faction at end:   ${JSON.stringify(postShot.perFaction)}`);
console.log(`shots per elevated faction-0 man per minute: ${(garrisonBefore.perFaction['0']?.elevated ? (T.launched * 60) / WINDOW / garrisonBefore.perFaction['0'].elevated : 0).toFixed(2)}`);
console.log(`elevated by faction/rank at end: ${JSON.stringify(postShot.rankHist)}`);
console.log(`warm trace (cumulative wall shots at each ${CHUNK}s of the ${WARM}s warm-up):`);
for (const w of warmTrace) console.log(`   t=${String(w.t).padStart(5)}s  launched ${String(w.launched).padStart(5)}  hitMan ${String(w.hitMan).padStart(4)}  killed ${String(w.killed).padStart(4)}  garrisonAmmo ${String(w.garrisonAmmo).padStart(6)} x${String(w.garrisonN).padStart(4)}  alive ${JSON.stringify(w.alive)}`);

if (errors.length) {
  console.log('');
  console.log(`page errors over the whole run (${errors.length}):`);
  for (const e of errors.slice(0, 12)) console.log(`  ${e}`);
}

if (JSON_OUT) {
  await writeFile(
    JSON_OUT,
    JSON.stringify(
      { map: MAP, scenario: SCENARIO, warm: WARM, window: WINDOW, url, profile, wall: after.wall, kinds: after.kinds.kinds, strengthBefore, strengthAfter, garrisonBefore, postShot, warmTrace, errors },
      null,
      1
    )
  );
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
