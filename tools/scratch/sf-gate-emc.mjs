/**
 * What is an open gate actually worth?
 *
 * The ram stops three blows short on Rome and the whole ram-tuning question assumes the
 * gate is a prize. That assumption has never been measured. This forces the gate open at a
 * time you name — the same call `Siege` makes on the twenty-sixth blow, so the carriageway
 * really is repainted in the occupancy raster, the obstacle set and the nav grid — and then
 * counts who walks through it.
 *
 * Arms:
 *   shipped   nothing touched
 *   open      the gate is broken open at --at, nobody is told
 *   host      the gate is broken open at --at and the idle host is sent through it
 *
 * One seed, one deterministic timeline. This is not a win-rate instrument.
 *
 *   node tools/scratch/sf-gate-emc.mjs --port=5491 --arm=open --at=220 --until=900
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const PORT = Number(A.get('port') ?? 5491);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'high';
const ARM = A.get('arm') ?? 'shipped';
const AT = Number(A.get('at') ?? 220);
const UNTIL = Number(A.get('until') ?? 900);
const SEED = A.get('seed') ? Number(A.get('seed')) : null;
const OUT = path.join(ROOT, 'screenshots/siegefun');
await mkdir(OUT, { recursive: true });

const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror ' + e.message.slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text().slice(0, 160)); });
let url = `${PORT ? `http://127.0.0.1:${PORT}` : ''}/?harness=1&w=640&h=360&quality=${QUALITY}&scenario=assault&autoplay=1`;
url += `&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, ...(SEED === null ? {} : { seed: SEED }) })}`;
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());

await p.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  const city = ctx.get('city');
  const flow = ctx.get('battleFlow');
  const bays = city.getGarrisonBays();
  const gate = city.getGates()[0];
  /** Signed depth from the curtain; positive = the storm's side. */
  const bayAtX = (x) => {
    for (const q of bays) if (x >= Math.min(q.x0, q.x1) && x <= Math.max(q.x0, q.x1)) return q;
    return x < bays[0].x0 ? bays[0] : bays[bays.length - 1];
  };
  const depthOf = (x, z) => {
    const q = bayAtX(x); const t = (x - q.x0) / (q.x1 - q.x0 || 1);
    return (x - x) * q.nx + (z - (q.z0 + (q.z1 - q.z0) * t)) * q.nz;
  };
  const storm = flow.objective ? flow.objective.storm : 1;
  const seen = new Set();          // storm men ever counted inside
  const viaGate = new Set();       // storm men ever counted in the carriageway
  window.__sf = {
    gate, storm,
    /** The idle host: storm-side foot still holding, more than 100 m out, not siege-owned. */
    host: () => g.battle.units.filter((u) => !u.destroyed && u.alive > 0 && u.faction === storm
      && u.order === 0 && Math.abs(depthOf(u.x, u.z)) > 100),
    open: () => {
      const gs = city.getGates();
      city.setGateOpen(gs[0].id, true);
      city.setGateDoorBroken?.(gs[0].id);
      return gs[0].id;
    },
    sample: () => {
      const pool = g.battle.pool;
      for (const u of g.battle.units) {
        if (u.faction !== storm || u.destroyed) continue;
        for (const i of u.members) {
          if (pool.hp[i] <= 0) continue;
          const d = depthOf(pool.x[i], pool.z[i]);
          if (d < -14) seen.add(i);
          if (d < 4 && d > -30 && Math.hypot(pool.x[i] - gate.x, pool.z[i] - gate.z) < 14) viaGate.add(i);
        }
      }
    },
    read: () => {
      const o = flow.objective ?? {};
      const eng = g.battle.siege?.engineReport?.() ?? {};
      const gr = g.battle.siege?.gateReport?.() ?? {};
      const rr = (g.battle.siege?.ramReport?.() ?? []).filter((x) => x.kind === 'gate')[0] ?? {};
      return {
        t: +ctx.time.simTime.toFixed(0),
        gateOpen: gr.open, gateHp: +(gr.hp ?? 0).toFixed(2), blows: gr.blows,
        ramState: rr.state, crew: rr.crewAlive, crewRout: rr.crewRouting, owned: rr.owned,
        stormOnWall: o.stormOnWall ?? 0, stormInside: o.stormInside ?? 0,
        garrisonOnWall: o.garrisonOnWall ?? 0,
        ladders: eng.laddersCrossed ?? 0,
        strength: { ...g.battle.strength },
        everInside: seen.size, everGate: viaGate.size,
        hostIdle: g.battle.units.filter((u) => !u.destroyed && u.alive > 0 && u.faction === storm && u.order === 0).length,
        result: flow.result ? { victor: flow.result.victor, reason: flow.result.reason, at: +flow.result.at.toFixed(0) } : null,
      };
    },
  };
});

const rows = [];
let opened = false;
for (let t = 0; t < UNTIL; t += 10) {
  const row = await p.evaluate(([armv, atv]) => {
    const g = window.__game;
    for (let s = 0; s < 10; s++) { g.engine.advance(1, 166); window.__sf.sample(); }
    const now = g.engine.context.time.simTime;
    let did = null;
    if (armv !== 'shipped' && !window.__sfOpened && now >= atv) {
      window.__sfOpened = true;
      did = window.__sf.open();
      if (armv === 'host') {
        const h = window.__sf.host();
        const gate = window.__sf.gate;
        // Straight at the carriageway and on through it: an attack-move so they fight what
        // is in the way rather than walking past it.
        const inX = gate.x, inZ = gate.z - Math.sign(gate.z) * 0;
        g.engine.context.events.emit('orderIssued', {
          unitIds: h.map((u) => u.id), kind: 'attackMove',
          x: inX, z: inZ - 60, running: true,
        });
        did += ` +host(${h.length} units, ${h.reduce((a, u) => a + u.alive, 0)} men)`;
      }
    }
    return { ...window.__sf.read(), did };
  }, [ARM, AT]);
  rows.push(row);
  if (row.did) { opened = true; console.log(`  ! t+${row.t} ${row.did}`); }
  if (row.result) break;
}

const last = rows[rows.length - 1];
console.log(`# ${MAP} q=${QUALITY} arm=${ARM}${ARM === 'shipped' ? '' : `@${AT}`} seed=${SEED ?? 'default'}`);
console.log('   t  gateOpen  hp  blows  ram          crew  onWall inside  everIn everGate  garrOnWall  storm  garr   hostIdle');
for (const r of rows) {
  if (r.t % 40 && r !== last) continue;
  console.log(`${String(r.t).padStart(4)}  ${String(r.gateOpen).padStart(8)} ${String(r.gateHp).padStart(4)} ${String(r.blows).padStart(6)}  ${String(r.ramState).padEnd(11)} ${String(r.crew).padStart(4)}  `
    + `${String(r.stormOnWall).padStart(6)} ${String(r.stormInside).padStart(6)}  ${String(r.everInside).padStart(6)} ${String(r.everGate).padStart(8)}  ${String(r.garrisonOnWall).padStart(10)}  `
    + `${String(r.strength[1] ?? 0).padStart(5)} ${String(r.strength[0] ?? 0).padStart(5)}   ${String(r.hostIdle).padStart(8)}`);
}
console.log('result:', JSON.stringify(last.result), ' peak everInside', Math.max(...rows.map((r) => r.everInside)),
  ' peak everGate', Math.max(...rows.map((r) => r.everGate)), ' peak stormInside', Math.max(...rows.map((r) => r.stormInside)));
console.log('errors:', errs.slice(0, 3));
await writeFile(path.join(OUT, `gate-${MAP}-${ARM}${ARM === 'shipped' ? '' : AT}${SEED === null ? '' : '-' + SEED}.json`), JSON.stringify({ arm: ARM, at: AT, map: MAP, quality: QUALITY, seed: SEED, rows, errs }, null, 1));
await b.close();
