/**
 * The landmark rework, shot **before it commits**.
 *
 * `e/city/rome-landmarks` had nothing committed when this pass ran and about eight hundred
 * changed lines in its working tree. Rather than wait, its diff was taken read-only with
 * `git diff HEAD -- src docs`, applied to a scratch checkout at the same base, and shot from the
 * same eye as everything else in `docs/CITY-GROUND-JUDGE.md`. Nothing was written to that
 * branch and nothing here is a judgement on finished work.
 *
 * The reason for the hurry is in §5.2 of that document: the branch is authoring a per-monument
 * `draw` scale into twenty-two survey rows and keeping heights at 1:1, which turns one global
 * anisotropy into twenty-two hand-written ones — the form that is hardest to reverse. It is one
 * field away from the opposite outcome, and a note that arrives before the rows are written is
 * worth more than a finding that arrives after.
 *
 * Reproduce it with:
 *
 *   git -C <landmarks-worktree> diff HEAD -- src docs > /tmp/lm.patch
 *   git worktree add --detach /tmp/scratch bc2e0f2 && cd /tmp/scratch && git apply /tmp/lm.patch
 *   node tools/film.mjs tools/shots/judge-lm-wip.shot.mjs --stills --nooverlay --noencode --port=5903
 */
export default {
  id: 'judge-lm-wip',
  title: 'The landmark rework in progress, at a man’s height',
  width: 1920, height: 1080, quality: 'ultra',
  scenes: { rome: { map: 'campus-martius', scenario: 'assault', enemy: 'juthungi',
    hour: 8.2, seed: 4265438264, unitSize: 'ultra', difficulty: 'hard', weather: 'clear' } },
  shots: [
    { id: 'lm-pantheon', scene: 'rome', desc: 'The Pantheon at draw 0.445 — 37 x 26 m in plan at its full height',
      start: 10, len: 0.1, speed: 1, track: { kind: 'world', x: 102, z: 843 },
      rail: [{ lift: 0, eye: 1.75, aim: 14, dist: 60, fov: 50, yaw: 0 }] },
    { id: 'lm-mausoleum', scene: 'rome', desc: 'The Mausoleum of Augustus, which has no draw scale — true plan, true height',
      start: 12, len: 0.1, speed: 1, track: { kind: 'world', x: 79, z: 651 },
      rail: [{ lift: 0, eye: 1.75, aim: 22, dist: 60, fov: 50, yaw: 0 }] },
    { id: 'lm-in-30', scene: 'rome', desc: 'Thirty metres inside the Porta Flaminia',
      start: 14, len: 0.1, speed: 1, track: { kind: 'gate' },
      rail: [{ lift: 0, stand: -40, eye: 1.75, aim: 1.55, dist: 10, fov: 42, yaw: 'in' }] },
    { id: 'lm-campus', scene: 'rome', desc: 'The Campus Martius from 55 m, for comparison with kz35-campus-martius.jpg',
      start: 16, len: 0.1, speed: 1, track: { kind: 'world', x: 309, z: 951 },
      rail: [{ lift: 0, eye: 55, aim: 12, dist: 150, fov: 42, yaw: 0 }] },
  ],
};
