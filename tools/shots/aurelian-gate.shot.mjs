/**
 * The Aurelian Wall — the escalade, and the ram that never reached the gate.
 *
 * ## What this film is, and the finding that decided it
 *
 * It was written as the trailer's climax: the ram at the Porta Flaminia, the slow push in, and
 * the leaves giving way, cut against `find: 'gateOpen'`. **That shot does not exist any more at
 * the tier it was shot at.** The cue refused, which is the whole reason cues exist, and the
 * measurement behind the refusal is this — Campus Martius, assault, seed 4265438264, unit size
 * ultra, difficulty hard, no camera anywhere near it:
 *
 * ```
 *   quality      men     ram crew                       gate blows     gate opens
 *   ultra       3,074    dead at (68, 514) by t+100     0 to t+520     never
 *   medium      3,009    reaches the gate               26 by t+240    t+180..240
 * ```
 *
 * The gate stands at (72, 530). At `ultra` the ram crew is shot off the road **sixteen metres
 * short of the door** and the gate is never struck once in nearly nine minutes. At `medium` the
 * same seed puts 26 blows into it. The tier is not a graphics setting here: it fixes the
 * soldier pool, which fixes the fitted unit scale, which is a different battle — 3,074 men
 * against 3,009. `docs/video/README.md` describes the shipped trailer's `rome-ram-gate` beat at
 * quality `ultra` with the break at t+215, so this has moved since `6698e19`.
 *
 * Which leaves the honest film, and it is a better one than a re-shoot of the trailer would
 * have been: the host crosses, the ladders go up, the parapet holds, the ram is cut to pieces
 * on the road, and the assault dies at the foot of the wall. Measured at the same settings:
 *
 * ```
 *   t+20   68 climbing, 0 fighting, ram 55 m out
 *   t+30   contact — 145 fighting, 38 men across the parapet
 *   t+40   peak — 165 fighting, 137 across
 *   t+60   243 across, ram 33 m out with 30 of 32 crew
 *   t+80   ram 20 m out, 19 crew left
 *   t+100  crew dead, 694 bodies
 *   t+180  6 men still fighting anywhere on the wall. It is over.
 * ```
 *
 * ## What this script is here to prove, feature by feature
 *
 *   - `interp: 'catmull'` — a three-station rail that descends and closes in one glide.
 *   - `start: { find: 'climbing', n: 80 }` and `{ find: 'corpses', n: 900 }` — cut against
 *     what the battle does, not against a number somebody wrote down.
 *   - `track.mode: 'follow'` on the ram crew, which moves 40 m during its own shot.
 *   - a `speed` ramp into a third speed and out of it again, as the crew is cut down.
 *   - `stage: shakeScale` — a camera-only knob, so the impacts read.
 *
 * The hour is 14.3 because the assault wants a mid-afternoon cross-light on brick. Sun angle is
 * recorded per frame in `film.json`; if a shot looks washed out, read `sunAngle` before
 * re-lighting anything — inside about 45 degrees of a low sun every surface goes to one cream.
 */
export default {
  id: 'aurelian-gate',
  title: 'The Aurelian Wall — the assault',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'rome-assault': {
      map: 'campus-martius',
      scenario: 'assault',
      enemy: 'juthungi',
      hour: 14.3,
      // The shipped battle: `Rng.hashString('battle-271')`, which is `DEFAULT_CONFIG.seed`.
      // Every measurement in docs/ was taken from this one.
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
  },

  shots: [
    {
      id: 'approach',
      scene: 'rome-assault',
      desc: 'A descending crane: siege towers and ladders crossing open ground under artillery.',
      start: 15,
      len: 5,
      track: { kind: 'gate' },
      interp: 'catmull',
      // The middle key is the shipped trailer's `siege-approach` opening frame and the last is
      // its closing one, so this rail is a *crane added in front of* a framing that has already
      // been graded rather than a new one. That is the cheap way to extend proven material and
      // it is worth saying out loud: the two stations that decide whether the wall reads were
      // not invented here.
      rail: [
        { at: 0, lift: 0, stand: 86, eye: 36, aim: 8.5, dist: 206, fov: 33, yaw: 'in', yawAdd: -0.48 },
        { at: 0.5, stand: 74, eye: 27, aim: 7, dist: 178, fov: 32, yawAdd: -0.38 },
        { at: 1, stand: 62, eye: 19, aim: 6, dist: 138, fov: 32, yawAdd: -0.18, ease: 'smootherstep' },
      ],
      caption: { text: 'THE AURELIAN WALL', sub: 'Rome, 271 AD', in: 0.14, out: 0.9 },
    },
    {
      /*
       * The ladders, cut on the escalade rather than on a clock.
       *
       * 80 men on the rungs at once happens at about t+27 in this battle and will happen at a
       * different second in the next one; the cue is the event. `k: -3` is three bays north of
       * the gate bay, which is where the unfinished stretch is and therefore where the ladder
       * parties are sent.
       */
      id: 'escalade',
      scene: 'rome-assault',
      desc: 'Escalade against the unfinished stretch: men on the rungs, the garrison above them.',
      start: { find: 'climbing', n: 80, offset: -1, before: 200 },
      len: 5,
      track: { kind: 'bay', k: -3 },
      rail: [
        { at: 0, lift: 0, stand: 4, eye: 10, aim: 5.5, dist: 54, fov: 34, yaw: 'in', yawAdd: 0.58 },
        { at: 1, lift: 0, stand: 4, eye: 17, aim: 7.5, dist: 41, fov: 34, yawAdd: 0.34, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The crest from *outside*, at the height of the walk.
       *
       * Standing the camera on the wall-walk and looking along it is the composition this shot
       * wants and is not survivable: the run is 34 m and every fifth bay carries a covered
       * gallery or a tower chamber, so the lens ends up inside one and the frame is a
       * photograph of a doorway. Outside the face at crest height gets the embrasures, the men
       * in them and the ladder heads without putting the camera inside the masonry. `lift:
       * 'crest'` is what makes the heights below mean anything: `eye: 1.3` is 1.3 m above the
       * crest of *this* bay, not above sea level, so it cannot go stale when the curtain is
       * re-cut.
       */
      id: 'parapet',
      scene: 'rome-assault',
      desc: 'The crest from outside: the garrison in the embrasures, escaladers at the top.',
      start: 52,
      len: 4.5,
      track: { kind: 'bay', k: -3 },
      rail: [
        { at: 0, lift: 'crest', stand: 3, eye: 1.3, aim: -1.5, dist: 46, fov: 32, yaw: 'in', yawAdd: 1.06 },
        { at: 1, lift: 'crest', stand: 3, eye: 1.0, aim: -1.3, dist: 33, fov: 32, yawAdd: 0.86 },
      ],
    },
    {
      /*
       * The ram on the road, tracked, and the ramp into a third speed as its crew goes down.
       *
       * The subject moves about 0.7 m/s and loses two thirds of its men across this window, so
       * `mode: 'follow'` is not a flourish: a pinned anchor would open on the shed and close on
       * the stretch of road behind it. `lag: 0.5` is a critically-damped filter over the
       * resolved positions, which is what stops the frame twitching each time the crew's
       * centroid jumps because a man died.
       *
       * The ramp is the point of the shot. It runs at speed 1 into the worst of it, drops to a
       * third and comes back — which at 30 fps means the middle spends three output frames on
       * each simulation tick. The mechanism is frame-doubling under `Time.paused`, so the ticks
       * either side of the ramp are the *same ticks* a 1x pass would have fired, in the same
       * order: the sim is bit-identical to the film without the ramp in it, and the picture is
       * step-printed the way an optical printer does it.
       */
      id: 'the-ram',
      scene: 'rome-assault',
      desc: 'The ram grinding up the road under the parapet, and its crew being shot off it.',
      start: 62,
      len: 7,
      speed: [
        { at: 0, v: 1 },
        { at: 0.28, v: 1 },
        { at: 0.40, v: 0.34 },
        { at: 0.72, v: 0.34 },
        { at: 1, v: 1 },
      ],
      track: { kind: 'unitType', id: 'ram-crew', mode: 'follow', lag: 0.5 },
      // Camera only. `RTSCamera.shakeScale` defaults to 0.35 because a battle fires
      // `cameraShake` continuously and they never cancel, only ever raise — but this shot is
      // about what is landing on the shed, so it is opened up for the duration.
      stage: [{ do: 'shakeScale', value: 0.85 }],
      rail: [
        { at: 0, eye: 9, aim: 3.2, dist: 42, fov: 34, yawAdd: -0.94 },
        { at: 1, eye: 5.4, aim: 2.8, dist: 26, fov: 31, yawAdd: -0.52, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The end of it, and the shot the trailer could not have.
       *
       * `corpses` is the densest forty-metre cell of the dead, which by nine hundred bodies is
       * the ground under the ladders. Half speed, so the pan is a survey rather than a move,
       * and the sim still runs — the routed are still streaming away behind it.
       */
      id: 'the-foot',
      scene: 'rome-assault',
      desc: 'The foot of the wall, where the assault died. Half speed.',
      start: { find: 'corpses', n: 900, offset: 1, before: 300 },
      len: 5,
      speed: 0.5,
      track: { kind: 'corpses' },
      rail: [
        { at: 0, eye: 13, aim: 2.2, dist: 58, fov: 33, yawAdd: 0.30 },
        { at: 1, eye: 9, aim: 2.0, dist: 44, fov: 31, yawAdd: -0.16, ease: 'smootherstep' },
      ],
      fadeOut: 0.7,
    },
  ],
};
