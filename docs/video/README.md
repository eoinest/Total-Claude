# The trailer

**[Download `total-claude-trailer.webm`](https://github.com/eoinest/Total-Claude/releases/download/r6/total-claude-trailer.webm)**
— 84 s, 1600×900, 30 fps, 14.2 MB, silent.

Attached to the [r6 release](https://github.com/eoinest/Total-Claude/releases/tag/r6) rather than
committed, so it does not sit in every clone forever. The poster frame and the shot list are here;
the video is one download away.

![The Porta Flaminia during the assault: two round brick towers flanking a stone-voussoired arch
with a portcullis behind it, a hide-roofed shed on timber posts standing in the gate mouth with its
crew packed underneath, broken timber lying in the passage, and infantry drawn up on the road to the
right.](trailer-poster.jpg)

Every frame is live simulation. Capture is a JPEG sequence rather than a screen recording: one frame
is one `engine.advance(1/30, 1000/30)` — the same `Engine.frame()` the rAF loop calls — with the rAF
loop stopped and the clock driven by the capture, so 30 fps playback is real time and a shared GPU
cannot drop frames. The tool throws if `simTime()` moves by anything other than 1/30 s between
consecutive frames, and that is asserted on every frame of every beat.

See [`SHOTLIST.md`](SHOTLIST.md) for the fourteen beats, their sim times and their cameras.

## One thing the trailer could not show

The gate breaks and nobody comes through it. 26 blows, `gateReport().open` first true between t+210
and t+215 — and **zero attackers cityward of the door plane at every sample from t+200 to t+300**.
The crowd outside thins from 77 to 10 as it is shot off the road, while 12–34 men stand on the walk
*above* the open arch, having come up a tower. So the climax is the ram and the moment the leaves
give, and the shot of men going through is at Carthage's tower ramps instead. It was not staged,
because it does not happen.
