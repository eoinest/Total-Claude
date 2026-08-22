/**
 * The city at a soldier's eye line — Rome against Carthage, the same camera on both.
 *
 * Written by the ground-level judge, not by a builder. It exists to answer one question that
 * no probe on this project can express as a threshold: **does the city read as a city from
 * inside it, at the height of a man?**
 *
 * ---------------------------------------------------------------------------------------
 * Why every camera in here is 1.75 m off the ground
 * ---------------------------------------------------------------------------------------
 *
 * A geometric probe passed this map. The owner then looked at one render for under a minute
 * and found four faults the probe had not. The difference is not rigour, it is altitude: every
 * graded frame this project has is from a tactical camera 30–150 m up, and at that height a
 * monument shrunk to fit and a street with a building in it both look fine. So the eye is put
 * at a standing man's and the lens is left nearly level (`aim` within 0.25 m of `eye`), which
 * is the only framing in which "this reads small next to a man" is a statement about the
 * picture rather than an inference from a table.
 *
 * **`dist` is deliberately small — 8 to 12 m — on every street shot.** `dist` is the standoff
 * from the *look-at point* to the eye, so a large `dist` with a low `eye` pushes the camera
 * back out of the thing it is photographing. Keeping it short parks the eye where the man
 * stands and lets the lens do the reaching. The consequence to know about: the eye's height is
 * measured from the terrain under the *focus*, so on sloping ground the eye is off by the fall
 * over `dist`. At 8–12 m on city ground that is under a metre. On the glacis outside the wall
 * it is more, and `rome-approach` / `carth-approach` are the two shots where that matters —
 * both are noted in place.
 *
 * ---------------------------------------------------------------------------------------
 * The pairing rule
 * ---------------------------------------------------------------------------------------
 *
 * **Every Rome shot has a Carthage twin with identical rail numbers.** Same eye, same aim,
 * same standoff, same lens, same standoff from the gate. Carthage is the control: the owner
 * thinks it came out well and Rome did not, and a difference you can point at is worth more
 * than an adjective. The only fields that differ between a twin pair are the ones that must —
 * the map, and the opposing army.
 *
 * **Both maps are shot at the same hour (10.0) and the same weather.** The project's existing
 * `eyeline-*` pairs use 9.5 for Rome and 16.5 for Carthage, because each map's compass is set
 * by where its attacker deploys and each wall's outer face wants its own light. That is right
 * for grading masonry and wrong for grading fabric: two frames under two suns cannot be
 * compared on palette, density or enclosure. So the sun is held and the cost is accepted —
 * Rome's outer curtain faces north and is in shade at every hour of the day (that is recorded
 * in `tools/shoot.mjs`'s `wall` shot and is not something an hour can fix), and Carthage's
 * faces west and is in shade at 10.0. **Neither approach shot is evidence about lighting.**
 *
 * ---------------------------------------------------------------------------------------
 * Why the interior shots are named by standoff from the gate
 * ---------------------------------------------------------------------------------------
 *
 * `stand` is metres out along the gate bay's own outward normal, so a negative `stand` walks
 * *into* the city along the axis the assault arrives on. That is the player's own path after a
 * breach, it is resolved against the live curtain rather than a coordinate that goes stale,
 * and it is the one line both maps have in common: Rome's gate faces the Juthungi across the
 * Campus Martius, Carthage's faces the isthmus across the Byrsa's approach. Walking the same
 * distances into both is the comparison.
 *
 * Frames are shot with `--stills`, which takes frames 0, n/2 and n-1 of each shot. The rails
 * here are single keys, so all three are the same picture; frame 0 is the one to look at. That
 * is three renders a shot instead of one, and it is not worth the complexity to avoid.
 */
export default {
  id: 'judge-city-eye',
  title: 'The city at eye level — Rome against Carthage',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'rome': {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 10.0,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
    'carth': {
      map: 'carthage',
      scenario: 'assault',
      enemy: 'carthage',
      hour: 10.0,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    /* ------------------------------------------------------------------ *
     * 1. The attacker's eye. What the player sees walking at the wall.
     * ------------------------------------------------------------------ */
    {
      id: 'rome-approach',
      scene: 'rome',
      desc: 'Rome: a man on the glacis 110 m out, looking at the Porta Flaminia.',
      // The focus is 100 m out and the eye 110 m out, so the eye is high by the fall of the
      // glacis over ten metres — about 1.4 m at 1:7. Read this frame for what the wall and the
      // gate look like from a man's height, not for the exact height.
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: 100, eye: 1.75, aim: 1.5, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'carth-approach',
      scene: 'carth',
      desc: 'Carthage: a man 110 m out, looking at the gate keep.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: 100, eye: 1.75, aim: 1.5, dist: 10, fov: 42, yaw: 'in' }],
    },

    /* ------------------------------------------------------------------ *
     * 2. From the parapet, looking in. The defender's view of his own city.
     * ------------------------------------------------------------------ */
    {
      id: 'rome-parapet-in',
      scene: 'rome',
      desc: 'Rome: standing on the wall-walk, looking in over the city.',
      // `stand: -6` puts the focus six metres inboard so that the eye — `dist` metres back
      // along the view — lands on the wall centreline rather than out over the ditch.
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [{ lift: 'walk', stand: -6, eye: 1.70, aim: 1.45, dist: 6, fov: 46, yaw: 'in' }],
    },
    {
      id: 'carth-parapet-in',
      scene: 'carth',
      desc: 'Carthage: standing on the wall-walk, looking in over the city.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [{ lift: 'walk', stand: -6, eye: 1.70, aim: 1.45, dist: 6, fov: 46, yaw: 'in' }],
    },

    /* ------------------------------------------------------------------ *
     * 3. Through the gate and into the street. Four standoffs, both maps.
     *    20 m: the gate passage. 120 m: the first block. 250 m and 400 m:
     *    the quarter the second act of the battle is fought in.
     * ------------------------------------------------------------------ */
    {
      id: 'rome-in-20',
      scene: 'rome',
      desc: 'Rome: twenty metres inside the Porta Flaminia, on the Via Lata.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -30, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'carth-in-20',
      scene: 'carth',
      desc: 'Carthage: twenty metres inside the gate.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -30, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'rome-in-120',
      scene: 'rome',
      desc: 'Rome: 120 m inside the wall, looking down the axis of the assault.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -130, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'carth-in-120',
      scene: 'carth',
      desc: 'Carthage: 120 m inside the wall, looking down the axis of the assault.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -130, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'rome-in-250',
      scene: 'rome',
      desc: 'Rome: 250 m inside the wall, in the Campus Martius.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -260, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'carth-in-250',
      scene: 'carth',
      desc: 'Carthage: 250 m inside the wall, below the Byrsa.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -260, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'rome-in-400',
      scene: 'rome',
      desc: 'Rome: 400 m inside the wall, on the Campus Martius proper.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -410, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'carth-in-400',
      scene: 'carth',
      desc: 'Carthage: 400 m inside the wall, on the Byrsa.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -410, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },

    /* ------------------------------------------------------------------ *
     * 4. Across the street rather than down it. A street reads as a street
     *    only if it is *enclosed*, and looking along one hides the walls
     *    that do the enclosing. Same points, turned 90 degrees.
     * ------------------------------------------------------------------ */
    {
      id: 'rome-across-120',
      scene: 'rome',
      desc: 'Rome: 120 m in, turned across the street instead of down it.',
      start: 22, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -130, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'carth-across-120',
      scene: 'carth',
      desc: 'Carthage: 120 m in, turned across the street instead of down it.',
      start: 22, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -130, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'rome-across-250',
      scene: 'rome',
      desc: 'Rome: 250 m in, turned across the street.',
      start: 24, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -260, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'carth-across-250',
      scene: 'carth',
      desc: 'Carthage: 250 m in, turned across the street.',
      start: 24, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -260, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },

    /* ------------------------------------------------------------------ *
     * 5. A monument, from the ground, at the distance a man would first see
     *    it whole. This is the frame the landmark rework's footprint floor
     *    has to be argued from: a 45 m drum 60 m away subtends 37 degrees,
     *    so if it does not fill this frame it is not 45 m.
     * ------------------------------------------------------------------ */
    {
      id: 'rome-mausoleum',
      scene: 'rome',
      desc: 'Rome: the Mausoleum of Augustus from 60 m, at eye level. 87 m across, 45 m high.',
      // World (79, 651) is where the plan diagnostic puts it. `yaw: 0` looks +Z, i.e. away
      // from the wall and into the city, so the eye sits on the gate side of the drum — the
      // side a man coming through the Porta Flaminia approaches from.
      start: 26, len: 0.1, speed: 1,
      track: { kind: 'world', x: 79, z: 651 },
      rail: [{ lift: 0, eye: 1.75, aim: 22, dist: 60, fov: 50, yaw: 0 }],
    },
    {
      id: 'rome-pantheon',
      scene: 'rome',
      desc: 'Rome: the Pantheon from 60 m, at eye level. 43.3 m rotunda, portico 34 m wide.',
      start: 28, len: 0.1, speed: 1,
      track: { kind: 'world', x: 102, z: 843 },
      rail: [{ lift: 0, eye: 1.75, aim: 14, dist: 60, fov: 50, yaw: 0 }],
    },
    {
      id: 'rome-colosseum',
      scene: 'rome',
      desc: 'Rome: the Flavian Amphitheatre from 90 m, at eye level. 189 m across, 48.5 m high.',
      start: 30, len: 0.1, speed: 1,
      track: { kind: 'world', x: 671, z: 1042 },
      rail: [{ lift: 0, eye: 1.75, aim: 22, dist: 90, fov: 50, yaw: 0 }],
    },
    {
      id: 'carth-byrsa',
      scene: 'carth',
      desc: 'Carthage: the Byrsa summit from 60 m, at eye level — the control for monument scale.',
      // Carthage's control monument, framed by the same rule: eye on the ground, aim at half
      // the subject's height, standoff about 1.4x its width.
      start: 26, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -418, eye: 1.75, aim: 22, dist: 60, fov: 50, yaw: 'in' }],
    },
  ],
};
