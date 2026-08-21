# The shot-script format

A **film** is a JavaScript module that default-exports one object. `tools/film.mjs` reads it,
validates it, and shoots it out of the live simulation: cameras on rails, pushes in and out,
cuts against events, slow motion, freeze frames, and staged setups.

```
node tools/film.mjs tools/shots/aurelian-gate.shot.mjs --check    # validate + print the plan
node tools/film.mjs tools/shots/aurelian-gate.shot.mjs            # shoot it
node tools/film.mjs --vocabulary                                  # every field, printed
```

**You do not need to read the runner to write a shot.** Everything is below, `--vocabulary`
prints the same tables from the code, and `--check` resolves a script into a frame-by-frame
plan without launching a browser. A validation failure names the shot, the field, what you gave
and what is accepted.

Three worked examples live in `tools/shots/` and each one is annotated with why its numbers are
what they are:

| script | what it is for |
|---|---|
| [`aurelian-gate.shot.mjs`](../../tools/shots/aurelian-gate.shot.mjs) | Rome's assault. A Catmull-Rom crane, two shots cut against events, a following camera on the ram, and a speed ramp into a third speed as its crew is shot off the road. Its header carries the measurement that rewrote it: **the gate is never struck at quality `ultra` on this tree**, and the cue refused rather than shooting an empty climax. |
| [`pydna-line.shot.mjs`](../../tools/shots/pydna-line.shot.mjs) | A field battle. A camera that tracks a moving cavalry unit, a cut on first contact, and a 3× time-lapse of the whole engagement. |
| [`carthage-elephants.shot.mjs`](../../tools/shots/carthage-elephants.shot.mjs) | Two scenes in one film, a **staged** order of battle, a freeze frame with the camera still moving, and an end card. |

---

## The shape of a film

```js
export default {
  id: 'aurelian-gate',              // kebab-case; it names the output directory
  title: 'The Aurelian Wall',
  width: 1920, height: 1080,        // default 1920x1080
  quality: 'ultra',                 // low | medium | high | ultra

  scenes: {                         // one page load each
    'rome-assault': {
      map: 'campus-martius',        // campus-martius | carthage | pydna
      scenario: 'assault',          // field | assault  (assault needs a map with a city)
      enemy: 'juthungi',            // juthungi | carthage
      hour: 14.3,                   // 4..21, SkySystem's own range
      seed: 4265438264,             // REQUIRED. There is no default.
      unitSize: 'ultra',            // small | normal | large | ultra | extreme
      difficulty: 'hard',
      weather: 'clear',             // optional: clear | overcast | rain
      armies: { /* … */ },          // optional, and it makes the film STAGED
    },
  },

  shots: [ /* the cut, in order */ ],
};
```

A **scene is a page load.** Everything in it is fixed before `Engine` is constructed, so two
shots on different scenes cannot share one. Everything in a scene except `weather` reaches the
app inside a `?battle=` token, because that is the only channel a seed travels on.

**`seed` is required and has no default.** A film without a pinned seed is not reproducible, and
a default is a decision nobody wrote down. `4265438264` is `DEFAULT_CONFIG.seed` — the shipped
battle, and the one every measurement in `docs/` was taken from.

---

## The shape of a shot

```js
{
  id: 'ram-push',
  scene: 'rome-assault',
  desc: 'One take: the ram at the Porta Flaminia, and the slow push in.',

  start: 62,                        // sim seconds — or { find: …, offset: … }
  len: 7,                           // FOOTAGE seconds. This is the length on screen.
  speed: 1,                         // sim seconds per footage second. 0 = freeze.
  motion: 'hold',                   // hold | substep    (see "Slow motion")
  interp: 'linear',                 // linear | catmull

  track: { kind: 'gate' },          // what the camera looks at
  rail: [ /* keys */ ],             // where the camera is, over time

  stage: [ /* actions before the camera rolls */ ],

  caption: { text: 'THE AURELIAN WALL', sub: 'Rome, 271 AD', in: 0.14, out: 0.9 },
  fadeIn: 0, fadeOut: 0.5,          // seconds
  endcard: { title: 'TOTAL CLAUDE', tagline: '…', url: '…' },
}
```

`len` is **footage** seconds and `speed` says how much battle each of them consumes. A shot at
`len: 6, speed: 3` is six seconds on screen and eighteen seconds of battle. A shot at
`len: 4, speed: 0.25` is four seconds on screen and one second of battle.

### `start` — when

A number is a sim time. An object cuts against an **event**:

```js
start: { find: 'gateOpen', offset: -2, before: 400 }
```

— "two seconds before the leaves give way, and give up looking at t+400". The runner resolves
this with a **scouting pass**: it runs the battle forward on the same fixed 1/30 grid with the
rasterisation skipped, notes the tick the predicate first holds on, then reloads the page and
runs the capture. A simulation can only be fast-forwarded, never rewound, so the cost of a cue
is one extra run of that battle. All of a scene's cues are scouted in one load, and one
predicate is resolved once however many shots share it.

This is the difference between a film that survives a change and one that does not. The trailer
had `at: [210, 215]` written down for its gate beat; a roster change that moved the twenty-sixth
blow by three seconds would have emptied the shot with nothing to say so.

| `find` | arguments | fires on |
|---|---|---|
| `contact` | — | the first tick anybody is in melee |
| `melee` | `n` | at least `n` men in melee |
| `gateBlow` | `nth` | the ram's `nth` blow |
| `gateOpen` | — | the gate leaves give way (or, on a circuit whose gate starts open, the breach) |
| `climbing` | `n` | at least `n` men on ladders or ramps |
| `routing` | `n` | at least `n` men broken |
| `corpses` | `n` | at least `n` dead |

If the predicate never fires by `before`, the run fails and says how far it got. It does not
quietly shoot the wrong second.

### `track` — what the camera looks at

**Name a thing. Never hand-place a camera.** This is the single most important convention in
this project's visual tooling and it is written down in `docs/tech/TOOLING.md` because it was
paid for: a shot with a fixed focus ended up in the corner of its own frame with ninety per cent
grass in it as soon as the line moved.

| `kind` | frame | needs | resolves to |
|---|---|---|---|
| `world` | plain | `x`, `z` | a fixed world point. The escape hatch, and the only anchor that can go stale. |
| `bay` | oriented | `k`, `subject?` | a garrison bay of the curtain, `k` bays from the gate bay. `subject: 'gate'` re-centres on the gate itself — which is *not* at the centre of its own bay, because the road decides where it is. |
| `gate` | oriented | — | shorthand for `{ kind: 'bay', k: 0, subject: 'gate' }` |
| `unitType` | facing | `id` | the largest surviving unit of a roster type, e.g. `war-elephants` |
| `unitClass` | facing | `faction`, `cls`, `pick?` | the largest, or `pick: 'frontmost'`, unit of a class. Faction 0 is Rome. |
| `cavalryUnit` | facing | — | the largest surviving cavalry unit on either side |
| `frontGap` | plain | — | the midpoint of the two front **lines** — not of the two hosts, whose centroids sit tens of metres behind where the lines are about to touch |
| `contact` | plain | — | the densest 40 m cell of men actually in melee. Also yields an `axis`. |
| `corpses` | plain | — | the densest 40 m cell of the dead |

The **frame** decides which rail offsets the anchor understands:

- **oriented** — has an outward normal and a run. `stand` (metres out along the normal),
  `along` (metres down the run), and `yaw: 'in' | 'out' | 'along'`.
- **facing** — has a heading. `along` slides down the subject's own frontage.
- **plain** — a point. `dx` / `dz` only.

Everything accepts `dx` / `dz`, applied last, in world axes.

```js
track: { kind: 'cavalryUnit', mode: 'follow', lag: 0.45 }
```

`mode: 'pin'` (the default) resolves the anchor once, on the shot's first frame, and freezes it.
`mode: 'follow'` re-resolves it every frame, so the camera rides a moving subject. `lag` is
seconds of critically-damped smoothing over the resolved positions, and it is not optional in
practice: a unit's centroid jumps whenever a file dies, and an unfiltered follow twitches.

The filter is computed by the runner from the resolved positions and the frame index, so it is a
pure function of the capture. Nothing about it reads the wall clock and a re-shoot reproduces it
exactly.

### `rail` — where the camera is

A rail is a list of **stations**. Each names the camera the way a photographer would, not the
way `RTSCamera` does:

```js
rail: [
  { at: 0, lift: 0, stand: 10, eye: 11,  aim: 3.8, dist: 46, fov: 34, yaw: 'in', yawAdd: -0.98 },
  { at: 1, lift: 0, stand: 3,  eye: 6.0, aim: 3.4, dist: 30, fov: 32,            yawAdd: -0.44 },
]
```

| field | unit | what it is |
|---|---|---|
| `at` | 0..1 | where this key sits in the shot. Must ascend; the first is 0 and the last is 1. |
| `ease` | name | the curve **into** this key. Default `smoothstep`. |
| `lift` | datum | the ground surface heights are measured from — see below |
| `stand` | m | out along the anchor's outward normal (oriented anchors) |
| `along` | m | along the anchor's run, or down a unit's frontage |
| `dx`, `dz` | m | world offsets from the anchor |
| `eye` | m | eye height above the datum |
| `aim` | m | height of the look-at point above the datum |
| `dist` | m | horizontal standoff from the look-at point to the eye |
| `fov` | deg | vertical field of view. **This is the lens.** 29–34 is long, 45–55 is wide. |
| `yaw` | — | base heading: `'in'`, `'out'`, `'along'`, or a number of radians. Must be **constant** across a shot. |
| `yawAdd` | rad | added to the base heading. This is where a pan lives. |
| `zoom` | 0..1 | `RTSCamera`'s own scalar, for a strategic overview where its coupling is right. Mutually exclusive with `eye`/`aim`/`dist`/`fov`. |

`eye`, `aim`, `dist` and `fov` travel together: a key with some of them and not the others has
no camera, and the validator says so.

**Why not `zoom`.** `RTSCamera`'s `zoom` is one scalar from which the rig derives orbit radius
*and* pitch *and* field of view at once, and then `place()` refuses to let the eye sit closer to
the ground than `lerp(1.7, 22, smoothstep(zoom))`. So "close to the men" and "far enough back to
see the wall" are the same dial. Three of the first trailer pass's siege frames came back as
1080p photographs of brick because of it. Naming eye height, aim height, standoff and focal
length separately is the fix, and the runner bypasses the four curves for the duration of a
frame and puts them back on the next one.

**`lift` is a named datum, and it matters more than it looks.** `eye: 1.3` with `lift: 'crest'`
is 1.3 m above the crest of *this bay of this wall*. Write the same shot in absolute metres and
it goes stale the day the curtain is re-cut.

| `lift` | datum |
|---|---|
| a number | that many metres above the terrain under the focus |
| `'walk'`, `'walk+2'`, `'walk-1.5'` | the bay's wall-walk, plus an offset |
| `'crest'`, `'crest+1'` | the bay's crest, plus an offset |

The **base** may not change inside one shot — a camera that changed which surface it measured
from mid-move would jump by the height of a wall — but the offset interpolates like any other
number.

**`interp`.** `'linear'` (the default) is piecewise: the runner finds the segment and eases
inside it with the ending key's curve. That is C⁰ and not C¹, so a three-key rail has a visible
change of velocity at the middle key — sometimes exactly what a beat wants (arrive, hold, leave)
and sometimes a bump. `'catmull'` runs one uniform Catmull-Rom spline through every station
instead, with the ends duplicated so the curve starts and stops on the first and last key rather
than overshooting them, and eases the whole move end to end. Use it for a crane: three or four
stations, one continuous glide. It wants at least three keys; with two it is a straight line and
`'linear'` says so honestly.

### `speed` — time scaling

`speed` is **simulation seconds per second of footage**.

```js
speed: 1                                   // real time
speed: 3                                   // 3x. Eighteen seconds of battle in six of film.
speed: 0.25                                // quarter speed
speed: 0                                   // freeze: the camera moves, the battle does not
speed: [ { at: 0, v: 1 }, { at: 0.42, v: 0.25 }, { at: 0.7, v: 0.25 }, { at: 1, v: 1 } ]
```

The mechanism, and it is the reason a determinism hash cannot move:

- **`speed >= 1`** fires that many 1/30 s ticks between photographs. The extra ticks run with
  `{ render: false }`, which skips only the submit — `Engine.advance` documents it and
  `qa-determinism` asserts it as bit-identical. It is the *same* battle with two frames in three
  not photographed.
- **`speed < 1`** renders a frame with `Time.paused` set. `beginFrame` then returns zero steps
  and hands every visual system a `scaledDt` of zero, while `rig.update` still gets the real
  frame delta. The accumulator is untouched, so a 0.25× shot fires exactly the ticks a 1× shot
  of the same window would have fired, in the same order. The picture is **step-printed**, the
  way an optical printer does slow motion: the men's animation phase is `time.simTime` and their
  positions are interpolated on `time.alpha`, and neither moves on a paused frame.
- **`speed: 0`** is the limit of that: no tick at all for the whole shot.
- A **ramp** is an accumulator over the same two mechanisms, so ticks still land on whole 1/30 s
  boundaries and `simTime` at every frame is an exact multiple of 1/30. The runner asserts that
  on every frame against the plan.

**`motion: 'substep'`** is the other slow-motion mechanism and it is opt-in. Instead of pausing,
it runs `advance(1/(30n), 1000/(30n))` per output frame, which ticks on every *n*th call and
interpolates the men's positions in between — smoother, at the cost of handing every `update` a
different `dt` from the 1× pass.

**Measured, that changes the battle.** `tools/scratch/vs-substep.mjs`, three loads of the Rome
assault at seed 4265438264, quality ultra, same total elapsed time, `{ render: false }`, hashed
with the same FNV-1a over exact float bits `qa-determinism.mjs` uses:

```
  hold    x1   t+40.0000   2,839 alive   988b8f88
  substep x2   t+39.9667   2,840 alive   653fb292
  hold    x1   t+40.0000   2,839 alive   988b8f88   <- control, re-run last
```

The control agrees bit for bit, so the divergence is the step size and not the machine. The
sub-stepped arm even lands **one tick short** at the same total elapsed time — 39.9667 s against
40.0000 s — because the accumulator arithmetic is not associative across 2,400 additions of
1/60 the way it is across 1,200 of 1/30. `Engine.advance`'s own comment records the same
phenomenon in the other direction: `advance(dt, 166)` and an exactly-five-tick
`advance(dt, 1000/6)` both diverge from `advance(dt, 1000/60)` at t+30 and stay diverged,
because how many ticks share a frame reaches the simulation.

So `substep` produces a *different* battle from the same seed, and `hold` does not. Only reach
for it if the step-print is visibly wrong for a beat, and know that the shots either side of it
are no longer the same footage. `motion: 'substep'` also requires one constant `speed` of the
form 1/n — a ramp has no single sub-step count, and the validator refuses rather than guessing
one.

The animation is at 30 Hz either way — `UnitRenderSystem` drives its clip phase off
`time.simTime` — so `substep` buys interpolated positions and nothing else. That is the honest
reason `hold` is the default rather than a compromise.

### `stage` — staged setups

A shot may arrange the world before the camera rolls. Every action is recorded in `film.json`,
and any film with a battle-touching one is stamped `emergent: false`.

| `do` | arguments | touches the battle? |
|---|---|---|
| `shakeScale` | `value` | no — `RTSCamera.shakeScale`, default 0.35 |
| `shake` | `amplitude`, `decay?` | no — one camera kick, now |
| `weather` | `kind` | yes — `clear` / `overcast` / `rain`, applied live and asserted |
| `rout` | `unit` (an anchor spec) | **yes** — breaks a unit |

Most staging is not here at all. The map, the scenario, the opposing faction, the seed, the hour
and **the order of battle** are *scene* fields, because they are fixed before `Engine` exists.
`scenes.*.armies` takes any of `BattleConfig`'s composition fields — `rome`, `juthungi`,
`carthage`, `siegeRome`, `siegeJuthungi`, `siegeCarthage`, `siegeRomanTrain` — and that is how a
film places units: choose the army, let the scenario deploy it, let the seed make it repeatable.

A custom `armies` block counts as staging as firmly as a `rout` does, and the scene is named in
`stagedScenes`. "The elephants are in this shot because I put four of them in the army" is
exactly the kind of thing a reader would want to have been told.

### Captions, fades, end cards

Drawn as DOM over the canvas, so they cost the renderer nothing and every font on the machine is
available. `--nooverlay` shoots clean plates instead.

```js
caption: { text: 'THE AURELIAN WALL', sub: 'Rome, 271 AD', in: 0.14, out: 0.9 },
fadeIn: 0.4, fadeOut: 0.5,       // seconds
endcard: { title: 'TOTAL CLAUDE', tagline: 'ONE BROWSER TAB', url: 'total-claude.vercel.app' },
```

`in` and `out` are fractions of the shot, with a 0.1 crossfade either side. The first shot of a
cut fades up from black over 0.8 s unless it names its own `fadeIn` — **including `fadeIn: 0`,
which means no fade and not "unset"**. That distinction was a bug until `war-machine` hit it; see
[`TRAILER-2.md`](TRAILER-2.md). Everything else is a hard cut, because the brief is cuts on action
and a dissolve between two moving cameras reads as a smear.

---

## Reproducibility

**The same script on the same working tree produces the same frames.** That is a requirement,
not an aspiration, and here is everything that makes it true:

1. **The seed is explicit and required.** It reaches the app through `?battle=`.
2. **Nothing reads the wall clock.** One captured frame is one `engine.advance(1/30, 1000/30)`
   — the same `Engine.frame()` the rAF loop calls — with the rAF loop stopped and the clock
   driven by the capture. Playback at 30 fps is real time.
3. **The clock is asserted on every frame** against the plan, to 1 µs. A battle that has stopped
   photographs perfectly; this project has shipped one that stopped for sixteen minutes.
4. **Cues are scouted on the same grid** with `{ render: false }`, never with `fastForward`,
   whose 1000/60 step is a measurably different battle.
5. **Anchors are resolved from the live world, not written down.**
6. **The follow filter is a pure function** of the resolved positions and the frame index.
7. **Provenance is stamped from the working tree, not from `HEAD`.**

That last one is a deliberate departure. `tools/shoot.mjs` stamps a pass with
`git rev-parse HEAD:src`, and `docs/HANDOFF.md` records that as an open defect: Vite serves files
from disk, so a frame taken with an uncommitted edit is labelled with the *previous* commit —
and the before/after workflow that stamp exists to protect produces two arms labelled
identically. `film.json` instead carries **`srcHash`**, a content hash of `src/` exactly as it
sits on disk, alongside `commit`, `srcTree` and the list of files that make them disagree. The
runner prints a warning when the tree is dirty, and refuses to merge a re-shoot into a directory
whose `srcHash` differs.

### What is *not* reproducible across machines

Pixels. The frames come out of a real GPU through ANGLE-on-Metal, and a driver revision moves
them. What is reproducible is the **simulation**: same seed, same schedule, same anchors, same
camera positions, which is what `film.json` records per frame and what a re-shoot is checked
against.

---

## Output

Everything lands in `/tmp/tc-video-studio/<film id>/`, which carries a `.metadata_never_index`
marker from the moment it is created — Spotlight indexing a tree of agent frames once took this
machine down at load 20 with zero node processes running.

```
/tmp/tc-video-studio/aurelian-gate/
  frames/<shot>-NNNNN.jpg     one JPEG per output frame, quality 94
  cut.json                    the ordered file list, which is the cut
  film.json                   the manifest: provenance, per-frame stats, staging
  aurelian-gate.webm          VP8, 1600x900
```

`film.json` records, per frame: sim time, tick count, head counts by state, corpses, draw calls,
eye position, field of view, sun angle and sun elevation. Sun angle is there because it is the
number that decided the trailer's opening beat — inside about 45 degrees of a low sun every
surface goes to one flat cream, and the first pass came back at 14 degrees off an 8-degree sun
and read as a lighting fault rather than as dawn. **If a shot looks washed out, read `sunAngle`
before re-lighting anything.**

The encoder is VP8, because Playwright's bundled ffmpeg is the only one on this machine and it
carries `libvpx` and nothing else. That is for looking at. A film that needs to *ship* goes
through `tools/scratch/trailer-encode.mjs` (VP9 + Opus) or `trailer-mp4-encode.mjs` (H.264 +
AAC), which drive WebCodecs inside a browser page and mux with `webm-muxer` / `mp4-muxer`; both
are pure functions of a frame list and take this tool's `cut.json` unchanged.

**There is no sound.** The mixer schedules against `AudioContext.currentTime`, so a capture that
steps two thousand frames in ninety seconds of wall clock would pile the whole film into ninety
seconds of nothing. The trailer solved that with a second, wall-clock-paced pass over the same
fixed grid (`tools/scratch/trailer-audio-pass.mjs`). A shot script has no `audio` field because
half of that would be worse than none of it; when it arrives it will be a second runner over
this same plan, not a change to the format.

---

## What has been shot with it

Three films, all at 1920×1080, quality `ultra`, seed 4265438264, on `e/tools/video-studio`
against `srcHash 60ae7aa6eff0` (src identical to `5f9030e`). Each is a WebM at 1600×900 plus
its `film.json` and four poster frames; the JPEG sequences were deleted after encoding, because
re-running the script reproduces them — which is the point.

| film | shots | frames | length | webm |
|---|---:|---:|---:|---:|
| `aurelian-gate` | 5 | 795 | 26.50 s | 5.92 MB |
| `pydna-line` | 4 | 660 | 22.00 s | 5.74 MB |
| `carthage-elephants` | 4 | 498 | 16.60 s | 3.53 MB |

`/tmp/tc-video-studio/<film>/`, which carries a `.metadata_never_index` marker. They are build
output and are not committed, exactly as the trailer's own files are not.

**The reproducibility claim was exercised rather than asserted.** `aurelian-gate` was shot
twice, in two separate browser sessions with two separate page loads, on the same tree and with
three other agents' work on the machine in between. The second pass's
`the-foot` cue resolved to the same tick (`corpses ≥ 900` at t+143.7333 s), resolved the same
anchor to fifteen significant figures (`x 261.8454311247795, z 529.015789204259`, densest cell
155 men) and produced the same head counts (2,171 → 2,168 alive, +3 corpses). The merge guard
let the second record merge into the first because `srcHash` had not moved, and `film.json`
carries both passes.

---

## The runner's flags

```
--check           validate and print the plan; no browser, no server, no frames
--json[=path]     dump the resolved film as JSON
--vocabulary      print every anchor, rail field, staging action and finder
--stills          three frames a shot, to look at framing
--shots=a,b       shoot a subset; the cut is still rebuilt from everything on disk
--scenes=x,y      shoot only these scenes
--encode          encode the frames already on disk and stop
--noencode        capture only
--keepframes      do not wipe the frame directory first
--nooverlay       no captions, no end card, no fades — clean plates
--out=DIR         work directory (default /tmp/tc-video-studio)
--port=N          vite port (default 5209). NEVER 5173 — that is the owner's playtest server
--keep            leave the spawned vite running
--w= --h= --dpr=  override the frame size
--scale=W:H       encoder output scale (default 1600:900); --scale= for native
```

A partial re-shoot merges into the existing `film.json` **by shot id** and rebuilds the cut from
what is on disk, so `--shots=ram-push` into a finished film replaces one shot and keeps the rest
— unless the renderer changed underneath, in which case the merge is refused and nothing is
written.

The runner reuses a dev server already on its port and starts one otherwise, with `TC_NO_HMR=1`
and its own `TC_VITE_CACHE_DIR`. That last one is a worktree trap rather than a nicety: agent
worktrees symlink `node_modules` back to the main checkout, and Vite's default cache directory is
a path resolved through that symlink, so several agents on several branches otherwise share one
optimiser cache. The failure that produces is a page which loads perfectly while serving another
branch's modules.

---

## A GUI on top of this

The owner asked for the script format first and a GUI later, and the format was shaped for it.

**A script is data.** No functions anywhere — the validator refuses them outright, at every
depth — so a film round-trips through JSON losslessly. `--json` is the read path and
`film.mjs <film>.json` is the write path; both exist today.

**Everything an editor needs to draw a timeline is computed without a browser.** `planFilm()` in
`tools/lib/shot-format.mjs` resolves a film into per-shot frame counts, footage lengths, sim
durations, tick schedules and capture order. `railAt()` gives the camera parameters at any point
along a shot and `frameState()` turns those into an absolute eye position, given an anchor.

**The one thing an editor cannot do offline is resolve an anchor**, because that is a query
against a live battle. `tools/lib/shot-page.mjs` holds those queries and nothing else — it
computes no camera geometry at all — so a GUI's viewport is: run the page, call `__tc.anchor()`,
then use exactly the same Node-side maths the runner uses. That split is why the two can never
disagree.

What a GUI would still need from this side:

- **A scrub endpoint.** Today a frame is `apply → step → screenshot`, always forward. An editor
  wants `apply → render` at an arbitrary point with no tick, which is `speed: 0`'s mechanism
  generalised — small, and not written because nothing needed it yet.
- **A cheap preview tier.** `--quality=medium --w=960 --h=540` already works and is roughly four
  times faster; a GUI would want that as a mode rather than as flags.
- **Anchor discovery.** `__tc.anchor()` answers a spec; it cannot list what specs *would*
  resolve in this scene. A `__tc.anchors()` that enumerated the bays and the surviving unit types
  is a dozen lines and would turn the anchor field into a dropdown.
- **Per-frame thumbnails out of the existing capture** — `cut.json` is already an ordered file
  list, so a timeline filmstrip is a directory read.
