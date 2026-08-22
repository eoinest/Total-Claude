/**
 * Second run of the ground judge's pass-two cameras — the four the first run mis-aimed.
 *
 * Recorded because the mis-aims are themselves findings and the reader needs to know which
 * frame came from which camera. In `judge-lm2.shot.mjs`:
 *
 *  - `lm2-marcellus` (world 181/1277, dist 90, `yaw` 0) put the eye **inside the Porticus
 *    Octaviae**, whose box runs z 1177–1271. That is not a camera error so much as a
 *    measurement: at a man's height, ninety metres north of the Theatre of Marcellus is
 *    masonry.
 *  - `lm2-marcellus-water` (eye 30, dist 220, `yaw` 1.5708) came back inside the same mass.
 *  - `lm2-southedge` (`yaw` π, dist 62) landed **inside the Colosseum's arena** rather than
 *    beyond its south wall — which at least shows the cavea and the hypogeum are modelled.
 *
 * `yaw` 0 puts the eye NORTH of the focus, which is the attacker's side; π puts it south.
 *
 *   node tools/film.mjs tools/shots/judge-lm2b.shot.mjs --stills --nooverlay --noencode \
 *     --port=5977 --out=/tmp/tc-jg2/filmb
 */
export default {
  id: 'judge-lm2b',
  title: 'The landmark rework at a man’s height, second run — 6c975e8',
  width: 1920, height: 1080, quality: 'ultra',

  scenes: {
    rome: {
      map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
      hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear',
    },
  },

  shots: [
    {
      id: 'lm2b-marcellus-w', scene: 'rome',
      desc: 'The Theatre of Marcellus from the west across the Tiber. Its centre datum is '
        + '1.52 m and WATER_LEVEL is 5.0: three of its four corners are under the river.',
      start: 10, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 18, aim: 12, dist: 130, fov: 50, yaw: -1.5708 }],
    },
    {
      id: 'lm2b-marcellus-e', scene: 'rome',
      desc: 'The same from the east, at a man’s height.',
      start: 11, len: 0.1, speed: 1,
      track: { kind: 'world', x: 181, z: 1277 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 110, fov: 50, yaw: 1.5708 }],
    },
    {
      id: 'lm2b-southedge', scene: 'rome',
      desc: 'The +Z edge of the heightfield behind the Colosseum, from 120 m: the drawn stone '
        + 'reaches z 1394.5 against HALF_EXTENT 1400. Whether there is ground under it.',
      start: 12, len: 0.1, speed: 1,
      track: { kind: 'world', x: 664, z: 1340 },
      rail: [{ lift: 0, eye: 120, aim: 20, dist: 460, fov: 46, yaw: 0 }],
    },
    {
      id: 'lm2b-pantheon-front', scene: 'rome',
      desc: 'The Pantheon’s portico from 110 m on its own axis — the insula standing in its '
        + 'forecourt, which no overlap check can see because it does not overlap.',
      start: 13, len: 0.1, speed: 1,
      track: { kind: 'world', x: 94, z: 1008 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 115, fov: 46, yaw: 0 }],
    },
    {
      id: 'lm2b-forum', scene: 'rome',
      desc: 'The Forum Romanum from the north at a man’s height — the forum-valley complex '
        + 'from inside the space it is a complex about.',
      start: 14, len: 0.1, speed: 1,
      track: { kind: 'world', x: 410, z: 1246 },
      rail: [{ lift: 0, eye: 1.75, aim: 12, dist: 90, fov: 50, yaw: 0 }],
    },
    {
      id: 'lm2b-colosseum-200', scene: 'rome',
      desc: 'The Colosseum from 200 m at a man’s height — whether a 27 m attic still ends the '
        + 'skyline of its own quarter.',
      start: 15, len: 0.1, speed: 1,
      track: { kind: 'world', x: 664, z: 1333 },
      rail: [{ lift: 0, eye: 1.75, aim: 18, dist: 200, fov: 46, yaw: 0 }],
    },
  ],
};
