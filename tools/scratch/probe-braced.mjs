#!/usr/bin/env node
/**
 * Two questions the rear investigation left open, in one browser slot.
 *
 * **1. The braced counter-charge.** `Combat.cavalryImpact` runs `p.vx[i] *= 0.15` on a horse
 * that strikes a braced spear line, on top of the unconditional `*= 0.35` at the end of the
 * same function — so a charger that hits a braced line keeps 5.25 % of its velocity. It was
 * suspect number three for "slows down the charges", and on the shipped field battle it fires
 * **zero times in 4,432 trample impacts** (`tools/scratch/probe-rear.mjs`). This spawns the
 * matchup that *does* fire it, so the figure quoted for it is measured rather than derived:
 * cavalry into a spear wall in shieldwall, which is the only shape `braced` is true for.
 *
 * **2. The tactical AI's cavalry cycle.** `CavalryCycle.withdraw` recomputes its destination
 * from the unit's own moving anchor every think, so it recedes at the unit's own speed and
 * re-fires forever — the defect that was found for elephants at `d84d06a` and deliberately
 * confined to `mount: 'elephant'`. This counts the `move` orders actually accepted by the
 * `OrderBook` for a *mounted* unit that is in contact, which is the churn as the sim sees it.
 *
 * Usage: node tools/scratch/probe-braced.mjs --port=5963 [--label=after] [--until=180]
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { stopClockOnReady } from '../lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5963);
const LABEL = args.get('label') ?? '';
const UNTIL = Number(args.get('until') ?? 180);

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

const browser = await launchBrowser({ label: 'probe-braced', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-braced', slot: browser.budgetSlot,
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await stopClockOnReady(page);
console.log(`source: ${base}   rev ${rev}${LABEL ? '   label ' + LABEL : ''}`);
await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());

// ---------------------------------------------------------------------------
// Phase 1 — the shipped field battle: who is issued a move order while in contact
// ---------------------------------------------------------------------------
await page.evaluate(async () => {
  const g = window.__game, b = g.battle, ctx = g.engine.context;
  const tac = ctx.tryGet('tactical-ai');
  const shared = await import('/src/sim/combatShared.ts');
  const forms = await import('/src/sim/formations.ts');
  const combat = ctx.tryGet('combat');
  const out = { moves: [], impacts: [] };
  window.__bp = { out };

  const realMove = tac.orders.move.bind(tac.orders);
  tac.orders.move = function (u, x, z, facing, running) {
    const accepted = realMove(u, x, z, facing, running);
    if (accepted) {
      const d = b.typeOf(u);
      const cav = d.unitClass === 'heavy-cavalry' || d.unitClass === 'light-cavalry';
      const brain = tac.brainOf(u.id);
      out.moves.push({
        t: +g.simTime().toFixed(2), unit: u.id, type: d.id, cav,
        engaged: !!u.engaged, phase: brain ? brain.cavPhase : null,
      });
    }
    return accepted;
  };

  // Recompute `braced` exactly as `cavalryImpact` does, so the count is the branch and not
  // an inference from the velocity that comes out of it.
  const realImpact = combat.cavalryImpact.bind(combat);
  const p = b.pool;
  combat.cavalryImpact = function (i, t, u, def, mods, chargeF, speed) {
    const dv = b.unitById(p.unitId[t]);
    const ddef = dv ? b.typeOf(dv) : null;
    const dmods = dv ? shared.modsOf(dv.id) : null;
    const df = dv ? forms.formation(dv.formationId) : null;
    const braced = !!(ddef && ddef.reach >= 2.2 && (dmods.braced || df.mods.shield > 1.2));
    const v0 = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
    const r = realImpact(i, t, u, def, mods, chargeF, speed);
    const v1 = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
    out.impacts.push({
      t: +g.simTime().toFixed(2), braced, defType: ddef ? ddef.id : '?',
      defForm: df ? df.id ?? dv.formationId : '?',
      v0: +v0.toFixed(3), v1: +v1.toFixed(3),
    });
    return r;
  };
});
for (let s = 0; s < UNTIL; s++) await page.evaluate(() => window.__game.advanceTicks(30));
const live = await page.evaluate(() => window.__bp.out);

const cavMoves = live.moves.filter((m) => m.cav);
const inContact = cavMoves.filter((m) => m.engaged);
const byPhase = {};
for (const m of inContact) byPhase[m.phase ?? 'null'] = (byPhase[m.phase ?? 'null'] || 0) + 1;
console.log('');
console.log(`=== shipped field battle, ${UNTIL}s: move orders the OrderBook accepted ===`);
console.log(`all units          ${live.moves.length}`);
console.log(`mounted units      ${cavMoves.length}   of which the unit was in contact ${inContact.length}`);
console.log(`in contact, by cavalry phase: ${JSON.stringify(byPhase)}`);
const perUnit = {};
for (const m of inContact) perUnit[m.unit] = (perUnit[m.unit] || 0) + 1;
console.log(`per squadron, in contact: ${JSON.stringify(perUnit)}`);
console.log(`braced impacts     ${live.impacts.filter((r) => r.braced).length} of ${live.impacts.length}`);

// ---------------------------------------------------------------------------
// Phase 2 — the lab that does fire the braced branch
// ---------------------------------------------------------------------------
/*
 * `braced` is `reach >= 2.2 && (mods.braced || formation.shield > 1.2)`, so the matchup has to
 * be a spear unit in shieldwall or testudo and nothing else in the roster qualifies. The pairs
 * must also be **hostile**: `spawnUnit` takes the faction from the roster row, so `equites` into
 * `urban-cohort` is Rome into Rome, the two never acquire each other, and the case returns zero
 * impacts for a reason that has nothing to do with bracing. Hence a Juthungi spear wall, with a
 * Juthungi warband in line as the unbraced control on the same ground at the same speed.
 */
for (const spec of [
  { cav: 'equites', foot: 'juthungi-spears', form: 'shieldwall' },
  { cav: 'equites', foot: 'juthungi-warband', form: 'line' },
]) {
  const r = await page.evaluate(async (s) => {
    const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11);
      u.alive = 0; u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    ctx.tryGet('morale')?.redeploy?.();
    for (const name of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage']) {
      const sy = ctx.tryGet(name);
      if (sy?.fixedUpdate) sy.fixedUpdate = () => {};
    }
    b.unitSizeScale = 1;
    window.__bp.out.impacts.length = 0;
    const idA = b.spawnUnit(s.foot, 0, 60, Math.PI, s.form);
    const idB = b.spawnUnit(s.cav, 0, -60, 0, 'wedge');
    const A = b.unitById(idA), B = b.unitById(idB);
    ctx.events.emit('orderIssued', { unitIds: [A.id], kind: 'halt' });
    ctx.events.emit('orderIssued', { unitIds: [B.id], kind: 'attack', targetUnitId: A.id });
    const speeds = [];
    for (let k = 0; k < 60; k++) {
      g.advanceTicks(15);
      const u = b.unitById(idB);
      let n = 0, sum = 0;
      if (u && !u.destroyed) {
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          n++;
          sum += Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
        }
      }
      speeds.push(n ? +(sum / n).toFixed(2) : 0);
    }
    const A2 = b.unitById(idA), B2 = b.unitById(idB);
    return {
      impacts: window.__bp.out.impacts.slice(),
      speeds,
      footLeft: A2 ? A2.alive : 0, cavLeft: B2 ? B2.alive : 0,
    };
  }, spec);
  const imp = r.impacts;
  const br = imp.filter((x) => x.braced);
  const ratio = (a) => (a.length
    ? (100 * a.filter((x) => x.v0 > 0.05).reduce((s, x) => s + x.v1 / x.v0, 0)
      / Math.max(1, a.filter((x) => x.v0 > 0.05).length)).toFixed(1) : 'n/a');
  console.log('');
  console.log(`=== lab: ${spec.cav} (wedge) into ${spec.foot} (${spec.form}) ===`);
  console.log(`impacts ${imp.length}, braced branch ${br.length} (${(100 * br.length / Math.max(1, imp.length)).toFixed(0)}%)`);
  console.log(`speed retained per impact: braced ${ratio(br)}%   unbraced ${ratio(imp.filter((x) => !x.braced))}%`);
  console.log(`squadron mean speed, 0.5 s apart: ${r.speeds.join(' ')}`);
  console.log(`survivors: foot ${r.footLeft}, horse ${r.cavLeft}`);
}

await page.close();
await closeServer();
await browser.close();
if (errors.length) for (const e of errors.slice(0, 6)) console.log('  ' + e);
