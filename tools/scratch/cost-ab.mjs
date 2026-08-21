/**
 * Interleaved A/B of simulation tick cost.
 *
 * Two trees on two ports, warmed to a point where `qa-determinism` says both are still
 * bit-identical (t+30), then timed over the same tick count, alternating A B A B so that
 * whatever else is running on this shared box lands on both arms. A single ordered pair was
 * measured at 2.42 and 5.03 ms/tick and a repeat of the *same* arm at 3.2, which is the
 * whole reason this file exists.
 */
import { chromium } from 'playwright';
const enc = (c) => Buffer.from(JSON.stringify(c)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const tok = enc({ map:'carthage', opponent:2, unitSize:'ultra',
  rome:{'legio-cohort':6,'praetorian-cohort':2,'urban-cohort':2,sagittarii:2,equites:3,scorpio:1},
  juthungi:{'juthungi-warband':6,'juthungi-spears':3,'juthungi-skirmishers':3,'juthungi-chosen':2,'juthungi-berserkers':2,'juthungi-riders':3},
  quality:'low', difficulty:'hard', seed:4265438264 });
const WARM = Number(process.argv[4] ?? 30);
const TICKS = Number(process.argv[5] ?? 600);
const REPS = Number(process.argv[6] ?? 3);
const browser = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
const open = async (port) => {
  const p = await browser.newPage({ viewport:{width:960,height:540} });
  await p.goto(`http://127.0.0.1:${port}/?harness=1&quality=low&w=960&h=540&scenario=assault&battle=${tok}`, { waitUntil:'domcontentloaded', timeout:120000 });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout:240000 });
  await p.evaluate((w) => {
    const g = window.__game, e = g.engine;
    e.stop(); window.__sr = e.renderOverride; e.renderOverride = () => {};
    e.context.time.resync(); window.__clk = 0; e.frame(0);
    window.__F = (1000/30)*(1+1e-9);
    window.__step = () => { window.__clk += window.__F; e.frame(window.__clk); };
    for (let t=0;t<w*30;t++) window.__step();
  }, WARM);
  return p;
};
const A = await open(process.argv[2]);
const B = await open(process.argv[3]);
const run = (pg, n) => pg.evaluate((k) => {
  const t0 = performance.now();
  for (let t=0;t<k;t++) window.__step();
  return performance.now() - t0;
}, n);
const a = [], b = [];
for (let r=0;r<REPS;r++) { a.push(await run(A, TICKS)); b.push(await run(B, TICKS)); }
const med = (v) => { const s=[...v].sort((x,y)=>x-y); return s[s.length>>1]; };
console.log(`warm ${WARM}s, ${TICKS} ticks x ${REPS}, alternating`);
console.log(`  A port ${process.argv[2]}: ${a.map(v=>v.toFixed(0)).join(' ')}  median ${(med(a)/TICKS).toFixed(3)} ms/tick`);
console.log(`  B port ${process.argv[3]}: ${b.map(v=>v.toFixed(0)).join(' ')}  median ${(med(b)/TICKS).toFixed(3)} ms/tick`);
console.log(`  ratio ${(med(a)/med(b)).toFixed(3)}`);
await browser.close();
