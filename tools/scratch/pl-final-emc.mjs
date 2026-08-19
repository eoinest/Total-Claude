/** Last pass: Rome's palette is unchanged, the gate after the ram, and the controls. */
import { argsOf, boot, shot, fast, hover, cam, aim, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const PORT = Number(A.get('port') ?? 5431);

// --- Rome, unchanged?
{
  const { browser, page, errs } = await boot({ port: PORT, map: 'campus-martius', out: OUT, label: 'fin-rome' });
  await installDiag(page);
  await page.mouse.move(800, 700); await page.waitForTimeout(250);
  console.log('ROME help:', await page.evaluate(() => document.querySelector('.dep-help')?.textContent.replace(/\s+/g, ' ')));
  await page.click('.dep-add'); await page.waitForTimeout(300);
  console.log('ROME palette:', await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row')).map(r => `${r.dataset.unit}=${r.querySelector('.dep-count').textContent}${r.querySelector('[data-d="1"]').disabled ? '[+off]' : '[+on]'}`)));
  console.log('ROME zone:', await page.evaluate(() => window.__game.deployment.zone.label));
  console.log('errs', errs.length);
  await browser.close();
}

// --- Carthage: the gate, the controls
const { browser, page, errs } = await boot({ port: PORT, map: 'carthage', out: OUT, label: 'fin' });
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(250);

console.log('\n-- the clock controls, before the battle starts');
const btns = await page.evaluate(() => Array.from(document.querySelectorAll('.tb-clock button, .topbar button, .tb button')).map(b => ({ c: b.className, t: (b.title || b.textContent || '').trim().slice(0, 30) })));
console.log(' ', JSON.stringify(btns));

await page.click('.dep-begin'); await page.waitForTimeout(500);
const speedOf = () => page.evaluate(() => ({ scale: window.__game.engine.time.scale ?? null, paused: window.__game.engine.time.paused ?? null,
  label: document.querySelector('.tb-speed, .tb-rate, .hud-dbg')?.textContent?.match(/(\d+)x/)?.[0] ?? null }));
console.log('  at start:', JSON.stringify(await speedOf()));
for (const [key, what] of [[' ', 'space'], ['2', 'key 2'], ['3', 'key 3'], ['1', 'key 1']]) {
  await page.keyboard.press(key === ' ' ? 'Space' : key);
  await page.waitForTimeout(350);
  console.log(`  after ${what}:`, JSON.stringify(await speedOf()));
}
const speedBtns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => /speed|rate|pause|fast/i.test(b.className + b.title)).map(b => { const r = b.getBoundingClientRect(); return { c: b.className, t: b.title, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }));
console.log('  clock buttons:', JSON.stringify(speedBtns));
for (const b of speedBtns) { await page.mouse.click(b.x, b.y); await page.waitForTimeout(300); console.log(`  clicked ${b.t || b.c}:`, JSON.stringify(await speedOf())); }

console.log('\n-- camera keys');
const rig = () => page.evaluate(() => { const r = window.__game.engine.rig; return { x: +r.focus.x.toFixed(1), z: +r.focus.z.toFixed(1), yaw: +r.yaw.toFixed(2), zoom: +r.zoom.toFixed(3) }; });
await cam(page, 0, 480, 0.5, 0); await page.waitForTimeout(500);
let r0 = await rig();
for (const k of ['w', 's', 'a', 'd', 'q', 'e']) {
  await page.keyboard.down(k); await page.waitForTimeout(500); await page.keyboard.up(k); await page.waitForTimeout(250);
  const r1 = await rig();
  console.log(`  ${k}: focus ${r0.x},${r0.z} -> ${r1.x},${r1.z}  yaw ${r0.yaw} -> ${r1.yaw}`);
  r0 = r1;
}
await page.mouse.move(800, 450);
await page.mouse.wheel(0, -600); await page.waitForTimeout(600);
console.log('  wheel up:', JSON.stringify(await rig()));
await page.mouse.wheel(0, 900); await page.waitForTimeout(600);
console.log('  wheel down:', JSON.stringify(await rig()));

console.log('\n-- the gate under the ram');
let last = null;
for (let k = 0; k < 14; k++) {
  await fast(page, 25);
  const g = await page.evaluate(() => {
    const s = window.__siege(), c = window.__city();
    const door = c.getGateDoor ? c.getGateDoor() : null;
    return { t: +window.__game.simTime().toFixed(0), gate: s.gateReport(), breach: s.breachReport(), stats: s.stats(),
      door: door ? { open: door.open } : null, gates: c.getGates().slice(0, 1) };
  });
  last = g;
  console.log(`  t+${g.t} gateHp=${g.gate.hp.toFixed(2)} blows=${g.gate.blows} breached=${g.gate.breached} open=${JSON.stringify(g.door)} gate0open=${g.gates[0].open} breachBays=${g.breach.bays.length} lanes=${g.breach.lanes} through=${g.breach.through} statsBreached=${g.stats.gateBreached}`);
  if (g.gate.hp <= 0 && k > 8) break;
}
const gx = last.gates[0];
await aim(page, gx.x, 18, gx.z - 6, { zoom: 0.42 });
await shot(page, OUT, 'fin-gate');
console.log('errs', errs.length);
await browser.close();
