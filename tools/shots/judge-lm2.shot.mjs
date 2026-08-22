/**
 * The landmark rework, graded from 1.75 m — pass two of the ground judge, on committed work.
 *
 * `e/city/rome-landmarks` at `6c975e8`. `resolveOverlaps` is deleted, `drawY` defaults to
 * `draw`, and every monument stands at `worldOf(e, n)`. The branch asks one question it cannot
 * answer itself and `ROME-FABRIC.md` §8.5b names the frame that would settle it:
 *
 *   *"What would change my mind: a render from the Porta Flaminia showing the Colosseum reading
 *   as a drum rather than an amphitheatre at 27 m."*
 *
 * So these are the frames. Every camera's world coordinates are computed offline by
 * `tools/scratch/jg2-positions.py` from the frame's own two anchors, so a builder can stand in
 * the same place without booting: `x = 292.171 + 0.443·e`, `z = 1245.496 − 0.35·n`.
 *
 * The monument rails are **the previous pass's rails, unchanged** — `dist` 90 / `fov` 50 /
 * `aim` 22 for the Colosseum, `dist` 60 / `fov` 50 for the Pantheon and the Mausoleum — so the
 * frames are directly comparable with `docs/images/judge-ground/rome-colosseum.jpg`,
 * `rome-pantheon.jpg` and `rome-mausoleum.jpg`. Only the focus moved, because the monuments did.
 *
 * `hour` 8.2 on every shot, which is the hour `docs/CITY-GROUND-JUDGE.md` §1 settled on for
 * Rome: the assault comes from the north, so a camera looking south at 10.0 flares out.
 *
 *   node tools/film.mjs tools/shots/judge-lm2.shot.mjs --stills --nooverlay --noencode \
 *     --port=5975 --out=/tmp/tc-jg2/film
 */
export default {
  id: 'judge-lm2',
  title: 'The landmark rework at a man’s height — 6c975e8',
  width: 1920, height: 1080, quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },

  shots: [
    // ---- the thing the branch asked to be judged -------------------------------------
    {
      id: 'lm2-colosseum', scene: 'rome',
      desc: 'The Flavian Amphitheatre at draw 0.573 — 108 x 89 m in plan, 27 m to the attic. '
        + 'Same rail as rome-colosseum.jpg: 90 m out, eye 1.75, aim 22, fov 50.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'world', x: 664, z: 1333 },
      rail: [{ lift: 0, eye: 1.75, aim: 22, dist: 90, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2-colosseum-near', scene: 'rome',
      desc: 'The same, from thirty metres — whether four storeys of arcading still read.',
      start: 11, len: 0.1, speed: 1,
      track: { kind: 'world', x: 664, z: 1333 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 30, fov: 55, yaw: 0 }],
    },
    {
      id: 'lm2-colosseum-valley', scene: 'rome',
      desc: 'The Colosseum with the Ludus Magnus (draw 0.339) and the Baths of Titus in one '
        + 'frame — the licensed abutment G8 and G15 now fail on, from the ground.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'world', x: 706, z: 1300 },
      rail: [{ lift: 0, eye: 1.75, aim: 16, dist: 150, fov: 50, yaw: 0 }],
    },

    // ---- isotropy, the rows that carry a scale and the rows that do not ---------------
    {
      id: 'lm2-pantheon', scene: 'rome',
      desc: 'The Pantheon at draw 0.704 — 59 x 41 m at 30 m, h/w 0.73 against a real 0.74. '
        + 'Same rail as rome-pantheon.jpg.',
      start: 13, len: 0.1, speed: 1,
      track: { kind: 'world', x: 94, z: 1008 },
      rail: [{ lift: 0, eye: 1.75, aim: 14, dist: 60, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2-mausoleum', scene: 'rome',
      desc: 'The Mausoleum of Augustus — no draw scale, full published plan and height. The '
        + 'control for every other frame here. Same rail as rome-mausoleum.jpg.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'world', x: 79, z: 721 },
      rail: [{ lift: 0, eye: 1.75, aim: 22, dist: 60, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2-size-relation', scene: 'rome',
      desc: 'The Mausoleum of Augustus (87 m real, drawn 87) with the Baths of Nero (190 m '
        + 'real, drawn 66) 245 m behind it. The real order of size is reversed.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'world', x: 57, z: 843 },
      rail: [{ lift: 0, eye: 1.75, aim: 20, dist: 200, fov: 46, yaw: 0 }],
    },
    {
      id: 'lm2-castra', scene: 'rome',
      desc: 'The Castra Praetoria at draw 0.190 — a 437 m fortress drawn 76 x 72 m, with the '
        + 'Aurelian curtain that takes its north wall into the circuit.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'world', x: 1228, z: 726 },
      rail: [{ lift: 0, eye: 1.75, aim: 8, dist: 110, fov: 50, yaw: 0 }],
    },

    // ---- the two flagged faults -------------------------------------------------------
    {
      id: 'lm2-marcellus', scene: 'rome',
      desc: 'The Theatre of Marcellus at (180, 1277) — reported 16 world metres inside the '
        + 'modelled Tiber channel after being moved 39 m to its plate control.',
      start: 17, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 1.75, aim: 14, dist: 90, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2-marcellus-water', scene: 'rome',
      desc: 'The same, from across the water at roof height — whether the theatre is standing '
        + 'in the river.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 30, aim: 12, dist: 220, fov: 46, yaw: 1.5708 }],
    },
    {
      id: 'lm2-southedge', scene: 'rome',
      desc: 'The +Z edge behind the Colosseum: eye on the last thirty metres of heightfield, '
        + 'looking north at the amphitheatre. Whether the ground runs out under it.',
      start: 19, len: 0.1, speed: 1,
      track: { kind: 'world', x: 664, z: 1333 },
      rail: [{ lift: 0, eye: 8, aim: 14, dist: 62, fov: 55, yaw: 3.14159 }],
    },

    // ---- the complexes, from the ground ----------------------------------------------
    {
      id: 'lm2-forum-valley', scene: 'rome',
      desc: 'The forum-valley complex from the west at eye level: the Temple of Jupiter, the '
        + 'Tabularium, the Forum Romanum and the imperial fora as one masonry front. This is '
        + 'the ground G8 says needs seven metres of street across it.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'world', x: 360, z: 1200 },
      rail: [{ lift: 0, eye: 1.75, aim: 18, dist: 130, fov: 50, yaw: 1.5708 }],
    },
    {
      id: 'lm2-ulpia', scene: 'rome',
      desc: 'The Basilica Ulpia (drawn 44 x 19 m) and Trajan’s Column standing inside Trajan’s '
        + 'Forum — the 0.66 m clearance G8 fails on, at a man’s height.',
      start: 21, len: 0.1, speed: 1,
      track: { kind: 'world', x: 377, z: 1129 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 70, fov: 50, yaw: 0 }],
    },

    // ---- the walk in, twinned on the previous pass -----------------------------------
    {
      id: 'lm2-in-30', scene: 'rome',
      desc: 'Thirty metres inside the Porta Flaminia. Twin of pair-30m-inside.jpg and '
        + 'pair-landmarks-wip.jpg — identical rail.',
      start: 22, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'lm2-axis-180', scene: 'rome',
      desc: '180 m in on the gate’s own axis. Twin of kz35-axis-180m.jpg — identical rail.',
      start: 23, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -240, eye: 1.75, aim: 10, dist: 60, fov: 42, yaw: 'in' }],
    },
    {
      id: 'lm2-axis-400', scene: 'rome',
      desc: '400 m in on the axis, where the shipped map put 105 unbroken metres of the '
        + 'Theatre of Pompey across it. Twin of r3-pompey.',
      start: 24, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -400, eye: 1.75, aim: 14, dist: 110, fov: 40, yaw: 'in' }],
    },
    {
      id: 'lm2-campus', scene: 'rome',
      desc: 'The Campus Martius from 55 m. Twin of kz35-campus-martius.jpg and '
        + 'lm-wip-campus-martius.jpg — the one frame here that is not at eye level.',
      start: 25, len: 0.1, speed: 1,
      track: { kind: 'world', x: 309, z: 951 },
      rail: [{ lift: 0, eye: 55, aim: 12, dist: 150, fov: 42, yaw: 0 }],
    },
  ],
};
