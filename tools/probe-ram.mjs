#!/usr/bin/env node
/**
 * Does a ram ever break the gate, and if not, what stops it?
 *
 * The owner: *"not once have I seen a battering ram successfully break down a gate. Perhaps
 * this is because they all die, or perhaps something is broken with the battering ram."*
 * Both hypotheses are testable and this picks one. It runs an assault with nobody
 * interfering and logs, per ram and per ten seconds of battle: state, blows landed, metres
 * still to walk, crew strength, whether the crew has broken, whether the siege system still
 * owns them, and what the gate's health is doing — against the arithmetic the machine is
 * supposed to satisfy.
 *
 * Usage: node tools/probe-ram.mjs --port=5388 [--secs=600] [--json]
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5388);
const SECS = Number(args.get('secs') ?? 600);
const MAP = args.get('map') ?? '';
const AS_JSON = args.has('json');

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• dev server ${base}`);

// See probe-walltraffic.mjs: without these, headless Chromium software-rasterises the siege.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
await page.goto(`${base}/?harness=1&quality=low&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`,
  { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 150000 });
} catch {
  console.error('the page never reached ready\n' + errs.join('\n'));
  await browser.close();
  process.exit(3);
}
console.log('• ready');

const out = await page.evaluate(async (secs) => {
  const g = window.__game, b = g.battle, s = b.siege;
  g.engine.stop();

  const trace = [];
  const events = [];
  const seen = new Map();
  let firstBattering = -1, breachedAt = -1;

  /*
   * Men through the arch, which is the only thing breaking a gate is *for*.
   *
   * Counted as attackers standing cityward of the door plane and within 12 m of the gate's
   * own axis, so a man who came over the wall on a ladder forty metres away is not credited
   * to the ram.
   */
  const gate0 = s.gateReport();
  const city = g.engine.context.get('city');
  const gd = city.getGateDoor();
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction ?? 0;
  const throughTheArch = () => {
    const p = b.pool;
    let n = 0;
    for (let i = 0; i < p.count; i++) {
      if (!p.aliveAt(i) || p.faction[i] === defender) continue;
      const dx = p.x[i] - gd.x, dz = p.z[i] - gd.z;
      // Signed: negative along the outward normal is inside the city.
      if (dx * gd.nx + dz * gd.nz >= 0) continue;
      if (Math.abs(dx * gd.dx + dz * gd.dz) > 12) continue;
      /*
       * And at street level, not on the parapet over the arch.
       *
       * The door plane is set back behind the outer face, so a man who came up a ladder onto
       * the gate bay's own walkway is cityward of it too — measured, this counter read 8, 17
       * and then 25 men "through the arch" at t+190..210 while the gate was still shut and
       * `door.open` was still false, which is a number that cannot be true beside its
       * neighbour. Those were escaladers standing seven metres above the road.
       */
      if (p.y[i] > gd.y + 2.5) continue;
      n++;
    }
    return n;
  };

  const sample = (t) => {
    const rams = s.ramReport();
    const gate = s.gateReport();
    for (const r of rams) {
      const key = `${r.id}`;
      const was = seen.get(key);
      const now = `${r.state}|${r.crewRouting}|${r.owned}|${r.wreck}`;
      if (was !== now) {
        events.push({ t: +t.toFixed(1), ram: r.id, state: r.state,
          crewAlive: r.crewAlive, crewRouting: r.crewRouting, owned: r.owned,
          wreck: r.wreck, blows: r.blows, dist: +r.distFromTarget.toFixed(1) });
        seen.set(key, now);
      }
      if (r.state === 'battering' && firstBattering < 0) firstBattering = +t.toFixed(1);
    }
    if (gate.breached && breachedAt < 0) breachedAt = +t.toFixed(1);
    trace.push({ t: +t.toFixed(0), gateBlows: gate.blows, gateHp: +gate.hp.toFixed(3),
      open: gate.open, breached: gate.breached, through: throughTheArch(),
      doorOpenFlag: city.getGateDoor().open,
      rams: rams.filter((r) => r.kind === 'gate').map((r) => ({
        id: r.id, st: r.state, blows: r.blows, d: +r.distFromTarget.toFixed(1),
        crew: r.crewAlive, rout: r.crewRouting, own: r.owned })) });
  };

  sample(0);
  const ticks = Math.round(secs * 30);
  for (let k = 1; k <= ticks; k++) {
    g.engine.advance(1 / 30, 1000 / 30);
    if (k % 300 === 0) sample(k / 30);
  }
  sample(secs);

  const gate = s.gateReport();
  const rams = s.ramReport();
  return {
    simTime: +g.simTime().toFixed(1),
    gate: { blows: gate.blows, hp: +gate.hp.toFixed(3), open: gate.open,
      breached: gate.breached, shutAtStart: gate.shutAtStart },
    firstBattering, breachedAt,
    rams: rams.map((r) => ({ id: r.id, kind: r.kind, state: r.state, blows: r.blows,
      dist: +r.distFromTarget.toFixed(1), crewAlive: r.crewAlive,
      crewRouting: r.crewRouting, crewPinned: r.crewPinned, owned: r.owned, wreck: r.wreck })),
    events, trace,
    strength: { rome: b.strength[0], germanic: b.strength[1] },
    gateDoor: { x: +gd.x.toFixed(1), z: +gd.z.toFixed(1), open: city.getGateDoor().open,
      halfWidth: gd.halfWidth, height: gd.height },
    gateAtStart: { open: gate0.open, breached: gate0.breached },
  };
}, SECS);

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log(`\nsim ${out.simTime}s   gate: ${out.gate.blows} blows, hp ${out.gate.hp}, `
    + `open ${out.gate.open}, breached ${out.gate.breached} (shut at start: ${out.gate.shutAtStart})`);
  console.log(`first blow at ${out.firstBattering}s, breach at ${out.breachedAt}s `
    + `(26 blows x 4.4 s = 114 s of battering, so a ram that starts on time breaks it)`);
  console.log('\nstate changes:');
  for (const e of out.events) {
    console.log(`  t+${String(e.t).padStart(5)}  ram ${e.ram}  ${e.state.padEnd(11)} `
      + `blows ${String(e.blows).padStart(2)}  ${e.dist.toFixed(1).padStart(6)} m to go  `
      + `crew ${String(e.crewAlive).padStart(3)}  routing ${e.crewRouting ? 'Y' : 'n'}  `
      + `owned ${e.owned ? 'Y' : 'n'}  wreck ${e.wreck ? 'Y' : 'n'}`);
  }
  console.log(`\ngate door record: ${JSON.stringify(out.gateDoor)}`);
  console.log('\nt    blows  hp     door.open  men-through-the-arch  rams');
  for (const s of out.trace) {
    console.log(`${String(s.t).padStart(5)}  ${String(s.gateBlows).padStart(5)}  `
      + `${s.gateHp.toFixed(3)}  ${String(s.doorOpenFlag).padEnd(9)}  `
      + `${String(s.through).padStart(4)}  `
      + s.rams.map((r) => `#${r.id} ${r.st.slice(0, 4)}/${r.blows}/${r.d}/${r.crew}`
        + `/${r.rout ? 'R' : '-'}/${r.own ? 'O' : '-'}`).join('  '));
  }
  console.log(`\nfinal rams: ${JSON.stringify(out.rams)}`);
  console.log(`strength rome ${out.strength.rome?.toFixed?.(3)} germanic ${out.strength.germanic?.toFixed?.(3)}`);
}
if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 8).join('\n'));
await browser.close();
