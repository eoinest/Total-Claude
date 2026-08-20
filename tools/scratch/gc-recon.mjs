/**
 * gc-recon.mjs — where, in sim time, does the Porta Flaminia actually give way?
 *
 * No audio, no camera, no render: just the clock and `gateReport()`, so the expensive
 * paced audio capture that follows knows exactly which sixteen seconds to record.
 *
 *   node tools/scratch/gc-recon.mjs --port=5344 [--to=260]
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5344);
const TO = Number(args.get('to') ?? 260);
const Q = args.get('quality') ?? 'ultra';
/*
 * `--noaudio` clears `AudioEngine.ready`, which makes its `preRender` return on its first
 * line — every listener update, cluster flush, bed and siege poll included. Run the same
 * timeline with and without it: if the two are tick-for-tick identical, nothing the audio
 * subsystem does can be reaching the simulation, which is the claim the siege watch rests on.
 */
const NOAUDIO = args.has('noaudio');
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(`${base}/?harness=1&quality=${Q}&w=960&h=540&map=campus-martius&scenario=assault`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
await page.evaluate((off) => {
  window.__game.engine.stop();
  window.__game.engine.renderOverride = () => {};
  const a = window.__game.engine.context.tryGet('audio');
  if (!a) throw new Error('no audio subsystem registered');
  if (off) a.ready = false;
  return a.ready;
}, NOAUDIO);
console.log(`  audio: ${NOAUDIO ? 'DISABLED (ready=false)' : 'live'}`);

const out = await page.evaluate((to) => {
  const g = window.__game;
  const s = g.battle.siege;
  const rows = [];
  let last = null;
  const snap = () => {
    const r = s.gateReport();
    const rams = s.ramReport();
    const tw = s.towerReport();
    return {
      t: +g.simTime().toFixed(3),
      open: r.open, breached: r.breached, blows: r.blows,
      broken: r.gates.map((x) => `${x.id}:${x.broken ? 1 : 0}`).join(','),
      x: +r.x.toFixed(2), z: +r.z.toFixed(2),
      wrecks: rams.filter((m) => m.wreck).length,
      ramStates: rams.map((m) => `${m.kind}/${m.state}/${m.blows}`).join(' '),
      bays: s.breachReport().bays.length,
      towers: tw.map((m) => m.state).join(','),
    };
  };
  rows.push(snap());
  while (g.simTime() < to) {
    g.engine.advance(1 / 30, 1000 / 30);
    const cur = snap();
    const key = `${cur.open}|${cur.breached}|${cur.broken}|${cur.wrecks}|${cur.bays}|${cur.towers}`;
    if (key !== last) { rows.push(cur); last = key; }
    else if (rows.length && cur.t - rows[rows.length - 1].t > 20) rows.push(cur);
  }
  rows.push(snap());
  return rows;
}, TO);

for (const r of out) {
  console.log(`t+${String(r.t).padStart(8)}  open=${r.open ? 1 : 0} breached=${r.breached ? 1 : 0} `
    + `blows=${String(r.blows).padStart(2)} broken=[${r.broken}] wrecks=${r.wrecks} bays=${r.bays} `
    + `towers=[${r.towers}] gate=(${r.x},${r.z})  ${r.ramStates}`);
}
if (errs.length) { console.error(`\n${errs.length} page error(s):`); for (const e of [...new Set(errs)].slice(0, 8)) console.error('  ' + e); }
await browser.close();
