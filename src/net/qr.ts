/**
 * A QR encoder, in one file, with no dependency and one copy.
 *
 * ## Why this is here at all
 *
 * The room code was never the hard part of playing on a LAN. The hard part is that a browser
 * needs a *page* before a code can mean anything, and the only machine on the network that has
 * one to give is the host — so the guest has to be handed an address, and an address typed by
 * hand off somebody else's screen is four dotted numbers, a colon, a port and a five-character
 * code. A QR is the whole of that, at arm's length, with nothing typed.
 *
 * ## Why it is written rather than installed
 *
 * `package.json` has **one** runtime dependency (`three`) and this project generates its own
 * textures, its own city and all 89 of its sounds; `ASSETS.md` requires a licence check for
 * anything added. A QR symbol is a Reed–Solomon code over GF(256) and eight mask candidates
 * scored by four penalty rules — about 300 lines, all of it specified by ISO/IEC 18004 and none
 * of it subject to change. `qrcode` on npm is 12 files and pulls a CLI, a PNG writer and
 * `yargs`. The trade is not close.
 *
 * ## Why *this* file and not two
 *
 * `tools/host-lan.mjs` prints the symbol into a terminal and `src/ui/NetLobby.ts` draws it on
 * the host's screen, and they must be the same symbol: the whole claim is that scanning either
 * one lands the guest in the same room. Node 24 strips types from a `.ts` import at load, which
 * `tools/relay.mjs` already relies on for `src/net/protocol.ts` — so both callers read one
 * encoder. That constraint is why nothing in here uses `enum`, `namespace`, a parameter
 * property or `declare`: those do not erase, and a second copy of a codec is the failure mode
 * `stateHash.ts` exists to document.
 *
 * ## Error correction: Q, not L, and the reason is the camera
 *
 * The symbol is going to be photographed off a glossy laptop screen at an angle, or off a
 * terminal whose font renders a module as half a character cell. Level Q recovers 25% of the
 * codewords against L's 7%, for one version step on the payloads this project produces —
 * `http://192.168.1.77:5958/?room=ABCDE` is 36 bytes, which is version 3 at L and version 4 at
 * Q, i.e. 29×29 against 33×33. Four modules of side length is a price worth paying for a
 * fourfold increase in what a thumb over the corner can cost you.
 *
 * ## The ceiling, stated
 *
 * Versions 1 to 10, which is 213 bytes at Q and 271 at M. Every URL this repository builds is
 * under 120. Beyond that `qrEncode` throws by name rather than silently truncating, because a
 * QR that encodes half a URL is a QR that scans perfectly and goes to the wrong place. The
 * block table for versions 11–40 is another 120 rows of data that nothing here would exercise,
 * and an untested table is worse than an absent one.
 */

/** Error-correction level. Q recovers about 25% of the codewords; see the file docstring. */
export type Ecc = 'L' | 'M' | 'Q' | 'H';

/**
 * A finished symbol. `dark(x, y)` is the only accessor a renderer needs.
 *
 * `modules` is row-major, one byte per module, 1 for dark. A `Uint8Array` rather than a
 * `boolean[][]` because both renderers walk it twice per row and the terminal one walks two
 * rows at a time.
 */
export interface QrSymbol {
  version: number;
  ecc: Ecc;
  /** Side length in modules, `17 + 4 * version`. */
  size: number;
  modules: Uint8Array;
  dark: (x: number, y: number) => boolean;
}

// ---------------------------------------------------------------------------
// The tables. ISO/IEC 18004 Table 9 (block structure) and Table E.1 (alignment).
// ---------------------------------------------------------------------------

/**
 * Per version 1–10: `[ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]`.
 *
 * Checked against the total-codeword count for every one of the forty entries — the sum
 * `ec * (g1 + g2) + g1 * d1 + g2 * d2` must equal 26, 44, 70, 100, 134, 172, 196, 242, 292, 346
 * for versions 1 to 10. `tools/qa-net.mjs`'s `qr-tables-sum` asserts exactly that at run time,
 * because a single mistyped digit in here produces a symbol that is structurally valid, scans,
 * and decodes to rubbish — the one class of bug an eyeball over a rendered image cannot catch.
 */
const BLOCKS: Record<Ecc, number[][]> = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

/** Total codewords per version, 1–10. The cross-check `BLOCKS` is validated against. */
export const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Alignment-pattern centre coordinates per version, 1–10. */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** The two-bit level indicator that goes into the format information. Not the array order. */
const ECC_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

export const MAX_VERSION = 10;

// ---------------------------------------------------------------------------
// GF(256), with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial of degree `n`, highest coefficient first, monic. */
const generator = (n: number): number[] => {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
};

/** The `ecLen` Reed–Solomon check codewords for one block. */
const rsBlock = (data: Uint8Array, ecLen: number): Uint8Array => {
  const g = generator(ecLen);
  const res = new Uint8Array(ecLen);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] ^= gmul(g[i + 1], factor);
  }
  return res;
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Byte mode only, and that is a decision rather than an omission.
 *
 * Alphanumeric mode would pack `HTTP://192.168.1.77:5958/?ROOM=ABCDE` at 5.5 bits a character
 * instead of 8 — but only in upper case, and the query string of a URL is case-sensitive while
 * the host part is not. A mode that is correct for four fifths of the payload is a mode that
 * produces a symbol which scans and opens the wrong page. Byte mode costs one version step on
 * the strings this project builds and is right for all of them.
 */
const MODE_BYTE = 4;
const charCountBits = (version: number): number => (version <= 9 ? 8 : 16);

const dataCodewords = (version: number, ecc: Ecc): number => {
  const [, g1, d1, g2, d2] = BLOCKS[ecc][version - 1];
  return g1 * d1 + g2 * d2;
};

/**
 * How many bytes of payload fit in one version at one level.
 *
 * Exported for one caller and it is a gate: `tools/qa-net.mjs`'s `qr` arm fills every one of
 * the forty (version, level) pairs to exactly this many bytes and requires Vision to read each
 * one back. That is what stands in for a hand-audit of `BLOCKS` — a mistyped digit there
 * changes a block boundary, which changes where the Reed–Solomon check codewords land, which
 * makes the symbol decode to something other than what went in. Forty exact round trips is a
 * stronger statement than any arithmetic identity over the table itself, because the identity
 * would also hold for two mistakes that agreed.
 */
export const capacityBytes = (version: number, ecc: Ecc): number =>
  Math.floor((dataCodewords(version, ecc) * 8 - 4 - charCountBits(version)) / 8);

/** Interleaved data + EC codewords, in the order they are placed. */
const codewords = (bytes: Uint8Array, version: number, ecc: Ecc): Uint8Array => {
  const [ecLen, g1, d1, g2, d2] = BLOCKS[ecc][version - 1];
  const total = dataCodewords(version, ecc);

  const bits: number[] = [];
  const push = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(MODE_BYTE, 4);
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);
  // Terminator, then to a byte boundary, then the specified alternating pad.
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data[i / 8] = v;
  }
  for (let i = bits.length / 8, pad = 0; i < total; i++, pad++) data[i] = pad % 2 === 0 ? 0xec : 0x11;

  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let at = 0;
  for (const [n, len] of [[g1, d1], [g2, d2]]) {
    for (let i = 0; i < n; i++) {
      const chunk = data.subarray(at, at + len);
      at += len;
      blocks.push({ data: chunk, ec: rsBlock(chunk, ecLen) });
    }
  }

  const out = new Uint8Array(total + ecLen * blocks.length);
  let k = 0;
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.data.length) out[k++] = b.data[i];
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) out[k++] = b.ec[i];
  }
  return out;
};

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The four penalty rules of §7.8.3.1, scored over all eight masks; lowest wins.
 *
 * Not optional and not a nicety: an unmasked symbol of a URL has long runs of light modules in
 * the padding region and a scanner's binariser loses the module grid across them. The rule that
 * earns its keep here is N3 — the 1:1:3:1:1 finder-lookalike — because a payload that happens to
 * contain one is a symbol that decodes on a phone held still and fails on one held by a person.
 */
const penalty = (mod: Uint8Array, size: number): number => {
  const at = (x: number, y: number): number => mod[y * size + x];
  let score = 0;
  // N1: runs of five or more of the same colour, in both directions.
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = axis === 0 ? at(0, a) : at(a, 0);
      for (let b = 1; b < size; b++) {
        const v = axis === 0 ? at(b, a) : at(a, b);
        if (v === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          prev = v;
          run = 1;
        }
      }
    }
  }
  // N2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }
  // N3: the 1:1:3:1:1 pattern with four light modules on either side.
  const finder = [1, 0, 1, 1, 1, 0, 1];
  for (let axis = 0; axis < 2; axis++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 6 < size; b++) {
        let hit = true;
        for (let i = 0; i < 7 && hit; i++) {
          const v = axis === 0 ? at(b + i, a) : at(a, b + i);
          if (v !== finder[i]) hit = false;
        }
        if (!hit) continue;
        const clear = (from: number, to: number): boolean => {
          for (let i = from; i <= to; i++) {
            if (i < 0 || i >= size) continue;
            if ((axis === 0 ? at(i, a) : at(a, i)) !== 0) return false;
          }
          return true;
        };
        if (clear(b - 4, b - 1) || clear(b + 7, b + 10)) score += 40;
      }
    }
  }
  // N4: deviation of the dark-module proportion from one half.
  let dark = 0;
  for (let i = 0; i < mod.length; i++) dark += mod[i];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
};

/** Draw everything that is not data, and mark it reserved. */
const drawFunctions = (mod: Uint8Array, fn: Uint8Array, size: number, version: number): void => {
  const put = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mod[y * size + x] = dark ? 1 : 0;
    fn[y * size + x] = 1;
  };
  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        put(fx + dx, fy + dy, d <= 3 && d !== 2);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    put(i, 6, i % 2 === 0);
    put(6, i, i % 2 === 0);
  }
  const centres = ALIGN[version - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      // The three that would sit on a finder are not drawn.
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserve the format-information strips. Values are written after a mask is chosen.
  for (let i = 0; i <= 8; i++) {
    put(8, i, false);
    put(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    put(size - 1 - i, 8, false);
    put(8, size - 1 - i, false);
  }
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      put(a, b, bit);
      put(b, a, bit);
    }
  }
};

const drawFormat = (mod: Uint8Array, size: number, ecc: Ecc, mask: number): void => {
  const value = (ECC_BITS[ecc] << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((value << 10) | rem) ^ 0x5412) >>> 0;
  const bit = (i: number): number => (bits >>> i) & 1;
  const put = (x: number, y: number, v: number): void => { mod[y * size + x] = v; };
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
  put(8, size - 8, 1); // The module that is always dark.
};

/**
 * Encode `text` as a QR symbol.
 *
 * `ecc` defaults to Q — see the file docstring; the symbol is going to be photographed.
 * `minVersion` forces a larger, and therefore coarser, symbol: a terminal renders a module as
 * half a character cell, and a phone camera has an easier time with 33 large modules than with
 * 25 small ones when the whole thing is 60 mm wide on a screen.
 */
export function qrEncode(text: string, opts: { ecc?: Ecc; minVersion?: number } = {}): QrSymbol {
  const ecc = opts.ecc ?? 'Q';
  const minVersion = Math.max(1, Math.min(MAX_VERSION, opts.minVersion ?? 1));
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = minVersion; v <= MAX_VERSION; v++) {
    if (4 + charCountBits(v) + 8 * bytes.length <= dataCodewords(v, ecc) * 8) { version = v; break; }
  }
  if (!version) {
    throw new Error(`qrEncode: ${bytes.length} bytes does not fit in a version-${MAX_VERSION} `
      + `symbol at level ${ecc} (${dataCodewords(MAX_VERSION, ecc)} data codewords). `
      + 'Shorten the payload; this encoder deliberately stops at version 10.');
  }

  const size = 17 + 4 * version;
  const mod = new Uint8Array(size * size);
  const fn = new Uint8Array(size * size);
  drawFunctions(mod, fn, size, version);

  const cw = codewords(bytes, version, ecc);
  let bit = 0;
  const total = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y * size + x]) continue;
        let dark = 0;
        if (bit < total) {
          dark = (cw[bit >>> 3] >>> (7 - (bit & 7))) & 1;
          bit++;
        }
        mod[y * size + x] = dark;
      }
    }
  }

  // Eight candidates, scored; the mask is part of the symbol, not a preference.
  let best = 0;
  let bestScore = Infinity;
  const trial = new Uint8Array(size * size);
  for (let m = 0; m < 8; m++) {
    trial.set(mod);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fn[y * size + x] && MASKS[m](x, y)) trial[y * size + x] ^= 1;
      }
    }
    drawFormat(trial, size, ecc, m);
    const s = penalty(trial, size);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y * size + x] && MASKS[best](x, y)) mod[y * size + x] ^= 1;
    }
  }
  drawFormat(mod, size, ecc, best);

  return {
    version,
    ecc,
    size,
    modules: mod,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && mod[y * size + x] === 1,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The quiet zone. Four modules, which is what the specification requires and what a scanner
 * uses to find the symbol at all.
 *
 * Named rather than inlined because both renderers need the same number and a QR printed hard
 * against a terminal's left margin — or against a dark panel background — is the single most
 * common way a symbol that is otherwise perfect fails to scan.
 */
export const QUIET = 4;

/**
 * The symbol as terminal text, two module rows to a line of half blocks.
 *
 * `▀` is drawn in the foreground colour over the background colour, so one character carries
 * two vertically adjacent modules — which matters because a character cell is about twice as
 * tall as it is wide, and one module per cell would produce a symbol stretched 2:1 that many
 * scanners refuse.
 *
 * The colours are stated in 24-bit escapes rather than left to the terminal. A QR is dark
 * modules on a light field; a terminal is usually the opposite, and a scanner that meets an
 * inverted symbol is entitled to give up. Setting both colours per line — not per module —
 * costs 20 bytes a row and removes the theme from the equation entirely.
 */
export function qrHalfBlocks(q: QrSymbol, quiet: number = QUIET): string {
  const n = q.size + quiet * 2;
  const on = '\u001b[48;2;255;255;255m\u001b[38;2;0;0;0m';
  const off = '\u001b[0m';
  const dark = (x: number, y: number): boolean => q.dark(x - quiet, y - quiet);
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let row = on;
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < n && dark(x, y + 1);
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(row + off);
  }
  return lines.join('\n');
}

/**
 * The symbol as an SVG document, for the host's own screen.
 *
 * One `<path>` of `Mx y h1 v1 h-1 z` sub-paths rather than a rectangle per module: a version-4
 * symbol is 1,089 modules and about half of them are dark, and 550 DOM nodes inside a lobby
 * panel is a measurable layout cost for something that never changes. `shape-rendering:
 * crispEdges` is not decoration — an anti-aliased module edge at a non-integer device pixel is
 * exactly the grey a binariser has to guess about.
 */
export function qrSvg(q: QrSymbol, opts: { quiet?: number; size?: number } = {}): string {
  const quiet = opts.quiet ?? QUIET;
  const n = q.size + quiet * 2;
  let d = '';
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (q.dark(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const px = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"${px} `
    + 'shape-rendering="crispEdges" role="img">'
    + `<rect width="${n}" height="${n}" fill="#fff"/>`
    + `<path d="${d}" fill="#000"/></svg>`;
}
