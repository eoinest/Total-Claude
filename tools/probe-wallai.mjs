#!/usr/bin/env node
/**
 * Does an army that has taken a wall do anything with it?
 *
 * The player's complaint: "the enemy AI when on the wall kinda hangs out. It should either
 * like start going down the stairs into the city to fight more, or target other forces."
 *
 * This grades the *consequence*, not the plumbing. `probe-walltraffic.mjs` already proves a
 * right-click moves men up, along and down; the question here is whether anybody ever gives
 * that order without a human. So every number is read off the running battle with both
 * armies on the AI, and the load-bearing ones are:
 *
 *   parapet     men whose feet are on a wall-walk, by faction
 *   frozen      of those, men whose net displacement over the last 10 s is under 0.5 m
 *   inside      storming men on the ground on the *city* side of the curtain
 *   decision    sim seconds at which `BattleFlow.result` is written, and what it said
 *
 * `frozen` is deliberately net displacement rather than speed: the known congestion case is
 * a man walking 1.4 m/s into a friendly back with zero net travel, and calling that "moving"
 * is exactly the mistake that let the behaviour ship.
 *
 * Usage:
 *   node tools/probe-wallai.mjs --port=5391 --map=rome --until=900
 *   node tools/probe-wallai.mjs --port=5391 --map=carthage --json
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5391);
const MAP = args.get('map') ?? 'rome';
const UNTIL = Number(args.get('until') ?? 900);
const AS_JSON = args.has('json');
const TAG = args.get('tag') ?? '';

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) {
  console.error(`no dev server answering /src/main.ts at ${base} — a probe that falls through`
    + ' to a stale dist/ measures a build, not this tree');
  process.exit(2);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const url = `${base}/?harness=1&scenario=assault&autoplay=1&quality=low&map=${MAP}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
if (errs.length) console.error('page errors:', errs.slice(0, 4));

await page.evaluate(`
window.__wa = (() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const flow = g.engine.context.get('battleFlow');
  g.engine.stop();

  /** Which side of the curtain a point is on: -1 in the city, +1 in the field. */
  const sideOf = (x, z) => {
    const st = s.stationNear(x, z);
    if (st < 0) return 1;
    return ((x - s.sx[st]) * s.snx[st] + (z - s.sz[st]) * s.snz[st]) < 0 ? -1 : 1;
  };

  /** The garrison's faction, decided once at t=0 while nobody has climbed anything yet. */
  let defender = -1;
  for (const u of b.units) if (s.isGarrisoned(u.id)) { defender = u.faction; break; }

  const mark = new Map();
  const remember = () => {
    mark.clear();
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (p.aliveAt(i)) mark.set(i, [p.x[i], p.z[i]]);
    }
  };

  const census = () => {
    const byFaction = {};
    const f = (k) => (byFaction[k] ??= {
      parapet: 0, frozen: 0, frozenFighting: 0, ground: 0, inside: 0, alive: 0, fighting: 0,
    });
    for (const u of b.units) {
      if (u.destroyed) continue;
      const r = f(u.faction);
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        r.alive++;
        const fight = p.state[i] === 4;
        if (fight) r.fighting++;
        if (b.elevated[i]) {
          r.parapet++;
          const m = mark.get(i);
          if (m && Math.hypot(p.x[i] - m[0], p.z[i] - m[1]) < 0.5) {
            r.frozen++;
            if (fight) r.frozenFighting++;
          }
        } else {
          r.ground++;
          if (sideOf(p.x[i], p.z[i]) < 0) r.inside++;
        }
      }
    }
    return byFaction;
  };

  /** Per-unit wall state, so a plan that never gets issued is visible as such. */
  const plans = () => b.units.filter((u) => !u.destroyed && (s.isGarrisoned(u.id) || s.ownsUnit(u.id)))
    .map((u) => {
      const w = s.unitWallState(u.id);
      return { id: u.id, faction: u.faction, name: u.name ?? '', alive: u.alive,
        onWall: w.onWall, onGround: w.onGround, onLink: w.onLink,
        goal: w.goal, runs: w.runs.join('/'), planAge: w.planAge, stuck: w.stuck };
    });

  return {
    defender,
    remember, census, plans,
    t: () => g.engine.time.simTime,
    run: (sec) => g.engine.advance(sec, 166),
    result: () => flow?.result ? {
      victor: flow.result.victor, reason: flow.result.reason, at: +flow.result.at.toFixed(1),
    } : null,
    counts: () => {
      const c = {};
      for (const u of b.units) if (!u.destroyed) c[u.faction] = (c[u.faction] ?? 0) + u.alive;
      return c;
    },
  };
})();
`);

const out = { map: MAP, tag: TAG, samples: [], decision: null, errs: errs.slice(0, 6) };

const sampleAt = async (target) => {
  const t = await page.evaluate('window.__wa.t()');
  if (target - t > 10) await page.evaluate(`window.__wa.run(${target - t - 10})`);
  await page.evaluate('window.__wa.remember()');
  await page.evaluate('window.__wa.run(10)');
  const s = await page.evaluate(`(() => ({
    t: +window.__wa.t().toFixed(1),
    defender: window.__wa.defender,
    census: window.__wa.census(),
    plans: window.__wa.plans(),
    counts: window.__wa.counts(),
    result: window.__wa.result(),
  }))()`);
  out.samples.push(s);
  return s;
};

for (const t of [87, 250]) {
  const s = await sampleAt(t);
  if (!AS_JSON) {
    const att = Object.entries(s.census).filter(([k]) => Number(k) !== s.defender);
    const def = s.census[s.defender] ?? {};
    console.log(`t+${s.t}  defender f${s.defender}: parapet ${def.parapet} frozen ${def.frozen}`
      + `  |  attackers: ` + att.map(([k, v]) =>
        `f${k} parapet ${v.parapet} frozen ${v.frozen} inside ${v.inside}`).join('  '));
    for (const q of s.plans) {
      console.log(`   u${q.id} f${q.faction} ${q.name} alive ${q.alive}`
        + ` wall ${q.onWall}/${q.onGround}/${q.onLink} goal ${q.goal} runs ${q.runs} age ${q.planAge} stuck ${q.stuck}`);
    }
  }
  if (s.result) { out.decision = s.result; break; }
}

if (!out.decision) {
  // Play it out. Chunked so a hang is visible as a stalled clock rather than a dead probe.
  for (let t = 260; t <= UNTIL && !out.decision; t += 40) {
    await page.evaluate('window.__wa.run(40)');
    const r = await page.evaluate('window.__wa.result()');
    const now = await page.evaluate('+window.__wa.t().toFixed(0)');
    if (!AS_JSON) process.stderr.write(`  … t+${now}\r`);
    if (r) out.decision = r;
  }
  if (!AS_JSON) process.stderr.write('\n');
}
out.final = await page.evaluate(`(() => ({
  t: +window.__wa.t().toFixed(1),
  census: window.__wa.census(),
  counts: window.__wa.counts(),
  plans: window.__wa.plans(),
}))()`);

if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`decision: ${out.decision ? `${out.decision.reason} for f${out.decision.victor} at t+${out.decision.at}` : `none by t+${out.final.t}`}`);
  console.log(`final counts ${JSON.stringify(out.final.counts)}`);
}
if (args.has('out')) {
  const fs = await import('node:fs');
  fs.writeFileSync(args.get('out'), JSON.stringify(out, null, 2));
}
await browser.close();
