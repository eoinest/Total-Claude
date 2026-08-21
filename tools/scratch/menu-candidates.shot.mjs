/**
 * Framing candidates for the menu plates. Scratch — shot with `--stills` only.
 *
 * Every candidate is `speed: 0`, so no tick fires and every shot in a scene can share one
 * start time; the runner never has to rewind and one page load produces the whole contact
 * sheet for that map.
 *
 * The first pass came back with two lighting faults that `film.json` named outright:
 * Rome at `sunAngle 15.2` (inside the 45 deg cone where everything goes to one flat cream)
 * and Pydna at `168` (sun behind the camera, so no cross-light at all). Carthage at 69.5 was
 * the only one right. So the yaw sweeps below are chosen to land near 70-100 deg.
 */
const romeRail = (o) => [{ at: 0, lift: 0, yaw: 'in', fov: 34, ...o }, { at: 1, lift: 0, fov: 34, ...o }];

export default {
  id: 'menu-candidates',
  title: 'Menu plate candidates',
  width: 1600,
  height: 900,
  quality: 'ultra',

  scenes: {
    'rome-wall': {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 14.3, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard',
    },
    'carthage-wall': {
      map: 'carthage', scenario: 'assault', enemy: 'carthage',
      hour: 16.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard',
    },
    'pydna-plain': {
      map: 'pydna', scenario: 'field', enemy: 'juthungi',
      hour: 17, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard',
    },
  },

  shots: [
    // --- Rome: the same bay, four lenses, all with the sun swung broadside -------------
    {
      id: 'r1', scene: 'rome-wall', desc: 'oblique, wall receding right', start: 80, len: 0.4, speed: 0,
      track: { kind: 'bay', k: -3 },
      rail: romeRail({ along: -20, stand: 26, eye: 22, aim: 8, dist: 96, yawAdd: 0.62 }),
    },
    {
      id: 'r2', scene: 'rome-wall', desc: 'close on the escalade', start: 80, len: 0.4, speed: 0,
      track: { kind: 'bay', k: -3 },
      rail: romeRail({ along: -6, stand: 10, eye: 15, aim: 7, dist: 62, yawAdd: 0.80 }),
    },
    {
      id: 'r3', scene: 'rome-wall', desc: 'wide, host at the foot', start: 80, len: 0.4, speed: 0,
      track: { kind: 'bay', k: -3 },
      rail: romeRail({ along: -40, stand: 46, eye: 30, aim: 9, dist: 130, yawAdd: 0.48 }),
    },
    {
      id: 'r4', scene: 'rome-wall', desc: 'the gate, oblique', start: 80, len: 0.4, speed: 0,
      track: { kind: 'gate' },
      rail: romeRail({ stand: 40, eye: 24, aim: 8, dist: 105, yawAdd: 0.55 }),
    },
    {
      id: 'r5', scene: 'rome-wall', desc: 'oblique, further round', start: 80, len: 0.4, speed: 0,
      track: { kind: 'bay', k: -4 },
      rail: romeRail({ along: -14, stand: 22, eye: 26, aim: 8.5, dist: 112, yawAdd: 1.02 }),
    },

    // --- Carthage: lower and closer than the first pass ---------------------------------
    {
      id: 'c1', scene: 'carthage-wall', desc: 'wall + Byrsa, 70 m', start: 150, len: 0.4, speed: 0,
      track: { kind: 'gate' },
      rail: romeRail({ stand: 46, eye: 70, aim: 14, dist: 210, yawAdd: -0.30 }),
    },
    {
      id: 'c2', scene: 'carthage-wall', desc: 'wall + Byrsa, 46 m', start: 150, len: 0.4, speed: 0,
      track: { kind: 'gate' },
      rail: romeRail({ stand: 40, eye: 46, aim: 12, dist: 160, yawAdd: -0.22 }),
    },
    {
      id: 'c3', scene: 'carthage-wall', desc: 'towers docked, close', start: 150, len: 0.4, speed: 0,
      track: { kind: 'bay', k: 2 },
      rail: romeRail({ stand: 26, eye: 30, aim: 12, dist: 104, yawAdd: -0.44 }),
    },
    {
      id: 'c4', scene: 'carthage-wall', desc: 'oblique the other way', start: 150, len: 0.4, speed: 0,
      track: { kind: 'bay', k: -2 },
      rail: romeRail({ stand: 34, eye: 52, aim: 13, dist: 170, yawAdd: 0.34 }),
    },

    // --- Pydna: the two yaws that put the sun broadside ----------------------------------
    {
      id: 'p1', scene: 'pydna-plain', desc: 'lines, sun from the left', start: 74, len: 0.4, speed: 0,
      track: { kind: 'frontGap' },
      rail: [
        { at: 0, eye: 30, aim: 3, dist: 110, fov: 34, yawAdd: -1.15 },
        { at: 1, eye: 30, aim: 3, dist: 110, fov: 34, yawAdd: -1.15 },
      ],
    },
    {
      id: 'p2', scene: 'pydna-plain', desc: 'lines, sun from the right', start: 74, len: 0.4, speed: 0,
      track: { kind: 'frontGap' },
      rail: [
        { at: 0, eye: 30, aim: 3, dist: 110, fov: 34, yawAdd: 1.75 },
        { at: 1, eye: 30, aim: 3, dist: 110, fov: 34, yawAdd: 1.75 },
      ],
    },
    {
      id: 'p3', scene: 'pydna-plain', desc: 'down the Roman line', start: 74, len: 0.4, speed: 0,
      track: { kind: 'unitClass', faction: 0, cls: 'heavy-infantry', pick: 'frontmost' },
      rail: [
        { at: 0, along: -10, eye: 16, aim: 3, dist: 72, fov: 34, yawAdd: 2.20 },
        { at: 1, along: -10, eye: 16, aim: 3, dist: 72, fov: 34, yawAdd: 2.20 },
      ],
    },
    {
      id: 'p4', scene: 'pydna-plain', desc: 'higher, sun from the left, wider', start: 74, len: 0.4, speed: 0,
      track: { kind: 'frontGap' },
      rail: [
        { at: 0, eye: 44, aim: 3, dist: 165, fov: 34, yawAdd: -0.85 },
        { at: 1, eye: 44, aim: 3, dist: 165, fov: 34, yawAdd: -0.85 },
      ],
    },
  ],
};
