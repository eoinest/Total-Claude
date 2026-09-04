#!/usr/bin/env node
/**
 * Why do the elephants underperform? — an instrumented run of the Punic field battle.
 *
 * The owner says they are too weak. "Too weak" has several possible causes with opposite
 * fixes, so this measures rather than guesses. It runs `?enemy=carthage` on the Campus
 * Martius, wraps the six places the simulation can hurt or credit an elephant, and reports:
 *
 *   deaths     when each animal died, to what (melee / missile / friendly), fired by which
 *              unit type, and whether the animal had ever landed a blow first
 *   contact    how many animals ever reach melee at all, and at what time
 *   charge     how often `Combat.chargeFactor` returns non-zero for an elephant unit, and
 *              how often `cavalryImpact` fires — the 90-point charge bonus is worthless if
 *              the plumbing never applies it
 *   kills      men killed per animal, from `UnitGroupState.kills`
 *   rout       when each elephant unit broke, and what the Punic line was doing after
 *   damage     total melee vs missile damage landed on the elephants
 *
 * Everything is read out of the simulation's own state; nothing is drawn.
 *
 *   node tools/scratch/ele-diag.mjs --port=5941 --secs=240 --json=out.json --label=before
 */

import path from 'node:path';
import process from 'node:process';
import { writeFile } from 'node:fs/promises';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5941);
const SECS = Number(args.get('secs') ?? 240);
const STEP = Number(args.get('step') ?? 2);
const LABEL = String(args.get('label') ?? 'now');
const JSON_OUT = args.get('json') ? path.resolve(ROOT, args.get('json')) : null;
const QUALITY = String(args.get('quality') ?? 'low');

const browser = await launchBrowser({ label: 'ele-diag', port: PORT, root: ROOT });
let server = null;
let out = null;
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-diag', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=${QUALITY}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true,
    null, { timeout: 240000 });

  // -------------------------------------------------------------------------
  // Instrument. Every wrapper is an own property over a prototype method, so the
  // simulation is untouched: nothing here changes a number the sim reads back.
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const combat = g.engine.ctx.tryGet('combat');
    const proj = g.engine.ctx.tryGet('projectiles');

    const R = {
      phase: 'boot',
      deaths: [],            // every elephant that died
      allDeaths: 0,
      punicDeaths: 0,
      romanDeaths: 0,
      contactAt: {},         // pool index -> sim time of its first landed blow
      impactAt: {},          // pool index -> sim time of its first cavalryImpact
      chargeCalls: 0,
      chargeLive: 0,         // returns > 0
      chargeSum: 0,
      chargeMax: 0,
      impacts: 0,
      impactsBraced: 0,
      blows: 0,
      blowsWithCharge: 0,
      dmgMelee: 0,
      dmgMissile: 0,
      dmgOther: 0,
      routs: [],
      counterKills: 0,       // animals killed by the braced counter-charge
      series: [],
    };
    window.__ELE = R;

    const eleIds = new Set(b.units.filter((u) => u.typeId === 'war-elephants').map((u) => u.id));
    const eleMembers = new Set();
    for (const u of b.units) {
      if (u.typeId === 'war-elephants') for (const i of u.members) eleMembers.add(i);
    }
    R.animals = eleMembers.size;
    R.eleUnits = [...eleIds];
    R.headcount = b.pool.count;

    // --- source attribution: which system is running right now ---
    const mark = (sys, tag) => {
      if (!sys || !sys.fixedUpdate) return;
      const inner = sys.fixedUpdate.bind(sys);
      sys.fixedUpdate = (dt, ctx) => { R.phase = tag; inner(dt, ctx); R.phase = 'other'; };
    };
    mark(combat, 'melee');
    mark(proj, 'missile');

    // --- damage on an animal, and the tick it died ---
    const dmg = b.damage.bind(b);
    b.damage = (i, amount, fromX, fromZ, attackerUnitId) => {
      const isEle = eleMembers.has(i);
      if (isEle && b.pool.aliveAt(i)) {
        if (R.phase === 'melee') R.dmgMelee += amount;
        else if (R.phase === 'missile') R.dmgMissile += amount;
        else R.dmgOther += amount;
      }
      const lethal = dmg(i, amount, fromX, fromZ, attackerUnitId);
      if (!lethal) return lethal;
      R.allDeaths++;
      const fac = b.pool.faction[i];
      if (fac === 2 || fac === 1) { /* faction ordinals resolved below */ }
      const killer = b.unitById(attackerUnitId);
      if (isEle) {
        const u = b.unitById(b.pool.unitId[i]);
        // Distance from this animal to the nearest living enemy soldier.
        let nearest = 1e9;
        const p = b.pool;
        for (let j = 0; j < p.count; j++) {
          if (!p.aliveAt(j)) continue;
          if (p.faction[j] === p.faction[i]) continue;
          const dx = p.x[j] - p.x[i];
          const dz = p.z[j] - p.z[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < nearest) nearest = d2;
        }
        R.deaths.push({
          i,
          t: +g.simTime().toFixed(2),
          by: R.phase,
          killer: killer ? killer.typeId : null,
          amount: +amount.toFixed(1),
          nearestEnemy: +Math.sqrt(nearest).toFixed(1),
          hadContact: R.contactAt[i] !== undefined,
          hadImpact: R.impactAt[i] !== undefined,
          unitAlive: u ? u.alive : -1,
          unitOrder: u ? u.order : -1,
        });
      }
      return lethal;
    };

    // --- charge factor, per call, for elephant units only ---
    const cf = combat.chargeFactor.bind(combat);
    combat.chargeFactor = (u, def, f, mods, id) => {
      const v = cf(u, def, f, mods, id);
      if (eleIds.has(u.id)) {
        R.chargeCalls++;
        if (v > 0) { R.chargeLive++; R.chargeSum += v; if (v > R.chargeMax) R.chargeMax = v; }
      }
      return v;
    };

    // --- the physical impact ---
    const ci = combat.cavalryImpact.bind(combat);
    combat.cavalryImpact = (i, t, u, def, mods, chargeF, speed) => {
      if (eleIds.has(u.id)) {
        R.impacts++;
        if (R.impactAt[i] === undefined) R.impactAt[i] = +g.simTime().toFixed(2);
        const dv = b.unitById(b.pool.unitId[t]);
        const ddef = dv ? b.typeOf(dv) : null;
        if (ddef && ddef.reach >= 2.2) R.impactsBraced++;
        const aliveBefore = b.pool.aliveAt(i);
        ci(i, t, u, def, mods, chargeF, speed);
        if (aliveBefore && !b.pool.aliveAt(i)) R.counterKills++;
        return;
      }
      ci(i, t, u, def, mods, chargeF, speed);
    };

    // --- every blow an animal throws ---
    const rb = combat.resolveBlow.bind(combat);
    combat.resolveBlow = (i, t, u, def, f, mods, chargeF, cav) => {
      if (eleIds.has(u.id)) {
        R.blows++;
        if (chargeF > 0) R.blowsWithCharge++;
        if (R.contactAt[i] === undefined) R.contactAt[i] = +g.simTime().toFixed(2);
      }
      rb(i, t, u, def, f, mods, chargeF, cav);
    };

    // --- routs ---
    const rout = b.rout.bind(b);
    b.rout = (u) => {
      if (u.order !== 5 && !u.destroyed) {
        R.routs.push({
          t: +g.simTime().toFixed(2), id: u.id, type: u.typeId,
          alive: u.alive, morale: +u.morale.toFixed(1), faction: u.faction,
        });
      }
      rout(u);
    };
  });

  // -------------------------------------------------------------------------
  // Run.
  // -------------------------------------------------------------------------
  const secs = SECS;
  for (let t = 0; t < secs; t += STEP) {
    await page.evaluate((s) => window.__game.fastForward(s), STEP);
    await page.evaluate(() => {
      const g = window.__game;
      const b = g.battle;
      const R = window.__ELE;
      const ele = b.units.filter((u) => u.typeId === 'war-elephants');
      let alive = 0; let kills = 0; let morale = 0; let routing = 0;
      let nearest = 1e9;
      for (const u of ele) {
        alive += u.alive; kills += u.kills; morale += u.morale;
        if (u.order === 5) routing++;
        for (const i of u.members) {
          if (!b.pool.aliveAt(i)) continue;
          const p = b.pool;
          for (let j = 0; j < p.count; j += 7) {
            if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) continue;
            const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
            const d2 = dx * dx + dz * dz;
            if (d2 < nearest) nearest = d2;
          }
        }
      }
      let rome = 0; let punic = 0;
      for (const u of b.units) {
        if (u.destroyed) continue;
        if (u.faction === 0) rome += u.alive; else punic += u.alive;
      }
      R.series.push({
        t: +g.simTime().toFixed(1),
        eleAlive: alive,
        eleKills: kills,
        eleMorale: ele.length ? +(morale / ele.length).toFixed(1) : 0,
        eleRouting: routing,
        nearest: nearest < 1e9 ? +Math.sqrt(nearest).toFixed(1) : -1,
        rome, punic,
      });
    });
  }

  out = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const R = window.__ELE;
    const ele = b.units.filter((u) => u.typeId === 'war-elephants');
    const flow = g.engine.ctx.tryGet('battleFlow');
    let rome = 0; let punic = 0; let romeStart = 0; let punicStart = 0;
    for (const u of b.units) {
      const alive = u.destroyed ? 0 : u.alive;
      if (u.faction === 0) { rome += alive; romeStart += u.members.length; }
      else { punic += alive; punicStart += u.members.length; }
    }
    return {
      ...R,
      simTime: +g.simTime().toFixed(1),
      eleUnitsFinal: ele.map((u) => ({
        id: u.id, name: u.name, alive: u.alive, of: u.members.length,
        kills: u.kills, morale: +u.morale.toFixed(1), order: u.order, destroyed: u.destroyed,
      })),
      rome, punic, romeStart, punicStart,
      result: flow ? (flow.result ?? null) : null,
    };
  });
  out.errors = errors;
  out.label = LABEL;
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}

// ---------------------------------------------------------------------------
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const t = out;
console.log(`\n=== ele-diag [${t.label}] — ${t.animals} animals, headcount ${t.headcount}, t+${t.simTime}s ===`);
console.log(`armies: Rome ${t.rome}/${t.romeStart}   Carthage ${t.punic}/${t.punicStart}   result ${JSON.stringify(t.result)}`);
console.log(`\nanimals: ${t.eleUnitsFinal.map((u) => `${u.alive}/${u.of}`).join('  ')}`
  + `   kills ${t.eleUnitsFinal.reduce((a, u) => a + u.kills, 0)}`);
const dead = t.deaths.length;
console.log(`\ndeaths (${dead}):`);
const byCause = {};
for (const d of t.deaths) {
  const k = `${d.by}/${d.killer ?? 'nobody'}`;
  byCause[k] = (byCause[k] ?? 0) + 1;
}
for (const [k, n] of Object.entries(byCause).sort((a, b2) => b2[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}
const beforeContact = t.deaths.filter((d) => !d.hadContact).length;
console.log(`  died before ever landing a blow: ${beforeContact}/${dead} (${pct(beforeContact, dead)})`);
console.log(`  died before ever charging home:  ${t.deaths.filter((d) => !d.hadImpact).length}/${dead}`);
console.log(`  median nearest enemy at death:   ${
  dead ? t.deaths.map((d) => d.nearestEnemy).sort((a, b2) => a - b2)[dead >> 1] : 'n/a'} m`);
console.log(`  killed by the braced counter-charge in cavalryImpact: ${t.counterKills}`);
console.log(`\ncharge plumbing:`);
console.log(`  chargeFactor calls ${t.chargeCalls}, non-zero ${t.chargeLive} (${pct(t.chargeLive, t.chargeCalls)})`
  + `  mean-when-live ${t.chargeLive ? (t.chargeSum / t.chargeLive).toFixed(3) : 'n/a'}  max ${t.chargeMax.toFixed(3)}`);
console.log(`  blows thrown ${t.blows}, of which with a live charge ${t.blowsWithCharge} (${pct(t.blowsWithCharge, t.blows)})`);
console.log(`  cavalryImpact fired ${t.impacts} (${t.impactsBraced} onto a >=2.2 m reach defender)`);
console.log(`  animals that ever landed a blow: ${Object.keys(t.contactAt).length}/${t.animals}`);
console.log(`  animals that ever charged home:  ${Object.keys(t.impactAt).length}/${t.animals}`);
console.log(`\ndamage taken by the animals: melee ${t.dmgMelee.toFixed(0)}  missile ${t.dmgMissile.toFixed(0)}  other ${t.dmgOther.toFixed(0)}`);
console.log(`\nroutes:`);
for (const r of t.routs.filter((r2) => r2.type === 'war-elephants')) {
  console.log(`  t+${r.t}s  unit ${r.id} ${r.alive} left, morale ${r.morale}`);
}
console.log(`  (total units routed this battle: ${t.routs.length})`);
console.log(`\nseries (t, eleAlive, eleKills, morale, routing, nearestEnemy, rome, punic):`);
for (const s of t.series) {
  if (s.t % 10 !== 0 && s.t > 4) continue;
  console.log(`  ${String(s.t).padStart(5)}  ${String(s.eleAlive).padStart(3)}  ${String(s.eleKills).padStart(4)}`
    + `  ${String(s.eleMorale).padStart(6)}  ${s.eleRouting}  ${String(s.nearest).padStart(6)}`
    + `  ${String(s.rome).padStart(5)}  ${String(s.punic).padStart(5)}`);
}
if (t.errors.length) console.log(`\nPAGE ERRORS:\n  ${t.errors.slice(0, 10).join('\n  ')}`);

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`\njson: ${JSON_OUT}`);
}
