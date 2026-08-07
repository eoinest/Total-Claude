# Handoff — live state

Written after a machine crash took down seven background agents at once. This is the state
that must survive a context compaction. Update it, do not let it rot.

## Agent roster and where each one was

All seven were mid-task when the machine crashed. Their transcripts are on disk and each can be
resumed with `SendMessage` to its id; resuming replays its own context, so a short "resume,
here is what changed" message is enough.

| id | workstream | last known position |
|---|---|---|
| `abfdfd21b8a18fae1` | Melee: stalled fights, chokepoint, `R`, stragglers | **FINISHED** — committed `ab8b957` |
| `a6cc76a93cdfce176` | Wall geometry: wider curtain, parallel stairs, scaffolding inside, gate shut | fresh agent; predecessor's transcript died in the crash |
| `ace11fa044ae8d5a8` | Siege: wall traversal, gate breach, heavy ram, tower ramp, **ram jamming the gate** | writing the public order API and plan executor |
| `aebaeeaacbc24699a` | Artillery: wrong projectiles, catapults off walls, slinger zero damage, **+ GroundDamage shadow bug** | building `damage-shadow.mjs` |
| `a5e7269998ab37764` | Rome streets: quilt, wider streets, monument overlap, **owns the YouTube reference** | fresh agent; predecessor's transcript died in the crash |
| `a26c20d608c42a659` | Lighting: chromatic ground bounce, the missing π | both halves written, measuring |
| `a179733306e97836f` | Blind critic: A/B against Rome II, reference sourcing | round 21 done, 20/20 |
| `a2ca69d0ce89dcaae` | **Anti-aliasing, mip and specular filtering** | new — owns the leading separator |

**The crash was Spotlight, not the agents' servers.** Load hit 20 with *zero* node processes:
`fileproviderd` 118%, `mds`+`mdsync` 76%, indexing **9.3 GB of agent screenshots across 287
directories**. Fixed with `.metadata_never_index` in `screenshots/` and `reference/`. Seven agents
rendering battles headlessly sustains load ~33 on 16 cores with 93% memory free and zero pageouts,
which is saturation, not the crash signature. Every agent must still delete its screenshot
directory when it finishes.

## Tree state

`HEAD` is `51d50be`, and **it boots** — verified by loading the page and reading
`window.__game.ready`, not by typecheck.

**`5ec90a5` through `148f394` did not boot at all.** `5ec90a5` committed `UnitRenderSystem.ts`
with four call sites against `engines.ts`/`Projectiles.ts` code that was never staged with it:
`engineAnchor` (an ESM binding error at import, fatal to the whole app) and
`projectiles.engineCycle`/`.engineTargets`/`.engineSite` (`?.` guards a null receiver, not a
missing method). Two more commits were stacked on a tree that had never run, including a camera
fix whose entire justification was screenshot framing. Fixed at `d7b2a58`. The Vercel build fails
on an unresolved named import rather than shipping it, so the live site was never affected.

Landed since: `55d8c54` camera, `148f394` clock, `d7b2a58` boot, `ab8b957` melee, `51d50be` blind
harness. The working tree still carries in-flight agent work and currently has a **runtime** TDZ
throw in `insulae.ts` (`terrace()`, `keep` before initialization) that kills the page at module
init — it typechecks clean, so `tsc` will not catch it.

If work must be parked: `git stash push -u -m "..."` the agent files and `git stash pop` to
restore. **Never commit a subset of a multi-file change** — that is exactly what broke mainline.
Verify a candidate commit set by grafting only those files onto a detached worktree at `HEAD`
and typechecking there, then load the page.

## The player's outstanding list, with owners

Everything below came from the player. Items not listed here are done and committed.

- **cast shadows have no silhouette** — *unowned, and it is a design decision, not a bug.*
  Diagnosed but deliberately not attempted; the lighting workstream wound down here. The cause
  is not the shadow filter. The PCSS blocker-search theory (that its disc, up to 38 cm at
  cascade 1, is wider than the gap between two men and so saturates inside a formation and
  forces the widest blur) was tested in-session across all 231 materials and moves the frame by
  **0.009-0.017/255 over 0.00% of it** — dead. The real cause is that **nothing but the crowd
  casts**, so the formation's wedge has no environment of smaller shadows to sit among. Turning
  either candidate on is real work, not a flag:
  - *Terrain* (`TerrainSystem.ts:111`) has a correct `depthMaterial` already, so it is one flag —
    but it is off because the clipmap's outer levels carry 8-32 m triangles that the outer
    cascades cannot bias against a heightfield-resolution normal, and the middle distance breaks
    out in an acne lattice. It needs **slope-scaled bias per cascade** first. That is a lighting
    job and the per-cascade ortho extents it would need are already computed in `LightingSystem`.
  - *Grass* (`GrassField.ts:723`) is **not** a flag flip. The cards are alpha-tested and
    displaced by wind in the vertex shader and there is no `customDepthMaterial`, so enabling
    casting would shadow the undeformed opaque quad — solid rectangles, not blades, and not
    matching the sway. It needs a depth material replicating both, and then the fill cost of a
    dense camera-centred mesh with `frustumCulled = false` across seven clipmap levels. Judge
    that cost against `SHADOW_CULL_MARGIN`, which was once claimed to be free and measured
    0.88-1.78 ms.
  Whoever picks this up: interleave the A/B in one session (see traps), and note the
  anti-aliasing work has since changed grass rendering — MSAA, alpha-to-coverage and
  coverage-preserving alpha mips — so any grass cost measured before `023240d` is stale.

- ~~gate chokepoint snaking~~ — **done** `ab8b957`, lateral drift 0.202 → 0.063 m/s
- ~~units standing face to face not fighting~~ — **done** `ab8b957`, 0 → 708-772 blows in 60 s
- ~~`R` run key does nothing~~ — **done** `ab8b957`, sim-side 1.55 → 3.383 m/s
- ~~stragglers stuck behind the wall~~ — **done** `ab8b957`, 94 → 30 stranded
- ~~wall much wider; stairs parallel not perpendicular; scaffolding inside~~ — **done, uncommitted
  in `src/city/wall.ts`.** Curtain 3.5 → 6.0 m (`CURTAIN_T`), clear standing band 1.57 → 2.21-4.06 m
  (4-6 ranks at the sim's 0.72 m pitch, was 2); nine flights parallel to the face, 14.2-20.4 m along
  against 3.28-3.79 m of projection; scaffold, crane and deck all on the city side. `probe-wall`
  19/19, up from 12 assertions — the seven new ones measure exactly these.
- ~~gate shut by default~~ — **done, uncommitted.** `GateOut.open` is `false` at build time, the
  leaves are modelled shut with a drawbar and a bricked lunette, and `CitySystem` no longer clears
  the carriageway out of the occupancy grid for a shut gate. Siege opens it with
  `setGateOpen('porta-flaminia', true)`.
- soldiers use stairs, move laterally along the wall, descend into the city — siege
- much larger wall-breaking ram — siege
- tower drawbridge backwards (ropes forward, door opens backwards) — siege
- **ram jams the gate it just broke** and cannot rout because it is a machine — siege
- scorpion/catapult fire arrows instead of bolts and stones — artillery
- big catapults off the walls, manned, immobile, aiming, animated — artillery
- streets read as a patched quilt; wider and more streets; monuments dropped across housing — streets
- **trampled ground receives no shadows** — artillery (owns `src/vfx/`)
- soldiers at 2-4% luminance — lighting

### Masonry: what was left on the floor

The named separator — "every recess is painted rather than modelled, the sharpest instance being
brick coursing that shows identical contrast in sunlit and shadowed regions under raking light" —
is fixed at the *material* level and the workstream was wound down there. What was found and not
chased:

- **A 55 mm course cannot resolve at the distance the deck is shot from, and never will.** At the
  `wall` camera the curtain is 90 m away at ~14 screen px/m, so a course is 0.8 px and the sampler
  is at mip 4-5. The whole brick tile contributes **1.7% of that frame's visible micro-structure**
  after the fix and 2.1% before it; the other 98% is geometry and grain. Any further work on the
  *tile* is invisible at battle range by arithmetic. What reads at 90 m in the reference
  photographs of the real wall is **metre-scale geometry** — relieving arches, string courses,
  buttress masses, patch repairs — which is `wall.ts`, not `texgen.ts`.
- **No geometry in this project carries vertex tangents.** `computeTangents` appears nowhere;
  three.js falls back to the screen-space derivative frame. That is legal and it measurably works
  (the relief channel's sunlit-to-shaded ratio is 3.5), so it was not the cause — but it is a
  standing cost on every normal-mapped surface and nobody has priced it.
- **The shipped `wall` camera is not a raking camera and its subject is not raked either.** Its
  sun-versus-camera bearing is +22 deg. Worse, the sun bears 33.2 deg and the curtain's inner face
  normal bears 21.5 deg, so the sun hits the one large brick surface in the deck **12 deg off
  normal** — the flattest light available — while the outer face bears 201.5 deg and is in shade at
  every hour, exactly as the shot table's own comment says. The surfaces that are actually raked
  are the ones turned 90 deg out of the curtain: tower flanks and merlon returns.
  `probe-masonry.mjs` carries a `walltowers` framing at +102 deg that photographs both flanks of
  the same towers, one lit and one shaded. **The deck has no masonry frame that grades masonry.**
- The de-painting in `travertineAshlar`, `basaltPaving` and `roofTiles` is **inert as shipped**:
  those keys have a `manifestId` and `public/assets/manifest.json` exists, so they take the
  photographed path. It only bites with an empty asset folder. The photographed sets get openness
  from an `ao` map when the manifest lists one, and 255 (unoccluded, a no-op) otherwise — **no
  manifest entry currently supplies one.**

Done: flags now use the median soldier (`5e5ce44`); soldier materials (`5ec90a5`).

## Measured facts that must not be re-derived

- **Rome is NOT short of roof, and "20.5 % built" was an instrument reading its own streets
  as failure.** `city-audit.mjs` built its street keep-out from `layout.ts`'s exported
  `WAYS` — the twenty-two named viae, 11 km. The district generator cuts a further **374
  lanes and 38 km**, and nothing outside `wayMix`'s running total could see them, so every
  vicus in the city was scored as unbuilt ground: 39 hectares of carriageway counted as a
  gap. With the lanes in (`CitySystem.getLanes()`), the same unchanged city reads
  ways 17.4 → **24.9 %**, free 35.6 → **28.1 %**, and **roof between street lines
  53.9 → 68.7 %** — inside the 60-70 % the AGEA orthophoto gives for the historic core.
  Do not "fix" the density; it is in band. Of the free ground that remains, **63 % lies
  under no district mask at all** (17.7 % of walled land) and only 29 % is inside a
  quarter's plateau. The real remaining difference from the orthophoto is **grain, not
  coverage**: AGEA's blocks are smaller and each is punched with 1-4 courts of 10-25 m,
  where ours are larger with one big court; their vici are 4-8 m and far more numerous.
  Aim the next pass at finer grain, not more roof.
- **The 60 m pomerium is met exactly, and `openGroundBehindWall min 40` was the instrument.**
  `probe-nav` sampled x −650..1200 against a `wallZAt` that clamps to the last segment,
  but the curtain ends at **x = 1144**. The four reported "intrusions" at x 1174-1198 are
  30-54 m *past the east end of the wall*, measuring a depth from a frozen z-line with no
  masonry near it. They were labelled `wall` by nearest-**centre** — the Castra Praetoria's
  278 × 262 m footprint has its centre 200 m from its own corner, while a curtain bay's is
  30 m away. Restricted to the wall's real span and labelled by **containment**: min
  **60.0 m** over 220 samples, zero intruders. Neither `POMERIUM` nor the curtain alignment
  was wrong. The Castra crosses the crest by **−18.6 m** (it is 18.6 m inside), so even its
  documented `atWall: 0.02` licence is unused.

- **The crowd is the only thing casting a shadow in a battle frame.** `probe-shadow.mjs`'s
  `all shadows` and `crowd shadows` arms return *identical* figures at both close cameras
  (9.768/255 over 22.80% at `romanline`, 9.851/255 over 17.73% at `raking`). `TerrainSystem`
  sets `castShadow = false` and so does `GrassField`, so there are no hill shadows and no tuft
  shadows — only men, horses, engines and some city meshes cast. This retires a critic note:
  "individual grass tufts a metre away cast crisp shadows while the formation drops one merged
  grey wedge" is comparing a cast shadow against grass **self-shading**, because grass casts
  nothing. The wedge reads as pasted on because it is the only cast shadow in the frame, with no
  environment of smaller shadows to sit among. See the missing-casters entry under the
  player's list for what each would cost.
- **The shadow noise floor is 0.000/255, not the recorded 1.42-1.47.** That figure was
  established before `Engine.advance` was found to be running five sim ticks between the two
  frames it called "no change at all". With the clock paused the floor is exactly zero, so every
  shadow result previously declared clean against 1.42 was declared against a moving world.
  Crowd shadows at `wide` measure 1.033/255 over 2.92% — under the old bar that was
  undetectable; it is real, just small.

- ~~Soldiers render at 2-4% of display luminance.~~ **RETRACTED — a unit error, and it
  misdirected three rounds of work.** `probe-units.mjs` reports *display-linear* values, as its
  own header says; 0.0354 / 0.0316 / 0.0204 linear are **0.207 / 0.196 / 0.157 display**. A second
  independent instrument agrees: soldiers 0.1745 display, ground 0.3126 (which is the "~30%
  ground" figure, so *that* one was display all along — the comparison mixed two unit systems).
  Rome II plates measure **0.2957 display / 0.1068 linear**. The true gap is soldiers ~0.17-0.21
  against ~0.25, about **1.4×, not 8-12×**. This is why three successive fixes each measured a
  real gain and each still felt like nothing: they were sized against a target 8× too far away.
  A fix sized for 8× would wreck the frame. There *is* still something to fix — a quarter of
  soldier pixels sit below 0.059 display and the median is 0.125, genuinely bottom-heavy — but
  size it for 1.4×.
- **The hemisphere fill drops a factor of π**, confirmed against three.js shader source.
  `getIBLIrradiance` returns `PI * envMapColor * envMapIntensity` — an irradiance.
  `getHemisphereLightIrradiance` returns `mix(ground, sky, w)` with **no** π, so its colour must
  already be an irradiance. We pass `skyFillColour`, which `atmosphere.ts` computes as a
  cosine-weighted mean *radiance*. Measured live, the fill delivers **10.9%** of the sky's own
  physically-derived irradiance (E(up) 0.0494 against π·L = 0.4529). The scattering integral is
  right; its application is wrong. The two ambient paths in the rig are quoted in different units.
- **Aliasing is the leading separator, and it is the only measure that has ever split the decks
  cleanly.** harshness = (full-res Laplacian energy) ÷ (Laplacian energy after a 4× low-pass); a
  ratio, so prior JPEG on the press plates cancels. **Ours 0.879-1.515 (mean 1.137), Rome II
  0.290-0.650 (mean 0.427) — 100% separation with an empty gap.** Not a detail deficit: Rome II's
  `frame-03` has the highest structural detail in the deck at 32.26, above eight of our ten. Ours
  is *inverted* — more energy at pixel scale than at structure scale, the signature of missing AA,
  mip and specular filtering. Symptoms two graders reached independently: untapered aliased spear
  lines, flat quadrilateral shields, grass legible to the horizon then stopping at a hard seam.
  **The ratio is one blur away from being gamed and must never be quoted alone.** A Gaussian of
  σ ≈ 0.6-0.8 px takes it from 1.656 to 0.464 — straight through the whole gap — because it is
  dominated by the final image's sub-pixel point-spread function and cannot tell "well filtered"
  from "slightly soft". Cross-check every movement against `tools/probe-shimmer.mjs`, which
  measures sub-pixel temporal stability and which a blur cannot fake, and **treat a sudden
  collapse in the ratio as suspicious rather than as progress.**
- **Do not raise ambient.** Darkest-quartile luminance: **ours 0.159, Rome II 0.122** — our shadows
  are already 30% brighter. Warm/cool separation, (b/r in darkest quartile) ÷ (b/r elsewhere):
  **ours 1.11, Rome II 1.85**. So the defect is *hue muddle at too high a level*, not darkness:
  our lit and shadowed pixels are nearly the same hue. The fix is more contrast between the two
  ambient hemispheres at equal or lower total, which is what the chromatic ground bounce does
  (sky-to-bounce hue contrast 3.55 → 9.3 at luminance 0.1013 → 0.1016).
- **A procedural normal map is gone by the time anything is 40 m away, and no `normalScale`
  fixes that.** Measured on the brick tile: mean tangent-space |n.xy| runs 0.271 / 0.254 / 0.237 /
  0.144 / 0.043 / 0.031 down the mip ladder — **84% of the perturbation is lost by mip 4**, because
  a bump's two slopes are equal and opposite and cancel under averaging. An albedo band has a
  non-zero mean and survives. That asymmetry is *why* every recess in this project reads as paint,
  and it applies to every generator in `texgen.ts`, not just brick. The counter is a **scalar**
  derived from the same height field: occlusion averages like brightness. `texgen.horizonOpenness`
  bakes one into the ORM texture's R channel (which was a hard-coded 255 read by nothing) and
  `materials.MICRO_RELIEF_PARS_GLSL` spends it on the direct light. Landed for masonry; **soldier
  kit, terrain and engines all have the same defect and none of them have the counter.**
- **Measuring "painted versus modelled" needs arm differencing, not a single frame.** Band-pass
  amplitude over a whole frame is dominated by geometry edges and grain — at the shipped `wall`
  camera the brick tile is only 1.7-2.4% of it — so a real change hides inside the noise.
  `tools/probe-masonry.mjs` removes one channel at a time from the live material and differences
  frames of an identical *paused* world; the reproducibility floor of that difference measures
  **0.00000**, so anything above zero is signal. That technique is general and worth reusing.
- **The crowd is NOT short of variation.** Read from the uploaded instance buffers: one 320-man
  cohort carries 57-59 kit masks, 119 statures, 229 cadences, 314/320 distinct animation phases,
  252 tunic colours. Adding variation is the wrong fix.
- Raising metalness *darkens* armour here — verified twice. Full metal trades a sunlit diffuse
  term for a dim blue sky reflection under a sun-dominated rig with a weak probe.
- `LightingSystem.ts:87` hemisphere fill is `0x9dbcdc / 0x6b5a3e` at 0.42, set to 0.34 at line 477,
  against a sun at 2.93.
- `GroundDamage.ts:352` sets `receiveShadow = false` on a raw `ShaderMaterial` at `renderOrder 1`,
  so trampled ground paints out the terrain's shadow.
- True frame times are melee 8.31 ms, clash 8.88 ms. **Every fps figure in this project's history
  before the harness clock fix was roughly double the truth.** Confirmed from the other side at
  `a974a28`: a *real interactive* session — page-driven `requestAnimationFrame`, HUD up, camera
  panned, rotated and zoomed, units drag-selected and right-click ordered — measures
  `engine.frame()` at p50 **9.1 ms**, p90 11.0, mean 8.84, over 927 frames at machine load
  27-42 (`tools/probe-interactive.mjs`). The rAF interval in that session is p50 25 ms, but
  that is headless compositing and six other agents, not this codebase.
- `fixedUpdate` 3.657 ms at 8,632 men idle, 3.964 ms routing across the wall, against a 4 ms budget.
- **The frame is a small colour pass and a large shadow pass, and only the second scales with
  tier.** Rome assault at ultra: 98 colour + 98 shadow + 23 post = 219. The colour pass is
  96-101 at *every* tier. **A casting mesh costs one call in the colour pass and one more per
  cascade — five on ultra.** Cascade 0 (39 m across) draws the same objects as cascade 3
  (745 m), because every caster is a merged mesh that straddles all four. Full per-camera
  per-tier table in `ARCHITECTURE.md` §4; worst is the assault at 219 against the 220 cap, and
  panning in a live session touches 226.
- **Soldier draws are 6, not 121-122.** Read off the live scene at t+72 s: the unit render
  group submits six meshes carrying 826-1,210 instances. The ≤12 target is met. The 121 figure
  is stale — it looks like a whole-frame count that got filed under soldiers.
- **The assault camera has never been inside the 220 cap, and the last forty commits cost it
  five draws.** Bisected with `tools/bisect-draws.mjs`, a worktree and a vite and a boot per
  commit: **254** at `9639c4c`, the commit that *created* the assault scenario, and **259** at
  `7a313fe`. There is no culprit commit and nobody should go looking for one.
- **MSAA costs about 1.2 ms, and 2x is not worth having.** Eight camera-measurements over two
  interleaved sessions at loads 42 and 60, wall-clock best-of-blocks. 4x against none:
  −1.56 −1.70 −0.77 −1.01 −0.55 +0.42 −2.11 −1.35, median **1.18 ms**. 4x against 2x:
  +0.36 −0.34 −1.15 +0.32 +0.15 +0.71 −0.15 −0.45, median **0.07 ms**. So the author's claimed
  +1.1 ms was right, and **the cost is in having a multisampled target at all, not in the
  sample count** — 2x pays 94 % of 4x's price for half the samples. `MSAA_SAMPLES` should read
  0 or 4 and never 2; `medium: 2` is the worst cell in that table.
- **Anisotropy 16 → 8 is not a lever**: −1.03 to +0.90 ms across four cameras, inside the
  noise, on a change already measured as worth 0.008 on image quality. Grass density 100 → 50 %
  is worth 0.55-3.71 ms and is the largest single knob at the wide and city cameras. The whole
  post chain is worth 1.6-3.5 ms and 22-25 draws.
- **The driver caps MSAA at 4 here.** `renderer.capabilities.maxSamples` is 4 under headless
  ANGLE-on-Metal, so an 8x arm silently resolves to 4x and would measure as free.

## Traps that have already cost time

1. **Probes silently fall back to a stale `dist/`** if no dev server is on their port. This made
   `probe-wall` report 5/12 when the live tree scored 12/12. Always pass a port whose server you
   started and read the tool's first line.
2. **`tsc --noEmit` goes blind to every semantic error program-wide** the moment any file has a
   syntax error. Use `node tools/typecheck.mjs --mine=<path>`; INCONCLUSIVE (exit 2) is not a pass.
3. **Vite HMR resets `window.__game` mid-measurement** when another agent saves. Run probes with
   `TC_NO_HMR=1`.
4. **Killing vite by `grep -v "port 5173"` misses the dev server**, because `npm run dev` puts no
   port on its command line. This has killed the player's server three times.
5. **`RTSCamera.jumpTo` parked the focus at y=0** — sea level — then let `update` float it up
   to terrain height at damp rate 9. A quarter-second after a jump the eye is still 10.5% of
   the terrain height low. Every graded plate was shot through a climbing camera, and the
   player got an unrequested swoop on every load. **Fixed** — `jumpTo` now samples `heightAt`.
   Any framing measured before this fix is suspect.
6. **Cross-session before/after is not a measurement on this project.** Two runs at identical
   configuration and identical shot order differ on **50-70% of pixels at a mean of 17-27/255**,
   because dust and particle VFX reseed per session even with the sim clock paused. A
   `THROW_MAX` change was nearly shipped on the strength of eyeballing two such runs; it looked
   convincing and was entirely reseeding. **A/B must be interleaved in one session, both arms
   reported.** Any past finding judged by shooting twice and comparing needs re-checking.
   Two practical notes: whole-frame gradient energy agrees to under 1% across a change that
   alters nothing, so the *metric* is not what fails — the frames genuinely are not comparable;
   and re-shoot the base arm **last** in every run as a drift check, because that is the only
   thing that distinguishes "my change did nothing" from "my arms did not restore".
7. **A number that cannot be true given its neighbour is this project's best bug detector.**
   Four silent no-ops have been caught this way: a probe arm reporting 0.000 beside a sibling
   reporting 9.7 (it flipped `renderer.shadowMap.enabled` without a recompile, and
   `USE_SHADOWMAP` is compile-time); the sun scoring as a *negative* light contributor; a
   metalness delta of exactly `0.0000` (the material already shipped `metalness: 1`); and a
   stale uniform lookup after a rename. In every case the arm never ran. Check the *shape* of a
   number before its value.
8. **The 1.42-1.47/255 shadow noise floor was a moving-world artefact.** Paused, the true floor
   is **0.000/255**. Every shadow result ever declared clean against that bar was declared
   against a world moving five sim ticks between frames.
9. **A typecheck is not proof of life.** Three commits stacked on a tree that white-screened.
   `tsc` cannot see a missing runtime method behind `?.`, an ESM binding error, or a temporal
   dead zone. Load the page, read `window.__game.ready`, and **capture `pageerror` and
   `console`** — without them a dead app is indistinguishable from a slow boot, and agents have
   lost hours to unexplained 180-second timeouts.
7. **A comment on this codebase is a hypothesis, not a fact.** Three found in one session:
   `atmosphere.glsl.ts` claimed "warm up-light" from a term with no hue, `probe-shadow.mjs`
   claimed `advance(1e-6)` was a microsecond when it was 0.13 s, and `jumpTo` implied a jump
   when it was a floated climb. When a measurement disagrees with what you can see, suspect the
   instrument first — that rule has now paid out five times.
8. `git clean -fd` in a verification worktree **deletes the `node_modules` symlink**; pass
   `-e node_modules`. **`git stash push -u` takes it too**, for the same reason — it is an
   untracked entry — and the failure lands one command later as `Cannot find package
   'playwright'`. A bare `sleep` is blocked in a backgrounded Bash call (exit 144) — use an
   `until` loop, and prefer the foreground for anything that must wait on a dev server.
9. Machine load makes frame timing meaningless — an *unchanged* tree has measured slower than a
   changed one. Use in-session interleaved A/B and report both arms. **Prefer the best block
   over the median**: contention is one-sided, so it can only add time, and the minimum over
   N blocks converges on the uncontended cost while the median tracks whatever else the machine
   is doing. `tools/probe-cost.mjs` reports both and flags the run when they disagree.
10. **Clearing `castShadow` does not switch the shadow pass off, and two probes think it
   does.** `LightingSystem.update` assigns `l.castShadow = lit` to every cascade light on
   *every frame* (line ~455), and lighting has order −100, so it runs before anything else can
   see the flag. The `shadowRender` knob and the `noshadowrender` arm in
   `tools/probe-perf-ab.mjs` are therefore silent no-ops, and any conclusion drawn from them
   should be re-checked. The working switch is `renderer.shadowMap.autoUpdate = false` with
   `needsUpdate = false`; `WebGLShadowMap.render` returns immediately on that and nothing in
   this codebase touches either. Signature of the fault, again: the arm reported the shadow
   passes at *exactly zero* draw calls.
11. **`EXT_disjoint_timer_query_webgl2` is available here and it does not work.** It is
   exposed by launching Chromium with `--enable-webgl-developer-extensions`, and it looked
   like the answer to a loaded machine. At `melee` it reports 51.2 ms of GPU per frame inside
   a block whose wall clock, drained by `readPixels` at both ends, is 16.1 ms — the GPU cannot
   spend three times the elapsed time of a drained interval. Its deltas are inflated in
   proportion: the post chain reads −35.5 ms against −6.0 ms of wall. Trust it for the *sign*
   of a difference and never for a millisecond.
12. **`src/maps/carthage.ts` still has `city: null`.** Carthage's triple wall, its 59
   casemated bays and its 30 towers exist in `src/city/carthageWall.ts` and are not reachable
   from `?map=carthage` at `7a313fe` — the map hands over no plan, so `main.ts` registers no
   `CitySystem` and `probe-boot-carthage` prints `city: absent`. Verified against a clean HEAD
   checkout, so it is not a regression, but any Carthage measurement quoted from a running
   game — including "19 visible wall meshes against Rome's 29" — was not taken on that map.

## Grading

`tools/blind-compare.mjs` against `reference/rome2/` (ten Rome II press plates), built from
`tools/shoot.mjs --set=deck`. `reference/siege/` (25 user images) and `reference/rome3d/` (YouTube
stills) are **mechanics and layout reference only, never blind-deck plates** — mixed provenance
would flatter or unfairly penalise us.

### The separation record, audited — do not quote the old number

**"Twenty-three rounds, twenty-three separations" was in every workstream's brief and it is not
a defensible claim.** It was audited frame by frame at `dd77a5f` because leak six raised the
possibility that some of those rounds had graded a UI overlay rather than a renderer. Here is
what the audit actually found, and it is a mixed answer.

**The HUD did not corrupt the record.** Every deck still on disk was measured with a detector
calibrated on a known HUD-bearing pass — per origin, the pixels static across every frame *and*
structured, minus the other origin's. The 18-shot pass with the interface up scores **0.837% of
frame**. All nineteen surviving decks score **0.000%**, and `screenshots/wallgeo-deck` was checked
by eye before its owner deleted it. So twenty decks are clean by measurement, not by assertion.

**But the denominator is wrong in three ways, and all three inflate it.**

1. **Nine of the nineteen surviving decks graded our renders against photographs**, not against
   Rome II — `eng-mech`, `mech-1/2/3`, and the engine agent's `deck-r0/r1/r2/r3/on`. A photograph
   and a render separate on sensor noise and depth of field whatever the renderer does. Those are
   real *accuracy* measurements ("does our scorpion match the archaeology") and they are not
   evidence about rendering. `blind-compare.mjs` now detects a photographic reference pool from
   source EXIF and prints `countsAsSeparationRound: false` into the key.
2. **Ten decks came from seven distinct shot passes.** `round1/2/3` are three seeds of the same
   eight siege frames; `rq-2903/5177/7331` are three seeds of the same six. Reshuffling a deck
   measures grader consistency, not the renderer.
3. **No ledger has ever existed.** There is no record anywhere in the repo of what the twenty-one
   or twenty-three rounds *were*. Roughly nine deck directories that existed at the start of this
   session — `blind-c1/c2/c3`, `blind-wall`, `critic1`, `plandeck-r1/r2/r3` — were deleted by
   their owners under the screenshot-cleanup rule and cannot be audited at all. One of them, a
   lighting deck, is independently known to be void: it was shot without `--nohud` and all three
   of its graders sorted on the faction-strength bar.

**The honest statement is: seven or eight independent render-quality passes against the Rome II
plates, every auditable one of which separated, plus one known void round and about nine rounds
with no surviving evidence either way.** That is still a real and consistent result — no
workstream has reached parity — but it is a seventh of the weight the old number implied. Quote
it that way. The named cause has moved five times: contact shadowing, material-boundary blend,
crowd clone repetition, luminance, and now **aliasing**, the first to separate cleanly as a single
scalar. A clean round does not imply parity and never has.

### The harness refuses decks now, rather than reminding people

**Seven leaks, and five were found by someone who was not looking for them.** Wordmark, camera
EXIF, a mislabelled key, file size, the quantisation tables that the file-size *fix* introduced,
the HUD, and the letterbox bars. Each was closed by a person resolving to be careful and the next
one arrived regardless, so `2cba66d` and `dd77a5f` replace care with refusal. Three gates, any of
which exits 3 and deletes the frames:

1. **Provenance.** `tools/shoot.mjs` now hides the HUD *by default* (`--hud` opts back in;
   `--nohud` still works and is a no-op) and records `hud: <bool>`, the tool, the argv, the dpr
   and the commit into `report.json`. `blind-compare` refuses any `--ours` directory whose record
   is missing or says true. **Missing is refused as firmly as true** — "nobody wrote it down" is
   exactly the state that produced leak six. Use `--pick=a,b,c` to grade a subset in place;
   copying frames to a new directory throws the record away and the deck will be refused.
2. **Overlay audit**, thresholds above. It also names the two other things that produce the same
   signature: a letterbox bar, and a side whose frames all share one camera.
3. **Invariants.** `bytes`, both quantisation-table sums and letterbox depth must be *identical*
   on every frame — an exact test, not a threshold, because with `--bytes=0` the raw sizes score
   0.850 balanced accuracy and slid under a 0.95 bar.

Leak seven was live when the audit ran: **`--fit=contain` letterboxes only the frames whose aspect
differs from 16:9**, which in `mech-1/2/3` is every reference photograph and none of our renders.
The comment claiming it "is not a tell" was wrong. Gate 3 catches it now.

**Leak eight is open and cannot be closed here.** Padding past the EOI defeats `wc -c`, not a JPEG
parser: scanning forward from SOS recovers the true compressed length in ten lines, and it sorts
the deck at **0.850** (ours 560,302 bytes against 349,225). Equalising it means either spending
fewer bits on our side — which is leak five, and manufactured the artefacts the critic was then
asked to grade — or burying the aliasing signal under matched grain. It is printed on every run
and it closes when the renderer stops carrying 1.7x the pixel-scale energy of a press plate. Note
that 1.7x and the harshness ratio of 1.137 against 0.427 are the same physical fact measured
twice; whoever closes the aliasing gap closes this leak for free.

Verified clean, so stop re-checking: the 20% bottom crop clears all ten wordmarks, and no EXIF or
ICC survives.

### Two biases in the instrument that run *against* us, both still open

- **Every graded plate in this project's history was rendered at one sample per pixel.**
  `ultra.maxPixelRatio` is 2, but the engine takes the minimum of that and
  `window.devicePixelRatio`, which headless Chromium reports as 1. The deck has been
  photographing a configuration the product does not ship, in the direction that flatters the
  reference — one sample per pixel is the worst case for the aliasing separator. `shoot.mjs
  --dpr=2` shoots the other arm; the default stays 1 so rounds stay comparable, and the value is
  recorded in `report.json` either way. **Nobody has measured the dpr-2 arm yet.**
- **The deck's 20% bottom crop removes our harshest band**, which is why the harness's own
  harshness numbers run about 1.2x lower than `tools/probe-harshness.mjs` measured on the
  uncropped frames. The crop is load-bearing for the wordmarks and must not be reduced, so the
  blind deck systematically *understates* the aliasing gap.

### Known limitation, left open deliberately

`--set=deck` (`dd77a5f`) fixes deck independence on the shot side: ten frames, no two sharing a
follow target, six on the Campus Martius and four at Pydna, hours 07:30 to 16:24 against the
single 17:00 every earlier frame shared, and one frame at `high` rather than ultra. It was used
for the final round and nothing else has been. **The old sixteen-shot pool is still what every
earlier round used, so no round before this one was ten independent trials**, and their accuracy
figures are inflated by family resemblance to an unknown degree.

Two things were tried inside that set and rejected — do not retry them. Pydna at its 19:00 preset
renders at a few percent luminance with a blown sun blob and nothing else legible, which a grader
sorts as "the dark one". And the honest non-ultra frame must be `high`, not `low`: `maxSoldiers`
is 1,600 at low and 3,200 at medium against an order of battle of 8,632, so a low-tier frame
photographs a different battle and is sorted on headcount rather than filtering.

`reference/museum/` holds 41 licence-verified photographs (PD/CC0/CC BY/CC BY-SA, provenance in
`ASSETS.md`) for **accuracy only** — a grader separates photography from rendering on sensor noise
alone. `reference/rome2/` remains the sole battle-plate pool, still only ten plates, and that is
the weakest part of the instrument. Widening it was considered and not attempted: it needs
licence verification on each individual asset page, official sources only, and it is the single
highest-value thing left undone here.

### Reading a grader's answer

Ask for a label, a confidence *and the mechanism*, and then check the mechanism. A fresh critic
sorting an earlier deck gave "no normal or roughness maps" as its runner-up cue and was simply
wrong — both are present, and it was reading flatness as absence. A grader that gets the label
right for a false reason is a different result from one that names a real defect, and only the
second is a work item. Allow "I cannot tell" per frame and count it honestly; a forced binary on
twenty frames turns a coin flip into evidence.
