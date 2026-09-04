#!/usr/bin/env node
/**
 * Contact sheets for the press set, and previews of the Open Graph card at the sizes a link
 * unfurler actually draws it.
 *
 *   node tools/press-sheet.mjs                       # contact sheet of screenshots/press
 *   node tools/press-sheet.mjs --cards               # the card at Slack/iMessage/Discord/X
 *   node tools/press-sheet.mjs --shipped            # only the frames the manifest kept, in rank order
 *   node tools/press-sheet.mjs --keys=press-rome-line,press-rome-melee
 *   node tools/press-sheet.mjs --cols=3 --tile=520
 *
 * ## Why the card previews exist
 *
 * "The tags are present" is not a link preview. A card is judged at about a third of the width
 * it is authored at, letterboxed or centre-cropped by whichever client the reader happens to
 * use, on that client's background. The four widths below are measured from the clients this
 * project's link is most likely to be pasted into, and the crop rule for each is the one that
 * client applies. iMessage's near-square crop is the one that catches out a corner wordmark,
 * and it did: the first card built here came back reading "OTAL CLAUDE", which is why the
 * lockup in `tools/make-brand.mjs` is centred rather than inset by a guessed margin.
 *
 * Sheets go to `screenshots/press/` alongside the frames, which `.gitignore` already covers.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const DIR = path.resolve(ROOT, args.get('in') ?? 'screenshots/press');
const OUT = path.resolve(ROOT, args.get('out') ?? DIR);
const COLS = Number(args.get('cols') ?? 3);
const TILE = Number(args.get('tile') ?? 560);
const LABEL = 34;

const GOLD = '#d9b25f';
const INK = { r: 0x0b, g: 0x09, b: 0x07, alpha: 1 };

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * Which frames, and in what order.
 *
 * By default every `press-*.png` in the directory, alphabetically — the whole pass, including
 * the cameras that missed, which is what you want when you are judging a pass.
 *
 * `--shipped` instead reads `public/press/manifest.json` and shows exactly the frames that were
 * kept, **in the manifest's own rank order**. That is the sheet worth showing anybody: the
 * alphabetical one puts the hero seventh and mixes in the frames that photographed grass.
 */
async function selectFrames() {
  if (args.has('shipped')) {
    const mf = JSON.parse(await readFile(path.join(ROOT, 'public/press/manifest.json'), 'utf8'));
    return mf.frames.map((f) => `${f.id}.png`);
  }
  if (args.get('keys')) return String(args.get('keys')).split(',').map((k) => `${k.trim()}.png`);
  return (await readdir(DIR)).filter((f) => f.endsWith('.png') && f.startsWith('press-')).sort();
}

async function contactSheet() {
  const files = await selectFrames();
  if (!files.length) throw new Error(`no press-*.png in ${DIR}`);
  const th = Math.round((TILE * 9) / 16);
  const cellH = th + LABEL;
  const rows = Math.ceil(files.length / COLS);
  const composites = [];
  for (const [i, f] of files.entries()) {
    const left = (i % COLS) * TILE;
    const top = Math.floor(i / COLS) * cellH;
    composites.push({
      input: await sharp(path.join(DIR, f)).resize(TILE - 8, th - 8, { fit: 'cover' }).png().toBuffer(),
      left: left + 4, top: top + 4,
    });
    const name = f.replace(/^press-|\.png$/g, '');
    composites.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${LABEL}">
        <text x="6" y="22" fill="${GOLD}" font-family="Menlo, monospace" font-size="17">${esc(name)}</text>
      </svg>`),
      left, top: top + th,
    });
  }
  const file = path.join(OUT, 'contact-sheet.png');
  await sharp({ create: { width: TILE * COLS, height: cellH * rows, channels: 4, background: INK } })
    .composite(composites).png().toFile(file);
  console.log(`${path.relative(ROOT, file)}  ${files.length} frame(s), ${COLS} across`);
  return files;
}

/**
 * The four clients, and what each of them does to a 1.91:1 card.
 *
 * `w` is the rendered width in CSS pixels in that client's default window; `ratio` is the box
 * it draws, and anything other than 1.91 means the client crops rather than letterboxes.
 */
const CLIENTS = [
  { name: 'Slack (desktop unfurl)', w: 360, ratio: 1200 / 630, bg: '#1a1d21', fg: '#d1d2d3' },
  { name: 'iMessage (bubble)', w: 300, ratio: 1.28, bg: '#000000', fg: '#e8e8ed' },
  { name: 'Discord (embed)', w: 400, ratio: 1200 / 630, bg: '#313338', fg: '#dbdee1' },
  { name: 'X / summary_large_image', w: 506, ratio: 1.91, bg: '#000000', fg: '#e7e9ea' },
];

async function cardSheet() {
  const card = path.resolve(ROOT, args.get('card') ?? 'public/og/total-claude.jpg');
  if (!existsSync(card)) throw new Error(`no card at ${card} — run tools/make-brand.mjs`);
  const meta = await sharp(card).metadata();
  const PAD = 26;
  const CAP = 30;
  const tiles = [];
  for (const c of CLIENTS) {
    const h = Math.round(c.w / c.ratio);
    const img = await sharp(card).resize(c.w, h, { fit: 'cover', position: 'centre' }).png().toBuffer();
    const cw = c.w + PAD * 2;
    const ch = h + PAD * 2 + CAP;
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${CAP}">
      <text x="${PAD}" y="20" fill="${c.fg}" font-family="Menlo, monospace" font-size="14"
        >${esc(c.name)} — ${c.w}x${h}</text></svg>`;
    tiles.push({
      w: cw,
      h: ch,
      buf: await sharp({ create: { width: cw, height: ch, channels: 4, background: c.bg } })
        .composite([
          { input: img, left: PAD, top: PAD },
          { input: Buffer.from(label), left: 0, top: h + PAD + 4 },
        ]).png().toBuffer(),
    });
  }
  const W = Math.max(...tiles.map((t) => t.w)) * 2;
  const rowH = [Math.max(tiles[0].h, tiles[1].h), Math.max(tiles[2].h, tiles[3].h)];
  const composites = tiles.map((t, i) => ({
    input: t.buf,
    left: (i % 2) * (W / 2),
    top: i < 2 ? 0 : rowH[0],
  }));
  const file = path.join(OUT, 'og-previews.png');
  await mkdir(OUT, { recursive: true });
  await sharp({ create: { width: W, height: rowH[0] + rowH[1], channels: 4, background: INK } })
    .composite(composites).png().toFile(file);
  console.log(`${path.relative(ROOT, file)}  card is ${meta.width}x${meta.height} ${meta.format}`);
}

await mkdir(OUT, { recursive: true });
if (args.has('cards')) await cardSheet();
else await contactSheet();
