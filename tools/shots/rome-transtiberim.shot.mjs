/**
 * **The far bank, photographed — the Trans Tiberim pass.**
 *
 * Phase 3 authored no way across the right bank and `fabric.ts`'s `RIVER_REACH` comment said
 * so. What held Regio XIV up was a 230 m ramp off the channel: a ribbon of insulae on the
 * water and a square kilometre of empty field behind it, on **47.2 % of the map's city
 * ground**. `ways.ts` now carries four Trans Tiberim rows off the plates and `regions.ts`
 * declares everything north of the Porta Septimiana *horti* -- 78 % of its buildable ground.
 * Regio XIV goes from 53 blocks and 76 buildings to 98 and 92; the frames are what decides
 * whether that reads as a quarter or as a coverage number.
 *
 * **Two cameras are `rome-grid.shot.mjs`'s, to the digit** — `grid-plan` and `grid-river` —
 * so the before and after of this pass can be laid side by side against the grid pass's own
 * frames and the only thing that has moved is the far bank. `CITY-GROUND-JUDGE.md` §2: the
 * camera is part of the instrument.
 *
 * **One file, one run, one browser.** `tools/film.mjs` takes a single budget slot and re-aims
 * one page per shot. Do not fan out.
 *
 * The world coordinates that matter, all from `worldOf` at `KX` 0.443 / `KZ` 0.35:
 *
 *   Pons Aemilius bridgehead   (129, 1336)   survey (-368, -259), the Ripa's south end
 *   Porta Septimiana           (-272, 1176)  survey (-1272, 197), where the quarter ends
 *   Janiculum Ridge            (-416, 1374)  survey (-1599, -367), clamped 8 m by CITY_Z_MAX
 *   Mausoleum of Hadrian       (-295, 833)   survey (-1326, 1178), the Pons Aelius bridgehead
 *   the Ansa's westernmost     (-375, 1025)  survey (-1506, 629), the Prata Quinctia's bank
 *
 * A note on `yaw`, because it decides three of these shots and is not obvious: yaw 0 looks
 * **+Z**, which is south; `PI` is north-up in a plan; `PI/2` looks **east**; `3*PI/2` looks
 * **west**, which is the direction the far bank is looked at from the city.
 */
export default {
  id: 'rome-transtiberim',
  title: 'Rome, 271 AD — the far bank',
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
    // 1. THE WHOLE MAP, SO THE HOLE IS EITHER FILLED OR IT IS NOT.
    // ---------------------------------------------------------------------------------
    {
      id: 'tt-plan-whole',
      scene: 'rome',
      desc: 'Straight down over the whole battlefield from 3,200 m, NORTH UP. Centre (0, 700). '
        + 'At 1920x1080 and fov 40 the frame covers about 2,329 m north-south and 4,140 m '
        + 'east-west, so the entire 2,800 m square is inside it and 1 px = 2.156 world m. This '
        + 'is the frame the hole was visible in: everything left of the river below the crest '
        + 'was field.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'world', x: 0, z: 700 },
      rail: [{ lift: 0, eye: 3200, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'grid-plan',
      scene: 'rome',
      desc: 'Straight down over the walled city from 2,400 m, NORTH UP. Centre (450, 950). '
        + '1 px = 1.617 world m. IDENTICAL RAIL to rome-grid.shot.mjs and rome-roads.shot.mjs, '
        + 'so this is the third frame of the same before-and-after. Only the west edge should '
        + 'have changed.',
      start: 15.3, len: 0.1, speed: 1,
      track: { kind: 'world', x: 450, z: 950 },
      rail: [{ lift: 0, eye: 2400, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'tt-plan-quarter',
      scene: 'rome',
      desc: 'Straight down over Transtiberim from 800 m, NORTH UP. Centre (-200, 1200): the '
        + 'Ripa, the Via Septimiana, the Via Aurelia and the Janiculum\'s east foot, with the '
        + 'Tiber Island in the bottom right. 1 px = 0.539 world m. This is the quarter itself, '
        + 'and the question it answers is whether the grain follows the bank.',
      start: 15.6, len: 0.1, speed: 1,
      track: { kind: 'world', x: -200, z: 1200 },
      rail: [{ lift: 0, eye: 800, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'tt-plan-horti',
      scene: 'rome',
      desc: 'Straight down over the Prata Quinctia and the Ager Vaticanus from 1,100 m, NORTH '
        + 'UP. Centre (-480, 800). 1 px = 0.741 world m. Everything here is horti: 20.8 of the '
        + 'region\'s 26.6 hectares of ground between street lines, built at 8 per cent with '
        + 'three times the trees. The failure mode this frame is for is a uniform lattice at '
        + 'one bearing over a square kilometre, which is what the pass was warned off.',
      start: 15.9, len: 0.1, speed: 1,
      track: { kind: 'world', x: -480, z: 800 },
      rail: [{ lift: 0, eye: 1100, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },

    // ---------------------------------------------------------------------------------
    // 2. THE FAR BANK FROM THE CITY SIDE, WHICH IS HOW ANYBODY WILL EVER SEE IT.
    // ---------------------------------------------------------------------------------
    {
      id: 'tt-from-city',
      scene: 'rome',
      desc: 'From the Campus Martius\'s river frontage, 200 m up and 640 m back, looking WEST '
        + 'across the Tiber at Transtiberim and the Janiculum. Target (-250, 1270). Nobody '
        + 'fights on this bank, so this and the plan above are the only two frames in which '
        + 'the quarter has to hold up.',
      start: 16.3, len: 0.1, speed: 1,
      track: { kind: 'world', x: -250, z: 1270 },
      rail: [{ lift: 0, eye: 200, aim: 20, dist: 640, fov: 40, yaw: 4.71239 }],
    },
    {
      id: 'grid-river',
      scene: 'rome',
      desc: 'The Tiber from 420 m up, looking east across the channel at world (-150, 950). '
        + 'IDENTICAL RAIL to rome-grid.shot.mjs `grid-river`, whose caption reads "Regio XIV '
        + 'builds 53 blocks on a 230 m band off the right bank and nothing beyond it". The '
        + 'camera sits at (-670, 950), which used to be an empty field and is now the Prata '
        + 'Quinctia\'s garden ground.',
      start: 16.7, len: 0.1, speed: 1,
      track: { kind: 'world', x: -150, z: 950 },
      rail: [{ lift: 0, eye: 420, aim: 20, dist: 520, fov: 40, yaw: 1.5708 }],
    },

    // ---------------------------------------------------------------------------------
    // 3. FROM 1.75 m, BECAUSE MAP-METHOD RULE 15 SAYS SO.
    // ---------------------------------------------------------------------------------
    {
      id: 'tt-eye-ripa',
      scene: 'rome',
      desc: 'Standing on the Ripa at world (-185, 1251) — survey (-1076, -16), a hundred metres '
        + 'south of the Porta Septimiana — eye 1.75 m, a 46 degree lens 120 m up the quay. The '
        + 'street runs north-west along the water at a world bearing of 220 degrees. What has '
        + 'to read here is a frontage on one side and the river on the other.',
      start: 17.1, len: 0.1, speed: 1,
      track: { kind: 'world', x: -185, z: 1251 },
      rail: [{ lift: 0, eye: 1.75, aim: 8, dist: 120, fov: 46, yaw: 4.012 }],
    },
    {
      id: 'tt-eye-aurelia',
      scene: 'rome',
      desc: 'Standing on the Via Aurelia at world (-200, 1352) — survey (-1111, -305) — eye '
        + '1.75 m, looking WEST up the road toward the Janiculum, 200 m of it in a 46 degree '
        + 'lens. The ridge ahead is the row `survey.ts` authors 520 x 240 and the terrain draws '
        + 'as a plateau; this frame is the one that shows whether the road climbing it reads.',
      start: 17.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: -200, z: 1352 },
      rail: [{ lift: 0, eye: 1.75, aim: 6, dist: 200, fov: 46, yaw: 4.71239 }],
    },
  ],
};
