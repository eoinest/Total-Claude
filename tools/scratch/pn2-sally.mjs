#!/usr/bin/env node
/**
 * pn2-sally — does `setGateOpen('postern-N', true)` actually open a postern?
 *
 * `bbe85d1` shuts the eight posterns and justifies it by claiming the affordance is
 * unchanged: the leaves are a chunk tagged `gateDoorFor`, so one existing call re-cuts the
 * raster and the obstacle boxes *and* takes the timber off the screen, with nothing new in
 * `src/sim/`. That is a claim about a code path nothing in the game calls today, which on
 * this project is exactly the kind that ships broken. This calls it.
 *
 *   node tools/scratch/pn2-sally.mjs --port=5603
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5603);
const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'assault', opponent: 2 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&w=960&h=540&quality=high&scenario=assault&battle=${token}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600000 });

const out = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.context.tryGet('city');
  const id = 'postern-30';
  const gate = city.getGates().find((q) => q.id === id);
  const nx = Math.sin(gate.facing), nz = Math.cos(gate.facing);
  const leafVisible = () => {
    let seen = null;
    city.root.traverse((n) => { if (n.name === `postern-door-30-lod0`) seen = n.visible && n.parent.visible; });
    return seen;
  };
  const crossable = () => !city.blocksMovement(
    gate.x + nx * 16, gate.z + nz * 16, gate.x - nx * 16, gate.z - nz * 16);
  const boxAtCentre = () => {
    // Both skins, the way probe-carthage-wall's E4 tests it.
    const obs = city.getObstacles().filter((o) => o.kind === 'wall');
    const hit = (px, pz) => obs.some((o) => {
      const c = Math.cos(-o.rot), s = Math.sin(-o.rot);
      const dx = px - o.x, dz = pz - o.z;
      return Math.abs(dx * c - dz * s) <= o.hw && Math.abs(dx * s + dz * c) <= o.hd;
    });
    return [hit(gate.x + nx * 4.15, gate.z + nz * 4.15), hit(gate.x - nx * 4.15, gate.z - nz * 4.15)];
  };
  const snap = (label) => ({
    label, open: city.getGates().find((q) => q.id === id).open,
    leafDrawn: leafVisible(), crossable: crossable(), skinsSolid: boxAtCentre(),
  });
  const rows = [snap('as built')];
  city.setGateOpen(id, true);
  rows.push(snap('after setGateOpen(true)'));
  city.setGateOpen(id, false);
  rows.push(snap('after setGateOpen(false)'));
  return rows;
});
for (const r of out) {
  console.log(`${r.label.padEnd(26)} open=${String(r.open).padEnd(5)} leafDrawn=${String(r.leafDrawn).padEnd(5)} ` +
    `crossable=${String(r.crossable).padEnd(5)} skins solid=[${r.skinsSolid.join(',')}]`);
}
if (errors.length) { console.log('PAGE ERRORS:'); for (const e of errors) console.log('  ' + e); }
await browser.close();
process.exit(errors.length ? 3 : 0);
