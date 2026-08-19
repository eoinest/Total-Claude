#!/usr/bin/env node
/**
 * Build the **paired** blind instrument: `NN-A.png` / `NN-B.png`, one of ours and one real
 * Total War: ROME II frame, same subject, side randomised, and a grader asked which is which.
 *
 * `tools/blind-compare.mjs` builds the *pooled* instrument — one shuffled line-up of twenty
 * frames the grader sorts wholesale. Both measure the same thing and neither replaces the
 * other, but the pair has one property the pool does not: **subject is controlled inside the
 * trial.** In a pool, "the frame with the war elephants is Rome II" is a correct call that
 * says nothing about our renderer. In a pair, the plate beside our elephants is Rome II's
 * elephants, and the grader has to find something else. What is left is closer to the
 * question we actually want answered.
 *
 * It also gives an honest scalar. Fourteen pairs are fourteen independent two-alternative
 * forced choices, so accuracy has a known null: **50% is the win condition**, and a round
 * that comes back at 50% means a grader cannot tell our game from Rome II.
 *
 * ---------------------------------------------------------------------------
 * What this file does differently from `blind-compare.mjs`, and why
 * ---------------------------------------------------------------------------
 *
 * **One crop rectangle per pair, applied to both members, and no resample at all.**
 * `blind-compare` normalises the whole deck to one shape, which forces a resize on anything
 * that is not 1920x1080 and forced a 1.25x upscale on every frame of every deck until round
 * 23 caught it. A pair does not need a deck-wide shape: it needs *its own two members* to be
 * identical, and they can be, exactly, by taking the same pixel rectangle out of both. Pairs
 * then differ from each other in size — which carries no origin signal, because both members
 * of a pair share it — and nothing anywhere is interpolated.
 *
 * **The rectangle is chosen against the reference plate's hazards, then applied to ours.**
 *   - *Wordmarks.* Every Rome II store screenshot carries a burned-in lockup, and every one
 *     of them is hard against the **right** edge. The window is therefore 1440 px wide out
 *     of 1920, which clears the leftmost glyph pixel in the whole set by at least 68 px. See
 *     `MAX_W` below for how that was measured, and for why the "bottom 20%" rule this
 *     project has used for twenty-three rounds is false on three of the twenty-two plates.
 *   - *Cinematic bars.* Three of the twenty-two — s2-17, s2-18, s2-19 — are 2.35:1 frames
 *     delivered in a 16:9 file with hard 139-140 px black bars top and bottom. Two of them
 *     are the best siege plates in the set. Dropping them would cost the wall-assault pairs;
 *     using them raw would let a grader sort those pairs on the bars alone with no reference
 *     to render quality. So the bars are measured (`blackBars`) and windowed out, and our
 *     frame is windowed to the *same rows*, which is why those pairs come out at 1440x720
 *     while the rest come out at 1440x800.
 *   - *Odd source widths.* s2-09 is 1728x1080, which the 1440 cap already covers.
 *
 * **One JPEG generation, then PNG.** The output format is PNG because that is what the deck
 * asks for, and PNG on its own is a leak: the plates arrive with a JPEG generation already
 * baked in and our renders have none, so at 100% zoom one side has ringing around every
 * spear and the other does not. Both sides therefore go through *one identical* mozjpeg
 * generation — same quality, same chroma mode — before being written as PNG. That does not
 * equalise it (theirs has two generations, ours one; the asymmetry is stated in the audit
 * rather than hidden), but it closes the large half of the gap.
 *
 * All crop offsets and sizes are multiples of 16. This is not tidiness: the plates already
 * carry a JPEG quantisation grid, and a crop offset that is not a multiple of 16 shifts our
 * re-encode off it, which grinds a *second*, misaligned block grid into the reference side
 * only. Aligned, the re-encode is close to idempotent for them.
 *
 * **Byte lengths are equalised with a PNG private chunk.** `wc -c *.png | sort -n` sorted an
 * earlier deck of this project without a pixel being viewed, because compressed length is a
 * measure of high-frequency content and our renders carry far more of it. `blind-compare`
 * pads past the JPEG EOI marker; the PNG equivalent is an ancillary private chunk (`paDd`)
 * appended before IEND, which every decoder ignores. Same trade, stated the same way: this
 * defeats a size *sort*, not a determined adversary with a chunk parser.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *
 *   node tools/pair-deck.mjs \
 *     --ours=/tmp/tc-ab/shots-r1 \
 *     --refs=reference/rome2-steam \
 *     --pairs=tools/ab-pairs-round1.json \
 *     --out=/tmp/tc-ab/round-1 \
 *     --key=/tmp/tc-ab/keys/round-1.json \
 *     --seed=91
 *
 * The key is written **outside** the deck directory and the deck's own README says nothing
 * about where. An agent pointed at the deck cannot read the answers by listing its own
 * working directory.
 */

import sharp from 'sharp';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  OVERLAY_REFUSE, SEPARABLE_REFUSE, SEPARABLE_WARN,
  balancedAccuracy, blackBars, flatBorderPx, overlayAudit, pictureStats, rng,
} from './lib/deck-audit.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const OURS = args.get('ours');
const REFS = args.get('refs') ?? 'reference/rome2-steam';
const PAIRS = args.get('pairs');
const OUT = args.get('out') ?? '/tmp/tc-ab/round-1';
const KEY = args.get('key') ?? '/tmp/tc-ab/keys/round-1.json';
const SEED = Number(args.get('seed') ?? 91);
const QUALITY = Number(args.get('quality') ?? 90);
/**
 * The wordmark defence, and it is horizontal, not vertical.
 *
 * `blind-compare.mjs` clears the Rome II lockups by cutting the bottom 20% of every frame,
 * measured across ten plates as "nothing intrudes above 80% of frame height". **That rule is
 * false on the wider set.** The three 2.35:1 cinematic plates place their lockup relative to
 * the letterboxed picture rather than to the file, so on s2-17 the top of "TOTAL WAR" sits at
 * y≈803 — 74% of frame height — and a deck built at the 80% rule shipped a legible
 * "TOTAL WAR / ROME II" in the bottom right of the Rome II side of the wall pair. That is
 * leak one, again, on the first deck this tool ever produced.
 *
 * So the primary defence is the *other* axis, where the margin is much larger. Every lockup
 * in all twenty-two store screenshots sits hard against the right edge. Measured two ways:
 *
 *   - cross-plate agreement on the four "Emperor Edition" plates (the only variant whose
 *     glyphs are opaque enough for it) puts that lockup at x 1499-1841, y 887-1026;
 *   - a 140 px vertical band cut at x 1330-1470 from all twenty-two plates contains no glyph
 *     pixel of any variant, including the wide "THE BATTLE OF PYDNA" title.
 *
 * `MAX_W = 1440` therefore clears the leftmost lockup pixel by at least 30 px on the worst
 * plate and by 59 px on the Emperor Edition ones. The vertical window is kept as well, so a
 * surviving lockup would have to be *both* left of 1440 *and* above 80% of frame height, and
 * none is either. Two independent defences, and a proof sheet of the discarded region is
 * written beside the key every run so the measurement can be re-checked rather than trusted.
 *
 * Stated plainly, because this is the one gate in this file that is a measurement with a
 * margin rather than an automatic refusal: a detector was tried and rejected. Counting
 * bright pixels with dark neighbours in the bottom-right does light up on a lockup, and it
 * also lights up on bronze helmets against shadow — 1113 per megapixel on the Pydna plate,
 * whose lockup the crop had already removed. A gate that refuses clean decks is worse than
 * no gate, because it gets turned off.
 */
const MAX_W = Number(args.get('maxWidth') ?? 1440);
/** Fraction of the *source* frame height below which a Rome II wordmark may sit. */
const WORDMARK_FROM = Number(args.get('wordmarkFrom') ?? 0.80);
/** Set 0 to skip byte-budget normalisation. */
const PAD = args.get('pad') === '0' ? 0 : 1;

if (!OURS || !PAIRS) {
  console.error('usage: pair-deck.mjs --ours=<dir> --pairs=<manifest.json> [--refs=dir] [--out=dir] [--key=file] [--seed=N]');
  process.exit(2);
}

const oursAbs = path.resolve(ROOT, OURS);
const refsAbs = path.resolve(ROOT, REFS);
const outAbs = path.resolve(ROOT, OUT);
const keyAbs = path.resolve(ROOT, KEY);

if (path.dirname(keyAbs) === outAbs) {
  console.error('REFUSED: the answer key would land inside the deck directory. That is leak three.');
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Gate 1: provenance
// ---------------------------------------------------------------------------
/*
 * Identical in spirit to `blind-compare.mjs`'s, and deliberately not softened. The shot pass
 * writes `hud: <bool>` beside the frames it produced; `false` is gradeable, `true` is
 * refused, and *missing* is refused just as firmly, because "nobody wrote it down" is the
 * state that produced leak six — a whole lighting round graded on the faction-strength bar.
 */
const recPath = path.join(oursAbs, 'report.json');
if (!existsSync(recPath)) {
  console.error(`REFUSED: ${OURS} has no report.json.`);
  console.error('  Re-shoot with tools/shoot.mjs, which records hud:false for every pass.');
  process.exit(3);
}
const rec = JSON.parse(await readFile(recPath, 'utf8'));
if (rec.hud !== false) {
  console.error(`REFUSED: report.json says hud=${rec.hud}. Missing is refused as firmly as true.`);
  process.exit(3);
}
if (rec.worldOverlay && rec.worldOverlay !== 'hidden' && rec.worldOverlay !== 'absent') {
  console.error(`REFUSED: report.json says worldOverlay=${rec.worldOverlay}.`);
  console.error('  A DOM strip does not remove world-space interface; selection rings would be in frame.');
  process.exit(3);
}

const manifest = JSON.parse(await readFile(path.resolve(ROOT, PAIRS), 'utf8'));
const pairs = manifest.pairs ?? manifest;
if (!Array.isArray(pairs) || !pairs.length) {
  console.error(`no pairs in ${PAIRS}`);
  process.exit(2);
}

const find = async (dir, base) => {
  const names = await readdir(dir);
  const hit = names.find((n) => n.replace(/\.[^.]+$/, '') === base);
  if (!hit) throw new Error(`no file named "${base}" in ${path.relative(ROOT, dir)}`);
  return path.join(dir, hit);
};

const align = (n, m = 16) => Math.floor(n / m) * m;
const alignUp = (n, m = 16) => Math.ceil(n / m) * m;

/**
 * Keep IHDR, IDAT and IEND; drop everything else.
 *
 * sharp writes a `pHYs` chunk (physical pixel dimensions, 72 dpi) on every PNG. Both pools
 * get the identical value so it is not a tell *today*, and that is exactly the argument that
 * was made about EXIF before leak two. A chunk nobody put there on purpose is a chunk nobody
 * is checking, so the deck carries none: the whitelist below is what a grader's `pngcheck`
 * should see, and `pair-deck` refuses a deck where it sees anything else.
 */
function stripAncillary(buf) {
  const keep = new Set(['IHDR', 'IDAT', 'IEND']);
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (keep.has(type)) parts.push(buf.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

await rm(outAbs, { recursive: true, force: true });
await mkdir(outAbs, { recursive: true });
await mkdir(path.dirname(keyAbs), { recursive: true });

const rand = rng(SEED);
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const order = shuffle(pairs);
const key = [];
const outFiles = [];
const windows = [];

for (const [i, p] of order.entries()) {
  const oursSrc = await find(oursAbs, p.ours);
  const refSrc = await find(refsAbs, p.ref);
  const om = await sharp(oursSrc).metadata();
  const rm_ = await sharp(refSrc).metadata();

  /*
   * The window, chosen against the plate's hazards and then applied to both.
   *
   * Rows: start below any cinematic bar, stop above the wordmark band. Columns: the full
   * width of the narrower source, centred in the wider one. Everything snapped to 16 px so
   * the plate's own JPEG block grid survives the crop.
   */
  const bars = await blackBars(refSrc);
  const top = alignUp(bars.top);
  const bottomLimit = align(Math.min(rm_.height - bars.bottom, rm_.height * WORDMARK_FROM));
  const w = align(Math.min(MAX_W, om.width, rm_.width));
  // Cap the height at 16:9 of the chosen width so the window keeps a game's shape rather
  // than becoming a 4:3 letterbox of a 16:9 composition.
  const h = align(Math.min(bottomLimit - top, om.height - top, (w * 9) / 16));
  if (h < 320 || w < 640) throw new Error(`${p.ref}: window collapsed to ${w}x${h}`);

  const cut = async (src, meta) => {
    // Left-anchored, both pools. Not centred: the lockups are hard against the *right* edge,
    // so a centred 1440 window out of 1920 keeps x 240-1680 and puts every one of them back
    // in the frame. Anchoring only the reference and centring ours would be worse still —
    // a systematic composition offset that correlates with origin is itself a tell.
    const left = 0;
    // Our frames have no wordmark and no bars, so in principle any rows would do. They get
    // the plate's rows anyway: a systematic vertical offset between the pools is a framing
    // difference that could correlate with origin, and there is no reason to introduce one.
    const t = Math.min(top, meta.height - h);
    const jpeg = await sharp(src)
      .extract({ left, top: t, width: w, height: h })
      /*
       * One generation, one quality, one chroma mode, both sides. The plates already carry a
       * generation and ours do not; this does not equalise that, it stops it being 1-vs-0.
       *
       * 4:4:4, and this was measured rather than assumed. The obvious choice is 4:2:0,
       * because that is what a web JPEG usually is and because full-chroma renders have
       * clean colour edges where a subsampled photograph fringes. But every one of the
       * twenty-two store screenshots is **4:4:4** — Valve serves them at full chroma — so
       * subsampling here would not be matching the reference, it would be degrading both
       * pools to make them match each other, and degrading the side that is the target.
       */
      .jpeg({ quality: QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    /*
     * Decode and re-emit as PNG.
     *
     * `withMetadata` is deliberately NOT called: sharp drops input metadata by default and
     * calling it would *re-attach* EXIF, ICC and density, which is leak two.
     *
     * `palette: false` is not a style preference. Left to itself sharp writes a PLTE chunk —
     * measured, on this exact pipeline — i.e. it quantises to 256 colours. Two images
     * quantised independently lose different amounts, and how much they lose depends on how
     * much colour variety they carried, which is precisely the kind of content-correlated
     * asymmetry this whole file exists to prevent.
     */
    const png = await sharp(jpeg).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();
    return stripAncillary(png);
  };

  const oursPng = await cut(oursSrc, om);
  const refPng = await cut(refSrc, rm_);

  // Side randomisation, per pair, from the seeded stream.
  const oursIsA = rand() < 0.5;
  const n = String(i + 1).padStart(2, '0');
  const aPath = path.join(outAbs, `${n}-A.png`);
  const bPath = path.join(outAbs, `${n}-B.png`);
  await writeFile(aPath, oursIsA ? oursPng : refPng);
  await writeFile(bPath, oursIsA ? refPng : oursPng);

  outFiles.push(
    { file: aPath, origin: oursIsA ? 'ours' : 'rome2', pair: n, side: 'A' },
    { file: bPath, origin: oursIsA ? 'rome2' : 'ours', pair: n, side: 'B' },
  );
  windows.push({ pair: n, w, h, top, bars: `${bars.top}/${bars.bottom}` });
  key.push({
    pair: n,
    subject: p.subject,
    ours: oursIsA ? `${n}-A.png` : `${n}-B.png`,
    rome2: oursIsA ? `${n}-B.png` : `${n}-A.png`,
    oursSource: path.relative(ROOT, oursSrc),
    romeSource: path.relative(ROOT, refSrc),
    window: { width: w, height: h, top, srcBars: bars },
  });
}

// ---------------------------------------------------------------------------
// Byte-budget pass: one file length for the whole deck.
// ---------------------------------------------------------------------------
/*
 * `wc -c` is the cheapest attack there is and it has worked on this project's decks before.
 * PNG has no equivalent of the JPEG EOI trailer, but it does have a chunk stream, and an
 * ancillary private chunk is ignored by every decoder. `paDd` is a legal name: byte 0
 * lowercase = ancillary, byte 1 lowercase = private, byte 2 uppercase = reserved bit clear,
 * byte 3 lowercase = safe to copy.
 *
 * Deterministic random filler rather than zeros, for the same reason `blind-compare` uses
 * it: a run of 0x00 announces itself as padding and invites stripping it back.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

let byteReport = 'byte normalisation skipped';
if (PAD) {
  const sizes = await Promise.all(outFiles.map(async (f) => (await stat(f.file)).size));
  const before = { ours: [], rome2: [] };
  outFiles.forEach((f, i) => before[f.origin].push(sizes[i]));
  const MB = 1024 * 1024;
  const target = (Math.ceil((Math.max(...sizes) + 1) / MB) + 1) * MB;
  for (const [i, f] of outFiles.entries()) {
    const buf = await readFile(f.file);
    if (buf.length + 12 > target) throw new Error(`${f.file} is ${buf.length} B, past the ${target} B target`);
    // IEND is the last 12 bytes of a well-formed PNG; the pad chunk goes immediately before.
    const iend = buf.subarray(buf.length - 12);
    if (iend.toString('latin1', 4, 8) !== 'IEND') throw new Error(`${f.file}: no IEND where one must be`);
    const dataLen = target - buf.length - 12;
    const data = Buffer.alloc(dataLen);
    const r = rng(SEED * 7919 + i);
    for (let k = 0; k < dataLen; k++) data[k] = Math.floor(r() * 256);
    const chunk = Buffer.alloc(dataLen + 12);
    chunk.writeUInt32BE(dataLen, 0);
    chunk.write('paDd', 4, 'latin1');
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + dataLen)), 8 + dataLen);
    await writeFile(f.file, Buffer.concat([buf.subarray(0, buf.length - 12), chunk, iend]));
  }
  const after = await Promise.all(outFiles.map(async (f) => (await stat(f.file)).size));
  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const distinct = new Set(after);
  byteReport = `padded to ${target} B (${distinct.size} distinct size${distinct.size === 1 ? '' : 's — LEAK'}); `
    + `pre-pad mean ours ${mean(before.ours)}, Rome II ${mean(before.rome2)} `
    + `(ratio ${(mean(before.ours) / mean(before.rome2)).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// The leak audit
// ---------------------------------------------------------------------------

/** Every PNG chunk type present, so "metadata stripped" is measured rather than asserted. */
async function pngChunks(file) {
  const buf = await readFile(file);
  const out = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    out.push(type);
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return out;
}

const ALLOWED_CHUNKS = new Set(['IHDR', 'IDAT', 'IEND', 'paDd']);
const chunkFindings = [];
const stats = [];
for (const f of outFiles) {
  const chunks = await pngChunks(f.file);
  const extra = [...new Set(chunks)].filter((c) => !ALLOWED_CHUNKS.has(c));
  if (extra.length) chunkFindings.push(`${path.basename(f.file)}: ${extra.join(',')}`);
  const meta = await sharp(f.file).metadata();
  const buf = await readFile(f.file);
  let idat = 0;
  {
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      if (buf.toString('latin1', i + 4, i + 8) === 'IDAT') idat += len;
      if (buf.toString('latin1', i + 4, i + 8) === 'IEND') break;
      i += 12 + len;
    }
  }
  stats.push({
    file: path.basename(f.file), origin: f.origin, pair: f.pair,
    bytes: buf.length,
    idatBytes: idat,
    width: meta.width, height: meta.height,
    depth: meta.depth, channels: meta.channels, space: meta.space,
    hasIcc: Boolean(meta.icc), hasExif: Boolean(meta.exif),
    flatBorderPx: await flatBorderPx(f.file),
    blackBar: (await blackBars(f.file)).top + (await blackBars(f.file)).bottom,
    ...(await pictureStats(f.file)),
  });
}

const isOurs = stats.map((s) => s.origin === 'ours');
const FIELDS = ['bytes', 'idatBytes', 'width', 'height', 'flatBorderPx', 'blackBar'];
/*
 * `idatBytes` is measured and printed but does not refuse, and the reason is the one
 * `blind-compare.mjs` gives for `scanBytes`: compressed length is a statement about how much
 * pixel-scale energy the source image carries, and ours genuinely carries more. The only
 * ways to equalise it are to spend fewer bits on our side — which manufactures the artefact
 * the grader is then asked to judge — or to add matched grain to both, which buries the
 * aliasing signal that is the leading real separator. Both destroy the instrument to protect
 * the instrument. It closes when the renderer stops carrying more pixel-scale energy than a
 * press plate, and nothing the harness does can close it first.
 */
const OPEN = new Set(['idatBytes']);
/*
 * `width` and `height` vary by pair *on purpose* — the cinematic plates are windowed to
 * 1920x704 and s2-09's pair to 1728x864 — but both members of a pair always share them, so
 * they cannot separate the pools. The pairwise check below is the one that matters; the
 * balanced-accuracy score on them is reported for completeness and is 0.5 by construction.
 */
const separability = FIELDS.map((f) => {
  const v = stats.map((s) => s[f]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    field: f,
    class: OPEN.has(f) ? 'open' : 'refuse',
    score: balancedAccuracy(v, isOurs),
    ours: +mean(v.filter((_, i) => isOurs[i])).toFixed(2),
    rome2: +mean(v.filter((_, i) => !isOurs[i])).toFixed(2),
  };
}).sort((a, b) => b.score - a.score);

// Pairwise identity: within a pair, everything the harness owns must match exactly.
const pairFindings = [];
for (const k of key) {
  const a = stats.find((s) => s.file === `${k.pair}-A.png`);
  const b = stats.find((s) => s.file === `${k.pair}-B.png`);
  for (const f of ['bytes', 'width', 'height', 'depth', 'channels', 'space', 'flatBorderPx', 'blackBar']) {
    if (a[f] !== b[f]) pairFindings.push(`pair ${k.pair}: ${f} ${a[f]} vs ${b[f]}`);
  }
  if (a.hasIcc || b.hasIcc) pairFindings.push(`pair ${k.pair}: an ICC profile survived`);
  if (a.hasExif || b.hasExif) pairFindings.push(`pair ${k.pair}: EXIF survived`);
}

const overlay = await overlayAudit(outFiles.map((f) => ({ origin: f.origin, file: f.file })));

/*
 * One timestamp for the whole deck.
 *
 * Files are written pair by pair, A then B, so A is always a few milliseconds older than
 * its B — and the byte-pad pass rewrites them in the same order. `ls -lt` therefore returns
 * the deck in a fixed order that is not the answer, but `stat` on a single pair still says
 * which of A and B was produced first, and nothing stops a future change to the write order
 * from making that correlate with origin. Normalise it rather than reason about it.
 */
{
  const stamp = new Date('2026-01-01T00:00:00Z');
  for (const f of outFiles) await utimes(f.file, stamp, stamp);
  await utimes(path.join(outAbs, 'README.md'), stamp, stamp).catch(() => {});
}

const aIsOurs = key.filter((k) => k.ours.endsWith('-A.png')).length;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const failures = [];
for (const s of separability) {
  if (s.class === 'refuse' && s.score >= SEPARABLE_REFUSE) {
    failures.push(`separable on ${s.field}: balanced accuracy ${s.score.toFixed(3)} (ours ${s.ours}, Rome II ${s.rome2})`);
  }
}
for (const o of overlay) {
  if (o.area >= OVERLAY_REFUSE) {
    failures.push(`origin-exclusive overlay on ${o.origin}: ${(o.area * 100).toFixed(3)}% of frame, largest blob ${(o.largest * 100).toFixed(3)}% at ${JSON.stringify(o.box)}`);
  }
}
failures.push(...pairFindings);
failures.push(...chunkFindings.map((c) => `unexpected PNG chunk — ${c}`));
if (aIsOurs < Math.floor(key.length * 0.25) || aIsOurs > Math.ceil(key.length * 0.75)) {
  failures.push(`side balance is ${aIsOurs}/${key.length} ours-as-A; reseed`);
}

const COMMIT = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();

console.log(`\npairs:    ${key.length}  ->  ${outAbs}`);
console.log(`windows:  ${[...new Set(windows.map((w) => `${w.w}x${w.h}`))].join(', ')}`);
console.log(`sides:    ours is A in ${aIsOurs} of ${key.length} pairs`);
console.log(`bytes:    ${byteReport}`);
console.log('\nseparability (balanced accuracy at the best single threshold; 0.5 = no signal)');
for (const s of separability) {
  console.log(`  ${s.field.padEnd(14)} ${s.score.toFixed(3)}  [${s.class}]  ours ${s.ours}  rome2 ${s.rome2}`);
}
/*
 * The picture statistics, printed per origin.
 *
 * Not a gate. This is the objective half of a round's findings — the thing a grader's
 * "the colour is all in one band" gets argued in, and the thing the next round has to move.
 * A large gap here is a *finding*, not a leak: it is the renderer differing from the target,
 * which is what the instrument exists to measure.
 */
const picture = ['lum', 'p01', 'p99', 'chroma', 'hueSpread', 'edge', 'halo', 'vignette'].map((f) => {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const v = stats.map((s) => s[f]);
  return {
    field: f,
    ours: +mean(v.filter((_, i) => isOurs[i])).toFixed(4),
    rome2: +mean(v.filter((_, i) => !isOurs[i])).toFixed(4),
    score: balancedAccuracy(v, isOurs),
  };
});
console.log('\npicture statistics (reported, never refused — these are findings, not leaks)');
for (const p of picture) {
  console.log(`  ${p.field.padEnd(10)} ours ${String(p.ours).padStart(9)}   rome2 ${String(p.rome2).padStart(9)}   `
    + `separates at ${p.score.toFixed(3)}`);
}

console.log('\noverlay audit (origin-exclusive static-and-structured pixels)');
for (const o of overlay) {
  console.log(`  ${o.origin.padEnd(6)} ${(o.area * 100).toFixed(4)}% of frame, largest blob ${(o.largest * 100).toFixed(4)}%`);
}

if (failures.length) {
  console.error('\nDECK REFUSED\n');
  for (const f of failures) console.error(`  ✗ ${f}`);
  await rm(outAbs, { recursive: true, force: true });
  console.error('\nNo deck was left behind.');
  process.exit(3);
}

/*
 * The grader's instructions, and nothing else.
 *
 * Written by the tool rather than by hand so it cannot drift out of step with the deck it
 * describes, and so nobody can quietly add a sentence to it. What is deliberately absent:
 * any mention of the answer key or where it lives, any mention of what the other renderer
 * is, any hint of which subjects are in the deck, and any number that a grader could use as
 * a prior — including how many pairs are ours (it is exactly one per pair, and saying so is
 * necessary; saying anything more is not).
 */
await writeFile(path.join(outAbs, 'README.md'), `# Blind pair deck

${key.length} numbered pairs. Each pair is two frames, \`NN-A.png\` and \`NN-B.png\`, showing a
comparable subject. **In every pair, exactly one frame is from Total War: ROME II and the
other is not.** Which side it is on was randomised independently for each pair.

For each pair, decide which frame is Total War: ROME II.

Answer with one JSON array and nothing else:

\`\`\`json
[
  { "pair": "01", "pick": "A", "confidence": 3, "why": "...", "second": "..." }
]
\`\`\`

- \`pick\` — \`"A"\` or \`"B"\`.
- \`confidence\` — 1 (pure guess) to 5 (certain).
- \`why\` — the single most decisive thing you saw, in one sentence. Be specific and
  physical: name the surface, the edge, the light, the material, the geometry or the motion.
  "Looks more polished" is not usable. "Every shadow terminates in a hard step with no
  penumbra" is.
- \`second\` — a second reason if you had one, otherwise \`""\`.

Rules:

- Answer every pair. If you truly cannot tell, still pick one and set \`confidence\` to 1.
- View the images at 100%, not scaled to fit.
- Judge the rendering and the scene. The two frames in a pair were chosen to show
  comparable subjects, so subject matter is not the answer.
- Read nothing in this directory except the images and this file, and look at nothing
  outside it. Do not reverse-image-search anything.
`);

await writeFile(keyAbs, `${JSON.stringify({
  round: manifest.round ?? path.basename(outAbs),
  when: new Date().toISOString(),
  tool: 'tools/pair-deck.mjs',
  commit: COMMIT,
  seed: SEED,
  jpegGeneration: { quality: QUALITY, encoder: 'mozjpeg', chroma: '4:4:4' },
  ours: {
    dir: path.relative(ROOT, oursAbs), commit: rec.commit, hud: rec.hud,
    dpr: rec.dpr, worldOverlay: rec.worldOverlay, width: rec.width, height: rec.height,
  },
  refs: path.relative(ROOT, refsAbs),
  sideBalance: { oursAsA: aIsOurs, pairs: key.length },
  audit: { separability, picture, overlay, byteReport, windows },
  key,
}, null, 2)}\n`);

/*
 * The wordmark proof, written beside the key and never inside the deck.
 *
 * One tile per reference plate: the region the crop *discarded*, with the crop line drawn on
 * it in green. If a lockup is anywhere left of that line, it is visible here in one glance,
 * and the next round can re-check the measurement instead of inheriting it. This exists
 * because the 80%-of-height rule was inherited, was wrong on three plates, and put a legible
 * "TOTAL WAR / ROME II" into the first deck this tool built.
 */
{
  const TW = 300, TH = 200, COLS = 4;
  const tiles = [];
  for (const [i, k] of key.entries()) {
    const src = path.resolve(ROOT, k.romeSource);
    const meta = await sharp(src).metadata();
    const cropW = k.window.width;
    // Show a band straddling the crop line: 200 px inside it, everything outside it.
    const left = Math.max(0, cropW - 200);
    const strip = await sharp(src)
      .extract({ left, top: Math.max(0, meta.height - 420), width: meta.width - left, height: Math.min(420, meta.height) })
      .resize(TW, TH, { fit: 'fill' }).toBuffer();
    const xl = Math.round(((cropW - left) / (meta.width - left)) * TW);
    const svg = `<svg width="${TW}" height="${TH}">`
      + `<line x1="${xl}" y1="0" x2="${xl}" y2="${TH}" stroke="#00ff00" stroke-width="2"/>`
      + `<text x="5" y="16" font-size="14" fill="#ff00ff" font-family="monospace">`
      + `${path.basename(k.romeSource)} pair ${k.pair}</text></svg>`;
    tiles.push({
      input: await sharp(strip).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toBuffer(),
      top: Math.floor(i / COLS) * TH, left: (i % COLS) * TW,
    });
  }
  const proof = path.join(path.dirname(keyAbs), `${path.basename(keyAbs, '.json')}-wordmark-proof.png`);
  await sharp({
    create: { width: TW * COLS, height: TH * Math.ceil(key.length / COLS), channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(tiles).png().toFile(proof);
  console.log(`proof:    ${proof}  (the discarded band of each plate, crop line in green)`);
}

console.log(`key:      ${keyAbs}  (outside the deck; the README does not mention it)`);
console.log('DECK ACCEPTED');
