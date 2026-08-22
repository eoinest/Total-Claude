#!/usr/bin/env node
/**
 * How wide does the box have to be, and how far east does the line then stand?
 *
 * `probe-deployshift.mjs` swept a rigid translation against the *shipped* boxes and found the
 * offset that gets the army out of the Tiber. It cannot answer §15 task 14's question, which is
 * the other way round: given that the line does not fit, how much box does it need, and what
 * does the placement rule have to inset by so that nobody stands on the mask's feather?
 *
 * This reads the real pool at t+0, undoes the shift `standOnDeploymentGround` actually applied,
 * and then replays candidate box geometries over the un-shifted men — counting, for each, the
 * men outside their own mask, the men in water, on the far bank and over the impassable slope,
 * and the east edge the box would need. The terrain it samples is the *current* heightfield, so
 * every ground number here is the unprepared case and can only improve once the box flattens it.
 *
 *   node tools/scratch/probe-deployfit.mjs --port=5932
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5932);
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(() => window.__game.engine.stop());

const out = await page.evaluate(async () => {
  const g = window.__game;
  const t = g.engine.ctx.get('terrain');
  const topo = await import('/src/terrain/topography.ts');
  const maps = await import('/src/maps/index.ts');
  const ground = maps.activeMap().terrain.deploy;
  const WATER = topo.WATER_LEVEL;
  const IMPASSABLE = 0.62;
  const FEATHER = 80;

  const rectMask = (x, z, cx, cz, hx, hz, feather) => {
    const dx = 1 - Math.min(1, Math.max(0, (Math.abs(x - cx) - (hx - feather)) / feather));
    const dz = 1 - Math.min(1, Math.max(0, (Math.abs(z - cz) - (hz - feather)) / feather));
    return dx * dx * (3 - 2 * dx) * (dz * dz * (3 - 2 * dz));
  };

  const pool = g.battle.pool;
  // Each unit's own box, exactly as `standOnDeploymentGround` picks it.
  const units = g.battle.units.map((u) => ({
    id: u.id, type: u.typeId, faction: u.faction, z: u.z,
    side: Math.abs(u.z - ground.north.cz) <= Math.abs(u.z - ground.south.cz) ? 'north' : 'south',
    members: [...u.members].filter((i) => pool.hp[i] > 0),
  }));

  // Undo the shift the shipped rule applied, so the candidates below start from the same
  // un-shifted layout `deployBattle` produces before it calls the rule.
  let shipped = ground.axisX;
  for (const u of units) {
    const box = ground[u.side];
    let west = Infinity;
    for (const i of u.members) if (pool.x[i] < west) west = pool.x[i];
    shipped = Math.max(shipped, box.cx - box.hx - west);
  }

  const men = [];
  for (const u of units) {
    for (const i of u.members) {
      men.push({ u: u.id, side: u.side, faction: u.faction, x0: pool.x[i] - shipped, z: pool.z[i] });
    }
  }

  const evaluate = (cand) => {
    let shift = cand.axisX;
    for (const u of units) {
      const box = cand[u.side];
      let west = Infinity;
      for (const i of u.members) if (pool.x[i] - shipped < west) west = pool.x[i] - shipped;
      shift = Math.max(shift, box.cx - box.hx + cand.inset - west);
    }
    const rows = {};
    for (const side of ['north', 'south']) {
      const box = cand[side];
      let n = 0, outside = 0, west = 0, east = 0, wet = 0, far = 0, steep = 0;
      let worst = 0, minX = Infinity, maxX = -Infinity, weakest = 1;
      for (const m of men) {
        if (m.side !== side) continue;
        n++;
        const x = m.x0 + shift;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        const mv = rectMask(x, m.z, box.cx, box.cz, box.hx, box.hz, FEATHER);
        if (mv < weakest) weakest = mv;
        if (mv < 0.02) { outside++; if (x < box.cx) west++; else east++; }
        const h = t.heightAt(x, m.z);
        if (h < WATER) wet++;
        else if (x < topo.riverBankX(m.z, -1)) far++;
        const s = Math.hypot((t.heightAt(x + 4, m.z) - t.heightAt(x - 4, m.z)) / 8,
          (t.heightAt(x, m.z + 4) - t.heightAt(x, m.z - 4)) / 8);
        if (s > worst) worst = s;
        if (s > IMPASSABLE) steep++;
      }
      rows[side] = {
        n, outside, west, east, wet, far, steep,
        worst: +worst.toFixed(3), weakestMask: +weakest.toFixed(4),
        minX: +minX.toFixed(1), maxX: +maxX.toFixed(1),
        boxX: [box.cx - box.hx, box.cx + box.hx],
        clearEast: +(box.cx + box.hx - maxX).toFixed(1),
        clearWest: +(minX - (box.cx - box.hx)).toFixed(1),
      };
    }
    return { shift: +shift.toFixed(3), ...rows };
  };

  // The ground the eastern extension would stand on, unprepared, along both box latitudes.
  const scan = [];
  for (const [name, cz, hz] of [['north', ground.north.cz, ground.north.hz],
    ['south', ground.south.cz, ground.south.hz]]) {
    for (let x = 400; x <= 1000; x += 20) {
      let wet = 0, worst = 0, minH = Infinity, cells = 0;
      for (let z = cz - hz; z <= cz + hz; z += 8) {
        cells++;
        const h = t.heightAt(x, z);
        if (h < minH) minH = h;
        if (h < WATER) wet++;
        const s = Math.hypot((t.heightAt(x + 4, z) - t.heightAt(x - 4, z)) / 8,
          (t.heightAt(x, z + 4) - t.heightAt(x, z - 4)) / 8);
        if (s > worst) worst = s;
      }
      scan.push({ name, x, cells, wet, minH: +minH.toFixed(2), worst: +worst.toFixed(3) });
    }
  }

  const cands = [];
  const base = { axisX: ground.axisX, north: { ...ground.north }, south: { ...ground.south } };
  cands.push({ label: 'shipped', ...base, inset: 0 });
  for (const inset of [0, 20, 40, 60, 80]) {
    for (const grow of [0, 60, 120, 180, 240, 300]) {
      cands.push({
        label: `inset ${inset}, east +${grow}`,
        axisX: base.axisX,
        north: { ...base.north, cx: base.north.cx + grow / 2, hx: base.north.hx + grow / 2 },
        south: { ...base.south, cx: base.south.cx + grow / 2, hx: base.south.hx + grow / 2 },
        inset,
      });
    }
  }
  return {
    shipped, ground,
    results: cands.map((c) => ({ label: c.label, inset: c.inset, ...evaluate(c) })),
    scan,
  };
});

console.log(`shipped shift ${out.shipped.toFixed(3)} m; boxes ${JSON.stringify(out.ground)}`);
console.log('');
console.log('candidate                | shift  | N out(W/E) wet far steep worst  minX   maxX  clrW  clrE weakest'
  + ' || S out(W/E) wet far steep worst  minX   maxX  clrW  clrE weakest');
for (const r of out.results) {
  const f = (s) => `${String(s.outside).padStart(4)}(${String(s.west).padStart(3)}/${String(s.east).padStart(3)})`
    + `${String(s.wet).padStart(4)}${String(s.far).padStart(4)}${String(s.steep).padStart(6)}`
    + `${s.worst.toFixed(3).padStart(7)}${s.minX.toFixed(0).padStart(6)}${s.maxX.toFixed(0).padStart(7)}`
    + `${s.clearWest.toFixed(0).padStart(6)}${s.clearEast.toFixed(0).padStart(6)}${s.weakestMask.toFixed(4).padStart(8)}`;
  console.log(`${r.label.padEnd(24)} | ${r.shift.toFixed(1).padStart(6)} |${f(r.north)} ||${f(r.south)}`);
}
console.log('');
console.log('unprepared ground east, by box latitude:');
for (const name of ['north', 'south']) {
  const row = out.scan.filter((s) => s.name === name);
  console.log(`  ${name}: ` + row.map((s) => `${s.x}:${s.worst}${s.wet ? `/w${s.wet}` : ''}`).join(' '));
}
if (args.get('json')) await writeFile(path.resolve(args.get('json')), JSON.stringify(out, null, 2));
await browser.close();
