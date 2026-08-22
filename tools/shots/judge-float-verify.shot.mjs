/**
 * Verification, and the reason this file exists at all.
 *
 * `judge-city-eye3.shot.mjs` came back with what looked like **a monument standing in the air**
 * over the Campus Martius — a dark brick mass with column shafts dangling under it and nothing
 * beneath them. That would have been the most serious finding of the whole judging pass and it
 * would have been wrong.
 *
 * These four cameras exist to settle it before it was written down: two at eye level and two
 * lifted to 55–60 m over the same two monuments, from a standoff that guarantees the ground
 * under them is in frame. The answer is that nothing floats. The slabs are **portico roofs**,
 * and their columns are thin enough and far enough apart (12–15 m against a real 3–4 m
 * intercolumniation) that past about forty metres the supports stop resolving and the roof
 * reads as a plate hanging in the sky.
 *
 * That is still a fault — it raised G5's severity in `docs/CITY-GROUND-JUDGE.md` — but it is a
 * different fault with a different fix, and the difference cost one page load to establish.
 * **A judge that publishes the first reading of a strange frame is a judge that manufactures
 * findings.**
 */
export default {
  id: 'judge-verify-float',
  title: 'Verification: is anything standing in the air at bc2e0f2?',
  width: 1920, height: 1080, quality: 'ultra',
  scenes: { rome: { map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
    hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear' } },
  shots: [
    { id: 'v-pompey-eye', scene: 'rome', desc: 'Theatre of Pompey from 130 m north at eye level',
      start: 10, len: 0.1, speed: 1, track: { kind: 'world', x: 97, z: 802 },
      rail: [{ lift: 0, eye: 1.75, aim: 20, dist: 130, fov: 45, yaw: 0 }] },
    { id: 'v-pompey-low', scene: 'rome', desc: 'Theatre of Pompey from 60 m up, 170 m north',
      start: 12, len: 0.1, speed: 1, track: { kind: 'world', x: 97, z: 802 },
      rail: [{ lift: 0, eye: 60, aim: 12, dist: 170, fov: 42, yaw: 0 }] },
    { id: 'v-nero-eye', scene: 'rome', desc: 'Baths of Nero from 110 m north at eye level',
      start: 14, len: 0.1, speed: 1, track: { kind: 'world', x: 309, z: 951 },
      rail: [{ lift: 0, eye: 1.75, aim: 18, dist: 110, fov: 45, yaw: 0 }] },
    { id: 'v-nero-low', scene: 'rome', desc: 'Baths of Nero from 55 m up, 150 m north',
      start: 16, len: 0.1, speed: 1, track: { kind: 'world', x: 309, z: 951 },
      rail: [{ lift: 0, eye: 55, aim: 12, dist: 150, fov: 42, yaw: 0 }] },
  ],
};
