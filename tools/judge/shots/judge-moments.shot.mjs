/**
 * The four moments a siege is supposed to be *for*, framed by a camera rather than by a
 * unit anchor — which is the only fair way to grade whether they land. Cued on the events
 * themselves (`climbing`, `routing`, `contact`), so each shot finds its own moment.
 */
export default {
  id: 'judge-moments',
  title: 'The moments that matter',
  width: 1600,
  height: 900,
  quality: 'ultra',
  scenes: {
    'rome-storm': {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 10, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard',
    },
    'pydna-field': {
      map: 'pydna', scenario: 'field', enemy: 'juthungi',
      hour: 17, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard',
    },
  },
  shots: [
    {
      id: 'ladders-up',
      scene: 'rome-storm',
      desc: 'The ladders go up against the Muro Torto — the one moment that decides every Rome battle.',
      start: { find: 'climbing', n: 60, before: 200, offset: -2 },
      len: 6, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [
        { at: 0, stand: 58, along: -14, lift: 'walk', eye: 6, aim: -2, dist: 62, fov: 42, yaw: 'in' },
        { at: 1, stand: 26, along: 10, lift: 'walk', eye: 3, aim: -1, dist: 34, fov: 42, yaw: 'in', ease: 'smootherstep' },
      ],
    },
    {
      id: 'over-the-parapet',
      scene: 'rome-storm',
      desc: 'Men actually on the walkway, seen along the walk — is the lodgement legible?',
      start: { find: 'climbing', n: 140, before: 300, offset: 4 },
      len: 6, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [
        { at: 0, stand: 20, along: -40, lift: 'walk', eye: 7, aim: 1, dist: 40, fov: 46, yaw: 'along' },
        { at: 1, stand: 16, along: 26, lift: 'walk', eye: 5, aim: 1, dist: 32, fov: 46, yaw: 'along', ease: 'smootherstep' },
      ],
    },
    {
      id: 'the-break-in',
      scene: 'rome-storm',
      desc: 'The men who decide it: broken parties running INTO the city. Framed from inside, looking back at the wall.',
      start: { find: 'routing', n: 90, before: 400, offset: 8 },
      len: 6, speed: 1,
      track: { kind: 'bay', k: 4 },
      rail: [
        // High and outside, looking down over the parapet into the ground behind it. The first
        // attempt stood the eye 70-120 m *inside* at eye 14 and put it inside the Pincian —
        // the hill behind the Muro Torto rises above the wall's own footing, which is itself
        // worth knowing about the ground the break-in happens on.
        { at: 0, stand: 150, along: -20, lift: 'crest', eye: 95, aim: -34, dist: 210, fov: 40, yaw: 'in' },
        { at: 1, stand: 90, along: 10, lift: 'crest', eye: 62, aim: -26, dist: 150, fov: 40, yaw: 'in', ease: 'smootherstep' },
      ],
    },
    {
      id: 'the-clash',
      scene: 'pydna-field',
      desc: 'Two lines meeting on the Pierian plain — the control, on the map that works.',
      start: { find: 'melee', n: 400, before: 400, offset: 2 },
      len: 6, speed: 1,
      track: { kind: 'contact' },
      rail: [
        { at: 0, dx: 0, dz: -150, lift: 0, eye: 46, aim: 2, dist: 150, fov: 38 },
        { at: 1, dx: 0, dz: -70, lift: 0, eye: 16, aim: 2, dist: 76, fov: 38, ease: 'smootherstep' },
      ],
    },
  ],
};
