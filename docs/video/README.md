# The trailer

Three files, all attached to the [r6 release](https://github.com/eoinest/Total-Claude/releases/tag/r6)
rather than committed, so none of them sits in every clone forever.

**[`total-claude-trailer-1080p-sound.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer-1080p-sound.webm)**
— **1920 × 1080, 30 fps, 86.0 s, VP9 + Opus, 130.2 MB.** The one to watch: native
resolution, and it has sound.

**[`total-claude-trailer.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer.webm)**
— 1600 × 900, 30 fps, 84.0 s, VP8, 14.2 MB, silent. The original cut, kept for a slow
connection and because the release links it.

**[`total-claude-trailer-720p-twitter.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer-720p-twitter.webm)**
— **1280 × 720, 30 fps, 21.933 s (658 frames), VP9 + Opus, 4,689,184 bytes.** The social cut:
under the five-megabyte ceiling with 310,816 bytes to spare, and it has sound.

At a nominal 10 MB/s that is about **thirteen seconds** for the 1080p one, **a second and a
half** for the small one and **half a second** for the social one; on a 10 Mbit line, about
**1 min 45 s**, **11 s** and **4 s**. VP9 and Opus in WebM play in Chrome, Edge, Firefox,
Safari 14+, VLC and IINA; neither VP9 file will open in QuickTime Player, which has never read
WebM of any kind.

They are not the same edit. The 1080p cut plays the assault on the Porta Flaminia as **one
sixteen-second take** — the ram, the push in, and the twenty-sixth blow — where the silent cut
broke it into two shots with a two-second hole in sim time and a camera that stepped backwards
across the join. That is the only editorial difference between those two, and it is why the
newer of them is two seconds longer.

## The 22-second cut, and why it is short rather than small

Five megabytes over eighty-six seconds is 465 kb/s. Dust, smoke and eight thousand moving men
do not survive that at any resolution, so the social cut spends the same five megabytes on a
fifth of the film instead: 21.933 s at 1.62 Mb/s, which is clean.

It is cut for a video that autoplays **muted, in a feed, on a phone**, where the frame is about
400 px wide, and every beat in it was chosen by looking at the master downscaled to exactly
that width rather than by looking at the shot list. Two of those looks overturned the obvious
edit. `field-scale` — 8,144 men from the flank at ninety metres, the most impressive frame in
the film on a desktop — is a hazy green patchwork at 400 px in which the smudges do not read as
men, so it is not in this cut at all. `field-line` reads unmistakably and is the cold open, but
it only holds for about 1.4 s: the beat tracks *along* the line, so the army is in the near
field from frame 60 to 85 and a receding band by frame 100, and the shot is exactly as long as
the thing in it.

| # | in | out | beat | what it is |
|---|----|-----|------|-----------|
| 1 | 0:00.00 | 0:01.40 | `field-line` | The shield wall, filling the frame, with its caption. The frame a feed will freeze on |
| 2 | 0:01.40 | 0:04.00 | `field-clash` | The melee and the dust band along it |
| 3 | 0:04.00 | 0:06.53 | `siege-ladders` | The Aurelian Wall, wide: ladders up, the garrison massed above |
| 4 | 0:06.53 | 0:08.93 | `siege-parapet` | The same escalade at crest height |
| 5 | 0:08.93 | 0:16.27 | `rome-ram-gate` | **One take.** In on a ram blow, the slow push, and the leaves giving way |
| 6 | 0:16.27 | 0:18.93 | `rome-arch` | The open arch from the street, the cohort standing in it |
| 7 | 0:18.93 | 0:21.93 | `endcard` | Title, URL, fade |

Hard cuts throughout and no fade up at the head, because a feed video that opens on black has
already lost; the only fade is the end card's, which is burned into the master frames, and the
sound is given that same curve.

**The ram is still one take.** Its window is a single contiguous run of master frames, and the
tool asserts that it is. It enters *on* a blow rather than before one: the shed's hide fills the
lens until frame 152 of the beat, a blow lands at 212–231, and the leaves give way at 353–369.
That last number is measured rather than taken from the simulation's five-second `gateReport()`
sampling — mean |Δluma| in the gate mouth runs at 1.06 through the quiet push and spikes to 6.54
there, and the pale leaf panel is present at frame 352 and gone by 362. The shot holds 1.9 s past
it, and then shot 6 says the same thing in a way that survives being 400 px wide.

At 400 px the break itself is a small dark change inside an already dark arch, which is why the
cut does not end on it. `rome-arch` — a black void in a warm brick wall with a packed cohort and
a red standard in front of it — is the most legible frame in the whole film at feed size, and it
is what tells a phone that the gate is open.

![The Porta Flaminia during the assault: two round brick towers flanking a stone-voussoired arch
with a portcullis behind it, a hide-roofed shed on timber posts standing in the gate mouth with its
crew packed underneath, broken timber lying in the passage, and infantry drawn up on the road to the
right.](trailer-poster.jpg)

## What the sound is, and what it is not

**It is the game's own audio, recorded live off the mixer while the simulation ran.** Every
sound in the file was synthesised by `src/audio/Synth.ts` from oscillators and noise at run
time — 89 procedural buffers, built in the page, about 20 MB of them — and mixed by
`src/audio/Mixer.ts` through its own spatialisation, its combat saturator and its soft-clip
limiter. The recording is a tap on the last node before `destination`, so what is in the file
is what a player hears.

**It is not:** no music was added, no sampled sound of any kind was added, nothing was
licensed, borrowed or downloaded, and no beat was sweetened, level-matched, compressed or
equalised afterwards. The only processing between the mixer and the file is the volume
envelope that matches the picture's own fades.

The score you can hear under it is the game's own adaptive one (`src/audio/Music.ts`) — a
synthesised D-Phrygian drone with percussion that the battle drives — because it is part of
the live mix and a player hears it too. It is about a third of the level, and it is the only
thing in the file that is not a battle.

Where the mix is thin, it is thin, and [`SHOTLIST.md`](SHOTLIST.md) says which beats and why.
Two of them are worth knowing about before you press play: **the gate gives way in silence**
(the sim emits a camera shake and nothing else for it), and **arrows have no fly-by**.

## How it is made

Every frame is live simulation. Capture is a JPEG sequence rather than a screen recording: one
frame is one `engine.advance(1/30, 1000/30)` — the same `Engine.frame()` the rAF loop calls —
with the rAF loop stopped and the clock driven by the capture, so 30 fps playback is real time
and a shared GPU cannot drop frames. The tool throws if `simTime()` moves by anything other
than 1/30 s between consecutive frames, and that is asserted on every frame of every beat.

The sound cannot be recorded that way, because the mixer schedules against
`AudioContext.currentTime` and a capture that steps 2,580 frames in ninety seconds of wall
clock would pile eighty-six seconds of events into ninety seconds of nothing. So the sound is a
second pass over the *same* fixed 1/30 s grid — identical sim, identical camera — paced to the
wall clock instead. See [`SHOTLIST.md`](SHOTLIST.md) for the measurements that prove the two
passes agree.

## One thing the trailer could not show

The gate breaks and nobody comes through it. 26 blows, `gateReport().open` first true between
t+210 and t+215 — and **zero attackers cityward of the door plane at every sample from t+200 to
t+300**. The crowd outside thins from 77 to 10 as it is shot off the road, while 12–34 men stand
on the walk *above* the open arch, having come up a tower. So the climax is the ram and the
moment the leaves give, and the shot of men going through is at Carthage's tower ramps instead.
It was not staged, because it does not happen.
