import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:5199/viewer.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });
const out = await p.evaluate(async () => {
  const m = await import('/src/units/soldierMesh.ts');
  const r = {};
  for (const f of [0,1,2]) for (const l of [0,1,2]) {
    r[`f${f}l${l}`] = m.buildSoldierGeometry(f,l).getIndex().count/3;
  }
  return r;
});
await b.close();
console.log(JSON.stringify(out));
