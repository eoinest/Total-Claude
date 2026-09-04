#!/usr/bin/env node
/**
 * Who takes the elephants' opponent away from them?
 *
 * `ele-why2` closed every door but one. Of the 250 times an animal lost the man it was
 * fighting, **none** was because he died (0) and **none** was because he drifted out of
 * `keepR` (0) — all 250 were "another reason". Nothing crowd-capped, `engageCap` never bound,
 * and the animals moved at a median 2.97 m/s the whole time with no target and 1.0 m/s with
 * one. There is exactly one other line in the tree that writes `p.target[i] = -1` for a living
 * man: `BattleSystem.steerToSlots`, when `orderGrace[u.id] > 0 || breakingOff[u.id] === 1`.
 *
 * So this counts orders. Every `orderIssued` for an elephant unit, its kind and its tick,
 * against the per-tick state of `orderGrace`, `breakingOff`, `contactLock` and `u.order`.
 *
 *   node tools/scratch/ele-why3.mjs --port=5946 --from=100 --to=142
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
const PORT = Number(args.get('port') ?? 5946);
const FROM = Number(args.get('from') ?? 96);
const TO = Number(args.get('to') ?? 142);
const JSON_OUT = args.get('json') ? path.resolve(ROOT, args.get('json')) : null;

const browser = await launchBrowser({ label: 'ele-why3', port: PORT, root: ROOT });
let server = null;
let out = null;
try {
  server = await startVite({ port: PORT, root: ROOT, label: 'ele-why3', slot: browser.budgetSlot });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${server.base}/?harness=1&enemy=carthage&quality=low`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true,
    null, { timeout: 240000 });
  await page.evaluate((s) => window.__game.fastForward(s), FROM);

  await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const combat = g.engine.ctx.tryGet('combat');
    const eleUnits = b.units.filter((u) => u.typeId === 'war-elephants');
    const eleIds = new Set(eleUnits.map((u) => u.id));
    const animals = [];
    for (const u of eleUnits) for (const i of u.members) animals.push(i);

    const S = {
      orders: [],            // every orderIssued naming an elephant unit
      byKind: {},
      ticks: 0,
      disengagingUnitTicks: 0, lockedUnitTicks: 0, liveUnitTicks: 0,
      orderGraceSamples: [], breakingOffTicks: 0,
      animalTicksDisengaging: 0, animalTicksAlive: 0,
      targetStrippedWhileDisengaging: 0, targetStrippedOther: 0,
      // Comparison: the same numbers for a Punic line unit that is not cavalry.
      ctlOrders: 0, ctlDisengagingUnitTicks: 0, ctlLiveUnitTicks: 0, ctlUnit: null,
    };
    window.__W3 = S;

    // A Gallic warband is the control: same army, same battle, foot instead of horse.
    const ctl = b.units.find((u) => u.typeId === 'gallic-mercenaries' && !u.destroyed);
    S.ctlUnit = ctl ? ctl.id : null;

    g.engine.events.on('orderIssued', (e) => {
      for (const id of e.unitIds ?? []) {
        if (eleIds.has(id)) {
          S.orders.push({ t: +g.simTime().toFixed(2), id, kind: e.kind, src: e.source ?? '?', tgt: e.targetUnitId ?? -1 });
          S.byKind[e.kind] = (S.byKind[e.kind] ?? 0) + 1;
        } else if (ctl && id === ctl.id) S.ctlOrders++;
      }
    });

    const prevTarget = new Map();
    for (const i of animals) prevTarget.set(i, -1);

    const inner = combat.fixedUpdate.bind(combat);
    combat.fixedUpdate = (dt, ctx) => {
      inner(dt, ctx);
      S.ticks++;
      for (const u of eleUnits) {
        if (u.destroyed || u.alive === 0) continue;
        S.liveUnitTicks++;
        const grace = b.orderGrace[u.id] ?? 0;
        const brk = b.breakingOff[u.id] ?? 0;
        if (grace > 0 || brk === 1) S.disengagingUnitTicks++;
        if (brk === 1) S.breakingOffTicks++;
        if (u.contactLock) S.lockedUnitTicks++;
        if (S.orderGraceSamples.length < 40000) S.orderGraceSamples.push(+grace.toFixed(2));
      }
      if (ctl && !ctl.destroyed && ctl.alive > 0) {
        S.ctlLiveUnitTicks++;
        if ((b.orderGrace[ctl.id] ?? 0) > 0 || b.breakingOff[ctl.id] === 1) S.ctlDisengagingUnitTicks++;
      }
      for (const i of animals) {
        if (!p.aliveAt(i)) { prevTarget.set(i, -1); continue; }
        S.animalTicksAlive++;
        const u = b.unitById(p.unitId[i]);
        const dis = u ? ((b.orderGrace[u.id] ?? 0) > 0 || b.breakingOff[u.id] === 1) : false;
        if (dis) S.animalTicksDisengaging++;
        const t = p.target[i];
        const pt = prevTarget.get(i);
        if (pt >= 0 && t < 0 && p.aliveAt(pt)) {
          if (dis) S.targetStrippedWhileDisengaging++;
          else S.targetStrippedOther++;
        }
        prevTarget.set(i, t);
      }
    };
  });

  await page.evaluate((s) => window.__game.fastForward(s), TO - FROM);

  out = await page.evaluate(() => {
    const S = window.__W3;
    const g = window.__game;
    const b = g.battle;
    const stat = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, c) => a - c);
      return { n: s.length, med: s[s.length >> 1], p75: s[Math.floor(s.length * 0.75)], max: s[s.length - 1],
        zero: s.filter((v) => v <= 0).length };
    };
    return {
      simTime: +g.simTime().toFixed(1),
      ticks: S.ticks,
      orders: S.orders, byKind: S.byKind,
      liveUnitTicks: S.liveUnitTicks,
      disengagingUnitTicks: S.disengagingUnitTicks,
      breakingOffTicks: S.breakingOffTicks,
      lockedUnitTicks: S.lockedUnitTicks,
      orderGrace: stat(S.orderGraceSamples),
      animalTicksAlive: S.animalTicksAlive,
      animalTicksDisengaging: S.animalTicksDisengaging,
      targetStrippedWhileDisengaging: S.targetStrippedWhileDisengaging,
      targetStrippedOther: S.targetStrippedOther,
      ctlUnit: S.ctlUnit, ctlOrders: S.ctlOrders,
      ctlLiveUnitTicks: S.ctlLiveUnitTicks,
      ctlDisengagingUnitTicks: S.ctlDisengagingUnitTicks,
      units: b.units.filter((u) => u.typeId === 'war-elephants')
        .map((u) => ({ id: u.id, alive: u.alive, kills: u.kills, order: u.order })),
    };
  });
  out.errors = errors;
  await page.close();
} finally {
  try { await browser.close(); } catch { /* already closed */ }
  try { await server?.close(); } catch { /* already down */ }
}

const S = out;
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
console.log(`\n=== ele-why3 — window ${FROM}..${TO}s, ${S.ticks} ticks ===`);
console.log(`orders naming an elephant unit: ${S.orders.length}  ${JSON.stringify(S.byKind)}`);
console.log(`\nunit-ticks alive ${S.liveUnitTicks}`);
console.log(`  disengaging (orderGrace > 0 or breakingOff): ${S.disengagingUnitTicks}  (${pc(S.disengagingUnitTicks, S.liveUnitTicks)})`);
console.log(`  of which breakingOff:                        ${S.breakingOffTicks}`);
console.log(`  contactLock held:                            ${S.lockedUnitTicks}  (${pc(S.lockedUnitTicks, S.liveUnitTicks)})`);
console.log(`  orderGrace: ${JSON.stringify(S.orderGrace)}`);
console.log(`\nanimal-ticks alive ${S.animalTicksAlive}, of which disengaging ${S.animalTicksDisengaging} (${pc(S.animalTicksDisengaging, S.animalTicksAlive)})`);
console.log(`  living opponent stripped while disengaging: ${S.targetStrippedWhileDisengaging}`);
console.log(`  living opponent stripped otherwise:        ${S.targetStrippedOther}`);
console.log(`\ncontrol — gallic-mercenaries unit ${S.ctlUnit} (foot, same army):`);
console.log(`  orders ${S.ctlOrders}; unit-ticks ${S.ctlLiveUnitTicks}; disengaging ${S.ctlDisengagingUnitTicks} (${pc(S.ctlDisengagingUnitTicks, S.ctlLiveUnitTicks)})`);
console.log(`\nthe order log:`);
for (const o of S.orders.slice(0, 80)) console.log(`  t+${o.t}s  unit ${o.id}  ${o.kind}  target ${o.tgt}  (${o.src})`);
if (S.orders.length > 80) console.log(`  … ${S.orders.length - 80} more`);
if (S.errors.length) console.log(`\nPAGE ERRORS:\n  ${S.errors.slice(0, 8).join('\n  ')}`);
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify(out, null, 2)); console.log(`\njson: ${JSON_OUT}`); }
