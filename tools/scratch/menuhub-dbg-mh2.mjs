import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5391';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-dev-shm-usage','--hide-scrollbars'] });
const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => ({
  menuRootKids: document.getElementById('menu-root')?.children.length,
  menuCls: document.querySelector('.menu')?.className ?? 'NO .menu',
  dest: document.querySelectorAll('.dest').length,
  ls: JSON.stringify(Object.entries(localStorage)),
  loc: location.href,
})));
await browser.close();
