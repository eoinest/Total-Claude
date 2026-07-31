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
 *   - **Bottom crop, and it must be 20%.** Every one of the Rome II plates carries a
 *     burned-in wordmark in the lower band — six "EMPEROR EDITION" lockups, four
 *     "WIKI.TOTALWAR.COM", one "THE BATTLE OF PYDNA". The first draft of this file cropped
 *     14%, which cuts at 86% of frame height while the Emperor Edition wordmark begins at
 *     about 82%. So a legible "TOTAL WAR / ROME II" fragment survived on six of the ten
 *     plates and the "blind" deck could be sorted by watermark rather than by render
 *     quality. It was verified against r2-04 alone, whose Pydna lockup sits lowest and was
 *     the single frame where the leak did not show — a bad sample generalised into a bad
 *     default. Measured across all ten: nothing intrudes above 80%, so 20% clears every
 *     wordmark with margin. Do not reduce it without re-measuring all ten.
 *   - **Top crop, off by default.** The press plates are clean along the top edge, so
 *     cropping there would throw away image for nothing. In-game captures are not: the
 *     wall-garrison reference carries a "Start Battle" banner and a gilt eagle across the
 *     top centre. Pass `--topCrop=0.14` for any deck containing in-game captures.
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
 *
 * `reference/rome2/` holds ten UI-free battle plates. The two campaign-map screenshots that
 * came with the set live in `reference/rome2-campaign/` and are deliberately out of the deck
 * path: their HUD — unit cards, a general's portrait, a minimap — runs well above any
 * sensible crop line and no amount of trimming makes them usable as blind plates.
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
const BOTTOM_CROP = Number(args.get('bottomCrop') ?? 0.20);
/** Fraction removed from the top, where in-game captures carry banners and buttons. */
const TOP_CROP = Number(args.get('topCrop') ?? 0);
const QUALITY = Number(args.get('quality') ?? 88);
/*
 * `cover` centre-crops to 16:9, which is right for battle frames and wrong for a siege
 * tower: towers are tall, and only 2 of 11 reconstruction photographs survived the crop with
 * the machine still in frame. A 2-plate deck is not a measurement. `--fit=contain` letterboxes
 * onto a neutral grey instead, losing nothing; applied to every frame it is not a tell.
 */
const FIT = args.get('fit') === 'contain' ? 'contain' : 'cover';

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

/*
 * Label reference frames by the directory they came from, not the string "rome2".
 * The first version hardcoded it, so an engine deck built from reference/engines/deck-pool
 * still reported every plate as `origin: "rome2"` in the key — which quietly turns the
 * answer key into a wrong answer key. Read `source` if you need the exact file.
 */
const REF_LABEL = args.get('refLabel') ?? path.basename(path.resolve(ROOT, REFS));
const deck = [
  ...ours.map((f) => ({ src: f, origin: 'ours' })),
  ...refs.map((f) => ({ src: f, origin: REF_LABEL })),
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
  const top = Math.round(meta.height * TOP_CROP);
  const keepH = Math.max(1, Math.round(meta.height * (1 - BOTTOM_CROP - TOP_CROP)));
  await img
    .extract({ left: 0, top, width: meta.width, height: keepH })
    // `cover` + centre keeps the composition and guarantees identical output dimensions,
    // so no frame can be identified by its shape.
    .resize(W, HEIGHT, {
      fit: FIT,
      position: 'centre',
      background: { r: 82, g: 82, b: 82 },
    })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    // Strip EXIF/ICC. sharp drops input metadata by default; calling `.withMetadata()` would
    // *re-attach* it, which is the opposite of what is wanted here. Reference photographs
    // carry camera make/model, lens and editing software (e.g. "Canon EOS 5D Mark II",
    // "Adobe Photoshop Lightroom"), and our renders carry almost none — so preserving
    // metadata lets a critic sort the entire deck with exiftool without viewing one pixel.
    // JPEG density travels the same way (300 for a camera file, 72 for a render).
    .toFile(path.join(outAbs, name));
  key.push({ frame: name, origin: entry.origin, source: path.relative(ROOT, entry.src) });
}

// One directory up, so an agent given the deck path cannot list its way to the answers.
const keyPath = path.join(path.dirname(outAbs), `${path.basename(outAbs)}.key.json`);
await writeFile(keyPath, JSON.stringify({
  seed: SEED, height: HEIGHT, topCrop: TOP_CROP, bottomCrop: BOTTOM_CROP, quality: QUALITY,
  fit: FIT, refs: REFS, refLabel: REF_LABEL, ours: ours.length, reference: refs.length, key,
}, null, 2));

console.log(`deck: ${deck.length} frames (${ours.length} ours, ${refs.length} ${REF_LABEL}) → ${path.relative(ROOT, outAbs)}`);
console.log(`all ${W}x${HEIGHT}, top ${Math.round(TOP_CROP * 100)}% + bottom ${Math.round(BOTTOM_CROP * 100)}% cropped, jpeg q${QUALITY}, metadata stripped`);
console.log(`key (do NOT give this to the critic): ${path.relative(ROOT, keyPath)}`);
