/**
 * Throwaway: the sharpness claim, at 1:1 device pixels, where it can be looked at.
 *
 * Every other number in this pass is a ratio. This is the only artefact that shows the thing
 * the owner actually asked about, and the only honest way to show it is to reproduce what the
 * browser does: take the rendition the `srcset` picker would choose, scale it up to the number
 * of device pixels the backdrop is painted across on the machine in question, and crop a piece
 * of that at one image pixel per device pixel. Anything shown smaller than 1:1 is a picture of
 * a downscale, which is the one operation that hides the defect being argued about.
 *
 * ---------------------------------------------------------------------------
 * Why this does NOT put the shipped file beside the new one
 * ---------------------------------------------------------------------------
 *
 * That was the first draft and it was worthless. The shipped `press-rome-line-1440.webp` and
 * the new `press-rome-line-2560.avif` are two different renders — the camera is `follow`-framed
 * and resolves to whatever the battle is doing at the second the harness reaches, which is not
 * the same second — so the same fractional crop of each lands on different subject matter. One
 * panel was a banner and a rank of legionaries and the other was grass. A reader would have
 * been comparing two pictures and told they were comparing two encodings.
 *
 * So both panels are cut from the **same** new source and differ only in the pipeline:
 *
 *   BEFORE   source -> 1920 (the old capture size, so the old supersampling too) -> 1440 WebP
 *            at q76 -> upscaled to the painted width. That is the whole of the old policy.
 *   AFTER    source -> 2560 AVIF at the shipped quality -> upscaled to the painted width.
 *   CEILING  the source itself at the painted width, which is what the display could show if
 *            the frame had every pixel it is painted across.
 *
 * Anything that differs between the first two panels is caused by this change and by nothing
 * else, which is the only claim worth making at 1:1.
 *
 *   node tools/scratch/plate-crops.mjs --keys=press-rome-line,press-carth-elephants
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const KEYS = (args.get('keys') ?? args.get('key') ?? 'press-rome-line').split(',');
/** The 16-inch MacBook Pro front door, from tools/scratch/menu-density.mjs. */
const PAINTED = Number(args.get('painted') ?? 4851);
const SRC = path.join(ROOT, args.get('src') ?? 'screenshots/press');
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/press');
/** The crop, in device pixels. Wide enough to hold a rank of men, tall enough to see faces. */
const CW = Number(args.get('cw') ?? 780);
const CH = Number(args.get('ch') ?? 520);
/** Where to cut it from, as a fraction of the frame. Off-centre: the sheet covers the middle. */
const FX = Number(args.get('fx') ?? 0.30);
const FY = Number(args.get('fy') ?? 0.58);

/** The old policy, reproduced exactly: a 1920 capture, then a 1440 WebP at q76. */
const OLD_CAPTURE = 1920;
const OLD_WIDTH = 1440;
const OLD_QUALITY = 76;
/** The new one, which must match `PLATE_WIDTHS` and `AVIF_QUALITY` in tools/make-brand.mjs. */
const NEW_WIDTH = Number(args.get('new-width') ?? 2560);
const NEW_QUALITY = Number(args.get('new-quality') ?? 50);

const GOLD = '#d9b25f';
const label = (text, sub, w) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="56">
     <rect width="${w}" height="56" fill="#0b0907"/>
     <text x="16" y="24" font-family="Georgia,serif" font-size="18" fill="${GOLD}">${text}</text>
     <text x="16" y="45" font-family="Georgia,serif" font-size="13" fill="#9a8d7a">${sub}</text>
   </svg>`);

/** Up to the painted width the way a browser would, then one image pixel per device pixel. */
const crop = async (buf) => {
  const up = await sharp(buf).resize(PAINTED, null, { kernel: 'lanczos3' }).png().toBuffer();
  const m = await sharp(up).metadata();
  const left = Math.max(0, Math.min(m.width - CW, Math.round(FX * m.width - CW / 2)));
  const top = Math.max(0, Math.min(m.height - CH, Math.round(FY * m.height - CH / 2)));
  return sharp(up).extract({ left, top, width: CW, height: CH }).png().toBuffer();
};

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;

await mkdir(OUT, { recursive: true });
for (const key of KEYS) {
  const source = path.join(SRC, `${key}.png`);
  if (!existsSync(source)) { console.log(`${key}: no source frame`); continue; }
  const meta = await sharp(source).metadata();

  // BEFORE: the old capture size first, so the old amount of supersampling is reproduced too.
  const oldCapture = await sharp(source)
    .resize(OLD_CAPTURE, null, { kernel: 'lanczos3' }).png().toBuffer();
  const before = await sharp(oldCapture)
    .resize(OLD_WIDTH, null, { kernel: 'lanczos3' })
    .webp({ quality: OLD_QUALITY, effort: 6 }).toBuffer();
  // AFTER: the shipped rendition itself if it is on disk, else encoded the same way.
  const shipped = path.join(ROOT, 'public/press', `${key}-${NEW_WIDTH}.avif`);
  const after = existsSync(shipped)
    ? await sharp(shipped).toBuffer()
    : await sharp(source).resize(NEW_WIDTH, null, { kernel: 'lanczos3' })
      .avif({ quality: NEW_QUALITY, effort: 5 }).toBuffer();

  const panels = [
    {
      buf: await crop(before),
      title: `BEFORE — the old policy: ${OLD_CAPTURE} capture, ${OLD_WIDTH} WebP q${OLD_QUALITY}`,
      sub: `${kb(before.length)}, upscaled ${(PAINTED / OLD_WIDTH).toFixed(2)}x to ${PAINTED} device px`,
    },
    {
      buf: await crop(after),
      title: `AFTER — ${meta.width} capture, ${NEW_WIDTH} AVIF q${NEW_QUALITY}`,
      sub: `${kb(after.length)}, upscaled ${(PAINTED / NEW_WIDTH).toFixed(2)}x to ${PAINTED} device px`,
    },
    {
      buf: await crop(await sharp(source).png().toBuffer()),
      title: 'the ceiling — the source, unencoded',
      sub: `${kb((await stat(source)).size)}, what the display could show if the frame had `
        + 'every pixel it is painted across',
    },
  ];

  const cellH = CH + 56;
  const canvas = sharp({
    create: { width: CW * panels.length, height: cellH, channels: 3, background: '#0b0907' },
  });
  const composites = panels.flatMap((p, i) => [
    { input: label(p.title, p.sub, CW), left: i * CW, top: 0 },
    { input: p.buf, left: i * CW, top: 56 },
  ]);
  const out = path.join(OUT, `crop-${key}.png`);
  await writeFile(out, await canvas.composite(composites).png().toBuffer());
  console.log(`  ${path.relative(ROOT, out)}  ${CW}x${CH} device px per panel, `
    + `cut at (${FX}, ${FY}) of the frame`);
}
