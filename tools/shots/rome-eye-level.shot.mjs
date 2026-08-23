/**
 * **Rome from 1.75 m, before and after the ground pass — and Carthage beside it.**
 *
 * `docs/VISUAL-RUBRIC.md` §H is scored *only* on frames taken at a standing man's eye with the
 * lens within 15° of level, so this file exists to produce exactly those and nothing else. It
 * is deliberately **the previous pass's rail, unchanged**: every Rome station below is copied
 * from `docs/ROME-RENDERS.md`'s own table, and instruction 9 of the rubric's critic notes says
 * why — *"a ground-level score is only comparable if the standoff and the lens are the same,
 * and the temptation is to re-frame a monument that has moved."*
 *
 * **`aim = eye + 1.55` makes the lens exactly level.** `pitch = atan2(eye - aim + 1.55, dist)`,
 * so `aim` 3.3 against `eye` 1.75 gives zero. The three stations below that are *not* level —
 * `r-vialata-terminus`, `r-oblique-campus` — are marked as such and are not scored on §H; they
 * are there because the terrain fault this pass is about is a *landform*, and a landform needs
 * one frame taller than a man to be seen whole.
 *
 * **`eye` is measured from the terrain under the FOCUS, not under the eye.** A 1.75 m camera
 * looking 110 m across ground that falls 8 m stands ten metres up. That is why `dist` is 24–30
 * on every scored station: at eye level `dist` is not a framing choice, it is what makes `eye`
 * mean what it says.
 *
 * **Carthage is the control and is shot in the same run**, at the two stations
 * `docs/CITY-GROUND-JUDGE.md` §2 paired the two cities at. Nothing in this pass touches
 * Carthage; its frames are here so that "Rome improved" can be read against something that
 * did not.
 *
 * One file, one run, one browser slot. Do not fan these out across invocations.
 */
export default {
  id: 'rome-eye-level',
  title: 'Rome at a standing man\'s eye — the ground pass',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      // 9.5, which is `rome-assembled.shot.mjs`'s hour, so the before frames in
      // `docs/ROME-RENDERS.md` are directly comparable.
      hour: 9.5,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
    carthage: {
      map: 'carthage',
      scenario: 'assault',
      // 10.0, the hour `docs/CITY-GROUND-JUDGE.md` shot Carthage at in both earlier passes.
      hour: 10.0,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
      weather: 'clear',
    },
  },

  shots: [
    // -----------------------------------------------------------------------------------
    // ROME — the scored stations. Level lens, 1.75 m, previous pass's rail.
    // -----------------------------------------------------------------------------------
    {
      id: 'r-eye-vialata-250',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m, on the Via Lata 250 m inside the Porta Flaminia looking on down the '
        + 'axis. ROME-RENDERS eye-vialata-250, rail unchanged.',
      start: 17, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -250, eye: 1.75, aim: 3.3, dist: 26, fov: 50, yaw: 'in' }],
    },
    {
      id: 'r-eye-vialata-500',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m, 500 m in — the deep monumental Campus Martius. ROME-RENDERS '
        + 'eye-vialata-500, rail unchanged.',
      start: 17.5, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -500, eye: 1.75, aim: 3.3, dist: 26, fov: 50, yaw: 'in' }],
    },
    {
      id: 'r-eye-gate-back',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m, 70 m inside the wall looking back north at the Porta Flaminia. '
        + 'ROME-RENDERS eye-gate-back, rail unchanged.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -70, eye: 1.75, aim: 3.3, dist: 30, fov: 50, yaw: 'out' }],
    },
    {
      id: 'r-eye-quarter-east',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m in the ordinary fabric east of the axis, world (300, 900), looking '
        + 'north. THE honest frame: no monument in it, only insulae and the ground between them. '
        + 'ROME-RENDERS eye-quarter-east, rail unchanged.',
      start: 18.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: 300, z: 900 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 24, fov: 50, yaw: 3.14159 }],
    },
    {
      id: 'r-eye-quarter-south',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m at world (520, 1010) looking south — the densest rebuilt fabric. '
        + 'ROME-RENDERS eye-quarter-south, rail unchanged.',
      start: 19, len: 0.1, speed: 1,
      track: { kind: 'world', x: 520, z: 1010 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 24, fov: 50, yaw: 0 }],
    },
    {
      id: 'r-eye-tabernae',
      scene: 'rome',
      desc: 'LEVEL, 1.75 m, 12 m off a frontage in the Campus Martius at world (60, 880) — close '
        + 'enough that H7 is countable in the frame rather than inferred. NEW STATION this pass; '
        + 'it has no before-twin on an earlier rail and is recorded as new.',
      start: 19.2, len: 0.1, speed: 1,
      track: { kind: 'world', x: 60, z: 880 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 12, fov: 55, yaw: 1.5708 }],
    },
    {
      id: 'r-parapet-in',
      scene: 'rome',
      desc: 'From the wall-walk of bay 4 looking into the city — the CITY-GROUND-JUDGE §3 pair, '
        + 'the single most useful frame in that document. Rome half.',
      start: 19.4, len: 0.1, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [{ lift: 'walk', stand: -6, eye: 1.7, aim: 1.45, dist: 6, fov: 46, yaw: 'in' }],
    },

    // -----------------------------------------------------------------------------------
    // ROME — not level, not scored on §H. The landform frames.
    // -----------------------------------------------------------------------------------
    {
      id: 'r-vialata-terminus',
      scene: 'rome',
      desc: 'NOT LEVEL (7.1 deg up). Gate stand -400, aim 14, dist 110 — ROME-RENDERS '
        + 'vialata-terminus, the frame in which the flood plain\'s rounded masses are plainest. '
        + 'The station is known stale (it no longer lands on the street after KZ 0.222 -> 0.35) '
        + 'and is kept unchanged anyway, because a stale station photographed twice is still a '
        + 'controlled comparison and a moved one is not.',
      start: 19.6, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -400, eye: 1.75, aim: 14, dist: 110, fov: 40, yaw: 'in' }],
    },
    {
      id: 'r-oblique-campus',
      scene: 'rome',
      desc: 'NOT LEVEL. The 420 m oblique over the Campus Martius — ROME-RENDERS oblique-campus, '
        + 'rail unchanged. The altitude at which the city already convinced.',
      start: 20, len: 0.1, speed: 1,
      track: { kind: 'world', x: 120, z: 900 },
      rail: [{ lift: 0, eye: 420, aim: 30, dist: 620, fov: 42, yaw: 3.9270 }],
    },
    {
      id: 'r-plan-campus',
      scene: 'rome',
      desc: 'Plan of the Campus Martius, north up, dist 0 — for reading the ground cover and the '
        + 'street network as a network. ROME-RENDERS plan-campus, rail unchanged.',
      start: 20.2, len: 0.1, speed: 1,
      track: { kind: 'world', x: 100, z: 950 },
      rail: [{ lift: 0, eye: 900, aim: 0, dist: 0, fov: 40, yaw: 3.14159 }],
    },

    // -----------------------------------------------------------------------------------
    // CARTHAGE — the control. Untouched by this pass.
    // -----------------------------------------------------------------------------------
    {
      id: 'c-avenue-30m',
      scene: 'carthage',
      desc: 'Carthage, 30 m inside its gate on the avenue, eye 1.75 — CITY-GROUND-JUDGE §2 '
        + 'pair-30m-inside, Carthage half, rail unchanged.',
      start: 17, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }],
    },
    {
      id: 'c-eye-quarter',
      scene: 'carthage',
      desc: 'LEVEL, 1.75 m in Carthage\'s ordinary fabric at world (-141, 701) — the twin of '
        + 'r-eye-quarter-east, same eye, same aim, same dist, same lens. This is the frame the '
        + 'urbanism comparison is made on.',
      start: 17.5, len: 0.1, speed: 1,
      track: { kind: 'world', x: -141, z: 701 },
      rail: [{ lift: 0, eye: 1.75, aim: 3.3, dist: 24, fov: 50, yaw: 3.14159 }],
    },
    {
      id: 'c-parapet-in',
      scene: 'carthage',
      desc: 'Carthage from the wall-walk of bay 4 looking into the city — the other half of the '
        + 'CITY-GROUND-JUDGE §3 pair, rail unchanged.',
      start: 18, len: 0.1, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [{ lift: 'walk', stand: -6, eye: 1.7, aim: 1.45, dist: 6, fov: 46, yaw: 'in' }],
    },
  ],
};
