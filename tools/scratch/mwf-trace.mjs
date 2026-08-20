#!/usr/bin/env node
/**
 * Per-tick morale trace for the attackers at the Carthaginian curtain.
 *
 * The question is not "does morale fall" but "which term is doing it". So this records
 * every contributing pressure term separately, once per sim tick, for every Roman unit,
 * alongside the raw signals those terms are computed from and the unit's position relative
 * to the wall. Sampling is done inside the page by wrapping `battleFlow.fixedUpdate`
 * (order 50), which runs after `morale` (order 30) in the same tick, so every row is the
 * state morale left behind rather than whatever a Playwright round-trip happened to catch.
 *
 * Instrument self-check, deliberately recorded rather than assumed: `moraleTerms` reports
 * the *instantaneous* per-term pressure, while what is actually applied to morale is the
 * low-passed sum (`PRESSURE_TAU`) after the `MAX_FALL_RATE` limiter, plus one-shot contagion
 * shocks that appear in no term at all. Both the term sum and the realised dMorale/dt are
 * stored so the residual can be measured instead of hand-waved.
 *
 * Usage:
 *   node tools/scratch/mwf-trace.mjs --port=5629 --seed=4265438264 --until=280 --out=/tmp/x.json
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5629);
const MAP = args.get('map') ?? 'carthage';
const QUALITY = args.get('quality') ?? 'high';
const UNTIL = Number(args.get('until') ?? 280);
const STRIDE = Number(args.get('stride') ?? 3);       // record every Nth sim tick (30 Hz base)
const SEEDS = String(args.get('seeds') ?? args.get('seed') ?? '4265438264').split(',').map(Number);
const OUT = args.get('out') ?? '/tmp/mwf-trace.json';
/**
 * Which side to trace. Rome is the *attacker* at Carthage and the *defender* at Rome, so a
 * probe hardcoded to Faction.Rome traces the garrison on one map and the storm on the other
 * — which is how a first pass at the Aurelian wall recorded twelve ballistarii and no ram.
 */
const FACTION = args.get('faction') ?? 'all';
/**
 * `--ablate=exchange` zeroes one term for the whole run; `--ablate=clear` removes the
 * in-contact recovery cliff. Requires the measurement scaffold in `src/sim/Morale.ts`.
 */
const ABLATE = args.get('ablate') ?? '';

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

/** Column layout of one recorded row. Kept here and in the page in one place. */
const COLS = [
  't', 'id', 'fac', 'alive', 'morale', 'maxMorale', 'order', 'band', 'y', 'x', 'z',
  'attrition', 'casualties', 'flanked', 'exchange', 'cavalry', 'fatigue', 'missiles',
  'witness', 'ground', 'army', 'recovery',
  'engagedFrac', 'flankedFrac', 'rearFrac', 'casPulse', 'killPulse', 'missPulse',
  'nearestEnemy', 'contactLock', 'surrounded', 'engaged', 'fatigueRaw', 'frontGap',
  'wallDist', 'wallSide', 'owned', 'garrisoned', 'routTimer', 'kills',
];

const runs = [];
for (const seed of SEEDS) {
  const url = `${base}/?harness=1&w=480&h=270&quality=${QUALITY}&scenario=assault&autoplay=1`
    + `&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed })}`;
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__game?.ready === true, null,
    { timeout: 600000, polling: 250 });
  // The page's own rAF loop must not step the sim between round-trips.
  await page.evaluate(() => window.__game.engine.stop());

  const meta = await page.evaluate(async ({ cols, stride, ablate, fac }) => {
    const g = window.__game, b = g.battle, ctx = g.engine.context;
    const shared = await import('/src/sim/combatShared.ts');
    const signalsOf = shared.signalsOf;
    const morale = ctx.get('morale');
    // Through the live subsystem, never through `import()`: see `MoraleSystem.measure`.
    const NAMES = ['attrition', 'casualties', 'flanked', 'exchange', 'cavalry', 'fatigue',
      'missiles', 'witness', 'ground', 'army', 'recovery'];
    // Absent on trees without the scaffold (r6); baseline runs there are still valid.
    if (!morale.measure && ablate) throw new Error('no measurement scaffold on the morale system');
    if (morale.measure) {
    morale.measure.scale.fill(1);
    morale.measure.forceClear = false;
    morale.measure.engagedThreshold = 0.02;
    morale.measure.proportionalRecovery = false;
    if (ablate === 'clear') morale.measure.forceClear = true;
    else if (ablate === 'engprop') morale.measure.proportionalRecovery = true;
    else if (ablate.startsWith('eng')) morale.measure.engagedThreshold = Number(ablate.slice(3)) / 100;
    else if (ablate) {
      const k = NAMES.indexOf(ablate);
      if (k < 0) throw new Error(`unknown ablation ${ablate}`);
      morale.measure.scale[k] = 0;
    }
    }
    const flow = ctx.get('battleFlow');
    const s = b.siege;
    const P = { rows: [], routs: [], siegeSeries: [], siegeWidth: 0, stride, tick: 0, cols };
    window.__mwf = P;

    ctx.events.on('unitRouted', (e) => {
      P.routs.push({ t: ctx.time.simTime, unitId: e.unitId, faction: e.faction ?? -1 });
    });
    ctx.events.on('unitRallied', (e) => {
      P.routs.push({ t: ctx.time.simTime, unitId: e.unitId, rally: 1 });
    });

    /** Plan distance from a point to the nearest wall station centreline, signed by side. */
    const wallDist = (x, z) => {
      if (!s || s.stationCount === 0) return [ -1, 0 ];
      const st = s.stationNear(x, z);
      if (st < 0) return [ -1, 0 ];
      const off = (x - s.sx[st]) * s.snx[st] + (z - s.sz[st]) * s.snz[st];
      return [ off, s.wallSideAt(x, z) ];
    };

    const orig = flow.fixedUpdate.bind(flow);
    flow.fixedUpdate = (dt, c) => {
      orig(dt, c);
      P.tick++;
      if (P.tick % P.stride !== 0) return;
      const t = ctx.time.simTime;
      if (s) {
        P.siegeSeries.push(t, s.wallShots, s.wallKills, s.stormOnWall ?? -1,
          ...(s.rams ?? []).flatMap((r) => [r.unitId, r.blows ?? -1, r.wreck ? 1 : 0,
            r.state ?? -1, r.derelictFor ?? -1, r.arrived ? 1 : 0]));
        P.siegeWidth = 4 + 6 * ((s.rams ?? []).length);
      }
      for (const u of b.units) {
        if (u.destroyed) continue;
        if (fac !== 'all' && u.faction !== Number(fac)) continue;
        const sig = signalsOf(u.id);
        const tm = morale.moraleTerms(u.id);
        const [off, side] = wallDist(u.x, u.z);
        P.rows.push(
          t, u.id, u.faction, u.alive, u.morale, u.maxMorale, u.order, morale.bandOf(u.id),
          b.levelOf(u.id), u.x, u.z,
          tm.attrition, tm.casualties, tm.flanked, tm.exchange, tm.cavalry,
          tm.fatigue, tm.missiles, tm.witness, tm.ground, tm.army, tm.recovery,
          sig.engagedFraction, sig.flankedFraction, sig.rearFraction,
          sig.casualtyPulse, sig.killPulse, sig.missilePulse,
          Math.min(sig.nearestEnemy, 9999), sig.contactLock ? 1 : 0, sig.surrounded ? 1 : 0,
          u.engaged ? 1 : 0, u.fatigue, Math.min(b.frontGapOf(u.id), 9999),
          off, side, s && s.ownsUnit(u.id) ? 1 : 0, s && s.isGarrisoned(u.id) ? 1 : 0,
          u.routTimer, u.kills,
        );
      }
    };

    return {
      ablate, scaffold: !!morale.measure,
      scale: morale.measure ? Array.from(morale.measure.scale) : null,
      forceClear: morale.measure?.forceClear ?? null,
      seed: b.config?.seed ?? null,
      stationCount: s ? s.stationCount : -1,
      ladders: s && s.ladders ? s.ladders.map((l) => ({
        station: l.station, unitId: l.unitId, topX: l.topX, topZ: l.topZ, topY: l.topY,
      })) : [],
      towers: s && s.towers ? s.towers.map((t) => ({ id: t.id, unitId: t.unitId,
        station: t.station })) : [],
      rams: s && s.rams ? s.rams.map((r) => ({ id: r.id, unitId: r.unitId, kind: r.kind,
        gateId: r.gateId, station: r.station })) : [],
      units: b.units.map((u) => ({
        id: u.id, typeId: u.typeId, faction: u.faction, init: u.initialStrength,
        maxMorale: u.maxMorale, discipline: ctx.get('battle').typeOf(u).discipline,
        x: +u.x.toFixed(1), z: +u.z.toFixed(1),
      })),
      wall: s ? {
        sy: Array.from({ length: Math.min(8, s.stationCount) }, (_, i) => s.sy[i * 50] ?? null),
      } : null,
    };
  }, { cols: COLS, stride: STRIDE, ablate: ABLATE, fac: FACTION });

  const CHUNK = 20;
  for (let t = 0; t < UNTIL; t += CHUNK) {
    await page.evaluate((n) => window.__game.engine.advance(n, 166), Math.min(CHUNK, UNTIL - t));
  }

  const data = await page.evaluate(() => ({
    rows: window.__mwf.rows, routs: window.__mwf.routs,
    siegeSeries: window.__mwf.siegeSeries, siegeWidth: window.__mwf.siegeWidth,
    ticks: window.__mwf.tick, t: window.__game.simTime(),
    siege: (() => {
      const s = window.__game.battle.siege;
      return s ? { wallShots: s.wallShots, wallKills: s.wallKills,
        stormOnWall: s.stormOnWall ?? null } : null;
    })(),
  }));
  runs.push({ seed, ablate: ABLATE, meta, ...data, errs });
  console.error(`seed ${seed} ablate=${ABLATE || 'none'}: t=${data.t.toFixed(0)}s ticks=${data.ticks} `
    + `rows=${data.rows.length / COLS.length} routs=${data.routs.length} errs=${errs.length}`);
  if (errs.length) console.error(errs.slice(0, 5).join('\n'));
  await page.close();
}

await browser.close();
await writeFile(OUT, JSON.stringify({ cols: COLS, stride: STRIDE, until: UNTIL, map: MAP,
  quality: QUALITY, runs }));
console.error(`wrote ${OUT}`);
