/**
 * Pass three: four frames that make the two highest-severity findings unmistakable.
 *
 * Pass two proved the faults and photographed them badly. `r2-in-350` put the eye five metres
 * from the Theatre of Pompey's wall and came back as a 1920 x 1080 photograph of ashlar, which
 * is true and unreadable. The fix is not a different place, it is a longer standoff: park the
 * eye in the one enclosed stretch of the Via Lata and let the blocking mass sit at the end of
 * the street where a person would actually meet it.
 *
 * All four are on Rome, `hour` 8.2, and all four are aimed off the walk table in
 * `tools/scratch/judge-ground/rome-58bc584.json` — the eye is always at a station the probe
 * reports clear, and the *focus* is deliberately inside the monument, because the monument is
 * the subject.
 *
 * Reminder of the arithmetic, which pass one got wrong: the eye sits `dist` metres outboard of
 * the focus with `yaw: 'in'`, and `dist` metres *inboard* of it with `yaw: 'out'`.
 */
export default {
  id: 'judge-city-eye3',
  title: 'The city at eye level, pass three — the blocked axis, framed properly',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'rome': {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },

  shots: [
    {
      id: 'r3-pompey', scene: 'rome',
      // Eye at 290 m in — the one stretch of the axis with frontage 11 m left and 10 m right,
      // i.e. the only place on the walk that measures as a street. Focus 110 m further on, which
      // is inside the Theatre of Pompey, because that is what closes the street.
      desc: 'Rome: standing in the one enclosed stretch of the Via Lata, looking at the Theatre of Pompey that closes it 110 m on.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -400, eye: 1.75, aim: 14, dist: 110, fov: 40, yaw: 'in' }],
    },
    {
      id: 'r3-enclosed', scene: 'rome',
      desc: 'Rome: the same spot, turned across the street — the 20 m gap that is the best enclosure in the city.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -300, eye: 1.75, aim: 1.55, dist: 10, fov: 46, yaw: 'in', yawAdd: 1.5708 }],
    },
    {
      id: 'r3-neronis', scene: 'rome',
      // Eye at 180 m in (frontage 39 m left, 24 m right), focus 60 m on, inside the Baths of Nero.
      desc: 'Rome: 180 m in, looking at the Baths of Nero, which close the axis from 220 to 240 m.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -240, eye: 1.75, aim: 10, dist: 60, fov: 42, yaw: 'in' }],
    },
    {
      id: 'r3-gate-inside', scene: 'rome',
      // The defender's frame, and the one the player is looking at while the ram works: eye 80 m
      // inside the wall on the road, looking back out at the Porta Flaminia.
      desc: 'Rome: 80 m inside the wall on the Via Lata, looking back at the Porta Flaminia.',
      start: 16, len: 0.1, speed: 1,
      track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 8, dist: 40, fov: 42, yaw: 'out' }],
    },
  ],
};
