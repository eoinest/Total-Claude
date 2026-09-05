#!/usr/bin/env node
/**
 * Every pixel of the site's dressing, generated from this repository.
 *
 * The favicon set, the web manifest, the Open Graph card and the press stills — everything
 * a stranger sees before pressing anything. Run it and the whole of `public/favicon*`, `public/icon-*`,
 * `public/apple-touch-icon.png`, `public/site.webmanifest`, `public/og/` and `public/press/`
 * are rewritten from source that lives here: an SVG authored in this file, and PNG frames
 * that `tools/shoot-press.mjs` rendered out of the game itself.
 *
 *     node tools/shoot-press.mjs         # shoots at 5120, stores at 2560, ten page loads
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
/** Where `tools/shoot-press.mjs` left its frames, captured at 5120 and stored at 2560. */
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
 *
 * ---------------------------------------------------------------------------
 * Sep 2026: what the running order is still for, now that the menu rolls dice
 * ---------------------------------------------------------------------------
 *
 * `MenuBackdrop` draws the front door's frame at random from this whole list and each deeper
 * screen's from the frames of the battle that screen names, so **rank no longer decides what
 * anybody sees**. Two things still depend on the order and both are worth stating, because a
 * list whose order has stopped mattering is a list somebody will re-sort:
 *
 *   - `PLATES[0]` is the hero, and the hero is the Open Graph card. That is a link preview at
 *     about 400 px in a chat client, which is a completely different test from a full-bleed
 *     backdrop: it is won by one large silhouette and lost by nine thousand four-pixel men.
 *   - Nothing else. There is no longer a per-rank rendition ladder; every frame carries the
 *     same widths, because every frame can now be the first thing a stranger sees.
 *
 * **Membership is the decision this file makes, and it is a harder one than it was.** Forty-five
 * cameras were shot for this pass and the ones below are what survived being looked at. The
 * failures are recorded under "shot, looked at, and left out" beneath this list, because a
 * camera that failed is cheaper to fix than to reinvent and because the pattern in them is
 * worth more than any single frame: the `eyeline-` family, lifted wholesale, produced press
 * frames that were diagnostics — a wall face filling the frame, one man's shoulder at 59 cm —
 * and the `follow`-and-`cam` families produced almost nothing but keepers.
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
      + 'go to noise. Still the hero, and the hero is now only the Open Graph card: the menu '
      + 'draws its front door at random from this whole list.',
  },
  {
    key: 'press-rome-parapet',
    verdict: 'strong',
    alt: 'The assault at its densest inside the Aurelian circuit, spears crossed above locked '
      + 'shields and a standard over the press.',
    note: 'The frame this set was missing, and it was missing for a timing mistake this file '
      + 'recorded and has now fixed. It shipped as a cut at t+150, where `follow: contact` '
      + 'resolved to open ground; the ram\'s own measured schedule says why — the gate goes at '
      + 't+220 — so t+230 is the first second at which there is reliably a fight to photograph.',
  },
  {
    key: 'press-rome-press',
    verdict: 'strong',
    alt: 'The Roman line going in under a late sun, rank behind rank across the whole frame, '
      + 'the host beyond them and a band of evening cloud above.',
    note: '`ab2-rome-melee`\'s camera — 2.55 m up, a head taller than the tallest man here, '
      + 'looking down into the press. That height is not taste: `contact` resolves to the '
      + 'densest 40 m cell of a melee eight thousand men deep, and that set measured 14 m of '
      + 'standoff putting the nearest man at 0.75 m against 17 m putting him at 0.88. Three '
      + 'metres bought thirteen centimetres; the only lever left is to get above the helmets.',
  },
  {
    key: 'press-rome-melee',
    verdict: 'strong',
    alt: 'Inside the melee on the Campus Martius in late light: helmets and crossed spears '
      + 'filling the frame, legionaries and Juthungi warriors at arm\'s length.',
    note: 'The hardest thing this renderer does, photographed at the distance where you can '
      + 'see it is doing it. Also one of the darkest frames in the set, which is the same thing '
      + 'as saying gold type sits on it with almost no scrim.',
  },
  {
    key: 'press-rome-helmets',
    verdict: 'strong',
    alt: 'The legionary front rank from a man\'s own eye height, telephoto down the line, a '
      + 'vexillum above it and open sky beyond.',
    note: '`ab2-rome-line`\'s camera: 2.05 m up, eight metres out, a thirty-degree lens, swung '
      + '1.2 rad off a sun that would otherwise be ten degrees off it. The only frame in the '
      + 'set shot from inside the line rather than across it, and one of the very few whose top '
      + 'third is sky — which is what a sheet of gold type wants behind it, and which almost no '
      + 'camera in this project produces, because above zoom 0.6 the rig fills the viewport '
      + 'with ground.',
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
    key: 'press-rome-ram',
    verdict: 'strong',
    alt: 'The ram at the Porta Flaminia mid-battery, the gatehouse drums above it and a column '
      + 'of men in the passage.',
    note: 'The gate is the best single piece of modelling in the game and the shipped cut of '
      + 'this frame stood six metres from it, which made a picture of two brick cylinders. This '
      + 'file recorded the remedy — "worth re-shooting from 40 m" — and this is it at 46, with '
      + 'the eye lifted to 12 m so the depression holds. The frame is now the gate, the engine '
      + 'and the men rather than one of the three.',
  },
  {
    key: 'press-rome-wall',
    verdict: 'strong',
    alt: 'The Aurelian Wall of Rome at mid-morning, its towers and gatehouse above the glacis, '
      + 'the city behind it.',
    note: 'The subject of the whole product in one frame — a city wall, and ground in front of '
      + 'it to cross. Hazier than the rest because it is the only frame shot through 500 m of '
      + 'atmosphere, which is also why it wants more scrim than it looks like it should.',
  },
  {
    key: 'press-rome-cavalry',
    verdict: 'strong',
    alt: 'A wedge of horse sweeping the flank at eye level in low sun, painted shields against '
      + 'the light.',
    note: 'Eye level among the horses, and the only frame that sells motion. Backlit and dark, '
      + 'which used to be the reason it was a fallback rather than a first impression and is '
      + 'now one of the reasons it is good: the darkest frames in the set are the ones gold '
      + 'type sits on with no scrim at all.',
  },
  {
    key: 'press-rome-grey',
    verdict: 'strong',
    alt: 'The Juthungi line still fighting over ground already littered, under a flat overcast '
      + 'noon, a standard among them and cloud to the horizon.',
    note: 'The first frame in the set with weather in it — all nine that shipped before were '
      + 'clear — and it turns out to be one of the best, for a reason that is about the menu '
      + 'rather than about the battle: `overcast` lifts mist to 0.45 and drops dust to 0.72, '
      + 'which puts a real horizon and a band of cloud across the top of a frame that at any '
      + 'other hour is filled with ground. `ab2-rome-aftermath`\'s camera, at its t+140 rather '
      + 'than t+190 — by 190 the lines have come apart on this map and `contact` frames men '
      + 'standing about in grass.',
  },
  {
    key: 'press-rome-hordegrey',
    verdict: 'strong',
    alt: 'The Juthungi host coming on under a shadowless sky, painted round shields filling the '
      + 'upper half of the frame.',
    note: 'The same warband as `press-rome-host` in the other kind of light. Flat light is what '
      + 'the shield paint wants — in low sun half of them are in shadow — so this is the frame '
      + 'in which the "no two men kitted the same" claim is easiest to check.',
  },
  {
    key: 'press-rome-mist',
    verdict: 'fair',
    alt: 'The legionary cohorts drawn up under an overcast noon, no shadow anywhere, the '
      + 'standard at the head of them.',
    note: 'The uniform line under the one lighting condition that flatters nothing. It is in '
      + 'the set as the control: if the ranks read here, they read.',
  },
  {
    key: 'press-rome-ladder',
    verdict: 'fair',
    alt: 'The Aurelian curtain from above the glacis, a tower on the crest and the Tiber and '
      + 'the city behind it.',
    note: 'It shipped as a cut, for framing "the curtain with no ladders on it". The escalade '
      + 'family had already measured the window on this bay — a man on a rung at t+13, nobody '
      + 'at the foot after t+45 — so t+60 was past the end of it rather than before the start, '
      + 'and t+34 is inside it. The ladders are still not the subject at this standoff. What '
      + 'this is now is the second view of the wall in the set, from closer than '
      + '`press-rome-wall` and with the tower reading as a tower.',
  },
  {
    key: 'press-rome-city',
    verdict: 'fair',
    alt: 'Rome from above at first light: the Aurelian circuit along the crest, the Tiber '
      + 'below it, the fabric of the city inside.',
    note: 'Quiet and atmospheric rather than arresting, and the only frame that shows the city '
      + 'as a city. It reads as the calm one and it is not: morning haze lifts its midtones and '
      + 'it measures among the worst in the set for type. Prose said otherwise here until the '
      + 'measurement was run, which is why every frame is measured and none is eyeballed.',
  },
  {
    key: 'press-rome-march',
    verdict: 'fair',
    alt: 'A vexillum at the head of the cohorts on the march, the standard against the grass '
      + 'with the ranks behind it.',
    note: 'The one frame whose subject is an object rather than a crowd. `ab-rome-march`\'s '
      + 'camera at t+40, which is after the lines have begun to move and before anything has '
      + 'touched — the part of a battle nothing else in this set photographs.',
  },
  {
    key: 'press-rome-aftermath',
    verdict: 'fair',
    alt: 'The field after the break in low sun: the dead in heaps, shields and spears among '
      + 'them, the grass dark around it.',
    note: 'The only frame about what a battle costs, and it is here for two reasons rather '
      + 'than one. A rotation that is nothing but arresting frames has no range in it; and the '
      + 'dark frames are measurably the best in the set to put gold type on, which is the '
      + 'opposite of what anyone guesses by looking at them.',
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
    key: 'press-carth-tusks',
    verdict: 'strong',
    alt: 'The Punic elephants head-on from in front of the spear line, crews in the towers, a '
      + 'band of evening cloud above them.',
    note: 'The same animals as `press-carth-elephants` from a quarter of the standoff and from '
      + 'the other side, on `ab2-carth-elephants`\'s camera. Kept beside it rather than instead '
      + 'of it, because the two are not the same picture: one is a line arriving obliquely and '
      + 'this is the thing itself, coming at the lens, with sky above it — which also makes it '
      + 'one of the frames gold type sits on most easily. The owner named this subject: "or '
      + 'perhaps watching an elephant\'s charge idk."',
  },
  {
    key: 'press-carth-wall',
    verdict: 'strong',
    alt: 'The wall of Carthage from the field in late afternoon, siege towers against the '
      + 'curtain and Roman assault columns drawn up on the red plain before it.',
    note: 'The second city, in the opposite end of the day from Rome\'s — 16:30, because the '
      + 'Punic curtain is a west face and is in its own shade before mid-afternoon. Pale '
      + 'limestone against red earth against a white city, which is the only palette in the set '
      + 'that is not green and gold.',
  },
  {
    key: 'press-carth-storm',
    verdict: 'strong',
    alt: 'Carthage under assault from high above the curtain: the wall, the citadel on its '
      + 'hill behind, and the city filling the frame.',
    note: '`ab2-carth-wall`\'s camera, and its note is the reasoning: 200 m out at 45 m up '
      + 'rather than 520 at 110, because the far version put the whole city in a strip across '
      + 'the middle of an empty plain. It is the only frame that shows a besieged city as a '
      + 'city rather than as a wall.',
  },
  {
    key: 'press-carth-line',
    verdict: 'strong',
    alt: 'The Punic front rank in late afternoon — Libyan spears and Iberian scutarii, every '
      + 'oval shield painted differently, a standard above them.',
    note: 'It shipped as a cut for being "good, and redundant beside press-rome-line and '
      + 'press-pydna-clash". Redundancy was a real objection when the set was nine frames and '
      + 'one of them had to stand behind every screen; in a rotation it is close to the '
      + 'opposite of one.',
  },
  {
    key: 'press-pydna-clash',
    verdict: 'strong',
    alt: 'Thousands of men locked together on open Macedonian ground at Pydna, 168 BC, spears '
      + 'and standards above the press.',
    note: 'The scale claim at its most literal — a wall of men to the horizon. Spectacular '
      + 'large, and it is texture rather than a picture below about 500 px, which is exactly '
      + 'the failure mode a link preview punishes and is why it is not the hero.',
  },
  {
    key: 'press-pydna-line',
    verdict: 'fair',
    alt: 'Pydna in the morning: a block of legionaries with their standard on dry Macedonian '
      + 'grass, the Macedonian line a dark bar on the horizon.',
    note: 'It shipped as a cut for being redundant beside `press-pydna-clash`, and it is here '
      + 'now for the same reason the two Punic line shots are. It is also the only frame in the '
      + 'set on dry yellow grass, which is Pydna\'s whole visual difference from the other two '
      + 'battlefields, and Pydna needs frames of its own: the menu draws each battle\'s '
      + 'backdrop only from that battle\'s frames, so a map with none would show the wrong war.',
  },
];

/**
 * ---------------------------------------------------------------------------
 * Shot, looked at, and left out
 * ---------------------------------------------------------------------------
 *
 * Recorded because "we kept two dozen of forty-five" is a fact about the *cameras*, and the
 * next person to point one at this game should not have to rediscover these.
 *
 * ## The eight from the pass that shot sixteen, and what happened to them
 *
 * All eight were re-examined and **five are now in the set**. Six of the eight had been cut
 * with a named remedy attached, and applying those remedies recovered three of them outright;
 * two more came back because the reason they were cut — redundancy — stopped being a reason
 * once the menu started rotating. The two remedies that were applied and did **not** work are
 * marked as such, because a remedy that was tried and failed is worth more than one that was
 * never tried:
 *
 *   press-rome-parapet   Cut: `follow: 'contact'` at t+150 resolved to open ground, because
 *                        there was no melee anywhere on the circuit at that second. FIXED at
 *                        t+230, which the ram's own schedule picks out — the gate goes at
 *                        t+220 — and it is now among the strongest frames in the set.
 *   press-rome-ram       Cut: the camera stood 6 m from the gate, so the frame was two tower
 *                        drums. FIXED at 46 m with the eye lifted to 12 to hold the depression.
 *   press-rome-ladder    Cut: framed the curtain with no ladders on it at t+60. FIXED at t+34;
 *                        the escalade family had already measured that nobody is at the foot
 *                        of this bank after t+45, so t+60 was past the end rather than early.
 *   press-rome-advance   Cut: an aerial at zoom 0.40, because `ownLine` puts the eye behind the
 *                        whole army. RE-SHOT with four lengths instead of a zoom scalar —
 *                        see the verdict on it below, which is still not good.
 *   press-carth-wide     Cut: a strategic view at zoom 0.62. RE-SHOT on `ab2-carth-wide`'s
 *                        cam block and STILL CUT: at 180 m over a Punic field the blocks are
 *                        smudges. A picture of ground is a picture of ground at any framing.
 *   press-carth-line     Cut as "good, and redundant". KEPT this time: redundancy was a real
 *                        objection when nine frames had to cover every screen and is close to
 *                        meaningless in a rotation.
 *   press-pydna-line     The same, and kept for the same reason.
 *   press-carth-ditch    Cut: a ditch seen from its own bank is invisible, which is what a
 *                        ditch is for. Still true.
 *
 * ## The new failures, and the one pattern worth carrying forward
 *
 * **Do not lift an `eyeline-` camera into a press frame.** Four were tried and four failed, and
 * they failed for the same reason rather than four reasons: that family exists to photograph a
 * *surface* — is the wall-walk where the city says it is — so it is `zoom: 0` at a man's eye
 * height with `lift: 'stand'`, and what it produces is a diagnostic. A diagnostic is a picture
 * of one object filling the frame.
 *
 *   press-rome-walk      `eyeline-rome-along` at t+150. Nearest man 0.59 m: one legionary's
 *                        shoulder and helmet across the whole frame, at the distance where the
 *                        modelling is the subject.
 *   press-rome-tower     `eyeline-rome-tower`. A flat slab of brick and a strip of paving.
 *   press-carth-walk     The Punic twin of `press-rome-walk`, cut unshot once the Roman one
 *                        had been looked at.
 *   press-rome-embrasure `ab2-rome-parapet` — which is not `eyeline-` but is the same mistake
 *                        one level up: a camera aimed 2.5 m *below* the walk surface to put the
 *                        city under you, which at press scale is brick and paving and no men.
 *
 * And three that failed for reasons of their own, each worth a line:
 *
 *   press-rome-glacis    `ab2-rome-wall`'s camera moved from 14:18 to 09:30 and measured
 *                        **10.1 degrees off the sun**. That shot's `yawAdd: 0.55` exists to
 *                        swing away from a 14.7-degree sun in the afternoon; in the morning the
 *                        same swing turns *into* it. The frame is cypresses and a fence.
 *                        **An hour and a yaw are one decision, not two.**
 *   press-rome-escalade  `escalade-foot-28` verbatim at t+28. That camera is 32 m out and 13 m
 *                        up, which its own family calls a diagnostic distance — it proves a
 *                        queue and shows nothing of the wall — and at bay -3 on this tree the
 *                        bank had not formed. A wall corner and empty grass.
 *   press-carth-spears   `ab2-carth-melee`'s 5 m camera on `libyan-spearmen` at t+110. At five
 *                        metres a camera is either inside the named unit or nowhere near it,
 *                        and this was the second. Grass, and a line on the horizon.
 *
 * All of them are still in `tools/shoot.mjs`, because they cost almost nothing — every one
 * rides in a page load another frame was already paying for — and because a camera that failed
 * is cheaper to fix than to reinvent. Five of the eight above prove it, and the two that were
 * re-shot and cut again prove the other half of it: the note is a record, not a promise.
 */

/**
 * ---------------------------------------------------------------------------
 * The widths served, and the CSS-pixel mistake this replaces
 * ---------------------------------------------------------------------------
 *
 * This ladder used to be `[960, 1440]` with 1920 for the hero alone, and the reasoning written
 * here for it was: "a 1920-wide window shows a 1440 plate upscaled 1.33x *behind a menu*,
 * which is not a place anyone has ever noticed resampling." The same conclusion is reached at
 * more length in `src/ui/menu.css`, which computes the backdrop's total over-scale as
 * `1.235 x 1.18 x 1.06 = 1.55` and says "the softness is accepted".
 *
 * **Both of those sums are in CSS pixels, and the display is not.** The owner reported the
 * menu art as soft and he is on a Retina Mac. `tools/scratch/menu-density.mjs` inverts the
 * whole transform chain in the live page — `object-fit: cover`, then `.bd-travel`'s vantage,
 * then `.bd-drift`'s wander, then `devicePixelRatio` — and reports the device pixels the frame
 * is actually painted across against the pixels the chosen rendition has:
 *
 * | window | front door | setup screen | it was given |
 * |---|---:|---:|---|
 * | 1366x768 @1 | 1,669 | 2,008 | 1440 |
 * | 1920x1080 @1 | 2,345 | 2,822 | 1440 |
 * | 1440x900 @2 | 3,909 | 4,704 | 1440, or 1920 on the hero |
 * | 1512x982 @2, 14-inch | 4,265 | 5,132 | 1440, or 1920 on the hero |
 * | **1728x1117 @2, 16-inch** | **4,851** | **5,838** | 1440, or 1920 on the hero |
 *
 * So the frame the owner is looking at on the setup screen is a 1,440 px picture stretched
 * across 5,838 device pixels — **4.05x** — and the hero, the one frame with a 1920, is at
 * 3.04x. The old `sizes` cap of 1440 is only half of it: even a bare `100vw` resolves 1,728 CSS
 * pixels there, doubles to 3,456 device pixels, and still hits a ceiling that is not there.
 *
 * ---------------------------------------------------------------------------
 * Where the ladder stops, measured rather than argued
 * ---------------------------------------------------------------------------
 *
 * `tools/scratch/plate-ladder.mjs` encodes each candidate rung, upscales it back to the 4,851
 * device pixels of that 16-inch front door, and measures what fraction of the reference's
 * gradient energy survives — "detail", where 1.00 is what the display could show if the frame
 * had every pixel it is painted across. On `press-rome-host`, the densest frame in the set:
 *
 * | rung | upscale | detail | AVIF q55 bytes | step buys |
 * |---|---:|---:|---:|---|
 * | 1440 | 3.37x | 0.740 | 205 kB | — (this is what ships today) |
 * | 1920 | 2.53x | 0.865 | 346 kB | **+12.5 points** |
 * | 2560 | 1.89x | 0.941 | 598 kB | **+7.6 points** |
 * | 3200 | 1.52x | 0.969 | 907 kB | +2.8 points for +52 % bytes |
 * | 3840 | 1.26x | (0.973 in WebP) | — | under a point, and above the capture |
 *
 * **2560 is the last rung worth taking and 3200 is the first that is not**, and that is the
 * whole of why the ladder stops where it does.
 *
 * The shipped set is 20.1 MB and it divides like this, which is the cut list if the deployment
 * ever needs the room:
 *
 * | rung | MB | share | what cutting it costs |
 * |---|---:|---:|---|
 * | AVIF 2560 | 7.1 | 35 % | every 2x Mac back from 1.90x to 2.53x — the owner's own machine |
 * | AVIF 1920 | 4.4 | 22 % | every 1x desktop back from about 1:1 to 1.6x |
 * | WebP 1440 | 4.0 | 20 % | Safari below 16.4 gets no picture, only the gradient floor |
 * | AVIF 1440 | 3.0 | 15 % | small windows take the 1920 and pay 45 % more bytes |
 * | AVIF 960 | 1.6 | 8 % | phones take the 1440 |
 *
 * **The 2560 rung is the first thing to cut and the last thing to want to cut**, and it is
 * named here so that cutting it is a decision rather than a drift.
 *
 * **The hero's privilege is gone, and randomising is why.** `MenuBackdrop` now draws the front
 * door's frame from the whole set, so any frame can be the first thing a stranger sees
 * full-bleed. A ladder that stops early on eight frames out of nine is a ladder that is wrong
 * eight times out of nine.
 *
 * ---------------------------------------------------------------------------
 * Quality, which is not the lever, except where it is
 * ---------------------------------------------------------------------------
 *
 * The prior pass measured WebP q58 to q76 as 181 kB to 245 kB at 1440 and concluded these
 * frames barely respond to the quality knob. That is true of the dense ones and **false of the
 * smooth ones**: on `press-rome-city`, which is haze and rooftops, AVIF q45 to q55 at 2560
 * moves detail 0.775 to 0.851, while on `press-rome-host` the same step moves it 0.925 to
 * 0.941. So quality is held near the middle and allowed to rise as the rendition gets smaller,
 * because a small rendition is the only thing its device will ever see and has no density to
 * hide behind. It is not pushed high anywhere, because density is doing the work.
 *
 * AVIF rather than WebP, measured on the same instrument: at equal detail on the worst frame,
 * AVIF q55 at 2560 is 598 kB against WebP q58's 813 kB for 0.941 against 0.936 — **26 % fewer
 * bytes** — and on the smooth frames AVIF is both smaller and sharper. One WebP rendition
 * survives per frame as the `<picture>` fallback at exactly the width and quality the whole
 * set shipped at before this pass, so a browser without AVIF (Safari below 16.4, which can
 * still run this game's WebGL2) sees precisely what every browser saw a week ago.
 */
const PLATE_WIDTHS = [960, 1440, 1920, 2560];
/** Rising as the rendition shrinks: a small plate is all its device will ever be given. */
const AVIF_QUALITY = { 960: 58, 1440: 55, 1920: 52, 2560: 50 };
/**
 * The one WebP per frame, for a browser with no AVIF.
 *
 * 1440 at q72 is not a compromise chosen here — it is the exact rendition this set shipped as
 * its `src` before this pass, so the fallback is bit-for-bit the old behaviour rather than a
 * new and untested small thing.
 */
const FALLBACK_WIDTH = 1440;
const FALLBACK_QUALITY = 72;

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
 * The box the menu sheet covers, as fractions of the frame — **measured in the live page**.
 *
 * This used to be `{ x: 0.25, y: 0.14, w: 0.50, h: 0.72 }`, derived on paper from a sheet
 * sized `min(760px, 94vw)` sitting over the middle of the frame. Three things were wrong with
 * that, and the third one mattered:
 *
 *   1. The sheet is `min(1180px, 94vw)` now, not 760.
 *   2. It is not one box. The front door's sheet is short and the setup sheet is tall, and
 *      both are a different fraction of the frame on every window shape.
 *   3. **The sheet does not sit over the middle of the frame.** `MenuBackdrop` scales the
 *      frame past the viewport and translates it so a chosen point — `(0.5, 0.42)` at the
 *      front door, `(0.46, 0.62)` on the setup screen — lands at the centre of the *viewport*,
 *      and then `object-fit: cover` crops it again by an amount that depends on the window's
 *      aspect. The region the sheet actually covers is therefore lower down the frame than
 *      the middle, and moves when the player goes deeper.
 *
 * `tools/scratch/menu-panelbox.mjs` inverts that whole chain in the live page across six
 * window shapes and both screens. The union, clamped to the frame, is
 * `{ x: 0.194, y: 0.245, w: 0.588, h: 0.648 }` — so the box below is that, rounded outward.
 *
 * **What the old box was measuring instead.** It ran from y 0.14 to y 0.86; the real one runs
 * from 0.245 to 0.893. The old top edge sat a tenth of the frame higher — which on a set of
 * frames deliberately composed with sky as a band across the top is exactly where the sky is.
 * Every frame with a horizon in it was having its brightest pixels counted as if type were
 * going to be laid over them, and was being scrimmed for a threat that was never there.
 */
const PANEL_BOX = { x: 0.19, y: 0.24, w: 0.60, h: 0.66 };

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
/**
 * Which battle each `press-` shot is of, read out of `tools/shoot.mjs`'s own table.
 *
 * `tools/shoot.mjs` records `map` and `scenario` per shot in `report.json` now, and that is the
 * source this file prefers. This exists for the frames whose report predates that — and for
 * the general case of a set assembled across several passes, where some records carry the
 * fields and some do not.
 *
 * The alternative it replaces was inferring the scenario from whether the camera happened to
 * have a `wall` block, which is a fact about the lens standing in for a fact about the battle
 * and was measurably wrong: `press-rome-parapet` is `follow: 'contact'` inside a storm of the
 * Aurelian Wall, has no `wall` block, and was filed as a field battle. The menu groups its
 * rotation by this field, so that put a picture of an assault behind the row that says field.
 *
 * Parsing a sibling tool's source is not lovely and it is deliberately the *second* choice, not
 * the first. `tools/shoot-press.mjs` already reads the same table the same way to check that no
 * declared shot has been left ungrouped, so the technique is established here rather than
 * invented, and both readers break loudly rather than quietly if the table's shape changes.
 */
async function scenariosFromShotTable() {
  const src = await readFile(path.join(ROOT, 'tools', 'shoot.mjs'), 'utf8');
  const block = src.match(/const PRESS_SHOTS = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('could not find PRESS_SHOTS in tools/shoot.mjs');
  const out = new Map();
  // Split on the two-space-indented key that opens each shot, then read the two fields off the
  // body. A shot that names neither is the default battle, which is what `resolveConfig` does.
  const parts = block[1].split(/\n {2}'(press-[a-z0-9-]+)': \{/).slice(1);
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i + 1] ?? '';
    out.set(parts[i], {
      map: body.match(/\bmap:\s*'([a-z-]+)'/)?.[1] ?? 'campus-martius',
      scenario: body.match(/\bscenario:\s*'([a-z]+)'/)?.[1] ?? 'field',
    });
  }
  return out;
}

async function buildPlates() {
  const dir = path.join(PUBLIC, 'press');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const { byName, meta, reports } = await readShotReports();
  const fromTable = await scenariosFromShotTable();
  const written = [];
  const frames = [];

  for (const [rank, p] of PLATES.entries()) {
    const src = framePath(p.key);
    if (!existsSync(src)) throw new Error(`missing plate frame ${src}`);
    const shot = byName.get(p.key);
    if (!shot) throw new Error(`no report entry for ${p.key} — the frame and the report disagree`);
    const srcMeta = await sharp(src).metadata();

    /*
     * `withoutEnlargement` is the reason the capture size and this ladder are one decision: a
     * rendition can never be wider than the source, so asking for 2560 from a 1920 capture
     * hands back a 1920 file under a 2560 name and every measurement downstream of it is a lie
     * about a picture that was never that big. The press pass shoots 5120x2880 for exactly
     * this, which also makes every rung here a 2x-or-better downsample and therefore
     * supersampled — the aliasing on mail and grass is resolved away rather than encoded.
     */
    const renditions = [];
    for (const w of PLATE_WIDTHS) {
      if (w > srcMeta.width) {
        throw new Error(`${p.key} is ${srcMeta.width} px wide and the ladder asks for ${w}. `
          + 'Re-shoot: node tools/shoot.mjs --set=press --w=5120 --h=2880 --out=screenshots/press');
      }
      const h = Math.round((w * srcMeta.height) / srcMeta.width);
      const buf = await sharp(src)
        .resize(w, h, { fit: 'cover', withoutEnlargement: true })
        // effort 5 rather than `optimize-assets`'s default: AVIF effort is expensive and this
        // is two dozen frames at four widths each, so the encode is minutes rather than the
        // extra second a WebP rung costs.
        .avif({ quality: AVIF_QUALITY[w], effort: 5 })
        .toBuffer();
      const rel = `press/${p.key}-${w}.avif`;
      await writeFile(path.join(PUBLIC, rel), buf);
      written.push([rel, buf.length]);
      renditions.push({ url: `/${rel}`, w, h, bytes: buf.length, format: 'avif' });
    }
    // The single WebP, for a browser that cannot decode any of the above.
    const fh = Math.round((FALLBACK_WIDTH * srcMeta.height) / srcMeta.width);
    const fbuf = await sharp(src)
      .resize(FALLBACK_WIDTH, fh, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: FALLBACK_QUALITY, effort: 6 })
      .toBuffer();
    const frel = `press/${p.key}-${FALLBACK_WIDTH}.webp`;
    await writeFile(path.join(PUBLIC, frel), fbuf);
    written.push([frel, fbuf.length]);
    const fallback = { url: `/${frel}`, w: FALLBACK_WIDTH, h: fh, bytes: fbuf.length, format: 'webp' };
    renditions.push(fallback);

    /*
     * A frame whose report predates the pass that started recording the battle falls back to
     * inferring the scenario from the camera, and that inference is wrong for exactly one shape
     * of shot: an assault framed by `follow` rather than by `wall`. Say so rather than silently
     * filing a picture of a storm as a field battle, because the menu groups its rotation by
     * this field and a wrong one puts the wrong battle behind a lit row.
     */
    /*
     * The report first, the shot table second, and nothing third.
     *
     * There is no longer a guess from the camera's shape: if neither source knows which battle
     * this frame is of, that is a fact worth stopping for rather than filling in, because the
     * menu picks a battle's backdrop by this field and a wrong one shows the wrong war behind
     * a lit row.
     */
    const battleOf = shot.map !== undefined && shot.scenario !== undefined
      ? { map: shot.map, scenario: shot.scenario }
      : fromTable.get(p.key);
    if (!battleOf) {
      throw new Error(`${p.key}: neither its report nor tools/shoot.mjs says which battle it `
        + 'is of, and the menu groups its rotation by that.');
    }

    const analysis = await typeReadability(src);
    /*
     * The one frame-level refusal in this file.
     *
     * `MenuBackdrop` derives its scrim from `panelP95` as `1 - 0.385 / panelP95`, capped at
     * 0.55. A frame brighter than about 0.86 in the region the sheet covers asks for more than
     * the cap, which means gold type on it is below 4.5:1 however much scrim it is given — and
     * a backdrop scrimmed that hard is darker than the plain gradient it replaced, so the
     * frame is costing bytes to make the screen worse. Say so loudly; there are twenty-two
     * others.
     */
    if (analysis.type.panelP95 > 0.86) {
      console.warn(`  !! ${p.key}: panelP95 ${analysis.type.panelP95} needs more scrim than the `
        + 'ceiling MenuBackdrop applies, so gold type on it will not clear 4.5:1. Use a '
        + 'different frame.');
    }
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
        /*
         * Both read off the report, not guessed from the key or the camera.
         *
         * `map` was `p.key.includes('carth') ? ... : ...`, which works only while every key is
         * named after its battlefield, and `scenario` was `shot.wallDebug ? 'assault' : 'field'`,
         * which asks whether the CAMERA was pointed at a wall rather than whether the BATTLE
         * was an assault. The second one was actually wrong: `press-rome-parapet` is
         * `follow: 'contact'` inside a storm of the Aurelian Wall, has no `wall` block, and was
         * filed as a field battle — which put a picture of an assault into the menu's rotation
         * for the field battle, on a screen whose entire claim is that the picture agrees with
         * the row that is lit. `tools/shoot.mjs` now records both.
         */
        map: battleOf.map,
        era: battleOf.map === 'carthage' ? '146 BC' : battleOf.map === 'pydna' ? '168 BC' : '271 AD',
        scenario: battleOf.scenario,
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
      // The AVIF ladder goes on a `<source>`; the lone WebP goes on the `<img>` inside it, so
      // it is a `src` rather than a member of the srcset and is deliberately not listed here.
      srcset: renditions.filter((r) => r.format === 'avif')
        .map((r) => `${r.url} ${r.w}w`).join(', '),
      fallback,
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
        'This said the menu sheet was 94 to 97 % opaque, so what is behind it barely matters. '
        + 'It is no longer true: `src/ui/MenuBackdrop.ts` thinned the sheet to about 84 % so '
        + 'the picture behind it would be worth having, and re-derived what that is worth in '
        + 'scrim — a flat 0.30 subtracted from the numbers below, with the arithmetic in '
        + '`scrimUnderSheet`. `scrimForGold` here is still the harder case: type laid DIRECTLY '
        + 'on the frame with no sheet at all.',
      quietestFrames: (() => {
        const q = [...frames].sort((a, b) => a.type.scrimForGold - b.type.scrimForGold);
        const worst = q.at(-1);
        const best = q.slice(0, 3);
        return 'Measured on every frame at the box the sheet actually covers, not guessed and '
          + 'not measured at the middle of the frame: '
          + best.map((f) => `${f.id} (${f.type.goldOnFrame}:1, scrim ${f.type.scrimForGold})`).join(', ')
          + ` are the quietest, and ${worst.id} is the worst at ${worst.type.scrimForGold}. `
          + 'The frame that LOOKS calm is reliably not the quiet one — haze lifts midtones and '
          + 'the genuinely quiet frames are the dark ones.';
      })(),
      firstPaintBytes: (() => {
        const h = frames[0].renditions.filter((r) => r.format === 'avif');
        return `The hero in AVIF: ${h.map((r) => `${r.w}w ${(r.bytes / 1024).toFixed(1)} kB`).join(', ')}`
          + `, plus a ${frames[0].fallback.w}w WebP at ${(frames[0].fallback.bytes / 1024).toFixed(1)} kB `
          + 'for a browser with no AVIF. Nothing in this directory is on the cold load; '
          + 'index.html references none of it and MenuBackdrop fetches none until arm().';
      })(),
      ifYouRotate:
        'It rotates now, and the rules it settled on are worth keeping if it is ever rewritten. '
        + '(1) Pick before the plate is assigned, once per screen, and memoise — a chooser that '
        + 'rolls on every refresh() changes the picture under a player who moved the mouse. '
        + '(2) The front door may draw from the whole set; a screen that NAMES a battle must '
        + 'draw only from that battle`s frames, or the picture disagrees with the row that is '
        + 'lit. (3) Prefetch through the same memo the shower uses, or every hover pays twice. '
        + '(4) Fetch the next plate only once someone has lingered, not on mount. (5) Honour '
        + 'prefers-reduced-motion by not moving, which also costs nothing.',
      dontUseTheseFor:
        'The in-battle settings panel. That one sits over a live game and a screenshot behind '
        + 'it would be a picture of a different battle than the one being played.',
      frontDoorAsItStands:
        'Judged from tools/shoot.mjs --shots=menu-door at 1440x900, not from the source. What '
        + 'is good is genuinely good and should not be touched: the wordmark tracking, the '
        + 'serif, the single oxblood primary against three recessive plaques, and the plaque '
        + 'copy, which describes each destination by what is inside it rather than by its '
        + 'name. Four things were weak when this was written. (1) The background was an empty '
        + 'near-black field with a faint radial — this is a 3D game whose front door showed no '
        + '3D, and it is the whole reason this set exists. DONE: `src/ui/MenuBackdrop.ts` puts '
        + 'these frames behind both sheets with a camera on them. (2) The mark beside the title '
        + 'is an eight-pointed starburst '
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
      renditions: 'Every frame has the same AVIF ladder — ' + PLATE_WIDTHS.join(', ') + ' — plus exactly one WebP at ' + FALLBACK_WIDTH + ' for a browser with no AVIF. There is no longer a hero-only width: MenuBackdrop draws the front door at random from the whole set, so any frame can be the one a stranger sees full-bleed. The ladder stops at ' + PLATE_WIDTHS.at(-1) + ' because it was measured to: on the densest frame, 1920 buys 12.5 points of detail over 1440 and 2560 buys 7.6 more, but 3200 buys 2.8 for 52 % more bytes. Put the AVIF srcset on a <source> and the WebP on the <img> inside it; do not mix them in one srcset.',
    },
    provenance: {
      commit: meta.commit,
      srcTree: meta.srcTree,
      capturedAt: `${meta.width}x${meta.height}`,
      storedAt: `${frames[0].source.width}x${frames[0].source.height}`,
      whyTwoSizes:
        'The renderer runs at one sample per pixel, so the frames are CAPTURED at 5120x2880 '
        + 'and immediately downsampled to the ladder top rung of 2560 before anything else '
        + 'looks at them. Every shipped rendition is therefore supersampled 2x2 or better, '
        + 'which is what resolves the aliasing on mail, shields and grass rather than encoding '
        + 'it. `storedAt` is what `screenshots/press/*.png` holds and what `source` on each '
        + 'frame below reports; `capturedAt` is what the GPU drew. Keeping the 5120 files was '
        + 'measured at 1.35 GB of scratch nothing reads twice, and it filled this machine.',
      quality: meta.quality,
      dpr: meta.dpr,
      hud: meta.hud,
      gl: meta.gl,
      reports,
      tool: 'node tools/shoot-press.mjs',
    },
    widths: PLATE_WIDTHS,
    // No `heroExtraWidths` any more, and its absence is the point: the menu draws its front
    // door at random from the whole set, so every frame carries the same ladder.
    fallbackWidth: FALLBACK_WIDTH,
    formats: { ladder: 'avif', fallback: 'webp' },
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
    map: ${JSON.stringify(f.battle.map)},
    scenario: ${JSON.stringify(f.battle.scenario)},
    alt: ${JSON.stringify(f.alt)},
    srcset: ${JSON.stringify(f.srcset)},
    src: ${JSON.stringify(f.fallback.url)},
    width: ${f.fallback.w},
    height: ${f.fallback.h},
    scrimForGold: ${f.type.scrimForGold},
    panelP95: ${f.type.panelP95},
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
 *   1. **The backdrop behind the menu**, \`src/ui/MenuBackdrop.ts\`. It draws the front door's
 *      frame at random from this whole list, and each deeper screen's from the frames of the
 *      battle that screen names — which is why \`map\` and \`scenario\` are on every entry, and
 *      why no frame has a wider ladder than any other any more.
 *   2. **The fallback** for anything that cannot afford a live scene — a weak GPU, a small
 *      viewport, a device already told it is too narrow to play on.
 *   3. **The link preview**, which is \`/og/total-claude.jpg\`, cropped from \`HERO\`.
 *
 * **\`srcset\` and \`src\` are two formats, not two sizes.** \`srcset\` is the AVIF ladder and
 * belongs on a \`<source type="image/avif">\`; \`src\` is the single WebP and belongs on the
 * \`<img>\` inside the same \`<picture>\`, for a browser that cannot decode AVIF. Merging them
 * into one \`srcset\` would offer a browser a choice between two formats on one element, which
 * \`srcset\` has no way to express — some visitors would then be handed the fallback at a rung
 * it was never encoded for.
 *
 * \`scrimForGold\` is the smallest black scrim alpha at which \`--gold\` (#d9b25f) type clears
 * 4.5:1 against the brightest part of the region the menu sheet actually covers — which is not
 * the middle of the frame, because the backdrop scales the frame past the viewport and slides
 * a chosen point of it under the sheet. See \`PANEL_BOX\` in \`tools/make-brand.mjs\`. 0 means
 * none is needed. It is measured on every frame rather than eyeballed on one.
 */

export interface PressPlate {
  /** The \`press-*\` shot in \`tools/shoot.mjs\` that produced it. */
  id: string;
  hero: boolean;
  /** Which battlefield this is a picture of. The menu rotates within one battle at a time. */
  map: string;
  /** \`field\` or \`assault\`, recorded by the shoot rather than inferred from the camera. */
  scenario: string;
  /** For a screen reader, and for \`og:image:alt\` on the hero. */
  alt: string;
  /** The AVIF ladder, for a \`<source srcset>\`. Widths: ${PLATE_WIDTHS.join(', ')}. */
  srcset: string;
  /** The one WebP rendition, for the \`<img>\` a browser without AVIF falls back to. */
  src: string;
  width: number;
  height: number;
  /** Smallest black scrim alpha at which gold type clears 4.5:1 laid DIRECTLY on this frame. */
  scrimForGold: number;
  /**
   * The 95th-percentile relative luminance inside the region the menu sheet covers.
   *
   * This, not \`scrimForGold\`, is what \`MenuBackdrop\` scrims from: the type it protects is
   * laid on an 84 %-opaque sheet rather than on the frame, so the sheet's own transmission
   * belongs in the arithmetic. The 95th percentile and not the mean, because type is
   * unreadable over its brightest patch, not over its average one.
   */
  panelP95: number;
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
    /*
     * The row that used to be here said "first paint, hero only", and it stopped being true
     * twice over: the front door is drawn at random so the hero is no longer the frame anyone
     * sees first, and it indexed `renditions[0..2]` positionally, which now walks off the end
     * of a four-rung ladder and into the WebP fallback. What a visitor actually pays is one
     * rendition of one frame, so the honest summary is the range across the whole set.
     */
    const at = (w) => frames.map((f) => f.renditions.find((r) => r.w === w && r.format === 'avif'))
      .filter(Boolean).map((r) => r.bytes);
    const span = (w) => {
      const b = at(w);
      return b.length ? `${w}w ${kb(Math.min(...b))}–${kb(Math.max(...b))}` : `${w}w none`;
    };
    console.log(`\n  one plate, which is what a visitor pays: ${PLATE_WIDTHS.map(span).join(', ')}`);
    const total = frames.flatMap((f) => f.renditions).reduce((a, r) => a + r.bytes, 0);
    console.log(`  whole set, every rendition: ${kb(total)} across ${frames.length} frames `
      + `(${kb(total / frames.length)} each), of which the ${PLATE_WIDTHS.at(-1)} rung is `
      + `${kb(at(PLATE_WIDTHS.at(-1)).reduce((a, b) => a + b, 0))} — the first thing to cut.`);
  }

  console.log('\nNow: node tools/qa-brand.mjs');
  if (!existsSync(FRAMES)) console.log(`(no frames at ${FRAMES})`);
  else console.log(`frames from ${path.relative(ROOT, FRAMES)}: ${(await readdir(FRAMES)).filter((f) => f.endsWith('.png')).length} png`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
