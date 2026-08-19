import { chromium } from 'playwright';
const PORT = Number(process.argv[2] ?? 5241);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
for (const [name, url, probe] of [
  ['index', `${base}/?harness=1&quality=ultra&scenario=field`, () => window.__game?.ready === true],
  ['viewer', `${base}/viewer.html`, () => window.__viewer?.ready === true],
]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [], logs = [];
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => { logs.push(`${m.type()}: ${m.text().slice(0, 160)}`); if (m.type() === 'error') errs.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  page.on('requestfailed', (r) => errs.push(`REQFAIL ${r.url()}`));
  const t0 = Date.now();
  let ready = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(probe, null, { timeout: 180000, polling: 250 });
    ready = true;
  } catch (e) { errs.push(`WAIT ${e.message.slice(0, 120)}`); }
  console.log(`${name}: ready=${ready} in ${Date.now() - t0} ms; errors=${errs.length}`);
  for (const e of errs.slice(0, 6)) console.log('   ' + e);
  const warn = logs.filter((l) => l.startsWith('warning') || /deprecat/i.test(l));
  for (const w of warn.slice(0, 3)) console.log('   warn: ' + w);
  await page.close();
}
await browser.close();
