/**
 * WHY IS THE PARAPET NEVER HELD?
 *
 * Across twelve seeds of Rome and three arms of Carthage, `stormHolding` was **0 in every
 * sample of every run**, while `stormOnWall` peaked at 123-290. Condition A — 24 men holding
 * a cleared stretch for 20 s — is the *first* thing both deployment briefs name, and it has
 * never once been non-zero in anything I have played.
 *
 * "The garrison is too strong" would show as `stormHolding` climbing and being knocked back.
 * It does not climb. So the hypothesis is different: the men do not stay. This logs, every
 * 5 s, for every unit of both sides: how many of its men are on the wall, on the ground and
 * on a link, and **what goal its wall plan is carrying** — plus every order that crosses the
 * bus and who issued it. If men walk off the parapet under a `descend` goal that no player
 * gave, the parapet is a doorway rather than a place, and condition A is unreachable for a
 * reason that is nothing to do with balance.
 */
import { argsOf, boot, ledger, dump, ff, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const FROM = Number(A.get('from') ?? 30);
const TO = Number(A.get('to') ?? 150);
const OUT = path.join(ROOT, `screenshots/judge/turnstile-${MAP}`);
const L = ledger(`turnstile — ${MAP}`);

let browser, page;
try {
  const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
    out: OUT, label: 't', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(300);
  // Tap the order bus. Reads only; the handler records and returns.
  await page.evaluate(() => {
    window.__orders = [];
    window.__game.engine.context.events.on('orderIssued', (e) => {
      window.__orders.push({ t: +window.__game.simTime().toFixed(1), src: e.source,
        kind: e.kind ?? e.order ?? '?', units: (e.unitIds ?? [e.unitId]).slice(0, 6),
        x: e.x !== undefined ? Math.round(e.x) : null, z: e.z !== undefined ? Math.round(e.z) : null });
    });
  });
  await page.click('.dep-begin'); await page.waitForTimeout(600);
  L.say('BEGIN pressed. No further orders will be given by me.');

  await ff(page, FROM);
  const rows = [];
  for (let t = FROM; t <= TO; t += 5) {
    await ff(page, 5);
    const s = await page.evaluate(() => {
      const g = window.__game, b = g.battle, s = b.siege;
      const o = g.engine.context.tryGet('battleFlow')?.objective ?? null;
      const per = b.units.filter(u => u.alive > 0 && !u.destroyed).map(u => {
        const w = s?.unitWallState?.(u.id) ?? null;
        return { id: u.id, f: u.faction, t: u.typeId, n: u.alive,
          up: w?.onWall ?? 0, gr: w?.onGround ?? 0, lk: w?.onLink ?? 0,
          goal: w?.goal ?? '-', dest: w?.destRun ?? -1, age: w?.planAge ?? -1, stuck: w?.stuck ?? 0,
          runs: w?.runs ?? [] };
      }).filter(u => u.up > 0 || u.gr > 0 || u.lk > 0 || u.goal !== 'none');
      return { t: +g.simTime().toFixed(1), obj: o && { onWall: o.stormOnWall, holding: o.stormHolding,
        garr: o.garrisonOnWall, inside: o.stormInside, runs: o.holdingRuns },
        per, nOrders: window.__orders.length };
    });
    rows.push(s);
    const stormSide = MAP === 'carthage' ? 0 : 1;
    const mine = s.per.filter(u => u.f === stormSide);
    const theirs = s.per.filter(u => u.f !== stormSide);
    L.say(`t+${String(s.t).padStart(6)} holding=${String(s.obj?.holding).padStart(3)} onWall=${String(s.obj?.onWall).padStart(4)} garrOnWall=${String(s.obj?.garr).padStart(4)} inside=${String(s.obj?.inside).padStart(3)} runsHeld=${JSON.stringify(s.obj?.runs)}`);
    L.say(`         STORM: ${mine.map(u => `${u.id}/${u.t.replace(/^(legio-|juthungi-)/, '')} up${u.up} gr${u.gr} lk${u.lk} goal=${u.goal}${u.dest >= 0 ? '->' + u.dest : ''} runs${JSON.stringify(u.runs)}`).join('  ') || '(none on the stone)'}`);
    L.say(`         GARR:  ${theirs.map(u => `${u.id} up${u.up} gr${u.gr} goal=${u.goal}${u.dest >= 0 ? '->' + u.dest : ''}`).join('  ') || '(none on the stone)'}`);
  }

  const orders = await page.evaluate(() => window.__orders);
  const bySrc = {};
  for (const o of orders) bySrc[o.src ?? 'undefined'] = (bySrc[o.src ?? 'undefined'] ?? 0) + 1;
  L.say(`\norders on the bus in ${TO} s: ${orders.length}  by source ${JSON.stringify(bySrc)}`);
  L.ck('I issued no orders', (bySrc.local ?? 0) === 0, 0, bySrc.local ?? 0);
  const stormSide = MAP === 'carthage' ? 0 : 1;
  const stormUnits = new Set((await page.evaluate((f) => window.__units(f).map(u => u.id), stormSide)));
  const atStorm = orders.filter(o => o.units.some(u => stormUnits.has(u)));
  L.say(`orders aimed at storming units: ${atStorm.length}; by source ${JSON.stringify(atStorm.reduce((a, o) => ({ ...a, [o.src]: (a[o.src] ?? 0) + 1 }), {}))}`);
  L.say(`first 25 of them: ${JSON.stringify(atStorm.slice(0, 25))}`);

  const peakHold = Math.max(...rows.map(r => r.obj?.holding ?? 0));
  const peakWall = Math.max(...rows.map(r => r.obj?.onWall ?? 0));
  L.ck('the storm ever holds a cleared stretch at all', peakHold > 0, '>0 at some sample', peakHold);
  L.ck('condition A gets within reach of its threshold', peakHold >= 24, '>=24 (WALL_FOOTHOLD)', peakHold);
  L.say(`peak on the parapet ${peakWall}; peak holding ${peakHold}`);
  // Which goals did storming men carry while they were on the wall?
  const goals = {};
  for (const r of rows) for (const u of r.per) if (u.f === stormSide && (u.up > 0 || u.lk > 0)) goals[u.goal] = (goals[u.goal] ?? 0) + 1;
  L.say(`goals carried by storming units with men on the stone: ${JSON.stringify(goals)}`);
  L.ck('no storming unit walks off the parapet under a descend goal nobody gave it',
    !(goals.descend > 0) || (bySrc.local ?? 0) > 0,
    'descend only after a player order', `descend seen ${goals.descend ?? 0} times, player orders ${bySrc.local ?? 0}`);
  await dump(OUT, `turnstile-${MAP}`, { map: MAP, seed: SEED, rows, orders, rowsChecks: L.rows, log: L.log });
} catch (e) {
  L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400));
} finally { if (browser) await browser.close(); }
L.summary();
