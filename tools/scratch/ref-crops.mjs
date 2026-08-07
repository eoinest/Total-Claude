#!/usr/bin/env node
// Cut single-soldier close-up crops out of the ten Total War: Rome II press
// plates for the soldier-fidelity comparison deck.
//
//   node tools/scratch/ref-crops.mjs            -> write final 900x1200 PNGs + index.json
//   node tools/scratch/ref-crops.mjs --preview  -> write unresized previews to .preview/
//
// Hard rule: no crop may contain a single pixel inside the wordmark exclusion
// zone (x > 1400, y > 820) in the SOURCE plate. The script throws if one does.
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome2';
const ROOT = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/soldier-fidelity';
const OUT = join(ROOT, 'reference-crops');
const PREVIEW = join(ROOT, 'tools/scratch/.preview');

const EXCL_X = 1400; // any pixel with x > EXCL_X ...
const EXCL_Y = 820; // ... AND y > EXCL_Y is wordmark territory

const OUT_W = 900;
const OUT_H = 1200;

/**
 * headToToe is the APPROXIMATE head-crown-to-heel span of the subject measured
 * in SOURCE pixels. Where the legs leave the frame or are occluded the value is
 * extrapolated from the measured head-to-hip span and flagged in `measure`.
 * @type {{id:string,plate:string,box:[number,number,number,number],desc:string,
 *         headToToe:number,measure:string,features:string[]}[]}
 */
const CROPS = [
  // ---------------------------------------------------------------- r2-00
  {
    id: 'r2crop-00-1',
    plate: 'r2-00.jpg',
    box: [20, 285, 570, 760],
    desc: 'Hellenistic/Successor heavy infantryman seen from directly behind: the whole back panel of a large-lamella scale corselet with a separate scale shoulder cape, under a smooth conical helmet with a black plume',
    headToToe: 1070,
    measure: 'head-to-hip measured ~555 px (crown y~375 to belt y~930); legs run out of the bottom of the plate, toe height extrapolated',
    features: [
      'scale armour - large lamellae, body panel + separate shoulder cape',
      'conical/bowl helmet, rear view, black plume',
      'tooled leather waist belt with repeating stamp',
      'green wool sleeve with embroidered cuff',
    ],
  },
  {
    id: 'r2crop-00-2',
    plate: 'r2-00.jpg',
    box: [1230, 108, 345, 460],
    desc: 'Officer/champion in a gilt bronze helmet with cast volute (ram-horn) bosses over the ears, full bearded face in three-quarter, teardrop-scale cuirass with leather shoulder straps',
    headToToe: 1000,
    measure: 'head-to-hip measured ~520 px (crown y~135 to belt y~655); lower body lost in grass and bodies, toe height extrapolated',
    features: [
      'ornate gilt bronze helmet with volute/horn bosses and a browband',
      'bearded face, three-quarter, eyes visible',
      'scale cuirass - teardrop scales, ~14 px per scale',
      'leather shoulder straps and belt',
    ],
  },
  // ---------------------------------------------------------------- r2-01
  {
    id: 'r2crop-01-1',
    plate: 'r2-01.jpg',
    box: [398, 130, 480, 640],
    desc: 'Successor officer three-quarter rear: white linen cuirass with maroon key-pattern trim and a folded shoulder yoke, layered pteruges, a wound cloth head wrap instead of a helmet, madder-purple wool sleeves',
    headToToe: 845,
    measure: 'measured crown of the head wrap y~165 to sandal y~1010',
    features: [
      'linothorax / white linen cuirass, maroon meander trim',
      'pteruges (two layers, scalloped)',
      'wound cloth head wrap, no helmet',
      'madder-purple wool sleeves',
    ],
  },
  {
    id: 'r2crop-01-2',
    plate: 'r2-01.jpg',
    box: [755, 195, 400, 533],
    desc: 'Eastern infantryman in a gilt bronze bowl helmet with a raised medial ridge, face three-quarter and lit, fine small-scale corselet over a sage tunic, oval shield with a cast bronze boss beside him',
    headToToe: 640,
    measure: 'head-to-hip measured ~335 px (crown y~225 to waist y~560); legs behind the shield, toe height extrapolated',
    features: [
      'fine scale armour - small scales, ~7 px each',
      'gilt bronze helmet, medial ridge, three-quarter',
      'bearded face with stubble',
      'oval shield with a cast bronze boss and iron rim strip',
    ],
  },
  {
    id: 'r2crop-01-3',
    plate: 'r2-01.jpg',
    box: [30, 45, 435, 580],
    desc: 'Round shield filling the frame, seen from the INSIDE as the bearer punches it forward - leather-faced back board with radial plank seams, a cast bronze grip (antilabe) and arm-strap fitting, leather bracing straps and four decorative bronze rivet washers where the outer bosses pass through; his madder-purple sleeve runs through the grip, green wool cloak behind',
    headToToe: 850,
    measure: 'subject is almost entirely behind his own shield; shield long axis measured ~370 px, bearer height estimated from scene depth',
    features: [
      'round shield INNER face - leather over planks, radial seams, worn edge',
      'cast bronze grip + arm-strap fittings, leather bracing straps',
      'bronze rivet washers with fluted heads',
      'green wool cloak, madder-purple wool sleeve',
    ],
  },
  // ---------------------------------------------------------------- r2-02
  {
    id: 'r2crop-02-1',
    plate: 'r2-02.jpg',
    box: [940, 28, 460, 613],
    desc: 'Germanic/Gallic champion in a wolf-pelt hood with the skull and forelegs left on, bearded face in near profile, undyed wool tunic, studded leather belt, bare arm and thigh',
    headToToe: 920,
    measure: 'measured crown y~110 (under the pelt) to sandal y~1030',
    features: [
      'wolf pelt - skull, ears and forepaws modelled, fur shading',
      'face in near profile, stubble, brow and cheekbone detail',
      'undyed wool tunic, no armour',
      'studded leather belt with a cast disc',
    ],
  },
  {
    id: 'r2crop-02-2',
    plate: 'r2-02.jpg',
    box: [795, 295, 400, 533],
    desc: 'Roman legionary forced to his knees: hide/leather cuirass with a gilt bronze breast panel and a cast rosette phalera, madder-red tunic, plated military belt and a baldric. His bronze helmet and a decorated sword pommel crowd the top of the frame; his head and face are occluded by the attacker’s arm, so this crop is an ARMOUR reference, not a face one',
    headToToe: 710,
    measure: 'figure is kneeling; measured crown y~320 to heel y~1030, standing height would be larger',
    features: [
      'composite leather cuirass with a gilt bronze breast plate and a cast phalera',
      'bronze Montefortino helmet with a crest knob (upper frame, partly occluded)',
      'madder-red wool tunic',
      'plated military belt (cingulum) and a baldric with a scabbard',
    ],
  },
  {
    id: 'r2crop-02-3',
    plate: 'r2-02.jpg',
    box: [1520, 35, 395, 527],
    desc: 'Roman auxiliary in lorica hamata mid-shout, bronze helmet with a crest knob and black side feathers, a plain oval shield turned nearly face-on at the left of the frame, gladius across the body',
    headToToe: 740,
    measure: 'measured crown y~60 to sandal y~800',
    features: [
      'mail / lorica hamata - the single best mail sample in the set',
      'bronze helmet with a crest knob and black feather tubes',
      'oval shield outer face, plain limewash with a leather rim',
      'gladius blade with an edge bevel',
      'open shouting mouth, teeth and tongue modelled',
    ],
  },
  // ---------------------------------------------------------------- r2-04
  {
    id: 'r2crop-04-1',
    plate: 'r2-04.jpg',
    box: [1075, 675, 285, 380],
    desc: 'Pydna legionary from directly behind, the nearest man of a packed rank: mail shirt with a separate shoulder doubling ending in a shaped hem, bronze Montefortino catching the low sun, black feather tubes, red tunic sleeves',
    headToToe: 730,
    measure: 'head-to-hip measured ~380 px (crown y~700 to the bottom of the plate); legs out of frame, toe height extrapolated. Smallest source box in the set (285 px wide), so this crop is upscaled ~3.2x and is visibly the softest of the fourteen',
    features: [
      'mail / lorica hamata with a scalloped shoulder doubling',
      'bronze Montefortino helmet, hard specular hotspot, rear view',
      'black feather tubes at the temples',
      'red tunic sleeves, scutum edge at the frame edges',
    ],
  },
  // ---------------------------------------------------------------- r2-07
  {
    id: 'r2crop-07-1',
    plate: 'r2-07.jpg',
    box: [1145, 262, 400, 533],
    desc: 'Bearded warrior mid-parry: bronze wide-brim helmet with a hatched crown, full face lit hard from the left, madder cloak over a blue tunic, white leather pteruges, two cast bronze sword hilts in frame',
    headToToe: 725,
    measure: 'measured crown y~315 to sandal y~1040',
    features: [
      'bronze wide-brim helmet, hatched/chased crown - full profile of the brim',
      'FULL FACE - beard, open mouth, brow shadow, ear',
      'madder wool cloak with a woven edge',
      'white leather pteruges over a blue tunic',
      'two cast bronze sword hilts with relief decoration',
      'tattooed forearm',
    ],
  },
  {
    id: 'r2crop-07-2',
    plate: 'r2-07.jpg',
    box: [0, 415, 400, 533],
    desc: 'Hoplite behind a bronze-faced round shield seen almost square on - incised eight-ray star, domed central boss, dented and tarnished metal; his bronze helmet with a repousse wave crown and bearded face just clear the rim',
    headToToe: 560,
    measure: 'measured crown y~470 to the visible foot y~1000; shield diameter ~300 px',
    features: [
      'round shield OUTER FACE - bronze/leather, incised eight-ray star, domed boss',
      'bronze helmet with a repousse wave-scroll crown and a brim',
      'bearded face, three-quarter',
      'blue tunic, white horsehair crest behind',
    ],
  },
  {
    id: 'r2crop-07-3',
    plate: 'r2-07.jpg',
    box: [545, 370, 440, 587],
    desc: 'Greek officer three-quarter rear, bent into a blow: pitted iron helmet with a riveted brow band and a hinged cheek piece, dark-red horsehair crest, purple wool cloak, overlapping white leather shoulder lames',
    headToToe: 650,
    measure: 'figure is bent almost double; measured crown y~410 to sandal y~1050 along the pose, standing height would be larger',
    features: [
      'iron/steel helmet, rear three-quarter - rivets, brow band, hinged cheek piece',
      'dark-red horsehair crest',
      'purple wool cloak with heavy folds',
      'white leather shoulder lames / scales',
    ],
  },
  // ---------------------------------------------------------------- r2-09
  {
    id: 'r2crop-09-1',
    plate: 'r2-09.jpg',
    box: [45, 455, 390, 520],
    desc: 'Front-rank Greek phalangite: bronze helmet with hinged cheek pieces and a brow rim, full bearded face scowling, gilt bronze shoulder yoke and chest plates over a pale linen cuirass, shield rim at his elbow',
    headToToe: 600,
    measure: 'head-to-hip measured ~310 px (crown y~490 to waist y~800); crouched behind the sarissa hedge, toe height extrapolated',
    features: [
      'bronze helmet with hinged cheek pieces and a brow rim',
      'FULL FACE - beard, nose, brow, downturned mouth',
      'gilt bronze shoulder yoke and rectangular chest plates',
      'pale linen cuirass',
      'round shield rim with a bronze edge',
      'tattooed/scarred bare arm',
    ],
  },
  // ---------------------------------------------------------------- r2-11
  {
    id: 'r2crop-11-1',
    plate: 'r2-11.jpg',
    box: [240, 70, 480, 640],
    desc: 'Germanic champion: wolf-pelt hood with the whole skull and forepaws intact, a polished iron face mask with punched eye slits and a fanged mouth, diamond-quilted gambeson, cast bronze disc brooch, ring-pattern hose',
    headToToe: 900,
    measure: 'head-to-hip measured ~475 px (crown of the pelt y~85 to belt y~560); legs occluded by a fallen body, toe height extrapolated',
    features: [
      'wolf pelt - full skull with teeth, ears, forepaws, long fur',
      'polished iron face mask - punched eye slits, fanged mouth, cold specular',
      'diamond-quilted gambeson',
      'cast bronze disc brooch with a raised centre',
      'ring/mail-pattern hose',
      'leather belt with a cast buckle',
    ],
  },
];

function assertLegal(c, W, H) {
  const [x, y, w, h] = c.box;
  if (x < 0 || y < 0 || x + w > W || y + h > H) {
    throw new Error(`${c.id}: box ${c.box} out of bounds for ${c.plate} (${W}x${H})`);
  }
  // Rectangle intersection with the exclusion quadrant.
  const overlapsX = x + w > EXCL_X;
  const overlapsY = y + h > EXCL_Y;
  if (overlapsX && overlapsY) {
    throw new Error(
      `${c.id}: box ${c.box} enters the wordmark zone (x>${EXCL_X} && y>${EXCL_Y}) — right edge ${x + w}, bottom ${y + h}`
    );
  }
  if (w / h > 1.0) throw new Error(`${c.id}: box is landscape (${(w / h).toFixed(2)}), want portrait-ish`);
}

const preview = process.argv.includes('--preview');
mkdirSync(preview ? PREVIEW : OUT, { recursive: true });

const meta = new Map();
const index = [];

for (const c of CROPS) {
  if (!meta.has(c.plate)) {
    const m = await sharp(join(SRC, c.plate)).metadata();
    meta.set(c.plate, m);
  }
  const { width: W, height: H } = meta.get(c.plate);
  assertLegal(c, W, H);

  const [left, top, width, height] = c.box;
  const pipe = sharp(join(SRC, c.plate)).extract({ left, top, width, height });

  if (preview) {
    await pipe.png().toFile(join(PREVIEW, `${c.id}.png`));
  } else {
    await pipe
      .resize(OUT_W, OUT_H, { fit: 'cover', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(join(OUT, `${c.id}.png`));
  }

  index.push({
    file: `${c.id}.png`,
    plate: c.plate,
    source_plate_size: { w: W, h: H },
    source_box: { x: left, y: top, w: width, h: height },
    source_box_aspect: +(width / height).toFixed(3),
    output_size: { w: OUT_W, h: OUT_H },
    description: c.desc,
    subject_head_to_toe_px_in_source: c.headToToe,
    measurement_note: c.measure,
    visible_types: c.features,
  });
  console.log(
    `${preview ? 'preview' : 'crop   '} ${c.id}  ${c.plate}  [${left},${top},${width},${height}]  ar=${(width / height).toFixed(2)}`
  );
}

if (!preview) {
  writeFileSync(
    join(OUT, 'index.json'),
    JSON.stringify(
      {
        generated_by: 'tools/scratch/ref-crops.mjs',
        source_dir: SRC,
        licence_note:
          'Total War: ROME II press plates. Crops are strictly excluded from the bottom-right wordmark quadrant (x>1400, y>820 in source). Local-only, gitignored, never redistributed.',
        output: { width: OUT_W, height: OUT_H, fit: 'cover', kernel: 'lanczos3' },
        unusable_plates: [
          {
            plate: 'r2-03.jpg',
            reason:
              'Strategic/deployment overview shot from several hundred metres up. The largest man in the frame is about 12 px tall. No close subject of any kind.',
          },
          {
            plate: 'r2-08.jpg',
            reason:
              'War-elephant plate. The elephants own the frame; the only humans are mahouts at ~150 px head-to-hip, soft and back-lit, and a row of near-black silhouetted helmet backs along the bottom edge with almost no recoverable detail.',
          },
          {
            plate: 'r2-10.jpg',
            reason:
              'Teutoburg forest at night. The foreground legionaries are seen from directly behind and are cut off at the shoulders by the frame edge — roughly 250 px head-to-shoulder, no torso, no hips — and they sit in deep shadow with heavy grain. Everything else in the plate is mid-ground crowd under 150 px.',
          },
        ],
        count: index.length,
        crops: index,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`\nwrote ${index.length} crops + index.json to ${OUT}`);
}
