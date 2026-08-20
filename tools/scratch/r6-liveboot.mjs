import { chromium } from 'playwright';
const URL = 'https://total-claude.vercel.app';
const MAPS = ['campus-martius', 'pydna', 'carthage'];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
let bad = 0;
for (const m of MAPS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [], cerr = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', c => { if (c.type() === 'error') cerr.push(c.text().slice(0, 160)); });
  const t0 = Date.now();
  await page.goto(`${URL}/?map=${m}&menu=0`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  let ready = false;
  try {
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 500 });
    ready = true;
  } catch {}
  const c1 = await page.evaluate(() => window.__game?.simTime?.() ?? null);
  await page.waitForTimeout(5000);
  const c2 = await page.evaluate(() => window.__game?.simTime?.() ?? null);
  const moved = c1 != null && c2 != null && c2 > c1;
  const ok = ready && moved && errs.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${m.padEnd(15)} ready=${ready} sim ${c1}->${c2} moved=${moved} boot=${((Date.now()-t0)/1000).toFixed(1)}s pageerror=${errs.length} cerr=${cerr.length}`);
  if (errs.length) console.log('   ' + errs.slice(0,2).join(' | '));
  await ctx.close();
}
await browser.close();
console.log(bad === 0 ? '\nALL THREE MAPS LIVE AND RUNNING' : `\n${bad} MAP(S) FAILED`);
