#!/usr/bin/env node
/**
 * Turn a QR symbol — or the terminal rendering of one — into a PNG, and read it back.
 *
 * ## Why a gate needs this
 *
 * `src/net/qr.ts` produces a matrix. A matrix is not a product: what the guest points a camera
 * at is a rendering, and every rendering is a chance to lose the symbol — a missing quiet zone,
 * a module that lands on half a device pixel, a terminal that draws light-on-dark. The repeated
 * failure this repository has shipped is a check that proves the *intermediate* value and calls
 * the product tested, so the assertion here is deliberately at the far end: render exactly what
 * a person will see, then decode the image with somebody else's decoder.
 *
 * **Somebody else's** is the whole point. Reading our own matrix back with our own code proves
 * the encoder agrees with itself. `tools/lib/qr-decode.swift` uses Vision, which is the decoder
 * an iPhone camera runs — so the pass condition is "the device this is aimed at can read it".
 *
 * ## The terminal path, which is the one nobody would think to check
 *
 * `qrHalfBlocks` writes one character per two module rows, with 24-bit colour escapes. Whether
 * that *scans* depends on a font, a cell aspect ratio and a terminal's colour handling, and no
 * amount of staring at the output settles it. `halfBlocksToPng` reconstructs the image the
 * terminal draws — two pixel rows per character row, foreground colour on top, background
 * underneath — and hands it to the same decoder. It is not a photograph of a terminal, and it
 * cannot speak for one terminal's font; what it does prove is that the glyph-to-module mapping
 * is faithful and the quiet zone survived, which is where the bugs actually are.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = import.meta.dirname;

/** A raw greyscale bitmap, ready for `sharp`. `data` is one byte a pixel, 0 dark, 255 light. */
const bitmap = (w, h) => ({ data: new Uint8Array(w * h).fill(255), width: w, height: h });

const toPng = async (bm) => {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(bm.data), { raw: { width: bm.width, height: bm.height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
};

/**
 * The symbol as a PNG, `scale` device pixels to a module, with its quiet zone.
 *
 * `scale` defaults to 8 rather than 1 because a decoder is not obliged to resolve a one-pixel
 * module and Vision in particular will not: at scale 1 a version-4 symbol is 41 px square and
 * comes back empty, which looks exactly like an encoder bug and is not one.
 */
export async function qrPng(symbol, { scale = 8, quiet = 4 } = {}) {
  const n = symbol.size + quiet * 2;
  const bm = bitmap(n * scale, n * scale);
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (!symbol.dark(x, y)) continue;
      const px = (x + quiet) * scale;
      const py = (y + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        bm.data.fill(0, (py + dy) * bm.width + px, (py + dy) * bm.width + px + scale);
      }
    }
  }
  return toPng(bm);
}

/**
 * The image a terminal draws for `qrHalfBlocks` output, at `scale` pixels a module.
 *
 * Each character row is two module rows: the upper half is painted in the foreground colour and
 * the lower half in the background colour, which is what `▀` means. `█` is both halves
 * foreground, `▄` is the lower half only, and a space is neither. The escape sequences set
 * black on white once per line; anything else in the string would be a bug in the renderer and
 * is refused here rather than guessed at.
 */
export function halfBlocksToPixels(text, { scale = 8 } = {}) {
  const lines = text.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
  const cols = Math.max(...lines.map((l) => [...l].length));
  const rows = lines.length * 2;
  const bm = bitmap(cols * scale, rows * scale);
  const paint = (cx, cy) => {
    const px = cx * scale;
    const py = cy * scale;
    for (let dy = 0; dy < scale; dy++) {
      bm.data.fill(0, (py + dy) * bm.width + px, (py + dy) * bm.width + px + scale);
    }
  };
  for (let r = 0; r < lines.length; r++) {
    const chars = [...lines[r]];
    for (let c = 0; c < chars.length; c++) {
      const ch = chars[c];
      if (ch === '█') { paint(c, r * 2); paint(c, r * 2 + 1); } else if (ch === '▀') { paint(c, r * 2); } else if (ch === '▄') { paint(c, r * 2 + 1); } else if (ch !== ' ') {
        throw new Error(`halfBlocksToPixels: '${ch}' is not one of the four half-block glyphs`);
      }
    }
  }
  return bm;
}

export async function halfBlocksToPng(text, opts = {}) {
  return toPng(halfBlocksToPixels(text, opts));
}

/**
 * Decode QR symbols out of PNG files, with Vision.
 *
 * Returns `Map<file, string[]>`. A file Vision cannot read comes back as an empty array rather
 * than an error, because "the decoder found nothing" is the finding a check wants to report.
 *
 * `swift` is present on any Mac with the Command Line Tools. Absent, this throws by name — a
 * gate that silently skipped the only independent instrument it has would be the exact shape of
 * check this file's docstring is complaining about.
 */
export async function decodeQr(files) {
  if (!files.length) return new Map();
  const out = await new Promise((resolve, reject) => {
    const p = spawn('swift', [path.join(HERE, 'qr-decode.swift'), ...files],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    p.stdout.on('data', (d) => { so += String(d); });
    p.stderr.on('data', (d) => { se += String(d); });
    p.on('error', (e) => reject(new Error(`swift could not be run (${e.message}). `
      + 'tools/lib/qr-decode.swift is the only independent QR decoder on this machine; '
      + 'install the Xcode Command Line Tools.')));
    p.on('exit', (code) => {
      if (code !== 0) reject(new Error(`qr-decode.swift exited ${code}: ${se.trim().slice(0, 400)}`));
      else resolve(so);
    });
  });
  const map = new Map();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    const j = JSON.parse(t);
    map.set(j.file, j.payloads);
  }
  return map;
}

/** `node tools/lib/qr-image.mjs <text> <out.png>` — a symbol, for looking at by hand. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [text, out] = process.argv.slice(2);
  if (!text || !out) {
    console.error('usage: node tools/lib/qr-image.mjs <text> <out.png>');
    process.exit(2);
  }
  const { qrEncode } = await import('../../src/net/qr.ts');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, await qrPng(qrEncode(text)));
  console.log(`wrote ${out}`);
}
