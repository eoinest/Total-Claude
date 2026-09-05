#!/usr/bin/env node
/**
 * The press pass, shot high and stored small.
 *
 *     node tools/shoot-press.mjs
 *     node tools/shoot-press.mjs --groups=rome-assault,carth-field   # a subset
 *     node tools/shoot-press.mjs --capture=5120 --store=2560         # the defaults
 *
 * ---------------------------------------------------------------------------
 * Why this exists rather than one `node tools/shoot.mjs --set=press`
 * ---------------------------------------------------------------------------
 *
 * `tools/make-brand.mjs` tops its rendition ladder out at 2560 px, and `withoutEnlargement`
 * means a rendition can never be wider than the frame it is cut from — so the press pass has
 * to render at least 2560. It should render at **twice** that, because the shoot harness runs
 * at `dpr: 1` (one sample per pixel, which is what every graded plate this project has ever
 * produced was rendered at) and mail, painted shields and grass are the worst possible content
 * for that. A 5120 capture downsampled to 2560 is 2x2 supersampling done in `sharp` instead of
 * in the renderer, and it costs a quarter of what `--dpr=2` costs to render.
 *
 * The problem is the intermediate. Forty-five frames of 5120x2880 PNG is **1.35 GB**, and this
 * machine has been run at 100 % of a 926 GB disk with under two gigabytes free — a single
 * `--set=press` at 5120 filled it, killed its own shoot at frame two, and took `sharp`, the
 * editor and every other agent's write with it. That is not a machine-specific accident worth
 * ignoring: a shoot that needs a gigabyte of scratch it never looks at again is badly built.
 *
 * So this runs the pass **one scene group at a time** and downsamples each frame to the
 * ladder's top rung the moment its group is written, deleting the 5120 behind it. `--batch=N`
 * splits a group further when even one group's worth is too much — the pass that wrote this
 * ran at `--batch=3`, which is 90 MB of intermediate held at once instead of 270. Nothing is
 * lost: 2560 is the widest rendition anything downstream asks for, and every pixel of it has
 * already been supersampled 2x2 from the 5120.
 *
 * The cost of `--batch` is engine boots, because a batch is a separate `shoot.mjs` invocation.
 * On Campus Martius a boot is three and a half seconds and it is free; on a Punic world it is
 * minutes, so batch Carthage only when the disk actually says so.
 *
 * `tools/shoot.mjs` merges `report.json` by shot name across runs into the same `--out`, and
 * refuses to merge across a change of `srcTree`, size, quality, `dpr` or `hud` — so running it
 * ten times here produces the same single record one run would have, and would say so loudly
 * if the tree moved underneath the pass.
 *
 * ---------------------------------------------------------------------------
 * The groups are the page loads
 * ---------------------------------------------------------------------------
 *
 * `groupKey` in `tools/shoot.mjs` is `[map, hour, scenario, quality, opponent, weather, seed]`,
 * and a shot that differs in any of them is a fresh engine boot — three and a half seconds on
 * Campus Martius and minutes on a Punic world. The lists below are that grouping written out,
 * so that this script's batches are exactly the harness's own page loads and batching costs
 * nothing at all. **If a `press-` shot is added to `tools/shoot.mjs` and not to a list here it
 * will not be shot**, which `--check` exists to catch.
 */
import { spawn } from 'node:child_process';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const CAPTURE = Number(args.get('capture') ?? 5120);
const STORE = Number(args.get('store') ?? 2560);
const OUT = args.get('out') ?? 'screenshots/press';

/** One entry per page load. The key is only a label; the array is what is shot. */
const GROUPS = {
  // Campus Martius, the assault on the Aurelian Wall, morning. The curtain faces north, so
  // this is the only end of the day at which a camera looking at it is not looking at the sun.
  'rome-assault': [
    'press-rome-wall', 'press-rome-ram', 'press-rome-ladder', 'press-rome-parapet',
    'press-rome-gate', 'press-rome-escalade', 'press-rome-walk', 'press-rome-tower',
    'press-rome-glacis',
  ],
  // The same wall two hours later, for the one camera that stands on it and looks inward.
  'rome-parapet': ['press-rome-embrasure', 'press-rome-embrasure-wide'],
  'rome-field-morning': [
    'press-rome-line', 'press-rome-city', 'press-rome-skyline', 'press-rome-host',
    'press-rome-helmets', 'press-rome-march', 'press-rome-dawn',
  ],
  'rome-field-late': [
    'press-rome-advance', 'press-rome-horse', 'press-rome-press', 'press-rome-aftermath',
    'press-rome-cavalry', 'press-rome-melee',
  ],
  'rome-field-overcast': ['press-rome-grey', 'press-rome-mist', 'press-rome-hordegrey'],
  // Carthage's curtain is a west face and takes no sun before about 15:00.
  'carth-assault': ['press-carth-wall', 'press-carth-storm', 'press-carth-postern'],
  'carth-assault-rain': ['press-carth-rain', 'press-carth-rainwall'],
  'carth-field': [
    'press-carth-elephants', 'press-carth-tusks', 'press-carth-spears', 'press-carth-line',
    'press-carth-wide',
  ],
  'pydna-morning': [
    'press-pydna-line', 'press-pydna-clash', 'press-pydna-march', 'press-pydna-horizon',
  ],
  'pydna-overcast': ['press-pydna-dusk', 'press-pydna-grey'],
};

/** Every `press-` key `tools/shoot.mjs` defines, so a shot cannot be added and then forgotten. */
const declared = await (async () => {
  const src = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'tools/shoot.mjs'), 'utf8');
  const block = src.match(/const PRESS_SHOTS = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('could not find PRESS_SHOTS in tools/shoot.mjs');
  return [...block[1].matchAll(/^ {2}'(press-[a-z0-9-]+)':/gm)].map((m) => m[1]);
})();

/**
 * Defined in `tools/shoot.mjs` and deliberately not shot, with the reason.
 *
 * A shot in this list is one whose camera has already been looked at and rejected, so shooting
 * it again costs a 30 MB intermediate and a slot in the contact sheet to learn nothing. It is
 * kept in `tools/shoot.mjs` rather than deleted, for the reason `tools/make-brand.mjs` gives
 * about failed cameras: they are cheaper to fix than to reinvent, and six of the eight this
 * set cut last time were repaired rather than replaced.
 *
 * **This list is not a way to hide a frame you have not looked at.** Every entry names the
 * frame that was looked at instead.
 */
const SKIP = {
  'press-carth-ditch': 'A ditch seen from its own bank is invisible, which is what a ditch is '
    + 'for. Cut once already on the same camera; nothing about it has changed.',
  'press-carth-walk': 'The Punic twin of `press-rome-walk`, which was shot and came back as '
    + 'one legionary\'s shoulder at 0.59 m. The whole `eyeline-` family photographs a surface '
    + 'rather than a battle — four were tried at press scale and four failed.',
  'press-rome-walk': 'Shot, looked at, cut: nearest man 0.59 m.',
  'press-rome-tower': 'Shot, looked at, cut: a flat slab of brick and a strip of paving.',
  'press-rome-glacis': 'Shot, looked at, cut: measured 10.1 degrees off the sun, because the '
    + 'yawAdd it inherited was tuned to swing away from an afternoon sun and swings into a '
    + 'morning one.',
  'press-rome-escalade': 'Shot, looked at, cut: a wall corner and empty grass, at a standoff '
    + 'its own family calls diagnostic.',
  'press-rome-embrasure': 'Shot, looked at, cut: brick and paving, no men.',
  'press-rome-embrasure-wide': 'Shot, looked at, cut: a siege tower across the top-left corner.',
  'press-carth-spears': 'Shot, looked at, cut: a 5 m camera on a named unit that was not there.',
  'press-carth-postern': 'Shot, looked at, cut: a flat wall face, one small door and a strip of '
    + 'grass. `carth-postern-wide` is a masonry inspection frame and does exactly what it was '
    + 'built to do; a menu backdrop is not what it was built for. Same lesson as the four '
    + '`eyeline-` frames.',
  'press-carth-wide': 'Shot, looked at, cut twice — a picture of ground is a picture of ground '
    + 'at any framing.',
  'press-rome-advance': 'Shot, looked at, cut twice, for the same reason as `press-carth-wide`.',
  'press-rome-horse': 'Shot, looked at, cut: nearest man 0.77 m, and the riders it was framed '
    + 'on are not in it.',
  'press-rome-skyline': 'Shot, looked at, cut: washed out through 800 m of haze, and the same '
    + 'subject as `press-rome-city` from further away.',
  'press-rome-gate': 'Shot, looked at, cut: the arch reads, but a flat untextured slab of '
    + 'siege ramp sits across the bottom-right corner and there is no battle in the frame.',
  'press-pydna-horizon': 'Shot, looked at, cut: `deck-pydna-horizon` puts a horizon in shot at '
    + '16:00, which is the hour it was tuned at. At 08:12 the same camera is dry grass and '
    + 'haze with a smudge of men on it — an hour and a camera are one decision, the same '
    + 'lesson as `press-rome-glacis`.',
  'press-rome-dawn': 'Not shot. `ownLine` at any zoom that fits both hosts is too far back to '
    + 'see either — measured twice on `press-rome-advance` and once on `press-carth-wide`.',
  'press-pydna-march': 'Not shot: the same subject as `press-pydna-line` sixteen seconds later.',
};

/** The page loads with the skipped shots taken out of them. This is what actually runs. */
const PLAN = Object.fromEntries(Object.entries(GROUPS)
  .map(([g, keys]) => [g, keys.filter((k) => !(k in SKIP))])
  .filter(([, keys]) => keys.length > 0));

const listed = [...Object.values(GROUPS).flat(), ...Object.keys(SKIP)];
const missing = declared.filter((k) => !listed.includes(k));
const phantom = listed.filter((k) => !declared.includes(k));
if (missing.length || phantom.length) {
  if (missing.length) console.error(`\nnot in any group here, so never shot:\n  ${missing.join('\n  ')}`);
  if (phantom.length) console.error(`\ngrouped here but not defined in shoot.mjs:\n  ${phantom.join('\n  ')}`);
  process.exit(2);
}
if (args.has('check')) {
  console.log(`\n  ${declared.length} press shot(s) declared: `
    + `${Object.values(PLAN).flat().length} shot across ${Object.keys(PLAN).length} page `
    + `load(s), ${Object.keys(SKIP).length} skipped with a reason each\n`);
  for (const [k, why] of Object.entries(SKIP)) console.log(`  skip ${k.padEnd(26)} ${why}`);
  console.log('');
  process.exit(0);
}

const want = args.has('groups') ? args.get('groups').split(',') : Object.keys(PLAN);
for (const g of want) {
  if (!GROUPS[g]) { console.error(`no such group: ${g}`); process.exit(2); }
  if (!PLAN[g]) { console.error(`every shot in ${g} is in SKIP`); process.exit(2); }
}

const run = (cmd, argv) => new Promise((resolve, reject) => {
  const c = spawn(cmd, argv, { cwd: ROOT, stdio: 'inherit', env: process.env });
  c.on('error', reject);
  c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

/**
 * Down to the ladder's top rung, in place.
 *
 * Written to a sibling and renamed over the original rather than resized in place, because
 * `sharp` reading and writing the same path is how a half-written PNG happens, and a
 * half-written PNG here would be a frame nobody notices is broken until `make-brand` reads it.
 *
 * The test is the file's **own width**, not a list of names seen earlier. The first draft kept
 * a `before` set and skipped anything in it, which is wrong the moment a group is re-shot into
 * a directory that already holds it: the frame is overwritten at the capture size, its name is
 * already in the set, and a 5120 px file survives the pass that exists to remove it.
 */
const shrink = async (dir) => {
  let saved = 0;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.png'))) {
    const full = path.join(dir, f);
    if ((await sharp(full).metadata()).width <= STORE) continue;
    const tmp = `${full}.shrink`;
    await sharp(full).resize(STORE, null, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 }).toFile(tmp);
    // `stat`, not `sharp().metadata().size` — that field is undefined for a file input in
    // this version of sharp, so the first draft of this line reported "0 MB reclaimed" after
    // correctly reclaiming a hundred and fifty of them.
    const wasBytes = (await stat(full)).size;
    await rename(tmp, full);
    saved += wasBytes - (await stat(full)).size;
  }
  return saved;
};

/**
 * `--batch=N`: shrink every N frames rather than every group.
 *
 * Peak scratch is one batch of capture-sized PNGs, and at 5120x2880 each of those is about
 * 30 MB. A nine-frame group is therefore 270 MB of intermediate held at once, which is fine on
 * a machine with room and is not fine on this one — the pass that wrote this file ran with
 * under 600 MB free and other agents writing to the same disk.
 *
 * The cost is engine boots: a batch is a separate `shoot.mjs` invocation, so splitting a group
 * of seven into three batches boots that world three times. On Campus Martius a boot is three
 * and a half seconds and this is free; on a Punic world it is minutes, which is why the default
 * is one batch per group and the split is a flag you reach for when the disk says so.
 */
const BATCH = Number(args.get('batch') ?? 0);
const chunk = (xs) => {
  if (!BATCH || BATCH >= xs.length) return [xs];
  const out = [];
  for (let i = 0; i < xs.length; i += BATCH) out.push(xs.slice(i, i + BATCH));
  return out;
};

const dir = path.join(ROOT, OUT);
let freed = 0;
for (const [i, g] of want.entries()) {
  const batches = chunk(PLAN[g]);
  console.log(`\n=== ${i + 1}/${want.length}  ${g} — ${PLAN[g].length} frame(s)`
    + `${batches.length > 1 ? ` in ${batches.length} batches` : ''} ===\n`);
  for (const b of batches) {
    await run(process.execPath, [
      'tools/shoot.mjs', `--shots=${b.join(',')}`,
      `--w=${CAPTURE}`, `--h=${Math.round((CAPTURE * 9) / 16)}`, `--out=${OUT}`,
    ]);
    freed += await shrink(dir);
  }
  console.log(`  stored at ${STORE} px wide; ${(freed / 1024 / 1024).toFixed(0)} MB of `
    + `${CAPTURE} px intermediate reclaimed so far`);
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.png'));
console.log(`\n  ${files.length} frame(s) in ${OUT}, captured at ${CAPTURE} and stored at ${STORE}.`);
console.log('  Now: node tools/make-brand.mjs\n');
await rm(path.join(dir, '.metadata_never_index'), { force: true });
