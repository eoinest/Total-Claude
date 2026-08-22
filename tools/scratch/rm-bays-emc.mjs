/**
 * The bays either side of the gate, their stage, and how many stations each carries.
 *
 * `deployAssault` fans the garrison out from the gate with `fanOut(total, 1, holdable)` — d
 * starts at 1, so bay offset **0**, the gate bay itself, is never offered. On the redesigned
 * circuit the Porta Flaminia is bay 1 and bays 0, 2, 3 and 4 are `footing`/`gap`/`footing`,
 * which `holdable` rejects. This prints the consequence rather than arguing it.
 */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'ultra';
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 240 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY })}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
const out = await p.evaluate(() => {
  const g = window.__game, b = g.battle, s = b.siege, ctx = g.engine.context;
  const city = ctx.tryGet('city');
  const bays = city.getGarrisonBays();
  const gates = city.getGates();
  const rows = bays.map((v) => {
    let st = 0, owned = 0;
    for (let i = 0; i < s.nStations; i++) if (s.sBay[i] === v.index) { st++; if (s.sOwner[i] >= 0) owned++; }
    return { index: v.index, stage: v.stage, garrisonable: v.garrisonable, isGate: v.isGate,
      x: +((v.x0 + v.x1) / 2).toFixed(1), z: +((v.z0 + v.z1) / 2).toFixed(1),
      len: +Math.hypot(v.x1 - v.x0, v.z1 - v.z0).toFixed(1), stations: st, owned };
  });
  // Which runs the gate bay's stations fall in, since `recut` severs the gatehouse stubs.
  const gateBay = bays.find((v) => v.isGate);
  const runs = {};
  for (let i = 0; i < s.nStations; i++) if (s.sBay[i] === gateBay.index) {
    const r = s.sRun[i]; (runs[r] ??= { n: 0, x: [] }).n++; runs[r].x.push(+s.sx[i].toFixed(0));
  }
  return { rows, gates: gates.map((x) => ({ id: x.id, x: +x.x.toFixed(1) })), gateBayIndex: gateBay.index,
    gateRuns: Object.entries(runs).map(([r, v]) => `run${r}: ${v.n} stations x ${Math.min(...v.x)}..${Math.max(...v.x)}`),
    nStations: s.nStations, nRuns: s.nRuns };
});
console.log(`gates: ${JSON.stringify(out.gates)}  gate bay ${out.gateBayIndex}  stations ${out.nStations} in ${out.nRuns} runs`);
console.log('gate bay runs:', out.gateRuns.join('  |  '));
console.log(' bay  stage        hold  gate   x      len   stations');
for (const r of out.rows.slice(0, 14)) {
  console.log(`  ${String(r.index).padStart(2)}  ${r.stage.padEnd(11)}  ${r.garrisonable ? ' Y ' : ' - '}  ${r.isGate ? 'GATE' : '    '}  ${String(r.x).padStart(6)}  ${String(r.len).padStart(5)}  ${String(r.stations).padStart(4)}`);
}
await b.close();
