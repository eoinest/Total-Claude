/**
 * Shard one 12-seed arm of `probe-footing --only=battle` across N browsers on one vite.
 *
 * The seed walk is arithmetic — `seed_i = (SEED0 + i * 0x9e3779b1) >>> 0` — so a shard is
 * just the same walk restarted at its own first seed. One vite serves every shard; the
 * probe only spawns a server when the port is dead, so nothing here starts or kills one.
 *
 *   node tools/scratch/sf-arm-emc.mjs --port=5491 --label=base --map=campus-martius \
 *        --until=1500 --shards=4 --seeds=12 [--traverse=2.0] [--nodrag]
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const PORT = Number(A.get('port') ?? 5491);
const LABEL = A.get('label') ?? 'arm';
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'high';
const UNTIL = Number(A.get('until') ?? 1500);
const SEEDS = Number(A.get('seeds') ?? 12);
const SHARDS = Number(A.get('shards') ?? 4);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const K = 0x9e3779b1;
const OUT = path.join(ROOT, 'screenshots/siegefun');
await mkdir(OUT, { recursive: true });

const per = Math.ceil(SEEDS / SHARDS);
const jobs = [];
for (let s = 0; s < SHARDS; s++) {
  const i0 = s * per;
  if (i0 >= SEEDS) break;
  const n = Math.min(per, SEEDS - i0);
  const seed0 = (SEED0 + i0 * K) >>> 0;
  const json = path.join('screenshots/siegefun', `${LABEL}-s${s}.json`);
  const argv = ['tools/probe-footing.mjs', `--port=${PORT}`, '--only=battle', `--map=${MAP}`,
    `--quality=${QUALITY}`, `--until=${UNTIL}`, `--seeds=${n}`, `--seed0=${seed0}`, `--json=${json}`];
  for (const k of ['traverse', 'nodrag']) if (A.has(k)) argv.push(A.get(k) === '1' ? `--${k}` : `--${k}=${A.get(k)}`);
  jobs.push({ s, i0, n, json: path.join(ROOT, json), argv });
}

console.log(`# ${LABEL}  map=${MAP} q=${QUALITY} until=${UNTIL} seeds=${SEEDS} shards=${jobs.length}`);
const t0 = Date.now();
await Promise.all(jobs.map((j) => new Promise((res, rej) => {
  const p = spawn('node', j.argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  p.stdout.on('data', (d) => {
    tail += d;
    for (const line of String(d).split('\n')) if (/^\s+run /.test(line)) console.log(`  [${j.s}]${line.trim()}`);
  });
  p.stderr.on('data', (d) => { tail += d; });
  p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`shard ${j.s} exit ${c}\n${tail.slice(-1500)}`))));
})));

const runs = [];
for (const j of jobs) {
  const r = JSON.parse(await readFile(j.json, 'utf8'));
  runs.push(...r.runs);
}
runs.sort((a, b) => a.seed - b.seed);

const tally = new Map();
let juth = 0, undec = 0, sumAt = 0, nAt = 0;
for (const r of runs) {
  const v = r.result ? r.result.victor : null;
  const k = r.result ? `${v === 1 ? 'Juthungi' : v === 0 ? 'Rome' : v === 2 ? 'Carthage' : v} / ${r.result.reason}` : 'undecided';
  tally.set(k, (tally.get(k) ?? 0) + 1);
  if (r.result) { sumAt += r.result.at; nAt++; } else undec++;
}
/** Whoever is storming wins when the garrison side loses; on both maps the storm is the non-garrison faction. */
const stormFaction = runs[0]?.setup?.storm ?? 1;
for (const r of runs) if (r.result && r.result.victor === stormFaction) juth++;

const crossTotal = runs.reduce((a, r) => a + Object.values(r.crossings.byBay).reduce((x, b) => x + b.men, 0), 0);
const errs = runs.flatMap((r) => r.errors);
const summary = {
  label: LABEL, map: MAP, quality: QUALITY, until: UNTIL, seeds: runs.length,
  stormFaction, stormWins: juth, undecided: undec,
  meanDecisionS: nAt ? +(sumAt / nAt).toFixed(0) : null,
  crossings: crossTotal, pageErrors: errs.length,
  outcomes: Object.fromEntries(tally),
  perSeed: runs.map((r) => ({
    seed: r.seed,
    victor: r.result ? r.result.victor : null,
    reason: r.result ? r.result.reason : 'undecided',
    at: r.result ? +r.result.at.toFixed(0) : null,
    inside: r.crossings.insidePeak.throughWall,
    crossed: Object.values(r.crossings.byBay).reduce((x, b) => x + b.men, 0),
  })),
};
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ summary, runs }, null, 1));
console.log(`\n== ${LABEL}: storm wins ${juth}/${runs.length}  undecided ${undec}  mean decision t+${summary.meanDecisionS}s  crossings ${crossTotal}  pageerrors ${errs.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s wall)`);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log(JSON.stringify(summary.perSeed));
