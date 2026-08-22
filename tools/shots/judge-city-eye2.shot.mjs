/**
 * Pass two: the same question, aimed at ground the first pass proved is *clear*.
 *
 * Pass one (`judge-city-eye.shot.mjs`) parked the eye at round numbers of metres inside each
 * gate and four of its twelve interior frames came back with the camera inside masonry. That
 * is not a harness fault — it is the finding — but a frame of the inside of a wall is evidence
 * of only one thing, so this pass is aimed off `tools/scratch/judge-fabric.mjs`, which walks
 * the gate axis in 5 m steps and reports, station by station, whether a standing man is inside
 * a solid. Every `stand` below was chosen from that table.
 *
 * **The arithmetic to keep straight.** The eye sits `dist` metres *outboard* of the focus, so a
 * shot whose eye is to stand `s` metres inside the wall needs `stand = -(s + dist)`. Pass one's
 * `stand: -130` put the eye 120 m in, which is inside the Mausoleum of Augustus (95–145 m on
 * the axis). Every id here is named for where the **eye** is, not where the focus is.
 *
 * ---------------------------------------------------------------------------------------
 * Two hours, and why that is right rather than sloppy
 * ---------------------------------------------------------------------------------------
 *
 * Pass one held the sun at 10.0 on both maps so that palette could be compared, and the cost
 * was worse than the gain: Rome's interior faces **south** (the assault comes from the north,
 * so `yaw: 'in'` looks toward the sun's own half of the sky at Rome's 41.9 N) and every Rome
 * interior frame came back flared out. Carthage's interior faces **east** and has the same
 * problem in the morning that Rome has at noon.
 *
 * So this pass gives each map the hour the project's own graded shots give it — Rome 8.2 from
 * `tools/shoot.mjs`'s `rome-line`, Carthage 15.4 from `ab2-carth-aftermath` — and **the pairs
 * are therefore evidence about form and not about light.** Grain, enclosure, density, street
 * width, whether a monument blocks the way: all comparable. Palette, contrast, haze: not, and
 * they are graded per map on its own frame instead.
 *
 * Camera geometry is identical across every twin pair, to the metre and the degree.
 */
export default {
  id: 'judge-city-eye2',
  title: 'The city at eye level, pass two — aimed at clear ground',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'rome': {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
    'carth': {
      map: 'carthage', scenario: 'assault', enemy: 'carthage',
      hour: 15.4, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },

  shots: [
    /* --- Rome: down the axis of the assault, from clear stations. ------------- */
    {
      id: 'r2-in-30', scene: 'rome',
      desc: 'Rome: 30 m inside the Porta Flaminia. Nothing within 250 m on the left; a 1.5 m wall 85 m to the right.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-in-90', scene: 'rome',
      desc: 'Rome: 90 m in, looking at the Mausoleum of Augustus, which closes the axis from 95 to 145 m.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -100, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-in-200', scene: 'rome',
      desc: 'Rome: 200 m in, between the Mausoleum and the Baths of Nero. Frontages 112 m left, 74 m right.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -210, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-in-310', scene: 'rome',
      // The only stretch of the whole 700 m that measures like a street: W 11-23 m, H/W 0.95-1.84
      // at 300-330 m in. Shot because a judge that only photographs the failures is not grading.
      desc: 'Rome: 310 m in — the one stretch of the axis that measures as a street. H/W 1.11.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -320, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-in-350', scene: 'rome',
      desc: 'Rome: 350 m in, looking at the Theatre of Pompey, which closes the axis for 105 m.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -360, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-in-500', scene: 'rome',
      desc: 'Rome: 500 m in, under the Capitol. A 48 m frontage 26 m to the left and a 1.8 m wall 90 m right.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -510, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r2-across-30', scene: 'rome',
      desc: 'Rome: 30 m in, turned across the axis — the ground behind the assaulted gate.',
      start: 22, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'r2-across-310', scene: 'rome',
      desc: 'Rome: 310 m in, turned across the street that measures as a street.',
      start: 24, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -320, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'r2-street', scene: 'rome',
      // The narrowest clear corridor the 300-point sample found in the whole walled city that is
      // long as well as narrow: 5 m across east-west, running 42 m north-south.
      desc: 'Rome: the narrowest long lane in the city — 5 m wide, 42 m long, at (-219, 784).',
      start: 26, len: 0.1, speed: 1,
      track: { kind: 'world', x: -219, z: 784 },
      rail: [{ lift: 0, eye: 1.75, aim: 1.60, dist: 8, fov: 46, yaw: 0 }],
    },
    {
      id: 'r2-street-x', scene: 'rome',
      desc: 'Rome: the same lane, across it — the frontages that make it a lane.',
      start: 28, len: 0.1, speed: 1,
      track: { kind: 'world', x: -219, z: 784 },
      rail: [{ lift: 0, eye: 1.75, aim: 1.60, dist: 8, fov: 46, yaw: 1.5708 }],
    },
    {
      id: 'r2-grain', scene: 'rome',
      // From a roof, not the ground: block *orientation* is what this frame is for, and at 1.75 m
      // the nearest frontage hides every block behind it. 8 m is one insula's eaves.
      desc: 'Rome: the Esquiline from roof height — block orientation over 150 m of fabric.',
      start: 30, len: 0.1, speed: 1,
      track: { kind: 'world', x: 553, z: 994 },
      rail: [{ lift: 0, eye: 8, aim: 8, dist: 40, fov: 46, yaw: 0.6 }],
    },
    {
      id: 'r2-capitol', scene: 'rome',
      desc: 'Rome: the Capitol from the west at eye level — the Temple of Jupiter over the Tabularium.',
      start: 32, len: 0.1, speed: 1,
      track: { kind: 'world', x: 362, z: 940 },
      rail: [{ lift: 0, eye: 1.75, aim: 20, dist: 80, fov: 50, yaw: 1.5708 }],
    },

    /* --- Carthage: the control, same cameras. --------------------------------- */
    {
      id: 'c2-in-30', scene: 'carth',
      desc: 'Carthage: 30 m inside the gate.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c2-in-90', scene: 'carth',
      desc: 'Carthage: 90 m in. Frontages 50 m left, 220 m right.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -100, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c2-in-240', scene: 'carth',
      desc: 'Carthage: 240 m in, threading the block column that lines the avenue.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -250, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c2-in-300', scene: 'carth',
      desc: 'Carthage: 300 m in, on the open ground below the Byrsa.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -310, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c2-in-470', scene: 'carth',
      desc: 'Carthage: 470 m in, past the Byrsa.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -480, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c2-across-30', scene: 'carth',
      desc: 'Carthage: 30 m in, turned across the axis.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'c2-across-300', scene: 'carth',
      desc: 'Carthage: 300 m in, turned across the axis.',
      start: 22, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -310, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'c2-street', scene: 'carth',
      // 4 m across and unbroken for 266 m: `PUNIC_WAY_WIDTH.vicus` exactly, which is the tell
      // that Carthage's lanes come off a declared module and Rome's come off nothing.
      desc: 'Carthage: a 4 m lane, unbroken for 266 m, at (-141, 701).',
      start: 24, len: 0.1, speed: 1,
      track: { kind: 'world', x: -141, z: 701 },
      rail: [{ lift: 0, eye: 1.75, aim: 1.60, dist: 8, fov: 46, yaw: 0 }],
    },
    {
      id: 'c2-street-x', scene: 'carth',
      desc: 'Carthage: the same lane, across it.',
      start: 26, len: 0.1, speed: 1,
      track: { kind: 'world', x: -141, z: 701 },
      rail: [{ lift: 0, eye: 1.75, aim: 1.60, dist: 8, fov: 46, yaw: 1.5708 }],
    },
    {
      id: 'c2-grain', scene: 'carth',
      desc: 'Carthage: the Punic quarter from roof height — block orientation over 150 m of fabric.',
      start: 28, len: 0.1, speed: 1,
      track: { kind: 'world', x: -244, z: 701 },
      rail: [{ lift: 0, eye: 8, aim: 8, dist: 40, fov: 46, yaw: 0.6 }],
    },
  ],
};
