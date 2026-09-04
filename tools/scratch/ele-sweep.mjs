#!/usr/bin/env node
/**
 * A candidate-by-candidate sweep of the elephant's stat block, on a controlled fight.
 *
 * One squadron of elephants against one Roman unit on clean ground, with the tactical AI, the
 * general AI and `battleFlow` stopped so nothing re-orders anybody, and — for the melee arm —
 * the morale system stopped too, because a rout is a different finding from a bad exchange.
 * Every arm is a **fresh page load**: the four RNGs are forks of `battle.rng` and there is no
 * way to rewind all of them, so a reload is the only honest reset.
 *
 * The variants are applied to the live `UnitTypeDef` **before the unit is spawned**, because
 * `attackCooldown` is seeded from `1 / attackRate` at spawn. So this measures exactly what
 * editing `src/units/roster.ts` would, without editing it once per candidate.
 *
 *   node tools/scratch/ele-sweep.mjs --port=5947 --secs=70 --json=sweep.json
 *   node tools/scratch/ele-sweep.mjs --only=base,A,B
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
const PORT = Number(args.get('port') ?? 5947);
const SECS = Number(args.get('secs') ?? 70);
const FOE = String(args.get('foe') ?? 'legio-cohort');
const MORALE = String(args.get('morale') ?? 'off');
const JSON_OUT = args.get('json') ? path.resolve(ROOT, args.get('json')) : null;

/**
 * The candidates.
 *
 * `base` is the shipped block and must stay first: every other row is read against it.
 * The rest are the levers the diagnosis actually points at, one at a time and then combined,
 * so the report can say which one bought what rather than "these six numbers changed".
 */
const VARIANTS = {
  base: {},
  hp200: { hitPoints: 200 },
  hp300: { hitPoints: 300 },
  hp400: { hitPoints: 400 },
  hp500: { hitPoints: 500 },
  hp300def: { hitPoints: 300, meleeDefence: 44 },
  hp300rate: { hitPoints: 300, attackRate: 0.72 },
  armour: { armour: 78 },
};
const ONLY = args.get('only') ? String(args.get('only')).split(',') : Object.keys(VARIANTS);

const browser = await launchBrowser({ label: 'ele-sweep', port: PORT, root: ROOT });
let server = null;
const rows = [];
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-sweep', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  for (const name of ONLY) {
    const patch = VARIANTS[name];
    if (!patch) { console.error(`no variant ${name}`); continue; }
    await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=low`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game && window.__game.ready === true,
      null, { timeout: 240000 });

    const r = await page.evaluate(({ name, patch, foe, morale, secs }) => {
      const g = window.__game;
      const b = g.battle;
      const p = b.pool;
      const combat = g.engine.ctx.tryGet('combat');

      // Clear the field.
      for (const u of b.units) { u.destroyed = true; u.alive = 0; }
      for (let i = 0; i < p.count; i++) p.state[i] = 11;
      const off = ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage'];
      if (morale === 'off') off.push('morale');
      for (const n of off) {
        const sys = g.engine.ctx.tryGet(n);
        if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
      }

      // Patch the roster row before spawning — `attackCooldown` is seeded from `attackRate`.
      const proto = b.units.find(() => true);
      void proto;
      const eleDef = (() => {
        // `typeOf` needs a unit; make a throwaway one, read its def, then discard it.
        const tmp = b.spawnUnit('war-elephants', 0, -400, 0, 'loose');
        const tu = b.unitById(tmp);
        const d = b.typeOf(tu);
        tu.destroyed = true; tu.alive = 0;
        for (const i of tu.members) p.state[i] = 11;
        return d;
      })();
      const before = {};
      for (const k of Object.keys(patch)) { before[k] = eleDef[k]; eleDef[k] = patch[k]; }

      const eleId = b.spawnUnit('war-elephants', 0, -30, 0, 'loose');
      const foeId = b.spawnUnit(foe, 0, 30, Math.PI, 'line');
      const ele = b.unitById(eleId);
      const fu = b.unitById(foeId);
      ele.order = 2; ele.targetX = 0; ele.targetZ = 40; ele.running = true;
      fu.order = 2; fu.targetX = 0; fu.targetZ = -40;

      const eleMembers = new Set(ele.members);
      const R = {
        blows: 0, blowsWithCharge: 0, impacts: 0, impactKills: 0, impactDamage: 0,
        chargeLive: 0, chargeCalls: 0, chargeSum: 0, chargeMax: 0,
        eleDeaths: 0, foeDeaths: 0, dmgToEle: 0, dmgToFoe: 0,
        fightingTicks: 0, aliveTicks: 0, targetTicks: 0,
      };
      const rb = combat.resolveBlow.bind(combat);
      combat.resolveBlow = (i, t, u, d, f, m, cf, cav) => {
        if (u.id === eleId) { R.blows++; if (cf > 0) R.blowsWithCharge++; }
        rb(i, t, u, d, f, m, cf, cav);
      };
      const ci = combat.cavalryImpact.bind(combat);
      combat.cavalryImpact = (i, t, u, d, m, cf, sp) => {
        if (u.id !== eleId) { ci(i, t, u, d, m, cf, sp); return; }
        R.impacts++;
        const hp0 = p.hp[t]; const alive0 = p.aliveAt(t);
        ci(i, t, u, d, m, cf, sp);
        R.impactDamage += Math.max(0, hp0 - p.hp[t]);
        if (alive0 && !p.aliveAt(t)) R.impactKills++;
      };
      const cf = combat.chargeFactor.bind(combat);
      combat.chargeFactor = (u, d, f, m, id) => {
        const v = cf(u, d, f, m, id);
        if (u.id === eleId) {
          R.chargeCalls++;
          if (v > 0) { R.chargeLive++; R.chargeSum += v; if (v > R.chargeMax) R.chargeMax = v; }
        }
        return v;
      };
      const dmg = b.damage.bind(b);
      b.damage = (i, amount, fx, fz, aid) => {
        const isEle = eleMembers.has(i);
        if (p.aliveAt(i)) { if (isEle) R.dmgToEle += amount; else R.dmgToFoe += amount; }
        const lethal = dmg(i, amount, fx, fz, aid);
        if (lethal) { if (isEle) R.eleDeaths++; else R.foeDeaths++; }
        return lethal;
      };
      const inner = combat.fixedUpdate.bind(combat);
      combat.fixedUpdate = (dt, ctx) => {
        inner(dt, ctx);
        for (const i of ele.members) {
          if (!p.aliveAt(i)) continue;
          R.aliveTicks++;
          if (p.state[i] === 4) R.fightingTicks++;
          if (p.target[i] >= 0) R.targetTicks++;
        }
      };

      for (let t = 0; t < secs; t += 2) g.fastForward(2);

      // Put the roster row back so a later arm on this page is not contaminated.
      for (const k of Object.keys(before)) eleDef[k] = before[k];

      return {
        name, patch, foe, morale,
        animals: ele.members.length, foeStrength: fu.members.length,
        eleAlive: ele.alive, foeAlive: fu.alive,
        eleKills: ele.kills, foeKills: fu.kills,
        eleMorale: +ele.morale.toFixed(1), foeMorale: +fu.morale.toFixed(1),
        eleRouted: ele.order === 5, foeRouted: fu.order === 5,
        blows: R.blows, blowsWithCharge: R.blowsWithCharge,
        impacts: R.impacts, impactKills: R.impactKills,
        meanImpact: R.impacts ? +(R.impactDamage / R.impacts).toFixed(1) : 0,
        chargeLive: R.chargeLive, chargeMax: +R.chargeMax.toFixed(3),
        chargeMean: R.chargeLive ? +(R.chargeSum / R.chargeLive).toFixed(3) : 0,
        eleDeaths: R.eleDeaths, foeDeaths: R.foeDeaths,
        dmgToEle: +R.dmgToEle.toFixed(0), dmgToFoe: +R.dmgToFoe.toFixed(0),
        fightingTicks: R.fightingTicks, aliveTicks: R.aliveTicks, targetTicks: R.targetTicks,
      };
    }, { name, patch, foe: FOE, morale: MORALE, secs: SECS });
    rows.push(r);
    console.log(`${String(r.name).padEnd(10)} animals ${String(r.eleAlive).padStart(2)}/${r.animals}`
      + `  foe ${String(r.foeAlive).padStart(3)}/${r.foeStrength}`
      + `  kills ${String(r.eleKills).padStart(3)}`
      + `  blows ${String(r.blows).padStart(4)}`
      + `  impacts ${String(r.impacts).padStart(3)} (lethal ${r.impactKills}, mean ${r.meanImpact})`
      + `  chargeMax ${r.chargeMax}`
      + `  fighting ${((r.fightingTicks / Math.max(1, r.aliveTicks)) * 100).toFixed(1)}%`);
  }
  if (errors.length) console.log(`\nPAGE ERRORS:\n  ${errors.slice(0, 8).join('\n  ')}`);
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}

console.log(`\n${'variant'.padEnd(10)} ${'patch'.padEnd(72)} kills  lost  exchange`);
const base = rows[0];
for (const r of rows) {
  const ex = r.eleDeaths ? (r.eleKills / r.eleDeaths).toFixed(2) : '  inf';
  const d = base && r !== base ? ` (${r.eleKills - base.eleKills >= 0 ? '+' : ''}${r.eleKills - base.eleKills} kills)` : '';
  console.log(`${r.name.padEnd(10)} ${JSON.stringify(r.patch).padEnd(72)} ${String(r.eleKills).padStart(5)} ${String(r.eleDeaths).padStart(5)}  ${ex}${d}`);
}
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify({ foe: FOE, morale: MORALE, secs: SECS, rows }, null, 2)); console.log(`\njson: ${JSON_OUT}`); }
