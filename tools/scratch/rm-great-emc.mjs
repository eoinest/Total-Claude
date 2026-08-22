/**
 * The great ram, in a real assault, over N seeds — and whether the hole it makes is a road.
 *
 * Four things are measured, in the order they have to happen:
 *
 *  1. a `great` ram is **deployed by the scenario** (not by a probe calling `spawnGreatRam`);
 *  2. it reaches its bay and batters — blows, and the seconds between them;
 *  3. `breachReport().lanes` goes from 0 to `BREACH_LANES` and `bays` names the bay;
 *  4. men **ordered through it by the ordinary order path** come out inside the city.
 *
 * Step 4 goes through `events.emit('orderIssued', …)`, which is the same event the player's
 * right-click and `ai/Orders.ts` both emit — not `Siege.stormBreach`, which is the thing
 * being tested. A probe that calls the verb it is asserting about is self-consistent and can
 * never fail.
 *
 *   node tools/scratch/rm-great-emc.mjs --port=5905 --seeds=4 --until=800
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'ultra';
const UNTIL = Number(A.get('until') ?? 800);
const STEP = Number(A.get('step') ?? 20);
const SEEDS = Number(A.get('seeds') ?? 4);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const LABEL = A.get('label') ?? 'great';
const K = 0x9e3779b1;
const OUT = path.join(ROOT, 'screenshots/rams');
await mkdir(OUT, { recursive: true });
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const all = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = (SEED0 + i * K) >>> 0;
  const p = await browser.newPage({ viewport: { width: 400, height: 240 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 160)); });
  await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed })}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
  await p.evaluate(() => window.__game.engine.stop());

  const setup = await p.evaluate(() => {
    const g = window.__game, b = g.battle, s = b.siege;
    const rams = s.ramReport();
    const gr = rams.find((r) => r.kind === 'great');
    return {
      men: b.units.reduce((a, u) => a + u.alive, 0), units: b.units.length,
      scale: b.unitSizeScale,
      rams: rams.map((r) => ({ kind: r.kind, unitId: r.unitId, crew: r.crewAlive, bay: r.bay,
        x: +r.x.toFixed(1), z: +r.z.toFixed(1), d: +r.distFromTarget.toFixed(1) })),
      great: !!gr, greatDims: gr ? gr.dims : null,
    };
  });

  const series = [];
  let storm = null;
  for (let t = 0; t < UNTIL; t += STEP) {
    const row = await p.evaluate((s) => {
      const g = window.__game, ctx = g.engine.context;
      g.fastForward(s);
      const b = g.battle, si = b.siege;
      const flow = ctx.get('battleFlow');
      const gr = si.gateReport();
      const br = si.breachReport();
      const great = si.ramReport().find((r) => r.kind === 'great') ?? {};
      const gate = si.ramReport().find((r) => r.kind === 'gate') ?? {};
      return { t: +ctx.time.simTime.toFixed(0),
        gateBlows: gr.blows, gateOpen: gr.open,
        gateCrew: gate.crewAlive ?? 0, gateState: gate.state,
        gBlows: great.bayBlows ?? 0, gState: great.state, gCrew: great.crewAlive ?? 0,
        gD: +(great.distFromTarget ?? 0).toFixed(0), gBay: great.bay ?? -1,
        lanes: br.lanes, bays: br.bays.slice(), through: br.through,
        result: flow.result ? `${flow.result.victor}/${flow.result.reason}@${flow.result.at.toFixed(0)}` : null };
    }, STEP);
    series.push(row);
    // The moment the hole exists, order the three nearest free storm units through it, by
    // the same event the mouse fires. Then keep advancing and watch `through`.
    if (row.lanes > 0 && storm === null) {
      storm = await p.evaluate(() => {
        const g = window.__game, b = g.battle, s = b.siege, ctx = g.engine.context;
        const br = s.breachReport();
        const bays = ctx.get('city').getGarrisonBays();
        const bay = bays.find((x) => x.index === br.bays[0]);
        const bx = (bay.x0 + bay.x1) * 0.5, bz = (bay.z0 + bay.z1) * 0.5;
        /*
         * **Field side only, and that is the whole test rather than a filter.**
         *
         * `Siege.interceptOrders` branches on `sideOf(u.x, u.z)` before it ever reaches
         * `escalade`: a unit already *inside* the curtain gets `sendToWall`, the defenders'
         * own stairs, because a besieger who is in the city does not need a hole in the wall.
         * Rome's assault leaves 86 Juthungi inside by t+60 through the unbuilt bays (see
         * `rm-inside-emc`), so "the three nearest free units" was picking men who were
         * already through and measuring the stair route: 6, 0, 0 men across three seeds. The
         * order this is about is the one given to men standing in the field.
         */
        /*
         * ...and foot, because `Siege.mayClimb` refuses artillery and horse by `unitClass`
         * and is right to: a battery does not climb rubble any more than it climbs a ladder.
         * The three units nearest bay 5 on the field side are two onager batteries and the
         * gate ram's spent crew, so an unfiltered "nearest three" was measuring the refusal.
         */
        const noClimb = new Set(['artillery', 'heavy-cavalry', 'light-cavalry']);
        const cands = b.units
          .filter((u) => !u.destroyed && u.alive >= 5 && u.faction !== 0
            && !s.ownsUnit(u.id) && !s.isGarrisoned(u.id) && s.wallSideAt(u.x, u.z) === 1
            && !noClimb.has(b.typeOf(u).unitClass))
          .map((u) => ({ u, d: Math.hypot(u.x - bx, u.z - bz) }))
          .sort((a, c) => a.d - c.d).slice(0, 3);
        for (const c of cands) {
          ctx.events.emit('orderIssued', { kind: 'move', unitIds: [c.u.id], x: bx, z: bz });
        }
        return { sent: cands.length, at: +ctx.time.simTime.toFixed(0),
          from: cands.map((c) => `${c.u.typeId}#${c.u.id}@${c.d.toFixed(0)}m`),
          before: br.through };
      });
    }
  }
  const tail = await p.evaluate(() => {
    const s = window.__game.battle.siege;
    const br = s.breachReport();
    return { lanes: br.lanes, bays: br.bays, through: br.through, integrity: br.integrity,
      rams: s.ramReport().map((r) => `${r.kind}:${r.state}:crew${r.crewAlive}:bay${r.bay}:${r.bayBlows}`) };
  });
  await p.close();

  const firstBreach = series.find((r) => r.lanes > 0);
  const gateOpen = series.find((r) => r.gateOpen);
  const rec = { seed, setup, storm, tail, series, errs,
    breachAt: firstBreach ? firstBreach.t : null, gateOpenAt: gateOpen ? gateOpen.t : null,
    through: tail.through };
  all.push(rec);
  console.log(`  ${String(seed).padStart(11)} great=${setup.great ? 'yes' : 'NO '}`
    + `  gate open ${gateOpen ? 't+' + gateOpen.t : 'never'}`
    + `  breach ${firstBreach ? 't+' + firstBreach.t + ' bay ' + firstBreach.bays.join(',') : 'never'}`
    + `  lanes ${tail.lanes}  through ${tail.through}`
    + `  ordered ${storm ? storm.sent + ' at t+' + storm.at + ' [' + storm.from.join(' ') + ']' : '0'}`
    + `  ${tail.rams.join(' ')}${errs.length ? '  ERR ' + errs[0] : ''}`);
}
console.log(`\n# ${LABEL} ${MAP} q=${QUALITY} ${SEEDS} seeds to t+${UNTIL}`);
console.log(`  breached ${all.filter((r) => r.breachAt !== null).length}/${SEEDS}`
  + `  median breach t+${[...all.map((r) => r.breachAt ?? 1e9)].sort((a, b) => a - b)[Math.floor(SEEDS / 2)]}`
  + `  men through: ${all.map((r) => r.through).join(', ')}`);
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify(all, null, 1));
await browser.close();
