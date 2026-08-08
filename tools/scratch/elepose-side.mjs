#!/usr/bin/env node
/**
 * Which side does the death clip roll the animal onto, and how high does each bone finish?
 *
 * `CREW_FALL_SIDE` in `UnitRenderSystem` is a hand-derived +1 ("its right") read off the sign
 * of the root's roll key. A roll about the model's forward axis moves +X up or down depending
 * on the handedness of the rig, and getting it backwards throws the crew *under* the falling
 * body instead of clear of it. So measure it: run the clip's own forward kinematics and print
 * where each bone actually is.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5691);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=low&enemy=carthage`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const { ELEPHANT_CLIP_SET } = await import('/src/anim/elephantClips.ts');
  const { frameGlobals } = await import('/src/anim/pose.ts');
  const rig = ELEPHANT_CLIP_SET.rig;
  const n = rig.boneCount;
  const q = new Float32Array(n * 4);
  const t = new Float32Array(n * 3);
  const clip = ELEPHANT_CLIP_SET.clips.find((c) => c.name === 'death');
  const at = (f) => {
    frameGlobals(rig, clip, f, q, t);
    const rows = [];
    for (let b = 0; b < n; b++) {
      rows.push({
        name: rig.names[b],
        x: +t[b * 3].toFixed(3), y: +t[b * 3 + 1].toFixed(3), z: +t[b * 3 + 2].toFixed(3),
      });
    }
    return rows;
  };
  return { frames: clip.frames, first: at(0), last: at(clip.frames - 1) };
});

console.log(`death clip, ${out.frames} frames\n`);
console.log('bone                standing x /  y /  z        settled x /  y /  z');
for (let i = 0; i < out.first.length; i++) {
  const a = out.first[i]; const b = out.last[i];
  console.log(`${a.name.padEnd(18)} ${String(a.x).padStart(7)} ${String(a.y).padStart(7)} ${String(a.z).padStart(7)}   `
    + `${String(b.x).padStart(7)} ${String(b.y).padStart(7)} ${String(b.z).padStart(7)}`);
}
const lo = out.last.reduce((m, r) => (r.y < m.y ? r : m));
const hi = out.last.reduce((m, r) => (r.y > m.y ? r : m));
const dxSum = out.last.reduce((s, r, i) => s + (r.x - out.first[i].x), 0) / out.last.length;
console.log(`\nlowest settled bone: ${lo.name} at y ${lo.y}`);
console.log(`highest settled bone: ${hi.name} at y ${hi.y}`);
console.log(`mean lateral displacement of every bone, standing -> settled: ${dxSum.toFixed(3)} m in +X`);
console.log(dxSum < 0
  ? 'the body moves toward -X, so it falls onto its -X flank'
  : 'the body moves toward +X, so it falls onto its +X flank');
await browser.close();
