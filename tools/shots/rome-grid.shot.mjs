/**
 * **Rome's grid, photographed — phase 4 of the fabric rebuild.**
 *
 * `docs/ROME-FABRIC.md` §5 phase 4: the seventeen district rectangles and their spine-and-rib
 * lattices are deleted, a block is a face of the road planar graph, and the fourteen Augustan
 * *regiones* carry attributes and no extent. These are the frames that let that be judged by
 * eye rather than by a table.
 *
 * **Every plan camera here reuses `rome-roads.shot.mjs`'s rail numbers to the digit** —
 * `network-plan`, `network-plan-campus` and `network-plan-east` — so a reader can put the two
 * sets of frames side by side and the only thing that has moved is the city. That is the
 * point of writing the coordinates down (`docs/MAP-METHOD.md` §3, and `CITY-GROUND-JUDGE.md`
 * §2's rule that a camera is part of the instrument).
 *
 * **One file, one run, one browser.** `tools/film.mjs` takes a single budget slot and re-aims
 * one page for every shot. Splitting these across invocations burns a slot each and
 * self-deadlocks at cap 4. Do not fan out.
 *
 * The world coordinates that matter, all from `worldOf` at `KX` 0.443 / `KZ` 0.35:
 *
 *   Porta Flaminia            (72.0, 529.7)   the gate, and the projection's own anchor
 *   Via Lata x Via Recta      (221.8, 928.8)  the Campus Martius's own crossroads
 *   Alta Semita, mid-Quirinal (600, 900)      the densest lattice on the map
 *   the Subura, Regio IV      (640, 1230)     77 % of its ground between street lines is roof
 */
export default {
  id: 'rome-grid',
  title: 'Rome, 271 AD — blocks as faces of the road graph',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 9.5,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    // ---------------------------------------------------------------------------------
    // 1. THE BLOCK STRUCTURE FROM ABOVE, AT A STATED SCALE.
    //    Identical rails to rome-roads.shot.mjs, so the pair is a before and after.
    // ---------------------------------------------------------------------------------
    {
      id: 'grid-plan',
      scene: 'rome',
      desc: 'Straight down over the walled city from 2,400 m, NORTH UP (yaw = PI, because yaw '
        + '0 looks +Z and +Z is south). Centre (450, 950). At 1920x1080 and fov 40 the frame '
        + 'covers about 1,746 m north-south and 3,104 m east-west, so 1 px = 1.617 world m. '
        + 'Same camera as rome-roads `network-plan`. 299 blocks, every one a face of the graph; '
        + '130 cross-lanes and 42.5 km of them, cut in each parent face\'s own frame.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'world', x: 450, z: 950 },
      rail: [{ lift: 0, eye: 2400, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'grid-plan-campus',
      scene: 'rome',
      desc: 'Straight down over the Campus Martius alone from 900 m, NORTH UP. Centre '
        + '(100, 950). 1 px = 0.606 world m. Same camera as rome-roads `network-plan-campus`. '
        + 'Regio IX: 53 blocks, 34 per cent of its ground between street lines built, and the '
        + 'lowest coverage of any graded regio because most of the rest of it is monument.',
      start: 15.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 100, z: 950 },
      rail: [{ lift: 0, eye: 900, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'grid-plan-east',
      scene: 'rome',
      desc: 'Straight down over the Quirinal, the Viminal and the Subura from 1,100 m, NORTH '
        + 'UP. Centre (700, 1000). 1 px = 0.741 world m. Same camera as rome-roads '
        + '`network-plan-east`. Regio VI builds 57 per cent of its ground between street lines '
        + 'and Regio V 64 — inside the AGEA orthophoto\'s 60-70 per cent for the historic core.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'world', x: 700, z: 1000 },
      rail: [{ lift: 0, eye: 1100, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'grid-plan-gate',
      scene: 'rome',
      desc: 'Straight down from 620 m over the 700 world metres directly behind the Porta '
        + 'Flaminia — the ground the assault fights across. Centre (200, 800). 1 px = 0.418 '
        + 'world m. Regio VII, the Via Lata quarter, was 2.9 per cent built before this pass '
        + 'and is 58 per cent now.',
      start: 16.2, len: 0.1, speed: 1,
      track: { kind: 'world', x: 200, z: 800 },
      rail: [{ lift: 0, eye: 620, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },

    // ---------------------------------------------------------------------------------
    // 2. A STREET AT A STANDING MAN'S EYE. MAP-METHOD rule 15: 1.75 m before 150 m.
    // ---------------------------------------------------------------------------------
    {
      id: 'grid-eye-lane',
      scene: 'rome',
      desc: 'Standing in a generated *vicus* on the Quirinal at world (600, 900), eye 1.75 m, '
        + 'looking 180 m down the lane. Every wall in this frame belongs to a block cut from '
        + 'the same two street lines, so the two façades are parallel by construction — that '
        + 'is the thing `probe-fabric` G20 measures and this is what it looks like.',
      start: 17, len: 0.1, speed: 1,
      track: { kind: 'world', x: 600, z: 900 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 180, fov: 40, yaw: 0.35 }],
    },
    {
      id: 'grid-eye-lata',
      scene: 'rome',
      desc: 'On the Via Lata 200 m inside the Porta Flaminia at a standing man\'s eye, a 32 '
        + 'degree lens 420 m down the carriageway. Same camera as rome-roads `vialata-length`, '
        + 'so the pair shows what the artery gained when the ground either side of it stopped '
        + 'being a lattice and became blocks fronting it.',
      start: 17.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 249, z: 1000 },
      rail: [{ lift: 0, eye: 1.75, aim: 24, dist: 420, fov: 32, yaw: 0.362 }],
    },
    {
      id: 'grid-eye-subura',
      scene: 'rome',
      desc: 'In Regio IV, the Subura, at world (640, 1230), eye 1.75 m, a 46 degree lens 90 m '
        + 'along. The densest regio the frame carries: 1.36 hectares of ground between street '
        + 'lines and 77 per cent of it roof, four to six storeys.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'world', x: 640, z: 1230 },
      rail: [{ lift: 0, eye: 1.75, aim: 16, dist: 90, fov: 46, yaw: 1.4 }],
    },

    // ---------------------------------------------------------------------------------
    // 3. ONE BLOCK, OBLIQUE, SO THE COURTYARD READS.
    // ---------------------------------------------------------------------------------
    {
      id: 'grid-block-oblique',
      scene: 'rome',
      desc: 'One block on the Viminal from 150 m up and 200 m out, world (820, 900). A block '
        + 'is 84 x 59 world metres between lane centrelines and 73 x 48 between building '
        + 'lines; a quarter of them are built as one continuous range about a courtyard and '
        + 'the rest as two terraces back to back about a light well.',
      start: 18.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 820, z: 900 },
      rail: [{ lift: 0, eye: 150, aim: 10, dist: 200, fov: 40, yaw: 3.9 }],
    },
    {
      id: 'grid-river',
      scene: 'rome',
      desc: 'The Tiber from 420 m up, looking east across the channel at world (-150, 950). '
        + 'The channel is a graph edge now, so no block crosses it and Transtiberim fronts the '
        + 'water instead of taking its grain from the map axes. Regio XIV builds 53 blocks on '
        + 'a 230 m band off the right bank and nothing beyond it: phase 3 authored no way '
        + 'across that bank, so the Janiculum is country until phase 6.',
      start: 19, len: 0.1, speed: 1,
      track: { kind: 'world', x: -150, z: 950 },
      rail: [{ lift: 0, eye: 420, aim: 20, dist: 520, fov: 40, yaw: 1.5708 }],
    },
  ],
};
