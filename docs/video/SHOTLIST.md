# Trailer — shot list and provenance

`docs/video/total-claude-trailer.webm` — **1600 × 900, 30 fps, 84.0 s, 14.2 MB, VP8, silent.**

Cut from the live simulation at `6698e196ed84f0e456b13cf1ab04c90eeea07d55`, quality tier
`ultra`, by `tools/scratch/trailer-cut.mjs`. Every frame is our own render: no reference
material, no third-party footage, no assets beyond the CC0 set already listed in
`ASSETS.md`.

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
| 11 | 0:57.0 | 1:03.0 | `rome-ram` | Campus Martius, assault | t+202 → t+208 | eye 11→8 m, standoff 46→33 m, 34° | The ram under its shed at the Porta Flaminia, blows landing |
| 12 | 1:03.0 | 1:11.0 | `rome-gate` | Campus Martius, assault | t+210 → t+218 | eye 8.5→6.0 m, standoff 44→30 m, 32° | The twenty-sixth blow. The leaves give way at **t+215** |
| 13 | 1:11.0 | 1:17.0 | `rome-arch` | Campus Martius, assault | t+218 → t+224 | eye 6.0→4.4 m, standoff 33→25 m, inside the wall | From the street: the arch is open and the last cohort stands in it |
| 14 | 1:17.0 | 1:24.0 | `endcard` | Campus Martius, assault | t+230 → t+237 | eye 66→58 m, standoff 250→218 m, 32° | The Aurelian Wall with Rome behind it. Title, `8,632 men · one browser tab`, and the URL |

Transitions are hard cuts, except: fade up from black over the first 0.8 s, a 0.6 s dip to
black at each act boundary (0:40, 0:57), and a fade to black over the last 0.7 s.

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
| `rome-ram` | +5.97 s | 2,340 → 2,320 | +20 | 30–42 | 39–42 | ≤4 | ≤495 |
| `rome-gate` | +7.97 s | 2,316 → 2,293 | +23 | 38–44 | 40–45 | ≤8 | ≤493 |
| `rome-arch` | +5.97 s | 2,293 → 2,278 | +15 | 25–44 | 27–42 | ≤7 | ≤493 |
| `endcard` | +6.97 s | 2,270 → 2,253 | +17 | 33–51 | 0–34 | ≤3 | ≤410 |

`field-line` is the one beat in which nobody is fighting, moving or dying, because at t+4
the armies are still drawn up and have not been ordered forward. See the nailed-camera
measurement above for what is nevertheless moving in it.

## What the assault does *not* do, and why the climax is cut the way it is

The gate breaks exactly as advertised: the ram reaches the leaves and begins battering at
t+100, lands 26 blows, and `gateReport().open` first reads true between t+210 and t+215 (five-second
sampling; the brief's t+220 is one interval later). **Nobody then comes through it.**

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

**Silent, deliberately.** Two reasons, in order:

1. There was no way to encode an audio track. The only video encoder on this machine is the
   one Playwright ships for `recordVideo`, built `--disable-everything` with `libvpx` and
   `png` and no audio codec or audio muxer at all. Installing ffmpeg was not in scope.
2. Nothing would have been captured anyway. `AudioEngine` creates its `AudioContext`
   suspended under the harness — no user gesture — and schedules nothing.

Worth recording for whoever adds sound later: the game's audio is **entirely synthesised**
(`src/audio/Synth.ts`, `Ambience.ts`, `Music.ts`) rather than sampled, so it is our own
material and carries no licence question. Nothing from any commercial game was considered.

## Reproducing it

```sh
npx vite --port 5219 --host 127.0.0.1 --strictPort        # not 5173
node tools/scratch/trailer-cut.mjs --port=5219 --stills   # 3 frames a beat, to look at
node tools/scratch/trailer-cut.mjs --port=5219            # capture + encode
node tools/scratch/trailer-cut.mjs --encode               # re-encode from cached frames
```

`--beats=a,b --keep` re-shoots individual beats in place; the cut is rebuilt from what is on
disk, so a partial re-shoot cannot silently drop the beats it did not touch.

Capture takes about ten minutes: 2,520 frames at roughly 80 ms each (render ~5 ms, the
screenshot round trip the rest), plus four world builds at 5 s and about three minutes of
fast-forward to reach the later beats.

## Size

14.2 MB. The same 2,520 frames encode to 20.8 MB at qmax 60 and to **68.8 MB** at
1920 × 1080 with qmax 48 — VP8 has no rate left to give at 1080p on grass, dust and eight
thousand moving men, and pinned its quantiser at the ceiling for the whole run while still
overshooting its target by 2×. If 14.2 MB in every clone is still too much, the alternatives
are, in order of preference: host it off-repo and keep only a still here; drop to 1280 × 720
(about 9 MB); or shorten the cut — beats 3 and 9 are the two the trailer would miss least.
