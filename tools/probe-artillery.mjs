#!/usr/bin/env node
/**
 * Artillery and missile probe — what each weapon actually emits, and where its shots go.
 *
 * `tools/probe-scorpion.mjs` photographs a machine. This one counts. It exists because the
 * report that started this work — "the scorpion and catapult batteries shoot a volley of arrows
 * instead of their respective items" — is a claim about what is *drawn*, and a still frame
 * cannot separate three completely different causes that all look identical:
 *
 *   1. the wrong weapon was fired (a roster fault),
 *   2. the right weapon was fired and the wrong geometry was chosen (a renderer fault),
 *   3. the right weapon and the right geometry, but N times per machine (an emitter fault).
 *
 * So it counts two things independently: the census of launches by weapon kind, and the
 * instance count of every mesh in the scene whose name begins `projectiles-`. If a battery of
 * four engines launched twelve `bolt`s and all twelve are in one mesh called
 * `projectiles-flight`, faults two and three are both present and can be told apart.
 *
 *   node tools/probe-artillery.mjs --port=5601                 # every case
 *   node tools/probe-artillery.mjs --port=5601 --only=census
 *   node tools/probe-artillery.mjs --port=5601 --only=kills --seconds=120
 *   node tools/probe-artillery.mjs --port=5601 --json=out.json
 *
 * Cases:
 *   meshes     what projectile meshes exist at all, and what geometry each carries
 *   census     one of every missile unit shooting; launches by kind vs instances by mesh
 *   ballistics each kind's physical reach against the range its roster claims, plus traces
 *   kills      each engine against infantry in the open; kills per minute
 *   wall       the assault scenario: where the artillery stands, and what its shots hit
 *   slinger    Balearic slingers vs a legionary cohort; where every stone ends up
 *   timing     does the projectile leave on the machine's release frame?
 *
 * Runs against a tree with no `debugProjectiles()` too — everything degrades to numbers that
 * can be read from the scene graph and from `alive` counts — so the same probe measures the
 * before and the after.
 *
 * FIRST LINE OF OUTPUT tells you whether this measured the live tree or something already
 * listening on the port. A probe that finds nothing on its port silently gets whatever a
 * preview server is serving, which may be a stale `dist/`.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5601);
const ONLY = args.get('only') ? String(args.get('only')).split(',') : null;
const SECONDS = Number(args.get('seconds') ?? 90);
const JSON_OUT = args.get('json') ?? null;
const want = (n) => !ONLY || ONLY.includes(n);
const results = {};

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (await waitForServer(base, 1200)) {
  // Refuse rather than warn. A probe that quietly attaches to whatever is already on its port
  // reports numbers from a tree nobody chose: this run attached to a dev server that had been
  // started in a *different checkout* — because npm resolved the project root through a
  // symlinked `node_modules` — and produced a "before" measurement of the "after" tree. The
  // warning that used to be printed here was read and ignored, which is what warnings are for.
  console.error(`REFUSING TO RUN: something is already listening on ${PORT}.`);
  console.error('  Pick a free port, or stop that server. This probe will not measure a tree it');
  console.error('  did not start, because it cannot tell which one it is from the outside.');
  process.exit(2);
}
// `node node_modules/vite/bin/vite.js`, never `npx`/`npm exec`: npm resolves the package root
// through node_modules and will chdir to a different checkout if that path is a symlink.
server = spawn(process.execPath, [
  path.join(ROOT, 'node_modules/vite/bin/vite.js'),
  // The project root is a positional for `vite dev`, not a `--root` flag.
  ROOT, '--port', String(PORT), '--host', '127.0.0.1', '--strictPort',
], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }

/**
 * Prove which tree is on the other end of the socket.
 *
 * Not "which directory did I ask for" — which *source* is being served. The dev server
 * transpiles from disk on request, so fetching the module and looking for a marker is the only
 * statement about provenance that cannot be wrong.
 */
const served = await fetch(`${base}/src/sim/Projectiles.ts`).then((r) => r.text()).catch(() => '');
// Marker must be a *string literal*, not a `const enum` member: the dev server transpiles
// TypeScript before serving it and inlines const-enum members, so `Visual.Stone` is not in the
// bytes on the wire even though it is in the file. Mesh names are literals and survive.
const fingerprint = served.includes('buildStoneGeometry')
  ? 'POST-FIX (one mesh per projectile class; a stone has its own geometry)'
  : served.includes("'projectiles-flight'")
    ? 'PRE-FIX (a single shaft mesh for every weapon kind)'
    : 'UNRECOGNISED — check this before believing any number below';
console.log(`source: ${base} — vite started by this probe from ${ROOT}`);
console.log(`served tree: ${fingerprint}  (${served.length} bytes of src/sim/Projectiles.ts)`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

/**
 * Load the battlefield and clear it.
 *
 * `scenario=field` rather than the assault, because the field battle leaves the most soldier
 * pool free for the probe's own units — the pool never recycles an index, so every case spends
 * capacity permanently and the page has to be reloaded before it runs out.
 */
const load = async (scenario = 'field') => {
  await page.goto(`${base}/?harness=1&quality=ultra&autoplay=0&scenario=${scenario}&w=640&h=400`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  // Tear the scenario down once per load, exactly as tools/matchup.mjs does: its thousands of
  // men shoot projectiles of their own and no census could attribute them.
  return page.evaluate(async () => {
    const g = window.__game;
    const b = g.battle;
    const ctx = g.engine.context;
    const p = b.pool;
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11 /* Dead */);
      u.alive = 0;
      u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    ctx.tryGet('morale')?.redeploy?.();
    // Otherwise the AI re-orders both units and battle flow calls the battle over on the
    // strength of an army that no longer exists.
    for (const n of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage']) {
      const s = ctx.tryGet(n);
      if (s?.fixedUpdate) s.fixedUpdate = () => {};
    }
    b.unitSizeScale = 1;
    return { free: p.capacity - p.count, capacity: p.capacity };
  });
};

let free = (await load()).free;
console.log(`soldier pool: ${free} indices free after clearing the scenario`);

/** Deploy one case, reloading first if the pool is running out. */
const setup = async (spec, need = 500) => {
  if (free < need) free = (await load()).free;
  const r = await page.evaluate((s) => {
    const g = window.__game;
    const b = g.battle;
    const ctx = g.engine.context;
    const p = b.pool;
    // Retire whatever the previous case left standing.
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11 /* Dead */);
      u.alive = 0;
      u.destroyed = true;
    }
    const ids = [];
    for (const e of s) ids.push(b.spawnUnit(e.type, e.x, e.z, e.facing, e.form ?? 'line'));
    const units = ids.map((id) => b.unitById(id));
    for (let k = 0; k < s.length; k++) {
      const u = units[k];
      if (!u) continue;
      const foe = units.find((x) => x && x.faction !== u.faction);
      if ((s[k].order ?? 'hold') === 'attack' && foe) {
        ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'attack', targetUnitId: foe.id });
      } else {
        ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });
      }
    }
    ctx.get('projectiles').debugResetCensus?.();
    return {
      free: p.capacity - p.count,
      alive: units.map((u) => (u ? { id: u.id, type: u.typeId, alive: u.alive } : null)),
    };
  }, spec);
  free = r.free;
  return r;
};

const advance = async (t) => page.evaluate(async (target) => {
  const g = window.__game;
  const end = g.simTime() + target;
  while (g.simTime() < end - 1e-6) g.advance(Math.min(0.25, end - g.simTime()));
}, t);

/**
 * Every projectile mesh in the scene, with the instances it drew last frame.
 *
 * Works on any tree, which is the point: a build with one flight mesh is drawing every weapon
 * kind with the same model, and that is fault (2) visible in one line without a screenshot.
 */
const meshes = async () => page.evaluate(() => {
  const out = [];
  window.__game.engine.context.scene.traverse((o) => {
    if (!/^projectiles-/.test(o.name || '')) return;
    const geo = o.geometry;
    const tris = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
    out.push({
      name: o.name, count: o.count ?? 0, visible: !!o.visible,
      geometry: geo?.uuid?.slice(0, 8) ?? '-', tris,
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
});

/** The census if the tree has one, plus fallbacks any tree can answer. */
const census = async () => page.evaluate(() => {
  const g = window.__game;
  const pr = g.engine.context.get('projectiles');
  return {
    detail: pr.debugProjectiles ? pr.debugProjectiles() : null,
    inFlight: pr.inFlight, spent: pr.spent, masonryHits: pr.masonryHits,
    units: g.battle.units.filter((u) => !u.destroyed)
      .map((u) => ({ id: u.id, type: u.typeId, alive: u.alive, ammo: u.ammo })),
  };
});

/**
 * Total launches over an interval, counted without a census.
 *
 * Sums the positive part of the change in `inFlight` tick by tick and adds anything that became
 * spent, which is exact unless two projectiles are created and destroyed inside one tick with
 * the count returning to where it started — and at 30 Hz they are not.
 */
const runCounting = async (seconds) => page.evaluate(async (secs) => {
  const g = window.__game;
  const pr = g.engine.context.get('projectiles');
  let launched = 0;
  let prevAir = pr.inFlight;
  let prevSpent = pr.spent;
  // Loop on the *simulation clock*, never on an iteration count.
  //
  // `engine.advance(1/30)` does not reliably advance one fixed tick — measured, a run of 2,700
  // calls covered about 712 s of sim time rather than 90 — and an artillery rate is a claim
  // about seconds, so counting iterations silently multiplied every shots-per-minute figure by
  // about eight. The same trap is recorded in commit 5363ae8 ("the harness clock was charging
  // 5 sim ticks per frame"), so it is the second time it has been paid for.
  const start = g.simTime();
  const end = start + secs;
  let guard = 0;
  while (g.simTime() < end - 1e-6 && guard++ < 400000) {
    g.advance(Math.min(1 / 30, end - g.simTime()));
    const born = (pr.inFlight - prevAir) + Math.max(0, pr.spent - prevSpent);
    if (born > 0) launched += born;
    prevAir = pr.inFlight;
    prevSpent = pr.spent;
  }
  return { launched, elapsed: +(g.simTime() - start).toFixed(2) };
}, seconds);

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------
// 1. What meshes exist at all
// ---------------------------------------------------------------------------
if (want('meshes')) {
  console.log('\n=== projectile meshes in the scene ===');
  await setup([
    { type: 'scorpio', x: 0, z: 0, facing: Math.PI },
    { type: 'onager', x: 30, z: 0, facing: Math.PI },
    { type: 'sagittarii', x: -40, z: 0, facing: Math.PI, form: 'loose' },
    { type: 'balearic-slingers', x: -70, z: 0, facing: Math.PI, form: 'loose' },
    { type: 'legio-cohort', x: 0, z: -140, facing: 0 },
  ], 900);
  await advance(50);
  const m = await meshes();
  results.meshes = m;
  console.log(`  ${pad('mesh', 34)}${num('instances', 10)}${num('tris/inst', 11)}  geometry`);
  for (const r of m) {
    console.log(`  ${pad(r.name, 34)}${num(r.count, 10)}${num(r.tris, 11)}  ${r.geometry}`);
  }
  const distinct = new Set(m.map((r) => r.geometry));
  console.log(`  ${m.length} mesh(es) over ${distinct.size} distinct geometr${distinct.size === 1 ? 'y' : 'ies'}` +
    (distinct.size <= 1 ? '  <-- every weapon kind is drawn with the same model' : ''));
}

// ---------------------------------------------------------------------------
// 2. Census
// ---------------------------------------------------------------------------
if (want('census')) {
  console.log('\n=== census: what each shooter puts in the air ===');
  const cases = [
    // Pairings are cross-faction on purpose. A same-faction pair never shoots — the target
    // search skips `o.faction === u.faction` — and two of these silently measured nothing
    // until the zero showed up next to a unit that plainly does fire.
    ['scorpio', 'juthungi-warband', 200],
    ['carroballista', 'juthungi-warband', 200],
    ['onager', 'legio-cohort', 170],
    ['sagittarii', 'juthungi-warband', 140],
    ['balearic-slingers', 'legio-cohort', 140],
    ['legio-cohort', 'juthungi-warband', 22],
  ];
  results.census = [];
  for (const [shooter, victim, gap] of cases) {
    await setup([
      { type: shooter, x: 0, z: 0, facing: Math.PI, form: 'line' },
      { type: victim, x: 0, z: -gap, facing: 0, form: 'line' },
    ], 700);
    // Long enough for a full cycle of the slowest engine (onager, 37.5 s reload).
    await advance(46);
    const c = await census();
    const live = (await meshes()).filter((r) => r.count > 0);
    console.log(`  ${shooter} -> ${victim} at ${gap} m`);
    const row = { shooter, victim, gap, inFlight: c.inFlight, spent: c.spent, meshes: live, kinds: [] };
    if (c.detail) {
      for (const k of c.detail.kinds) {
        if (k.launched === 0) continue;
        row.kinds.push(k);
        console.log(`    kind=${pad(k.kind, 9)} drawn-as=${pad(k.visual, 7)}` +
          ` launched=${num(k.launched, 5)}  refused-out-of-reach=${num(k.unreachable, 5)}`);
      }
    } else {
      console.log('    (no census on this tree — scene graph only)');
    }
    console.log(`    in air ${c.inFlight}, spent ${c.spent}; meshes carrying instances: ` +
      (live.length ? live.map((r) => `${r.name}=${r.count}`).join(' ') : '(none this frame)'));
    results.census.push(row);
  }
}

// ---------------------------------------------------------------------------
// 3. Ballistics
// ---------------------------------------------------------------------------
if (want('ballistics')) {
  console.log('\n=== ballistics: physical reach against the roster claim ===');
  const claimed = await page.evaluate(async () => {
    const mod = await import('/src/units/roster.ts');
    const out = {};
    for (const t of mod.ALL_UNITS ?? []) {
      if (!t.missile) continue;
      (out[t.missile.kind] ??= []).push({ unit: t.id, range: t.missile.range, arc: t.missile.arc });
    }
    return out;
  }).catch(() => ({}));

  const phys = await page.evaluate(() => {
    const pr = window.__game.engine.context.get('projectiles');
    return pr.debugProjectiles ? pr.debugProjectiles().kinds : null;
  });
  results.ballistics = { claimed, phys };
  if (phys) {
    console.log(`  ${pad('kind', 9)}${pad('drawn', 7)}${num('speed', 7)}${num('size m', 8)}` +
      `${num('reach m', 9)}${num('claimed', 9)}  verdict`);
    for (const k of phys) {
      const cl = claimed[k.kind];
      const worst = cl ? Math.max(...cl.map((c) => c.range)) : null;
      const bad = worst !== null && worst > k.maxRangeM;
      console.log(`  ${pad(k.kind, 9)}${pad(k.visual, 7)}${num(k.speed, 7)}${num(k.length, 8)}` +
        `${num(k.maxRangeM, 9)}${num(worst ?? '-', 9)}  ` +
        (worst === null ? '' : bad
          ? `CANNOT REACH — ${(worst - k.maxRangeM).toFixed(0)} m short of its own roster range`
          : 'reaches'));
    }
  } else {
    console.log('  (no physics table on this tree; reach is inferred from the traces below)');
    for (const [k, v] of Object.entries(claimed)) {
      console.log(`  ${pad(k, 9)} claimed up to ${Math.max(...v.map((c) => c.range))} m` +
        ` (${v.map((c) => c.unit).join(', ')})`);
    }
  }

  console.log('\n  live traces — one shot followed to impact:');
  results.traces = [];
  for (const [shooter, victim, gap] of [
    ['scorpio', 'juthungi-warband', 260],
    ['onager', 'legio-cohort', 200],
    ['sagittarii', 'juthungi-warband', 150],
    ['balearic-slingers', 'legio-cohort', 170],
  ]) {
    await setup([
      { type: shooter, x: 0, z: 0, facing: Math.PI, form: 'line' },
      { type: victim, x: 0, z: -gap, facing: 0, form: 'line' },
    ], 700);
    const tr = await page.evaluate(async () => {
      const g = window.__game;
      const pr = g.engine.context.get('projectiles');
      let apex = -1e9;
      let last = null;
      // Latch onto one slot and follow only that one. Scanning for "the first live
      // projectile" every tick silently hops between shots the moment two are in the air or
      // a slot is recycled, which produced a trace that reported a bolt travelling 30 m.
      let idx = -1;
      let x0 = 0;
      let z0 = 0;
      for (let n = 0; n < 90 * 30; n++) {
        g.advance(1 / 30);
        if (idx < 0) {
          // Only a shot that has just left: latching whatever slot happens to be alive
          // catches a projectile already most of the way to its target, which reported a
          // sling stone as having "flown 0.8 m".
          for (let i = 0; i < pr.highWater; i++) {
            if (pr.alive[i] === 1 && pr.life[i] < 0.08) { idx = i; break; }
          }
          if (idx < 0) continue;
          x0 = pr.ox[idx];
          z0 = pr.oz[idx];
        }
        if (pr.alive[idx] !== 1) break;
        apex = Math.max(apex, pr.py[idx]);
        last = {
          x: pr.px[idx], z: pr.pz[idx], x0, z0,
          v: Math.hypot(pr.vx[idx], pr.vy[idx], pr.vz[idx]),
          life: pr.life[idx],
        };
      }
      return last ? { apex, ...last } : null;
    });
    if (!tr) {
      console.log(`    ${pad(shooter, 20)} no shot inside 90 s`);
      results.traces.push({ shooter, gap, none: true });
      continue;
    }
    const flew = Math.hypot(tr.x - tr.x0, tr.z - tr.z0);
    results.traces.push({
      shooter, gap, flew: +flew.toFixed(1), apex: +tr.apex.toFixed(1),
      life: +tr.life.toFixed(2), impactSpeed: +tr.v.toFixed(1),
    });
    console.log(`    ${pad(shooter, 20)} flew ${num(flew.toFixed(1), 7)} m of ${num(gap, 4)} m` +
      `  apex ${num(tr.apex.toFixed(1), 6)} m  ${num(tr.life.toFixed(2), 6)} s` +
      `  arriving at ${num(tr.v.toFixed(1), 5)} m/s` +
      (flew < gap * 0.9 ? `   <-- ${(gap - flew).toFixed(0)} m SHORT` : ''));
  }
}

// ---------------------------------------------------------------------------
// 4. Kills per minute in the open
// ---------------------------------------------------------------------------
if (want('kills')) {
  console.log(`\n=== kills per minute in the open (${SECONDS} s runs, target holding) ===`);
  console.log(`  ${pad('engine', 16)}${pad('target', 18)}${num('shots', 7)}${num('counted', 9)}` +
    `${num('kills', 7)}${num('k/min', 8)}${num('per shot', 10)}`);
  const runs = [
    ['scorpio', 'juthungi-warband', 220],
    ['carroballista', 'juthungi-warband', 220],
    ['onager', 'legio-cohort', 180],
    ['onager', 'praetorian-cohort', 180],
  ];
  results.kills = [];
  for (const [engine, victim, gap] of runs) {
    const s = await setup([
      { type: engine, x: 0, z: 0, facing: Math.PI, form: 'line' },
      { type: victim, x: 0, z: -gap, facing: 0, form: 'line' },
    ], 700);
    const before = s.alive.find((a) => a && a.type === victim)?.alive ?? 0;
    const { launched: counted, elapsed } = await runCounting(SECONDS);
    const c = await census();
    const after = c.units.find((u) => u.type === victim)?.alive ?? 0;
    const kills = before - after;
    const shots = c.detail ? c.detail.kinds.reduce((a, k) => a + k.launched, 0) : counted;
    const row = {
      engine, victim, gap, shots, kills, before, after,
      elapsed,
      perMin: +(kills * 60 / elapsed).toFixed(2),
      perShot: shots ? +(kills / shots).toFixed(3) : 0,
    };
    results.kills.push(row);
    row.counted = counted;
    row.batteries = c.detail?.batteries ?? null;
    for (const b of row.batteries ?? []) {
      console.log(`      battery ${b.unit} ${b.kind}: ${b.machines} machines` +
        `  sinceShot=[${b.sinceShot.join(', ')}]  target=[${b.target.join(',')}]` +
        `  shotsOnTarget=[${b.shotsOnTarget.join(',')}]`);
    }
    // `shots` is the census; `counted` is the same thing inferred from the pool's own
    // in-flight and spent totals. They should agree, and printing both is what proves the
    // pre-fix numbers — taken on a tree with no census — can be believed.
    console.log(`  ${pad(engine, 16)}${pad(victim, 18)}${num(shots, 7)}${num(counted, 9)}` +
      `${num(kills, 7)}${num(row.perMin, 8)}${num(row.perShot, 10)}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Against the wall
// ---------------------------------------------------------------------------
if (want('wall')) {
  console.log(`\n=== the assault scenario, unmodified, for ${SECONDS} s ===`);
  await page.goto(`${base}/?harness=1&quality=ultra&autoplay=1&scenario=assault&w=640&h=400`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  const w = await page.evaluate(async (secs) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const pr = ctx.get('projectiles');
    const b = g.battle;
    pr.debugResetCensus?.();
    // Where the artillery stands, from the simulation's own `elevated` flag rather than from
    // coordinates — so this cannot go stale when the wall is rebuilt underneath it.
    const emplacement = [];
    for (const u of b.units) {
      if (u.destroyed) continue;
      if (b.typeOf(u).unitClass !== 'artillery') continue;
      let up = 0;
      let n = 0;
      let maxY = -1e9;
      for (const i of u.members) {
        if (!b.pool.aliveAt(i)) continue;
        n++;
        if (b.elevated[i] !== 0) up++;
        maxY = Math.max(maxY, b.pool.y[i]);
      }
      emplacement.push({
        unit: u.id, type: u.typeId, men: n, onMasonry: up,
        fractionOnMasonry: n ? +(up / n).toFixed(2) : 0,
        highestManY: +maxY.toFixed(2), groundY: +b.groundAt(u.x, u.z).toFixed(2),
        x: +u.x.toFixed(1), z: +u.z.toFixed(1),
      });
    }
    const before = new Map(b.units.filter((u) => !u.destroyed).map((u) => [u.id, u.alive]));
    const end = g.simTime() + secs;
    while (g.simTime() < end - 1e-6) g.advance(Math.min(0.25, end - g.simTime()));
    let dead = 0;
    for (const u of b.units) if (before.has(u.id)) dead += before.get(u.id) - u.alive;
    const siege = ctx.tryGet('siege');
    return {
      emplacement,
      detail: pr.debugProjectiles ? pr.debugProjectiles() : null,
      masonryHits: pr.masonryHits,
      siege: siege?.debugState ? siege.debugState().artillery ?? null : null,
      totalDead: dead,
    };
  }, SECONDS);
  results.wall = w;
  console.log("  artillery emplacement (from the sim's own `elevated` flag, not from coordinates):");
  for (const e of w.emplacement) {
    console.log(`    unit ${num(e.unit, 3)} ${pad(e.type, 15)} ${num(e.men, 3)} men,` +
      ` ${num(e.onMasonry, 3)} on masonry (${e.fractionOnMasonry})` +
      `  anchor (${e.x}, ${e.z})  ground ${e.groundY} m  highest man ${e.highestManY} m` +
      (e.fractionOnMasonry > 0.5 ? '   <-- EMPLACED ON THE WALL' : ''));
  }
  if (w.detail) {
    for (const k of w.detail.kinds) {
      if (k.launched === 0) continue;
      console.log(`    ${pad(k.kind, 9)} launched ${num(k.launched, 5)}  hit a man ${num(k.hitMan, 5)}` +
        `  killed ${num(k.killed, 5)}  into masonry ${num(k.intoMasonry, 6)}` +
        `  into ground ${num(k.intoGround, 6)}  k/min ${(k.killed * 60 / SECONDS).toFixed(2)}`);
    }
  }
  console.log(`    masonry hits ${w.masonryHits}; total men killed on the field ${w.totalDead}`);
  free = (await load()).free;
}

// ---------------------------------------------------------------------------
// 6. The slinger case
// ---------------------------------------------------------------------------
if (want('slinger')) {
  console.log('\n=== Balearic slingers vs a legionary cohort, 98 s, cohort attacking ===');
  const s = await setup([
    { type: 'balearic-slingers', x: 0, z: 0, facing: Math.PI, form: 'loose', order: 'hold' },
    { type: 'legio-cohort', x: 0, z: -200, facing: 0, form: 'line', order: 'attack' },
  ], 700);
  const before = s.alive.find((a) => a && a.type === 'legio-cohort')?.alive ?? 0;
  const { launched: counted, elapsed } = await runCounting(98);
  const c = await census();
  const after = c.units.find((u) => u.type === 'legio-cohort')?.alive ?? 0;
  results.slinger = { before, after, counted, elapsed, detail: c.detail };
  if (c.detail) {
    for (const k of c.detail.kinds) {
      if (k.launched === 0 && k.unreachable === 0) continue;
      console.log(`  ${k.kind}: physical reach ${k.maxRangeM} m` +
        `\n    launched ${num(k.launched, 5)}   refused as out of reach ${num(k.unreachable, 5)}` +
        `\n    hit a man ${num(k.hitMan, 5)}   stopped by a shield ${num(k.blockedByShield, 5)}` +
        `   killed ${num(k.killed, 4)}` +
        `\n    buried in the ground ${num(k.intoGround, 5)}` +
        `   mean distance from the point it was aimed at ${k.meanMissM ?? '-'} m` +
        `\n    total damage dealt ${k.damage}`);
    }
  } else {
    console.log(`  launched ${counted} (no census on this tree)`);
  }
  console.log(`  cohort ${after} of ${before} alive after ${elapsed} s of sim` +
    `  —  ${before - after} killed`);
}

// ---------------------------------------------------------------------------
// 6b. Photographs of the thing in the air
// ---------------------------------------------------------------------------
if (want('photo')) {
  console.log('\n=== photographs: the projectile itself, in flight ===');
  const dir = path.resolve(ROOT, args.get('out') ?? 'screenshots/artillery');
  await mkdir(dir, { recursive: true });
  const PW = 1280;
  const PH = 720;
  await page.setViewportSize({ width: PW, height: PH });
  // The canvas size is pinned by the harness query string, not by the viewport.
  await page.goto(`${base}/?harness=1&quality=ultra&autoplay=0&scenario=field&w=${PW}&h=${PH}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

  /**
   * Launch one missile of a known kind and photograph it.
   *
   * Chasing a live volley was tried twice and does not work: the camera has to be placed from
   * the projectile's position, and the only way to get a frame out is `advance`, which moves it
   * 1.4 m at an onager's speed and 2.6 m at a bolt's — further than the whole stand-off. Both
   * attempts photographed empty pasture.
   *
   * `launchBallistic` is the public API a siege engine already fires through, so the object
   * photographed is the same object the battle puts in the air, and `engine.renderOverride` —
   * which is `PostFX` — produces a finished frame *without* stepping the simulation. So the
   * camera is aimed at where the missile actually is, and it is still there when the shutter
   * opens.
   */
  for (const [kind, tag, lofted] of [
    ['boulder', 'stone', true],
    ['bolt', 'bolt', false],
    ['sling', 'sling', true],
    ['pilum', 'pilum', false],
    ['bow', 'arrow', true],
  ]) {
    const got = await page.evaluate(async ({ k, lo }) => {
      const g = window.__game;
      const ctx = g.engine.context;
      const pr = ctx.get('projectiles');
      const cam = ctx.camera;
      // Clear anything already flying so the latch below cannot pick up a stray.
      for (let i = 0; i < pr.highWater; i++) if (pr.alive[i] === 1) pr.release(i);
      const y0 = g.battle.groundAt(0, 0);
      const ok = pr.launchBallistic({
        kind: k,
        fromX: 0, fromY: y0 + 2, fromZ: 0,
        toX: 0, toY: y0 + 2, toZ: -140,
        damage: 1, apDamage: 1, spread: 0, ownerUnit: -1,
        rng: g.battle.rng.fork('photo-' + k), lofted: lo,
      });
      if (!ok) return null;
      let idx = -1;
      for (let i = 0; i < pr.highWater; i++) if (pr.alive[i] === 1) { idx = i; break; }
      if (idx < 0) return null;
      // Far enough out to be clear of the muzzle and still climbing.
      for (let n = 0; n < 22 && pr.alive[idx] === 1; n++) g.advance(1 / 30);
      if (pr.alive[idx] !== 1) return null;

      g.engine.rig.update = () => {};
      g.engine.rig.zoom = 0.42;
      const Vec3 = cam.position.constructor;
      // Aim at where the missile is *drawn*, not where the simulation has it.
      //
      // `preRender` interpolates between the previous tick and the current one by
      // `time.alpha`, and no `preRender` runs between placing the camera and
      // `renderOverride`. So the instance on screen is up to one whole tick behind the pool —
      // 1.2 m for a stone and 2.5 m for a bolt at 75 m/s, against a stand-off of 1.7 m. That is
      // why the bolt was photographed off the edge of the frame while the stone merely sat in
      // the corner: same bug, scaled by muzzle velocity.
      const al = ctx.time.alpha;
      const p = new Vec3(
        pr.ox[idx] + (pr.px[idx] - pr.ox[idx]) * al,
        pr.oy[idx] + (pr.py[idx] - pr.oy[idx]) * al,
        pr.oz[idx] + (pr.pz[idx] - pr.oz[idx]) * al
      );
      const v = new Vec3(pr.vx[idx], pr.vy[idx], pr.vz[idx]).normalize();
      const side = new Vec3().crossVectors(v, new Vec3(0, 1, 0)).normalize();
      // Broadside and very slightly above, which is how a shape reads best.
      const d = kindStandoff(k);
      cam.fov = 30;
      cam.near = 0.02;
      cam.far = 2400;
      // The aspect has to be re-derived, not inherited. Calling `updateProjectionMatrix` after
      // changing only the fov keeps whatever aspect was last set, and if that disagrees with
      // the drawing buffer the subject lands off-centre with a letterbox band across the top —
      // which is exactly what the first set of these frames showed.
      cam.aspect = ctx.renderer.domElement.width / ctx.renderer.domElement.height;
      cam.updateProjectionMatrix();
      cam.position.set(p.x + side.x * d, p.y + d * 0.18, p.z + side.z * d);
      cam.lookAt(p);
      cam.updateMatrixWorld(true);
      g.engine.renderOverride(ctx);
      return {
        life: +pr.life[idx].toFixed(2), y: +pr.py[idx].toFixed(1),
        speed: +Math.hypot(pr.vx[idx], pr.vy[idx], pr.vz[idx]).toFixed(1),
        size: +pr.len[idx].toFixed(3),
        canvas: ctx.renderer.domElement.toDataURL('image/png'),
      };
      // Stand-off chosen per kind so each fills a similar share of the frame: a 2 m pilum and
      // a 5 cm sling bullet cannot be photographed from the same distance.
      function kindStandoff(kk) {
        if (kk === 'sling') return 0.45;
        if (kk === 'boulder') return 1.5;
        if (kk === 'pilum') return 3.4;
        return 1.7;
      }
    }, { k: kind, lo: lofted });
    if (!got) { console.log(`  ${pad(tag, 8)} launch refused`); continue; }
    const file = path.join(dir, `flight-${tag}.png`);
    await writeFile(file, Buffer.from(got.canvas.slice(got.canvas.indexOf(',') + 1), 'base64'));
    console.log(`  ${pad(tag, 8)} kind=${pad(kind, 8)} ${got.life}s, ${got.y} m up,` +
      ` ${got.speed} m/s, drawn at ${got.size} m -> ${path.relative(ROOT, file)}`);
  }
  await page.setViewportSize({ width: 640, height: 400 });
  free = (await load()).free;
}

// ---------------------------------------------------------------------------
// 7. Release timing
// ---------------------------------------------------------------------------
if (want('timing')) {
  console.log('\n=== release timing: is the projectile created on the frame the engine fires? ===');
  results.timing = [];
  for (const engine of ['scorpio', 'onager']) {
    await setup([
      { type: engine, x: 0, z: 0, facing: Math.PI, form: 'line' },
      { type: engine === 'onager' ? 'legio-cohort' : 'juthungi-warband',
        x: 0, z: -160, facing: 0, form: 'line' },
    ], 700);
    const r = await page.evaluate(async (typeId) => {
      const g = window.__game;
      const ctx = g.engine.context;
      const pr = ctx.get('projectiles');
      const ur = ctx.get('unitRender');
      const u = g.battle.units.find((x) => !x.destroyed && x.typeId === typeId);
      if (!u) return null;
      const events = [];
      let prevAir = pr.inFlight;
      let prevSpent = pr.spent;
      // Whichever clock this tree keeps: the sim's if it has one, else the renderer's.
      const readCycle = () => {
        const sim = pr.engineCycle ? pr.engineCycle(u.id) : null;
        if (sim) return { src: 'sim', v: Array.from(sim) };
        const bat = ur.batteries?.get(u.id);
        return bat ? { src: 'renderer', v: Array.from(bat.sinceShot) } : { src: 'none', v: [] };
      };
      let prev = readCycle();
      for (let n = 0; n < 120 * 30 && events.length < 8; n++) {
        g.advance(1 / 30);
        const cur = readCycle();
        const born = (pr.inFlight - prevAir) + Math.max(0, pr.spent - prevSpent);
        const reset = [];
        for (let k = 0; k < cur.v.length; k++) {
          if (prev.v[k] !== undefined && cur.v[k] < prev.v[k]) reset.push(k);
        }
        if (reset.length > 0 || born > 0) {
          const dbg = ur.debugEngines ? ur.debugEngines().find((b) => b.unit === u.id) : null;
          events.push({
            t: +g.simTime().toFixed(3), clock: cur.src, resetEngines: reset, born,
            drawAtReset: reset.length && dbg ? dbg.engines[reset[0]]?.draw : null,
            phaseAtReset: reset.length && dbg ? dbg.engines[reset[0]]?.phase : null,
          });
        }
        prevAir = pr.inFlight;
        prevSpent = pr.spent;
        prev = cur;
      }
      return { machines: prev.v.length, clock: prev.src, events };
    }, engine);
    if (!r) { console.log(`  ${engine}: not spawned`); continue; }
    results.timing.push({ engine, ...r });
    console.log(`  ${engine}: ${r.machines} machines, cycle clock kept by the ${r.clock}`);
    let both = 0;
    let onlyShot = 0;
    let onlyReset = 0;
    for (const e of r.events) {
      const ok = e.resetEngines.length > 0 && e.born > 0;
      if (ok) both++;
      else if (e.born > 0) onlyShot++;
      else onlyReset++;
      console.log(`    t=${num(e.t, 8)}  machines resetting [${pad(e.resetEngines.join(','), 7)}]` +
        `  projectiles created ${num(e.born, 2)}  ${ok ? 'SAME TICK' : 'SPLIT ACROSS TICKS'}` +
        (e.drawAtReset !== null && e.drawAtReset !== undefined
          ? `  (draw ${e.drawAtReset}, phase ${e.phaseAtReset})` : ''));
    }
    console.log(`    ${both} coincident, ${onlyShot} shot(s) with no release, ` +
      `${onlyReset} release(s) with no shot`);
  }
}

if (errors.length) {
  console.log('\n=== console errors ===');
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(results, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(0);
