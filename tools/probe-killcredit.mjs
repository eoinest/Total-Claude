#!/usr/bin/env node
/**
 * who is credited with a kill, and is anybody credited with killing his own man?
 *
 * `BattleSystem.damage` does `if (killer) killer.kills++` without asking whose man died. The
 * missile path now passes -1 for a friendly casualty so that resolves to nobody; melee does
 * not. This wraps `damage` in the page and tallies every lethal call by
 * (killer faction, victim faction) and by which *system* was on the stack when it happened,
 * so "melee credits friendly kills" is a number rather than a reading of the source.
 *
 * The second half is the ledger the commit message argued from: credited kills against bodies
 * on the floor, per faction. A faction credited with more kills than the other side has
 * losses is on its face shooting itself.
 *
 * Read only: nothing is spawned, no order issued, no system stubbed.
 *
 * Usage: node tools/probe-killcredit.mjs --port=5715 --map=rome --warm=30 --window=240
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5715);
const MAP = args.get('map') ?? 'rome';
const SCENARIO = args.get('scenario') ?? 'assault';
const WARM = Number(args.get('warm') ?? 30);
const WINDOW = Number(args.get('window') ?? 240);
const SLICE = Number(args.get('slice') ?? 30);
const JSON_OUT = args.get('json') ?? null;

const base = `http://127.0.0.1:${PORT}`;
const served = await fetch(`${base}/src/sim/Combat.ts`).then((r) => r.text()).catch(() => '');
if (!served) { console.error(`FATAL: nothing served at ${base} — is vite up?`); process.exit(2); }
console.log(`source:      ${base}  (Combat.ts ${served.length} bytes)`);
console.log(`guard present in served Combat.ts: ${served.includes('CREDIT_FRIENDLY') ? 'YES' : 'no'}`);

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?harness=1&quality=high&autoplay=0&scenario=${SCENARIO}&w=640&h=400&battle=${token}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
console.log(`booted; page errors so far: ${errors.length}`);

await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const T = {
    lethal: 0, credited: 0, uncredited: 0,
    friendlyLethal: 0, friendlyCredited: 0,
    bySystem: {}, friendlyBySystem: {}, pairs: {},
  };
  window.__mfu = T;
  // Which system is on the stack. The sim runs its systems one at a time, so a marker set
  // on entry and cleared on exit is exact and costs nothing per damage call.
  let SRC = 'other';
  for (const nm of ['combat', 'projectiles', 'siege', 'battle', 'abilities']) {
    const s = ctx.tryGet(nm);
    if (!s?.fixedUpdate) continue;
    const orig = s.fixedUpdate.bind(s);
    s.fixedUpdate = (dt, c) => { const prev = SRC; SRC = nm; try { orig(dt, c); } finally { SRC = prev; } };
  }
  const dmg = b.damage.bind(b);
  b.damage = (i, amount, fx, fz, aid) => {
    const victimF = b.pool.faction[i];
    const killer = b.unitById(aid);
    const lethal = dmg(i, amount, fx, fz, aid);
    if (!lethal) return lethal;
    T.lethal++;
    T.bySystem[SRC] = (T.bySystem[SRC] ?? 0) + 1;
    if (killer) T.credited++; else T.uncredited++;
    const kf = killer ? killer.faction : -1;
    const key = `${kf}->${victimF}`;
    T.pairs[key] = (T.pairs[key] ?? 0) + 1;
    if (kf === victimF) {
      T.friendlyLethal++;
      T.friendlyCredited++;
      T.friendlyBySystem[SRC] = (T.friendlyBySystem[SRC] ?? 0) + 1;
    }
    return lethal;
  };
});

const ledger = async () => page.evaluate(() => {
  const b = window.__game.battle;
  const p = b.pool;
  const per = {};
  for (const u of b.units) {
    const f = u.faction;
    per[f] ??= { init: 0, alive: 0, kills: 0, units: 0 };
    per[f].units++;
    per[f].init += u.initialStrength ?? 0;
    per[f].kills += u.kills ?? 0;
    let a = 0;
    for (const i of u.members) if (p.aliveAt(i)) a++;
    per[f].alive += a;
  }
  return { t: window.__game.simTime(), per, tally: JSON.parse(JSON.stringify(window.__mfu)) };
});

const advance = async (s) => {
  let left = s;
  while (left > 1e-6) { const step = Math.min(5, left); await page.evaluate((x) => window.__game.engine.advance(x, 166), step); left -= step; }
};

await advance(WARM);
const t0 = await ledger();
const slices = [];
const n = Math.max(1, Math.round(WINDOW / SLICE));
console.log('');
console.log('slice   lethal  credited  uncredited  friendly-credited   by system');
for (let k = 0; k < n; k++) {
  const a = await ledger();
  await advance(SLICE);
  const c = await ledger();
  const d = (o, key) => (c.tally[key] ?? 0) - (a.tally[key] ?? 0);
  const dsys = {};
  for (const s of new Set([...Object.keys(a.tally.bySystem), ...Object.keys(c.tally.bySystem)])) {
    const v = (c.tally.bySystem[s] ?? 0) - (a.tally.bySystem[s] ?? 0);
    if (v) dsys[s] = v;
  }
  slices.push({ t0: a.t, t1: c.t, lethal: d(0, 'lethal'), friendly: d(0, 'friendlyCredited'), bySystem: dsys });
  console.log(
    `${a.t.toFixed(0).padStart(4)}-${c.t.toFixed(0).padStart(4)}`
    + `${String(d(0, 'lethal')).padStart(8)}${String(d(0, 'credited')).padStart(10)}`
    + `${String(d(0, 'uncredited')).padStart(12)}${String(d(0, 'friendlyCredited')).padStart(19)}   `
    + Object.entries(dsys).map(([s, v]) => `${s} ${v}`).join('  ')
  );
}
const t1 = await ledger();

console.log('');
console.log(`window ${(t1.t - t0.t).toFixed(0)} s of sim`);
console.log('');
console.log('kills credited against bodies on the floor');
console.log('faction   men lost   credited kills   kills/bodies   (bodies = the OTHER sides\' losses)');
const factions = Object.keys(t1.per).sort();
const lost = {};
for (const f of factions) lost[f] = (t0.per[f].alive - t1.per[f].alive);
for (const f of factions) {
  const k = t1.per[f].kills - t0.per[f].kills;
  const bodies = factions.filter((g) => g !== f).reduce((s, g) => s + lost[g], 0);
  console.log(
    `${String(f).padEnd(9)} ${String(lost[f]).padStart(8)} ${String(k).padStart(16)} `
    + `${String(k).padStart(8)}/${String(bodies).padEnd(6)} ${k > bodies ? '  <-- MORE KILLS THAN BODIES' : ''}`
  );
}
console.log('');
console.log('lethal blows by system:      ', JSON.stringify(diffObj(t0.tally.bySystem, t1.tally.bySystem)));
console.log('friendly CREDITED by system: ', JSON.stringify(diffObj(t0.tally.friendlyBySystem, t1.tally.friendlyBySystem)));
console.log('killerFaction->victimFaction:', JSON.stringify(diffObj(t0.tally.pairs, t1.tally.pairs)));
console.log(`uncredited lethal blows: ${t1.tally.uncredited - t0.tally.uncredited}`
  + `  (a friendly missile casualty, or a man killed by nobody)`);
if (errors.length) { console.log(`\npage errors: ${errors.length}`); for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ' + e); }

function diffObj(a, b2) {
  const o = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b2 ?? {})])) {
    const v = (b2?.[k] ?? 0) - (a?.[k] ?? 0);
    if (v) o[k] = v;
  }
  return o;
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ map: MAP, scenario: SCENARIO, t0, t1, slices }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}
await browser.close();
process.exit(0);
