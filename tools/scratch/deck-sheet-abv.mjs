#!/usr/bin/env node
/**
 * Contact sheet of a built pair deck, ordered by the answer key, for the *builder's* own
 * final look. Not for a grader: it is labelled with which side is which.
 *
 * The automated gates in `tools/pair-deck.mjs` catch the leaks anybody has thought of. This
 * catches the ones nobody has — a frame that came back as black mud, a subject pairing that
 * turned out absurd once both images were beside each other, a piece of interface that the
 * overlay audit missed because it only appeared in one frame.
 *
 *   node tools/scratch/deck-sheet-abv.mjs --key=/tmp/tc-ab/keys/round-1.json --out=/tmp/x.png
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const KEY = args.get('key');
const DECK = args.get('deck');
const OUT = args.get('out') ?? '/tmp/tc-ab/deck-sheet.png';
const W = Number(args.get('w') ?? 620);

const key = JSON.parse(await readFile(KEY, 'utf8'));
const deck = DECK ?? path.resolve(path.dirname(KEY), '..', key.round ?? 'round-1');

const rows = [];
for (const k of key.key) {
  const h = Math.round(W * (k.window.height / k.window.width));
  const label = (f, who) => Buffer.from(
    `<svg width="${W}" height="26"><rect width="${W}" height="26" fill="#000"/>`
    + `<text x="6" y="19" font-size="17" font-family="monospace" fill="${who === 'OURS' ? '#0f0' : '#ff0'}">`
    + `${k.pair} ${f} ${who} — ${k.subject}</text></svg>`
  );
  const a = await sharp(path.join(deck, `${k.pair}-A.png`)).resize(W, h, { fit: 'fill' }).toBuffer();
  const b = await sharp(path.join(deck, `${k.pair}-B.png`)).resize(W, h, { fit: 'fill' }).toBuffer();
  const aWho = k.ours.endsWith('-A.png') ? 'OURS' : 'ROME II';
  const bWho = aWho === 'OURS' ? 'ROME II' : 'OURS';
  rows.push({
    h: h + 26,
    tiles: [
      { input: label('A', aWho), top: 0, left: 0 },
      { input: label('B', bWho), top: 0, left: W + 8 },
      { input: a, top: 26, left: 0 },
      { input: b, top: 26, left: W + 8 },
    ],
  });
}

const total = rows.reduce((s, r) => s + r.h + 6, 0);
const composite = [];
let y = 0;
for (const r of rows) {
  for (const t of r.tiles) composite.push({ ...t, top: t.top + y });
  y += r.h + 6;
}
await sharp({ create: { width: W * 2 + 8, height: total, channels: 3, background: { r: 60, g: 0, b: 0 } } })
  .composite(composite).png().toFile(OUT);
console.log(`${rows.length} pairs -> ${OUT}`);
