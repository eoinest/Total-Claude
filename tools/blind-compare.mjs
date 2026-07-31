#!/usr/bin/env node
/**
 * Blind A/B harness: mix our frames in with real Total War: Rome II frames, strip every
 * tell, and hand a critic a numbered deck it cannot decode.
 *
 * The point is that a critic told "grade our screenshot" grades charitably, and a critic
 * shown our frame beside a labelled Rome II frame grades the label. Neither measures what we
 * want, which is: *can a hostile expert pick ours out of a line-up, and on what evidence?*
 *
 * Every image — ours and theirs — goes through the identical pipeline, because any asymmetry
 * is a tell:
 *
 *   - **Bottom crop.** Rome II press shots carry a logo in the bottom-right; r2-04's
 *     "ROME II / THE BATTLE OF PYDNA" wordmark occupies most of the lower band. Cropping a
 *     fixed fraction off the bottom of *both* sets removes it without leaving our frames
 *     visibly taller. Our frames are shot with `--nohud`, so nothing of ours is lost.
 *   - **One resolution.** Rome II press assets are 1920x1080; ours may be anything. Everything
 *     is resized to a common height and centre-cropped to 16:9, so aspect ratio and pixel
 *     density cannot be used to sort the deck.
 *   - **One encoder.** Both sets are re-encoded as JPEG at the same quality with metadata
 *     stripped. Otherwise our lossless PNGs versus their JPEG artefacts is a giveaway, and
 *     EXIF/software tags name the renderer outright.
 *   - **Shuffled, seeded.** Filenames are `frame-01..NN` in an order derived from `--seed`,
 *     so a run is reproducible without being guessable from the ordering.
 *
 * The answer key is written to `key.json` in the *parent* of the deck directory, so an agent
 * pointed at the deck cannot read it by listing its own working directory.
 *
 *   node tools/blind-compare.mjs --ours=screenshots/scorpion --refs=reference/rome2 \
 *     --out=screenshots/blind/scorpion --seed=7
 *
 * Reference frames are local-only and gitignored; nothing from `reference/` is ever copied
 * anywhere tracked, and the deck directory should be treated the same way.
 */

import { readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const OURS = args.get('ours');
const REFS = args.get('refs') ?? 'reference/rome2';
const OUT = args.get('out');
const SEED = Number(args.get('seed') ?? 1);
const HEIGHT = Number(args.get('height') ?? 1080);
/** Fraction of the frame height removed from the bottom, where wordmarks sit. */
const BOTTOM_CROP = Number(args.get('bottomCrop') ?? 0.14);
const QUALITY = Number(args.get('quality') ?? 88);

if (!OURS || !OUT) {
  console.error('usage: blind-compare.mjs --ours=<dir> --out=<dir> [--refs=reference/rome2] [--seed=N]');
  process.exit(2);
}

/** Mulberry32, so a seed reproduces a deck exactly. */
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IMG = /\.(png|jpg|jpeg|webp)$/i;
const listImages = async (dir) => {
  const abs = path.resolve(ROOT, dir);
  const names = (await readdir(abs)).filter((f) => IMG.test(f)).sort();
  return names.map((f) => path.join(abs, f));
};

const ours = await listImages(OURS);
const refs = await listImages(REFS);
if (!ours.length) { console.error(`no images in ${OURS}`); process.exit(1); }
if (!refs.length) { console.error(`no images in ${REFS}`); process.exit(1); }

const outAbs = path.resolve(ROOT, OUT);
await rm(outAbs, { recursive: true, force: true });
await mkdir(outAbs, { recursive: true });

const deck = [
  ...ours.map((f) => ({ src: f, origin: 'ours' })),
  ...refs.map((f) => ({ src: f, origin: 'rome2' })),
];

// Fisher-Yates with the seeded stream.
const rand = rng(SEED);
for (let i = deck.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [deck[i], deck[j]] = [deck[j], deck[i]];
}

const W = Math.round((HEIGHT * 16) / 9);
const key = [];

for (const [i, entry] of deck.entries()) {
  const name = `frame-${String(i + 1).padStart(2, '0')}.jpg`;
  const img = sharp(entry.src, { failOn: 'none' });
  const meta = await img.metadata();
  const keepH = Math.max(1, Math.round(meta.height * (1 - BOTTOM_CROP)));
  await img
    .extract({ left: 0, top: 0, width: meta.width, height: keepH })
    // `cover` + centre keeps the composition and guarantees identical output dimensions,
    // so no frame can be identified by its shape.
    .resize(W, HEIGHT, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    // Strip EXIF/ICC: the software tag alone would name the renderer.
    .withMetadata({})
    .toFile(path.join(outAbs, name));
  key.push({ frame: name, origin: entry.origin, source: path.relative(ROOT, entry.src) });
}

// One directory up, so an agent given the deck path cannot list its way to the answers.
const keyPath = path.join(path.dirname(outAbs), `${path.basename(outAbs)}.key.json`);
await writeFile(keyPath, JSON.stringify({
  seed: SEED, height: HEIGHT, bottomCrop: BOTTOM_CROP, quality: QUALITY,
  ours: ours.length, rome2: refs.length, key,
}, null, 2));

console.log(`deck: ${deck.length} frames (${ours.length} ours, ${refs.length} Rome II) → ${path.relative(ROOT, outAbs)}`);
console.log(`all ${W}x${HEIGHT}, bottom ${Math.round(BOTTOM_CROP * 100)}% cropped, jpeg q${QUALITY}, metadata stripped`);
console.log(`key (do NOT give this to the critic): ${path.relative(ROOT, keyPath)}`);
