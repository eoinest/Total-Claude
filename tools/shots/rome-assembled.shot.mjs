/**
 * **Rome as assembled — the pictures, not the probe illustrations.**
 *
 * `e/city/rome-assembled` is the first tree in which Rome's re-projected frame, its re-surveyed
 * Tiber and its re-placed landmarks all exist at once. This file photographs that city so the
 * owner can look at it, and so a judge can stand in exactly the same place afterwards. Every
 * camera below is a world coordinate written down; `docs/ROME-RENDERS.md` lists the same table.
 *
 * **One file, one run, one browser.** `tools/film.mjs` takes a single budget slot, opens one
 * page and re-aims it for every shot. Splitting these across invocations would burn a slot each
 * and self-deadlock at cap 4 — the point of the cap. Do not fan out.
 *
 * The four the brief asks for are `plan-topdown`, `oblique-campus`, `vialata-terminus` and
 * `street-eye`. The rest are the same subjects from a second position, because the cost of
 * another camera in an already-open page is one page-aim and the cost of a re-shoot is a whole
 * browser slot.
 *
 * ## Reading the camera fields
 *
 * There is no `position`/`lookAt` in this format. `track` is an anchor resolved against the live
 * world; `rail` is a photographer's offset from it. `eye` is metres above the terrain **under
 * the focus**, `aim` is the height of the look-at point, `dist` is the *horizontal* standoff
 * from look-at to eye, `fov` is vertical degrees. `yaw` 0 looks **+Z**, which on this map is
 * south, into the city and away from the wall; `yaw: Math.PI` looks north at the wall. On the
 * `gate` anchor, `stand: -N` walks N metres down the Via Lata into the city and `yaw: 'in'`
 * faces that way.
 *
 * `dist: 0` gives `pitch = atan2(rise, 0) = pi/2` — a straight-down plan view. No shot file in
 * this repo had ever used it; `plan-topdown` is the first, and `plan-topdown-safe` is the
 * near-vertical fallback shot in the same run so that a failure of the untested path costs
 * nothing.
 */
export default {
  id: 'rome-assembled',
  title: 'Rome, 271 AD — the assembled map',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      // 9.5 is mid-morning. The Aurelian curtain faces north and is in shade at every hour of
      // the day — that is the wall's own geometry and not something an hour can fix — so the
      // hour is chosen for the city behind it rather than for the masonry in front.
      hour: 9.5,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    // ---------------------------------------------------------------------------------
    // 1. THE PLAN. Stated scale, for setting beside the Lanciani plate.
    // ---------------------------------------------------------------------------------
    {
      id: 'plan-topdown',
      scene: 'rome',
      desc: 'Straight down over the walled city from 2,400 m, NORTH UP. Frame covers ~1,746 m '
        + 'N-S and ~3,104 m E-W at 1920x1080, so 1 px = 1.617 m. Centre (450, 950). '
        + 'yaw = PI, because yaw 0 looks +Z and +Z is south: the first take of this shot came '
        + 'back upside down against a north-up plate.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'world', x: 450, z: 950 },
      rail: [{ lift: 0, eye: 2400, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },
    {
      id: 'plan-topdown-safe',
      scene: 'rome',
      desc: 'The same plan as a near-vertical, in case dist:0 misbehaves. 2,400 m up, 200 m '
        + 'back — 85.2 degrees from horizontal rather than 90.',
      start: 10.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 450, z: 950 },
      rail: [{ lift: 0, eye: 2400, aim: 0, dist: 200, fov: 40, yaw: 0 }],
    },
    {
      id: 'plan-campus',
      scene: 'rome',
      desc: 'Straight down over the Campus Martius alone, from 900 m, NORTH UP. 1 px = '
        + '0.606 m. Centre (100, 950) — the Pantheon, both theatres and the river in one frame.',
      start: 11, len: 0.1, speed: 1,
      track: { kind: 'world', x: 100, z: 950 },
      rail: [{ lift: 0, eye: 900, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },

    // ---------------------------------------------------------------------------------
    // 2. THE OBLIQUE. Fabric, river and wall in one frame — the brief's second picture.
    // ---------------------------------------------------------------------------------
    {
      id: 'oblique-campus',
      scene: 'rome',
      desc: 'Over the Campus Martius from the south-east at 420 m, looking north-west: the '
        + 'fabric in the foreground, the Tiber crossing the frame, the Aurelian Wall closing '
        + 'the top. Focus (120, 900).',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'world', x: 120, z: 900 },
      rail: [{ lift: 0, eye: 420, aim: 30, dist: 620, fov: 42, yaw: 3.9270 }],
    },
    {
      id: 'oblique-north',
      scene: 'rome',
      desc: 'The same subject from due south at 380 m, looking north straight up the Via Lata '
        + 'axis to the Porta Flaminia. Focus (110, 850).',
      start: 12.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 110, z: 850 },
      rail: [{ lift: 0, eye: 380, aim: 25, dist: 600, fov: 42, yaw: 3.1416 }],
    },
    {
      id: 'oblique-river',
      scene: 'rome',
      desc: 'From over the far bank at 300 m looking east across the Tiber into the city — the '
        + 're-surveyed channel, the Tiber Island, and the fabric behind it. Focus (-60, 1050).',
      start: 13, len: 0.1, speed: 1,
      track: { kind: 'world', x: -60, z: 1050 },
      rail: [{ lift: 0, eye: 300, aim: 20, dist: 520, fov: 44, yaw: 4.7124 }],
    },
    {
      id: 'oblique-wall',
      scene: 'rome',
      desc: 'The Aurelian Wall from outside it at 220 m, the attacker\'s side, looking south '
        + 'over the curtain into the city. Focus on the Porta Flaminia bay.',
      start: 13.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: 260, eye: 220, aim: 20, dist: 420, fov: 44, yaw: 'in' }],
    },

    // ---------------------------------------------------------------------------------
    // 3. THE VIA LATA, to its terminus. The ground judge already rates this view.
    // ---------------------------------------------------------------------------------
    {
      id: 'vialata-terminus',
      scene: 'rome',
      desc: 'Standing on the Via Lata 400 m inside the Porta Flaminia at a man\'s height, '
        + 'looking down the axis at the Theatre of Pompey that closes it 110 m on.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -400, eye: 1.75, aim: 14, dist: 110, fov: 40, yaw: 'in' }],
    },
    {
      id: 'vialata-long',
      scene: 'rome',
      desc: 'The whole run of the Via Lata from 150 m inside the gate, a long lens down 300 m '
        + 'of street — this is the shot that shows the bend round the Mausoleum of Augustus.',
      start: 14.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -190, eye: 1.75, aim: 18, dist: 300, fov: 32, yaw: 'in' }],
    },
    {
      id: 'vialata-gate',
      scene: 'rome',
      desc: 'Turned round: 40 m inside the wall on the Via Lata looking back out at the Porta '
        + 'Flaminia — the defender\'s frame and the one the player watches the ram from.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 8, dist: 40, fov: 42, yaw: 'out' }],
    },

    // ---------------------------------------------------------------------------------
    // 4. EYE LEVEL AT 1.75 m. The altitude MAP-METHOD rule 15 exists about.
    // ---------------------------------------------------------------------------------
    /*
     * **Pass two of the ground cameras, and the arithmetic pass one got wrong.**
     *
     * `shot-page.mjs` computes `rise = eye - aim + 1.55` and `pitch = atan2(rise, dist)`, and
     * the camera ends up at `terrainY(focus) + eye`. Two consequences pass one walked into:
     *
     *  1. **The datum is the ground under the FOCUS, not under the eye.** `street-eye-quarter`
     *     put the focus on the Pantheon and the eye 70 m away, and the Campus Martius falls
     *     about 8 m over that run, so a camera asking for 1.75 m stood ten metres up looking
     *     down on the tops of a colonnade. Short `dist` is not a style choice here, it is what
     *     makes `eye` mean what it says.
     *  2. **`aim` sets the pitch.** For a level lens at a standing man's eye the aim height must
     *     be `eye + 1.55` = 3.3, which makes `rise` zero. `VISUAL-RUBRIC.md` section H is only
     *     scorable on frames within 15 degrees of level, and pass one's `aim: 14` at `dist: 110`
     *     is 6.4 degrees up while `aim: 12` at `dist: 70` is 8.7 degrees down - both legal, but
     *     neither is the level frame the rubric describes, and both were guesses.
     *
     * So: `aim: 3.3` throughout, `dist` 22-30 m, and yaw chosen so the 9.5 h sun is behind or
     * beside the lens. Pass one's `street-eye-quarter` was shot straight into it and came back
     * white.
     */
    {
      id: 'eye-vialata-250',
      scene: 'rome',
      desc: 'LEVEL lens, 1.75 m, on the Via Lata 250 m inside the Porta Flaminia, looking on '
        + 'down the axis. aim 3.3 = eye + 1.55, so the pitch is exactly 0.',
      start: 17, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -250, eye: 1.75, aim: 3.3, dist: 26, fov: 50, yaw: 'in' }],
    },
    {
      id: 'eye-vialata-500',
      scene: 'rome',
      desc: 'The same lens 500 m in, deeper into the monumental Campus Martius.',
      start: 17.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -500, eye: 1.75, aim: 3.3, dist: 26, fov: 50, yaw: 'in' }],
    },
    {
      id: 'eye-gate-back',
      scene: 'rome',
      desc: 'Level at 1.75 m, 70 m inside the wall, looking back north at the Porta Flaminia — '
        + 'the sun is behind the lens at this heading.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -70, eye: 1.75, aim: 3.3, dist: 30, fov: 50, yaw: 'out' }],
    },
    {
      id: 'eye-quarter-east',
      scene: 'rome',
      desc: 'Level at 1.75 m in the ordinary fabric east of the axis, world (300, 900), looking '
        + 'north. Insulae rather than marble — this is the frontage H1 and H6 are scored on.',
      start: 18.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 300, z: 900 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 24, fov: 50, yaw: 3.14159 }],
    },
    {
      id: 'eye-quarter-south',
      scene: 'rome',
      desc: 'Level at 1.75 m at world (520, 1010), looking south, sun on the left. The densest '
        + 'part of the rebuilt fabric.',
      start: 19, len: 0.1, speed: 1,
      track: { kind: 'world', x: 520, z: 1010 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 24, fov: 50, yaw: 0 }],
    },
    {
      id: 'eye-colosseum',
      scene: 'rome',
      desc: 'Level at 1.75 m 24 m from the Flavian Amphitheatre at world (671, 1042) — the '
        + 'recognition test in VISUAL-RUBRIC H8(c): does it read as the Colosseum from the '
        + 'street, at a standoff a person could actually take up?',
      start: 19.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 671, z: 1042 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 28, fov: 50, yaw: 3.14159 }],
    },
    {
      id: 'street-eye',
      scene: 'rome',
      desc: 'A man standing in the street at 1.75 m, turned across the Via Lata 300 m in — the '
        + 'enclosure reading, which is what VISUAL-RUBRIC H1 is scored on.',
      start: 15.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -300, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'street-eye-quarter',
      scene: 'rome',
      desc: 'Eye level inside the ordinary fabric away from the monumental axis, at the '
        + 'Pantheon\'s quarter (102, 843) — insulae rather than marble.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'world', x: 102, z: 843 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 70, fov: 46, yaw: 0.7854 }],
    },
    {
      id: 'street-eye-marcellus',
      scene: 'rome',
      desc: 'Eye level at the Theatre of Marcellus (181, 1277) — the row the water check used '
        + 'to fault and no longer does. Standing on dry ground beside it.',
      start: 16.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 1.75, aim: 16, dist: 90, fov: 46, yaw: 3.1416 }],
    },
  ],
};
