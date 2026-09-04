#!/usr/bin/env node
/**
 * Every pixel of the site's dressing, generated from this repository.
 *
 * The favicon set, the web manifest, the Open Graph card and the press stills — everything
 * a stranger sees before pressing anything. Run it and the whole of `public/favicon*`, `public/icon-*`,
 * `public/apple-touch-icon.png`, `public/site.webmanifest`, `public/og/` and `public/press/`
 * are rewritten from source that lives here: an SVG authored in this file, and PNG frames
 * that `tools/shoot.mjs --set=press` rendered out of the game itself.
 *
 *     node tools/shoot.mjs --set=press --w=1920 --h=1080 --out=screenshots/press
 *     node tools/make-brand.mjs
 *     node tools/qa-brand.mjs            # and this is the half that can fail
 *
 * ## Why it is a generator and not a folder of files
 *
 * `ASSETS.md` records provenance for every byte this project ships, and the standing rule is
 * CC0 or explicitly commercial-use-permitted, never anything out of another game. The cheapest
 * way to satisfy a licence audit is to have nothing to audit: the eagle is a path in this
 * file, the card is a frame this renderer drew, and both can be re-derived from the tree by
 * anyone who doubts them. Nothing here was downloaded.
 *
 * ## The favicon, and the 404 it must not bring back
 *
 * `index.html` carried `<link rel="icon" href="data:," />` for exactly one reason, written out
 * in a comment above it: three `qa-net` arms assert a page raises no console error, and a
 * browser that asks for a favicon nobody declared logs a 404 on every page load. An empty data
 * URI satisfied the declaration without a request.
 *
 * Replacing it means every icon declared in the head has to *resolve* — on the Vite dev server,
 * under `npm run host`'s static server, and on Vercel. That is three servers with three
 * different rules, and `public/<x>` maps to `/<x>` on all three, so that is where these go.
 * **Not `public/assets/`**: `tools/optimize-assets.mjs` deletes `dist/assets` wholesale and
 * re-emits only what `public/assets/manifest.json` lists, so an image parked there survives
 * `vite build` and is gone by the end of `npm run build`. `tools/qa-brand.mjs` fetches every
 * declared URL off a real server rather than trusting this comment.
 *
 * ## The mark
 *
 * An aquila, displayed, on the HUD's near-black with the HUD's gold. Four things about it are
 * decisions rather than drawing:
 *
 *   - **The tile is opaque.** A gold glyph on transparency vanishes into a light tab and a
 *     dark one takes the tile's own black; an opaque tile reads identically on both, which is
 *     the only property here that was actually checked at 16 px on both tab colours rather
 *     than asserted.
 *   - **The head is turned.** A symmetric head with a symmetric beak renders as a diamond and
 *     the bird becomes an aeroplane. The first draft did exactly that.
 *   - **The wings carry deep cuts and the body is narrow.** At 16 px the mark is a 16-pixel
 *     bitmap; an evenly-filled silhouette is a blob. Roughly half of it has to be dark.
 *   - **Nothing is thinner than about 1.5 px at 16.** Feather fringes finer than that
 *     dissolve into a grey fuzz, which is what killed two earlier drafts.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
/** Where `tools/shoot.mjs --set=press` left its 1920x1080 frames. */
const FRAMES = path.resolve(ROOT, args.get('frames') ?? 'screenshots/press');

// ---------------------------------------------------------------------------
// Palette. The single source is `src/ui/hud.css`; these are copies, and
// `tools/qa-brand.mjs` re-reads that file and fails if they have drifted.
// ---------------------------------------------------------------------------
export const BRAND = {
  /** `--panel-bg`'s darkest stop, and the `theme-color` the head declares. */
  ink: '#100c09',
  /** `--gold`. */
  gold: '#d9b25f',
  /** `--gold-bright`. */
  goldBright: '#f2dd9e',
  /** `--bronze`, used for the rim so the tile has an edge on a dark tab. */
  bronze: '#6a5334',
  /** `--travertine`. */
  travertine: '#d9cfba',
};

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * The aquila, in a 64-unit box.
 *
 * `rounded` is false for the maskable/large sizes, where a platform applies its own mask and
 * a corner radius baked into the art shows up as a double-rounded corner.
 */
export function markSvg({ size = 64, rounded = true, rim = true, bleed = 0 } = {}) {
  const r = rounded ? 10 : 0;
  // `bleed` insets the bird so a platform mask (Android's 40% safe zone) cannot clip a wingtip.
  const s = 1 - bleed;
  const o = (64 * bleed) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <rect width="64" height="64" rx="${r}" fill="${BRAND.ink}"/>
  ${rim ? `<rect x="1.25" y="1.25" width="61.5" height="61.5" rx="${Math.max(0, r - 1)}" fill="none" stroke="${BRAND.bronze}" stroke-width="1.5"/>` : ''}
  <g fill="${BRAND.gold}" transform="translate(${o} ${o}) scale(${s})">
    <circle cx="33" cy="12" r="4.6"/>
    <path d="M29.4 10.4 L21 12.9 L29.4 15 Z"/>
    <path d="M28.4 18 h7.2 l-1.1 21 h-5 Z"/>
    <path d="M26 37.5 h12 l2.4 13 l-4.6 -3.4 l-3.8 6.6 l-3.8 -6.6 l-4.6 3.4 Z"/>
    <path d="M34.4 19.5 L45 15 L58 12.6 L60.5 21 L49.5 24.2 L55 29 L43.5 28.6 L46 35.5 L35.4 27 Z"/>
    <path d="M34.4 19.5 L45 15 L58 12.6 L60.5 21 L49.5 24.2 L55 29 L43.5 28.6 L46 35.5 L35.4 27 Z"
          transform="translate(64,0) scale(-1,1)"/>
  </g>
</svg>
`;
}

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/**
 * A minimal ICO container around PNG payloads.
 *
 * Every browser in use has read PNG-in-ICO since IE 11, and the alternative is a BMP encoder
 * with an upside-down scanline order and a separate AND mask for a format nothing consults any
 * more. `favicon.ico` exists at all because things that are not browsers — chat clients, feed
 * readers, link unfurlers — still request `/favicon.ico` by path without reading the document,
 * and a 404 there is the same 404 this whole exercise is under orders not to reintroduce.
 */
function ico(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

async function buildIcons() {
  await mkdir(PUBLIC, { recursive: true });
  const out = [];

  await writeFile(path.join(PUBLIC, 'favicon.svg'), markSvg());
  out.push(['favicon.svg', markSvg().length]);

  const sizes = [16, 32, 48];
  const rasters = [];
  for (const size of sizes) rasters.push({ size, data: await png(markSvg(), size) });
  await writeFile(path.join(PUBLIC, 'favicon.ico'), ico(rasters));
  out.push(['favicon.ico', ico(rasters).length]);

  for (const size of [16, 32]) {
    const data = rasters.find((r) => r.size === size).data;
    await writeFile(path.join(PUBLIC, `favicon-${size}.png`), data);
    out.push([`favicon-${size}.png`, data.length]);
  }

  // iOS draws this on a home screen at 180 and applies its own corner radius over the top, so
  // the art is square-cornered — a rounded tile inside a rounded mask shows a pale hairline.
  const apple = await png(markSvg({ rounded: false, rim: false }), 180);
  await writeFile(path.join(PUBLIC, 'apple-touch-icon.png'), apple);
  out.push(['apple-touch-icon.png', apple.length]);

  for (const size of [192, 512]) {
    const data = await png(markSvg({ rounded: false, rim: false, bleed: 0.2 }), size);
    await writeFile(path.join(PUBLIC, `icon-${size}.png`), data);
    out.push([`icon-${size}.png`, data.length]);
  }

  const manifest = {
    name: 'Total Claude — the Siege of Rome',
    short_name: 'Total Claude',
    description:
      'Nine thousand individually simulated soldiers assault the Aurelian Wall, in a browser.',
    start_url: '/',
    display: 'standalone',
    background_color: BRAND.ink,
    theme_color: BRAND.ink,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  const mtext = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(PUBLIC, 'site.webmanifest'), mtext);
  out.push(['site.webmanifest', Buffer.byteLength(mtext)]);

  return out;
}

// ---------------------------------------------------------------------------
// The plates behind the menu, and the Open Graph card
// ---------------------------------------------------------------------------

/**
 * The set, in rank order, and the first of them is the hero.
 *
 * `key` is a `press-*` shot in `tools/shoot.mjs`; everything else about the frame — which
 * battle, which camera, which second, how many men were alive — is read back out of that
 * tool's own `report.json` rather than restated here, because a fact copied by hand is a fact
 * that goes stale. This list carries only what a machine cannot derive: the running order, the
 * alt text, and an honest one-line verdict.
 *
 * `verdict` is `hero`, `strong` or `fair`, and it is the answer to "would a stranger stop
 * scrolling". `fair` means competent and true to the game and not arresting; it is in the set
 * because a set of six arresting frames all of the same thing is worse than a set with range
 * in it, and because the fallback job — a still for a device that cannot afford a live scene —
 * wants breadth more than it wants drama.
 */
export const PLATES = [
  {
    key: 'press-rome-line',
    verdict: 'hero',
    alt: 'Legionary cohorts drawn up in packed ranks at first light, painted shields and '
      + 'helmets catching the low sun, a vexillum among them.',
    note: 'The claim this project makes is nine thousand men simulated one at a time, and this '
      + 'is the frame that shows it without asking anything of the viewer: rank on rank of '
      + 'individually posed soldiers, every shield a different painted scutum, and — the part '
      + 'that decided it — the ranks read as ranks at 400 px, where the two denser candidates '
      + 'go to noise. It is also the only strong frame whose top third is empty ground, so a '
      + 'wordmark or a menu can sit on it.',
  },
  {
    key: 'press-carth-elephants',
    verdict: 'strong',
    alt: 'A Carthaginian elephant line advancing in front of the Punic centre in late '
      + 'afternoon light, crews in the towers on their backs.',
    note: 'The most arresting single frame in the set and the one nobody mistakes for another '
      + 'game. Not the hero for two reasons: the title of the site is the Siege of Rome, and at '
      + 'full size on a large display this is the roughest modelling in the game.',
  },
  {
    key: 'press-pydna-clash',
    verdict: 'strong',
    alt: 'Thousands of men locked together on open Macedonian ground at Pydna, 168 BC, spears '
      + 'and standards above the press.',
    note: 'The scale claim at its most literal — a wall of men to the horizon. Spectacular '
      + 'large, and it is texture rather than a picture below about 500 px, which is exactly '
      + 'the failure mode a link preview punishes.',
  },
  {
    key: 'press-rome-melee',
    verdict: 'strong',
    alt: 'Inside the melee on the Campus Martius in late light: legionaries and Juthungi '
      + 'warriors at arm\'s length, spears crossed above them.',
    note: 'The hardest thing this renderer does, photographed at the distance where you can '
      + 'see it is doing it.',
  },
  {
    key: 'press-rome-host',
    verdict: 'strong',
    alt: 'A Juthungi warband coming on at eye level, painted round shields, no two men kitted '
      + 'the same.',
    note: 'The variety argument: the Roman line is uniform on purpose and this is the frame '
      + 'that proves the uniformity is a choice rather than a limit.',
  },
  {
    key: 'press-rome-wall',
    verdict: 'strong',
    alt: 'The Aurelian Wall of Rome at mid-morning, its towers and gatehouse above the glacis, '
      + 'the city behind it.',
    note: 'The subject of the whole product in one frame — a city wall, and ground in front of '
      + 'it to cross. Hazier than the rest because it is the only frame shot through 500 m of '
      + 'atmosphere, which is also why it is the calmest thing here to put type on.',
  },
  {
    key: 'press-carth-wall',
    verdict: 'strong',
    alt: 'The wall of Carthage from the field in late afternoon, Roman assault columns drawn '
      + 'up on the plain before it.',
    note: 'The second city, in the opposite end of the day from Rome\'s. Pale limestone against '
      + 'red earth, which is the only palette in the set that is not green and gold.',
  },
  {
    key: 'press-rome-cavalry',
    verdict: 'fair',
    alt: 'A wedge of Roman equites sweeping the flank at eye level in low sun.',
    note: 'Eye level among the horses, and the only frame that sells motion. Dark and cramped, '
      + 'so it is a fallback rather than a first impression.',
  },
  {
    key: 'press-rome-city',
    verdict: 'fair',
    alt: 'Rome from above at first light: the Aurelian circuit along the crest, the Tiber '
      + 'below it, the fabric of the city inside.',
    note: 'Quiet and atmospheric rather than arresting, and the only frame that shows the city '
      + 'as a city. It reads as the calm one and it is not: the morning haze puts its panel '
      + 'region at 0.65 scrim, joint worst in the set. Prose said otherwise here until the '
      + 'measurement was run.',
  },
];

/**
 * Shot, looked at, and left out. Recorded because "we only kept nine of seventeen" is a fact
 * about the *cameras*, and the next person to point one at this game should not have to
 * rediscover these:
 *
 *   press-rome-parapet   `follow: 'contact'` at t+150 of the assault resolved to open ground:
 *                        there was no melee anywhere on the circuit at that second. A frame of
 *                        grass, and a useful negative result about when the wall is actually
 *                        fought over.
 *   press-carth-ditch    A ditch seen from its own bank is invisible, which is what a ditch is
 *                        for. `r6-carthage-ditch` needed four framings to get a picture of a
 *                        hole and this camera is not one of them.
 *   press-carth-wide     0.62 zoom on a Punic field is a strategic view: washed-out aerial,
 *                        men four pixels tall.
 *   press-rome-advance   The same, retuned to 0.40 and still an aerial. `ownLine` puts the eye
 *                        behind the whole army, which at any zoom that fits both hosts is too
 *                        far back to see either.
 *   press-rome-ladder    Backed off to 85 m to show ladders against the curtain and framed the
 *                        curtain with no ladders on it: at t+60 the escalade at bay -3 had
 *                        either not started or was over.
 *   press-rome-ram       The gate is the best single piece of modelling in the game and this
 *                        camera is 6 m from it, so the frame is two tower drums and a slab of
 *                        siege tower. Worth re-shooting from 40 m; not worth shipping.
 *   press-carth-line     Good, and redundant beside `press-rome-line` and `press-pydna-clash`.
 *   press-pydna-line     Good, and redundant beside `press-pydna-clash`.
 *
 * All seventeen are still in `tools/shoot.mjs`, because they cost almost nothing — every one
 * rides in a page load another frame was already paying for — and because a camera that failed
 * is cheaper to fix than to reinvent.
 */

/**
 * The widths served, and why there are three.
 *
 * A still behind the menu is drawn at the viewport width, so the useful sizes are "a phone"
 * and "a laptop": 960 covers every phone at 2x and every small window, 1440 covers a 13-inch
 * laptop at 1x and a 1440-wide window. **Only the hero gets 1920**, and that asymmetry is the
 * byte budget rather than an oversight.
 *
 * Three widths across nine frames came to 5.79 MB in `public/`. Not a cold-load cost — nothing
 * fetches any of it unless something asks — but it is 5.79 MB in every deployment, against a
 * guest's whole cold load of 841 kB, and the third width buys almost nothing: these frames are
 * grass and mail, so they are high-frequency all over and WebP's quality knob barely moves
 * them (q58 to q76 is 181 kB to 245 kB at 1440). Dropping the third width is worth 2.85 MB;
 * dropping quality to where it would show is worth 400 kB. So the width goes and the quality
 * stays, and a 1920-wide window shows a 1440 plate upscaled 1.33x *behind a menu*, which is
 * not a place anyone has ever noticed resampling.
 *
 * The hero keeps 1920 because it has a second job — the instant first paint, full-bleed,
 * before the live scene is up — and that one is looked at directly.
 *
 * 1920 is also the ceiling because **1920 is the source**: the press pass renders at
 * 1920x1080 and `withoutEnlargement` means asking for more hands back a 1920 file under a
 * bigger name. For a genuinely larger source, re-run the pass at the size you want:
 *
 *     node tools/shoot.mjs --set=press --w=2560 --h=1440 --out=screenshots/press
 */
const PLATE_WIDTHS = [960, 1440];
/** The hero alone, for the full-bleed first paint on a desktop. */
const HERO_EXTRA_WIDTHS = [1920];

/**
 * The hero is the head of `PLATES`, and everything that needs one frame uses this one.
 *
 * `--hero=<key>` overrides it, and exists because choosing a hero by looking at 1920 px frames
 * is choosing the wrong one. The question is which frame survives being 400 px wide in a chat
 * client, so the way this was actually settled was to build the card from each candidate and
 * look at all of them at the four real preview sizes:
 *
 *     node tools/make-brand.mjs --only=card --hero=press-carth-elephants --card-out=/tmp/a.jpg
 *     node tools/press-sheet.mjs --cards --card=/tmp/a.jpg --out=/tmp
 */
const HERO_KEY = args.get('hero') ?? PLATES[0].key;

const OG = { w: 1200, h: 630 };

/**
 * The card, and the only compositing this file does.
 *
 * The frame is the game's. What is added is a scrim and a wordmark, and both are there for one
 * measured reason: a link preview renders at roughly a third of the width this is captured at,
 * and at 400 px a dark battlefield full of four-pixel men is texture rather than a picture.
 * The wordmark gives the thumbnail one thing that survives the downscale, and the scrim is what
 * makes the wordmark legible on a frame whose lower third is lit ground.
 *
 * ## Centred, and that is a bug fix rather than a taste
 *
 * The first cut put the lockup bottom-left at 6.5 % in, on the reasoning that 6.5 % keeps it
 * inside a square centre crop. That reasoning is simply wrong, and rendering the card at the
 * four real preview sizes is what said so: **iMessage draws the bubble at about 1.28:1**, and
 * a 1.28:1 centre crop of a 1.905:1 card removes `(1 - 1.28/1.905) / 2` of the width from each
 * side — 16.4 %, not 6.5 %. The preview came back reading *"OTAL CLAUDE / IE SIEGE OF ROME"*.
 *
 * So the safe width is the central 67 %, x from 197 to 1003, and the lockup is centred on 600
 * where no centred crop of any aspect can reach it. `tools/press-sheet.mjs --cards` is the
 * check, and it is a check that can fail: it renders the actual file at the actual sizes with
 * the actual crop each client applies. Asserting that an `og:image` tag exists would have
 * passed this card in the state that shipped a clipped wordmark.
 */
function cardOverlay() {
  const { w, h } = OG;
  const cx = w / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="0.80"/>
      <stop offset="0.34" stop-color="#000" stop-opacity="0.40"/>
      <stop offset="0.64" stop-color="#000" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#scrim)"/>
  <g transform="translate(${cx - 34} ${h - 208}) scale(1.06)">${markInline()}</g>
  <text x="${cx}" y="${h - 88}" fill="${BRAND.goldBright}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="58" letter-spacing="10"
        >TOTAL CLAUDE</text>
  <text x="${cx}" y="${h - 48}" fill="${BRAND.travertine}" opacity="0.86" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="22" letter-spacing="5"
        >THE SIEGE OF ROME &#183; 271 AD</text>
  <rect x="0" y="${h - 5}" width="${w}" height="5" fill="${BRAND.gold}" opacity="0.55"/>
</svg>`;
}

/** The bird alone, no tile, in its own 64-unit box, for the card's lockup. */
function markInline() {
  return `<g fill="${BRAND.gold}">
    <circle cx="33" cy="12" r="4.6"/>
    <path d="M29.4 10.4 L21 12.9 L29.4 15 Z"/>
    <path d="M28.4 18 h7.2 l-1.1 21 h-5 Z"/>
    <path d="M26 37.5 h12 l2.4 13 l-4.6 -3.4 l-3.8 6.6 l-3.8 -6.6 l-4.6 3.4 Z"/>
    <path d="M34.4 19.5 L45 15 L58 12.6 L60.5 21 L49.5 24.2 L55 29 L43.5 28.6 L46 35.5 L35.4 27 Z"/>
    <path d="M34.4 19.5 L45 15 L58 12.6 L60.5 21 L49.5 24.2 L55 29 L43.5 28.6 L46 35.5 L35.4 27 Z"
          transform="translate(64,0) scale(-1,1)"/>
  </g>`;
}

function framePath(key) {
  return path.join(FRAMES, `${key}.png`);
}

// ---------------------------------------------------------------------------
// Can type live on this frame?
// ---------------------------------------------------------------------------

/** WCAG relative luminance from 8-bit sRGB. */
function luminance(r, g, b) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const GOLD_L = luminance(0xd9, 0xb2, 0x5f);

/**
 * The box a centred menu sheet covers, as fractions of the frame.
 *
 * `menu.css` sizes the front door at `min(760px, 94vw)`, so on a 1280-wide window the sheet is
 * 59 % of the width and on a 1920-wide one it is 40 %. 50 % is the middle of that range and the
 * height is the tall case. This is the region the *next* agent's live camera and any still
 * behind it both have to keep quiet, so it is measured on every frame rather than eyeballed on
 * one — which is the failure mode this project has a documented history of.
 */
const PANEL_BOX = { x: 0.25, y: 0.14, w: 0.50, h: 0.72 };

/**
 * What it would take to put gold type straight onto this frame.
 *
 * Two numbers, and the second is the useful one:
 *
 *   - `goldOnFrame` is the contrast ratio of `--gold` (#d9b25f) against the *95th percentile*
 *     luminance inside the panel box. The 95th and not the mean, because type is unreadable
 *     over its brightest patch, not over its average one — a frame that is black except for a
 *     sunlit wall behind the title has a lovely mean and is illegible.
 *   - `scrimForGold` is the smallest black scrim alpha, in 0.05 steps, that gets that ratio to
 *     4.5:1, which is WCAG AA for body text. 0 means the frame needs nothing. Above about 0.45
 *     the picture has stopped being a picture, and the honest answer for such a frame is to
 *     use a different one.
 *
 * A black scrim composites in sRGB as `C' = C * (1 - a)`, so the alpha is applied before
 * linearisation rather than to the luminance, which is why this recomputes rather than scaling.
 */
async function typeReadability(file) {
  // 320x180 is enough for luminance statistics and is also roughly what a link preview shows.
  const W = 320, H = 180;
  const { data } = await sharp(file).resize(W, H, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = [];
  const grid = Array.from({ length: 9 }, () => ({ sum: 0, n: 0 }));
  const panel = [];
  const box = {
    x0: Math.round(PANEL_BOX.x * W), x1: Math.round((PANEL_BOX.x + PANEL_BOX.w) * W),
    y0: Math.round(PANEL_BOX.y * H), y1: Math.round((PANEL_BOX.y + PANEL_BOX.h) * H),
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const l = luminance(...rgb);
      px.push(l);
      const cell = Math.floor((y * 3) / H) * 3 + Math.floor((x * 3) / W);
      grid[cell].sum += l;
      grid[cell].n++;
      if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) panel.push({ l, rgb });
    }
  }
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const sorted = [...px].sort((a, b) => a - b);
  const panelSorted = [...panel].sort((a, b) => a.l - b.l);
  const hot = pct(panelSorted, 0.95);
  const scrimmed = (a) => luminance(...hot.rgb.map((c) => c * (1 - a)));
  let scrim = 0;
  while (scrim < 0.9 && contrast(GOLD_L, scrimmed(scrim)) < 4.5) scrim = +(scrim + 0.05).toFixed(2);

  const r3 = (n) => +n.toFixed(3);
  return {
    luma: {
      mean: r3(px.reduce((a, b) => a + b, 0) / px.length),
      p05: r3(pct(sorted, 0.05)), p50: r3(pct(sorted, 0.5)), p95: r3(pct(sorted, 0.95)),
    },
    /** Row-major 3x3 means, so a consumer can find the quiet third without re-reading pixels. */
    grid: grid.map((c) => r3(c.sum / c.n)),
    type: {
      panelBox: PANEL_BOX,
      panelP95: r3(hot.l),
      goldOnFrame: +contrast(GOLD_L, hot.l).toFixed(2),
      scrimForGold: scrim,
      /** True if the frame takes gold type with a scrim light enough to still read as a photo. */
      quiet: scrim <= 0.25,
    },
  };
}

/**
 * The camera and battle facts, read back out of `tools/shoot.mjs`'s own report.
 *
 * Merged across every `report*.json` in the frames directory, newest file wins per shot name,
 * because re-shooting five cameras out of seventeen is the normal way this set gets fixed and
 * the second pass's report only names the five. Every report must agree on `srcTree` — the
 * tree object of `src/`, which is what actually decides what a frame looks like — or the set
 * is frames from two different renderers and this refuses to describe it as one set.
 */
async function readShotReports() {
  const files = (await readdir(FRAMES)).filter((f) => /^report.*\.json$/.test(f));
  if (!files.length) throw new Error(`no report*.json in ${FRAMES}`);
  const loaded = [];
  for (const f of files) {
    const full = path.join(FRAMES, f);
    loaded.push({ f, mtime: (await import('node:fs')).statSync(full).mtimeMs, r: JSON.parse(await readFile(full, 'utf8')) });
  }
  loaded.sort((a, b) => a.mtime - b.mtime);
  const trees = new Set(loaded.map((l) => l.r.srcTree));
  if (trees.size > 1) {
    throw new Error(`frames came from ${trees.size} different src trees (${[...trees].join(', ')}) — re-shoot the set`);
  }
  const byName = new Map();
  for (const l of loaded) for (const s of l.r.shots) byName.set(s.name, { ...s, report: l.f });
  return { byName, meta: loaded.at(-1).r, reports: loaded.map((l) => l.f) };
}

async function buildCard() {
  const src = framePath(HERO_KEY);
  if (!existsSync(src)) throw new Error(`no frame for the card at ${src} — run tools/shoot.mjs --set=press first`);
  await mkdir(path.join(PUBLIC, 'og'), { recursive: true });
  // `cover` on a 16:9 source into 1.905:1 crops 3.3 % off the top and bottom and nothing off
  // the sides, so the camera the shot table framed is the camera the card shows.
  const base = await sharp(src).resize(OG.w, OG.h, { fit: 'cover', position: 'centre' }).toBuffer();
  const buf = await sharp(base)
    .composite([{ input: Buffer.from(cardOverlay()), top: 0, left: 0 }])
    .jpeg({ quality: 84, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  const rel = args.get('card-out') ?? 'og/total-claude.jpg';
  const file = path.isAbsolute(rel) ? rel : path.join(PUBLIC, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
  return [[`${rel}  (from ${HERO_KEY})`, buf.length]];
}

/**
 * Encode the set, measure it, and describe it.
 *
 * The output is `public/press/`: three WebP renditions per frame and one `manifest.json` that
 * says, for every frame, which battle it is, where the camera stood, how big each rendition is,
 * how many bytes it costs, and whether gold type can live on it. That last part is the reason
 * this is a manifest rather than a folder — a consumer that has to open the files in an editor
 * to find out whether the title will be readable is going to check one frame and assume the
 * rest, which is exactly how this repository has shipped instruments that lie before.
 */
async function buildPlates() {
  const dir = path.join(PUBLIC, 'press');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const { byName, meta, reports } = await readShotReports();
  const written = [];
  const frames = [];

  for (const [rank, p] of PLATES.entries()) {
    const src = framePath(p.key);
    if (!existsSync(src)) throw new Error(`missing plate frame ${src}`);
    const shot = byName.get(p.key);
    if (!shot) throw new Error(`no report entry for ${p.key} — the frame and the report disagree`);
    const srcMeta = await sharp(src).metadata();

    const renditions = [];
    for (const w of rank === 0 ? [...PLATE_WIDTHS, ...HERO_EXTRA_WIDTHS] : PLATE_WIDTHS) {
      const h = Math.round((w * srcMeta.height) / srcMeta.width);
      const buf = await sharp(src)
        // effort 6 rather than `optimize-assets`'s 5: this is two dozen files built by hand,
        // not ninety textures built on every deploy, so the extra second each is free.
        .resize(w, h, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: w <= 960 ? 72 : 76, effort: 6 })
        .toBuffer();
      const rel = `press/${p.key}-${w}.webp`;
      await writeFile(path.join(PUBLIC, rel), buf);
      written.push([rel, buf.length]);
      renditions.push({ url: `/${rel}`, w, h, bytes: buf.length });
    }

    const analysis = await typeReadability(src);
    frames.push({
      id: p.key,
      rank,
      hero: rank === 0,
      verdict: p.verdict,
      alt: p.alt,
      note: p.note,
      desc: shot.desc,
      battle: {
        // `desc` and the camera come from the report; the map and hour are recovered from the
        // shot key and the report's own resolved numbers rather than restated by hand.
        map: p.key.includes('carth') ? 'carthage' : p.key.includes('pydna') ? 'pydna' : 'campus-martius',
        era: p.key.includes('carth') ? '146 BC' : p.key.includes('pydna') ? '168 BC' : '271 AD',
        scenario: shot.wallDebug ? 'assault' : 'field',
        simTime: +shot.simTime.toFixed(1),
        men: shot.men,
        units: shot.units,
        weather: shot.weather,
        sunElevationDeg: shot.sunElev,
        sunAngleOffLensDeg: shot.sunAngle,
      },
      camera: {
        focusX: shot.focusX, focusZ: shot.focusZ, yaw: shot.yaw,
        cam: shot.camDebug ?? null,
        wall: shot.wallDebug ?? null,
        nearestManM: shot.nearestMan,
        horizonFrac: shot.horizonFrac,
      },
      source: {
        file: `screenshots/press/${p.key}.png`,
        width: srcMeta.width,
        height: srcMeta.height,
        shot: p.key,
        report: shot.report,
      },
      renditions,
      srcset: renditions.map((r) => `${r.url} ${r.w}w`).join(', '),
      ...analysis,
    });
  }

  const manifest = {
    $comment: 'GENERATED by tools/make-brand.mjs. Every frame is a real render of this game, '
      + 'produced by `node tools/shoot.mjs --set=press`. Do not edit by hand — '
      + '`node tools/qa-brand.mjs` re-derives this file and fails if the checked-in copy differs.',
    consumers: {
      openGraph: 'the hero, cropped to 1200x630 with a scrim and wordmark, at /og/total-claude.jpg',
      firstPaint: 'the hero as an instant still behind the menu, before a live scene can boot',
      fallback: 'any frame, for a device that cannot afford a live scene',
    },
    /**
     * Handover notes, from the agent that shot the set to whoever builds the front door.
     *
     * Nothing here is wired into the menu — `.menu-bg` in `src/ui/menu.css` is untouched and
     * `src/ui/MainMenu.ts` does not import `pressPlates.ts`. These are the things that were
     * measured on the way past and would otherwise have to be rediscovered.
     */
    forTheMenu: {
      import: "import { HERO, PRESS_PLATES } from './pressPlates';",
      whereItGoes:
        '`.menu-bg` is a single empty div behind both sheets (front door and battle setup), '
        + 'created in MainMenu.build(). It is the natural mount point and covers both screens.',
      typeIsProtectedAlready:
        'The menu sheet is `--panel-bg`, a gradient from rgba(30,24,17,0.94) to '
        + 'rgba(16,12,9,0.97) — 94 to 97 % opaque. So text contrast on the sheet barely moves '
        + 'whatever is behind it. `scrimForGold` below is the number for type laid DIRECTLY on '
        + 'a frame, which is the harder case and the one to check if the sheet ever thins.',
      quietestFrames:
        'Measured, not guessed: press-rome-melee (5.25:1, scrim 0) and press-rome-cavalry '
        + '(5.93:1, scrim 0) take gold type with no scrim at all. press-rome-city LOOKS like '
        + 'the calm one and is joint worst at 0.65 — the morning haze lifts its midtones.',
      firstPaintBytes:
        'HERO at 960w is 88.8 kB, at 1440w 230.7 kB, at 1920w 459.2 kB. Nothing in this '
        + 'directory is on the cold load; index.html references none of it.',
      ifYouRotate:
        'Fetch the next plate only once someone has lingered, not on mount — a visitor who '
        + 'clicks BATTLE in three seconds should pay for one image, not six. And honour '
        + 'prefers-reduced-motion by not rotating at all, which also costs nothing.',
      dontUseTheseFor:
        'The in-battle settings panel. That one sits over a live game and a screenshot behind '
        + 'it would be a picture of a different battle than the one being played.',
      frontDoorAsItStands:
        'Judged from tools/shoot.mjs --shots=menu-door at 1440x900, not from the source. What '
        + 'is good is genuinely good and should not be touched: the wordmark tracking, the '
        + 'serif, the single oxblood primary against three recessive plaques, and the plaque '
        + 'copy, which describes each destination by what is inside it rather than by its '
        + 'name. Four things are weak. (1) The background is an empty near-black field with a '
        + 'faint radial — this is a 3D game whose front door shows no 3D, and it is the whole '
        + 'reason this set exists. (2) The mark beside the title is an eight-pointed starburst '
        + 'described in the source as an eagle; at 46 px it reads as an asterisk. (3) In a tall '
        + 'viewport the sheet floats in the middle with large dead zones above and below, '
        + 'because it is `place-items: center` with nothing else on the page. (4) Nothing '
        + 'anywhere on the screen says nine thousand men, which is the only fact about this '
        + 'project that would make a stranger stay.',
      theEagle:
        'The `EAGLE` const in MainMenu.ts and the one in index.html\'s loading panel are the '
        + 'same eight-pointed starburst, which is not an eagle. The favicon now IS an aquila '
        + '(markSvg() in tools/make-brand.mjs, and markInline() is the same bird with no tile, '
        + 'ready to drop into a template). Making the three agree is a real improvement and it '
        + 'is deliberately NOT done here, because it is a change to the established visual '
        + 'identity and that is the owner\'s call, not a side effect of adding a favicon.',
    },
    howToRead: {
      'type.scrimForGold':
        'the smallest black scrim alpha at which #d9b25f type clears 4.5:1 against the 95th '
        + 'percentile luminance inside `type.panelBox`. 0 means the frame needs no scrim; '
        + 'above ~0.45 it has stopped being a picture.',
      'type.quiet': 'scrimForGold <= 0.25, i.e. gold type is readable on it without hiding it.',
      grid: 'row-major 3x3 mean relative luminance, for finding the quiet third of a frame.',
      renditions: 'pick with `srcset`. Every frame has 960 and 1440; only the hero also has 1920, because three widths across nine frames was 5.79 MB in public/ and the third one buys almost nothing behind a menu. 1920 is the ceiling because 1920 is the capture size.',
    },
    provenance: {
      commit: meta.commit,
      srcTree: meta.srcTree,
      capturedAt: `${meta.width}x${meta.height}`,
      quality: meta.quality,
      dpr: meta.dpr,
      hud: meta.hud,
      gl: meta.gl,
      reports,
      tool: 'node tools/shoot.mjs --set=press --w=1920 --h=1080 --out=screenshots/press',
    },
    widths: PLATE_WIDTHS,
    heroExtraWidths: HERO_EXTRA_WIDTHS,
    hero: PLATES[0].key,
    heroBecause: PLATES[0].note,
    frames,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(dir, 'manifest.json'), text);
  written.push(['press/manifest.json', Buffer.byteLength(text)]);

  written.push(...await writePlateModule(frames));
  return { written, frames };
}

/**
 * `src/ui/pressPlates.ts`, generated.
 *
 * `public/press/manifest.json` is the full description and is meant to be read by a person or
 * a tool. This is the part an *application* needs, and it is a module rather than a fetch for
 * one reason: the hero still has to be on screen in milliseconds, and a round trip to a
 * manifest before the first byte of the image is requested is the opposite of that.
 *
 * Generated by the same pass that writes the files, so it cannot name one that does not exist —
 * a plate listed in `src/` and missing from `public/press/` is a 404 on the front door, which
 * is the failure the icon comment in `index.html` exists to describe. `tools/qa-brand.mjs`
 * re-derives this module and fails if the checked-in copy has drifted.
 */
export function plateModuleText(frames) {
  const entries = frames.map((f) => `  {
    id: ${JSON.stringify(f.id)},
    hero: ${f.hero},
    alt: ${JSON.stringify(f.alt)},
    srcset: ${JSON.stringify(f.srcset)},
    src: ${JSON.stringify(f.renditions[1].url)},
    width: ${f.renditions[1].w},
    height: ${f.renditions[1].h},
    scrimForGold: ${f.type.scrimForGold},
  },`).join('\n');
  const text = `/**
 * The press stills: real frames of this game, addressable from the app.
 *
 * GENERATED by \`tools/make-brand.mjs\` in the same pass that encodes the files, so this list
 * can never name a plate \`public/press/\` does not hold. Do not edit by hand —
 * \`node tools/qa-brand.mjs\` re-derives it and fails on drift.
 *
 * \`public/press/manifest.json\` is the same set with everything else about it: which battle,
 * where the camera stood, every rendition's bytes, and the luminance measurements these
 * \`scrimForGold\` values are the summary of.
 *
 * Intended uses, in the order they matter:
 *
 *   1. **The instant first paint.** A live scene has to boot the renderer; a still is on
 *      screen in milliseconds. \`HERO\` is the one to show, and \`src\`/\`srcset\` are sized so a
 *      phone does not fetch a desktop plate.
 *   2. **The fallback** for anything that cannot afford a live scene — a weak GPU, a small
 *      viewport, a device already told it is too narrow to play on.
 *   3. **The link preview**, which is \`/og/total-claude.jpg\`, cropped from \`HERO\`.
 *
 * \`scrimForGold\` is the smallest black scrim alpha at which \`--gold\` (#d9b25f) type clears
 * 4.5:1 against the brightest part of the region a centred menu sheet covers. 0 means none is
 * needed. It is measured on every frame rather than eyeballed on one.
 */

export interface PressPlate {
  /** The \`press-*\` shot in \`tools/shoot.mjs\` that produced it. */
  id: string;
  hero: boolean;
  /** For a screen reader, and for \`og:image:alt\` on the hero. */
  alt: string;
  /** Every rendition, for a \`srcset\` attribute. Widths: ${PLATE_WIDTHS.join(', ')}. */
  srcset: string;
  /** The middle rendition, for a plain \`src\` fallback. */
  src: string;
  width: number;
  height: number;
  /** Smallest black scrim alpha at which gold type clears 4.5:1 on this frame. */
  scrimForGold: number;
}

export const PRESS_PLATES: readonly PressPlate[] = [
${entries}
];

/** The frame to paint first. */
export const HERO: PressPlate = PRESS_PLATES[0];
`;
  return text;
}

async function writePlateModule(frames) {
  const text = plateModuleText(frames);
  await writeFile(path.join(ROOT, 'src', 'ui', 'pressPlates.ts'), text);
  return [['src/ui/pressPlates.ts', Buffer.byteLength(text)]];
}

// ---------------------------------------------------------------------------

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

/**
 * Run only when run, so `tools/qa-brand.mjs` can import the pieces.
 *
 * Without this guard the checker cannot import `BRAND`, `markSvg` or `plateModuleText` without
 * *rebuilding every asset as a side effect of the import* — which would make the check
 * unfalsifiable in the most literal way available: it would write the answer it then read.
 */
async function main() {
  const only = args.get('only');
  const want = (name) => !only || only.split(',').includes(name);

  const written = [];
  let frames = null;
  if (want('icons')) written.push(...await buildIcons());
  if (want('plates')) {
    const r = await buildPlates();
    written.push(...r.written);
    frames = r.frames;
  }
  // After the plates: the card is cropped from the hero, which `buildPlates` has just proved
  // exists and has just measured.
  if (want('card')) written.push(...await buildCard());

  let total = 0;
  for (const [name, bytes] of written) {
    total += bytes;
    console.log(`  ${name.padEnd(38)} ${kb(bytes).padStart(9)}`);
  }
  console.log(`\n${written.length} file(s), ${kb(total)} total.`);

  if (frames) {
    console.log('\n  frame                     verdict  gold on frame  scrim  '
      + PLATE_WIDTHS.map((w) => `${w}w`.padStart(8)).join('') + '    hero');
    for (const f of frames) {
      console.log(`  ${f.id.padEnd(24)}  ${(f.verdict + (f.hero ? ' *' : '')).padEnd(8)} `
        + `${`${f.type.goldOnFrame}:1`.padStart(12)}  ${String(f.type.scrimForGold).padStart(5)}  `
        + f.renditions.map((r) => kb(r.bytes).padStart(8)).join(''));
    }
    const hero = frames[0];
    console.log(`\n  first paint, hero only: ${kb(hero.renditions[0].bytes)} on a phone (960w), `
      + `${kb(hero.renditions[1].bytes)} on a laptop (1440w), `
      + `${kb(hero.renditions[2].bytes)} full-bleed at 1920w`);
    console.log(`  whole set, every rendition: ${kb(frames.flatMap((f) => f.renditions).reduce((a, r) => a + r.bytes, 0))}`);
  }

  console.log('\nNow: node tools/qa-brand.mjs');
  if (!existsSync(FRAMES)) console.log(`(no frames at ${FRAMES})`);
  else console.log(`frames from ${path.relative(ROOT, FRAMES)}: ${(await readdir(FRAMES)).filter((f) => f.endsWith('.png')).length} png`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
