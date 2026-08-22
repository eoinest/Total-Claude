# Trailer 2 — "War Machine"

> The ask was four words long: **short, high-action, exciting, with music.** The shipped trailer
> is 86 s and stately. This is **28.267 s**, eleven shots, no dissolves, no fade up at the head,
> and every cut on a measured accent in a licensed piece of music.

The film is a declarative shot script: **[`tools/shots/war-machine.shot.mjs`](../../tools/shots/war-machine.shot.mjs)**,
run by [`tools/film.mjs`](../../tools/film.mjs). Edit a beat and re-shoot it; nothing about this
cut lives anywhere else. The script's header carries the per-shot reasoning and the arithmetic;
this page carries the cut, the cues, the licence, and what the studio was missing.

```sh
node tools/film.mjs tools/shots/war-machine.shot.mjs --check          # the plan, no browser
node tools/film.mjs tools/shots/war-machine.shot.mjs --port=5973      # shoot it
```

---

## The cut, beat by beat, and the cue each one resolved against

Eleven shots. "Music" is seconds into the source track; the bed is its 166.240 s – 194.507 s.
Every one of those boundaries is a transient the onset detector found, not a round number.

| # | in | out | shot | scene | cue | resolved to | what it is |
|---|---:|----:|------|-------|-----|-------------|------------|
| 1 | 0:00.00 | 0:01.73 | `ele-charge` | Carthage, field | `contact − 3.2` | RES_1 | War elephants coming on behind the Punic shield wall, tracked, 40 → 28 m. Caption *CARTHAGE · Spring, 146 BC*. No fade up |
| 2 | 0:01.73 | 0:02.83 | `ele-arrest` | Carthage, field | `contact + 0.25` | RES_2 | The impact, **frozen** (`speed: 0`, 33 frames, no tick) with a scripted camera kick and a slow creep across the hold |
| 3 | 0:02.83 | 0:04.13 | `line-crash` | Campus Martius, field | `contact − 0.7` | RES_3 | Dawn: the two lines meet on `frontGap`, 70 → 56 m |
| 4 | 0:04.13 | 0:05.90 | `the-charge` | Campus Martius, field | `contact + 7.6` | RES_4 | The cavalry wing at the gallop, followed with a 0.4 s damped filter, 38 → 30 m |
| 5 | 0:05.90 | 0:08.47 | `the-city` | Carthage, assault | **t+12, fixed** | — | A crane over Carthage — the great wall, the ditch, four siege towers, the Byrsa — falling 96 m → 58 m. Lands on the loudest transient in the score (18.3) |
| 6 | 0:08.47 | 0:11.23 | `punic-towers` | Carthage, assault | `corpses ≥ 660, +8` | RES_6 | Siege towers docked on the Punic parapet, columns crossing onto the wall, on `contact`, at **2×** |
| 7 | 0:11.23 | 0:12.80 | `rome-host` | Rome, assault | `climbing ≥ 80, −8` | RES_7 | Siege towers still crossing the tomb field toward the Aurelian Wall, Rome behind it, at **2×**. Caption *THE AURELIAN WALL · Rome, 271 AD* |
| 8 | 0:12.80 | 0:13.73 | `escalade` | Rome, assault | `melee ≥ 140, +8` | RES_8 | **The only ladder shot in the film**, 28 frames: the wall face in raking light, men on the rungs, the garrison above |
| 9 | 0:13.73 | 0:22.60 | `the-gate` | Rome, assault | `gateOpen − 5.39` | RES_9 | **One take, 8.867 s.** The ram at the Porta Flaminia, one continuous Catmull-Rom push 46 → 30 m, and the leaves giving way inside a speed ramp to 0.45× |
| 10 | 0:22.60 | 0:24.77 | `the-road` | Rome, assault | `gateOpen + 2.5` | RES_10 | The column under the broken arch, elevated and close, at 0.7×. Outside, not through the arch |
| 11 | 0:24.77 | 0:28.27 | `endcard` | Rome, assault | `gateOpen + 14` | RES_11 | The wall with Rome behind it. Title, URL, the music credit, and a 0.9 s fade |

Hard cuts throughout. The only fades are the end card's, and **there is no fade up at the head**:
a feed video that opens on black has already lost, so frame one is a shield wall.

### Why these cues and not times

Every beat except the crane is hung on something the battle does. That is not ceremony — it is
what let the same script survive the fact that **Rome's circuit moved 157 m between the studio's
measurements and this shoot**. Two beats that would have been written as sim times are the gate
and the escalade, and both moved.

**The gate breaks at quality `ultra` again, and that is news.** The video studio measured, at this
exact seed and tier, the ram crew shot off the road at (68, 514) — sixteen metres short of a door
at (72, 530) — with **zero blows landed by t+520** and the gate never opening. Rome's re-surveyed
circuit (36 bays, three gates, a new assault determinism pin) changed that. Scouted here:

```
  cue gateBlow(1)   t+103.000
  cue gateOpen      RES_GATEOPEN
```

So the climax is the real one, and nothing in this film needed a quality tier chosen to make a
shot work. Everything is `quality: 'ultra'`, `unitSize: 'ultra'`, `difficulty: 'hard'`, seed
`4265438264` — the shipped battle.

---

## The music

| | |
| --- | --- |
| Title | **Song Of The Forge** |
| Creator | **Scott Buckley** |
| Source | <https://www.scottbuckley.com.au/library/song-of-the-forge/> |
| Licence | **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/> |
| Attribution | required, and reproduced in the film |
| Bed | the track's 166.240 s – 194.507 s, 28.267 s, gain 0.89, 0.03 s fade in, 0.9 s fade out |
| Bed level | RMS −15.81 dBFS, peak −1.93 dBFS |
| SHA-256 of the source file | `5be7859f5846bf80f93c4d936991e76616c8b147c178ba7e77b292191b3b5d48` |

The credit the licence asks for, in the creator's own wording, is burned into the end card's last
3.5 s and recorded in [`ASSETS.md`](../../ASSETS.md):

> 'Song Of The Forge' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au

**The material was modified**, which CC BY 4.0 §3(a)(1)(B) requires be indicated: a 28.267 s
window was excerpted and given a fade. Nothing was pitched, stretched, re-equalised or remixed.
`ASSETS.md` has the full verification trail — the licence quoted from the track's own page, the
single-hop download from the creator's own domain, the format allowlist, the magic-byte and
payload checks, and what this machine has and does not have for malware scanning.

**The two candidates that were rejected**, because a rejection is as useful as a choice:
Kevin MacLeod's `freepd.com` — the canonical CC0 source, and **offline as of August 2026**, with a
closure notice where the licence statement used to be, which is not something to build on; and
Pixabay, whose Content Licence is neither CC0 nor CC BY and whose redistribution terms are not
clean for a file that ships as a release asset.

### The cut is timed to the audio, and the audio was measured

No BPM was read off a web page. `tools/scratch/trailer2-music.mjs` decodes the file through
`OfflineAudioContext` in a Chromium page — there is still no ffmpeg on this machine — resamples to
48 kHz stereo, and does all of its measurement Node-side:

- a **spectral-flux onset envelope** at 100 Hz over a 1024-point Hann window and 40 log-spaced
  bins from 40 Hz to 8 kHz, mean-subtracted over a 2 s window so a loud section cannot out-vote a
  quiet one;
- **autocorrelation** over 0.25–1.5 s for the period, then a comb refinement: **0.7062 s, 84.96
  BPM**, first beat at 0.297 s;
- and a **peak list**, which is what the cut actually uses. Shot boundaries are the strongest
  transients in the finale, so no shot length is a multiple of anything — they are 1.733, 1.100,
  1.300, 1.767, 2.567, 2.767, 1.567, 0.933, 8.867, 2.167 and 3.500 s, and each is the gap between
  two accents quantised to whole frames. Cumulative drift against the audio is under half a frame
  over the whole film.

The finale's own shape is what the picture is hung on, and it is why the longest shot is where it
is: between 180.0 s and 183.2 s the percussion drops out for a choir, so the film's answer to
three and a quarter seconds with nothing to cut on is one long take rather than three cuts with
nothing under them. The percussion returns at 184.25 s, and the gate gives way on the 185.54 s
accent.

```
  166.2 .. 172.1   percussive, accelerating          four shots in 5.9 s
  172.1            the loudest transient (18.3)      -> the crane over Carthage
  174.7 .. 179.9   drive                             -> the Punic wall, then Rome's
  180.0 .. 183.2   a sustained swell, no percussion   \  ONE take on the gate
  184.2 .. 188.5   the drive returns, four accents    /  the break on 185.54
  188.9 .. 191.0   swell                             -> the road, after
  191.0            accent                            -> the card
  192.3            the last accent (17.5)            -> inside the card
  193   .. 194.5   the resolution, decaying          -> the fade
```

### How the sound reaches the file, given that the studio has none

`tools/film.mjs` deliberately ships no audio: the mixer schedules against
`AudioContext.currentTime`, and a capture that steps 848 frames through several minutes of wall
clock would pile the whole film into a few seconds of nothing. So this is a **music bed added in
the edit**, not captured game audio, and `trailer2-music.mjs` writes it as the interleaved 48 kHz
stereo Float32 buffer that `trailer-encode.mjs` and `trailer-mp4-encode.mjs` already take as
`--pcm`. No new capture pipeline was built and no existing one was changed.

**The game's own sound is not in this trailer**, and that is a loss worth naming: the 86 s cut's
audio is 89 procedural buffers synthesised in the page and recorded off the last node before the
speakers, and it is the more honest artefact. Doing both would mean running
`trailer-audio-pass.mjs`'s wall-clock-paced second pass over this plan and mixing the two, which
is a real piece of work — the pass has to rebuild the camera to place the listener, suspend the
context across every fast-forward, and it cannot do a speed ramp or a freeze at all, because a
frozen picture has no wall-clock duration to schedule into. **Four of eleven shots here are ramped
or frozen.** So this cut is music only, and a combined mix is the next thing to build, not a thing
that was skipped.

---

## Files

Four files out of one 848-frame sequence and one music bed. None of them is committed — they are
release assets, for the same reason the shipped trailer's four are: a video in a repository is in
every clone of it forever. They are handed over from `screenshots/trailer-2/`, which
`.gitignore` covers for `*.webm` and `*.mp4`.

| file | frame | codecs | bytes |
| --- | --- | --- | ---: |
| `total-claude-war-machine-1080p.webm` | 1920 × 1080 | VP9 + Opus 128 kb/s | **30,148,908** |
| `total-claude-war-machine-1080p.mp4` | 1920 × 1080 | H.264 High L4.0 + AAC-LC 128 kb/s | **28,189,388** |
| `total-claude-war-machine-720p-social.webm` | 1280 × 720 | VP9 + Opus 64 kb/s | **4,745,649** |
| `total-claude-war-machine-720p-social.mp4` | 1280 × 720 | H.264 High L3.1 + AAC-LC 96 kb/s | **4,760,735** |

All four are 30 fps and 28.267 s. **Both social files are under the five-million-byte ceiling** —
by 254,351 and 239,265 bytes — which is the same order of headroom the shipped social pair
carries, and it is deliberate: a file that clears the limit by eight kilobytes has not cleared it,
because the ceiling is applied after an uploader's own remux.

There are two of each because the owner asked for the pair on the last trailer and used it: X's
uploader takes MP4 and MOV and does not take WebM at all, and QuickTime Player has never read
WebM of any kind. The MP4s are High profile rather than Baseline (`avc1.640c1f` / `avc1.640c28`
as written by the encoder, `yuv420p`, progressive) and every decoder made this decade takes them.

**The 1080p pair is a master, not a delivery target.** 8.4 Mb/s of video over dust, smoke and
eight thousand moving men is roughly what the shipped 86 s master spends per second (130.2 MB at
12.1 Mb/s); it is meant to be re-encoded by whatever it is handed to, not streamed as-is.

### Why the audio bitrates differ between the two social files

Opus at 64 kb/s and AAC-LC at 96 kb/s are the same perceptual place, not two different decisions,
and the shipped social pair is asymmetric for the same reason. **The AAC number is also a floor
that had to be found the hard way:** `AudioEncoder.isConfigSupported` reports
`mp4a.40.2` at 64 kb/s, 48 kHz, stereo as **supported**, and then the encoder throws a bare
`EncodingError` on the first frame it is given. The probe lies; only an actual encode tells you.
96 kb/s is the lowest rate this Chromium's AAC encoder would accept, it costs 118 kB against the
5 MB budget, and the video rate was dropped from 1.25 to 1.17 Mb/s to pay for it.

### Verified out of the delivered files, not out of the pipeline

Every number above was read back from the file itself: a `<video>` element accepted all four and
agreed on the frame size and a 28.26–28.29 s duration; the muxed audio decoded through
`decodeAudioData` to 28.27 s of 48 kHz stereo at RMS −16.3 dBFS and peak −1.4 dBFS; played for
real through a `MediaElementAudioSource`, the analyser moved on 40 of 40 polls, which is the only
proof that the sound is routed somewhere and not merely present; and a still was seeked out at
every one of the eleven shot midpoints and its mean luma measured. **The darkest frame in the
film is the end card at 53.9 and the brightest is the crane over Carthage at 132.1** — so no shot
in any of the four files photographs black, and none of them photographs empty ground.

---

## What the studio was missing, and one thing it got wrong

Written as feedback on the shot format, which the brief asked for explicitly. Three of these are
defects — two fixed in `tools/film.mjs` on this branch, one worked around in the script — and the
rest are gaps.

### Fixed here: `fadeIn: 0` did not turn the fade off, and the film shipped opening on black

This one got all the way to a delivered file, and it is the reason this page's own claim to have
no fade up at the head is worth stating twice.

The runner defaults the first shot of a cut to a 0.8 s fade up from black, which is right — it is
the one measured editorial rule that survived every recut of the shipped trailer. A script says
otherwise by setting `fadeIn`, and `war-machine` sets `fadeIn: 0` with a comment saying why: a
feed video that opens on black has already lost, so frame one should be a shield wall. The test
was

```js
const inF = Math.round((isFirstInCut && !sh.fadeIn ? 0.8 : sh.fadeIn) * FPS);
```

and `!sh.fadeIn` is true for `0`. **A fade of zero and no fade at all were the same value**, so
the deliberate instruction was read as an absence and overridden by the default. The film was shot
with a 24-frame fade up that its own script had switched off, and nothing warned: the frames were
correct in every other respect, the cut was the right length, the encode was clean, and the only
tell was that frame 0 of the first shot was a **13 kB JPEG where every other shot's frame 0 was
about 700 kB**. The fix is `??` instead of a falsy test, and one shot — 52 frames — was re-shot.

Two things generalise. **A defaulted numeric option needs `??`, not truthiness**, anywhere zero is
a meaningful value, and in a camera format zero is meaningful for nearly every field. And the
cheapest detector of a black frame anybody has is the size of its JPEG; a `--stills` or shoot
summary that flagged any frame more than a few times smaller than its neighbours would have caught
this, the motion-blur smear below, and at least two of the framings under *What refused to shoot*.

### Fixed here: every shot's first frame was a full-screen motion-blur smear

`PostFX` gets camera motion blur by reprojecting the depth buffer through `prevViewProj`, and its
own comment says the quiet part out loud — *"a first frame blurred against it smears the whole
screen"*. It clears that matrix on a resize and nowhere else, because in a game the camera never
teleports. **In a film it teleports at every cut.** `runTo` fast-forwards with `{ render: false }`,
so the last matrix the post chain saw is the previous shot's last frame, tens or hundreds of metres
away. Frame 0 of every one of the first pass's shots came back as an unusable radial smear — at
eleven cuts, and in a 0.93 s shot that is 3.6 % of it.

The fix is one render with no tick before the frame loop: exactly the `speed: 0` mechanism,
`Time.paused`, so `beginFrame` returns zero steps, every visual system gets a `scaledDt` of 0 and
the accumulator is untouched. The simulation cannot tell it happened, which is why it is safe to do
in the runner rather than by shooting a throwaway frame and trimming the cut afterwards. Verified
by re-shooting: frame 0 of every shot is now sharp.

### Fixed here in the script, not the runner: cross-predicate cue contamination

**The scouting pass resolves a scene's cues on one forward-running clock.** It deduplicates by
predicate, so three shots on one `contact` are one answer — but a *different* predicate is
evaluated from wherever the previous one left off, and a simulation cannot be rewound. On this
film's first pass, `corpses(700)` (`before: 420`) was scouted before `gateOpen` (`before: 520`),
resolved at t+260.3667, and `gateOpen` was then asked from there and answered "already true, now":
**t+260.36666666665815**, the same tick to fourteen decimal places. That is the tell, and it is the
only tell — the run does not warn.

Worked around by hanging all three of the gate beats off one predicate. The general fix belongs in
the runner: either scout cues in ascending `before` order *and* record for each answer whether the
predicate was already true on the first tick examined, or run one scout per predicate from t=0 and
pay for the extra passes.

### Gaps

- **No anchor for "where men are climbing".** The single most photogenic event of an assault has
  `climbing` as a *finder* and nothing as an *anchor*, so a shot cut against the escalade has
  nowhere to point. `contact` is the workaround used here and it only works once men are actually
  in melee on the walk, which is 10–20 s after the first ladder goes up. A `climbing` anchor —
  densest 40 m cell of men in the climbing state, with the wall's axis — is the same shape as
  `corpses` and would have saved two scouting passes.
- **No cue for "the towers have docked".** `punic-towers` is cut against `corpses ≥ 660` because
  that is the only monotonic proxy available for a time; `climbing` fires 200 s too early, on the
  ladders. A `towerDocked(n)` finder would say what the shot means.
- **The end card has no credit field.** `endcard` takes a title, a tagline and a URL. A CC BY music
  bed requires an attribution line, so it goes in the `caption` slot with an empty `text`, which
  works and reads correctly but is a workaround. One more optional string — `endcard.credit`,
  small, bottom-centre or bottom-left — closes it, and any film with a licensed asset in it will
  want the same thing.
- **No `--scout` flag.** There is no way to resolve a film's cues and print them without also
  capturing. `--stills` is the cheapest path today and it still shoots three frames a shot; a
  scout-only mode over the same plan is a dozen lines and would have made the three exploratory
  passes this film needed much cheaper.
- **`--stills` does not tell you a shot is unsurvivable.** It photographs whatever the camera sees,
  including the inside of a city or the trunk of a cypress. The `film.json` record has the numbers
  that would catch some of it — `draws`, head counts — but nothing reads them. A `--stills`
  summary that flagged "this shot's frames have no soldiers in them" would have caught three of
  the four framings that had to be re-derived here.
- **`bay k` clamps silently.** `k` is clamped into range around the *first* gate bay, so on Rome's
  re-surveyed circuit every negative `k` resolves to bay 0 and eleven exploratory shots came back
  identical. Clamping is the right behaviour; not saying so is not. The example film's
  `bay k: -3` — "the unfinished stretch" — no longer means anything and now silently means bay 0.
- **A shot's `start` cannot be expressed relative to another shot's.** `the-gate`, `the-road` and
  `endcard` all had to repeat `find: 'gateOpen'` with different offsets. That is fine, and it is
  also what forced the discovery above; `after: 'the-gate', gap: 1.06` would be clearer.

---

## What refused to shoot

- **Pydna.** The plan had three Pydna beats: the crash on `frontGap`, a cavalry charge, and the
  whole engagement at 3× from 190 m. Shot at hour 8.2 from both flanks, the plain came back as a
  pale gold wash with the hosts barely reading, and the wide was the same failure the shipped
  trailer measured on `field-scale` at 400 px. The two field beats moved to the Campus Martius,
  which has trees, hedgerows and a river valley for the light to model. **Pydna is a good map and a
  bad photograph at dawn**; an hour nearer noon would probably fix it and there was no fourth
  scouting pass to spend on finding out.
- **`melee n: 1200` on the Campus Martius field battle.** It never fires: the cue ran to t+300 and
  refused, and the peak simultaneous melee in that battle is about 600. Lowered to 450 for
  scouting and 140 for the shot that shipped. This is the mechanism working — a hard-coded time
  would have photographed a thinner fight and said nothing.
- **`bay k: -3` at Rome**, and everything derived from it. See above.
- **The example film's ram framing.** `unitType: 'ram-crew'` with the annotated rail from
  `aurelian-gate.shot.mjs` now produces a 1080p photograph of brick and a shed roof: the crew is at
  (71.2, 520.1) and the gate at (72.0, 531.4) on the new circuit, and the geometry that framing was
  tuned for is gone. Re-derived from the gate anchor, and the shot that shipped ends on the
  shipped trailer's own poster framing.
- **The Carthage escalade as the Punic beat.** `climbing n: 60` at Carthage resolves at about t+40
  and photographs *ladders*, which would have been a second escalade shot and broken the one
  binding note in the brief. Moved to `corpses ≥ 660`, which lands where the towers have docked.

---

## Reproducing it

```sh
# 1. the frames (848 of them, 1920x1080, four page loads)
node tools/film.mjs tools/shots/war-machine.shot.mjs --out=/tmp/tc-trailer2/studio --port=5973 --noencode

# 2. the music bed, exactly as long as the picture
node tools/scratch/trailer2-music.mjs --in=SongOfTheForge.mp3 \
  --from=166.24 --frames=848 --fadein=0.03 --fadeout=0.9 --gain=0.89 \
  --out=/tmp/tc-trailer2/bed/music.f32 --port=5971

# 3. the keyframe list: an IDR on every cut, because a P-frame across a hard cut is the most
#    expensive frame in a fast montage and the ugliest one to get wrong
node tools/scratch/trailer2-cutmeta.mjs \
  /tmp/tc-trailer2/studio/war-machine/cut.json /tmp/tc-trailer2/bed/meta.json

# 4. the master pair, 1920x1080
#    (trailer-encode.mjs takes no --meta, so the master WebM gets a plain 90-frame GOP and
#     lands on 17 keyframes of its own accord; the MP4 gets the eleven forced ones plus its GOP)
node tools/scratch/trailer-encode.mjs \
  --cut=/tmp/tc-trailer2/studio/war-machine/cut.json --pcm=/tmp/tc-trailer2/bed/music.f32 \
  --out=OUT/total-claude-war-machine-1080p.webm \
  --codec=vp09.00.41.08 --bitrate=8000000 --abitrate=128000 --gop=90 --port=5975

node tools/scratch/trailer-mp4-encode.mjs \
  --cut=/tmp/tc-trailer2/studio/war-machine/cut.json --pcm=/tmp/tc-trailer2/bed/music.f32 \
  --meta=/tmp/tc-trailer2/bed/meta.json --out=OUT/total-claude-war-machine-1080p.mp4 \
  --w=1920 --h=1080 --codec=avc1.640028 --bitrate=8000000 --abitrate=128000 --gop=90 --port=5976

# 5. the social pair, 1280x720, each under 5,000,000 bytes
#    Both bitrates were set by measuring, not by arithmetic: VP9 overshot a 1.25 Mb/s request by
#    12 % and delivered 5,220,366 bytes, and H.264 overshot a 1.25 Mb/s request by 5 % and
#    delivered 4,992,058 — 7,942 bytes under the ceiling, which is not under the ceiling. The
#    numbers below are the second pass at each.
node tools/scratch/trailer-tw-encode.mjs \
  --cut=/tmp/tc-trailer2/studio/war-machine/cut.json --pcm=/tmp/tc-trailer2/bed/music.f32 \
  --meta=/tmp/tc-trailer2/bed/meta.json \
  --out=OUT/total-claude-war-machine-720p-social.webm \
  --w=1280 --h=720 --codec=vp09.00.31.08 --bitrate=1120000 --abitrate=64000 --gop=150 --port=5977

node tools/scratch/trailer-mp4-encode.mjs \
  --cut=/tmp/tc-trailer2/studio/war-machine/cut.json --pcm=/tmp/tc-trailer2/bed/music.f32 \
  --meta=/tmp/tc-trailer2/bed/meta.json \
  --out=OUT/total-claude-war-machine-720p-social.mp4 \
  --w=1280 --h=720 --codec=avc1.64001f --bitrate=1170000 --abitrate=96000 --gop=150 --port=5978
```

The source audio file is not committed; `ASSETS.md` has its URL and SHA-256, and step 2 is a pure
function of it. The frame sequence is not committed either, for the same reason the shipped
trailer's is not: re-running step 1 reproduces it, which is the point of the format. Delete
`/tmp/tc-trailer2/studio/war-machine/frames` once the four files exist — it is **462 MB in 848
JPEGs** and this machine has been taken down once by Spotlight indexing a tree of agent frames.
The work directory carries a `.metadata_never_index` marker from the moment it is created.

`OUT` above is wherever the files are being handed over from; on this branch it was
`screenshots/trailer-2/`, which `.gitignore` already covers for video.

**Every cut resolved.** For the record, because a film cut against events is only as good as the
events firing, this is what the shoot's own `film.json` recorded — cue value, then the frame the
shot actually started on:

```
  ele-charge     contact    t+72.000     -> t+68.800    (-3.2)
  ele-arrest     contact    t+72.000     -> t+72.250    (+0.25)
  line-crash     frontGap   t+64.433     -> t+63.733    (-0.7)
  the-charge     frontGap   t+64.433     -> t+72.033    (+7.6)
  the-city       —          fixed        -> t+12.000
  punic-towers   corpses660 t+238.367    -> t+246.367   (+8)
  rome-host      climbing80 t+19.233     -> t+11.233    (-8)
  escalade       melee140   t+44.233     -> t+52.233    (+8)
  the-gate       gateOpen   t+213.833    -> t+208.443   (-5.39)
  the-road       gateOpen   t+213.833    -> t+216.333   (+2.5)
  endcard        gateOpen   t+213.833    -> t+227.833   (+14)
```

**And the gate really breaks on camera.** `the-gate` runs t+208.467 to t+215.27 of simulation, so
`gateOpen` at t+213.833 falls inside it; the arithmetic in the shot's own header puts the break at
footage frame 168 of 266, and photographed, the leaves are in place at frame 150 and gone at frame
170, with the sunlit road visible through the arch. That is the check the shipped trailer's gate
beat did not get, and it is the one that matters, because a gate cut against a hard-coded
timestamp in this project once filmed a door that never opened.
