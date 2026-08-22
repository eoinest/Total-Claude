/**
 * THE DISTRIBUTION — the same battle, N seeds, hands off, to the verdict.
 *
 * One playthrough cannot tell an unwinnable battle from a hard one, and it cannot tell a
 * *boring* one from an unlucky one. This runs the assault on N seeds and reports, per seed:
 * the verdict, the tick it landed on, **which of the two objective conditions actually
 * fired**, and where each of the three routes into the city had got to when it did.
 *
 * The last column is the point. If the battle is always decided before t+220 then the gate
 * ram, the great ram and half the siege train are furniture.
 *
 * Also asserts the seed field does something: two different seeds must not produce the same
 * t+30 state hash. Nothing else in the rig checks that, and a seed row that did nothing would
 * make every "12 seeds" claim in this project one measurement repeated twelve times.
 */
import { argsOf, boot, ledger, dump, ff, ended, ROOT, secTicks } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const MAP = A.get('map') ?? 'campus-martius';
const RUNS = Number(A.get('runs') ?? 8);
const UNTIL = Number(A.get('until') ?? 2400);
const PORT = Number(A.get('port') ?? 5911);
const OUT = path.join(ROOT, `screenshots/judge/seeds-${MAP}`);
const L = ledger(`${MAP} × ${RUNS} seeds`);

// Deterministic seed list so a re-run is the same campaign.
const SEEDS = [4265438264, 1, 7, 99, 12345, 777777, 2718281828, 31415926,
  8675309, 424242, 1000003, 4000000000].slice(0, RUNS);

const rows = [], h30 = new Map();
for (const seed of SEEDS) {
  let browser;
  try {
    const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
      out: OUT, label: `s${seed}`, seed, query: 'autoplay=1&deploy=0' });
    browser = r.browser;
    const page = r.page;
    // Autoplay + no deployment: the AI plays both sides. This measures the battle the engine
    // produces on its own, which is the baseline a player's orders have to beat.
    const t30 = await (async () => { await ff(page, 30); return page.evaluate(() => window.__game.hashes()); })();
    h30.set(seed, JSON.stringify(t30));

    let firstGate = null, firstBreach = null, firstOnWall = null, firstInside = null;
    let peak = { onWall: 0, holding: 0, inside: 0, heldFor: 0, stalled: 0 };
    let verdict = null, tEnd = null, snaps = [];
    for (let t = 30; t < UNTIL; t += 20) {
      await ff(page, 20);
      const s = await page.evaluate(() => {
        const tr = window.__TRUTH(), h = window.__HUD();
        return { t: tr.t, o: tr.objective, sg: tr.siege, res: tr.flowResult,
          phase: h.phase, adv: h.adv, note: h.note, str: tr.strength };
      });
      const o = s.o, sg = s.sg;
      if (o) {
        peak.onWall = Math.max(peak.onWall, o.stormOnWall);
        peak.holding = Math.max(peak.holding, o.stormHolding);
        peak.inside = Math.max(peak.inside, o.stormInside);
        peak.heldFor = Math.max(peak.heldFor, o.heldFor);
        peak.stalled = Math.max(peak.stalled, o.stalledFor);
        if (firstOnWall === null && o.stormOnWall > 0) firstOnWall = s.t;
        if (firstInside === null && o.stormInside > 0) firstInside = s.t;
      }
      if (firstGate === null && sg?.gate?.breached) firstGate = s.t;
      if (firstBreach === null && (sg?.breach?.bays?.length ?? 0) > 0) firstBreach = s.t;
      if (t % 200 === 30) snaps.push({ t: s.t, phase: s.phase, adv: s.adv,
        onWall: o?.stormOnWall, holding: o?.stormHolding, inside: o?.stormInside });
      const e = await ended(page);
      if (e) { verdict = e; tEnd = s.t; break; }
    }
    const tr = await page.evaluate(() => window.__TRUTH());
    const fr = tr.flowResult;
    /*
     * Which condition fired. `reason: 'objective'` covers both, and the arbiter does not say
     * which — so it is inferred from the census at the moment it ended, which is exactly the
     * inference the end card has to make and gets wrong. A held parapet needs 20 s of clock
     * on it; a break-in needs 60 men. They are never both true here.
     */
    const cond = fr?.reason !== 'objective' ? null
      : (tr.objective?.stormInside ?? 0) >= 60 ? 'B: 60 inside'
        : (tr.objective?.heldFor ?? 0) >= 19 ? 'A: parapet held 20 s' : `ambiguous (inside ${tr.objective?.stormInside}, held ${Math.round(tr.objective?.heldFor ?? 0)}s)`;
    const row = { seed, verdict: verdict?.verdict ?? 'none', reason: fr?.reason ?? 'none',
      victor: fr?.victor ?? null, at: fr ? Math.round(fr.at) : null, cond,
      gateAt: firstGate, breachAt: firstBreach, onWallAt: firstOnWall, insideAt: firstInside,
      peak, casualties: fr?.casualties, snaps };
    rows.push(row);
    L.say(`seed ${String(seed).padStart(10)}  ${(verdict?.verdict ?? 'NO RESULT').padEnd(8)} ${String(fr?.reason ?? '-').padEnd(11)} at t+${String(row.at ?? '?').padStart(4)}  ${String(cond ?? '-').padEnd(22)} | first: onWall t+${firstOnWall ?? '-'} inside t+${firstInside ?? '-'} gate t+${firstGate ?? '-'} breach t+${firstBreach ?? '-'} | peak onWall ${peak.onWall} holding ${peak.holding} inside ${peak.inside} held ${Math.round(peak.heldFor)}s`);
  } catch (e) {
    L.say(`seed ${seed}: THREW ${String(e).slice(0, 200)}`);
    rows.push({ seed, error: String(e).slice(0, 200) });
  } finally { if (browser) await browser.close(); }
}

// ------------------------------------------------------------------- verdicts
const ok = rows.filter(r => !r.error);
const distinct = new Set([...h30.values()]);
L.ck('the seed field actually changes the battle', distinct.size === h30.size,
  `${h30.size} distinct t+30 hashes`, `${distinct.size} distinct`);
const byReason = {};
for (const r of ok) byReason[`${r.verdict}/${r.reason}`] = (byReason[`${r.verdict}/${r.reason}`] ?? 0) + 1;
L.say(`\noutcomes: ${JSON.stringify(byReason)}`);
const conds = {};
for (const r of ok) if (r.cond) conds[r.cond] = (conds[r.cond] ?? 0) + 1;
L.say(`objective conditions that fired: ${JSON.stringify(conds)}`);
const ats = ok.map(r => r.at).filter(n => n != null).sort((a, b) => a - b);
L.say(`decided at: min ${ats[0]} median ${ats[Math.floor(ats.length / 2)]} max ${ats[ats.length - 1]}`);
const gates = ok.filter(r => r.gateAt != null).length, breaches = ok.filter(r => r.breachAt != null).length;
L.say(`the gate opened in ${gates}/${ok.length} runs; a bay came down in ${breaches}/${ok.length}`);
L.ck('more than one outcome across the seed set', Object.keys(byReason).length > 1,
  '>1 distinct verdict/reason', Object.keys(byReason).join(', '));
L.ck('the battle is still being fought when the gate opens (t+220)',
  ok.filter(r => (r.at ?? 0) > 220).length > ok.length / 2,
  'over half the runs last past t+220', `${ok.filter(r => (r.at ?? 0) > 220).length}/${ok.length}`);
L.ck('the great ram\'s breach (t+420) ever matters',
  ok.filter(r => (r.at ?? 0) > 420).length > 0,
  'at least one run lasts past t+420', `${ok.filter(r => (r.at ?? 0) > 420).length}/${ok.length}`);
await dump(OUT, `seeds-${MAP}`, { map: MAP, runs: RUNS, rows, checks: L.rows, log: L.log });
L.summary();
