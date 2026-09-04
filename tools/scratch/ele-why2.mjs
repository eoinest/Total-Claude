#!/usr/bin/env node
/**
 * The elephants stand among twenty-six Romans and have no opponent. This says why.
 *
 * `ele-why` measured the fact: 3,753 animal-ticks with an enemy inside the 3.46 m acquire
 * radius and no target against 496 with one, a median of 26 enemies in reach at the moment of
 * death, and four blows from thirty-two animals. That is not a balance number, so this
 * reproduces `Combat`'s own acquire and keep tests from outside and buckets every rejection:
 *
 *   keep   — why the opponent it had a tick ago is gone: he died, he is out of `keepR`, or the
 *            animal itself stopped being able to hold him
 *   acquire— of the enemies in reach, how many are refused for `CROWD_HARD_CAP`, how many for
 *            level, and whether the unit's own `engageCap` was full
 *   motion — the animal's speed, because a body that crosses `keepR` between two acquisitions
 *            can never complete an attack cycle
 *
 *   node tools/scratch/ele-why2.mjs --port=5945 --secs=140 --from=100
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
const PORT = Number(args.get('port') ?? 5945);
const FROM = Number(args.get('from') ?? 100);
const TO = Number(args.get('to') ?? 140);
const JSON_OUT = args.get('json') ? path.resolve(ROOT, args.get('json')) : null;

const browser = await launchBrowser({ label: 'ele-why2', port: PORT, root: ROOT });
let server = null;
let out = null;
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-why2', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=low`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true,
    null, { timeout: 240000 });

  // Run up to the window with no instrumentation at all, so the approach costs nothing.
  await page.evaluate((s) => window.__game.fastForward(s), FROM);

  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const combat = g.engine.ctx.tryGet('combat');

    const animals = [];
    for (const u of b.units) {
      if (u.typeId === 'war-elephants') for (const i of u.members) animals.push(i);
    }
    const def = b.typeOf(b.unitById(p.unitId[animals[0]]));
    const ACQ_R = def.reach + 0.86;
    const KEEP_R = def.reach + 0.86 + 0.32;

    const S = {
      reach: def.reach, ACQ_R, KEEP_R,
      ticks: 0,
      // keep-side
      keptTarget: 0, lostTargetDead: 0, lostTargetRange: 0, lostOther: 0,
      lostRangeDist: [],
      // acquire-side
      noTargetInReach: 0, noTargetInReachAllCrowded: 0, crowdedFraction: [],
      engageCapFull: 0, engageCapValue: 0, holdingValue: [],
      routingTicks: 0,
      // motion
      speeds: [], speedsWithTarget: [], speedsNoTarget: [],
      states: {},
      impactsSeen: 0, blowsSeen: 0,
      attackersOnAnimals: [],
    };
    window.__W2 = S;

    const prevTarget = new Map();
    for (const i of animals) prevTarget.set(i, -1);

    const rb = combat.resolveBlow.bind(combat);
    combat.resolveBlow = (i, t, u, d, f, m, cf, cav) => {
      if (u.typeId === 'war-elephants') S.blowsSeen++;
      rb(i, t, u, d, f, m, cf, cav);
    };
    const ci = combat.cavalryImpact.bind(combat);
    combat.cavalryImpact = (i, t, u, d, m, cf, sp) => {
      if (u.typeId === 'war-elephants') S.impactsSeen++;
      ci(i, t, u, d, m, cf, sp);
    };

    const inner = combat.fixedUpdate.bind(combat);
    combat.fixedUpdate = (dt, ctx) => {
      // Snapshot last tick's targets and positions before the melee runs again.
      inner(dt, ctx);
      S.ticks++;
      for (const i of animals) {
        if (!p.aliveAt(i)) { prevTarget.set(i, -1); continue; }
        const st = p.state[i];
        S.states[st] = (S.states[st] ?? 0) + 1;
        if (st === 12) { S.routingTicks++; prevTarget.set(i, -1); continue; }

        const sp = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
        if (S.speeds.length < 40000) S.speeds.push(+sp.toFixed(2));

        const t = p.target[i];
        const pt = prevTarget.get(i);
        if (t >= 0) {
          S.keptTarget++;
          if (S.speedsWithTarget.length < 40000) S.speedsWithTarget.push(+sp.toFixed(2));
        } else {
          if (S.speedsNoTarget.length < 40000) S.speedsNoTarget.push(+sp.toFixed(2));
          if (pt >= 0) {
            // We had one last tick and do not now. Which test threw him out?
            if (!p.aliveAt(pt)) S.lostTargetDead++;
            else {
              const dx = p.x[pt] - p.x[i]; const dz = p.z[pt] - p.z[i];
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d > KEEP_R) { S.lostTargetRange++; S.lostRangeDist.push(+d.toFixed(2)); }
              else S.lostOther++;
            }
          }
          // Is there anything to take, and why is it refused?
          let inReach = 0; let crowded = 0;
          b.hash.query(p.x[i], p.z[i], ACQ_R, (j) => {
            if (j === i) return;
            if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) return;
            if (Math.abs(p.y[j] - p.y[i]) > 1.9) return;
            const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
            if (dx * dx + dz * dz > ACQ_R * ACQ_R) return;
            inReach++;
            if (combat.attackers[j] >= 4) crowded++;
          });
          if (inReach > 0) {
            S.noTargetInReach++;
            if (crowded === inReach) S.noTargetInReachAllCrowded++;
            if (S.crowdedFraction.length < 40000) S.crowdedFraction.push(+(crowded / inReach).toFixed(2));
          }
        }
        prevTarget.set(i, t);
        if (S.attackersOnAnimals.length < 40000) S.attackersOnAnimals.push(combat.attackers[i]);
      }
      // Unit-level: is engageCap the binding constraint?
      for (const u of b.units) {
        if (u.typeId !== 'war-elephants' || u.destroyed || u.alive === 0) continue;
        let holding = 0;
        for (const i of u.members) if (p.aliveAt(i) && p.target[i] >= 0) holding++;
        const cap = Math.max(6, Math.round(Math.min(u.width, u.alive) * 1.8));
        S.engageCapValue = cap;
        if (S.holdingValue.length < 40000) S.holdingValue.push(holding);
        if (holding >= cap) S.engageCapFull++;
      }
    };
  });

  await page.evaluate((s) => window.__game.fastForward(s), TO - FROM);

  out = await page.evaluate(() => {
    const S = window.__W2;
    const g = window.__game;
    const b = g.battle;
    const stat = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, c) => a - c);
      return {
        n: s.length, min: s[0], p25: s[Math.floor(s.length * 0.25)],
        med: s[s.length >> 1], p75: s[Math.floor(s.length * 0.75)],
        p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1],
        mean: +(s.reduce((a, c) => a + c, 0) / s.length).toFixed(3),
      };
    };
    return {
      simTime: +g.simTime().toFixed(1),
      reach: S.reach, ACQ_R: S.ACQ_R, KEEP_R: S.KEEP_R,
      ticks: S.ticks,
      keptTarget: S.keptTarget,
      lostTargetDead: S.lostTargetDead,
      lostTargetRange: S.lostTargetRange,
      lostOther: S.lostOther,
      lostRangeDist: stat(S.lostRangeDist),
      noTargetInReach: S.noTargetInReach,
      noTargetInReachAllCrowded: S.noTargetInReachAllCrowded,
      crowdedFraction: stat(S.crowdedFraction),
      engageCapFull: S.engageCapFull,
      engageCapValue: S.engageCapValue,
      holding: stat(S.holdingValue),
      routingTicks: S.routingTicks,
      speeds: stat(S.speeds),
      speedsWithTarget: stat(S.speedsWithTarget),
      speedsNoTarget: stat(S.speedsNoTarget),
      attackersOnAnimals: stat(S.attackersOnAnimals),
      states: S.states,
      impacts: S.impactsSeen, blows: S.blowsSeen,
      units: b.units.filter((u) => u.typeId === 'war-elephants')
        .map((u) => ({ id: u.id, alive: u.alive, of: u.members.length, kills: u.kills, order: u.order, width: u.width, spacingX: +u.spacingX.toFixed(2) })),
    };
  });
  out.errors = errors;
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}

const S = out;
const STATE = ['Idle', 'Marching', 'Running', 'Charging', 'Fighting', 'Bracing', 'Throwing',
  'Shooting', 'Reloading', 'Staggered', 'Dying', 'Dead', 'Routing', 'Climbing', 'Cheering'];
console.log(`\n=== ele-why2 — window ${FROM}..${TO} s, ended t+${S.simTime}s ===`);
console.log(`reach ${S.reach} m, acquire ${S.ACQ_R.toFixed(2)} m, keep ${S.KEEP_R.toFixed(2)} m`);
console.log(`units: ${S.units.map((u) => `${u.alive}/${u.of} kills ${u.kills} order ${u.order} width ${u.width} spacingX ${u.spacingX}`).join(' | ')}`);
console.log(`\nblows ${S.blows}   cavalryImpacts ${S.impacts}`);
console.log(`\nanimal-ticks (non-routing): with a target ${S.keptTarget}, routing ${S.routingTicks}`);
console.log(`  target lost because he DIED:            ${S.lostTargetDead}`);
console.log(`  target lost because he was OUT OF KEEP: ${S.lostTargetRange}   ${JSON.stringify(S.lostRangeDist)}`);
console.log(`  target lost for another reason:         ${S.lostOther}`);
console.log(`\nno target, enemies within acquire radius: ${S.noTargetInReach}`);
console.log(`  ... of which every one was crowd-capped: ${S.noTargetInReachAllCrowded}`);
console.log(`  fraction of in-reach enemies crowd-capped: ${JSON.stringify(S.crowdedFraction)}`);
console.log(`\nengageCap ${S.engageCapValue}; unit-ticks at the cap ${S.engageCapFull}; holding ${JSON.stringify(S.holding)}`);
console.log(`\nspeed m/s        all: ${JSON.stringify(S.speeds)}`);
console.log(`speed with target: ${JSON.stringify(S.speedsWithTarget)}`);
console.log(`speed no target:   ${JSON.stringify(S.speedsNoTarget)}`);
console.log(`\nattackers on each animal: ${JSON.stringify(S.attackersOnAnimals)}`);
console.log(`\nstates: ${Object.entries(S.states).map(([k, v]) => `${STATE[k] ?? k} ${v}`).join(', ')}`);
if (S.errors.length) console.log(`\nPAGE ERRORS:\n  ${S.errors.slice(0, 8).join('\n  ')}`);
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify(out, null, 2)); console.log(`\njson: ${JSON_OUT}`); }
