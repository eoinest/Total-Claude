/**
 * Pydna — the line, the charge, the crash.
 *
 * A field battle on the plain, and the script that exercises everything the wall cannot: a
 * camera that *tracks a moving unit*, a cut against the moment of contact rather than against
 * a clock, and a time-lapse that compresses half a minute of engagement into four seconds.
 *
 * What this script is here to prove:
 *   - `track.mode: 'follow'` with `lag` — the aim point re-resolves every frame against the
 *     largest surviving cavalry unit and is critically damped, so the camera rides the charge
 *     instead of being aimed at where it used to be.
 *   - `start: { find: 'contact', offset: -2 }` — open two seconds before the lines touch.
 *   - `speed: 3` — three simulation seconds per second of film, by firing three ticks between
 *     photographs. Bit-identical to the same window at speed 1; it is the *same* battle with
 *     two frames in three not photographed.
 *   - `interp: 'linear'` with three keys and different easings per segment: arrive, hold, leave.
 *
 * The opening beat looks *north*, from behind the Roman line at the host it is waiting for, and
 * that is a lighting decision rather than a compositional one. Two passes of the trailer's
 * equivalent came back as one flat cream wash with the men barely legible in it, at 14 degrees
 * off an 8-degree sun; turned around, the same dawn is a cross-light and the same men have
 * edges. `sunAngle` is in `film.json` per frame — check it before blaming the renderer.
 */
export default {
  id: 'pydna-line',
  title: 'Pydna — the line',
  width: 1920,
  height: 1080,
  quality: 'ultra',

  scenes: {
    'pydna-field': {
      map: 'pydna',
      scenario: 'field',
      enemy: 'juthungi',
      hour: 8.2,
      seed: 4265438264,
      unitSize: 'ultra',
      difficulty: 'hard',
    },
  },

  shots: [
    {
      /*
       * Tracking along the shield wall, on the line's own frontage.
       *
       * `along` on a unit anchor slides down the subject's *frontage* — perpendicular to its
       * facing — rather than along a world axis, so this is a dolly beside the line whichever
       * way the line happens to be drawn up. Write it in world metres with `dx`/`dz` and it
       * would be a diagonal the day somebody changes the deployment.
       */
      id: 'shieldwall',
      scene: 'pydna-field',
      desc: 'Dawn. Behind the Roman line, tracking along it, the enemy host beyond.',
      start: 4,
      len: 5,
      track: { kind: 'unitClass', faction: 0, cls: 'heavy-infantry', pick: 'frontmost' },
      rail: [
        { at: 0, along: -40, eye: 2.7, aim: 1.55, dist: 27, fov: 32, yawAdd: Math.PI - 0.34 },
        { at: 1, along: 32, eye: 2.5, aim: 1.50, dist: 21, fov: 32, yawAdd: Math.PI - 0.22 },
      ],
      caption: { text: 'PYDNA', sub: 'The plain, at first light', in: 0.14, out: 0.9 },
    },
    {
      /*
       * The crash, cut against the event.
       *
       * `frontGap` is the midpoint of the two front *lines*, not of the two hosts — a host's
       * centroid carries its reserves and its artillery and sits tens of metres behind where
       * the lines are about to touch. `find: 'contact'` is the first tick on which anybody is
       * in melee anywhere on the field, so `offset: -2` opens on the last two seconds of the
       * closing run whatever the deployment.
       *
       * Three keys with different easings: `easeIn` into the middle station so the push starts
       * from rest, `smootherstep` into the last so it settles rather than stops.
       */
      id: 'crash',
      scene: 'pydna-field',
      desc: 'The last fifty metres and the crash: the lines meet.',
      start: { find: 'contact', offset: -2, before: 200 },
      len: 6,
      track: { kind: 'frontGap' },
      rail: [
        { at: 0, eye: 15, aim: 2.4, dist: 96, fov: 32, yawAdd: 1.02 },
        { at: 0.45, eye: 13, aim: 2.2, dist: 80, fov: 32, yawAdd: 0.94, ease: 'easeIn' },
        { at: 1, eye: 11, aim: 2.0, dist: 62, fov: 32, yawAdd: 0.80, ease: 'smootherstep' },
      ],
    },
    {
      /*
       * The charge, and why the camera has to follow rather than be pointed.
       *
       * A cavalry wing at the gallop crosses about 9 m/s, so over a five-second shot the
       * subject moves forty-five metres — a third of the frame width at this standoff. A pinned
       * anchor would open on the horse and close on the grass it left. `mode: 'follow'`
       * re-resolves the anchor on every frame; `lag: 0.45` is a critically-damped filter over
       * the resolved positions, which is what stops the frame twitching each time the unit's
       * centroid jumps because a file died.
       *
       * The filter is computed in the runner from the resolved positions and the frame index,
       * so it is a pure function of the capture and a re-shoot reproduces it exactly. Nothing
       * about it reads the wall clock.
       */
      id: 'charge',
      scene: 'pydna-field',
      desc: 'The cavalry wing coming round the flank at the gallop, tracked.',
      start: { find: 'contact', offset: 5, before: 240 },
      len: 5,
      track: { kind: 'cavalryUnit', mode: 'follow', lag: 0.45 },
      rail: [
        { at: 0, eye: 8, aim: 2.0, dist: 58, fov: 32, yawAdd: 0.50 },
        { at: 1, eye: 5.6, aim: 1.8, dist: 38, fov: 30, yawAdd: 0.86, ease: 'easeOut' },
      ],
    },
    {
      /*
       * The whole engagement, at three times, from the flank.
       *
       * Two earlier framings of this beat failed in opposite directions in the trailer. At the
       * rig's own zoom 0.78 the pitch curve is 50 degrees down and eight thousand men render as
       * smudges on a map. Pulled back to a 500 m standoff with a long lens instead, the aerial
       * perspective at that range washed the field to one cream and the hosts stopped reading
       * as hosts. A camera on the flank at ninety metres, looking *down the length* of the
       * engagement, gets the whole frontage without the distance: the near end is two hundred
       * metres away and the far end recedes, which is what depth is for.
       *
       * `speed: 3` fires three ticks between photographs, so eighteen seconds of battle run in
       * six of film. The ticks are the same ticks and in the same order; two frames in three
       * are simply not photographed, which is why this cannot move a determinism hash.
       */
      id: 'the-field',
      scene: 'pydna-field',
      desc: 'From the flank at ninety metres, down the length of the whole engagement, at 3x.',
      start: { find: 'contact', offset: 16, before: 240 },
      len: 6,
      speed: 3,
      track: { kind: 'contact' },
      rail: [
        // The base heading is constant and the turn lives in `yawAdd`, which is what the
        // validator insists on: two absolute `yaw` numbers cannot be told apart from a shot
        // that meant to change frame of reference halfway through, and one of those is a bug.
        { at: 0, dx: 46, eye: 74, aim: 5, dist: 250, fov: 34, yaw: -Math.PI / 2, yawAdd: -0.22 },
        { at: 1, dx: 16, eye: 58, aim: 5, dist: 196, fov: 34, yawAdd: -0.08 },
      ],
      fadeOut: 0.6,
    },
  ],
};
