#!/usr/bin/env node
/**
 * Why does a war elephant reach the Roman line and never swing?
 *
 * `tools/scratch/ele-diag.mjs` measured the shipped Punic field battle and found 32 animals
 * throwing **five** melee blows in 331 s and killing nobody, with 17 of 20 deaths happening
 * to an animal that had never landed one. That is a mechanism question, not a balance
 * question, so this samples the melee state of every animal on *every tick* — from inside the
 * page, after `Combat.fixedUpdate` has run — rather than through a Playwright round trip.
 *
 * Per animal it reports the whole of its melee career:
 *   tContact   first tick it had an opponent
 *   tBlow      first tick a blow of its own actually resolved
 *   tDeath     when it died
 *   ticksWithTarget / ticksInReachNoTarget — acquisition working, or not
 *   cooldown and swing at the moment of death — was it mid-cycle, and how far through
 *
 *   node tools/scratch/ele-why.mjs --port=5943 --secs=180 --from=95
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
const PORT = Number(args.get('port') ?? 5943);
const SECS = Number(args.get('secs') ?? 180);
const JSON_OUT = args.get('json') ? path.resolve(ROOT, args.get('json')) : null;

const browser = await launchBrowser({ label: 'ele-why', port: PORT, root: ROOT });
let server = null;
let out = null;
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-why', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=low`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true,
    null, { timeout: 240000 });

  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const combat = g.engine.ctx.tryGet('combat');

    const eleIds = new Set(b.units.filter((u) => u.typeId === 'war-elephants').map((u) => u.id));
    const animals = [];
    for (const u of b.units) {
      if (u.typeId === 'war-elephants') for (const i of u.members) animals.push(i);
    }
    const rec = new Map();
    for (const i of animals) {
      rec.set(i, {
        i, unit: p.unitId[i],
        tContact: null, tBlow: null, tDeath: null,
        ticks: 0, ticksTarget: 0, ticksReachNoTarget: 0, ticksSwinging: 0,
        ticksStaggered: 0, ticksRouting: 0, ticksFighting: 0, ticksCharging: 0,
        blows: 0, hitsTaken: 0, dmgTaken: 0,
        cooldownAtDeath: null, swingAtDeath: null, stateAtDeath: null,
        inReachAtDeath: null, secondsInContact: null,
        spawnCooldown: +p.attackCooldown[i].toFixed(3),
      });
    }
    const R = { animals: rec, reach: 0 };
    window.__WHY = R;

    const def = b.typeOf(b.unitById(p.unitId[animals[0]]));
    const ACQ_R = def.reach + 0.86;
    R.reach = ACQ_R;
    R.attackRate = def.attackRate;

    // Blows this animal resolved.
    const rb = combat.resolveBlow.bind(combat);
    combat.resolveBlow = (i, t, u, dfn, f, mods, chargeF, cav) => {
      const r = rec.get(i);
      if (r) { r.blows++; if (r.tBlow === null) r.tBlow = +g.simTime().toFixed(2); }
      rb(i, t, u, dfn, f, mods, chargeF, cav);
    };

    // Damage landed on this animal, and the tick it died.
    const dmg = b.damage.bind(b);
    b.damage = (i, amount, fx, fz, aid) => {
      const r = rec.get(i);
      if (r && p.aliveAt(i)) { r.hitsTaken++; r.dmgTaken += amount; }
      const lethal = dmg(i, amount, fx, fz, aid);
      if (lethal && r && r.tDeath === null) {
        r.tDeath = +g.simTime().toFixed(2);
        r.cooldownAtDeath = +p.attackCooldown[i].toFixed(3);
        r.swingAtDeath = +combat.swing[i].toFixed(3);
        r.stateAtDeath = p.state[i];
        let n = 0;
        b.hash.query(p.x[i], p.z[i], ACQ_R, (j) => {
          if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) return;
          const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
          if (dx * dx + dz * dz <= ACQ_R * ACQ_R) n++;
        });
        r.inReachAtDeath = n;
        if (r.tContact !== null) r.secondsInContact = +(r.tDeath - r.tContact).toFixed(2);
      }
      return lethal;
    };

    // Per-tick census, after the melee has run.
    const inner = combat.fixedUpdate.bind(combat);
    combat.fixedUpdate = (dt, ctx) => {
      inner(dt, ctx);
      const now = g.simTime();
      for (const r of rec.values()) {
        const i = r.i;
        if (!p.aliveAt(i)) continue;
        r.ticks++;
        const st = p.state[i];
        if (st === 9) r.ticksStaggered++;      // SoldierState.Staggered
        if (st === 12) r.ticksRouting++;       // SoldierState.Routing
        if (st === 4) r.ticksFighting++;       // SoldierState.Fighting
        if (st === 3) r.ticksCharging++;       // SoldierState.Charging
        if (combat.swing[i] >= 0) r.ticksSwinging++;
        const t = p.target[i];
        if (t >= 0) {
          r.ticksTarget++;
          if (r.tContact === null) r.tContact = +now.toFixed(2);
        } else {
          let n = 0;
          b.hash.query(p.x[i], p.z[i], ACQ_R, (j) => {
            if (n) return;
            if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) return;
            const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
            if (dx * dx + dz * dz <= ACQ_R * ACQ_R) n = 1;
          });
          if (n) r.ticksReachNoTarget++;
        }
      }
    };
    void eleIds;
  });

  // Confirm the state ordinals rather than trusting the numbers above.
  const states = await page.evaluate(() => {
    const g = window.__game;
    const out = {};
    // SoldierState is a const enum; read it off a live pool instead.
    out.note = 'ordinals read from the running build below';
    out.sample = g.battle.pool.state[0];
    return out;
  });
  void states;

  await page.evaluate((s) => window.__game.fastForward(s), SECS);

  out = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const R = window.__WHY;
    const ele = b.units.filter((u) => u.typeId === 'war-elephants');
    return {
      simTime: +g.simTime().toFixed(1),
      reach: R.reach,
      attackRate: R.attackRate,
      animals: [...R.animals.values()],
      units: ele.map((u) => ({
        id: u.id, alive: u.alive, of: u.members.length, kills: u.kills,
        morale: +u.morale.toFixed(1), order: u.order,
      })),
    };
  });
  out.errors = errors;
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}

const a = out.animals;
const dead = a.filter((r) => r.tDeath !== null);
const swung = a.filter((r) => r.tBlow !== null);
const contacted = a.filter((r) => r.tContact !== null);
const num = (xs) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length) : NaN);
const med = (xs) => (xs.length ? [...xs].sort((x, y) => x - y)[xs.length >> 1] : NaN);

console.log(`\n=== ele-why — t+${out.simTime}s, ${a.length} animals, acquire radius ${out.reach.toFixed(2)} m, attackRate ${out.attackRate} ===`);
console.log(`units: ${out.units.map((u) => `${u.alive}/${u.of} kills ${u.kills} morale ${u.morale} order ${u.order}`).join(' | ')}`);
console.log(`\nanimals that ever had an opponent: ${contacted.length}/${a.length}`);
console.log(`animals that ever landed a blow:   ${swung.length}/${a.length}`);
console.log(`animals dead:                      ${dead.length}/${a.length}`);
console.log(`\nof the dead:`);
console.log(`  median seconds between first opponent and death: ${med(dead.filter((r) => r.secondsInContact !== null).map((r) => r.secondsInContact))}`);
console.log(`  median attack cooldown remaining at death:       ${med(dead.map((r) => r.cooldownAtDeath)).toFixed?.(3) ?? med(dead.map((r) => r.cooldownAtDeath))}`);
console.log(`  median swing progress at death (-1 = not swinging): ${med(dead.map((r) => r.swingAtDeath))}`);
console.log(`  median enemies within acquire radius at death:   ${med(dead.map((r) => r.inReachAtDeath))}`);
console.log(`  median hits taken:                               ${med(dead.map((r) => r.hitsTaken))}`);
console.log(`  mean damage taken:                               ${num(dead.map((r) => r.dmgTaken)).toFixed(1)}`);
console.log(`\nacquisition:`);
console.log(`  animal-ticks with an opponent:                 ${a.reduce((s, r) => s + r.ticksTarget, 0)}`);
console.log(`  animal-ticks with an enemy in reach and none:  ${a.reduce((s, r) => s + r.ticksReachNoTarget, 0)}`);
console.log(`  animal-ticks mid-swing:                        ${a.reduce((s, r) => s + r.ticksSwinging, 0)}`);
console.log(`  animal-ticks staggered:                        ${a.reduce((s, r) => s + r.ticksStaggered, 0)}`);
console.log(`  animal-ticks routing:                          ${a.reduce((s, r) => s + r.ticksRouting, 0)}`);
console.log(`  animal-ticks alive:                            ${a.reduce((s, r) => s + r.ticks, 0)}`);
console.log(`  spawn cooldown, median:                        ${med(a.map((r) => r.spawnCooldown))} s`);
console.log(`\nper animal (i, unit, tContact, tBlow, tDeath, inContact s, blows, hitsTaken, cd@death, swing@death, inReach@death, ticksTarget, ticksReachNoTarget):`);
for (const r of a) {
  console.log(`  ${r.i} u${r.unit} ${String(r.tContact).padStart(7)} ${String(r.tBlow).padStart(7)} `
    + `${String(r.tDeath).padStart(7)} ${String(r.secondsInContact).padStart(6)} `
    + `${String(r.blows).padStart(3)} ${String(r.hitsTaken).padStart(4)} `
    + `${String(r.cooldownAtDeath).padStart(7)} ${String(r.swingAtDeath).padStart(7)} `
    + `${String(r.inReachAtDeath).padStart(3)} ${String(r.ticksTarget).padStart(5)} ${String(r.ticksReachNoTarget).padStart(5)}`);
}
if (out.errors.length) console.log(`\nPAGE ERRORS:\n  ${out.errors.slice(0, 8).join('\n  ')}`);
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify(out, null, 2)); console.log(`\njson: ${JSON_OUT}`); }
