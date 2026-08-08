#!/usr/bin/env node
/**
 * what a charge costs a horseman, sliced by the ten metres he is crossing.
 *
 * `cav-vs-archers` inverted when the missile friendly-fire fix let the rear ranks' arrows
 * through, and "archers now win" is not enough to tune on — the question is how many arrows
 * are delivered while the horse is closing, and at what range they are delivered, because
 * the two levers available (rate of fire, damage) act on different halves of that.
 *
 * Same teardown as `tools/matchup.mjs` — the siege is killed, the AI and the arbiter are
 * stubbed, two units are spawned on empty ground and ordered — then stepped a second at a
 * time with the projectile census read every second and differenced.
 *
 * Usage: node tools/probe-charge.mjs --port=5715 [--case=cav|num] [--until=240]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5715);
const UNTIL = Number(args.get('until') ?? 240);
const WHICH = args.get('case') ?? 'cav';
const JSON_OUT = args.get('json') ?? null;

const SPECS = {
  cav: { id: 'cav-vs-archers', a: { type: 'sagittarii', form: 'loose', order: 'hold' },
    b: { type: 'juthungi-riders', form: 'wedge', order: 'attack' }, gap: 150 },
  num: { id: 'numidian-vs-archers', a: { type: 'sagittarii', form: 'loose', order: 'hold' },
    b: { type: 'numidian-cavalry', form: 'wedge', order: 'attack' }, gap: 150 },
};
const spec = SPECS[WHICH];
if (!spec) { console.error('unknown case'); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const served = await fetch(`${base}/src/units/roster.ts`).then((r) => r.text()).catch(() => '');
if (!served) { console.error(`FATAL: nothing served at ${base}`); process.exit(2); }
const sag = served.match(/id: 'sagittarii'[\s\S]{0,700}?missile: \{([^}]*)\}/);
console.log(`source: ${base}`);
console.log(`sagittarii missile: {${sag ? sag[1].trim() : '??'}}`);
console.log(`case:   ${spec.id}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

const r = await page.evaluate(async ([spec, until]) => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const p = b.pool;
  for (const u of b.units) {
    if (u.destroyed) continue;
    for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11);
    u.alive = 0; u.destroyed = true;
  }
  const shared = await import('/src/sim/combatShared.ts');
  shared.resetCombatShared();
  ctx.tryGet('morale')?.redeploy?.();
  for (const name of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage']) {
    const s = ctx.tryGet(name);
    if (s?.fixedUpdate) s.fixedUpdate = () => {};
  }
  b.unitSizeScale = 1;
  const half = spec.gap / 2;
  const idA = b.spawnUnit(spec.a.type, 0, half, Math.PI, spec.a.form);
  const idB = b.spawnUnit(spec.b.type, 0, -half, 0, spec.b.form);
  const A = b.unitById(idA); const B = b.unitById(idB);
  if (!A || !B) return { error: 'spawn failed' };
  ctx.events.emit('orderIssued', { unitIds: [A.id], kind: 'halt' });
  ctx.events.emit('orderIssued', { unitIds: [B.id], kind: 'attack', targetUnitId: A.id });

  const pr = ctx.get('projectiles');
  const cen = () => {
    const d = pr.debugProjectiles();
    const bow = d.kinds.find((k) => k.kind === 'bow') ?? {};
    const jav = d.kinds.find((k) => k.kind === 'javelin') ?? {};
    return {
      bl: bow.launched ?? 0, bh: bow.hitMan ?? 0, bk: bow.killed ?? 0,
      bb: bow.blockedByShield ?? 0, bu: bow.unreachable ?? 0, bd: bow.damage ?? 0,
      jl: jav.launched ?? 0, jh: jav.hitMan ?? 0, jk: jav.killed ?? 0,
    };
  };
  const rows = [];
  const start = g.simTime();
  let prev = cen();
  let decidedAt = -1; let winner = '';
  for (let t = 0; t <= until; t += 1) {
    g.advance(1);
    const c = cen();
    const gap = Math.hypot(A.x - B.x, A.z - B.z);
    let fighting = 0;
    for (let i = 0; i < p.count; i++) if (p.state[i] === 4) fighting++;
    rows.push({
      t: Math.round(g.simTime() - start),
      gap: +gap.toFixed(1),
      front: +Math.min(999, b.frontGapOf(A.id)).toFixed(1),
      aA: A.alive, bA: B.alive,
      aM: Math.round(A.morale), bM: Math.round(B.morale),
      fight: fighting,
      bl: c.bl - prev.bl, bh: c.bh - prev.bh, bk: c.bk - prev.bk, bb: c.bb - prev.bb,
      jl: c.jl - prev.jl, jh: c.jh - prev.jh, jk: c.jk - prev.jk,
      ammo: A.ammo,
    });
    prev = c;
    const aDone = A.alive === 0 || A.order === 5;
    const bDone = B.alive === 0 || B.order === 5;
    if (aDone || bDone) { decidedAt = Math.round(g.simTime() - start); winner = aDone && bDone ? 'both' : aDone ? 'B' : 'A'; break; }
  }
  return {
    decidedAt, winner, rows,
    aInit: A.initialStrength, bInit: B.initialStrength, aAlive: A.alive, bAlive: B.alive,
    aMor: Math.round(A.morale), bMor: Math.round(B.morale), aMax: A.maxMorale, bMax: B.maxMorale,
  };
}, [spec, UNTIL]);

if (r.error) { console.error(r.error); await browser.close(); process.exit(1); }

console.log('');
console.log(`decided ${r.decidedAt < 0 ? 'timeout' : 't+' + r.decidedAt + 's'}  winner ${r.winner || 'neither'}`);
console.log(`A sagittarii ${r.aAlive}/${r.aInit} (${Math.round(100 * (1 - r.aAlive / r.aInit))}% lost) morale ${r.aMor}/${r.aMax}`);
console.log(`B ${spec.b.type} ${r.bAlive}/${r.bInit} (${Math.round(100 * (1 - r.bAlive / r.bInit))}% lost) morale ${r.bMor}/${r.bMax}`);

// --- the charge, sliced by the ten metres it is crossing ---
console.log('');
console.log('the approach, by the range band the arrows were loosed at');
console.log(' band(m)   secs  arrows  hits  blocked  kills  hit%   kill/arrow%   B alive at exit');
const BANDS = [160, 140, 120, 100, 80, 60, 40, 20, 0];
for (let k = 0; k < BANDS.length - 1; k++) {
  const hi = BANDS[k]; const lo = BANDS[k + 1];
  const rs = r.rows.filter((x) => x.front <= hi && x.front > lo && x.fight === 0);
  if (!rs.length) continue;
  const s = (f) => rs.reduce((a, x) => a + f(x), 0);
  const bl = s((x) => x.bl); const bh = s((x) => x.bh); const bk = s((x) => x.bk); const bb = s((x) => x.bb);
  console.log(
    `${String(hi).padStart(4)}-${String(lo).padEnd(4)} ${String(rs.length).padStart(6)}`
    + `${String(bl).padStart(8)}${String(bh).padStart(6)}${String(bb).padStart(9)}${String(bk).padStart(7)}`
    + `${(bl ? (100 * bh / bl).toFixed(1) : '-').padStart(7)}`
    + `${(bl ? (100 * bk / bl).toFixed(2) : '-').padStart(14)}`
    + `${String(rs.at(-1).bA).padStart(18)}`
  );
}
const pre = r.rows.filter((x) => x.fight === 0);
const s = (f) => pre.reduce((a, x) => a + f(x), 0);
console.log('');
console.log(`before contact: ${pre.length} s, arrows ${s((x) => x.bl)}, hits ${s((x) => x.bh)},`
  + ` blocked ${s((x) => x.bb)}, kills ${s((x) => x.bk)}`
  + `  -> B lost ${r.bInit - (pre.at(-1)?.bA ?? r.bInit)} of ${r.bInit} on the way in`);
console.log('');
console.log('   t   front   Aal  Bal  Amor Bmor  fight  arrows hits kills  ammo');
for (const x of r.rows) {
  if (x.t % 5 !== 0 && x.t > 6) continue;
  console.log(
    `${String(x.t).padStart(4)}${String(x.front).padStart(8)}${String(x.aA).padStart(6)}${String(x.bA).padStart(5)}`
    + `${String(x.aM).padStart(6)}${String(x.bM).padStart(5)}${String(x.fight).padStart(7)}`
    + `${String(x.bl).padStart(8)}${String(x.bh).padStart(5)}${String(x.bk).padStart(6)}${String(x.ammo).padStart(6)}`
  );
}
if (errors.length) { console.log(`page errors ${errors.length}: ${[...new Set(errors)].slice(0, 4).join(' | ')}`); }
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify(r, null, 2)); console.log(`wrote ${JSON_OUT}`); }
await browser.close();
process.exit(0);
