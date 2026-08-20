# The trailer

Four files, all attached to the [r6 release](https://github.com/eoinest/Total-Claude/releases/tag/r6)
rather than committed, so none of them sits in every clone forever.

**[`total-claude-trailer-1080p-sound.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer-1080p-sound.webm)**
— **1920 × 1080, 30 fps, 86.0 s, VP9 + Opus, 130.2 MB.** The one to watch: native
resolution, and it has sound.

**[`total-claude-trailer.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer.webm)**
— 1600 × 900, 30 fps, 84.0 s, VP8, 14.2 MB, silent. The original cut, kept for a slow
connection and because the release links it.

**[`total-claude-trailer-720p-twitter.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer-720p-twitter.webm)**
— **1280 × 720, 30 fps, 20.700 s (621 frames), VP9 + Opus, 4,703,399 bytes.** The social cut:
under the five-megabyte ceiling with 296,601 bytes to spare, and it has sound.

**[`total-claude-trailer-720p-twitter.mp4`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer-720p-twitter.mp4)**
— **1280 × 720, 30 fps, 20.700 s (621 frames), H.264 High + AAC-LC, 4,691,477 bytes.** The same
cut, same beats, same one-take ram, in the container X's uploader will actually accept: that
endpoint takes MP4 and MOV and does not take WebM at all, so the file above cannot be handed to
it. 308,523 bytes of headroom.

Both social files are on their **second edit**; the section below says what changed and why.
At a nominal 10 MB/s that is about **thirteen seconds** for the 1080p one, **a second and a
half** for the small one and **half a second** for either social one; on a 10 Mbit line, about
**1 min 45 s**, **11 s** and **4 s**. VP9 and Opus in WebM play in Chrome, Edge, Firefox,
Safari 14+, VLC and IINA; neither VP9 file will open in QuickTime Player, which has never read
WebM of any kind — which is the other thing the MP4 is for. It is High profile rather than
Baseline: `avc1.640c1f`, level 3.1, `yuv420p`, progressive, which every decoder made this
decade takes, and Baseline would have cost picture for compatibility nobody needs now.

They are not the same edit. The 1080p cut plays the assault on the Porta Flaminia as **one
sixteen-second take** — the ram, the push in, and the twenty-sixth blow — where the silent cut
broke it into two shots with a two-second hole in sim time and a camera that stepped backwards
across the join. That is the only editorial difference between those two, and it is why the
newer of them is two seconds longer.

## The 21-second cut, and why it is short rather than small

Five megabytes over eighty-six seconds is 465 kb/s. Dust, smoke and eight thousand moving men
do not survive that at any resolution, so the social cut spends the same five megabytes on a
quarter of the film instead: 20.700 s at 1.72 Mb/s, which is clean.

It is cut for a video that autoplays **muted, in a feed, on a phone**, where the frame is about
400 px wide, and no beat is in it because the shot list liked it. Every candidate was put
through `tools/scratch/trailer-tw-legible.mjs`, which downscales the master to exactly the
delivered width and reports two numbers: how much **gradient energy** survives the resample —
the structure a viewer can still see — and how much the picture **moves between frames** at that
size, which is what peripheral vision in a feed actually picks up. Both are computed on the same
`imageSmoothingQuality = 'high'` path the encoder and the browser use, and nothing anywhere is
upscaled.

| beat | gradient | frame contrast | motion | in the cut? |
|------|---------:|---------------:|-------:|-------------|
| `rome-arch` | **17.39** | 39.7 | 6.16 | no — cut on the owner's note |
| `carth-eles` | 17.19 | 48.3 | **10.28** | yes |
| `field-line` | 13.79 | **77.0** | 11.31 | yes |
| `field-clash` | 13.09 | 59.3 | 4.77 | yes |
| `carth-tower` | 10.88 | 55.4 | 2.61 | yes |
| `siege-parapet` | 10.86 | 59.4 | 3.22 | yes |
| `siege-ladders` | 10.07 | 32.0 | 2.20 | no |
| `rome-ram-gate` | 7.30 | 28.7 | 1.78 | yes |
| `endcard` | 6.28 | 27.6 | 1.22 | yes |

Two results from the first pass still stand. `field-scale` — 8,144 men from the flank at ninety
metres, the most impressive frame in the film on a desktop — is a hazy green patchwork at 400 px
in which the smudges do not read as men, so it is not in this cut either. And `field-line` reads
unmistakably and is the cold open, but only holds for about 1.4 s: the beat tracks *along* the
line, so the army is in the near field from frame 60 to 85 and a receding band by frame 100, and
the shot is exactly as long as the thing in it.

| # | in | out | beat | what it is, and why it is there |
|---|----|-----|------|-----------|
| 1 | 0:00.00 | 0:01.40 | `field-line` | The shield wall, filling the frame, with its caption. The frame a feed will freeze on |
| 2 | 0:01.40 | 0:04.00 | `field-clash` | The melee and the dust band along it |
| 3 | 0:04.00 | 0:06.60 | `carth-eles` | The war elephants, coming on and growing. The most legible beat in the cut, and a *field* beat, so the map changes on a cut where the colour does not |
| 4 | 0:06.60 | 0:08.77 | `carth-tower` | Two siege towers docked on the Punic parapet, columns queuing into them. Dark timber on pale limestone |
| 5 | 0:08.77 | 0:11.20 | `siege-parapet` | The Aurelian Wall at crest height: a ladder with a chain of men on it, the garrison massed above. Hands off from one wall being climbed to another |
| 6 | 0:11.20 | 0:17.37 | `rome-ram-gate` | **One take.** In on a ram blow, the slow push, and the leaves giving way |
| 7 | 0:17.37 | 0:20.70 | `endcard` | Title, URL, fade |

Hard cuts throughout and no fade up at the head, because a feed video that opens on black has
already lost; the only fade is the end card's, which is burned into the master frames, and the
sound is given that same curve. The 86 s cut's other burned fades — the dips to black at its two
act boundaries — are now **asserted** around rather than remembered: `trailer-tw-cut.mjs` walks
every window and throws if any frame in it sits at less than full picture gain, `endcard`
excepted.

### What changed in the second edit, and why Carthage is not a non-sequitur

Four notes came back on the first cut: two escalade beats is one too many, put Carthage in, put
the elephants back, and cut `rome-arch`. All four are done, and the two questions they left open
were settled with the instrument above rather than by taste.

**The close escalade beat survives, not the wide one.** The obvious keep was `siege-ladders` —
the whole wall, the ladders, the assault massed at the foot, the best *photograph* of the two.
At 400 px it loses on every axis: gradient 10.07 against `siege-parapet`'s 10.86, frame contrast
32.0 against 59.4, motion 2.20 against 3.22. The reason is visible the moment both are put at
that width. The wide shot is mid-brown wall on mid-green grass and its ladders are two faint
diagonals; the close one is hard sky against dark brick with a ladder that has men on the rungs.
It is also the *closer* of the two, which matters now that a Punic wall precedes it: the back
half of the film pushes in the whole way and never steps back.

**Carthage sits in the middle, as a block, hinged at both ends.** The pass before this one cut
Carthage on the grounds that a 146 BC white-sand map dropped into a twenty-second Roman
escalation is a non-sequitur. That was right about *dropping* it in, so it is not dropped in.
The film enters Carthage on `carth-eles`, a field beat whose green grass, gold stubble and pale
sky are the same palette as the `field-clash` it cuts from — one field shot to another field
shot, and the map changes underneath a cut the eye does not notice. It leaves Carthage on
`carth-tower`, a wall being escaladed, and cuts to `siege-parapet`, a wall being escaladed — the
colour changes and the activity does not. One boundary is motivated by palette, the other by
subject, and neither is a jump.

What the film then reads as is not one battle but **a sweep across the war that narrows into one
gate**: field, field, wall, wall, gate, with the palette walking green → gold → pale limestone →
red brick → shadow in the same direction the camera is pushing. For a twenty-second feed video
that is the right genre; a single continuous engagement is what the eighty-six second cut is for.

### The gate breaking, at 400 px, honestly

**The ram is still one take.** Its window is a single contiguous run of master frames and the
tool asserts it. It enters *on* a blow: the shed's hide fills the lens until frame 152 and a blow
lands at 212–231, so cutting in at 206 puts the shake 0.2 s after the cut.

The first edit put `rome-arch` last on the grounds that the break is invisible at feed size.
Measured, that is half right, and the half it gets wrong matters. **The break is the largest
thing that happens in the shot**: whole-frame |Δluma| at 400 px peaks at 9.54 on frame 356
against a beat mean of 1.78 ± 1.23 — z = +6.3 — and the leaves are gone between frames 355 and
370. A muted viewer feels that. What they do not get is the *consequence*. The gate mouth is
dark before and dark after; the change is a pale panel leaving an already dark arch, so the
frame's contrast **falls** across the aftermath, 28.6 → 23.3, and its motion decays
monotonically, 1.67 → 0.58, the emptiest picture in the film.

That makes "hold longer on the collapse" the wrong way round, and the window is fifteen frames
*shorter* than the first edit's rather than longer. The surge of men on the road runs at 2.38
through frame 389 against a pre-break 1.88 and is back at 1.84 by 434, so the take ends at 390,
on the last frame where it is still doing something, and the second that buys goes to the end
card. Cutting to the title while the gate is still coming apart lands the break on the title
instead of letting it dissipate against brick.

It is a softer ending than the first cut's. `rome-arch` — a black void in a warm brick wall with
a packed cohort and a red standard in front of it — measures 17.39, the highest gradient energy
of any beat in the film, and it was doing real work. Without it the film ends on an event the
viewer feels rather than a picture they read.

![The Porta Flaminia during the assault: two round brick towers flanking a stone-voussoired arch
with a portcullis behind it, a hide-roofed shed on timber posts standing in the gate mouth with its
crew packed underneath, broken timber lying in the passage, and infantry drawn up on the road to the
right.](trailer-poster.jpg)

### What the bits cost, and how both files were checked

Neither ladder was carried over from the first edit, because the material changed: the elephants
are the most motion-heavy shot in the film at 400 px (inter-frame |Δluma| 10.28 against 2.20 for
the wide escalade beat they helped displace) and a codec has to be asked again when that changes.
Both were re-derived from zero on the finished 621-frame cut.

| ask | VP9 → video | bytes | | ask | H.264 → video | bytes |
|----:|------------:|------:|-|----:|--------------:|------:|
| 1.60 | 1.72 Mb/s (+7.5 %) | **4,703,399** | | 1.65 | 1.71 Mb/s (+3.8 %) | **4,691,477** |
| 1.70 | 1.83 Mb/s (+7.6 %) | 4,979,553 | | 1.75 | 1.83 Mb/s (+4.3 %) | 4,980,328 |
| 1.80 | 1.93 Mb/s (+7.2 %) | 5,243,202 ✗ | | 1.85 | 1.91 Mb/s (+3.2 %) | 5,195,946 ✗ |

VP9 overshoots its ask by about 8 % on this cut and H.264 by about 4 %, and the rung above the
one shipped leaves twenty thousand bytes of headroom, which is not headroom. Both files carry
about three hundred thousand.

Both were then **decoded back and measured**, which is the only evidence that survives the mux.
The MP4 is walked as bytes first: `ftyp isom`, `moov` before `mdat` so an uploader need not
buffer the whole file, `avc1.640c1f` High profile level 3.1, and an `AudioSpecificConfig` of
`11 90` — AAC-LC, 48 kHz, stereo. Per-shot RMS is taken from the delivered **Opus** and **AAC**
tracks against the mixdown the cut wrote: the WebM agrees to within **−0.40 %…+0.14 %** and the
MP4 to within **−1.99 %…−0.28 %**. The MP4's outlier is `field-line`, the quiet opening shot, and
it is not this edit's: the shipped file reproduces it at −1.99 % on the same 1.4 s of audio.

**The AAC encoder-delay trap is still handled and still measured.** A plain MP4 written from raw
AAC frames carries no edit list, so nothing takes off the encoder's priming delay and an early
cut of this file came back 44 ms out of sync. 2,048 samples — two whole AAC frames — are taken
off in the PCM domain before encoding, and the delivered track cross-correlates against the
mixdown at a residual lag of **64 samples, 1.33 ms**, well inside one frame of picture, with an
envelope correlation of r = 0.9944.

Picture, against the source downscaled the way the encoder downscaled it and aligned first so the
number is compression rather than camera travel: **23.2–30.4 dB** for the WebM and **22.5–29.7 dB**
for the MP4 at 1280 px, worst case in both at the elephants, where the grass texture is what the
bitrate spends itself on. At 400 px — the size either file will actually be watched at — the two
are **25.3–29.8 dB** and **24.8–29.6 dB**, a gap of 0.26–0.72 dB, and they score 27.5–35.0 dB
against *each other*.

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
