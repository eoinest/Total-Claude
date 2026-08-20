# Trailer — shot list and provenance

Four files on the [r6 release](https://github.com/eoinest/Total-Claude/releases/tag/r6):

| | resolution | codecs | length | size | sound |
|---|---|---|---|---|---|
| `total-claude-trailer-1080p-sound.webm` | **1920 × 1080** | VP9 + Opus | **86.0 s** | **130.2 MB** | **yes** |
| `total-claude-trailer.webm` | 1600 × 900 | VP8 | 84.0 s | 14.2 MB | no |
| `total-claude-trailer-720p-twitter.webm` | 1280 × 720 | VP9 + Opus | 21.933 s | **4,689,184 B** | yes |
| `total-claude-trailer-720p-twitter.mp4` | 1280 × 720 | H.264 High + AAC-LC | 21.933 s | **4,791,207 B** | yes |

The third is a shortened recut of the first — the same master frames and the same per-beat
mixer recordings, windowed — for a video that autoplays muted in a phone feed under a
five-megabyte ceiling. `docs/video/README.md` has its shot list and the measurements that
chose it. The fourth is that same cut in a container X's upload endpoint will take; it is not a
transcode of the WebM but a second encode from the same 658 master frames and the same
`mix-tw.f32`, so nothing is generation-lossed through VP9 on the way.

All three are cut from the live simulation at `6698e196ed84f0e456b13cf1ab04c90eeea07d55`, quality
tier `ultra`. Every frame is our own render and every sound is our own synthesis: no reference
material, no third-party footage, no sampled audio, no assets beyond the CC0 set already listed
in `ASSETS.md`.

The picture is `tools/scratch/trailer-recut.mjs`, the sound is
`tools/scratch/trailer-audio-pass.mjs` + `trailer-mixdown.mjs`, and the encode is
`tools/scratch/trailer-encode.mjs`. The two passes share their beat table and their camera
maths through `tools/scratch/trailer-shot.mjs`, which is why they can be checked against each
other rather than assumed to agree.

## How it was captured, and why it is not a screen recording

One captured frame is one `engine.advance(1/30, 1000/30)` — the same `Engine.frame()` the
`requestAnimationFrame` loop calls, at the frame time a player running at 30 fps gets, with
one 30 Hz simulation tick charged to it. Playback at 30 fps is therefore real time: nothing
in this file is sped up, slowed down, or held.

The rAF loop is stopped for the duration (`engine.stop()`, the same thing
`tools/probe-ram.mjs` does) and the clock is driven by the capture instead. That buys three
things a wall-clock recording cannot have on a machine whose GPU is shared: no dropped
frames, an exact and reproducible clock, and — because frames are addressed by name and the
cut is a file list — no dead air across the four page loads the four different worlds need.

**The clock is asserted, not assumed.** The capture throws if `simTime()` moves by anything
other than 1/30 s ± 1 ms between two consecutive frames, on every frame of every beat. The
per-beat deltas below are the second check: men die, corpses accumulate, and the counts of
men fighting, moving, climbing and shooting all change within each beat.

For the one beat where nothing is *marching* yet — the opening, where the armies are still
standing to — the world was measured directly with the camera nailed down
(`tools/scratch/trailer-idlecheck.mjs`): against a one-frame floor of 10.6 mean |Δluma|,
t+4.1 differs by 12.7, t+4.5 by 23.4 and t+9.0 by 61.5. Monotonic in elapsed sim time,
which is what a running world does and a frozen one does not.

## The cut

Timecodes are into the finished file. "Sim" is the simulated clock of the scene the beat was
taken from; each beat's screen time equals its sim duration exactly.

| # | In | Out | Beat | Map / scenario | Sim | Camera | What it shows |
|---|----|-----|------|----------------|-----|--------|---------------|
| 1 | 0:00.0 | 0:05.0 | `field-line` | Campus Martius, field, 08:12 | t+4 → t+9 | eye 2.7→2.5 m, aim 1.55 m, standoff 27→21 m, 32° | Dawn. Tracking along the Roman line from behind it, the Juthungi host beyond. Caption: *The Campus Martius — Rome, 271 AD* |
| 2 | 0:05.0 | 0:12.0 | `field-clash` | Campus Martius, field | t+63 → t+70 | eye 15→11 m, standoff 96→62 m, 32° | The last fifty metres and the crash. Anchored on the midpoint of the two front lines, resolved live |
| 3 | 0:12.0 | 0:16.0 | `field-cav` | Campus Martius, field | t+74 → t+78 | eye 8→6 m, standoff 58→40 m, 32° | The equites wing round the flank at the gallop |
| 4 | 0:16.0 | 0:22.0 | `field-scale` | Campus Martius, field | t+92 → t+98 | eye 74→58 m, standoff 250→196 m, 34° | From the flank, down the length of the whole engagement: 8,144 men, dust over every contact |
| 5 | 0:22.0 | 0:29.0 | `siege-approach` | Campus Martius, **assault**, 14:18 | t+15 → t+22 | eye 27→19 m, standoff 178→138 m, 32° | Siege towers and ladders crossing the tomb field toward the Aurelian Wall, under artillery. Caption: *The Aurelian Wall* |
| 6 | 0:29.0 | 0:35.0 | `siege-ladders` | Campus Martius, assault | t+40 → t+46 | eye 10→17 m, standoff 54→41 m, 34° | Escalade on the unfinished stretch (bay −3): men on the rungs, the garrison massed above |
| 7 | 0:35.0 | 0:40.0 | `siege-parapet` | Campus Martius, assault | t+52 → t+57 | eye crest +1.3→+1.0 m, standoff 46→33 m, 32° | The crest from outside: the fight in the embrasures, escaladers reaching the top |
| 8 | 0:40.0 | 0:47.0 | `carth-wall` | Carthage, **assault**, 16:12 | t+12 → t+19 | descending crane, eye 158→44 m, standoff 380→196 m, 34° | The Byrsa, the city and the gulf, then down onto the great wall, its ditch and four siege towers. Caption: *Carthage — Spring, 146 BC* |
| 9 | 0:47.0 | 0:52.0 | `carth-eles` | Carthage, field, 10:24 | t+96 → t+101 | eye 5.0→3.6 m, standoff 52→32 m, 32° | The war elephants coming on in front of the Punic centre |
| 10 | 0:52.0 | 0:57.0 | `carth-tower` | Carthage, assault | t+252 → t+257 | eye 26→21 m, standoff 60→44 m, 32° | Two siege towers docked on the Punic parapet, columns queuing up into them |
| 11 | 0:57.0 | **1:13.0** | `rome-ram-gate` | Campus Martius, assault | t+202 → t+218 | **one take**: eye 11→6.0 m, standoff 46→30 m, 34°→32° | The ram under its shed at the Porta Flaminia, the slow push in, and the leaves giving way on the twenty-sixth blow at **t+215** |
| 12 | 1:13.0 | 1:19.0 | `rome-arch` | Campus Martius, assault | t+218 → t+224 | eye 6.0→4.4 m, standoff 33→25 m, inside the wall | From the street: the arch is open and the last cohort stands in it |
| 13 | 1:19.0 | 1:26.0 | `endcard` | Campus Martius, assault | t+230 → t+237 | eye 66→58 m, standoff 250→218 m, 32° | The Aurelian Wall with Rome behind it. Title, `8,632 men · one browser tab`, and the URL |

Transitions are hard cuts, except: fade up from black over the first 0.8 s, a 0.6 s dip to
black at each act boundary (0:40, 0:57), and a fade to black over the last 0.7 s. **The sound
takes the same curve**, computed from the same table, so it goes down with the picture and
comes back with it.

### Beat 11 was two beats, and that was the one thing wrong with the released cut

The 84 s silent cut plays this as `rome-ram` (t+202→208) and `rome-gate` (t+210→218). Three
things made the join read as a cut rather than as a move:

1. **A two-second hole in sim time** — t+208 to t+210 was never captured.
2. **The camera stepped backwards across it** — eye 8 → 8.5 m, standoff 33 → 44 m. A wider
   frame after a tighter one is exactly what an audience reads as a new setup.
3. They were separate captures, so nothing carried across.

Re-shot as one sixteen-second beat with a single eased move, monotonic in eye, standoff, aim
and yaw. It is measured as well as looked at: mean |Δluma| between consecutive frames across
the beat is 3.60 ± 1.68, and at frame 180 — where the splice used to be — it is 3.41, **z =
−0.11**. There is no discontinuity there because there is no longer anything there. The whole
cut is two seconds longer as a result, and the slow push is what the two seconds buy.

## What moved, per beat

Straight from the capture log. `alive` is the whole field, both sides.

| Beat | sim | alive | corpses | fighting | moving | climbing | shooting |
|------|-----|-------|---------|----------|--------|----------|----------|
| `field-line` | +4.97 s | 8,632 → 8,632 | +0 | 0 | 0 | 0 | 0 |
| `field-clash` | +6.97 s | 8,630 → 8,561 | +69 | 0 → 294 | 123–433 | 0 | ≤1,200 |
| `field-cav` | +3.97 s | 8,528 → 8,504 | +24 | 260–457 | 777–935 | 0 | ≤520 |
| `field-scale` | +5.97 s | 8,246 → 8,144 | +102 | 456–613 | 804–993 | 0 | ≤200 |
| `siege-approach` | +6.97 s | 3,042 → 3,016 | +26 | 0–14 | 0–3 | ≤27 | ≤810 |
| `siege-ladders` | +5.97 s | 2,982 → 2,949 | +33 | 113–130 | 41–50 | ≤55 | ≤431 |
| `siege-parapet` | +4.97 s | 2,924 → 2,881 | +43 | 125–141 | 86–92 | ≤42 | ≤431 |
| `carth-wall` | +6.97 s | 3,431 → 3,426 | +5 | 0 | 0–2 | ≤34 | ≤440 |
| `carth-eles` | +4.97 s | 7,974 → 7,903 | +71 | 1–30 | 340–374 | 0 | ≤400 |
| `carth-tower` | +4.97 s | 2,963 → 2,948 | +15 | 49–60 | 92–120 | ≤85 | ≤217 |
| `rome-ram-gate` | +15.97 s | 2,340 → 2,293 | +47 | 30–44 | 39–45 | ≤8 | ≤495 |
| `rome-arch` | +5.97 s | 2,293 → 2,278 | +15 | 25–44 | 27–42 | ≤7 | ≤493 |
| `endcard` | +6.97 s | 2,270 → 2,253 | +17 | 33–51 | 0–34 | ≤3 | ≤410 |

`field-line` is the one beat in which nobody is fighting, moving or dying, because at t+4
the armies are still drawn up and have not been ordered forward. See the nailed-camera
measurement above for what is nevertheless moving in it.

## What the assault does *not* do, and why the climax is cut the way it is

The gate breaks exactly as advertised: the ram reaches the leaves and begins battering at
t+100, lands 26 blows, and `gateReport().open` first reads true between t+210 and t+215
(five-second sampling; the brief's t+220 is one interval later). **Nobody then comes through
it.**

Measured with `tools/scratch/trailer-arch.mjs` — attackers cityward of the door plane,
within 16 m of the gate axis, at street level rather than on the parapet over the arch — the
count is **0 at every sample from t+200 to t+300**. What happens instead is that the crowd
outside the arch thins from 77 men to 10 as it is shot off the road, while 12–34 attackers
who came up a siege tower stand on the wall-walk *above* the open gate.

So the trailer does not show men pouring through a broken gate, because the simulation does
not do that. It shows the ram, the moment the leaves give, and then the open arch from the
street inside with the garrison still formed up in it — which is true, and is the most
dramatic thing that is. The "pour" is at the tower ramps instead: beat 10 is Carthage's
towers disgorging onto the parapet, where 80/72/54/33 men have crossed by t+290.

## Audio

The 1080p cut has sound. **It is the game's own synthesised output, recorded live off the
mixer, and nothing else.** No music was added, no sampled sound of any kind was added,
nothing was licensed or downloaded, and no beat was level-matched, compressed or equalised.
The only thing done to the recording is the volume envelope that matches the picture's fades.

### How the sound was recorded, given that the picture is a frame sequence

The picture is captured by stepping the engine with the rAF loop stopped, at roughly 12× slower
than real time. Sound cannot be captured that way: `Mixer.play`, `Mixer.update` and
`Music.pump` all schedule against `AudioContext.currentTime`, so stepping 2,580 frames through
ninety seconds of wall clock would pile eighty-six seconds of events into ninety seconds of
nothing.

So `tools/scratch/trailer-audio-pass.mjs` makes a second pass over the **same fixed 1/30 s sim
grid** — the same `engine.advance(1/30, 1000/30)`, the same beats, the same cameras — but paces
it to the wall clock, and taps the mixer. Four things that pass has to get right, each measured
rather than assumed:

- **The context has to be actually running.** `AudioEngine.init` will not `resume()` without a
  user gesture, and `Mixer.play` hard-returns while `running` is false, so a suspended context
  schedules literally nothing and yields a clean, green, silent file. Chromium is launched with
  `--autoplay-policy=no-user-gesture-required` and `ctx.state` is read back and asserted before
  a sample is kept. It reads `running` at 48 kHz on every one of the four page loads.
- **The tap is the last node before the speakers.** The graph tail is
  `master → pre(0.5) → masterClip(soft clip 0.62/2) → destination`; the recording is taken off
  `masterClip`, so it includes the master gain and the limiter. Tapping `master` would have been
  6 dB hot and unlimited.
- **The listener has to be where the lens was.** `AudioEngine.preRender` takes the listener
  basis off `ctx.camera.matrixWorld`, so the sound pass rebuilds the camera from the same
  `trailer-shot.mjs` the picture uses, and compares its own per-frame eye positions against the
  ones the picture capture recorded. **Zero metres of error on every beat for which a valid
  picture record exists.**
- **Fast-forward has to be silent.** Between beats the clock is run flat out; the context is
  suspended across every fast-forward, which stops `currentTime` and makes `Mixer.running`
  false, so nothing is scheduled into the void.

Rendering is switched off for the sound pass (`Engine.renderOverride`, the seam the engine
already has). Nothing audible is downstream of the draw call, and with it on, GPU contention
put stalls of up to 667 ms into a loop that has to hit a 33.3 ms mark — which does not move a
beat, because the pacer catches up, but does bunch two thirds of a second of battle into the
instant afterwards. With it off, no frame in the whole cut is more than 5.7 ms late.

### Level, per beat

`raw` is the recording; `cut` is after the fade envelope; `decoded` is measured by decoding the
**delivered file** back out of its Opus track, which is the only proof the sound survived the
mux. Full scale is 1.0.

| Beat | in | out | raw RMS | dBFS | raw peak | cut RMS | decoded RMS | voices | peak voices | score share |
|------|----|-----|---------|------|----------|---------|-------------|--------|-------------|-------------|
| `field-line` | 0.0 | 5.0 | 0.1082 | -19.3 | 0.456 | 0.1054 | 0.1053 | 336 | 39 | 37 % |
| `field-clash` | 5.0 | 12.0 | 0.1591 | -16.0 | 0.878 | 0.1590 | 0.1589 | 535 | 40 | 30 % |
| `field-cav` | 12.0 | 16.0 | 0.1425 | -16.9 | 0.677 | 0.1425 | 0.1425 | 217 | 40 | 38 % |
| `field-scale` | 16.0 | 22.0 | 0.1253 | -18.0 | 0.584 | 0.1253 | 0.1252 | 143 | 40 | 43 % |
| `siege-approach` | 22.0 | 29.0 | 0.1059 | -19.5 | 0.524 | 0.1058 | 0.1058 | 112 | 24 | 43 % |
| `siege-ladders` | 29.0 | 35.0 | 0.1272 | -17.9 | 0.657 | 0.1272 | 0.1272 | 315 | 40 | 42 % |
| `siege-parapet` | 35.0 | 40.0 | 0.1281 | -17.9 | 0.702 | 0.1256 | 0.1255 | 344 | 40 | 41 % |
| `carth-wall` | 40.0 | 47.0 | 0.1014 | -19.9 | 0.458 | 0.1010 | 0.1009 | 142 | 33 | 44 % |
| `carth-eles` | 47.0 | 52.0 | 0.1400 | -17.1 | 0.731 | 0.1400 | 0.1398 | 335 | 40 | 31 % |
| `carth-tower` | 52.0 | 57.0 | 0.1374 | -17.2 | 0.796 | 0.1340 | 0.1334 | 273 | 39 | 38 % |
| `rome-ram-gate` | 57.0 | 73.0 | 0.1231 | -18.2 | 0.669 | 0.1228 | 0.1226 | 474 | 40 | 40 % |
| `rome-arch` | 73.0 | 79.0 | 0.1287 | -17.8 | 0.690 | 0.1287 | 0.1286 | 183 | 40 | 38 % |
| `endcard` | 79.0 | 86.0 | 0.1007 | -19.9 | 0.381 | 0.0967 | 0.0967 | 20 | 40 | 47 % |

Whole track: RMS **0.1242 (−18.1 dBFS)**, peak **0.878 (−1.1 dBFS)** — the mixer's soft clip is
never reached. Decoded RMS agrees with the mixdown to within **0.4 %** on every beat.

"Score share" is the music bus' own RMS as a fraction of the master's, after the 0.425 the bus
is worth by the time it reaches the tap. It is 30–47 %, so in power terms the game's own
adaptive score is roughly a tenth to a fifth of what you hear; the rest is the battle.

### Clock, per beat

`drift` is `AudioContext` time across the recorded frames minus the beat's screen time.

| Beat | drift (ms) | worst frame late (ms) | frames > 8 ms late | camera vs picture (m) |
|------|-----------|----------------------|--------------------|----------------------|
| `field-line` | 9 | 5.5 | 0 | 0 |
| `field-clash` | 9 | 4.5 | 0 | — |
| `field-cav` | 7 | 5.7 | 0 | — |
| `field-scale` | 12 | 5.4 | 0 | 0 |
| `siege-approach` | 4 | 5.6 | 0 | — |
| `siege-ladders` | 7 | 5.6 | 0 | — |
| `siege-parapet` | 4 | 1.2 | 0 | 0 |
| `carth-wall` | 4 | 3.8 | 0 | (stale reference — see below) |
| `carth-eles` | -1 | 2.6 | 0 | (stale reference) |
| `carth-tower` | 4 | 5.0 | 0 | — |
| `rome-ram-gate` | **1** | 4.9 | 0 | 0 |
| `rome-arch` | 7 | 3.4 | 0 | — |
| `endcard` | 9 | 3.8 | 0 | 0 |

Every beat is within 12 ms of its own length, so nothing drifts against the picture, and each
beat is trimmed to its exact sample count anyway. A dash means no per-frame camera record
survives for that beat to check against.

`carth-wall` and `carth-eles` check against `stills.json`, which is older than the beat table
and disagrees with it (its `carth-wall` ends 59 m from where the shipped frames end, and its
`field-scale` is 100 m out from `capture.json` for a beat that *does* have a live record). So
that beat was verified against the pixels instead: re-shooting `carth-wall` from the current
table gives frames differing from the shipped ones by mean |Δluma| **1.18 and 1.34**, where two
*consecutive shipped frames* differ by **6.61**. The table reproduces the picture; the stills
record is stale.

### What is thin, and what is missing

Said plainly, because papering over it would be worse:

- **The gate gives way in silence.** `Siege.ts` emits a `cameraShake` for the collapse and
  nothing else — there is no `gate_*` recipe in `Synth.ts` at all. The twenty-sixth blow itself
  *is* audible: a ram blow emits a `projectileImpact` with `material: 'wood' | 'stone'`, so it
  arrives as `impact_wood` / `impact_stone` through the cluster grid. But the moment the leaves
  break has no sound of its own.
- **Arrows have no fly-by.** `BattleAudio.updateFlybys` exists and would Doppler the three
  nearest projectiles within 45 m, and at this commit it never runs once. See below.
- **The ambience is weather-deaf.** Wind, rain and cloud are constants at this commit. See below.
- **The mix has little dynamic shape.** Beat RMS spans just 3.9 dB across the whole film,
  −16.0 dBFS at the clash to −19.9 at the end card. That is honest — a dense battle bed with
  hundreds of overlapping voices does not have much dynamic range — but it means the sound does
  not build the way the picture does. It is not being compressed; that is the game's mix.
- **The end card is nearly all score.** 20 voices started in seven seconds against 474 in the
  ram beat, and 47 % of the level is the music bus.

### Two audio fixes that exist on `main` and are deliberately not in this file

Both were fixed after `6698e19`. The trailer is pinned to `6698e19` because a later commit on
`main` made the garrison 16.1 % more lethal and the ram crew now breaks at t+210 having landed
24 of 26 blows — the gate never opens, and beat 11 does not exist. Matching the picture matters
more than the fixes, and a cut assembled from two different trees would be worse than either.

1. **Arrow fly-by Doppler has never once sounded.** `AudioEngine.attachSimSources` resolves the
   projectile feed through `as unknown as Partial<ProjectileView>`, and `Partial<>` makes every
   field optional, so the compiler stops checking the names. Four of the seven are wrong:
   `ProjectileSystem` publishes `inFlight`, `px`, `py`, `pz`, where the view asks for
   `activeCount`, `x`, `y`, `z`. The runtime `instanceof` guard therefore always fails,
   `projView` is always `null`, and `updateFlybys()` returns on its first line every frame.
   Volleys are audible — those are events — but nothing whistles past the camera. Beats 5, 6, 7
   and 11 are shooting up to 810 arrows at a time and would all gain from it.
2. **The ambience cannot hear the weather.** `AudioEngine.weather()` reads `windSpeed`, `rain`
   and `cloud` off the `sky` subsystem, which publishes only `timeOfDay`; the real values live
   on `vfx` (`VFXSystem.wind`, `Weather.rainRate`), and cloud is inverted there anyway
   (`cloudCoverage` is *higher* for *less* cloud). So `Ambience` runs on its fallbacks — wind
   pinned at 0.34, rain at 0, cloud at 0.2 — for the whole film. The wind bed you hear is a
   three-sine procedural gust that never responds to anything, and the insects do not know
   whether it is raining.

## The encode, and why it is not 1600 × 900 VP8 any more

The silent cut's resolution and codec were both artefacts of the only encoder reachable at the
time: Playwright's bundled ffmpeg, built `--disable-everything` with `libvpx` and `png` — VP8
only, and **no audio encoder or audio muxer at all**. VP8 at 1080p over this material pinned its
quantiser at the ceiling for the whole run and still came out at 68.8 MB, so the picture was
downscaled to 1600 × 900 to make a file small enough to commit. It is a release asset now, so
that constraint is gone.

The 1080p cut is encoded by Chromium's own WebCodecs `VideoEncoder` and `AudioEncoder`, driven
from a Playwright page and muxed with **`webm-muxer`** (npm, pure JS). No ffmpeg is involved and
nothing was installed system-wide. `VideoEncoder.isConfigSupported` reports VP8, VP9 (8- and
10-bit) and AV1 all available in this build; VP9 was chosen for compatibility.

Bitrate was chosen by measuring rather than by guessing, against the 1920 × 1080 JPEG source, on
1:1 crops centred on the highest-variance tile of the frame — dust over a moving camera at 0:08,
eight thousand men at 0:19, flat brick at 0:32, the gate mouth in shadow at 1:05:

| encode | size | 0:08 | 0:19 | 0:32 | 1:05 |
|---|---|---|---|---|---|
| VP9 12 Mb/s (**shipped**) | 130.2 MB | 27.23 dB | 26.79 | 29.37 | 29.86 |
| AV1 10 Mb/s | 109.1 MB | 27.56 dB | 26.84 | 29.03 | 29.52 |
| VP9 25.4 Mb/s (reference) | 274.3 MB | 28.02 dB | 27.59 | 30.24 | 30.05 |

Doubling the bitrate buys 0.2–0.8 dB, which says the number is floored by the RGB → YUV 4:2:0 →
RGB round trip and not by compression. The shipped encode is within 0.8 dB of a 25 Mb/s
reference on the hardest frame in the film, and at 100 % the crops show no blocking, no banding
in the sky gradients, and brick courses and individual men still legible.

### The 720p social encode, and the five-megabyte ceiling

Same pipeline, same measurement, different arithmetic: the file has to come in under 5,000,000
bytes, so the only free variable once the length was fixed at 21.933 s was the bitrate. VP9's
rate control overshoots its ask by about 11 % on this material, consistently enough to
interpolate against.

| asked | delivered | total bytes | headroom |
|---|---|---|---|
| 1.00 Mb/s | 1.15 Mb/s | 3,397,748 | 1,602,252 B |
| 1.40 Mb/s | 1.56 Mb/s | 4,531,082 | 468,918 B |
| **1.45 Mb/s (shipped)** | **1.62 Mb/s** | **4,689,184** | **310,816 B** |
| 1.50 Mb/s | 1.66 Mb/s | 4,807,064 | 192,936 B |
| 4.00 Mb/s (reference) | 4.07 Mb/s | 11,403,134 | −6,403,134 B |

PSNR is against the same source frame put through the *same* downscale the encoder used
(1920 → 1280 in a 2D context at `imageSmoothingQuality = 'high'`), so the number is compression
and not resampling, and against the frame the player actually presented, found by search, so it
is not motion either. Whole frame, and the worst 64 px tile in it:

| encode | 0:02.6 clash | 0:05.2 ladders | 0:07.5 parapet | 0:12.0 gate in shadow | 0:17.5 the cohort |
|---|---|---|---|---|---|
| VP9 1.15 Mb/s | 25.40 / 22.15 | 27.39 / 22.68 | 28.05 / 22.48 | 29.75 / 25.20 | 23.59 / 18.66 |
| **VP9 1.62 Mb/s (shipped)** | **26.02 / 23.52** | **27.95 / 23.92** | **28.53 / 23.47** | **29.93 / 25.57** | **24.10 / 19.60** |
| VP9 4.07 Mb/s (reference) | 27.45 / 25.67 | 29.14 / 25.48 | 29.50 / 25.44 | 30.56 / 26.71 | 25.34 / 21.49 |

2.4× the file buys 0.63–1.43 dB, so the shipped rate is on the same plateau the 1080p encode is
on: the content is hard, not starved. It matters more that the *failure mode* is right. At 100 %
the crops lose specular edges off helmets and texture off grass, and gain no blocking and no
banding anywhere, including in the shadowed gate mouth — which is what has to be true of a file
that is a source for someone else's transcoder rather than the finished artefact.

### The same cut as MP4, because X's uploader will not take a WebM

Same 658 master frames, same `mix-tw.f32`, same seven beats and the same contiguous ram — only
the container and the two codecs change. `avc1.64001f` (High, level 3.1), `avc1.4d001f`,
`avc1.42001f` and `mp4a.40.2` are all reported supported by `VideoEncoder.isConfigSupported` and
`AudioEncoder.isConfigSupported` in this build; only the software path is available, and it does
emit real High profile rather than falling back — `avcC` on the delivered file reads
`01 64 0c 1f`, which is profile_idc 100, and that is read back out of the file rather than
trusted from the codec string.

**The VP9 ladder does not carry over and none of it was reused.** H.264's rate control here
tracks its ask far more closely than VP9's does — 9.7 % over at 1.00 Mb/s falling to 1.6 % *under*
at 4.00, where VP9 sat at a flat 11 % over — so the interpolation is a different line:

| asked | delivered | total bytes | headroom |
|---|---|---|---|
| 1.00 Mb/s | 1.10 Mb/s | 3,280,551 | 1,719,449 B |
| 1.40 Mb/s | 1.47 Mb/s | 4,292,964 | 707,036 B |
| 1.55 Mb/s | 1.61 Mb/s | 4,672,946 | 327,054 B |
| **1.60 Mb/s (shipped)** | **1.65 Mb/s** | **4,791,207** | **208,793 B** |
| 1.65 Mb/s | 1.70 Mb/s | 4,922,240 | 77,760 B |
| 1.70 Mb/s | 1.76 Mb/s | 5,093,265 | −93,265 B |
| 4.00 Mb/s (reference) | 3.94 Mb/s | 11,068,443 | −6,068,443 B |

1.65 Mb/s asked would also have fitted, and was not taken: it is 2.4 % more bits for about a
tenth of a decibel, against 77 kB of headroom. The encoder is threaded and not bit-reproducible
— the shipped point re-encodes to within about 14 kB run to run, 0.3 % — and 208 kB is forty
times that. AAC-LC is 96 kb/s stereo, 263,900 bytes of the file; Opus does the same job at 80,
which is the honest cost of the container swap and not worth clawing back at 0.03 Mb/s of
picture.

PSNR by the same method as above and the same instrument, both files measured in one run, whole
frame / worst 64 px tile:

| moment | H.264 1.65 Mb/s (shipped) | VP9 1.62 Mb/s | H.264 3.94 Mb/s (reference) |
|---|---|---|---|
| 0:03.6 clash in dust | **24.02 / 21.00** | 26.02 / 23.85 | 24.84 / 22.55 |
| 0:06.4 parapet | **28.44 / 25.31** | 29.17 / 25.08 | 29.45 / 26.58 |
| 0:11.5 ram, mid push | **29.03 / 24.66** | 30.07 / 25.77 | 29.86 / 26.30 |
| 0:15.2 gate mouth in shadow | **30.08 / 26.62** | 30.55 / 27.16 | 30.83 / 27.23 |
| 0:17.5 the cohort | **23.76 / 20.20** | 24.10 / 19.60 | 24.74 / 21.69 |

2.31× the file buys 0.75–1.01 dB, so the shipped rate is on the same plateau VP9 is on and the
content is hard rather than starved; going the other way, 0.69× the file only costs 0.42–0.69 dB.
H.264 is 0.29–2.00 dB behind VP9 at the same delivered rate, which is the codec generation gap
and not a mistake in the ladder.

**None of that is the number that decides it.** Every figure above is measured at 1280 px, which
is not a size this file will be seen at. At 400 px — the element sized to 400 and screenshotted
there, so the browser's own scaler is in the picture — against the master downscaled 1920 → 400:

| moment | H.264 | VP9 | difference | H.264 vs VP9 |
|---|---|---|---|---|
| 0:03.6 | 25.55 dB | 26.09 | −0.54 dB | 28.57 dB |
| 0:06.4 | 27.84 | 28.25 | −0.41 | 33.88 |
| 0:11.5 | 29.02 | 29.56 | −0.54 | 34.72 |
| 0:14.2 | 29.46 | 29.64 | −0.18 | 35.50 |
| 0:15.2 | 29.67 | 29.83 | −0.16 | 35.34 |
| 0:17.5 | 24.93 | 25.26 | −0.32 | 27.75 |
| 0:20.0 | 28.06 | 28.38 | −0.32 | 34.65 |

The 0.29–2.00 dB gap at 1280 px collapses to 0.16–0.54 dB at 400, and the two encodes are closer
to each other (27.7–35.5 dB) than either is to the source. Side by side at feed size, sixteen
stills across the cut, they are not tellable apart. At 100 % the H.264 file loses spear shafts
and grass texture — it goes soft, not blocky — and the shadowed gate mouth, which is the place
this was most likely to fail, still resolves the grille and shows no banding.

**The sound needed one correction the WebM did not.** AAC-LC's encoder delay is left in a plain
MP4, because there is no edit list to take it off the way a WebM demuxer takes off Opus'
pre-skip, and the first attempt shipped a track 2,112 samples — 44 ms — behind the picture,
which is exactly where a viewer starts to be able to hear it. Dropping the leading packets is
not the fix, since AAC frames overlap and the frame after a dropped one decodes wrong, so the
compensation is made in the PCM: the encoder is fed the mixdown from sample 2,048 with 2,048
samples of silence appended. Measured again on the delivered file, the lag is 64 samples,
1.33 ms. The encoder's whole-frame padding also ran the audio track 83 ms past the last picture
frame, so frames starting after it are dropped; the track is 21.952 s against 21.933 s of
picture.

Per-shot RMS decoded out of the delivered AAC, against what the cut wrote: −0.43 % to −0.76 %
on six of seven shots, and −1.99 % on `field-line`, which is the 43 ms of pre-roll landing
inside a 1.4 s shot. The same instrument scores the Opus track at −0.19 % to +0.17 %, so AAC's
band is about four times wider on one shot and four times wider than nothing on the rest, which
is what a different lossy codec should look like. AAC also overshoots the mixdown's peak by
0.87 dB (0.9715 against 0.878) where Opus overshoots by 0.07 — under full scale, but it is why
the peak column is worth printing.

AV1 was encoded at the same ask and came out 14 % smaller (4,036,228 B at 1.38 Mb/s), and is not
shipped, because it could not be checked. `canPlayType` reports `probably` for
`av01.0.05M.08` in this build and the review harness — which finishes a VP9 file in under a
minute — hung on the AV1 file's first seek and was killed after six. An encode nobody can decode
back and measure is not a candidate.

## Reproducing it

```sh
npx vite --port 5237 --host 127.0.0.1 --strictPort         # not 5173, the owner plays on that
node tools/scratch/trailer-recut.mjs --port=5237 --stills  # 3 frames a beat, to look at
node tools/scratch/trailer-recut.mjs --port=5237 --noencode        # picture: 2,580 JPEGs
node tools/scratch/trailer-audio-pass.mjs --port=5237              # sound: 13 beats of PCM
node tools/scratch/trailer-mixdown.mjs                             # PCM -> one 86 s track
node tools/scratch/trailer-encode.mjs --codec=vp09.00.41.08 --bitrate=12000000 \
  --out=/tmp/tc-sound/total-claude-trailer-1080p-sound.webm
node tools/scratch/trailer-review.mjs --file=...                   # watch and listen to it back
node tools/scratch/trailer-cropcheck.mjs --file=...                # judge the encode at 100 %
```

The 22 s social cut needs none of the above run again — it reuses the master frames and the
per-beat recordings on disk:

```sh
node tools/scratch/trailer-tw-scout.mjs --sheet="field-scale:0,80,179"   # candidates at 400 px
node tools/scratch/trailer-tw-scout.mjs --diff=rome-ram-gate --box=0.30,0.34,0.40,0.46
node tools/scratch/trailer-tw-cut.mjs                              # 658 frames + a matching track
node tools/scratch/trailer-tw-encode.mjs --ladder=1400000,1450000,1500000
node tools/scratch/trailer-tw-encode.mjs --bitrate=1450000 \
  --out=/tmp/tc-tw/total-claude-trailer-720p-twitter.webm
node tools/scratch/trailer-tw-review.mjs                           # decode it back, at 400 px
```

The MP4 reuses that same `cut-tw.json` and `mix-tw.f32` rather than re-cutting, which is what
makes it the same edit rather than a similar one:

```sh
node tools/scratch/trailer-mp4-encode.mjs --probe                  # ask, do not assume
node tools/scratch/trailer-mp4-encode.mjs --ladder=1550000,1600000,1650000,1700000
node tools/scratch/trailer-mp4-encode.mjs --bitrate=1600000 \
  --out=/tmp/tc-mp4/total-claude-trailer-720p-twitter.mp4
node tools/scratch/trailer-mp4-review.mjs --file=... \
  --vs=/tmp/tc-tw/total-claude-trailer-720p-twitter.webm           # both, one instrument
```

`--beats=a,b --keep` re-shoots individual beats in place; the cut is rebuilt from what is on
disk, so a partial re-shoot cannot silently drop the beats it did not touch. The two
dependencies added for any of this are `webm-muxer` and `mp4-muxer`, which are siblings; no
ffmpeg is installed, and Playwright's bundled one could not have made either file — it is built
`--disable-everything` with libvpx and png, so VP8 only, no audio codec and no audio muxer.

The picture takes about ten minutes to capture and one to encode; the sound pass takes about
eight, most of it fast-forwarding four worlds to the later beats.
