/** Rome, deployment: put a cohort on the parapet by hand and measure where it lands. */
import { argsOf, boot, shot, fast, hover, rightDrag, rightClick, leftClick, cam, proj, aim,
  selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page, errs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'campus-martius', out: OUT, label: 'pp' });
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);
const bays = await page.evaluate(() => window.__bays());
const own = await page.evaluate(() => window.__units(0));
const coh = own.find(u => u.type === 'legio-cohort');
console.log('cohort on the ground behind the wall:', JSON.stringify(coh));
let s = await selectHard(page, coh.id, { zoom: 0.6, yaw: Math.PI });
console.log('select:', s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why} ${s.answering}/${s.probes}`);
if (!s.ok) { await browser.close(); process.exit(1); }
const b = bays.filter(x => x.garr).sort((p, q) => Math.abs(p.cx - coh.x) - Math.abs(q.cx - coh.x))[2];
console.log('target bay', JSON.stringify(b));
const wp = await wallPixel(page, b, { side: -1, zoom: 0.6 });
console.log(`${wp.hit}/${wp.tried} pixels on the bay offer a wall order`);
if (!wp.p) { console.log('!! no pixel offers one'); await shot(page, OUT, 'pp-nopixel'); await browser.close(); process.exit(1); }
const h = await hover(page, wp.p);
console.log('cursor before I commit:', h.cursor, 'hint', JSON.stringify(h.hint));
await shot(page, OUT, 'pp-1-before');
const d = await rightDrag(page, wp.p, { x: wp.p.x + 90, y: wp.p.y });
console.log('hint while dragging:', JSON.stringify(d.hint), 'cursor', d.cursor);
await page.waitForTimeout(900);
let u = await page.evaluate((i) => window.__u(i), coh.id);
console.log('after the drop:', JSON.stringify(u));
console.log(`bay walkY ${b.walkY}  men mean ${u.meanY}  error ${(u.meanY - b.walkY).toFixed(3)} m  spread ${(u.hiY - u.loY).toFixed(3)} m`);
await shot(page, OUT, 'pp-2-dropped');
// Can I pick them up there, during deployment?
const p2 = await aim(page, u.x, u.meanY + 0.9, u.z, { zoom: 0.6, yaw: Math.PI });
if (p2) { const h2 = await hover(page, p2); console.log('hover my own men on the parapet, still in deployment:', { cursor: h2.cursor, hovered: h2.hovered, want: coh.id }); }
const s2 = await selectHard(page, coh.id, { zoom: 0.6, yaw: Math.PI });
console.log('re-select them in deployment:', s2.ok ? `OK` : `FAILED ${s2.why} ${s2.answering}/${s2.probes}`);
console.log('deployment thinks:', await page.evaluate(() => { const d = window.__game.deployment; return { units: d.budget().units, men: d.budget().men }; }));
// and after the battle starts?
await page.click('.dep-begin'); await page.waitForTimeout(600);
await fast(page, 4);
u = await page.evaluate((i) => window.__u(i), coh.id);
console.log('once the battle starts:', JSON.stringify(u), `error ${(u.meanY - b.walkY).toFixed(3)} m`);
const s3 = await selectHard(page, coh.id, { zoom: 0.6, yaw: Math.PI });
console.log('re-select once the battle is running:', s3.ok ? `OK (${s3.easy ? 'first click' : `hunted ${s3.answering}/${s3.probes}`})` : `FAILED ${s3.why}`);
await shot(page, OUT, 'pp-3-inplay');
console.log('errs', errs.length);
await browser.close();
