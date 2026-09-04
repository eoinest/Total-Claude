#!/usr/bin/env node
/**
 * The elephant A/B, in **one browser run per side**: the measurement and the pictures.
 *
 * This exists in this shape because of the machine rather than because of the battle. Three
 * headless browsers rendering a 9,000-man field battle cost 595 % of CPU between them, the
 * owner is playing, and the boot is the expensive part of any run — so the diagnostic pass and
 * the photographic pass share one page load instead of taking a slot each. Everything before
 * and after the plates runs with `fastForward` (`render: false`), which skips the submit and
 * nothing else, so the battle is the same battle a run that never photographed it would have.
 *
 * Both sides run the identical schedule — same chunk size, same trigger rule, same plate
 * cadence — so the two are comparable even though the battle diverges, which is the point.
 *
 * The trigger is the elephants' own distance to the nearest living Roman, not a stopwatch:
 * after a change that gets them into contact sooner, a fixed t+110 s would photograph two
 * different parts of a battle and call it an A/B.
 *
 * What it reports, per side:
 *   deaths     when each animal died, to melee or missile, and whether it had ever swung
 *   contact    animal-ticks holding an opponent, animal-ticks `Fighting`, unit-ticks locked
 *   charge     `chargeFactor` live share and peak, `cavalryImpact` count and lethality
 *   kills      men killed, from `UnitGroupState.kills`
 *   rout       when each squadron broke, and Punic deaths under a routing animal afterwards
 *   armies     both headcounts through the battle, and who is winning at the end
 *
 *   node tools/scratch/ele-ab.mjs --port=5971 --label=before --secs=330
 */

import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5971);
const LABEL = String(args.get('label') ?? 'now');
const SECS = Number(args.get('secs') ?? 330);
const STEP = Number(args.get('step') ?? 2);
const QUALITY = String(args.get('quality') ?? 'high');
const TRIGGER = Number(args.get('trigger') ?? 16);
const PLATES = Number(args.get('plates') ?? 8);
const EVERY = Number(args.get('every') ?? 0.75);
const ZOOM = Number(args.get('zoom') ?? 0.40);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/ele-ab');
const JSON_OUT = path.resolve(ROOT, args.get('json') ?? `tools/scratch/ele-ab-${LABEL}.json`);

const load = () => os.loadavg().map((v) => v.toFixed(2)).join(' / ');
console.log(`machine load at start: ${load()}  (${os.cpus().length} cores)`);

const browser = await launchBrowser({ label: 'ele-ab', port: PORT, root: ROOT });
let server = null;
let out = null;
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-ab', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=${QUALITY}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true,
    null, { timeout: 300000 });
  await page.addStyleTag({
    content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
  });
  await page.evaluate(() => {
    const hud = window.__game?.engine?.ctx?.tryGet?.('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
  });

  // -------------------------------------------------------------------------
  // Instruments. Own properties over prototype methods: nothing the simulation
  // reads back is changed, so the battle is the one that would have run anyway.
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const combat = g.engine.ctx.tryGet('combat');
    const proj = g.engine.ctx.tryGet('projectiles');

    const eleUnits = b.units.filter((u) => u.typeId === 'war-elephants');
    const eleIds = new Set(eleUnits.map((u) => u.id));
    const eleMembers = new Set();
    for (const u of eleUnits) for (const i of u.members) eleMembers.add(i);

    const R = {
      phase: 'boot', animals: eleMembers.size, headcount: p.count,
      deaths: [], routs: [], series: [],
      blows: 0, blowsWithCharge: 0, swungAnimals: {},
      impacts: 0, impactKills: 0, impactDamage: 0,
      chargeCalls: 0, chargeLive: 0, chargeSum: 0, chargeMax: 0,
      chargeLiveWithAbility: 0, modsChargeMax: 0,
      entryHp: p.maxHp[[...eleMembers][0]],
      dmgMelee: 0, dmgMissile: 0,
      targetTicks: 0, fightingTicks: 0, aliveTicks: 0, lockedUnitTicks: 0, liveUnitTicks: 0,
      punicDeathsAfterFirstRout: 0, firstEleRoutT: null,
      punicDeathsNearRoutingAnimal: 0,
    };
    window.__AB = R;

    const mark = (sys, tag) => {
      if (!sys || !sys.fixedUpdate) return;
      const inner = sys.fixedUpdate.bind(sys);
      sys.fixedUpdate = (dt, ctx) => { R.phase = tag; inner(dt, ctx); R.phase = 'other'; };
    };
    mark(proj, 'missile');

    const dmg = b.damage.bind(b);
    b.damage = (i, amount, fx, fz, aid) => {
      const isEle = eleMembers.has(i);
      if (isEle && p.aliveAt(i)) {
        if (R.phase === 'missile') R.dmgMissile += amount; else R.dmgMelee += amount;
      }
      const lethal = dmg(i, amount, fx, fz, aid);
      if (!lethal) return lethal;
      const killer = b.unitById(aid);
      if (isEle) {
        let near = 1e9;
        for (let j = 0; j < p.count; j++) {
          if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) continue;
          const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < near) near = d2;
        }
        const u = b.unitById(p.unitId[i]);
        R.deaths.push({
          i, t: +g.simTime().toFixed(2), by: R.phase === 'missile' ? 'missile' : 'melee',
          killer: killer ? killer.typeId : null,
          nearestEnemy: +Math.sqrt(near).toFixed(1),
          hadSwung: !!R.swungAnimals[i],
          unitAlive: u ? u.alive : -1, unitOrder: u ? u.order : -1,
        });
      } else if (p.faction[i] === 2) {
        // A Carthaginian. Is a routing elephant on top of him? That is the drawback the
        // roster argues for, measured rather than asserted.
        if (R.firstEleRoutT !== null) R.punicDeathsAfterFirstRout++;
        for (const u of eleUnits) {
          if (u.order !== 5 || u.destroyed) continue;
          let hit = false;
          for (const k of u.members) {
            if (!p.aliveAt(k)) continue;
            const dx = p.x[k] - p.x[i]; const dz = p.z[k] - p.z[i];
            if (dx * dx + dz * dz < 36) { hit = true; break; }
          }
          if (hit) { R.punicDeathsNearRoutingAnimal++; break; }
        }
      }
      return lethal;
    };

    const rb = combat.resolveBlow.bind(combat);
    combat.resolveBlow = (i, t, u, d, f, m, cf, cav) => {
      if (eleIds.has(u.id)) { R.blows++; R.swungAnimals[i] = 1; if (cf > 0) R.blowsWithCharge++; }
      rb(i, t, u, d, f, m, cf, cav);
    };
    const ci = combat.cavalryImpact.bind(combat);
    combat.cavalryImpact = (i, t, u, d, m, cf, sp) => {
      if (!eleIds.has(u.id)) { ci(i, t, u, d, m, cf, sp); return; }
      R.impacts++;
      const hp0 = p.hp[t]; const alive0 = p.aliveAt(t);
      ci(i, t, u, d, m, cf, sp);
      R.impactDamage += Math.max(0, hp0 - p.hp[t]);
      if (alive0 && !p.aliveAt(t)) R.impactKills++;
    };
    const cf = combat.chargeFactor.bind(combat);
    combat.chargeFactor = (u, d, f, m, id) => {
      const v = cf(u, d, f, m, id);
      if (eleIds.has(u.id)) {
        R.chargeCalls++;
        // `mods.charge` is 1.4 exactly while the `charge` ability is live and 1 otherwise
        // (`Abilities.ts`), so this says whether the ability was still running at contact —
        // which is the whole question the trigger-distance change is about.
        if (m.charge > R.modsChargeMax) R.modsChargeMax = m.charge;
        if (v > 0) {
          R.chargeLive++; R.chargeSum += v;
          if (v > R.chargeMax) R.chargeMax = v;
          if (m.charge > 1.01) R.chargeLiveWithAbility++;
        }
      }
      return v;
    };
    const rout = b.rout.bind(b);
    b.rout = (u) => {
      if (u.order !== 5 && !u.destroyed && eleIds.has(u.id)) {
        R.routs.push({ t: +g.simTime().toFixed(2), id: u.id, alive: u.alive, morale: +u.morale.toFixed(1) });
        if (R.firstEleRoutT === null) R.firstEleRoutT = +g.simTime().toFixed(2);
      }
      rout(u);
    };

    const inner = combat.fixedUpdate.bind(combat);
    combat.fixedUpdate = (dt, ctx) => {
      inner(dt, ctx);
      for (const u of eleUnits) {
        if (u.destroyed || u.alive === 0) continue;
        R.liveUnitTicks++;
        if (u.contactLock) R.lockedUnitTicks++;
      }
      for (const i of eleMembers) {
        if (!p.aliveAt(i)) continue;
        R.aliveTicks++;
        if (p.target[i] >= 0) R.targetTicks++;
        if (p.state[i] === 4) R.fightingTicks++;
      }
    };
  });

  const sample = async () => page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const R = window.__AB;
    const ele = b.units.filter((u) => u.typeId === 'war-elephants');
    let rome = 0; let punic = 0;
    for (const u of b.units) {
      if (u.destroyed) continue;
      if (u.faction === 0) rome += u.alive; else punic += u.alive;
    }
    R.series.push({
      t: +g.simTime().toFixed(1),
      eleAlive: ele.reduce((a, u) => a + (u.destroyed ? 0 : u.alive), 0),
      eleKills: ele.reduce((a, u) => a + u.kills, 0),
      eleMorale: +(ele.reduce((a, u) => a + u.morale, 0) / Math.max(1, ele.length)).toFixed(1),
      eleRouting: ele.filter((u) => u.order === 5).length,
      rome, punic,
    });
  });

  // ---- phase 1: run up to the charge ----
  let trig = null;
  for (let t = 0; t < SECS && !trig; t += STEP) {
    const d = await page.evaluate((s) => {
      const g = window.__game;
      const b = g.battle;
      const p = b.pool;
      g.fastForward(s);
      const ele = b.units.filter((u) => u.typeId === 'war-elephants' && !u.destroyed && u.alive > 0);
      let best = 1e9; let pick = -1;
      for (const u of ele) {
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          for (let j = 0; j < p.count; j += 3) {
            if (!p.aliveAt(j) || p.faction[j] === p.faction[i]) continue;
            const dx = p.x[j] - p.x[i]; const dz = p.z[j] - p.z[i];
            const d2 = dx * dx + dz * dz;
            if (d2 < best) { best = d2; pick = u.id; }
          }
        }
      }
      return { d: ele.length ? Math.sqrt(best) : -1, t: +g.simTime().toFixed(2), unit: pick };
    }, STEP);
    await sample();
    if (d.d >= 0 && d.d <= TRIGGER) trig = d;
    if (d.d < 0) break;
  }
  if (trig) console.log(`charge trigger: t+${trig.t}s, unit ${trig.unit}, ${trig.d.toFixed(1)} m`);

  // ---- phase 2: the plates ----
  await mkdir(OUT, { recursive: true });
  const plates = [];
  if (trig) {
    for (let k = 0; k < PLATES; k++) {
      const info = await page.evaluate(({ unit, zoom }) => {
        const g = window.__game;
        const b = g.battle;
        const p = b.pool;
        const u = b.unitById(unit);
        let x = 0; let z = 0; let n = 0;
        if (u) for (const i of u.members) { if (p.aliveAt(i)) { x += p.x[i]; z += p.z[i]; n++; } }
        const cx = n ? x / n : (u ? u.x : 0);
        const cz = n ? z / n : (u ? u.z : 0);
        g.setCamera(cx, cz, zoom, (u ? u.facing : 0) + Math.PI / 2);
        g.engine.advance(1 / 30, 1000 / 30);
        const R = window.__AB;
        const ele = b.units.filter((uu) => uu.typeId === 'war-elephants');
        return {
          t: +g.simTime().toFixed(2),
          alive: ele.reduce((a, uu) => a + (uu.destroyed ? 0 : uu.alive), 0),
          of: ele.reduce((a, uu) => a + uu.members.length, 0),
          kills: ele.reduce((a, uu) => a + uu.kills, 0),
          impacts: R.impacts, impactKills: R.impactKills, blows: R.blows,
          routing: ele.filter((uu) => uu.order === 5).length,
          x: +cx.toFixed(1), z: +cz.toFixed(1),
        };
      }, { unit: trig.unit, zoom: ZOOM });
      const name = `${LABEL}-${String(k).padStart(2, '0')}.png`;
      await page.screenshot({ path: path.join(OUT, name) });
      plates.push({ file: name, ...info });
      console.log(`  ${name}  t+${info.t}s  animals ${info.alive}/${info.of}  kills ${info.kills}`
        + `  blows ${info.blows}  impacts ${info.impacts}(lethal ${info.impactKills})  routing ${info.routing}`);
      if (k < PLATES - 1) await page.evaluate((s) => window.__game.fastForward(s), EVERY);
    }
  }

  // ---- phase 3: the rest of the battle ----
  const t0 = await page.evaluate(() => window.__game.simTime());
  for (let t = t0; t < SECS; t += STEP) {
    await page.evaluate((s) => window.__game.fastForward(s), STEP);
    await sample();
  }

  out = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const R = window.__AB;
    const flow = g.engine.ctx.tryGet('battleFlow');
    const ele = b.units.filter((u) => u.typeId === 'war-elephants');
    let rome = 0; let punic = 0; let romeStart = 0; let punicStart = 0;
    for (const u of b.units) {
      const alive = u.destroyed ? 0 : u.alive;
      if (u.faction === 0) { rome += alive; romeStart += u.members.length; }
      else { punic += alive; punicStart += u.members.length; }
    }
    return {
      ...R, swungAnimals: Object.keys(R.swungAnimals).length,
      simTime: +g.simTime().toFixed(1),
      units: ele.map((u) => ({ id: u.id, alive: u.alive, of: u.members.length, kills: u.kills,
        morale: +u.morale.toFixed(1), order: u.order, destroyed: u.destroyed })),
      rome, punic, romeStart, punicStart,
      result: flow ? (flow.result ?? null) : null,
    };
  });
  out.label = LABEL; out.errors = errors; out.plates = plates; out.trigger = trig;
  out.loadAtStart = load();
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}
out.loadAtEnd = load();

const t = out;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
console.log(`\n=== ele-ab [${t.label}] — ${t.animals} animals, headcount ${t.headcount}, t+${t.simTime}s ===`);
console.log(`machine load: start ${t.loadAtStart}  end ${t.loadAtEnd}`);
console.log(`armies at the end: Rome ${t.rome}/${t.romeStart}   Carthage ${t.punic}/${t.punicStart}`);
console.log(`result: ${JSON.stringify(t.result)}`);
console.log(`\nWHAT THE ANIMALS DID`);
console.log(`  men killed by the elephants:      ${t.units.reduce((a, u) => a + u.kills, 0)}`);
console.log(`  animals left:                     ${t.units.map((u) => `${u.alive}/${u.of}`).join(', ')}`);
console.log(`  melee blows thrown:               ${t.blows} (${t.blowsWithCharge} with a live charge)`);
console.log(`  animals that ever swung:          ${t.swungAnimals}/${t.animals}`);
console.log(`  cavalryImpact fired:              ${t.impacts}  (lethal ${t.impactKills}, mean ${t.impacts ? (t.impactDamage / t.impacts).toFixed(1) : 0} damage)`);
console.log(`  chargeFactor live:                ${t.chargeLive}/${t.chargeCalls} (${pct(t.chargeLive, t.chargeCalls)})  mean ${t.chargeLive ? (t.chargeSum / t.chargeLive).toFixed(3) : 0}  peak ${t.chargeMax.toFixed(3)}`);
console.log(`  ... with the charge ABILITY live: ${t.chargeLiveWithAbility}  (mods.charge peak ${t.modsChargeMax.toFixed(2)}; 1.40 = ability running, 1.00 = expired)`);
console.log(`  hit points per animal:            ${t.entryHp}`);
console.log(`  animal-ticks holding an opponent: ${t.targetTicks} of ${t.aliveTicks} alive (${pct(t.targetTicks, t.aliveTicks)})`);
console.log(`  animal-ticks Fighting:            ${t.fightingTicks}`);
console.log(`  unit-ticks with contactLock held: ${t.lockedUnitTicks} of ${t.liveUnitTicks} (${pct(t.lockedUnitTicks, t.liveUnitTicks)})`);
console.log(`\nWHAT KILLED THEM`);
const byCause = {};
for (const d of t.deaths) { const k = `${d.by}/${d.killer ?? 'nobody'}`; byCause[k] = (byCause[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`  died having never swung:          ${t.deaths.filter((d) => !d.hadSwung).length}/${t.deaths.length}`);
console.log(`  damage taken: melee ${t.dmgMelee.toFixed(0)}, missile ${t.dmgMissile.toFixed(0)}`);
console.log(`\nTHE DRAWBACK`);
console.log(`  squadrons broken: ${t.routs.map((r) => `t+${r.t}s at ${r.alive} left, morale ${r.morale}`).join(' | ') || 'none'}`);
console.log(`  Punic deaths after the first elephant rout:            ${t.punicDeathsAfterFirstRout}`);
console.log(`  ... of which within 6 m of a living routing animal:    ${t.punicDeathsNearRoutingAnimal}`);
console.log(`\nSERIES (t, animals, kills, morale, routing, Rome, Carthage)`);
for (const s of t.series) {
  if (Math.round(s.t) % 20 !== 0 && s.t > 4) continue;
  console.log(`  ${String(s.t).padStart(6)} ${String(s.eleAlive).padStart(3)} ${String(s.eleKills).padStart(5)}`
    + ` ${String(s.eleMorale).padStart(6)} ${s.eleRouting} ${String(s.rome).padStart(5)} ${String(s.punic).padStart(5)}`);
}
if (t.errors.length) console.log(`\nPAGE ERRORS:\n  ${t.errors.slice(0, 8).join('\n  ')}`);
await writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(`\njson: ${JSON_OUT}\nplates: ${OUT}`);
