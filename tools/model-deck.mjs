#!/usr/bin/env node
/**
 * Build a blind deck for the *isolated-model* instrument.
 *
 * Both pools are single soldiers at the same magnification, so the grader is sorting on the
 * man rather than on grass seams, terrain and aliasing. What that buys is real; what it costs
 * is honesty about one confound, stated here rather than buried: **our plates stand on a
 * neutral ground and the Rome II crops are cut out of a battle**, so background alone can
 * sort the deck. This tool cannot fix that — matting a press plate is not possible — so the
 * grading protocol asks for a *mechanism* on every call and the separation rate is reported
 * twice: raw, and restricted to calls whose stated mechanism is a property of the figure.
 *
 * Everything the battle harness learned about leaks still applies and is enforced here:
 *
 *   - identical output pixel size on both sides;
 *   - one encoder, one quality, for both — the press plates have a prior JPEG generation and
 *     ours do not, so both are re-encoded rather than only one;
 *   - all metadata stripped (EXIF sorted a deck once);
 *   - **byte counts checked** and the spread reported, because file size scored 0.850
 *     balanced accuracy on an earlier deck all by itself;
 *   - neutral filenames from a seeded shuffle, with the key written outside the deck.
 *
 * Usage:
 *   node tools/model-deck.mjs --ours=screenshots/mdl-r3 --out=screenshots/deck-m1 --seed=41
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const ROOT = path.resolve(import.meta.dirname, '..');
const OURS = path.resolve(ROOT, args.get('ours') ?? 'screenshots/mdl-r1');
const REF = path.resolve(ROOT, args.get('ref') ?? 'reference-crops');
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/deck-model');
const SEED = Number(args.get('seed') ?? 41);
const W = Number(args.get('w') ?? 750);
const H = Number(args.get('h') ?? 1000);
const Q = Number(args.get('q') ?? 90);

/** The provenance gate. A deck whose source cannot say `hud:false` is refused, as in shoot.mjs. */
const recPath = path.join(OURS, 'report.json');
if (!fs.existsSync(recPath)) {
  console.error(`REFUSED: ${path.relative(ROOT, OURS)} has no report.json.`);
  console.error('"Nobody wrote it down" is the state that produced leak six. Re-shoot with shoot-model.mjs.');
  process.exit(3);
}
const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
if (rec.hud !== false) {
  console.error(`REFUSED: report.json says hud=${rec.hud}. Missing is refused as firmly as true.`);
  process.exit(3);
}

const oursFiles = fs.readdirSync(OURS).filter((f) => f.endsWith('.png')).sort();
const refFiles = fs.readdirSync(REF).filter((f) => f.endsWith('.png')).sort();
if (!oursFiles.length || !refFiles.length) {
  console.error(`Empty pool: ours ${oursFiles.length}, ref ${refFiles.length}`);
  process.exit(1);
}

/** Mulberry32 — a seeded shuffle so a round can be reproduced from its key. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Balance the pools: an unbalanced deck lets a grader arithmetic its way to a better score.
const n = Math.min(oursFiles.length, refFiles.length);
const pick = [
  ...shuffle(oursFiles).slice(0, n).map((f) => ({ origin: 'ours', src: path.join(OURS, f), name: f })),
  ...shuffle(refFiles).slice(0, n).map((f) => ({ origin: 'rome2', src: path.join(REF, f), name: f })),
];
const order = shuffle(pick);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const key = [];
for (let i = 0; i < order.length; i++) {
  const label = `plate-${String(i + 1).padStart(2, '0')}.jpg`;
  await sharp(order[i].src)
    .resize(W, H, { fit: 'cover', kernel: 'lanczos3' })
    // One encoder, one quality, both pools. `mozjpeg` fixes the quantisation tables, which is
    // the thing that leaked when only the file *size* was equalised.
    .jpeg({ quality: Q, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .withMetadata({})
    .toFile(path.join(OUT, label));
  key.push({ plate: label, origin: order[i].origin, source: order[i].name });
}

const bytes = key.map((k) => fs.statSync(path.join(OUT, k.plate)).size);
const byOrigin = { ours: [], rome2: [] };
key.forEach((k, i) => byOrigin[k.origin].push(bytes[i]));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const keyPath = path.join(path.dirname(OUT), `${path.basename(OUT)}-key.json`);
fs.writeFileSync(keyPath, `${JSON.stringify({
  when: new Date().toISOString(),
  seed: SEED,
  size: { w: W, h: H },
  quality: Q,
  ours: { dir: path.relative(ROOT, OURS), commit: rec.commit, hud: rec.hud, dpr: rec.dpr },
  ref: path.relative(ROOT, REF),
  bytes: {
    oursMean: Math.round(mean(byOrigin.ours)),
    romeMean: Math.round(mean(byOrigin.rome2)),
    ratio: Number((mean(byOrigin.ours) / mean(byOrigin.rome2)).toFixed(3)),
  },
  key,
}, null, 2)}\n`);

console.log(`deck: ${order.length} plates (${n} ours, ${n} Rome II) -> ${path.relative(ROOT, OUT)}/`);
console.log(`key:  ${path.relative(ROOT, keyPath)}  (outside the deck, so a grader cannot read it)`);
console.log(`bytes: ours ${Math.round(mean(byOrigin.ours))} vs Rome II ${Math.round(mean(byOrigin.rome2))} — ratio ${(mean(byOrigin.ours) / mean(byOrigin.rome2)).toFixed(3)}`);
console.log('  a ratio far from 1.0 is a leak on its own: file size alone once scored 0.850 balanced accuracy.');
