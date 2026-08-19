/** Screen-right vs A/D, the speed keys, and marching through the broken gate. */
import { argsOf, boot, shot, fast, rightClick, cam, aim, proj, installDiag, selectHard, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page, errs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'carthage', out: OUT, label: 'last' });
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(250);
await page.click('.dep-begin'); await page.waitForTimeout(400);

console.log('-- which way is screen right, and which way does D go');
for (const yaw of [0, Math.PI / 2, Math.PI]) {
  await cam(page, 0, 470, 0.55, yaw); await page.waitForTimeout(600);
  const j = await page.evaluate(() => { const g = window.__game; const f = g.engine.rig.focus;
    const p0 = window.__P(f.x, f.y, f.z), px = window.__P(f.x + 20, f.y, f.z), pz = window.__P(f.x, f.y, f.z + 20);
    return { p0, dxScreen: px ? +(px.x - p0.x).toFixed(1) : null, dzScreen: pz ? +(pz.x - p0.x).toFixed(1) : null, dzUp: pz ? +(pz.y - p0.y).toFixed(1) : null }; });
  const before = await page.evaluate(() => { const f = window.__game.engine.rig.focus; return { x: +f.x.toFixed(1), z: +f.z.toFixed(1) }; });
  await page.keyboard.down('d'); await page.waitForTimeout(400); await page.keyboard.up('d'); await page.waitForTimeout(250);
  const after = await page.evaluate(() => { const f = window.__game.engine.rig.focus; return { x: +f.x.toFixed(1), z: +f.z.toFixed(1) }; });
  const dx = after.x - before.x, dz = after.z - before.z;
  // Screen-x movement the D key produced.
  const screenDx = (j.dxScreen / 20) * dx + (j.dzScreen / 20) * dz;
  console.log(`  yaw ${yaw.toFixed(2)}: world+X is ${j.dxScreen > 0 ? 'screen RIGHT' : 'screen LEFT'} (${j.dxScreen}px/20m); D moved focus (${dx.toFixed(1)}, ${dz.toFixed(1)}) = ${screenDx.toFixed(0)} px of screen-x -> camera pans ${screenDx > 0 ? 'RIGHT (view slides right, scene slides left)' : 'LEFT'}`);
}

console.log('\n-- speed keys: does the clock actually change rate');
const t = () => page.evaluate(() => window.__game.simTime());
for (const k of ['1', '2', '3']) {
  await page.keyboard.press(k); await page.waitForTimeout(200);
  const a = await t(); await page.waitForTimeout(1500); const b = await t();
  console.log(`  key ${k}: ${(b - a).toFixed(2)} sim-seconds in 1.5 real seconds  (=${((b - a) / 1.5).toFixed(2)}x)`);
  console.log('    debug line:', await page.evaluate(() => document.querySelector('.hud-dbg, .dbg')?.textContent?.replace(/\s+/g, ' ').slice(-40)));
}
await page.keyboard.press('1');

console.log('\n-- break the gate, then march a cohort through it');
for (let k = 0; k < 12; k++) {
  await fast(page, 25);
  const g = await page.evaluate(() => window.__siege().gateReport());
  if (g.breached) { console.log(`  gate breached at t+${(await page.evaluate(() => window.__game.simTime())).toFixed(0)}`); break; }
}
const gate = (await page.evaluate(() => window.__city().getGates()))[0];
console.log('  gate', JSON.stringify(gate));
const coh = (await page.evaluate(() => window.__units(0))).filter(u => u.type === 'legio-cohort' && u.alive > 100).sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
console.log('  cohort', coh.id, 'at', coh.x, coh.z);
const s = await selectHard(page, coh.id, { zoom: 0.55 });
console.log('  select:', s.ok ? 'OK' : `FAILED ${s.why}`);
if (s.ok) {
  const inX = gate.x, inZ = gate.z + 45;
  const gy = await page.evaluate(([x, z]) => window.__game.battle.groundAt(x, z), [inX, inZ]);
  const p = await aim(page, inX, gy, inZ, { zoom: 0.62 });
  console.log('  street beyond the gate projects to', p);
  if (p) {
    const d = await rightClick(page, p, { hold: 400 });
    console.log('  hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
    for (const step of [40, 40, 40, 60]) {
      await fast(page, step);
      const u = await page.evaluate((i) => window.__u(i), coh.id);
      const inside = await page.evaluate((i) => { const g = window.__game, u = g.battle.unitById(i), p = g.battle.pool;
        let n = 0; for (const m of u.members) if (p.hp[m] > 0 && p.z[m] > 535) n++; return n; }, coh.id);
      console.log(`    t+${(await page.evaluate(() => window.__game.simTime())).toFixed(0)}  cohort at (${u.x},${u.z}) alive ${u.alive}  men past the wall line: ${inside}`);
    }
    await aim(page, gate.x, 16, gate.z, { zoom: 0.42 });
    await shot(page, OUT, 'last-gate');
  }
}
console.log('errs', errs.length);
await browser.close();
