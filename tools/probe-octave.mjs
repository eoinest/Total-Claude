#!/usr/bin/env node
/**
 * Octave band-energy on figure pixels — the soldier-fidelity separator, and a ruler for
 * closing it.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the isolated-model deck the two pools are indistinguishable at coarse scale: at 4, 8 and
 * 16 px our plates and the Rome II press crops score at chance. The entire separation is a
 * *shape* statistic of the finest two octaves — our figures carry far more energy at 1 px than
 * at 2 px, and the reference figures do not. So the number to move is
 *
 *     R = E1 / E2      (RMS energy of the 1 px band over the RMS energy of the 2 px band)
 *
 * and the trap, recorded twice in this project by two independent instruments, is that **R can
 * be moved through the whole gap by blurring**, which makes the model worse. A Gaussian of
 * sigma 0.7 px does it on its own (`--selftest` proves it here rather than asserting it).
 *
 * That is why this tool never prints R alone. It prints the **absolute** band energies beside
 * it, so a fall in R caused by *losing* 1 px energy can be told apart from a fall caused by
 * *gaining* 2-8 px energy. A change that lowers R while E2 and E4 also fall is a blur and must
 * be rejected; a change that lowers R while E2 and E4 rise is real added mid-band structure —
 * normal maps, roughness variation, wear, cavity, grime. **That distinction is the whole point
 * of this instrument**, and it is the one property `--selftest` is built to guarantee.
 *
 * WHAT IS MEASURED, AND ON WHICH PIXELS
 * -------------------------------------
 * 1. **Working resolution: 900x1200 for both pools.** That is the reference crops' native size
 *    and the logical (CSS) size `shoot-model.mjs` is told to shoot; our plates come off the
 *    harness at dpr 2, i.e. 1800x2400, and are resampled *down* by exactly two with lanczos3.
 *    Only ours is resampled, and only downward, because upsampling the press crops would invent
 *    no detail while destroying the meaning of "the 1 px band" for the pool we are chasing. It
 *    also keeps the reference numbers *fixed* across every A/B, which is what a baseline is for.
 *    Measured cost of that downsample, with this tool at `--size=1800x2400`: our pooled median R
 *    is 1.620 native against 1.464 here, so the resample costs 9.6% of the median and moves
 *    individual plates both ways (-20% to +12%; "1 px" is a different physical size on the
 *    figure at each resolution, so per-plate comparison across the two is not like for like).
 *    The remaining gap to the reference pool is 15 times that 9.6%, so the resample does not
 *    manufacture the separation.
 *    **Resolution normalisation is load-bearing, not hygiene**: measured at each pool's own
 *    native size instead, the two pools *overlap* (see the note at the bottom of this comment).
 *
 * 2. **Luminance transform: Rec.709 luma of the sRGB-encoded bytes, 0..1. Identical for both
 *    pools.** Deliberately not linearised: both pools are display-referred (a tone-mapped
 *    render and a press JPEG), our backdrop is far darker than the crops' mid-key background,
 *    and linearising would reweight the two pools' shadows differently. `probe-harshness.mjs`
 *    uses the same transform, so the two instruments stay comparable.
 *
 * 3. **The figure mask.** Both pools get the *same* rule where a same rule is possible, and the
 *    place they cannot is stated rather than hidden:
 *
 *      - **Both pools**: intersect with one centred elliptical subject window (default axes
 *        0.72 W x 0.84 H, 47.5% of frame). The reference crops are composed with the subject
 *        centred and filling the frame, and our plates are framed by `fill`, so a centred window
 *        is a defensible subject selector for both. It is a fixed constant, not fitted to either
 *        pool, so nothing we change to our models can move the reference numbers.
 *
 *      - **Ours only**: flood-fill the neutral backdrop from the four corners with a local
 *        luminance-step tolerance (default 0.006, against a measured backdrop step of p99
 *        0.005-0.007), then **erode the resulting figure mask by 4 px** so the silhouette — the
 *        largest 1 px step in the frame — contributes to nothing.
 *
 *        **The Rome II crops get no equivalent, because they have no flat backdrop to remove.**
 *        They are cut out of a battle: the pixels around the subject are other soldiers, terrain
 *        and haze, all of it real content at every scale. There is no honest way to matte a
 *        press plate, so the reference window necessarily contains some non-subject content.
 *        This is the instrument's largest open bias and it runs *against* the reference — that
 *        background is softer than a subject, so it drags the reference E1 and E2 down together
 *        and its effect on a *ratio* is second-order. Coverage % is printed per image so a
 *        reader can see for themselves how comparable the two pools' masks are.
 *
 *        `--mask=smooth` swaps the corner flood for a border-seeded, gradient-gated flood that
 *        also removes backdrop regions the four corners cannot reach (the close-up plates cut
 *        the ground into islands, and the corner rule scores those islands as figure — see
 *        juth-head and praet-torso, whose coverage falls from 47/42% to 38/16% under the other
 *        rule). It is not the default because it can eat a smooth, frame-touching part of the
 *        figure, which it does to juth-head's chin. It is here so the mask sensitivity is
 *        *checkable rather than asserted*: measured across the ten baseline plates the two
 *        rules move R by at most 6.0% on any plate and 2.5% on the pooled median, always in
 *        the same direction, and **the two pools fail to overlap under either rule**. The mask
 *        is not what this measurement rests on.
 *
 * 4. **The octave decomposition.** Difference-of-Gaussians on the luma, at the working
 *    resolution, computed on the *whole* image and only then restricted to the mask — masking
 *    before blurring would manufacture an edge at the silhouette:
 *
 *      E1 = RMS( I          - G(1)*I )      everything finer than ~1 px
 *      E2 = RMS( G(1)*I     - G(2)*I )
 *      E4 = RMS( G(2)*I     - G(4)*I )
 *      E8 = RMS( G(4)*I     - G(8)*I )
 *      E16= RMS( G(8)*I     - G(16)*I )
 *
 *    printed x1000, kernels truncated at 3.5 sigma. Note that E4, E8 and E16 have a support
 *    far wider than the 4 px erosion, so at those bands the figure pixels near the silhouette
 *    are contaminated by the backdrop; read them as indicative. The two the separator is
 *    actually built from are nearly clean: G(1) reaches 4 px, entirely inside the erosion, and
 *    G(2) reaches 7, so only a 3 px fringe of E2 sees any backdrop at all.
 *
 * WHAT THE ABSOLUTE ENERGIES DO AND DO NOT LICENCE
 * ------------------------------------------------
 * E2 and E4 are trustworthy for **within-pool A/B** — same content, same framing, same
 * exposure, so a rise is a real gain in mid-band structure. Across the two pools they are
 * confounded by content and key (our lit figure on a plain ground against a crop that is half
 * soft background), so "our E2 must climb to the reference's E2" is *not* what these numbers
 * say. Read the ratio across pools and the absolutes within one.
 *
 * THE REPRODUCIBILITY FLOOR — MEASURED, NOT ASSUMED
 * --------------------------------------------------
 * Trap 6 says cross-session A/B is invalid for *battle* frames because the VFX reseed. The
 * isolated viewer is a different instrument and `--repro` measures it rather than assuming
 * either way. Three shoots of a byte-identical tree (61cda1b plus one unstaged diff, verified
 * unchanged across all three by hashing `git diff HEAD -- src/` before and after each):
 *
 *   **|dR| worst 0.58% on any plate, 0.24% between the two shoots that shared a dev server.
 *   Pooled median R moves 0.11-0.30%.**
 *
 * So cross-session A/B *is* valid on this deck, comfortably inside a 2% bar. Two secondary
 * results worth having, both measured here rather than reasoned about:
 *
 *   - A **cold `vite`** start costs almost nothing: the shoot that had to start its own server
 *     reads 0.58% worst-case against the two that reused a warm one, which read 0.24% against
 *     each other. No run is bit-identical to another, but what differs is far below anything
 *     worth grading.
 *   - The floor is small enough to be *useful*. Across the concurrent commit 61cda1b ("every
 *     closed ring ran one column of its texture backwards") the same ten plates moved **6-11%
 *     on exactly the four whose kit carries closed-ring geometry** and under 1% on the other
 *     six — 25 to 45 times the noise floor, on the right four plates. That is the instrument
 *     resolving a real single-commit geometry fix, which is the job.
 *
 * One provenance gap you must close by hand: `report.json` records the **commit** and not the
 * working tree, and this workstream runs agents editing `src/` concurrently. Two decks recorded
 * at the same commit can be different trees. Hash the diff, or shoot both arms back to back.
 *
 * PROVENANCE
 * ----------
 * The same gate as `model-deck.mjs`: an `--ours` directory with no `report.json`, or one that
 * does not say `hud: false`, is refused with exit 3. Missing is refused as firmly as true.
 *
 * A NOTE ON THE ROUND-ONE NUMBERS — THEY ARE ON A DIFFERENT SCALE
 * ---------------------------------------------------------------
 * Round one recorded ours 2.01-3.61 against Rome II 1.20-1.35 and a target of 1.4. That script
 * is not in the tree and **those constants do not transfer to this one.** Normalised as above,
 * this tool reads the same separation with the same sign and the same coarse-scale convergence,
 * on a scale roughly half as large. The likeliest reason is resolution: measured at each pool's
 * own native size (ours 1800x2400, the crops at their source-box size of 285x380 to 570x760)
 * the same decomposition reads ours 1.29-2.13 against Rome II 0.87-2.15 (a scratch check, since
 * this tool cannot re-cut the crops) — closer to the round-one figures, and **overlapping**,
 * which is exactly the failure mode normalising is there to prevent.
 * Use the reference pool measured *by this tool* as the target, not the old constant. In these
 * units the reference pool is R 0.520-0.621, median 0.597, and ours is 1.199-1.890.
 *
 * USAGE
 * -----
 *   node tools/probe-octave.mjs --ours=screenshots/sf2-base --ref=reference-crops \
 *        --json=screenshots/sf2-base/octave.json
 *   node tools/probe-octave.mjs --ours=screenshots/sf2-base --repro=screenshots/sf2-base/rep2
 *   node tools/probe-octave.mjs --ours=screenshots/sf2-base --selftest --ref=reference-crops
 *
 * Exit codes: 0 ok, 1 usage or I/O, 2 the instrument failed its own guarantee
 * (`--selftest` blur not caught, or `--repro` above the tolerance), 3 provenance refused.
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const [SW, SH] = (args.get('size') ?? '900x1200').split('x').map(Number);
const TOL = Number(args.get('tol') ?? 0.006);
const GTOL = Number(args.get('gtol') ?? 0.012);
const ERODE = Number(args.get('erode') ?? 4);
const MASK = args.get('mask') ?? 'corners';
const WINDOW = args.get('window') ?? '0.72x0.84';
const SIGMA = Number(args.get('sigma') ?? 0.7);
const REPRO_TOL = Number(args.get('reprotol') ?? 2);
const SIGMAS = [1, 2, 4, 8, 16];

if (!Number.isFinite(SW) || !Number.isFinite(SH) || SW < 64 || SH < 64) {
  console.error(`bad --size=${args.get('size')}`);
  process.exit(1);
}
if (MASK !== 'corners' && MASK !== 'smooth') {
  console.error(`bad --mask=${MASK}; want corners|smooth`);
  process.exit(1);
}

const N = SW * SH;

// ---------------------------------------------------------------------------
// Image maths. Everything below works on a Float64 luma plane of SW x SH.
// ---------------------------------------------------------------------------

/** Rec.709 luma of sRGB bytes, 0..1. The one luminance transform, both pools. */
function luma(data, channels) {
  const L = new Float64Array(N);
  for (let i = 0, p = 0; i < N; i++, p += channels) {
    L[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }
  return L;
}

/** Separable Gaussian, edge-clamped. Radius 3.5 sigma, so the truncation is under 1e-3. */
function gaussian(img, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3.5));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp((-i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const t = new Float64Array(N);
  const o = new Float64Array(N);
  for (let y = 0; y < SH; y++) {
    const row = y * SW;
    for (let x = 0; x < SW; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= SW ? SW - 1 : x + i; a += img[row + xx] * k[i + r]; }
      t[row + x] = a;
    }
  }
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= SH ? SH - 1 : y + i; a += t[yy * SW + x] * k[i + r]; }
      o[y * SW + x] = a;
    }
  }
  return o;
}

/** Central-difference gradient magnitude, for the `smooth` mask's traversal gate. */
function gradMag(L) {
  const g = new Float64Array(N);
  for (let y = 1; y < SH - 1; y++) {
    for (let x = 1; x < SW - 1; x++) {
      const i = y * SW + x;
      g[i] = Math.hypot(L[i + 1] - L[i - 1], L[i + SW] - L[i - SW]);
    }
  }
  return g;
}

/** Chebyshev erosion by r, as two 1-D minimum passes. Off-frame counts as background. */
function erodeMask(m, r) {
  if (r <= 0) return m;
  const t = new Uint8Array(N);
  const o = new Uint8Array(N);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) { const xx = x + d; if (xx < 0 || xx >= SW || !m[y * SW + xx]) { v = 0; break; } }
      t[y * SW + x] = v;
    }
  }
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 1;
      for (let d = -r; d <= r; d++) { const yy = y + d; if (yy < 0 || yy >= SH || !t[yy * SW + x]) { v = 0; break; } }
      o[y * SW + x] = v;
    }
  }
  return o;
}

function dilateMask(m, r) {
  const t = new Uint8Array(N);
  const o = new Uint8Array(N);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < SW && m[y * SW + xx]) { v = 1; break; } }
      t[y * SW + x] = v;
    }
  }
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < SH && t[yy * SW + x]) { v = 1; break; } }
      o[y * SW + x] = v;
    }
  }
  return o;
}

/**
 * Backdrop flood. `seeds` are indices; traversal accepts a neighbour whose luma is within
 * `tol` of the pixel it is reached *from* — a local step rule, not a distance from the seed
 * colour, because the neutral ground carries a vertical gradient and a soft cast shadow that a
 * seed-distance rule would leave behind as false "figure". `gate` (optional) forbids entry to
 * any pixel whose gradient magnitude exceeds it.
 */
function flood(L, seeds, tol, G, gate) {
  const seen = new Uint8Array(N);
  const st = new Int32Array(N);
  let sp = 0;
  for (const s of seeds) if (!seen[s] && (!G || G[s] <= gate)) { seen[s] = 1; st[sp++] = s; }
  while (sp > 0) {
    const i = st[--sp];
    const x = i % SW;
    const y = (i / SW) | 0;
    const v = L[i];
    const step = (j) => {
      if (seen[j]) return;
      if (G && G[j] > gate) return;
      if (Math.abs(L[j] - v) > tol) return;
      seen[j] = 1; st[sp++] = j;
    };
    if (x + 1 < SW) step(i + 1);
    if (x > 0) step(i - 1);
    if (y + 1 < SH) step(i + SW);
    if (y > 0) step(i - SW);
  }
  return seen;
}

/** The centred elliptical subject window, identical for both pools. `--window=none` disables. */
function subjectWindow() {
  if (WINDOW === 'none') return null;
  const [fa, fb] = WINDOW.split('x').map(Number);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) { console.error(`bad --window=${WINDOW}`); process.exit(1); }
  const m = new Uint8Array(N);
  const cx = (SW - 1) / 2;
  const cy = (SH - 1) / 2;
  const a = (fa * SW) / 2;
  const b = (fb * SH) / 2;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const dx = (x - cx) / a;
      const dy = (y - cy) / b;
      if (dx * dx + dy * dy <= 1) m[y * SW + x] = 1;
    }
  }
  return m;
}
const WIN = subjectWindow();

/** Our figure mask: backdrop out, then erode. The reference pool never reaches this. */
function figureMask(L) {
  let bg;
  if (MASK === 'corners') {
    bg = flood(L, [0, SW - 1, (SH - 1) * SW, N - 1], TOL, null, 0);
  } else {
    const G = gradMag(L);
    const seeds = [];
    for (let x = 0; x < SW; x++) { seeds.push(x, (SH - 1) * SW + x); }
    for (let y = 0; y < SH; y++) { seeds.push(y * SW, y * SW + SW - 1); }
    bg = flood(L, seeds, TOL, G, GTOL);
    // Close single-pixel grain holes so they are not scored as figure.
    bg = erodeMask(dilateMask(bg, 2), 2);
  }
  const fig = new Uint8Array(N);
  for (let i = 0; i < N; i++) fig[i] = bg[i] ? 0 : 1;
  return erodeMask(fig, ERODE);
}

function andWindow(m) {
  if (!WIN) return m;
  const o = new Uint8Array(N);
  for (let i = 0; i < N; i++) o[i] = m[i] && WIN[i] ? 1 : 0;
  return o;
}

function coverage(m) {
  let n = 0;
  for (let i = 0; i < N; i++) if (m[i]) n++;
  return n;
}

/** The five octave band energies, RMS over the mask, x1000. */
function bandEnergies(L, mask) {
  const levels = [L];
  for (const s of SIGMAS) levels.push(gaussian(L, s));
  const out = [];
  for (let k = 0; k < SIGMAS.length; k++) {
    const a = levels[k];
    const b = levels[k + 1];
    let acc = 0;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const d = a[i] - b[i];
      acc += d * d; n++;
    }
    out.push(n ? Math.sqrt(acc / n) * 1000 : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Decode to the working resolution. Skips the resampler entirely when already there. */
async function loadLuma(file) {
  const meta = await sharp(file).metadata();
  let pipe = sharp(file).removeAlpha();
  const resampled = meta.width !== SW || meta.height !== SH;
  if (resampled) pipe = pipe.resize(SW, SH, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  return { L: luma(data, info.channels), src: { w: meta.width, h: meta.height }, resampled };
}

function listPngs(dir) {
  if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(1); }
  return fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
}

/** The provenance gate, identical in spirit to model-deck.mjs. */
function provenance(dir) {
  const rec = path.join(dir, 'report.json');
  if (!fs.existsSync(rec)) {
    console.error(`REFUSED: ${path.relative(ROOT, dir)} has no report.json.`);
    console.error('"Nobody wrote it down" is the state that produced leak six. Re-shoot with shoot-model.mjs.');
    process.exit(3);
  }
  const r = JSON.parse(fs.readFileSync(rec, 'utf8'));
  if (r.hud !== false) {
    console.error(`REFUSED: ${path.relative(ROOT, dir)}/report.json says hud=${r.hud}. Missing is refused as firmly as true.`);
    process.exit(3);
  }
  return r;
}

/** HEAD now, so a deck shot against a tree that has since moved says so on its own header. */
function headNow() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** One image -> one row. `pool` picks the mask rule; only `ours` gets the backdrop removed. */
async function measure(file, pool) {
  const { L, src, resampled } = await loadLuma(file);
  const mask = andWindow(pool === 'ours' ? figureMask(L) : (WIN ?? new Uint8Array(N).fill(1)));
  const cov = coverage(mask);
  if (cov < 2000) {
    console.error(`\nFAIL: ${path.basename(file)} masked down to ${cov} px — the mask rule did not find a figure.`);
    process.exit(1);
  }
  const E = bandEnergies(L, mask);
  return {
    name: path.basename(file).replace(/\.(png|jpg|jpeg)$/i, ''),
    pool,
    src: `${src.w}x${src.h}`,
    resampled,
    coverage: +((cov / N) * 100).toFixed(2),
    E1: +E[0].toFixed(3), E2: +E[1].toFixed(3), E4: +E[2].toFixed(3),
    E8: +E[3].toFixed(3), E16: +E[4].toFixed(3),
    R: +(E[0] / E[1]).toFixed(4),
    _mask: mask, _L: L,
  };
}

const med = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const stat = (xs) => ({ min: Math.min(...xs), median: med(xs), max: Math.max(...xs) });

const HEAD = 'image             cov%      E1      E2      E4      E8     E16       R';
function printRow(r) {
  console.log(
    r.name.padEnd(16),
    r.coverage.toFixed(1).padStart(5),
    r.E1.toFixed(2).padStart(7), r.E2.toFixed(2).padStart(7), r.E4.toFixed(2).padStart(7),
    r.E8.toFixed(2).padStart(7), r.E16.toFixed(2).padStart(7),
    r.R.toFixed(3).padStart(7),
  );
}

async function measurePool(dir, pool, label) {
  const files = listPngs(dir);
  if (!files.length) { console.error(`empty pool: ${dir}`); process.exit(1); }
  const rows = [];
  for (const f of files) {
    const r = await measure(path.join(dir, f), pool);
    delete r._mask; delete r._L; // only --selftest needs the planes; 24 of them is 230 MB
    rows.push(r);
  }
  console.log(`\n${label}  (${rows.length} images, ${path.relative(ROOT, dir)}/)`);
  console.log(HEAD);
  for (const r of rows) printRow(r);
  return rows;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const OURS = args.has('ours') ? path.resolve(ROOT, args.get('ours')) : null;
const REF = path.resolve(ROOT, args.get('ref') ?? 'reference-crops');
const JSONOUT = args.get('json');

if (!OURS) {
  console.error('usage: node tools/probe-octave.mjs --ours=<dir> [--ref=<dir>] [--json=<path>] [--repro=<dir>] [--selftest]');
  process.exit(1);
}

const rec = provenance(OURS);
const t0 = Date.now();

const HEAD_NOW = headNow();
console.log('probe-octave — 1/2/4/8/16 px band energy on figure pixels');
console.log(`  ours     ${path.relative(ROOT, OURS)}/   commit ${rec.commit}  dpr ${rec.dpr}  hud ${rec.hud}  shot ${rec.when ?? '?'}`);
if (HEAD_NOW && rec.commit && HEAD_NOW !== rec.commit) {
  console.log(`  NOTE     these plates were shot at ${rec.commit}; HEAD is now ${HEAD_NOW}. They do not photograph this tree.`);
}
console.log(`  working  ${SW}x${SH}  Rec.709 luma of sRGB bytes, both pools`);
console.log(`  mask     ours: ${MASK} flood tol ${TOL}${MASK === 'smooth' ? ` gate ${GTOL}` : ''} + erode ${ERODE} px; both pools: centred ellipse ${WINDOW}`);
console.log(`  bands    DoG at sigma ${SIGMAS.join('/')} px, RMS x1000. R = E1/E2.`);

let exitCode = 0;
const dump = { tool: 'probe-octave.mjs', when: new Date().toISOString(), argv: process.argv.slice(2) };
dump.config = { size: { w: SW, h: SH }, tol: TOL, gtol: GTOL, erode: ERODE, mask: MASK, window: WINDOW, sigmas: SIGMAS };
dump.ours = { dir: path.relative(ROOT, OURS), commit: rec.commit, dpr: rec.dpr, hud: rec.hud, when: rec.when };

if (args.has('selftest')) {
  // ---- The blur trap ------------------------------------------------------
  // Take one of our plates, blur it by sigma px, and re-measure with the mask computed on the
  // ORIGINAL so the only thing that changed is the image. The instrument passes only if it
  // reports R collapsing *and* E2 and E4 falling with it: a tool that saw only R would rate a
  // blur as progress.
  const files = listPngs(OURS);
  const pick = args.get('plate') ?? files.find((f) => f.startsWith('legio-front')) ?? files[0];
  const file = path.join(OURS, pick.endsWith('.png') ? pick : `${pick}.png`);
  if (!fs.existsSync(file)) { console.error(`no such plate: ${file}`); process.exit(1); }

  const before = await measure(file, 'ours');
  const blurred = gaussian(before._L, SIGMA);
  const Eb = bandEnergies(blurred, before._mask);
  const after = {
    name: `${before.name}+blur${SIGMA}`, pool: 'ours', src: before.src, resampled: before.resampled,
    coverage: before.coverage,
    E1: +Eb[0].toFixed(3), E2: +Eb[1].toFixed(3), E4: +Eb[2].toFixed(3),
    E8: +Eb[3].toFixed(3), E16: +Eb[4].toFixed(3), R: +(Eb[0] / Eb[1]).toFixed(4),
  };

  console.log(`\nSELFTEST — Gaussian sigma ${SIGMA} px applied at the working resolution, mask held fixed`);
  console.log(HEAD);
  printRow(before);
  printRow(after);

  const dR = ((after.R - before.R) / before.R) * 100;
  const dE2 = ((after.E2 - before.E2) / before.E2) * 100;
  const dE4 = ((after.E4 - before.E4) / before.E4) * 100;
  const dE1 = ((after.E1 - before.E1) / before.E1) * 100;
  console.log(`\n  delta   R ${dR >= 0 ? '+' : ''}${dR.toFixed(1)}%   E1 ${dE1.toFixed(1)}%   E2 ${dE2.toFixed(1)}%   E4 ${dE4.toFixed(1)}%`);

  let refMed = null;
  if (fs.existsSync(REF)) {
    const refRows = [];
    for (const f of listPngs(REF)) refRows.push(await measure(path.join(REF, f), 'ref'));
    refMed = med(refRows.map((r) => r.R));
    const gap = before.R - refMed;
    console.log(`  reference median R ${refMed.toFixed(3)}; the blur alone closes ${(((before.R - after.R) / gap) * 100).toFixed(0)}% of this plate's gap to it.`);
  }

  const caught = dR < 0 && dE2 < 0 && dE4 < 0;
  if (caught) {
    console.log('\n  PASS — R collapses and E2/E4 collapse with it. A blur cannot be sold to this tool as');
    console.log('         added mid-band structure: real structure raises E2 and E4 while lowering R.');
  } else {
    console.log('\n  FAIL — the blur was not caught. R moved without the absolute energies following it,');
    console.log('         so this instrument can be gamed. Do not grade with it.');
    exitCode = 2;
  }
  dump.selftest = { plate: before.name, sigma: SIGMA, before: strip(before), after, deltaPct: { R: dR, E1: dE1, E2: dE2, E4: dE4 }, refMedianR: refMed, caught };
} else if (args.has('repro')) {
  // ---- The reproducibility floor -----------------------------------------
  // Trap 6 records that cross-session comparison is invalid for battle frames because the VFX
  // reseed. The isolated viewer might be deterministic; this measures it rather than assuming.
  const REP = path.resolve(ROOT, args.get('repro'));
  provenance(REP);
  const a = await measurePool(OURS, 'ours', 'RUN A');
  const b = await measurePool(REP, 'ours', 'RUN B');
  const byName = new Map(b.map((r) => [r.name, r]));
  const common = a.filter((r) => byName.has(r.name));
  if (!common.length) { console.error('the two runs share no plate names'); process.exit(1); }

  console.log('\nREPRODUCIBILITY — same tree, same plate spec, two shoots');
  console.log('plate               R_A     R_B    dR%    E2_A    E2_B   dE2%   dcov%');
  const dRs = [];
  const dE2s = [];
  const rep = [];
  for (const ra of common) {
    const rb = byName.get(ra.name);
    const dR = (Math.abs(rb.R - ra.R) / ((ra.R + rb.R) / 2)) * 100;
    const dE2 = (Math.abs(rb.E2 - ra.E2) / ((ra.E2 + rb.E2) / 2)) * 100;
    const dcov = Math.abs(rb.coverage - ra.coverage);
    dRs.push(dR); dE2s.push(dE2);
    rep.push({ name: ra.name, R_A: ra.R, R_B: rb.R, dRpct: +dR.toFixed(3), dE2pct: +dE2.toFixed(3), dCovPct: +dcov.toFixed(3) });
    console.log(ra.name.padEnd(16), ra.R.toFixed(3).padStart(7), rb.R.toFixed(3).padStart(7), dR.toFixed(2).padStart(6),
      ra.E2.toFixed(2).padStart(7), rb.E2.toFixed(2).padStart(7), dE2.toFixed(2).padStart(6), dcov.toFixed(2).padStart(7));
  }
  const worst = Math.max(...dRs);
  const medR = med(dRs);
  // The per-plate floor and the pooled floor are different numbers and only one of them is
  // usable. A single plate is one draw of whatever is not pinned between shoots; the pool
  // median averages ten of them, so it is the statistic an A/B should be read on.
  const poolA = med(a.map((r) => r.R));
  const poolB = med(b.map((r) => r.R));
  const poolD = (Math.abs(poolB - poolA) / ((poolA + poolB) / 2)) * 100;
  const e2A = med(a.map((r) => r.E2));
  const e2B = med(b.map((r) => r.E2));
  const e2D = (Math.abs(e2B - e2A) / ((e2A + e2B) / 2)) * 100;
  const e4A = med(a.map((r) => r.E4));
  const e4B = med(b.map((r) => r.E4));
  const e4D = (Math.abs(e4B - e4A) / ((e4A + e4B) / 2)) * 100;

  console.log(`\n  per-plate floor: |dR| median ${medR.toFixed(2)}%, worst ${worst.toFixed(2)}%   |dE2| median ${med(dE2s).toFixed(2)}%, worst ${Math.max(...dE2s).toFixed(2)}%`);
  console.log(`  pooled  floor:   median R ${poolA.toFixed(3)} vs ${poolB.toFixed(3)} = ${poolD.toFixed(2)}%   median E2 ${e2D.toFixed(2)}%   median E4 ${e4D.toFixed(2)}%`);
  if (worst <= REPRO_TOL) {
    console.log(`  USABLE — every plate repeats to better than ${REPRO_TOL}%. A between-run change larger than`);
    console.log(`           ${worst.toFixed(2)}% on a plate, or ${poolD.toFixed(2)}% on the pool median, is signal.`);
  } else {
    console.log(`\n  *** PER-PLATE R IS NOT USABLE *** — R moves ${worst.toFixed(2)}% between two shoots of an UNCHANGED`);
    console.log(`      tree, against a tolerance of ${REPRO_TOL}%. The masks are stable to ${Math.max(...rep.map((r) => r.dCovPct)).toFixed(2)}% coverage, so this is`);
    console.log('      the shoot and not the measurement: the plates differ only over the figure, in the pose-');
    console.log('      dependent high-frequency texture, which is a settling or animation-phase leak in the');
    console.log('      viewer rather than VFX reseeding (the backdrop is bit-identical).');
    if (poolD <= REPRO_TOL) {
      console.log(`      **The pooled median IS usable: ${poolD.toFixed(2)}%.** Grade an A/B on the pool median across all`);
      console.log(`      ${common.length} plates, never on one plate, and treat a pooled move under ${Math.max(poolD, 1).toFixed(1)}% as noise.`);
    } else {
      console.log(`      The pooled median is no better (${poolD.toFixed(2)}%). Interleave both arms in one session and`);
      console.log('      report both, per trap 6, or pin the shoot before grading anything.');
    }
    exitCode = 2;
  }
  dump.repro = {
    dirA: path.relative(ROOT, OURS), dirB: path.relative(ROOT, REP), tolerancePct: REPRO_TOL, plates: rep,
    perPlate: { medianDRpct: +medR.toFixed(3), worstDRpct: +worst.toFixed(3), usable: worst <= REPRO_TOL },
    pooled: { R_A: poolA, R_B: poolB, dRpct: +poolD.toFixed(3), dE2pct: +e2D.toFixed(3), dE4pct: +e4D.toFixed(3), usable: poolD <= REPRO_TOL },
  };
} else {
  // ---- The baseline -------------------------------------------------------
  const ours = await measurePool(OURS, 'ours', 'OURS');
  const refs = await measurePool(REF, 'ref', 'ROME II CROPS');

  const oR = stat(ours.map((r) => r.R));
  const rR = stat(refs.map((r) => r.R));
  const overlap = oR.min <= rR.max && rR.min <= oR.max;

  console.log('\nPOOLED');
  console.log('pool        n   R min   R med   R max    E1 med   E2 med   E4 med   E8 med  E16 med   cov med');
  for (const [label, rows] of [['ours', ours], ['rome2', refs]]) {
    const s = stat(rows.map((r) => r.R));
    console.log(
      label.padEnd(8), String(rows.length).padStart(3),
      s.min.toFixed(3).padStart(7), s.median.toFixed(3).padStart(7), s.max.toFixed(3).padStart(7),
      med(rows.map((r) => r.E1)).toFixed(2).padStart(9),
      med(rows.map((r) => r.E2)).toFixed(2).padStart(8),
      med(rows.map((r) => r.E4)).toFixed(2).padStart(8),
      med(rows.map((r) => r.E8)).toFixed(2).padStart(8),
      med(rows.map((r) => r.E16)).toFixed(2).padStart(8),
      med(rows.map((r) => r.coverage)).toFixed(1).padStart(9),
    );
  }

  console.log(`\n  R ranges ${overlap ? '**OVERLAP**' : 'do NOT overlap'}: ours [${oR.min.toFixed(3)}, ${oR.max.toFixed(3)}]  rome2 [${rR.min.toFixed(3)}, ${rR.max.toFixed(3)}]`);
  if (!overlap) console.log(`  separation gap ${(oR.min - rR.max).toFixed(3)} (${(oR.min / rR.max).toFixed(2)}x); our median is ${(oR.median / rR.median).toFixed(2)}x the reference median.`);

  const e = (k, rows) => med(rows.map((r) => r[k]));
  console.log('\n  ABSOLUTE BAND ENERGY — the anti-blur check. Pooled medians:');
  for (const k of ['E1', 'E2', 'E4', 'E8', 'E16']) {
    const a = e(k, ours);
    const b = e(k, refs);
    console.log(`    ${k.padEnd(3)} ours ${a.toFixed(2).padStart(6)}   rome2 ${b.toFixed(2).padStart(6)}   ours/rome2 ${(a / b).toFixed(2)}`);
  }
  console.log('    Grade a change on OUR column only: E2 and E4 must RISE while R falls. If they fall');
  console.log('    with R it is a blur and the model got worse — see --selftest.');
  console.log('    Do NOT read the cross-pool ratios as targets. They are confounded by content and key');
  console.log('    (a lit figure on plain ground against a crop that is half soft background), and they');
  console.log('    already run the "wrong" way: our absolute mid-band energy is above the reference\'s.');
  console.log('    What separates the pools is the SHAPE — the excess is 3.8x at 1 px and only ~1.3x at');
  console.log('    4-16 px, which is the coarse-scale parity round one found, measured again here.');

  dump.rows = [...ours, ...refs].map(strip);
  dump.pooled = {
    ours: { n: ours.length, R: oR, E1: e('E1', ours), E2: e('E2', ours), E4: e('E4', ours), E8: e('E8', ours), E16: e('E16', ours), coverage: med(ours.map((r) => r.coverage)) },
    rome2: { n: refs.length, R: rR, E1: e('E1', refs), E2: e('E2', refs), E4: e('E4', refs), E8: e('E8', refs), E16: e('E16', refs), coverage: med(refs.map((r) => r.coverage)) },
    overlap,
  };
  dump.ref = { dir: path.relative(ROOT, REF) };
}

function strip(r) {
  const { _mask, _L, ...rest } = r;
  return rest;
}

console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);

if (JSONOUT) {
  const p = path.resolve(ROOT, JSONOUT);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(`json -> ${path.relative(ROOT, p)}`);
}

process.exit(exitCode);
