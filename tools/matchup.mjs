#!/usr/bin/env node
/**
 * Matchup harness.
 *
 * Spawns exactly two units on empty ground, lets them fight, and reports who won, how
 * long it took and what it cost. This is how a balance claim gets checked: "spears beat
 * cavalry" is either a number in this table or it is an assertion.
 *
 * The scenario is torn down first — the siege deploys at boot and its 8,900 men would
 * dominate every army-level signal — then two fresh units are spawned, the AI and the
 * battle-flow arbiter are switched off, and explicit orders are issued. Everything else
 * (combat, morale, abilities, projectiles) runs exactly as it does in a real battle.
 *
 * Usage:
 *   node tools/matchup.mjs [--port=5363] [--only=spear-vs-cav] [--until=300] [--verbose]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5363);
const UNTIL = Number(args.get('until') ?? 300);
const ONLY = args.get('only') ?? '';
const VERBOSE = args.has('verbose');

/**
 * Each case: two units, where they start, what formation, and what they are told to do.
 * `gap` is the metres between the two anchors at spawn.
 */
const CASES = [
  {
    id: 'spear-vs-cav',
    name: 'Tribal Spearmen vs Roman Cavalry',
    a: { type: 'juthungi-spears', form: 'line', order: 'hold' },
    b: { type: 'equites', form: 'wedge', order: 'attack' },
    gap: 160,
    expect: 'A (spears hold, horse dies on the points)',
  },
  {
    id: 'cav-vs-braced-spears',
    name: 'Roman Cavalry vs braced Tribal Spearmen (shield wall)',
    a: { type: 'juthungi-spears', form: 'shieldwall', order: 'hold', ability: 'brace' },
    b: { type: 'equites', form: 'wedge', order: 'attack' },
    gap: 160,
    expect: 'A decisively — a braced spear wall is what cavalry must not charge',
  },
  {
    id: 'cav-vs-archers',
    name: 'Tribal Horse Raiders vs Auxiliary Archers',
    a: { type: 'sagittarii', form: 'loose', order: 'hold' },
    b: { type: 'juthungi-riders', form: 'wedge', order: 'attack' },
    gap: 150,
    expect: 'B quickly — horse in the open is death to missile troops',
  },
  {
    id: 'spears-vs-legionary',
    name: 'Roman Urban Cohort (spears) vs Tribal Warband',
    a: { type: 'urban-cohort', form: 'line', order: 'hold' },
    b: { type: 'juthungi-warband', form: 'horde', order: 'attack' },
    gap: 90,
    expect: 'close — second-line spearmen are not heavy infantry',
  },
  {
    id: 'legionary-vs-warband',
    name: 'Legionary Cohort vs Tribal Warband',
    a: { type: 'legio-cohort', form: 'line', order: 'attack' },
    b: { type: 'juthungi-warband', form: 'horde', order: 'attack' },
    gap: 90,
    expect: 'A, but slowly and at real cost',
  },
  {
    id: 'chosen-vs-cohort',
    name: "Chieftain's Chosen (wedge) vs Legionary Cohort front",
    a: { type: 'legio-cohort', form: 'line', order: 'hold' },
    b: { type: 'juthungi-chosen', form: 'wedge', order: 'attack' },
    gap: 120,
    expect: 'B should hurt badly and may break the cohort',
  },
  {
    id: 'cav-vs-routers',
    name: 'Roman Cavalry vs a broken Warband',
    a: { type: 'juthungi-warband', form: 'horde', order: 'rout' },
    b: { type: 'equites', form: 'wedge', order: 'attack' },
    gap: 90,
    expect: 'B annihilates them — running men cannot fight back',
  },
  // ---- Carthage ---------------------------------------------------------
  // Added with the faction. The calibration these are read against is the one stated at the
  // top of `src/units/roster.ts`: a matched pair of line units grinds for two to four
  // minutes, a favourable matchup still takes about a minute, and an eighteen-second
  // massacre means the damage numbers are roughly four times a Total War melee's.
  {
    id: 'libyan-vs-cohort',
    name: 'Libyan Heavy Spearmen vs Legionary Cohort',
    a: { type: 'libyan-spearmen', form: 'line', order: 'attack' },
    b: { type: 'legio-cohort', form: 'line', order: 'attack' },
    gap: 90,
    expect: 'close — Rome should edge it on attack, but slowly',
  },
  {
    id: 'sacred-vs-praetorian',
    name: 'Sacred Band vs Praetorian Guard (elite mirror)',
    a: { type: 'sacred-band', form: 'line', order: 'attack' },
    b: { type: 'praetorian-cohort', form: 'line', order: 'attack' },
    gap: 90,
    expect: 'a long grind — the two elites are priced against each other',
  },
  {
    id: 'scutarii-vs-cohort',
    name: 'Iberian Scutarii vs Legionary Cohort',
    a: { type: 'legio-cohort', form: 'line', order: 'hold' },
    b: { type: 'iberian-scutarii', form: 'wedge', order: 'attack' },
    gap: 110,
    expect: 'B hurts on contact and then loses the grind — the falcata trade',
  },
  {
    id: 'gauls-vs-cohort',
    name: 'Gallic Mercenaries vs Legionary Cohort',
    a: { type: 'legio-cohort', form: 'line', order: 'hold' },
    b: { type: 'gallic-mercenaries', form: 'wedge', order: 'attack' },
    gap: 120,
    expect: 'B should break the cohort or die trying — Cannae in miniature',
  },
  {
    id: 'elephant-vs-cohort',
    name: 'War Elephants vs Legionary Cohort',
    a: { type: 'legio-cohort', form: 'line', order: 'hold' },
    b: { type: 'war-elephants', form: 'loose', order: 'attack' },
    gap: 150,
    expect: 'B ruinous — unsupported infantry is what elephants are for',
  },
  {
    id: 'elephant-vs-spears',
    name: 'War Elephants vs braced Urban Cohort (spear wall)',
    a: { type: 'urban-cohort', form: 'shieldwall', order: 'hold', ability: 'brace' },
    b: { type: 'war-elephants', form: 'loose', order: 'attack' },
    gap: 150,
    expect: 'A — a braced spear wall is the answer to elephants and must read as one',
  },
  {
    id: 'balearic-vs-cohort',
    name: 'Balearic Slingers vs advancing Legionary Cohort',
    a: { type: 'balearic-slingers', form: 'loose', order: 'hold' },
    b: { type: 'legio-cohort', form: 'line', order: 'attack' },
    gap: 200,
    expect: 'B wins on contact, but the sling should tell against mail on the way in',
  },
  {
    id: 'numidian-vs-archers',
    name: 'Numidian Cavalry vs Auxiliary Archers',
    a: { type: 'sagittarii', form: 'loose', order: 'hold' },
    b: { type: 'numidian-cavalry', form: 'wedge', order: 'attack' },
    gap: 150,
    expect: 'B quickly — light horse in the open is death to missile troops',
  },
  {
    id: 'punic-grind',
    name: 'Libyan Spearmen vs Urban Cohort (matched control)',
    a: { type: 'libyan-spearmen', form: 'line', order: 'attack' },
    b: { type: 'urban-cohort', form: 'line', order: 'attack' },
    gap: 90,
    expect: 'the Punic pacing benchmark — should sit in the same band as even-grind',
  },
  {
    id: 'even-grind',
    name: 'Urban Cohort vs Tribal Spearmen (matched control)',
    a: { type: 'urban-cohort', form: 'line', order: 'attack' },
    b: { type: 'juthungi-spears', form: 'line', order: 'attack' },
    gap: 90,
    expect: 'a long, near-even grind — this is the pacing benchmark',
  },
];

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1000))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) {
    console.error('vite did not start');
    process.exit(1);
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** Everything that runs inside the page for one case. */
const runCase = async (page, spec, until) =>
  page.evaluate(async ([spec, until]) => {
    const g = window.__game;
    const b = g.battle;
    const ctx = g.engine.context;
    const p = b.pool;

    // --- tear the scenario down -------------------------------------------
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11 /* Dead */);
      u.alive = 0;
      u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    ctx.tryGet('morale')?.redeploy?.();
    // The AI would immediately re-order both units, and battle flow would call the
    // battle over on the strength of the army that no longer exists.
    for (const name of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage']) {
      const s = ctx.tryGet(name);
      if (s?.fixedUpdate) s.fixedUpdate = () => {};
    }

    // --- deploy the two units --------------------------------------------
    b.unitSizeScale = 1;
    const NORTH = Math.PI;
    const SOUTH = 0;
    const half = spec.gap / 2;
    const idA = b.spawnUnit(spec.a.type, 0, half, NORTH, spec.a.form);
    const idB = b.spawnUnit(spec.b.type, 0, -half, SOUTH, spec.b.form);
    const A = b.unitById(idA);
    const B = b.unitById(idB);
    if (!A || !B) return { error: 'spawn failed (soldier pool exhausted)' };

    const order = (u, spec, foe) => {
      if (spec.ability) {
        ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'ability', ability: spec.ability });
      }
      if (spec.order === 'attack') {
        ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'attack', targetUnitId: foe.id });
      } else if (spec.order === 'rout') {
        b.rout(u);
      } else {
        ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });
      }
    };
    order(A, spec.a, B);
    order(B, spec.b, A);

    // --- per-tick melee sampler ------------------------------------------
    // Whether men *stay* locked in melee cannot be seen at one sample a second, and
    // "do they flicker between Fighting and Marching" is the whole question. Hooked on
    // `abilities` (order 35), which is the last sim system still running here.
    const tickTrace = [];
    const ab = ctx.tryGet('abilities');
    if (ab?.fixedUpdate) {
      const orig = ab.fixedUpdate.bind(ab);
      ab.fixedUpdate = (dt2, c2) => {
        orig(dt2, c2);
        if (tickTrace.length >= 240) return;
        let fA = 0; let tA = 0; let fB = 0; let tB = 0;
        for (const i of A.members) {
          if (p.state[i] === 4) fA++;
          if (p.target[i] >= 0 && p.aliveAt(i)) tA++;
        }
        for (const i of B.members) {
          if (p.state[i] === 4) fB++;
          if (p.target[i] >= 0 && p.aliveAt(i)) tB++;
        }
        if (fA + fB + tA + tB > 0) tickTrace.push([fA, tA, fB, tB]);
      };
    }

    // --- run --------------------------------------------------------------
    const sig = shared.signalsOf;
    const samples = [];
    let contactAt = -1;
    let decidedAt = -1;
    let winner = '';
    let peakFight = 0;
    let fightSum = 0;
    let fightN = 0;
    const rankHist = new Array(10).fill(0);
    const start = g.simTime();
    const step = 1;
    for (let t = 0; t <= until; t += step) {
      g.advance(step);
      let fighting = 0;
      for (let i = 0; i < p.count; i++) if (p.state[i] === 4) fighting++;
      if (fighting > peakFight) peakFight = fighting;
      for (const i of A.members) if (p.state[i] === 4) rankHist[Math.min(9, p.rank[i])]++;
      if (contactAt < 0 && (A.contactLock || B.contactLock || fighting > 0)) {
        contactAt = Math.round(g.simTime() - start);
      }
      if (contactAt >= 0) { fightSum += fighting; fightN++; }
      if (t % 10 === 0 || (contactAt >= 0 && t - contactAt < 6)) {
        samples.push({
          t: Math.round(g.simTime() - start),
          aAlive: A.alive, bAlive: B.alive,
          aMor: Math.round(A.morale), bMor: Math.round(B.morale),
          aOrd: A.order, bOrd: B.order,
          aLock: A.contactLock, bLock: B.contactLock,
          fighting,
          aGap: Math.round(Math.min(999, b.frontGapOf(A.id)) * 10) / 10,
          aFace: Math.round(A.facing * 180 / Math.PI),
          bFace: Math.round(B.facing * 180 / Math.PI),
          aPush: Math.round(sig(A.id).pushBalance * 100) / 100,
          aEng: Math.round(sig(A.id).engagedFraction * 100) / 100,
          bEng: Math.round(sig(B.id).engagedFraction * 100) / 100,
        });
      }
      const aDone = A.alive === 0 || A.order === 5 /* Rout */;
      const bDone = B.alive === 0 || B.order === 5;
      if (spec.a.order === 'rout' ? bDone : (aDone || bDone)) {
        decidedAt = Math.round(g.simTime() - start);
        winner = aDone && bDone ? 'both' : aDone ? 'B' : 'A';
        break;
      }
      if (spec.a.order === 'rout' && A.alive === 0) {
        decidedAt = Math.round(g.simTime() - start);
        winner = 'B';
        break;
      }
    }
    return {
      contactAt, decidedAt, winner,
      aAlive: A.alive, aInit: A.initialStrength, aMor: Math.round(A.morale), aMax: A.maxMorale,
      bAlive: B.alive, bInit: B.initialStrength, bMor: Math.round(B.morale), bMax: B.maxMorale,
      peakFight, meanFight: fightN ? Math.round(fightSum / fightN) : 0,
      samples, tickTrace: tickTrace.slice(0, 120), rankHist,
    };
  }, [spec, until]);

console.log('# matchup harness — two units, empty ground\n');
const table = [];
for (const spec of CASES) {
  if (ONLY && !spec.id.includes(ONLY)) continue;
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.setDefaultTimeout(180000);
  await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 180000 });
  const r = await runCase(page, spec, UNTIL);
  await page.close();

  if (r.error) {
    console.log(`${spec.id}: ERROR ${r.error}`);
    continue;
  }
  const aLoss = Math.round((1 - r.aAlive / r.aInit) * 100);
  const bLoss = Math.round((1 - r.bAlive / r.bInit) * 100);
  table.push({
    id: spec.id, name: spec.name,
    contact: r.contactAt, decided: r.decidedAt,
    winner: r.winner || 'neither',
    aLoss, bLoss, peakFight: r.peakFight, meanFight: r.meanFight,
    a: `${r.aAlive}/${r.aInit}`, b: `${r.bAlive}/${r.bInit}`,
    aMor: `${r.aMor}/${r.aMax}`, bMor: `${r.bMor}/${r.bMax}`,
    expect: spec.expect,
  });
  console.log(`${spec.name}`);
  const verdict = r.winner === 'A' ? 'A WINS (B broke or died)'
    : r.winner === 'B' ? 'B WINS (A broke or died)'
      : r.winner === 'both' ? 'mutual collapse' : 'undecided at timeout';
  console.log(`  contact t+${r.contactAt}s   decided ${r.decidedAt < 0 ? '(timeout)' : 't+' + r.decidedAt + 's'}   ${verdict}`);
  console.log(`  A ${spec.a.type.padEnd(20)} ${r.aAlive}/${r.aInit} (${aLoss}% lost)  morale ${r.aMor}/${r.aMax}`);
  console.log(`  B ${spec.b.type.padEnd(20)} ${r.bAlive}/${r.bInit} (${bLoss}% lost)  morale ${r.bMor}/${r.bMax}`);
  console.log(`  men in melee: peak ${r.peakFight}, mean while engaged ${r.meanFight}`);
  const rh = r.rankHist ?? [];
  const rhSum = rh.reduce((a, v) => a + v, 0) || 1;
  console.log(`  A's fighting men by rank: ${rh.map((v, k) => `${k}:${Math.round(v / rhSum * 100)}%`).join(' ')}`);
  console.log(`  expected: ${spec.expect}`);
  if (VERBOSE) {
    console.log('    t   aAlive bAlive aMor bMor fight  gap  aFace bFace push  aEng bEng lock');
    for (const s of r.samples) {
      console.log(
        `  ${String(s.t).padStart(4)} ${String(s.aAlive).padStart(7)}${String(s.bAlive).padStart(7)}` +
        `${String(s.aMor).padStart(5)}${String(s.bMor).padStart(5)}${String(s.fighting).padStart(6)}` +
        `${String(s.aGap).padStart(6)}${String(s.aFace).padStart(6)}${String(s.bFace).padStart(6)}` +
        `${String(s.aPush).padStart(6)}${String(s.aEng).padStart(6)}${String(s.bEng).padStart(5)}` +
        `  ${s.aLock ? 'A' : '-'}${s.bLock ? 'B' : '-'}`
      );
    }
  }
  if (VERBOSE && r.tickTrace?.length) {
    const tt = r.tickTrace;
    console.log(`  per-tick melee, first ${tt.length} ticks of contact (fightA/targetA fightB/targetB):`);
    for (let k = 0; k < tt.length; k += 6) {
      const row = tt.slice(k, k + 6).map(([fa, ta, fb, tb]) => `${fa}/${ta} ${fb}/${tb}`).join(' | ');
      console.log(`    +${String(k).padStart(3)}t  ${row}`);
    }
  }
  if (errors.length) {
    console.log(`  ${errors.length} console error(s): ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
  }
  console.log('');
}

console.log('\n## summary');
console.log('case                       winner  contact  decided  A lost  B lost  melee(peak/mean)');
for (const r of table) {
  console.log(
    `${r.id.padEnd(26)} ${String(r.winner).padEnd(7)} ${String(r.contact + 's').padStart(7)} ` +
    `${String(r.decided < 0 ? 'timeout' : r.decided + 's').padStart(8)} ` +
    `${String(r.aLoss + '%').padStart(6)}  ${String(r.bLoss + '%').padStart(6)}  ` +
    `${String(r.peakFight).padStart(5)}/${r.meanFight}`
  );
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(0);
