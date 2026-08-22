#!/usr/bin/env node
/**
 * Terrain / VFX diagnostic probe.
 *
 * Three jobs, all of them measurements rather than arguments:
 *
 *   --tree            dump the scene graph (name, type, visible, world bbox) so a defect
 *                     can be attributed to a *named* object rather than to a guess.
 *   --bisect=BOX      render one camera repeatedly, hiding one top-level subtree at a
 *                     time, and count how many dark pixels remain inside BOX. Whichever
 *                     hide empties the box owns the artifact. BOX is x,y,w,h in pixels.
 *   --lattice         2-D power spectrum of a ground crop, to put a number on "the grass
 *                     sits in a visible regular lattice": a real sward has a broad
 *                     spectrum, a lattice has a spike at its own period.
 *
 * The bisect exists because item 3 of this workstream — a dark shape in the sky at the top
 * of `horizon` — had already collected three wrong attributions from reasoning alone
 * (a bird billboard, an oversize banner, and the bird fix that turned out to be a different
 * defect). Hiding subtrees and re-counting cannot be argued with.
 *
 *   node tools/probe-terrain.mjs --tree --port=5411
 *   node tools/probe-terrain.mjs --bisect=240,0,200,26 --shot=horizon --port=5411
 *   node tools/probe-terrain.mjs --lattice --img=screenshots/newshots/raking.png
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Cameras copied verbatim from tools/shoot.mjs so a finding here transfers to a graded frame. */
const SHOTS = {
  horizon: { x: -420, z: -120, zoom: 0.12, yaw: Math.PI * 0.62, at: 2 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, at: 2 },
  // The combat cameras with `follow` already resolved, copied from tools/probe-perf-ab.mjs
  // so an A/B at one camera and one sim time is exactly repeatable.
  clash: { x: 15, z: -17, zoom: 0.3, yaw: Math.PI * 1.15, at: 72 },
  melee: { x: 15, z: -17, zoom: 0.3, yaw: Math.PI * 1.15, at: 88 },
};

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5411);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const SHOT = args.get('shot') ?? 'horizon';
const MAP = args.get('map') ?? '';
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/work-terr');

// ---------------------------------------------------------------------------
// --lattice: no browser needed, it reads a PNG.
// ---------------------------------------------------------------------------
if (args.has('lattice')) {
  const file = path.resolve(ROOT, args.get('img') ?? 'screenshots/newshots/raking.png');
  // A square crop of open ground. Defaults chosen on raking.png: the lower-right quadrant
  // is all sward with no men and no shadow edge in it.
  const box = (args.get('box') ?? '900,560,512,512').split(',').map(Number);
  const { data, info } = await sharp(file)
    .extract({ left: box[0], top: box[1], width: box[2], height: box[3] })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const N = info.width;
  const g = new Float64Array(N * N);
  let mean = 0;
  for (let i = 0; i < N * N; i++) { g[i] = data[i] / 255; mean += g[i]; }
  mean /= N * N;
  // Hann window, or the crop's own edges dominate the spectrum with a sinc pattern.
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) g[y * N + x] = (g[y * N + x] - mean) * win[x] * win[y];

  // Naive DFT over a reduced frequency set: we only care about periods of 2..64 px, and a
  // full FFT is not worth writing for a one-off diagnostic.
  const KMAX = 64;
  const power = [];
  for (let ky = -KMAX; ky <= KMAX; ky++) {
    for (let kx = 0; kx <= KMAX; kx++) {
      if (kx === 0 && ky <= 0) continue;
      let re = 0, im = 0;
      // Stride the image: sampling every 2nd pixel is exact enough for periods > 4 px and
      // makes the double loop tractable.
      for (let y = 0; y < N; y += 2) {
        for (let x = 0; x < N; x += 2) {
          const ph = (-2 * Math.PI * (kx * x + ky * y)) / N;
          const v = g[y * N + x];
          re += v * Math.cos(ph); im += v * Math.sin(ph);
        }
      }
      power.push({ kx, ky, p: re * re + im * im, period: N / Math.hypot(kx, ky) });
    }
  }
  const total = power.reduce((a, b) => a + b.p, 0);
  power.sort((a, b) => b.p - a.p);
  console.log(`lattice spectrum of ${path.basename(file)} box=${box.join(',')} (${N}x${N})`);
  console.log(`  strongest 12 spatial frequencies (period in px, share of band power):`);
  for (const t of power.slice(0, 12)) {
    console.log(`    k=(${String(t.kx).padStart(3)},${String(t.ky).padStart(4)})  period ${t.period.toFixed(1).padStart(6)} px  ${((t.p / total) * 100).toFixed(2)}%`);
  }
  // The number that matters: how much of the band sits in the top few bins. A broad
  // spectrum (real texture) spreads power; a lattice concentrates it.
  const top8 = power.slice(0, 8).reduce((a, b) => a + b.p, 0) / total;
  const top32 = power.slice(0, 32).reduce((a, b) => a + b.p, 0) / total;
  console.log(`  concentration: top-8 bins ${(top8 * 100).toFixed(1)}% of band power, top-32 ${(top32 * 100).toFixed(1)}%`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --diff=A,B : mean absolute difference between two renders, in 0-255 units.
//
// The number to compare it against is a *same-code control*: render the same shot twice
// from one unchanged tree and diff those. `shoot.mjs` is not pixel-repeatable on crowd
// frames — soldier appearance drifts per rendered frame even at frozen sim time — so a
// diff is only evidence of a change if it clears that floor. Measured floors on this tree:
// terrain 1.20/255, wall 1.65/255, and `horizon` is unusable at 37.8 % of pixels because
// the sward is wind-animated.
// ---------------------------------------------------------------------------
if (args.has('diff')) {
  const [fa, fb] = String(args.get('diff')).split(',');
  const A = await sharp(path.resolve(ROOT, fa)).raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(path.resolve(ROOT, fb)).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = A.info;
  let sum = 0, over = 0;
  for (let i = 0; i < width * height; i++) {
    const d = Math.abs(A.data[i * channels] - B.data[i * channels])
      + Math.abs(A.data[i * channels + 1] - B.data[i * channels + 1])
      + Math.abs(A.data[i * channels + 2] - B.data[i * channels + 2]);
    sum += d / 3;
    if (d > 12) over++;
  }
  console.log(`${fa} vs ${fb}: meanAbsDiff ${(sum / (width * height)).toFixed(2)}/255, `
    + `${over} px over 12/765 (${((over / (width * height)) * 100).toFixed(2)}%)`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --place: reproduce GrassField's vertex-shader instance placement in float32 and measure
// whether the resulting point set is a lattice. The shader's placement is pure arithmetic
// on the cell index, so it can be evaluated offline exactly, and that is a far cleaner
// measurement than a perspective screenshot: no camera, no foreshortening, no mip bias.
//
// Reports the structure factor at the first Bragg peak of the lattice (which is what "you
// can count the rows" means quantitatively) and the nearest-neighbour distance histogram.
// ---------------------------------------------------------------------------
if (args.has('place')) {
  const f = Math.fround;
  const spacing = Number(args.get('spacing') ?? 0.335);
  const jitter = Number(args.get('jitter') ?? 1.9);
  const keepFrac = Number(args.get('keep') ?? 1);
  const N = Number(args.get('n') ?? 96);
  const mode = args.get('mode') ?? 'current';

  const fr = (v) => f(v - Math.floor(v));
  /** hash12 (Dave Hoskins), in float32, exactly as `grassHash` in GrassField.ts. */
  const hash12 = (x, y) => {
    const ax = fr(f(f(x) * 0.1031)), ay = fr(f(f(y) * 0.1031));
    // p3 = (ax, ay, ax) — the source writes vec3(p.xyx) times a *scalar*, so p3.x == p3.z.
    const d = f(f(ax * f(ay + 33.33)) + f(ay * f(ax + 33.33)) + f(ax * f(ax + 33.33)));
    return fr(f(f(f(ax + d) + f(ay + d)) * f(ax + d)));
  };
  /** The sin hash the ground shader already uses for the field lattice (`fieldHash`). */
  const hashSin = (x, y) => fr(f(Math.sin(f(f(x) * 127.1 + f(y) * 311.7)) * 43758.5453));
  /**
   * hash13 over a 3-vector with three *distinct* multipliers, so no two components of the
   * permuted vector are equal. This is the difference from hash12: with a scalar multiplier
   * p3.x and p3.z are identical and the permute has one fewer degree of freedom.
   */
  const hash13 = (x, y, z) => {
    let ax = fr(f(f(x) * 0.1031)), ay = fr(f(f(y) * 0.1030)), az = fr(f(f(z) * 0.0973));
    const d = f(f(ax * f(ay + 33.33)) + f(ay * f(az + 33.33)) + f(az * f(ax + 33.33)));
    ax = f(ax + d); ay = f(ay + d); az = f(az + d);
    return fr(f(f(ax + ay) * az));
  };
  const HASHES = {
    hash12: (x, y) => hash12(x, y),
    sin: (x, y) => hashSin(x, y),
    hash13: (x, y) => hash13(x, y, f(x + y) * 0.37),
  };
  const hash = HASHES[args.get('hash') ?? 'hash12'] ?? HASHES.hash12;

  const pts = [];
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const cx = f(gx * spacing), cz = f(gz * spacing);
      const h1 = hash(gx, gz);
      const h2 = hash(f(gx + 37.1), f(gz + 11.7));
      const h3 = hash(f(gx + 5.3), f(gz + 91.2));
      if (h3 > keepFrac) continue;
      let ox, oz;
      if (mode === 'current') {
        ox = (h1 - 0.5) * spacing * jitter;
        oz = (h2 - 0.5) * spacing * jitter;
      } else {
        // Polar jitter: a hash-chosen bearing and radius, so the displacement is not the
        // product of two independent axis-aligned uniforms (which leaves the lattice
        // axes as the two directions of maximum correlation).
        const ang = h1 * Math.PI * 2;
        const rad = Math.sqrt(h2) * spacing * jitter * 0.5;
        ox = Math.cos(ang) * rad;
        oz = Math.sin(ang) * rad;
      }
      pts.push([cx + ox, cz + oz]);
    }
  }

  // Structure factor at the lattice's own reciprocal vectors, and at a control direction
  // that is not a lattice vector. 1.0 = a perfect lattice, ~1/N = a Poisson point set.
  const S = (kx, kz) => {
    let re = 0, im = 0;
    for (const [x, z] of pts) { const ph = kx * x + kz * z; re += Math.cos(ph); im += Math.sin(ph); }
    return (re * re + im * im) / pts.length;
  };
  const g = (2 * Math.PI) / spacing;
  console.log(`placement: ${mode}  spacing=${spacing} jitter=${jitter} keep=${keepFrac}  ${pts.length} points over ${(N * spacing).toFixed(1)} m square`);
  console.log(`  S(1,0)  = ${S(g, 0).toFixed(2)}      first Bragg peak along x`);
  console.log(`  S(0,1)  = ${S(0, g).toFixed(2)}      first Bragg peak along z`);
  console.log(`  S(1,1)  = ${S(g, g).toFixed(2)}      diagonal`);
  console.log(`  S(2,0)  = ${S(2 * g, 0).toFixed(2)}      second order along x`);
  console.log(`  S(0.37) = ${S(g * 0.37, g * 0.63).toFixed(2)}      control: not a lattice vector`);
  // Nearest-neighbour distance: a lattice has a tight spike at `spacing`, a random set a
  // broad Rayleigh-like distribution.
  const nn = [];
  const step = Math.max(1, Math.floor(pts.length / 4000));
  for (let i = 0; i < pts.length; i += step) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1];
      if (Math.abs(dx) > 1.5 || Math.abs(dz) > 1.5) continue;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    if (best < Infinity) nn.push(Math.sqrt(best));
  }
  nn.sort((a, b) => a - b);
  const q = (p) => nn[Math.min(nn.length - 1, Math.floor(p * nn.length))];
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  const sd = Math.sqrt(nn.reduce((a, b) => a + (b - mean) ** 2, 0) / nn.length);
  console.log(`  nearest neighbour: mean ${mean.toFixed(3)} m  sd ${sd.toFixed(3)}  cv ${(sd / mean).toFixed(3)}`
    + `  p05 ${q(0.05).toFixed(3)}  p50 ${q(0.5).toFixed(3)}  p95 ${q(0.95).toFixed(3)}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Browser-backed modes
// ---------------------------------------------------------------------------
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const mapArg = MAP ? `&map=${MAP}` : '';
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}${mapArg}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
await mkdir(OUT, { recursive: true });

const shot = SHOTS[SHOT] ?? SHOTS.horizon;
await page.evaluate(async (s) => {
  const g = window.__game;
  const STEP = 0.5;
  while (g.simTime() < s.at - 1e-6) g.advance(Math.min(STEP, s.at - g.simTime()));
  g.setCamera(s.x, s.z, s.zoom, s.yaw);
  g.advance(0.25);
}, shot);

if (args.has('tree')) {
  const tree = await page.evaluate(() => {
    const out = [];
    // three is not exposed on window, so the world bbox is accumulated by hand: every
    // Object3D carries a Vector3 in `.position`, which is enough to borrow the class from.
    const scratch = window.__game.engine.context.scene.position.clone();
    const worldBox = (root) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      root.updateWorldMatrix(true, true);
      root.traverse((m) => {
        const geo = m.geometry;
        if (!geo) return;
        if (!geo.boundingBox) { try { geo.computeBoundingBox(); } catch { return; } }
        const bb = geo.boundingBox;
        if (!bb || !Number.isFinite(bb.min.x)) return;
        for (let c = 0; c < 8; c++) {
          scratch.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z);
          scratch.applyMatrix4(m.matrixWorld);
          const v = [scratch.x, scratch.y, scratch.z];
          for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
        }
      });
      return Number.isFinite(lo[0]) ? [...lo, ...hi].map((v) => +v.toFixed(1)) : null;
    };
    const walk = (o, depth) => {
      let bb = null;
      try { bb = worldBox(o); } catch { /* some custom geometry has no computable bbox */ }
      out.push({
        depth,
        name: o.name || '(unnamed)',
        type: o.type,
        visible: o.visible,
        children: o.children.length,
        mat: o.material ? (Array.isArray(o.material) ? 'multi' : o.material.type + (o.material.name ? `:${o.material.name}` : '')) : '',
        bb,
      });
      if (depth < 2) for (const c of o.children) walk(c, depth + 1);
    };
    for (const c of window.__game.engine.context.scene.children) walk(c, 0);
    return out;
  });
  for (const n of tree) {
    console.log(`${'  '.repeat(n.depth)}${n.name.padEnd(30 - n.depth * 2)} ${n.type.padEnd(16)} vis=${n.visible ? 'Y' : 'n'} ch=${String(n.children).padStart(4)} ${n.mat.padEnd(24)} ${n.bb ? `bb=[${n.bb.join(' ')}]` : ''}`);
  }
}

if (args.has('bisect')) {
  const [bx, by, bw, bh] = String(args.get('bisect')).split(',').map(Number);
  const thresh = Number(args.get('thresh') ?? 0.35);

  /** Count pixels darker than `thresh` inside the box — the artifact's own signature. */
  const countDark = async (label) => {
    const buf = await page.screenshot({ type: 'png', clip: { x: bx, y: by, width: bw, height: bh } });
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let n = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      const r = data[i * info.channels] / 255, g = data[i * info.channels + 1] / 255, b = data[i * info.channels + 2] / 255;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < thresh) { n++; sr += r; sg += g; sb += b; }
    }
    if (args.has('save')) await writeFile(path.join(OUT, `bisect-${label.replace(/[^\w.-]+/g, '_')}.png`), buf);
    return { n, rgb: n ? [sr / n, sg / n, sb / n].map((v) => Math.round(v * 255)) : null };
  };

  const baseline = await countDark('baseline');
  console.log(`baseline dark pixels in box ${bx},${by} ${bw}x${bh}: ${baseline.n}  mean rgb=${baseline.rgb}\n`);
  if (!baseline.n) {
    console.log('nothing dark in the box — wrong camera, wrong box, or the artifact is gone.');
  }

  /** Resolve a node by an index path from the scene root, e.g. [12, 3]. */
  const setHidden = (pathArr) => page.evaluate((p) => {
    let o = window.__game.engine.context.scene;
    for (const i of p) o = o.children[i];
    o.userData.__probeVis ??= o.visible;
    o.visible = false;
    window.__game.engine.advance(1 / 60);
  }, pathArr);
  const setShown = (pathArr) => page.evaluate((p) => {
    let o = window.__game.engine.context.scene;
    for (const i of p) o = o.children[i];
    if (o.userData.__probeVis !== undefined) o.visible = o.userData.__probeVis;
    window.__game.engine.advance(1 / 60);
  }, pathArr);
  const childrenOf = (pathArr) => page.evaluate((p) => {
    let o = window.__game.engine.context.scene;
    for (const i of p) o = o.children[i];
    return o.children.map((c, i) => ({ i, label: `${c.name || c.type}`, visible: c.visible, kids: c.children.length }));
  }, pathArr);

  const owners = [];
  /** Recursive: hide each child in turn, and drill into whichever one empties the box. */
  const descend = async (pathArr, depth, ref) => {
    const kids = await childrenOf(pathArr);
    for (const k of kids) {
      if (!k.visible) continue;               // already invisible; cannot be the culprit
      await setHidden([...pathArr, k.i]);
      const r = await countDark(`${pathArr.join('.')}.${k.i}-${k.label}`);
      await setShown([...pathArr, k.i]);
      const drop = ref ? ((ref - r.n) / ref) * 100 : 0;
      if (drop > 2) {
        console.log(`${'  '.repeat(depth)}hide ${k.label.padEnd(30 - depth * 2)} dark=${String(r.n).padStart(6)}  -${drop.toFixed(1)}%${drop > 85 ? '   <<== OWNER' : ''}`);
      }
      if (drop > 85) {
        owners.push({ path: [...pathArr, k.i], label: k.label, remaining: r.n });
        if (k.kids && depth < 3) await descend([...pathArr, k.i], depth + 1, ref);
      }
    }
  };
  await descend([], 0, baseline.n);

  if (!owners.length) console.log('No single subtree accounts for the box. It may be the sky material itself, or post-processing.');
  else console.log(`\nowner chain: ${owners.map((o) => o.label).join(' > ')}`);
  await writeFile(path.join(OUT, 'bisect.json'), JSON.stringify({ shot: SHOT, box: [bx, by, bw, bh], baseline, owners }, null, 2));
}

// --project=NAME --box=x,y,w,h : project a named mesh's vertices to screen and report the
// ones landing inside the box, with their world position and distance from the camera. This
// turns "something dark is up there" into "that triangle, at that range".
if (args.has('project')) {
  const want = String(args.get('project'));
  const [bx, by, bw, bh] = String(args.get('box') ?? '245,0,180,24').split(',').map(Number);
  const hits = await page.evaluate(({ want, bx, by, bw, bh, W, H }) => {
    const ctx = window.__game.engine.context;
    const cam = ctx.camera;
    cam.updateMatrixWorld(true);
    const out = [];
    ctx.scene.traverse((m) => {
      if (!m.geometry || !m.name || !m.name.includes(want)) return;
      if (!m.visible) return;
      const pos = m.geometry.attributes.position;
      if (!pos) return;
      const v = m.position.clone();
      const camPos = cam.position;
      let n = 0;
      for (let i = 0; i < pos.count && n < 400; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
        const wx = v.x, wy = v.y, wz = v.z;
        const p = v.clone().project(cam);
        const sx = (p.x * 0.5 + 0.5) * W;
        const sy = (1 - (p.y * 0.5 + 0.5)) * H;
        if (p.z < -1 || p.z > 1) continue;
        if (sx >= bx && sx < bx + bw && sy >= by && sy < by + bh) {
          out.push({
            mesh: m.name, i,
            world: [+wx.toFixed(1), +wy.toFixed(1), +wz.toFixed(1)],
            screen: [Math.round(sx), Math.round(sy)],
            dist: +Math.hypot(wx - camPos.x, wy - camPos.y, wz - camPos.z).toFixed(1),
          });
          n++;
        }
      }
    });
    return { cam: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)], fov: cam.fov, far: cam.far, out };
  }, { want, bx, by, bw, bh, W, H });
  console.log(`camera at ${hits.cam.join(', ')}  fov=${hits.fov}  far=${hits.far}`);
  console.log(`vertices of "*${want}*" landing inside ${bx},${by} ${bw}x${bh}: ${hits.out.length}`);
  const byDist = new Map();
  for (const h of hits.out) {
    const key = Math.round(h.dist / 100) * 100;
    byDist.set(key, (byDist.get(key) ?? 0) + 1);
  }
  console.log('  distance histogram (100 m bins):', [...byDist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}m:${c}`).join(' '));
  for (const h of hits.out.slice(0, 24)) {
    console.log(`   ${h.mesh} v${h.i}  world=(${h.world.join(', ')})  screen=(${h.screen.join(',')})  d=${h.dist}m`);
  }
}

// --verts=NAME : histogram a mesh's vertices by radius from the world origin and by
// distance from the camera. A ring authored at three fixed radii should show exactly three
// spikes; anything else in the distribution is stray geometry.
if (args.has('verts')) {
  const r = await page.evaluate((want) => {
    const ctx = window.__game.engine.context;
    const cam = ctx.camera;
    cam.updateMatrixWorld(true);
    const res = [];
    ctx.scene.traverse((m) => {
      if (!m.geometry || !m.name || !m.name.includes(want)) return;
      const pos = m.geometry.attributes.position;
      if (!pos) return;
      const v = m.position.clone();
      const radH = new Map();
      const distH = new Map();
      let minDist = Infinity, minV = null, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
        const rad = Math.round(Math.hypot(v.x, v.z) / 50) * 50;
        radH.set(rad, (radH.get(rad) ?? 0) + 1);
        const d = v.distanceTo(cam.position);
        const db = Math.round(d / 100) * 100;
        distH.set(db, (distH.get(db) ?? 0) + 1);
        if (d < minDist) { minDist = d; minV = [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]; }
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
      res.push({
        mesh: m.name, verts: pos.count, visible: m.visible,
        radii: [...radH.entries()].sort((a, b) => a[0] - b[0]),
        dists: [...distH.entries()].sort((a, b) => a[0] - b[0]).slice(0, 14),
        minDist: +minDist.toFixed(1), minV, yRange: [+minY.toFixed(1), +maxY.toFixed(1)],
      });
    });
    return { cam: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)], res };
  }, String(args.get('verts')));
  console.log(`camera ${r.cam.join(', ')}`);
  for (const m of r.res) {
    console.log(`\n${m.mesh}  ${m.verts} verts  vis=${m.visible}  y ${m.yRange[0]}..${m.yRange[1]}  nearest vertex ${m.minDist} m at (${m.minV?.join(', ')})`);
    console.log(`  radius from origin (50 m bins): ${m.radii.map(([k, c]) => `${k}:${c}`).join(' ')}`);
    console.log(`  distance from camera (100 m bins, nearest 14): ${m.dists.map(([k, c]) => `${k}:${c}`).join(' ')}`);
  }
}

if (args.has('only')) {
  // Hide every scene-root child whose name does not match, so one system can be looked at
  // against the sky on its own.
  const kept = await page.evaluate((want) => {
    const sc = window.__game.engine.context.scene;
    const keep = [];
    for (const c of sc.children) {
      if (c.type.endsWith('Light') || c.name === 'sky') { keep.push(c.name || c.type); continue; }
      if (c.name && c.name.includes(want)) { keep.push(c.name); continue; }
      // `city` holds far-hills among 57 other chunks: descend and keep only the match.
      if (c.children.length) {
        let any = false;
        for (const g of c.children) {
          if (g.name && g.name.includes(want)) { any = true; keep.push(g.name); } else g.visible = false;
        }
        if (any) continue;
      }
      c.visible = false;
    }
    window.__game.engine.advance(1 / 60);
    return keep;
  }, String(args.get('only')));
  console.log(`kept: ${kept.join(', ')}`);
}

// --eval='<js>' : run a snippet in the page before grabbing, so a single knob can be
// isolated (postfx off, sun moved, a uniform zeroed) without editing a shipping file.
// --ground=x,y[;x,y...] : where does a screen pixel land on the terrain, and how many
// metres does one pixel cover there? Needed to say whether a pattern seen in a frame has
// the period of the 0.335 m grass lattice, the 6.5 m cover noise or the 94 m field grid.
if (args.has('ground')) {
  const pts = String(args.get('ground')).split(';').map((s) => s.split(',').map(Number));
  const out = await page.evaluate(({ pts, W, H }) => {
    const ctx = window.__game.engine.context;
    const cam = ctx.camera;
    const terrain = ctx.tryGet('terrain');
    cam.updateMatrixWorld(true);
    const v = cam.position.clone();
    const org = cam.position.clone();
    /** March a screen ray against `heightAt` until it crosses the ground. */
    const hit = (sx, sy) => {
      v.set((sx / W) * 2 - 1, -((sy / H) * 2 - 1), 0.5).unproject(cam).sub(org).normalize();
      let t = 1, prev = org.y - terrain.heightAt(org.x, org.z);
      for (let i = 0; i < 4000; i++) {
        const px = org.x + v.x * t, py = org.y + v.y * t, pz = org.z + v.z * t;
        const d = py - terrain.heightAt(px, pz);
        if (d <= 0 && prev > 0) {
          return { x: +px.toFixed(2), y: +py.toFixed(2), z: +pz.toFixed(2), t: +t.toFixed(1) };
        }
        prev = d;
        t += Math.max(0.25, t * 0.01);
        if (t > 4000) break;
      }
      return null;
    };
    return pts.map(([sx, sy]) => {
      const a = hit(sx, sy);
      const b = hit(sx + 20, sy);
      const c = hit(sx, sy + 20);
      return {
        px: [sx, sy], world: a,
        mPerPxX: a && b ? +(Math.hypot(b.x - a.x, b.z - a.z) / 20).toFixed(4) : null,
        mPerPxY: a && c ? +(Math.hypot(c.x - a.x, c.z - a.z) / 20).toFixed(4) : null,
      };
    });
  }, { pts, W, H });
  for (const o of out) {
    console.log(`px(${o.px.join(',')}) -> world(${o.world ? `${o.world.x}, ${o.world.y}, ${o.world.z}` : 'miss'})  range ${o.world?.t}m  ${o.mPerPxX} m/px across, ${o.mPerPxY} m/px down`);
  }
}

if (args.has('eval')) {
  const r = await page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('g', 'ctx', src);
    const ctx = window.__game.engine.context;
    const out = f(window.__game, ctx);
    window.__game.engine.advance(1 / 60);
    return out === undefined ? 'ok' : String(out);
  }, String(args.get('eval')));
  console.log(`eval -> ${r}`);
}

// --frames=N : run shoot.mjs's own timing loop verbatim before grabbing. shoot.mjs measures
// frame cost with `engine.frame(engine.time.elapsed * 1000 + 16.7)` N times; if that loop
// leaves the post chain's reprojection state inconsistent with the camera, the graded frame
// carries an artifact the running game does not. Reproducing the loop is the only way to
// tell a scene defect from a harness defect.
if (args.has('frames')) {
  const n = Number(args.get('frames'));
  const info = await page.evaluate((N) => {
    const g = window.__game;
    const gl = g.engine.renderer.getContext();
    const px = new Uint8Array(4);
    g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { ms: (performance.now() - t0) / N, frameDt: g.engine.time.frameDt };
  }, n);
  console.log(`frames=${n}  ${info.ms.toFixed(2)} ms/frame  time.frameDt=${info.frameDt}`);
}

if (args.has('grab')) {
  const file = path.join(OUT, `${args.get('grab') === 'true' ? SHOT : args.get('grab')}.png`);
  await page.screenshot({ path: file, type: 'png' });
  console.log(`→ ${file}`);
}

if (errs.length) console.error(`\npage errors:\n  ${[...new Set(errs)].join('\n  ')}`);
await browser.close();
if (server) server.kill('SIGTERM');
