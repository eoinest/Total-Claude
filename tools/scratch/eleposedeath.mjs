#!/usr/bin/env node
// Where every bone of the elephant ends up on the last frame of the death clip.
import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5578);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 150000 });

const out = await page.evaluate(async () => {
  const [{ ELEPHANT_RIG }, ec, pose] = await Promise.all([
    import('/src/anim/rig.ts'), import('/src/anim/elephantClips.ts'), import('/src/anim/pose.ts'),
  ]);
  const rig = ELEPHANT_RIG;
  const n = rig.boneCount;
  const q = new Float32Array(n * 4);
  const t = new Float32Array(n * 3);
  const clip = ec.ELEPHANT_CLIP_SET.clips[ec.ELEPHANT_CLIP.death];
  const rows = [];
  for (const f of [0, Math.floor(clip.frames / 2), clip.frames - 1]) {
    pose.frameGlobals(rig, clip, f, q, t);
    const byName = {};
    for (let b = 0; b < n; b++) {
      byName[rig.names[b]] = [
        +t[b * 3].toFixed(3), +t[b * 3 + 1].toFixed(3), +t[b * 3 + 2].toFixed(3),
      ];
    }
    let lo = Infinity, hi = -Infinity, loName = '', hiName = '';
    for (const [k, v] of Object.entries(byName)) {
      if (v[1] < lo) { lo = v[1]; loName = k; }
      if (v[1] > hi) { hi = v[1]; hiName = k; }
    }
    rows.push({ f, lo: +lo.toFixed(3), loName, hi: +hi.toFixed(3), hiName, byName });
  }
  return { frames: clip.frames, rows, names: rig.names };
});

for (const r of out.rows) {
  console.log(`\n--- frame ${r.f} / ${out.frames - 1} ---  lowest ${r.loName} y=${r.lo}   highest ${r.hiName} y=${r.hi}`);
  const pick = ['root', 'croup', 'loin', 'barrel', 'withers', 'neck', 'head', 'trunk4',
    'fFootL', 'fFootR', 'bFootL', 'bFootR', 'fKneeL', 'bHockL'];
  for (const k of pick) console.log(`  ${k.padEnd(9)} ${JSON.stringify(r.byName[k])}`);
}
await browser.close();
