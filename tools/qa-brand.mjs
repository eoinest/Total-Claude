#!/usr/bin/env node
/**
 * The half of the site dressing that can fail.
 *
 *   node tools/qa-brand.mjs                 # against a dev server on 5197
 *   node tools/qa-brand.mjs --dist          # against a built dist/, the way Vercel serves it
 *   node tools/qa-brand.mjs --port=5902
 *
 * ## What this is for
 *
 * **A check that asserts a `<meta>` tag exists is the kind that cannot fail in the way that
 * matters.** This repository has a documented history of exactly that shape — a gate green
 * because the harness never asked the question — and the icon comment in `index.html` is about
 * one of them: three `qa-net` arms asserted a page raised no console error and passed for
 * months only because Playwright's old headless shell never requested a favicon.
 *
 * So none of the arms below read the HTML and stop. Every one of them **fetches the URL off a
 * running server, reads the bytes, and decodes them.** The three questions that actually decide
 * whether a link preview works are:
 *
 *   1. does the file the tag names exist, at that exact URL, on the server that will serve it;
 *   2. are its real decoded pixel dimensions the ones the tag claims;
 *   3. is it the picture, or is it a placeholder that happens to be 1200x630.
 *
 * The third is the one nobody writes, so it is written here: the card is measured for contrast
 * and detail, and a flat fill, a gradient or a single-colour plate fails it.
 *
 * ## Arms
 *
 *   head         every `<link href>` and `<meta content>` URL in both entry HTMLs, on both
 *                pages, fetched: status, content-type, and decoded dimensions for images.
 *   og           the card is a real 1200x630 JPEG with real image statistics, its declared
 *                `og:image:width`/`height` match its pixels, `og:image` is absolute, and the
 *                Twitter pair is present and consistent.
 *   tags         the tags a person reads: description length, canonical, theme-color,
 *                `twitter:card` = summary_large_image, `og:type`, `og:site_name`, `og:url`.
 *   icons        the favicon renders at 16 px with enough ink to be a shape rather than a
 *                smudge, and identically against a light and a dark tab, and the ICO container
 *                parses and holds the sizes it claims.
 *   palette      `tools/make-brand.mjs`'s copy of the HUD palette still matches
 *                `src/ui/hud.css`, and `theme-color` matches both.
 *   set          `public/press/manifest.json`, `src/ui/pressPlates.ts` and the files on disk
 *                agree: no name in either that the directory lacks, no file in the directory
 *                that neither names, and every rendition's declared size is its real size.
 *   drift        if the source frames are present, the generated module is re-derived from
 *                them and compared byte for byte with the checked-in copy.
 *
 * Exit code is the number of failed arms, so it is usable as a gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { startVite } from './lib/browser-budget.mjs';
import { BRAND, PLATES, plateModuleText } from './make-brand.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5197);
const DIST = args.has('dist');
const FRAMES = path.resolve(ROOT, args.get('frames') ?? 'screenshots/press');
const SITE = 'https://total-claude.vercel.app';

let failures = 0;
const results = [];
function arm(name, fn) {
  return { name, fn };
}
const problems = [];
const fail = (msg) => { problems.push(msg); };

// ---------------------------------------------------------------------------
// Head parsing. Deliberately regex rather than a DOM: this file must be able to
// run with no browser and no dependency beyond sharp, and the question it asks
// of the HTML is "which URLs and which content strings", not "what is the tree".
// ---------------------------------------------------------------------------

function headOf(html) {
  const links = [...html.matchAll(/<link\b([^>]*)>/g)].map((m) => attrs(m[1]));
  const metas = [...html.matchAll(/<meta\b([^>]*)>/gs)].map((m) => attrs(m[1]));
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;
  return { links, metas, title };
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** `<meta name=x>` or `<meta property=x>`, whichever the tag used. */
const meta = (h, key) => h.metas.find((m) => m.name === key || m.property === key)?.content ?? null;

// ---------------------------------------------------------------------------

async function fetchOk(base, url) {
  const abs = url.startsWith('http') ? url : `${base}${url}`;
  const r = await fetch(abs, { signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') ?? '', bytes: buf.length, buf, abs };
}

/**
 * The ICO container, read rather than trusted.
 *
 * 6-byte `ICONDIR`, then one 16-byte `ICONDIRENTRY` per image, each with an offset and a
 * length pointing at a payload — a PNG, in every icon this project writes. Returns the largest
 * payload, and throws if any entry points outside the file, which is the way a hand-rolled
 * container is wrong.
 */
function icoEntries(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('not an ICO container');
  }
  const count = buf.readUInt16LE(4);
  if (count < 1 || buf.length < 6 + count * 16) throw new Error('ICO directory is truncated');
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf.readUInt8(e) || 256;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (off + len > buf.length) throw new Error(`ICO entry ${i} points past the end of the file`);
    out.push({ size, data: buf.subarray(off, off + len) });
  }
  return out;
}

const largestIcoImage = (buf) =>
  icoEntries(buf).sort((a, b) => b.size - a.size)[0].data;

/**
 * Is this a picture, or a placeholder that happens to have the right dimensions?
 *
 * Three statistics, and all three have to pass, because each one alone has a cheap fake:
 * a flat fill has zero standard deviation; a linear gradient has a healthy standard deviation
 * and almost no *local* variation; and a two-tone mock has both of those and only a handful of
 * distinct colours. A render of nine thousand men in grass has all three by a mile.
 *
 * ## The thresholds are measured, not guessed
 *
 * They were set by building the artefact the brief forbids — a wordmark on a gradient at
 * 1200x630 — and measuring it beside the real thing. `PLACEHOLDER` below rebuilds that same
 * artefact on every run and the `og` arm asserts these thresholds still *reject* it, so this
 * cannot quietly decay into a check that passes everything.
 *
 *     artefact                          sd    detail  colours
 *     flat fill                       0.00      0.00        1
 *     wordmark on a gradient         12.99      4.11      134
 *     ── thresholds ──               20.00      8.00      250
 *     the card                       39.58     21.98      424
 *     press-rome-city (real frame)   33.60     16.25      441
 *     press-carth-wall (real frame)  28.69     16.82      490
 *     press-rome-melee (real frame)  36.96     25.21      728
 *
 * The narrowest margin is `colours`, where the card is 424 against a threshold of 250 and the
 * placeholder is 134. A first draft of this used 500 and failed the real card, which is how the
 * numbers above came to be measured at all.
 */
const PHOTO_MIN = { sd: 20, detail: 8, colours: 250 };

/** The exact thing this is meant to catch, rebuilt each run so the detector is self-testing. */
const PLACEHOLDER = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#241a10"/><stop offset="1" stop-color="#0a0906"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="600" y="330" fill="#d9b25f" text-anchor="middle" font-size="72"
        font-family="serif">TOTAL CLAUDE</text>
</svg>`);
async function looksLikeAPhotograph(buf) {
  const { data, info } = await sharp(buf).resize(240, 126, { fit: 'fill' }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const grey = new Float64Array(n);
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    grey[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Quantised to 5 bits a channel: enough to tell "a few flat colours" from "a photograph".
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  const mean = grey.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(grey.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  // Mean absolute Laplacian: local detail. A gradient scores near zero here and a photo does not.
  let lap = 0, m = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      lap += Math.abs(4 * grey[i] - grey[i - 1] - grey[i + 1]
        - grey[i - info.width] - grey[i + info.width]);
      m++;
    }
  }
  return { sd: +sd.toFixed(2), detail: +(lap / m).toFixed(2), colours: seen.size };
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

async function armHead(base) {
  const pages = ['/', '/viewer.html'];
  let checked = 0;
  for (const page of pages) {
    const r = await fetchOk(base, page);
    if (r.status !== 200) { fail(`${page} is ${r.status}`); continue; }
    const h = headOf(r.buf.toString('utf8'));

    // Every URL this document declares, whether icon, manifest or preview image.
    const urls = new Set();
    for (const l of h.links) if (l.href && !l.href.startsWith('data:') && !l.href.startsWith('http')) urls.add(l.href);
    for (const key of ['og:image', 'twitter:image']) {
      const v = meta(h, key);
      if (v) urls.add(v.replace(SITE, ''));
    }
    if (!urls.size) fail(`${page} declares no icon or preview URL at all`);

    for (const u of urls) {
      const got = await fetchOk(base, u);
      checked++;
      if (got.status !== 200) { fail(`${page} declares ${u} → HTTP ${got.status}`); continue; }
      if (got.bytes === 0) { fail(`${page} declares ${u} → 200 with an empty body`); continue; }
      /*
       * A 200 is not proof the file is there, and this is the hole that nearly made this
       * whole check decorative.
       *
       * **Vite's dev server answers a missing static file with `index.html` and status 200.**
       * So `status !== 200` cannot see a missing icon here at all; a mutation test that
       * pointed `apple-touch-icon` at a name that does not exist came back 200, and the only
       * reason the arm failed was that sharp then choked trying to parse HTML as an image —
       * which is luck, and reported as `Entity 'hellip' not defined`, which is not a
       * diagnosis. On Vercel the same request is a genuine 404, so the *dev* run was the one
       * that could be fooled, and the dev run is the one anybody actually does.
       *
       * The content type is the honest question: an `.png` served as `text/html` is the
       * fallback page wearing the file's name.
       */
      const wantType = {
        '.png': /image\/png/, '.jpg': /image\/jpeg/, '.jpeg': /image\/jpeg/,
        '.webp': /image\/webp/, '.avif': /image\/avif/, '.svg': /image\/svg/,
        '.ico': /image\/(x-icon|vnd\.microsoft\.icon)/,
        '.webmanifest': /manifest\+json|application\/json/, '.json': /application\/json/,
      }[path.extname(u).toLowerCase()];
      if (wantType && !wantType.test(got.type)) {
        fail(`${page} declares ${u} → 200 as "${got.type}", which is not what a `
          + `${path.extname(u)} is. On the dev server a missing file is answered with `
          + 'index.html and a 200, so this is what a 404 looks like here');
        continue;
      }
      if (/\.(png|jpg|jpeg|webp|avif|ico|svg)$/.test(u)) {
        try {
          // sharp has no ICO decoder, so an `.ico` is opened as the container it is and the
          // largest PNG inside it is what gets decoded. Skipping it instead would leave the
          // one icon that non-browsers fetch by path as the one icon nothing ever opened.
          const m2 = u.endsWith('.ico')
            ? await sharp(largestIcoImage(got.buf)).metadata()
            : await sharp(got.buf).metadata();
          if (!m2.width || !m2.height) fail(`${u} did not decode as an image`);
          // The size a `sizes=` attribute claims has to be the size the file is.
          const claim = h.links.find((l) => l.href === u && /^\d+x\d+$/.test(l.sizes ?? ''));
          if (claim) {
            const [cw, ch] = claim.sizes.split('x').map(Number);
            // An .ico holds several sizes; sharp reports the largest. Only check the others.
            if (!u.endsWith('.ico') && (m2.width !== cw || m2.height !== ch)) {
              fail(`${u} declares sizes="${claim.sizes}" and decodes as ${m2.width}x${m2.height}`);
            }
          }
        } catch (e) { fail(`${u} did not decode: ${e.message}`); }
      }
      if (u.endsWith('.webmanifest')) {
        if (!/manifest\+json|application\/json/.test(got.type)) {
          fail(`${u} served as "${got.type}" — Chrome rejects a manifest that is not `
            + 'application/manifest+json, and logs a console error doing it');
        }
        const mf = JSON.parse(got.buf.toString('utf8'));
        for (const ic of mf.icons ?? []) {
          const g = await fetchOk(base, ic.src);
          checked++;
          if (g.status !== 200) fail(`${u} names icon ${ic.src} → HTTP ${g.status}`);
        }
      }
    }
  }
  return `${checked} declared URL(s) fetched and decoded across ${pages.length} pages`;
}

async function armOg(base) {
  const html = (await fetchOk(base, '/')).buf.toString('utf8');
  const h = headOf(html);
  const img = meta(h, 'og:image');
  if (!img) { fail('no og:image'); return 'no card'; }
  if (!img.startsWith('http')) {
    fail(`og:image is "${img}" — it must be absolute; every unfurler ignores a relative one, `
      + 'and this is the single most common way a card silently ships as a grey rectangle');
  }
  const got = await fetchOk(base, img.replace(SITE, ''));
  if (got.status !== 200) { fail(`og:image → HTTP ${got.status}`); return 'card missing'; }
  const m = await sharp(got.buf).metadata();
  const dw = Number(meta(h, 'og:image:width'));
  const dh = Number(meta(h, 'og:image:height'));
  if (m.width !== dw || m.height !== dh) {
    fail(`og:image:width/height say ${dw}x${dh}, the file is ${m.width}x${m.height}`);
  }
  if (m.width !== 1200 || m.height !== 630) fail(`card is ${m.width}x${m.height}, not 1200x630`);
  if (m.format !== 'jpeg' && m.format !== 'png') fail(`card is ${m.format}; unfurlers want JPEG or PNG`);
  // Facebook's documented ceiling is 8 MB and Twitter's is 5; anything over 1 MB here is a
  // mistake rather than a picture.
  if (got.bytes > 1024 * 1024) fail(`card is ${(got.bytes / 1024).toFixed(0)} kB — over 1 MB`);

  // The detector, tested before it is trusted. If the thresholds have drifted far enough to
  // accept a wordmark on a gradient, they are no longer evidence that the card is a frame.
  const ph = await looksLikeAPhotograph(await sharp(PLACEHOLDER).jpeg({ quality: 84 }).toBuffer());
  if (ph.sd >= PHOTO_MIN.sd && ph.detail >= PHOTO_MIN.detail && ph.colours >= PHOTO_MIN.colours) {
    fail(`the placeholder detector accepts a wordmark on a gradient (sd ${ph.sd}, detail `
      + `${ph.detail}, colours ${ph.colours}) — its thresholds are decoration`);
  }

  const s = await looksLikeAPhotograph(got.buf);
  if (s.sd < PHOTO_MIN.sd) fail(`card has luminance sd ${s.sd} (< ${PHOTO_MIN.sd}) — that is a flat fill, not a frame`);
  if (s.detail < PHOTO_MIN.detail) fail(`card has local detail ${s.detail} (< ${PHOTO_MIN.detail}) — that is a gradient, not a frame`);
  if (s.colours < PHOTO_MIN.colours) fail(`card has ${s.colours} distinct colours (< ${PHOTO_MIN.colours}) — that is a mock-up`);

  if (!meta(h, 'og:image:alt')) fail('no og:image:alt');
  if (meta(h, 'twitter:card') !== 'summary_large_image') {
    fail(`twitter:card is "${meta(h, 'twitter:card')}", not summary_large_image`);
  }
  if (!meta(h, 'twitter:image')) fail('twitter:card is summary_large_image with no twitter:image');
  if (meta(h, 'twitter:image') !== img) fail('twitter:image and og:image disagree');
  return `1200x630 ${m.format}, ${(got.bytes / 1024).toFixed(0)} kB, `
    + `sd ${s.sd} detail ${s.detail} colours ${s.colours}`;
}

async function armTags(base) {
  let n = 0;
  for (const page of ['/', '/viewer.html']) {
    const h = headOf((await fetchOk(base, page)).buf.toString('utf8'));
    const d = meta(h, 'description');
    if (!d) fail(`${page} has no meta description`);
    // Google truncates around 160; under 60 is a keyword stub rather than a sentence.
    else if (d.length < 60 || d.length > 200) fail(`${page} description is ${d.length} chars (want 60-200)`);
    else if (!/[.!?]/.test(d)) fail(`${page} description is not a sentence`);
    if (!h.title || h.title.length < 10) fail(`${page} has no usable <title>`);
    const canon = h.links.find((l) => l.rel === 'canonical')?.href;
    if (!canon) fail(`${page} has no canonical link`);
    else if (!canon.startsWith(SITE)) fail(`${page} canonical is ${canon}, not under ${SITE}`);
    const theme = meta(h, 'theme-color');
    if (!theme) fail(`${page} has no theme-color`);
    else if (theme.toLowerCase() !== BRAND.ink) fail(`${page} theme-color ${theme} != ${BRAND.ink}`);
    for (const k of ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description']) {
      if (!meta(h, k)) fail(`${page} has no ${k}`);
    }
    const ogUrl = meta(h, 'og:url');
    if (ogUrl && canon && ogUrl !== canon) fail(`${page}: og:url ${ogUrl} != canonical ${canon}`);
    n++;
  }
  return `${n} page(s), description, canonical, theme-color and the og/twitter pair`;
}

/**
 * The icon at the size a tab actually draws it, on both tab colours.
 *
 * "It exists" is not the question. Two things are:
 *
 *   - **Is it a shape at 16 px, or a smudge?** At least a fifth and at most four fifths of the
 *     pixels must differ materially from the tile's own near-black. Under a fifth is a wisp
 *     and over four fifths is a blob; two earlier drafts of this mark failed on the second.
 *   - **Does it look the same on a light tab and a dark one?** This is the property the whole
 *     opaque-tile decision exists to buy, so it is tested the way it is experienced: composite
 *     the icon over Chrome's light tab strip and over its dark one and compare the two
 *     results. Counting alpha does not answer it — the *first* version of this arm did that
 *     and failed the shipped icon over twelve anti-aliased corner pixels, which is a rounded
 *     corner working correctly.
 *
 * Corners are the reason the comparison is bounded: a rounded tile is *supposed* to let the tab
 * through at its corners, so the test is over the inscribed disc, and the tolerance below is
 * the perceptual one — a corner pixel differing between the two tabs is fine, a wing differing
 * is not.
 */
async function armIcons(base) {
  const svg = await fetchOk(base, '/favicon.svg');
  if (svg.status !== 200) { fail('/favicon.svg missing'); return 'no svg'; }
  const raw = await sharp(svg.buf, { density: 512 }).resize(16, 16).ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  const INK = [0x10, 0x0c, 0x09];
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = raw.data.subarray(i * 4, i * 4 + 4);
    if (Math.abs(r - INK[0]) + Math.abs(g - INK[1]) + Math.abs(b - INK[2]) > 60) ink++;
  }
  const frac = ink / 256;
  if (frac < 0.20) fail(`favicon is only ${(frac * 100).toFixed(0)}% ink at 16 px — a wisp`);
  if (frac > 0.80) fail(`favicon is ${(frac * 100).toFixed(0)}% ink at 16 px — a blob`);

  // The same 16 px icon, over Chrome's light tab strip and over its dark one.
  const over = async (bg) => sharp({ create: { width: 16, height: 16, channels: 4, background: bg } })
    .composite([{ input: await sharp(svg.buf, { density: 512 }).resize(16, 16).png().toBuffer() }])
    .removeAlpha().raw().toBuffer();
  const light = await over({ r: 0xf1, g: 0xf3, b: 0xf4, alpha: 1 });
  const dark = await over({ r: 0x29, g: 0x2a, b: 0x2d, alpha: 1 });
  let differing = 0;
  let worst = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // Inside the inscribed disc: the corners are meant to show the tab through.
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 7.5 ** 2) continue;
      const i = (y * 16 + x) * 3;
      const d = Math.abs(light[i] - dark[i]) + Math.abs(light[i + 1] - dark[i + 1])
        + Math.abs(light[i + 2] - dark[i + 2]);
      worst = Math.max(worst, d);
      if (d > 24) differing++;
    }
  }
  if (differing > 0) {
    fail(`favicon renders differently on a light and a dark tab: ${differing} pixel(s) inside `
      + `the tile differ by up to ${worst}/765. The tile is not opaque where it should be`);
  }

  const ico = await fetchOk(base, '/favicon.ico');
  if (ico.status !== 200) fail('/favicon.ico missing — non-browsers request it by path');
  else {
    // Parse the container rather than trusting it: 6-byte ICONDIR, then 16 bytes per entry.
    const count = ico.buf.readUInt16LE(4);
    if (ico.buf.readUInt16LE(2) !== 1 || count < 1) fail('favicon.ico is not an icon container');
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      const w = ico.buf.readUInt8(e) || 256;
      const off = ico.buf.readUInt32LE(e + 12);
      const len = ico.buf.readUInt32LE(e + 8);
      if (off + len > ico.buf.length) fail(`favicon.ico entry ${i} points past the end of the file`);
      sizes.push(w);
    }
    if (!sizes.includes(16) || !sizes.includes(32)) {
      fail(`favicon.ico holds ${sizes.join('/')} — a tab wants 16 and a bookmark bar wants 32`);
    }
  }

  const apple = await fetchOk(base, '/apple-touch-icon.png');
  if (apple.status !== 200) fail('/apple-touch-icon.png missing');
  else {
    const m = await sharp(apple.buf).metadata();
    if (m.width !== 180 || m.height !== 180) fail(`apple-touch-icon is ${m.width}x${m.height}, want 180x180`);
  }
  return `16 px: ${(frac * 100).toFixed(0)}% ink, identical on light and dark tabs; `
    + `ico holds ${icoEntries((await fetchOk(base, "/favicon.ico")).buf).map((e) => e.size).join("/")}`;
}

async function armPalette() {
  const css = await readFile(path.join(ROOT, 'src', 'ui', 'hud.css'), 'utf8');
  const want = { gold: '--gold', goldBright: '--gold-bright', bronze: '--bronze', travertine: '--travertine' };
  for (const [k, v] of Object.entries(want)) {
    const m = css.match(new RegExp(`${v}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) { fail(`hud.css has no ${v}`); continue; }
    if (m[1].toLowerCase() !== BRAND[k]) fail(`BRAND.${k} is ${BRAND[k]}, hud.css ${v} is ${m[1]}`);
  }
  // `--panel-bg`'s darkest stop is what `theme-color` and the icon tile are.
  const panel = css.match(/--panel-bg:[^;]*rgba\((\d+),\s*(\d+),\s*(\d+)/g);
  const last = css.match(/--panel-bg:[^;]*rgba\(\s*(\d+),\s*(\d+),\s*(\d+)[^)]*\)\s*\)/);
  if (last) {
    const hex = `#${[last[1], last[2], last[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    if (hex !== BRAND.ink) fail(`BRAND.ink is ${BRAND.ink}, --panel-bg's darkest stop is ${hex}`);
  } else if (!panel) fail('hud.css has no --panel-bg to take the ink colour from');
  return `${Object.keys(want).length + 1} colours match src/ui/hud.css`;
}

async function armSet(base) {
  const mfRes = await fetchOk(base, '/press/manifest.json');
  if (mfRes.status !== 200) { fail('/press/manifest.json → ' + mfRes.status); return 'no manifest'; }
  const mf = JSON.parse(mfRes.buf.toString('utf8'));
  const mod = await readFile(path.join(ROOT, 'src', 'ui', 'pressPlates.ts'), 'utf8');

  if (mf.frames.length !== PLATES.length) {
    fail(`manifest has ${mf.frames.length} frames, make-brand's PLATES has ${PLATES.length}`);
  }
  if (mf.hero !== PLATES[0].key) fail(`manifest hero ${mf.hero} != PLATES[0] ${PLATES[0].key}`);
  if (!mf.frames[0].hero) fail('the first frame in the manifest is not flagged as the hero');

  const named = new Set();
  for (const f of mf.frames) {
    if (!mod.includes(`id: "${f.id}"`)) fail(`pressPlates.ts does not name ${f.id}`);
    for (const r of f.renditions) {
      named.add(r.url.replace(/^\//, ''));
      const got = await fetchOk(base, r.url);
      if (got.status !== 200) { fail(`${r.url} → HTTP ${got.status}`); continue; }
      if (got.bytes !== r.bytes) fail(`${r.url} is ${got.bytes} B, manifest says ${r.bytes}`);
      const m = await sharp(got.buf).metadata();
      if (m.width !== r.w || m.height !== r.h) {
        fail(`${r.url} is ${m.width}x${m.height}, manifest says ${r.w}x${r.h}`);
      }
    }
    /*
     * The two formats are two jobs, and asserting them separately is the point.
     *
     * `srcset` is the AVIF ladder and goes on a `<source>`; `fallback` is the single WebP and
     * goes on the `<img>` inside the same `<picture>`. The old check here was "srcset includes
     * the last rendition", which passed by accident while there was one format and would pass
     * again, silently, if the WebP were ever appended to the ladder — offering a browser a
     * choice between formats on one element, which `srcset` cannot express and which would
     * hand some visitors the fallback at a rung it was never encoded for.
     */
    const avif = f.renditions.filter((r) => r.format === 'avif');
    const webp = f.renditions.filter((r) => r.format === 'webp');
    if (avif.length === 0) fail(`${f.id} has no AVIF rendition`);
    if (webp.length !== 1) fail(`${f.id} has ${webp.length} WebP renditions, expected exactly 1`);
    const widest = avif.reduce((a, b) => (b.w > a.w ? b : a), avif[0]);
    if (avif.length && !f.srcset.includes(widest.url)) {
      fail(`${f.id} srcset omits its widest AVIF (${widest.url})`);
    }
    for (const r of webp) {
      if (f.srcset.includes(r.url)) fail(`${f.id} srcset carries the WebP fallback ${r.url}`);
    }
    if (webp.length === 1 && f.fallback?.url !== webp[0].url) {
      fail(`${f.id} fallback is ${f.fallback?.url}, but its WebP rendition is ${webp[0].url}`);
    }
    if (webp.length === 1 && !mod.includes(`src: "${webp[0].url}"`)) {
      fail(`${f.id}: pressPlates.ts does not use ${webp[0].url} as its src`);
    }
    for (const k of ['map', 'scenario']) {
      if (!mod.includes(`${k}: ${JSON.stringify(f.battle[k])}`)) {
        fail(`${f.id}: pressPlates.ts does not carry ${k} ${f.battle[k]} — `
          + 'MenuBackdrop groups the rotation by battle and cannot without it');
      }
    }
    if (typeof f.type?.scrimForGold !== 'number') fail(`${f.id} has no measured scrimForGold`);
  }

  // No orphans: a file in the directory that nothing names is a file nobody will ever update.
  const onDisk = (await readdir(path.join(ROOT, 'public', 'press')))
    .filter((f) => /\.(webp|avif)$/.test(f)).map((f) => `press/${f}`);
  for (const f of onDisk) if (!named.has(f)) fail(`public/${f} is on disk and named by nothing`);

  // Every URL the app can reach must resolve, not just the ones the manifest lists.
  for (const m of mod.matchAll(/"(\/press\/[^"\s]+\.(?:webp|avif))/g)) {
    const got = await fetchOk(base, m[1]);
    if (got.status !== 200) fail(`pressPlates.ts names ${m[1]} → HTTP ${got.status}`);
  }
  return `${mf.frames.length} frames, ${onDisk.length} renditions, manifest = module = disk`;
}

/**
 * The generated module, re-derived.
 *
 * Only possible when the source frames are here, because the module carries measurements taken
 * from the pixels. Skipped rather than faked when they are not: `screenshots/**` is gitignored,
 * so a fresh checkout has the outputs and not the inputs, and a check that quietly passes on
 * missing evidence is worse than one that says it did not run.
 */
async function armDrift() {
  if (!existsSync(FRAMES)) return 'skipped — no source frames (screenshots/** is gitignored)';
  const mfPath = path.join(ROOT, 'public', 'press', 'manifest.json');
  const mf = JSON.parse(await readFile(mfPath, 'utf8'));
  const expected = plateModuleText(mf.frames);
  const actual = await readFile(path.join(ROOT, 'src', 'ui', 'pressPlates.ts'), 'utf8');
  if (expected !== actual) {
    fail('src/ui/pressPlates.ts differs from what make-brand would generate — run '
      + '`node tools/make-brand.mjs` and commit the result');
  }
  return 'src/ui/pressPlates.ts is byte-identical to its generator\'s output';
}

// ---------------------------------------------------------------------------

let server = null;
try {
  if (DIST) {
    if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
      console.error('--dist needs a build: npm run build');
      process.exit(2);
    }
  }
  const r = await startVite({ port: PORT, root: ROOT, label: 'qa-brand', mode: DIST ? 'static' : 'dev' });
  server = r.started ? r : null;
  const base = r.base;
  console.log(`• ${DIST ? 'static server over dist/' : 'vite dev'} on ${base}\n`);

  const arms = [
    arm('head', () => armHead(base)),
    arm('og', () => armOg(base)),
    arm('tags', () => armTags(base)),
    arm('icons', () => armIcons(base)),
    arm('palette', () => armPalette()),
    arm('set', () => armSet(base)),
    arm('drift', () => armDrift()),
  ];

  for (const a of arms) {
    const before = problems.length;
    let note = '';
    try { note = await a.fn(); }
    catch (e) { fail(`${a.name} threw: ${e.message}`); }
    const mine = problems.slice(before);
    if (mine.length) {
      failures++;
      console.log(`  ✗ ${a.name.padEnd(9)} ${mine.length} problem(s)`);
      for (const p of mine) console.log(`      ${p}`);
    } else {
      console.log(`  ✓ ${a.name.padEnd(9)} ${note}`);
    }
    results.push({ arm: a.name, problems: mine, note });
  }
} finally {
  if (server) await server.close();
}

console.log(`\n${failures ? `${failures} arm(s) FAILED` : 'all arms green'}`);
process.exit(failures);
