#!/usr/bin/env node
/**
 * Blind A/B harness: mix our frames in with real Total War: Rome II frames, strip every
 * tell, and hand a critic a numbered deck it cannot decode.
 *
 * The point is that a critic told "grade our screenshot" grades charitably, and a critic
 * shown our frame beside a labelled Rome II frame grades the label. Neither measures what we
 * want, which is: *can a hostile expert pick ours out of a line-up, and on what evidence?*
 *
 * **This file refuses decks.** Three gates run on every invocation and any one of them exits
 * 3 without leaving frames behind. They exist because the harness has leaked seven times —
 * wordmark, EXIF, mislabelled key, file size, quantisation tables, the HUD, and the
 * letterbox bars `--fit=contain` puts on one pool only — and five of those were found by
 * somebody who was not looking for them. Each was closed by a person resolving to be
 * careful, and the next one arrived anyway. Care is not a mechanism.
 *
 *   1. **Provenance.** `--ours` must carry a `report.json` from the shot pass saying
 *      `hud: false`. Missing is refused as firmly as `true`; "nobody recorded it" is the
 *      state that produced leak six.
 *   2. **Overlay audit.** Per origin, the pixels that are static across every frame *and*
 *      structured, minus the other origin's. A DOM interface lights this up at 1.8% of
 *      frame; the worst clean deck on record is 0.005%.
 *   3. **Separability.** Six header-level scalars — file size, true JPEG length past the
 *      pad, both quantisation-table sums, source aspect, flat border depth — scored by
 *      balanced accuracy at the best single threshold. Refused at 0.95.
 *
 * Gate 3 would have caught leaks 2, 4, 5 and 7 the day they were introduced. Gate 2 would
 * have caught leak 6. Neither catches leak 1: see the note above Gate 2 for why the bottom
 * crop is still the only thing holding that one.
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
 *   - **One byte budget.** Encoding every frame at one *quality* sounds symmetric and is not:
 *     quality is a ratio, so at fixed q88 the file size reports how much high-frequency detail
 *     an image carries. Our renders carry far more of it — fine grass over the whole frame,
 *     grain, thousands of instanced men — while the press plates are web assets already
 *     compressed once before we saw them. Measured on a 6-ours/10-plate deck: mean 672,830
 *     bytes for ours against 349,225 for the plates, and the nine smallest files in the
 *     directory were all plates. `wc -c *.jpg | sort -n` decoded the deck without viewing a
 *     pixel. Round-tripping our PNGs through a JPEG generation first does NOT fix it
 *     (633,746 vs 349,225) — the asymmetry is content, not provenance. So each frame's quality
 *     is padded past its EOI marker to one common file length. An earlier version instead
 *     binary-searched each frame's *quality* to hit a common size, which traded the size leak
 *     for a quantisation-table leak — see the byte pass below, where the numbers are.
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

import { readdir, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
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
/*
 * 864, not 1080, and the reason is a defect an adversarial grader found in round 23.
 *
 * Both pools arrive at 1920x1080. A 20% bottom crop leaves 1920x864, and resizing *that*
 * back up to 1920x1080 is a 1.25x upscale — which is exactly what the harness did on every
 * frame of every deck it has ever built. The grader detected it directly: a period-4.995
 * comb in both axes with intermodulation sidebands beating against the 1/8 JPEG grid,
 * present in all twenty frames. It does not discriminate, because it is applied to both
 * sides, but it means every round to date was graded on interpolated pixels with real
 * detail thrown away and a resampling signature added back — on an instrument whose leading
 * separator is pixel-scale energy.
 *
 * At 864 a 1920x1080 source passes through the crop and out again untouched: no resample at
 * all, for either pool. Anything of a different shape is downscaled, which loses nothing
 * that upscaling would have recovered.
 *
 * Round 23 was run at the old 1080 default, before this was found, so its numbers are the
 * upscaled ones.
 */
const HEIGHT = Number(args.get('height') ?? 864);
/** Fraction of the frame height removed from the bottom, where wordmarks sit. */
const BOTTOM_CROP = Number(args.get('bottomCrop') ?? 0.20);
/** Fraction removed from the top, where in-game captures carry banners and buttons. */
const TOP_CROP = Number(args.get('topCrop') ?? 0);
const QUALITY = Number(args.get('quality') ?? 88);
/** Set 0 to skip byte-budget normalisation. Anything else overrides the computed target. */
const BYTES = args.get('bytes') === undefined ? null : Number(args.get('bytes'));
/*
 * `cover` centre-crops to 16:9, which is right for battle frames and wrong for a siege
 * tower: towers are tall, and only 2 of 11 reconstruction photographs survived the crop with
 * the machine still in frame. A 2-plate deck is not a measurement. `--fit=contain` letterboxes
 * onto a neutral grey instead, losing nothing.
 *
 * The comment that used to sit here said "applied to every frame it is not a tell", and that
 * is false. `contain` is applied to every frame; *bars* appear only on frames whose aspect
 * differs from 16:9, and aspect correlates perfectly with origin. In the `mech-1`, `mech-2`
 * and `mech-3` decks our 16:9 renders are full-bleed and every 4:3 reference photograph
 * carries a grey pillarbox down both sides. Three decks sortable at a glance, with no
 * reference to render quality at all. The audit below (`flatBorderPx`) now measures exactly
 * this and refuses the deck, which is why `contain` is still offered rather than removed:
 * it is safe when the pools genuinely share an aspect, and it is caught when they do not.
 */
const FIT = args.get('fit') === 'contain' ? 'contain' : 'cover';
/**
 * Take only these basenames (comma-separated, extension optional) from `--ours`.
 *
 * Exists so the provenance rule below stays livable. `report.json` lives beside the frames
 * a shot pass wrote, so hand-copying six of eighteen frames into a fresh directory throws
 * the provenance away and the deck is refused. Sub-selecting in place keeps it.
 */
const PICK = args.get('pick') ? new Set(String(args.get('pick')).split(',').map((s) => s.trim().replace(/\.[^.]+$/, ''))) : null;

if (!OURS || !OUT) {
  console.error('usage: blind-compare.mjs --ours=<dir> --out=<dir> [--refs=reference/rome2] [--seed=N] [--pick=a,b,c]');
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

/*
 * ---------------------------------------------------------------------------
 * Gate 1: provenance. Refuse a deck that cannot *prove* it is interface-free.
 * ---------------------------------------------------------------------------
 *
 * Leak six was that `tools/shoot.mjs` hid the HUD only when handed `--nohud`, and this
 * file never mentioned the flag. A lighting deck went out with the top plaque in every one
 * of our frames and all three of its graders sorted on the faction-strength bar. Nothing
 * about that measured a renderer.
 *
 * The five leaks before it were each closed by an individual deciding to be more careful,
 * and a sixth arrived regardless. So the rule here is not a reminder, it is a refusal: the
 * shot pass writes `hud: <bool>` into `report.json` beside the frames it produced, and a
 * directory that does not carry that record is not gradeable. Three states, and they are
 * deliberately distinct:
 *
 *   hud: false   → shot with the interface stripped. Gradeable.
 *   hud: true    → shot with the interface up. Refused.
 *   no record    → nobody knows. Refused. This is the state that produced leak six, and
 *                  treating it as "probably fine" is exactly the failure.
 *
 * Reference pools are exempt from the *missing record* case and only from that case, since
 * press plates and licensed photographs were never produced by our tooling; they are still
 * refused if a record exists and says `true`, which catches `--refs` pointed at a shot
 * directory by mistake. Both verdicts are written into the answer key.
 */
async function provenanceOf(dir, side) {
  const abs = path.resolve(ROOT, dir);
  let rec = null;
  try { rec = JSON.parse(await readFile(path.join(abs, 'report.json'), 'utf8')); }
  catch { /* absent or unparseable */ }
  if (rec && !Array.isArray(rec) && typeof rec.hud === 'boolean') {
    return {
      state: rec.hud ? 'hud-visible' : 'verified-clean',
      tool: rec.tool ?? 'unknown', at: rec.at ?? null, commit: rec.commit ?? null,
      worldOverlay: rec.worldOverlay ?? null,
    };
  }
  if (rec) return { state: 'record-without-hud-field', tool: rec.tool ?? 'unknown' };
  return { state: side === 'ours' ? 'no-record' : 'external-pool', tool: null };
}

const oursProv = await provenanceOf(OURS, 'ours');
const refsProv = await provenanceOf(REFS, 'refs');
const provFailures = [];
if (oursProv.state !== 'verified-clean') {
  provFailures.push(
    `--ours=${OURS}: ${oursProv.state}.\n`
    + `    A blind deck may only be built from frames a shot pass certified interface-free.\n`
    + `    Re-shoot with:  node tools/shoot.mjs --out=${OURS} --shots=...\n`
    + `    (the HUD is off by default; --hud opts back in and marks the directory ungradeable)\n`
    + `    To grade a subset of an existing pass, keep report.json in place and use --pick=a,b,c.`
  );
}
if (refsProv.state === 'hud-visible' || refsProv.state === 'record-without-hud-field') {
  provFailures.push(`--refs=${REFS}: ${refsProv.state}. A reference pool must not be a HUD-bearing shot directory.`);
}

const ours = (await listImages(OURS)).filter((f) => !PICK || PICK.has(path.basename(f).replace(/\.[^.]+$/, '')));
const refs = await listImages(REFS);
if (!ours.length) { console.error(`no images in ${OURS}${PICK ? ' matching --pick' : ''}`); process.exit(1); }
if (!refs.length) { console.error(`no images in ${REFS}`); process.exit(1); }
/*
 * The overlay audit below needs a handful of frames per side to tell a fixed overlay from
 * scene content. Three is the floor at which "static across every frame" means anything,
 * and a two-frame side was never a measurement in the first place.
 */
if (ours.length < 3) provFailures.push(`--ours has ${ours.length} frame(s); the overlay audit needs at least 3.`);
if (refs.length < 3) provFailures.push(`--refs has ${refs.length} frame(s); the overlay audit needs at least 3.`);

if (provFailures.length) {
  console.error('\nDECK REFUSED — provenance\n');
  for (const f of provFailures) console.error(`  ✗ ${f}`);
  console.error('\nNo deck was written.');
  process.exit(3);
}

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

/*
 * Output shape: follow the pools rather than forcing 16:9.
 *
 * Forcing 16:9 at height 864 would hand back 1536x864 — no upscale, but 20% of every
 * frame's width thrown away instead. Neither is necessary. When both pools are the same
 * shape (they are: 1920x1080 on both sides), the post-crop shape *is* 1920x864, and
 * emitting exactly that resamples nothing and crops nothing. Identical output dimensions
 * are what matters for blindness, not any particular ratio.
 *
 * Falls back to 16:9 when the sources disagree, and an explicit `--height`/`--w` always
 * wins, because a mixed-shape pool has no natural common shape and someone has to choose.
 */
const shapes = new Map();
for (const f of [...ours, ...refs]) {
  const m = await sharp(f, { failOn: 'none' }).metadata();
  const k = `${m.width}x${m.height}`;
  shapes.set(k, (shapes.get(k) ?? 0) + 1);
}
const [modal, modalN] = [...shapes].sort((a, b) => b[1] - a[1])[0];
const uniform = modalN === ours.length + refs.length && !args.has('height') && !args.has('w');
const [modalW, modalH] = modal.split('x').map(Number);
const OUT_H = uniform ? Math.max(1, Math.round(modalH * (1 - BOTTOM_CROP - TOP_CROP))) : HEIGHT;
const W = args.has('w') ? Number(args.get('w')) : (uniform ? modalW : Math.round((OUT_H * 16) / 9));
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
    .resize(W, OUT_H, {
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
  key.push({
    frame: name, origin: entry.origin, source: path.relative(ROOT, entry.src),
    // Kept for the separability audit: source shape is a header-level statistic, and when
    // it correlates with origin the deck is sortable without decoding an image.
    srcW: meta.width, srcH: meta.height,
    // Camera EXIF on the source is the cheapest possible test for "this pool is
    // photographs". The tags never reach the deck — they are stripped above — but a pool
    // of photographs is separable from a pool of renders on sensor noise and depth of
    // field whatever the harness does, so the *deck* needs to know it is that kind of deck.
    srcExif: Boolean(meta.exif),
  });
}

/*
 * Byte-budget pass — **pad, do not re-quantise.**
 *
 * The previous version binary-searched each frame's JPEG quality until its file size hit a
 * common target. It closed the `wc -c` leak and opened a worse one in its place, because
 * quality is not free: the search wrote the answer into the quantisation table. Measured on
 * the round2 and round3 decks it produced, the luma DQT sum reads
 *
 *     ours   mean 1426 (median 1367, q59-q95)
 *     rome2  mean  977 (median  801, q59-q99)
 *
 * — a 72-78% single-threshold split on `frame-NN.jpg`'s DQT header alone, no pixel decoded.
 * That is the same class of failure as the file-size leak it replaced, and it is worse in one
 * respect: a per-frame quality is not just a label, it is *visible*. Our frames carry more
 * high-frequency detail, so equalising bytes means systematically spending fewer bits on them,
 * so our frames come back with more ringing around spear silhouettes and more 8x8 blocking in
 * the sky. The harness was manufacturing the artefact that the critic was then asked to grade.
 *
 * So: one quality for every frame, and equalise the *file length* afterwards by appending
 * filler past the EOI marker, which every decoder ignores. Nobody is degraded relative to
 * anybody, `wc -c *.jpg | sort -n` returns the deck in filename order, and the compression
 * artefacts in the deck are the ones the source content actually earned.
 *
 * Stated honestly: this defeats a size *sort*, not a determined adversary. The compressed
 * length is still recoverable by scanning for the last `FF D9`. Closing that would mean
 * destroying real image information on one side or the other, which is the trade this pass
 * previously made and should not.
 */
let byteReport = 'byte normalisation skipped';
/** Frames the pad target could not reach; hoisted because the verdict below refuses on it. */
const short = [];
if (BYTES !== 0) {
  const sizeOf = async (f) => (await stat(path.join(outAbs, f))).size;
  const before = { ours: [], ref: [] };
  for (const e of key) before[e.origin === 'ours' ? 'ours' : 'ref'].push(await sizeOf(e.frame));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sizes = await Promise.all(key.map((e) => sizeOf(e.frame)));
  // Round up past the largest frame so every file lands on one number, and so that number
  // is not itself the max frame's size (which would identify that one frame).
  const target = BYTES ?? (Math.ceil((Math.max(...sizes) + 1) / 65536) + 1) * 65536;
  for (const [i, e] of key.entries()) {
    if (sizes[i] > target) { short.push(`${e.frame} ${sizes[i]}`); continue; }
    const src = path.join(outAbs, e.frame);
    const buf = await readFile(src);
    // Deterministic per-frame filler rather than zeros: a run of 0x00 is obvious tail padding
    // and invites stripping it back to the real length.
    const pad = Buffer.alloc(target - buf.length);
    const r = rng(SEED * 7919 + i);
    for (let k = 0; k < pad.length; k++) pad[k] = Math.floor(r() * 256);
    await writeFile(src, Buffer.concat([buf, pad]));
  }
  const after = { ours: [], ref: [] };
  for (const e of key) after[e.origin === 'ours' ? 'ours' : 'ref'].push(await sizeOf(e.frame));
  const distinct = new Set([...after.ours, ...after.ref]);
  byteReport = `bytes: padded to ${target} (all frames q${QUALITY}, one quantisation table), `
    + `pre-pad ours ${Math.round(mean(before.ours))}, ${REF_LABEL} ${Math.round(mean(before.ref))}`
    + (short.length ? `; ${short.length} OVER TARGET, unpadded and identifiable: ${short.join(', ')}`
      : `; ${distinct.size} distinct file size${distinct.size === 1 ? '' : 's — LEAK'}`);
}

/*
 * ===========================================================================
 * Gate 2: the overlay audit. Does a fixed overlay sit on one origin only?
 * ===========================================================================
 *
 * Every leak in this harness's history has been the same shape — some property of the
 * *file* rather than of the *render* separates the two pools — and every one was closed
 * individually, after a grader stumbled on it. Five of the six were found by somebody who
 * was not looking. So the harness now looks, every run, before it hands anything over.
 *
 * A DOM interface is not scene content: it is drawn at the same pixel coordinates in every
 * frame of a pass, with hard edges, regardless of where the camera is pointing. That gives
 * a signature no render has. For each origin group take the per-pixel standard deviation
 * across its frames and the spatial gradient of its per-pixel mean, and mark the pixels
 * that are simultaneously *static* (sd < 0.02) and *structured* (|grad| > 0.10). Scene
 * content fails the first test; sky and haze fail the second. Then subtract the other
 * group's mask, because an artefact common to the whole deck is symmetric and therefore
 * not a tell — only an origin-*exclusive* overlay decodes anything.
 *
 * Calibrated on the 18-shot pass at `95b7f5d`, run through this same crop and resize:
 *
 *     with the HUD up      0.888% of frame static-and-structured, largest blob 1.774%
 *                          (bounding box x 276-683, y 5-57 of 960x540 — the top plaque)
 *     round1 ours          0.000%      round1 rome2         0.000%
 *     critic-blind ours    0.003%      wallgeo-deck ours    0.002%
 *     rq-2903 ours         0.005%      rome2 raw, uncropped 0.000%
 *
 * Two and a half orders of magnitude between the worst clean deck and a HUD-bearing one,
 * so the threshold is not delicate. Components below 40 px are dropped as JPEG speckle.
 *
 * What this does NOT catch, stated plainly so nobody trusts it further than it goes: the
 * Rome II wordmarks are *not* flagged, because the six "EMPEROR EDITION" lockups, the four
 * "WIKI.TOTALWAR.COM" strips and the one Pydna title sit at slightly different places and
 * read different text, so they are not static across the pool. The 20% bottom crop remains
 * the only thing standing between the deck and leak one. Nor will this catch a single small
 * widget — a lone settings cog is about 40 px of edge, under the floor. It catches a HUD.
 */
const AUDIT_W = 960, AUDIT_H = 540, AUDIT_N = AUDIT_W * AUDIT_H;
const SD_STATIC = 0.02, GRAD_EDGE = 0.10, MIN_COMPONENT = 40;
/** Refuse at 0.02% of frame — 104 px, four times the worst clean deck and forty times under a HUD. */
const OVERLAY_REFUSE = 0.0002;

async function greyOf(file) {
  const { data } = await sharp(path.join(outAbs, file), { failOn: 'none' })
    .resize(AUDIT_W, AUDIT_H, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data, (v) => v / 255);
}

function staticStructuredMask(imgs) {
  const n = imgs.length;
  const mean = new Float32Array(AUDIT_N);
  for (let i = 0; i < AUDIT_N; i++) { let s = 0; for (const im of imgs) s += im[i]; mean[i] = s / n; }
  const mask = new Uint8Array(AUDIT_N);
  for (let y = 1; y < AUDIT_H - 1; y++) {
    for (let x = 1; x < AUDIT_W - 1; x++) {
      const i = y * AUDIT_W + x;
      let s = 0;
      for (const im of imgs) { const d = im[i] - mean[i]; s += d * d; }
      if (Math.sqrt(s / n) >= SD_STATIC) continue;
      if (Math.hypot(mean[i + 1] - mean[i - 1], mean[i + AUDIT_W] - mean[i - AUDIT_W]) > GRAD_EDGE) mask[i] = 1;
    }
  }
  return mask;
}

/** Drop speckle and report the biggest surviving region, so the message can point at it. */
function components(mask) {
  const seen = new Uint8Array(AUDIT_N);
  const stack = new Int32Array(AUDIT_N);
  let kept = 0, best = 0, bestBox = null;
  for (let s0 = 0; s0 < AUDIT_N; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    let top = 0, count = 0, x0 = AUDIT_W, x1 = -1, y0 = AUDIT_H, y1 = -1;
    stack[top++] = s0; seen[s0] = 1;
    const members = [];
    while (top) {
      const p = stack[--top];
      members.push(p); count++;
      const px = p % AUDIT_W, py = (p / AUDIT_W) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (px < AUDIT_W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (py > 0 && mask[p - AUDIT_W] && !seen[p - AUDIT_W]) { seen[p - AUDIT_W] = 1; stack[top++] = p - AUDIT_W; }
      if (py < AUDIT_H - 1 && mask[p + AUDIT_W] && !seen[p + AUDIT_W]) { seen[p + AUDIT_W] = 1; stack[top++] = p + AUDIT_W; }
    }
    if (count < MIN_COMPONENT) { for (const p of members) mask[p] = 0; continue; }
    kept += count;
    if (count > best) { best = count; bestBox = [x0, y0, x1, y1]; }
  }
  return { kept, best, bestBox };
}

const origins = [...new Set(key.map((e) => e.origin))];
const masks = new Map();
for (const o of origins) {
  const imgs = [];
  for (const e of key) if (e.origin === o) imgs.push(await greyOf(e.frame));
  masks.set(o, staticStructuredMask(imgs));
}
const overlay = [];
for (const o of origins) {
  const mine = masks.get(o);
  const excl = new Uint8Array(AUDIT_N);
  for (let i = 0; i < AUDIT_N; i++) {
    if (!mine[i]) continue;
    let shared = false;
    for (const [p, m] of masks) if (p !== o && m[i]) { shared = true; break; }
    if (!shared) excl[i] = 1;
  }
  const { kept, best, bestBox } = components(excl);
  overlay.push({ origin: o, area: kept / AUDIT_N, largest: best / AUDIT_N, box: bestBox });
}

/*
 * ===========================================================================
 * Gate 3: header separability. Can one number sort the deck?
 * ===========================================================================
 *
 * Leaks two, four, five and seven were all the same bug wearing different clothes — EXIF,
 * file size, the quantisation-table sum that the file-size *fix* introduced, and the
 * letterbox bars that `--fit=contain` puts on one pool only. Each was diagnosed after the
 * fact by someone computing one scalar per frame and finding it split the deck. So compute
 * them here, every run, and refuse rather than ship.
 *
 * The score is balanced accuracy at the best single threshold — (sensitivity+specificity)/2
 * maximised over every cut point — which does not reward a lopsided deck for guessing the
 * majority label. A constant statistic scores 0.5 and a perfect tell scores 1.0. Refusal
 * at 0.95 means at most one frame in a 20-frame deck may be misplaced by the best cut;
 * warning at 0.85. The battery is small and fixed on purpose: fishing across dozens of
 * statistics on a 20-frame deck would refuse clean decks by chance alone.
 */
const SEPARABLE_REFUSE = 0.95, SEPARABLE_WARN = 0.85;

/**
 * The true end of the compressed data, found the way an adversary would find it.
 *
 * `lastIndexOf(FF D9)` — the obvious version, and the one written here first — does not
 * work, and the reason is worth keeping: the tail padding is a quarter of a megabyte of
 * random bytes, so it contains about four spurious `FF D9` pairs by chance and the naive
 * search lands in the filler. That is a happy accident rather than a defence. Inside an
 * entropy-coded scan a literal `FF` is always stuffed to `FF 00` or is a restart marker
 * `FF D0`-`FF D7`, so `FF D9` cannot occur before the real EOI: scanning *forward* from
 * SOS finds the true length every time, in ten lines. Measure what can actually be
 * measured, or this gate is theatre.
 */
function scanLength(buf) {
  for (let i = 2; i + 3 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) return i + 2;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xda) {
      for (let p = i + 2 + len; p + 1 < buf.length; p++) if (buf[p] === 0xff && buf[p + 1] === 0xd9) return p + 2;
      return buf.length;
    }
    i += 2 + len;
  }
  return buf.length;
}

/** Sum of the first (luma) and second (chroma) quantisation tables, straight from the header. */
function dqtSums(buf) {
  const out = [];
  for (let i = 2; i + 4 < buf.length && out.length < 2;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end && out.length < 2) {
        const prec = buf[p] >> 4;
        p += 1;
        const n = 64;
        let s = 0;
        for (let k = 0; k < n; k++) s += prec ? ((buf[p + 2 * k] << 8) | buf[p + 2 * k + 1]) : buf[p + k];
        p += prec ? 128 : 64;
        out.push(s);
      }
    }
    i += 2 + len;
  }
  return out;
}

/**
 * Depth, in pixels, of the uniform bars touching each frame edge — i.e. letterboxing.
 *
 * A bar is a 2D region of one value, so the test is flat *along* the edge and unchanging
 * *inward*. Flatness alone is not enough and the first version proved it: a sky graded
 * vertically has rows that are constant to within a level, so `flight-stone.png` scored
 * 2,618 px of "bar" on a frame with no bar in it. Anchoring every row to the value of the
 * outermost row separates the two — a gradient walks away from its first row immediately,
 * a bar does not.
 */
async function flatBorderPx(file) {
  const { data, info } = await sharp(path.join(outAbs, file), { failOn: 'none' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const rowIs = (y, v) => { for (let x = 0; x < w; x++) if (Math.abs(data[y * w + x] - v) > 1) return false; return true; };
  const colIs = (x, v) => { for (let y = 0; y < h; y++) if (Math.abs(data[y * w + x] - v) > 1) return false; return true; };
  let n = 0;
  for (let y = 0, v = data[0]; y < h && rowIs(y, v); y++) n++;
  for (let y = h - 1, v = data[(h - 1) * w]; y >= 0 && rowIs(y, v); y--) n++;
  for (let x = 0, v = data[0]; x < w && colIs(x, v); x++) n++;
  for (let x = w - 1, v = data[w - 1]; x >= 0 && colIs(x, v); x--) n++;
  return n;
}

const stats = [];
for (const e of key) {
  const buf = await readFile(path.join(outAbs, e.frame));
  const [dqtL = 0, dqtC = 0] = dqtSums(buf);
  stats.push({
    frame: e.frame, origin: e.origin,
    bytes: buf.length,
    scanBytes: scanLength(buf),
    dqtLuma: dqtL, dqtChroma: dqtC,
    srcAspect: e.srcW / e.srcH,
    flatBorderPx: await flatBorderPx(e.frame),
  });
}

function balancedAccuracy(values, isOurs) {
  const pos = values.filter((_, i) => isOurs[i]);
  const neg = values.filter((_, i) => !isOurs[i]);
  if (!pos.length || !neg.length) return 0.5;
  const cuts = [...new Set(values)].sort((a, b) => a - b);
  let best = 0.5;
  for (const c of cuts) {
    const tpr = pos.filter((v) => v <= c).length / pos.length;
    const tnr = neg.filter((v) => v > c).length / neg.length;
    best = Math.max(best, (tpr + tnr) / 2, ((1 - tpr) + (1 - tnr)) / 2);
  }
  return best;
}

const isOurs = stats.map((s) => s.origin === 'ours');
/*
 * `scanBytes` is measured and reported but does not refuse, and that distinction is the
 * only judgement call in this file. Everything else in the battery is an artefact of the
 * harness — the pad target, the quantisation tables, the source shape, the letterbox — so
 * the harness can and must equalise it. The length of the compressed scan is not: it is a
 * statement about how much high-frequency energy the source image contains, and our frames
 * genuinely contain 1.7x what a Rome II press plate does (603,879 against 349,225 bytes,
 * measured on the 5-frame deck at `95b7f5d`). The only ways to equalise it are to spend
 * fewer bits on our side, which is precisely leak five and manufactured the artefacts the
 * critic was then asked to grade, or to add matched grain to both sides, which would bury
 * the aliasing signal that is currently the leading separator. Both destroy the instrument
 * to protect the instrument.
 *
 * So it stays open, and it stays printed. Note where it points: 1.7x the bytes and
 * harshness 1.137 against 0.427 are the same physical fact measured twice. Whoever closes
 * the aliasing gap closes this leak as a side effect, and nothing the harness does can
 * close it first.
 */
/*
 * Four of the six are things the harness *makes*, not things it observes, so the rule for
 * them is not a statistical one: they must come out **identical on every frame**, or the
 * pipeline did not do its job. A separability score is the wrong test here and the first
 * draft of this gate proved it — with `--bytes=0` the raw file sizes scored 0.850 balanced
 * accuracy, plainly a leak (the original bug report was "the nine smallest files in the
 * directory were all plates"), and sailed under a 0.95 bar because one large press plate
 * happened to overlap our range. An exact-equality test has no such soft edge, needs no
 * threshold, and cannot be argued with.
 */
const INVARIANT_FIELDS = ['bytes', 'dqtLuma', 'dqtChroma', 'flatBorderPx'];
const REFUSE_FIELDS = new Set(INVARIANT_FIELDS);
/*
 * Source aspect is only *observable* in the deck when `contain` letterboxes it into view.
 * Under `cover` every frame is centre-cropped to identical dimensions and the source shape
 * is destroyed, so refusing on it there would fail clean decks for a statistic no grader
 * can reach. It is still measured and printed under `cover`, because it explains why
 * `flatBorderPx` fires the moment someone switches fit.
 */
if (FIT === 'contain') REFUSE_FIELDS.add('srcAspect');
const FIELDS = ['bytes', 'scanBytes', 'dqtLuma', 'dqtChroma', 'srcAspect', 'flatBorderPx'];
/** refuse: the harness owns it. open: real and unclosable. hidden: not in the output at all. */
const classOf = (f) => (REFUSE_FIELDS.has(f) ? 'refuse' : f === 'scanBytes' ? 'open' : 'hidden');
const separability = FIELDS.map((f) => {
  const v = stats.map((s) => s[f]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    field: f,
    class: classOf(f),
    score: balancedAccuracy(v, isOurs),
    ours: +mean(v.filter((_, i) => isOurs[i])).toFixed(4),
    refs: +mean(v.filter((_, i) => !isOurs[i])).toFixed(4),
  };
}).sort((a, b) => b.score - a.score);

/*
 * Is the reference pool photographs?
 *
 * A photograph and a render are separable on sensor noise and depth of field alone, and no
 * amount of cropping, re-encoding or byte padding touches either. A deck built against
 * `reference/engines/*` or `reference/museum/*` therefore reports a separation it would
 * have reported for a perfect renderer, and four such decks are sitting in the history as
 * if they were quality rounds. They are a legitimate instrument — "does our scorpion match
 * the archaeology" is a real question — but they are an *accuracy* instrument and must
 * never be counted in a separation record about rendering. So say so, loudly, in the run
 * that produces one, rather than leaving it to whoever reads the key months later.
 */
const refEntries = key.filter((e) => e.origin !== 'ours');
const oursEntries = key.filter((e) => e.origin === 'ours');
const refExif = refEntries.filter((e) => e.srcExif).length / (refEntries.length || 1);
const oursExif = oursEntries.filter((e) => e.srcExif).length / (oursEntries.length || 1);
const photographic = refExif >= 0.5 && oursExif < 0.5;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const failures = [];
for (const o of overlay) {
  if (o.largest < OVERLAY_REFUSE && o.area < OVERLAY_REFUSE) continue;
  const [x0, y0, x1, y1] = o.box;
  const spread = ((x1 - x0) * (y1 - y0)) / AUDIT_N;
  /*
   * Three things produce a static, structured, origin-exclusive region, and the message has
   * to name the right one or it sends the reader hunting for a HUD that is not there. A
   * band across the top is the plaque. A thin strip down an edge is a letterbox bar. A
   * region sprawling over most of the frame is not an overlay at all — it means every frame
   * on that side was shot from one camera, which is a worse deck than a HUD-bearing one
   * because it is sortable on composition and no crop can fix it.
   */
  const cause = spread > 0.4
    ? 'these frames share one camera: the "overlay" is the scene itself, unchanged between frames. '
      + 'A blind side needs distinct viewpoints or it sorts on composition.'
    : (y1 < AUDIT_H * 0.25 && (x1 - x0) > AUDIT_W * 0.15)
      ? 'a band across the top is the DOM HUD — re-shoot without --hud.'
      : 'a thin strip down a frame edge is a letterbox bar from --fit=contain on a pool of a different shape.';
  failures.push(
    `overlay: "${o.origin}" carries a fixed feature no other origin has — `
    + `${(o.area * 100).toFixed(3)}% of frame static-and-structured, largest region `
    + `${(o.largest * 100).toFixed(3)}% at [x ${x0}-${x1}, y ${y0}-${y1}] of ${AUDIT_W}x${AUDIT_H}. `
    + cause
  );
}
for (const f of INVARIANT_FIELDS) {
  const values = [...new Set(stats.map((s) => s[f]))];
  if (values.length === 1) continue;
  const byOrigin = origins.map((o) => {
    const v = [...new Set(stats.filter((s) => s.origin === o).map((s) => s[f]))].sort((a, b) => a - b);
    return `${o} ${v.length > 3 ? `${v[0]}..${v[v.length - 1]}` : v.join('/')}`;
  }).join(', ');
  failures.push(
    `not invariant: \`${f}\` takes ${values.length} distinct values across the deck (${byOrigin}). `
    + `The harness is supposed to make this identical on every frame; a grader can read it out of `
    + `the file header with no decoder.`
  );
}
for (const s of separability) {
  if (s.score >= SEPARABLE_REFUSE && REFUSE_FIELDS.has(s.field) && !INVARIANT_FIELDS.includes(s.field)) {
    failures.push(
      `separable: \`${s.field}\` sorts the deck at balanced accuracy ${s.score.toFixed(3)} `
      + `(ours mean ${s.ours}, ${REF_LABEL} mean ${s.refs}) — a grader needs no pixels.`
    );
  }
}
if (short.length) failures.push(`bytes: ${short.length} frame(s) exceeded the pad target and are identifiable by size: ${short.join(', ')}`);

if (failures.length) {
  console.error('\nDECK REFUSED — audit\n');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\nThe frames have been deleted so they cannot be graded by accident.');
  await rm(outAbs, { recursive: true, force: true });
  // And the key from any previous run at the default path, which would otherwise sit there
  // describing a deck that no longer exists.
  await rm(path.join(path.dirname(outAbs), `${path.basename(outAbs)}.key.json`), { force: true });
  if (args.get('key')) await rm(path.resolve(ROOT, args.get('key')), { force: true });
  process.exit(3);
}

/*
 * One directory up by default, which stops an agent given the deck path from listing its
 * way to the answers *from inside the deck* — and no further than that. A grader curious
 * enough to `ls ..` finds `<deck>.key.json` sitting next to `<deck>/`. That is a weaker
 * guarantee than the original comment here implied, so: `--key=<path>` puts it anywhere,
 * and for a genuinely adversarial grader it should be somewhere the deck's parent does not
 * reveal.
 */
const keyPath = args.get('key')
  ? path.resolve(ROOT, args.get('key'))
  : path.join(path.dirname(outAbs), `${path.basename(outAbs)}.key.json`);
await mkdir(path.dirname(keyPath), { recursive: true });
await writeFile(keyPath, JSON.stringify({
  seed: SEED, height: OUT_H, width: W, topCrop: TOP_CROP, bottomCrop: BOTTOM_CROP, quality: QUALITY,
  fit: FIT, refs: REFS, refLabel: REF_LABEL, ours: ours.length, reference: refs.length,
  provenance: { ours: oursProv, refs: refsProv },
  audit: {
    overlay, separability, photographic, refExif, oursExif,
    thresholds: { OVERLAY_REFUSE, SEPARABLE_REFUSE },
    // Spelled out in the key so a reader months from now does not have to infer it.
    countsAsSeparationRound: !photographic,
  },
  key,
}, null, 2));

console.log(`deck: ${deck.length} frames (${ours.length} ours, ${refs.length} ${REF_LABEL}) → ${path.relative(ROOT, outAbs)}`);
console.log(`all ${W}x${OUT_H}, top ${Math.round(TOP_CROP * 100)}% + bottom ${Math.round(BOTTOM_CROP * 100)}% cropped, jpeg q${QUALITY}, metadata stripped`);
console.log(byteReport);
console.log(`provenance: ours ${oursProv.state} (${oursProv.tool ?? '-'}${oursProv.commit ? ' @' + oursProv.commit : ''}), ${REF_LABEL} ${refsProv.state}`);
console.log(`overlay audit: ${overlay.map((o) => `${o.origin} ${(o.area * 100).toFixed(3)}%`).join(', ')} (refuse at ${(OVERLAY_REFUSE * 100).toFixed(3)}%)`);
console.log(`separability: ${separability.slice(0, 3).map((s) => `${s.field} ${s.score.toFixed(2)}`).join(', ')} (refuse at ${SEPARABLE_REFUSE})`);
const NOTE = {
  refuse: ' — below the refusal bar, but it is a statistic this harness owns',
  open: ' — OPEN LEAK, live in the deck and not closable here; see the note on REFUSE_FIELDS',
  hidden: ` — not observable in the output under --fit=${FIT}; it would be a leak under contain`,
};
for (const s of separability) {
  if (s.score < SEPARABLE_WARN) continue;
  console.log(
    `  ${s.class === 'open' ? '‼' : '⚠'} \`${s.field}\` sorts the deck at ${s.score.toFixed(3)} `
    + `(ours ${s.ours}, ${REF_LABEL} ${s.refs})${NOTE[s.class]}`
  );
}
if (photographic) {
  console.log(
    `  ‼ ${Math.round(refExif * 100)}% of the "${REF_LABEL}" pool carries camera EXIF and ${Math.round(oursExif * 100)}% of ours does.\n`
    + '    This is a render-against-photograph deck. Sensor noise and depth of field separate\n'
    + '    those two whatever the renderer does, so a separation here is NOT evidence about\n'
    + '    render quality and this round must not be counted in the separation record.'
  );
}
console.log(`key (do NOT give this to the critic): ${path.relative(ROOT, keyPath)}`);
