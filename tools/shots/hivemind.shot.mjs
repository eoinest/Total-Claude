/**
 * The four views the "hive mind" report has to be judged from.
 *
 * The owner's complaint is three things and a boundary: the sway is coherent, a melee keeps
 * its geometry, the men look driven rather than deciding — *unless they were told to* stand
 * in a shape, in which case the shape is the point.
 *
 * Each of those needs a different camera, and two of them need a camera looking **down**,
 * because a lattice is invisible from eye level: a rank of men one behind the other reads as
 * a crowd from in front and as a ruled grid from above. `probe-hivemind.mjs` measured a
 * cohort at ease at exactly 0.86 m nearest-neighbour separation with a standard deviation of
 * **0.000 m** and a per-man speed of **0.000 m/s** — a crystal of statues — and none of the
 * eye-level shots in `shoot.mjs` would have shown it.
 *
 * Pinned, not followed, and all six run off one scene at one seed, so a before/after pair is
 * the same battle twice and the only thing that moved is the men.
 */
export default {
  id: 'hivemind',
  title: 'Do the men look like nine thousand men, or like one animal?',
  width: 1920, height: 1080, quality: 'ultra',
  scenes: {
    field: {
      map: 'campus-martius', scenario: 'field', enemy: 'juthungi',
      hour: 9.5, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },
  shots: [
    // ---- a cohort standing at ease -------------------------------------------------
    // Early, before anyone has moved far: the men are dressed and waiting.
    {
      id: 'ease-eye', scene: 'field',
      desc: 'A legionary cohort standing at ease, from in front at eye level',
      start: 6, len: 0.1, speed: 1,
      track: { kind: 'unitType', id: 'legio-cohort' },
      rail: [{ lift: 0, eye: 1.85, aim: 1.6, dist: 26, fov: 38 }],
    },
    {
      // The lattice shot. Looking down the ranks is the only way the grid is visible.
      id: 'ease-top', scene: 'field',
      desc: 'The same cohort from 34 m up — the shot the lattice shows in',
      start: 8, len: 0.1, speed: 1,
      track: { kind: 'unitType', id: 'legio-cohort' },
      rail: [{ lift: 0, eye: 34, aim: 1.2, dist: 40, fov: 40 }],
    },

    // ---- two lines at the moment of contact ------------------------------------------
    {
      id: 'contact-eye', scene: 'field',
      desc: 'The instant the first man is in melee, from the seam at eye level',
      start: { find: 'contact', before: 400 }, len: 0.1, speed: 1,
      track: { kind: 'frontGap' },
      rail: [{ lift: 0, eye: 2.4, aim: 1.7, dist: 34, fov: 40, yawAdd: 0.9 }],
    },
    {
      id: 'contact-top', scene: 'field',
      desc: 'The same instant from 48 m up — two shapes, or two crowds?',
      start: { find: 'contact', offset: 0.4, before: 400 }, len: 0.1, speed: 1,
      track: { kind: 'frontGap' },
      rail: [{ lift: 0, eye: 48, aim: 1.2, dist: 58, fov: 44, yawAdd: 0.9 }],
    },

    // ---- a melee thirty seconds in ----------------------------------------------------
    {
      id: 'melee-eye', scene: 'field',
      desc: 'Thirty seconds into the melee, inside the seam',
      start: { find: 'melee', n: 200, offset: 30, before: 400 }, len: 0.1, speed: 1,
      track: { kind: 'contact' },
      rail: [{ lift: 0, eye: 2.2, aim: 1.6, dist: 28, fov: 40, yawAdd: 0.9 }],
    },
    {
      // The rectangle-grinding-a-rectangle shot.
      id: 'melee-top', scene: 'field',
      desc: 'Thirty seconds in, from 52 m up — is it still two rectangles?',
      start: { find: 'melee', n: 200, offset: 30.4, before: 400 }, len: 0.1, speed: 1,
      track: { kind: 'contact' },
      rail: [{ lift: 0, eye: 52, aim: 1.2, dist: 62, fov: 44, yawAdd: 0.9 }],
    },
  ],
};
