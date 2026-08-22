#!/usr/bin/env node
/**
 * Gait and seat parameter sweep.
 *
 * `probe-rider.mjs` says what the current numbers are; this says what a candidate change
 * would make them. It rebuilds horse and rider overlays in the page with trial amplitudes
 * and re-measures the stride the renderer will divide ground speed by, plus the hoof's
 * ground penetration and the rider's leg spread against the horse's ribs — the three
 * things that decide whether a gallop reads as a gallop and a rider as astride.
 *
 *   node tools/probe-gait.mjs --port=5393
 */

import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5393);

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${base}/?harness=1&quality=high&w=640&h=360`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const [rig, pose, authored, horseMod, bakedH, bakedM] = await Promise.all([
    import('/src/anim/rig.ts'),
    import('/src/anim/pose.ts'),
    import('/src/anim/authored.ts'),
    import('/src/units/horseMesh.ts'),
    import('/src/anim/generated/horseBaked.gen.ts'),
    import('/src/anim/generated/manBaked.gen.ts'),
  ]);
  const { HORSE_RIG, MAN_RIG, HB, MB } = rig;
  const { decodeBaked, buildOverlay, measureRootSpeed, frameGlobals } = pose;
  const { HORSE_CONTACTS } = authored;

  const hBase = decodeBaked(bakedH.HORSE_BAKED);
  const mBase = decodeBaked(bakedM.MAN_BAKED);

  const worldOf = (r, clip, f) => {
    const n = r.boneCount;
    const q = new Float32Array(n * 4);
    const t = new Float32Array(n * 3);
    frameGlobals(r, clip, f, q, t);
    return t;
  };

  /** Lowest and highest hoof over a clip, and the stride the renderer will use. */
  const gaitStats = (clip) => {
    const s = measureRootSpeed(HORSE_RIG, clip, HORSE_CONTACTS);
    let lo = 1e9, hi = -1e9;
    const hoofBones = [HB.fHoofL, HB.fHoofR, HB.bHoofL, HB.bHoofR];
    let reachF = -1e9, reachB = 1e9;
    for (let f = 0; f < clip.frames; f++) {
      const t = worldOf(HORSE_RIG, clip, f);
      for (const b of hoofBones) {
        const y = t[b * 3 + 1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      const zf = t[HB.fHoofL * 3 + 2];
      if (zf > reachF) reachF = zf;
      const zb = t[HB.bHoofL * 3 + 2];
      if (zb < reachB) reachB = zb;
    }
    // Hoof mesh reaches 0.095 below its bone (see buildHorseGeometry).
    return { rootSpeed: s, stride: s * clip.duration, hoofLo: lo - 0.095, hoofHi: hi - 0.095, reach: reachF - reachB };
  };

  const res = { gaits: [], legs: [], back: null };

  // --- horse: how far can amplitude take the stride? ------------------------
  const galBase = hBase.get('gallop');
  res.gaits.push({ label: 'gallop (baked, no overlay)', ...gaitStats(galBase) });
  for (const a of [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8]) {
    for (const dur of [0.6]) {
      const def = {
        name: 'try', frames: 22, duration: dur, loop: true,
        amp: [
          [HB.fUpperL, a], [HB.fUpperR, a], [HB.bFemurL, a], [HB.bFemurR, a],
          [HB.fShoulderL, a], [HB.fShoulderR, a], [HB.bHipL, a], [HB.bHipR, a],
        ],
        tracks: [],
      };
      res.gaits.push({ label: `amp hips+shoulders ${a.toFixed(2)}`, ...gaitStats(buildOverlay(HORSE_RIG, galBase, def)) });
    }
  }
  for (const a of [1.2, 1.4, 1.6]) {
    const def = {
      name: 'try', frames: 22, duration: 0.6, loop: true,
      amp: [
        [HB.fUpperL, a], [HB.fUpperR, a], [HB.bFemurL, a], [HB.bFemurR, a],
        [HB.fLowerL, a], [HB.fLowerR, a], [HB.bTibiaL, a], [HB.bTibiaR, a],
        [HB.bCannonL, a], [HB.bCannonR, a],
      ],
      tracks: [],
    };
    res.gaits.push({ label: `amp whole leg ${a.toFixed(2)}`, ...gaitStats(buildOverlay(HORSE_RIG, galBase, def)) });
  }
  // Root fore-aft surge: extra backward drift while a hoof is planted.
  for (const d of [0.15, 0.3, 0.45]) {
    const def = {
      name: 'try', frames: 22, duration: 0.6, loop: true,
      amp: [[HB.fUpperL, 1.3], [HB.fUpperR, 1.3], [HB.bFemurL, 1.3], [HB.bFemurR, 1.3]],
      root: [[0, 0, 0, d], [0.5, 0, 0, -d], [1, 0, 0, d]],
      tracks: [],
    };
    res.gaits.push({ label: `amp 1.30 + surge ${d.toFixed(2)}`, ...gaitStats(buildOverlay(HORSE_RIG, galBase, def)) });
  }

  // --- horse back surface at the saddle station -----------------------------
  {
    const g = horseMod.buildHorseGeometry(0);
    const pos = g.getAttribute('position').array;
    const pt = g.getAttribute('aPieceTint').array;
    const anchor = horseMod.saddleOffset();
    let top = -1e9, belly = 1e9, halfW = 0, tackTop = -1e9, tackBot = 1e9;
    for (let v = 0; v < pos.length / 3; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (Math.abs(z - anchor.z) > 0.12) continue;
      if (pt[v * 4] === 0) {
        if (y > top) top = y;
        if (y < belly) belly = y;
        if (Math.abs(x) > halfW) halfW = Math.abs(x);
      } else if (pt[v * 4] === 1) {
        if (y > tackTop) tackTop = y;
        if (y < tackBot) tackBot = y;
      }
    }
    res.back = { anchor, top, belly, halfW, tackTop, tackBot };
    g.dispose();
  }

  // --- rider: leg spread against the ribs ----------------------------------
  const idleAlert = mBase.get('idleAlert');
  const RIDE_ARMS = [];
  const legDef = (flex, abduct, sign) => ({
    name: 'try', frames: 8, duration: 1, loop: true,
    root: [[0, 0, 0, 0]],
    tracks: [
      { bone: MB.thighL, keys: [[0, -54 - flex, 6, sign * abduct]] },
      { bone: MB.shinL, keys: [[0, 40 + flex, -4, -sign * abduct * 0.4]] },
      { bone: MB.thighR, keys: [[0, -54 - flex, -6, -sign * abduct]] },
      { bone: MB.shinR, keys: [[0, 40 + flex, 4, sign * abduct * 0.4]] },
      { bone: MB.footL, keys: [[0, -18, 0, 0]] },
      { bone: MB.footR, keys: [[0, -18, 0, 0]] },
      ...RIDE_ARMS,
    ],
  });
  for (const sign of [-1, 1]) {
    for (const abduct of [14, 20, 26, 32]) {
      for (const flex of [0, 8]) {
        const c = buildOverlay(MAN_RIG, idleAlert, legDef(flex, abduct, sign));
        const t = worldOf(MAN_RIG, c, 0);
        res.legs.push({
          sign, abduct, flex,
          pelvis: [t[MB.pelvis * 3], t[MB.pelvis * 3 + 1], t[MB.pelvis * 3 + 2]],
          kneeX: t[MB.shinL * 3], kneeY: t[MB.shinL * 3 + 1], kneeZ: t[MB.shinL * 3 + 2],
          footX: t[MB.footL * 3], footY: t[MB.footL * 3 + 1], footZ: t[MB.footL * 3 + 2],
        });
      }
    }
  }
  return res;
});

const f = (v, w = 7, d = 3) => String(v.toFixed(d)).padStart(w);
console.log('\n=== horse gallop stride vs amplitude ===');
console.log('  stride = the distance one cycle covers; cadence at 9.6 m/s = 9.6 / stride');
console.log('  label                          rootSpeed  stride  cad@9.6  rate@9.6  hoofLo  hoofHi  reach');
for (const g of out.gaits) {
  console.log(`  ${g.label.padEnd(30)} ${f(g.rootSpeed, 8)} ${f(g.stride)} ${f(9.6 / g.stride, 7, 2)} ` +
    `${f(9.6 / g.rootSpeed, 8, 3)} ${f(g.hoofLo)} ${f(g.hoofHi)} ${f(g.reach)}`);
}

console.log('\n=== horse cross-section at the saddle station (rest pose) ===');
const b = out.back;
console.log(`  anchor y ${b.anchor.y.toFixed(4)} z ${b.anchor.z.toFixed(4)}`);
console.log(`  body top ${b.top.toFixed(4)}  belly ${b.belly.toFixed(4)}  half-width ${b.halfW.toFixed(4)}`);
console.log(`  tack spans ${b.tackBot.toFixed(4)} .. ${b.tackTop.toFixed(4)}` +
  `   (tack top is ${(b.tackTop - b.top).toFixed(4)} m relative to the body surface)`);

console.log('\n=== rider leg spread (left leg; barrel half-width above) ===');
console.log('  sign abduct flex   pelvisY   kneeX   kneeY   kneeZ   footX   footY   footZ');
for (const l of out.legs) {
  console.log(`  ${String(l.sign).padStart(4)} ${String(l.abduct).padStart(6)} ${String(l.flex).padStart(4)} ` +
    `${f(l.pelvis[1])} ${f(l.kneeX)} ${f(l.kneeY)} ${f(l.kneeZ)} ${f(l.footX)} ${f(l.footY)} ${f(l.footZ)}`);
}

if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
if (server) server.kill('SIGTERM');
