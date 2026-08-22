# Rome, as assembled — the renders, and where every camera stood

Pictures of the city on `e/city/rome-assembled`, the first tree in which Rome's re-projected
frame (`KZ` 0.222 → 0.35), its re-surveyed Tiber (451 stations, polyline + signed distance field)
and its re-placed landmarks (`resolveOverlaps` deleted, every monument on its survey row) all
exist together.

**These are photographs of the city, not probe illustrations.** Nothing here is a diagnostic
overlay. If a fault is visible in one of these frames it is visible because the city has it.

## Where the files are

```
screenshots/rome-assembled/rome-assembled/stills/<shot-id>-00000.jpg
```

Absolute, on this worktree:

```
/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-aa1ea2e71531566ea/screenshots/rome-assembled/rome-assembled/stills/
```

1920 × 1080 JPEG q94, `quality: ultra`. Three frames per shot (`-00000`, `-00001`, `-00002`) —
they are the same picture, so **use `-00000`**. `screenshots/**` is gitignored by design; these
are build output and are not committed. `stills.json` beside them carries per-frame provenance:
eye position, FOV, `sunAngle`, `sunElev`, draw calls, head counts.

To regenerate the whole set, one browser slot, one page load:

```
node tools/film.mjs tools/shots/rome-assembled.shot.mjs --stills --nooverlay \
     --port=5957 --out=screenshots/rome-assembled
```

## The scene every camera is in

| | |
|---|---|
| map | `campus-martius` (this is Rome's id; there is no `rome`) |
| scenario | `assault` — the Juthungi outside the Aurelian Wall |
| seed | `4265438264`, the shipped battle everything in `docs/` is measured from |
| hour | 9.5 |
| weather | clear |
| unit size | ultra (3,072 men in 32 units, measured) |

## The plan against the Lanciani plate

`tools/probe-plan.mjs` (branch `e/tools/probe-plan`) renders the map into the georeferenced
plate's own frame and compares. It writes five PNGs at **1.709 real m/px with a 500 m scale bar**:

```
screenshots/probe-plan/A-plate-rome-assembled.png        the plate alone
screenshots/probe-plan/B-render-rome-assembled.png       the built city alone, north up
screenshots/probe-plan/C-overlay-rome-assembled.png      <- the one to look at
screenshots/probe-plan/D-faults-rome-assembled.png       the ranked divergences, marked
screenshots/probe-plan/E-drawn-on-plate-rome-assembled.png
screenshots/probe-plan/report-rome-assembled.json
```

**`C-overlay` is the picture the brief asked for**: grey is the engine's built fabric, yellow is
its monuments, blue is its Tiber, all laid on Lanciani's 1901 *Forma Urbis Romae*. Re-run with

```
node <probe-plan worktree>/tools/probe-plan.mjs --root=<this worktree> --port=5983 --tag=<tag>
```

**Verdict 6/9, one skipped.**

| | |
|---|---|
| **P3 monuments stand where the survey put them** | **PASS — mean 0 / worst 0 real metres.** The rubric's largest single loss (median 227 m, worst 1,031 m) is now zero. |
| P5 the great bend goes the same way | PASS — plate bows −732.4 m west, engine −727 m |
| P6 the bend turns in the same place | PASS — apex 40 m of latitude apart, 5.9 m of easting |
| P7 local curvature has the plate's sign | PASS — 1 of 14 bands disagree, no run of 2 |
| P8 nothing changes bank between plate and engine | PASS — 0.00 % of 535,757 m² |
| P10 the channel is the plate's width | PASS — 102.1 real m against 100.8, ratio **1.01** |
| P1 no solid stands in the river | FAIL — 2 of 1,124 solids on wet ground, **0 fully submerged**, 3,465 m² |
| P2 no solid stands in a carriageway | FAIL — 544 of 1,124, but **529 are district lanes and only 15 are monuments** on the named armature |
| P4 the centreline agrees over the city | FAIL — 4 of 21 bands over 47 m; worst 392 m at n −100, which is inside the northern reach `tiberSurvey.ts` names as a fabrication and puts out of scope |
| P9 gate way-counts | SKIP — no machine ruler on the plate side |

## The pictures worth looking at first

| look at | what it shows |
|---|---|
| **`oblique-wall-00000.jpg`** | The establishing shot. The Aurelian Wall with its towers and the Porta Flaminia, the Via Flaminia running out through the fields the assault arrives down, the Tiber, and the city behind the curtain — all in one frame. |
| **`oblique-campus-00000.jpg`** | Rome as a city. Dense tiled insulae, the Tiber and its bridges, the Mausoleum of Hadrian's drum on the far bank, the Pantheon's dome, a theatre, aqueduct arcades. |
| **`plan-topdown-00000.jpg`** | The plan, north up, for setting beside the Lanciani plate. |
| **`oblique-north-00000.jpg`** | The Stadium of Domitian, the Mausoleum of Augustus with its cypresses, the Pantheon, and the wall closing the top right. |
| **`eye-quarter-east-00000.jpg`** | The honest one. A true 1.75 m eye-level frame in the ordinary fabric — and it shows the ground judge's standing faults: blank ground floors (H7) and grass growing at the street edge (H9). |

## Every camera, by coordinate

`track` is an anchor resolved against the live world; the camera sits `dist` metres from it
horizontally, at `eye` metres above **the terrain under the focus**. The `gate` anchor resolves
at world **(72.0, 532.4)** with outward normal **(−0.1143, −0.9934)**; `stand: S` moves the focus
by `n·S`, so negative `stand` walks into the city down the Via Lata. The **focus (x, z)** column
below is that arithmetic already done, so a judge can stand in the same place without resolving
an anchor.

`yaw` 0 looks **+Z**, which on this map is **south** — into the city, away from the wall.
`yaw: π` looks north at the wall.

### The plan

| shot | focus (x, z) | eye | aim | dist | fov | yaw | note |
|---|---|---|---|---|---|---|---|
| `plan-topdown` | 450, 950 | 2400 | 0 | **0** | 40 | π | Straight down, north up. **1 px = 1.617 m**; frame covers 1,746 m N–S × 3,104 m E–W. |
| `plan-campus` | 100, 950 | 900 | 0 | **0** | 40 | π | Campus Martius alone. **1 px = 0.606 m**; 655 m × 1,164 m. |
| `plan-topdown-safe` | 450, 950 | 2400 | 0 | 200 | 40 | 0 | Near-vertical fallback (85.2° from horizontal), shot before `dist: 0` was known to work. South-up. Superseded. |

`dist: 0` gives `pitch = atan2(rise, 0) = π/2`, a true plan. **No shot file in this repo had used
it before this one**; it works.

### The obliques

| shot | focus (x, z) | eye | aim | dist | fov | yaw |
|---|---|---|---|---|---|---|
| `oblique-wall` | **42.3, 274.1** (`gate`, stand +260) | 220 | 20 | 420 | 44 | `in` |
| `oblique-campus` | 120, 900 | 420 | 30 | 620 | 42 | 3.9270 (1.25 π) |
| `oblique-north` | 110, 850 | 380 | 25 | 600 | 42 | 3.1416 |
| `oblique-river` | −60, 1050 | 300 | 20 | 520 | 44 | 4.7124 (1.5 π) |

### The Via Lata

| shot | focus (x, z) | eye | aim | dist | fov | yaw |
|---|---|---|---|---|---|---|
| `vialata-gate` | **76.6, 572.1** (stand −40) | 1.75 | 8 | 40 | 42 | `out` |
| `vialata-long` | **93.7, 721.1** (stand −190) | 1.75 | 18 | 300 | 32 | `in` |
| `vialata-terminus` | **117.7, 929.8** (stand −400) | 1.75 | 14 | 110 | 40 | `in` |

### Eye level, 1.75 m

The second batch (`eye-*`) is the corrected one. **`aim = eye + 1.55 = 3.3` makes `rise` exactly
zero and the lens exactly level**, which is the condition `docs/VISUAL-RUBRIC.md` §H attaches to
being scorable at all. The first batch (`street-*`) guessed at `aim` and is 7-10 degrees off level (`pitch = atan2(eye - aim + 1.55, dist)`, positive looking down).

| shot | focus (x, z) | eye | aim | dist | fov | yaw | level? |
|---|---|---|---|---|---|---|---|
| `eye-gate-back` | **80.0, 601.9** (stand −70) | 1.75 | 3.3 | 30 | 50 | `out` | **0.0°** |
| `eye-vialata-250` | **100.6, 780.7** (stand −250) | 1.75 | 3.3 | 26 | 50 | `in` | **0.0°** |
| `eye-vialata-500` | **129.2, 1029.1** (stand −500) | 1.75 | 3.3 | 26 | 50 | `in` | **0.0°** |
| `eye-quarter-east` | 300, 900 | 1.75 | 3.3 | 24 | 50 | 3.1416 | **0.0°** |
| `eye-quarter-south` | 520, 1010 | 1.75 | 3.3 | 24 | 50 | 0 | **0.0°** |
| `eye-colosseum` | 671, 1042 | 1.75 | 3.3 | 28 | 50 | 3.1416 | **0.0°** |
| `street-eye` | **106.3, 830.4** (stand −300) | 1.75 | 1.55 | 10 | 46 | `in` +90° | 9.9° down |
| `street-eye-quarter` | 102, 843 | 1.75 | 12 | 70 | 46 | 0.7854 | 7.1° up |
| `street-eye-marcellus` | 181, 1277 | 1.75 | 16 | 90 | 46 | 3.1416 | 8.0° up |

## Three things these frames establish that no probe reported

1. **The camera's own height datum is the terrain under the *focus*, not under the eye.** A
   1.75 m camera looking at something 70 m away across ground that falls 8 m stands ten metres
   up. Half the first batch is a picture taken from a first-floor window because of it. `dist`
   is not a framing choice at eye level; it is what makes `eye` mean what it says.

2. **The Campus Martius has terrain relief in it that a floodplain should not have.** It is
   plainly visible in `eye-vialata-250` and `vialata-terminus` as rounded masses between the
   camera and the monuments, and it is the single biggest thing standing between these frames and
   a street. Nothing in `probe-fabric` looks at terrain under the fabric; `probe-ground` does, but
   it is a reporter and not a gate.

3. **A camera position is a measurement against a frame, and it goes stale when the frame
   moves.** `vialata-terminus` is `judge-city-eye3`'s `r3-pompey` verbatim — a station chosen
   because a probe reported it as the one enclosed stretch of the Via Lata. That was measured
   before `KZ` went 0.222 → 0.35. It no longer lands on the street. Survey rows are versioned
   against the projection; camera stations are not, and nothing marks them.
