/**
 * Third run: identify the artefact the first ground pass could not.
 *
 * `docs/CITY-GROUND-JUDGE.md` §5.2 recorded, of the landmark branch's working tree, *"grey
 * conical mounds with paving draped over them, near the old Pantheon coordinates, which I could
 * not diagnose and am not calling a fault."* It is still there on the committed branch and it is
 * visible from four of this pass's cameras. These frames are aimed at it directly.
 */
export default {
  id: 'judge-lm2c',
  title: 'The unexplained artefact, aimed at directly — 6c975e8',
  width: 1920, height: 1080, quality: 'ultra',
  scenes: {
    rome: {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },
  shots: [
    {
      id: 'lm2c-marcellus-air', scene: 'rome',
      desc: 'The Theatre of Marcellus from 70 m directly north — is the white spiked mass its cavea?',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 70, aim: 10, dist: 120, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2c-marcellus-close', scene: 'rome',
      desc: 'The same from 45 m at a man’s height, from the north-east.',
      start: 11, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 1.75, aim: 10, dist: 45, fov: 55, yaw: 0.7854 }],
    },
    {
      id: 'lm2c-pompey', scene: 'rome',
      desc: 'The Theatre of Pompey at (-27, 1142) — measured 36 m tall on a 54 m drawn footprint, '
        + 'h/w 0.66 against a real 0.19, which is the worst residual anisotropy on the map.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'world', x: -27, z: 1142 },
      rail: [{ lift: 0, eye: 1.75, aim: 16, dist: 100, fov: 50, yaw: 0 }],
    },
  ],
};
