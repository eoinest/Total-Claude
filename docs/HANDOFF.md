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

- **56.2% of a soldier's triangles disagreed with themselves, and a battle frame could never
  have shown it.** `MeshBuilder` wrote a shading normal per vertex and a triangle order, and
  nothing tied them together. `revolve` emitted normals that were the *exact negation* of its
  own winding for every profile, so every helmet bowl, the skull, the hair, all four shield
  bosses and every lathed weapon head drew correctly and lit itself inside out — at
  `envMapIntensity: 2.9` a helmet crown sampled the ground hemisphere instead of the sky, which
  is why a bronze galea rendered as a flat cream lampshade. `box` got a left-handed basis on
  four of six faces, so ±X and ±Y were **culled** by `side: FrontSide` and a box drew as two
  facing panels with the world between them. Fixed at `5eb55f0` by deriving winding from the
  normals (`quadFacing`/`triFacing`); `tools/probe-soldiermesh.mjs` reports 0 / 4,307. Identical
  vertex and index counts, so the cost is nil. **Culling and shading disagree silently: a mesh
  can render solid and still be wrong, and only a per-triangle probe finds it.**

- **The shield boss was modelled, tinted and drawn every frame, on the wrong side of the board.**
  `boss()` is a lathe under `rotationX(+PI/2)`, and all four call sites passed a negative axial
  offset: the scutum's umbo sat 219 mm *behind* the face it should stand proud of, the oval's
  114 mm, the round's 56 mm. "No boss geometry, no rim bevel" is the cue both round-23 graders
  named first or second. Fixed at `d237d1c`; `boss()` now takes the board's own front-face Z so
  the mistake is not expressible.

- **"No smooth region anywhere in frame" is the grain pass, not the geometry.** The adversarial
  grader's strongest scalar (32px tiles with Laplacian std < 1.0; plates 0.31-15.10%, ours
  0.00-0.05%, 20/20) was attributed to "renderer dither or terrain polygon faceting". Measured
  on one isolated-model plate, switching only `uGrain` (`PostFX.ts:1140`, ships **0.016**):
  **0.016 -> 0.00%, 0.006 -> 2.21%, 0 -> 69.67%**, against Rome II soldier crops at mean 7.09%
  (range 0.48-24.03). One uniform. Re-shot at 0.016 twice for 0.00 both times, so it is stable.
  **0.006 lands inside the reference range.** Owned by the render workstream — one default.
  And the statistic itself is weaker than believed: with the backdrop flood-filled out it
  collapses from 100% to 80/70% balanced accuracy, i.e. it was largely measuring the background.

- **The separation is a one-pixel spike, and it is not the background.** On the isolated-model
  deck an adversarial grader flood-filled the backdrop, eroded the silhouette 4 px and measured
  the figure only. Octave decomposition: at **4, 8 and 16 px the two pools are statistically
  identical** (60-65% balanced accuracy = chance) — our models are not worse-proportioned,
  worse-posed or worse-lit at coarse scale. The whole separation is the **1 px ÷ 2 px energy
  ratio: ours 2.01-3.61, Rome II 1.20-1.35, no overlap.** The target is to drive it under 1.4
  **by adding energy at 2-8 px — normal maps, roughness variation, wear, cavity, grime — and
  never by blurring the 1 px band**, which lowers the ratio while making the model worse. That
  is the same trap the harshness note records, found independently by a second instrument.
  Two statistics that *fail* here and should stop being quoted at this magnification: local RMS
  contrast at 32 px (80%, and the sign is **backwards** — Rome II is higher), and a
  Gaussian-blur high-pass (70%, because the blur residual is dominated by the mid-band the two
  pools share).
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
12. **Carthage was unreachable at `7a313fe` and is the over-budget map at `b7d8aaf`.**
   `src/maps/carthage.ts` had `city: null` until the fabric merge, so no Carthage figure
   quoted from a running game before that was taken on that map. It is wired now, and its
   assault camera renders **242** at ultra: 134 colour + 85 shadow + 23 post. The shadow pass
   is *cheaper* than Rome's and the triple wall is 25 visible meshes against Rome's 31, so the
   shared-material-stream technique works. The colour pass is the problem — `fabric` alone is
   **157 visible meshes**, about forty chunks at 5/3/1. Their LOD ladder works; there are just
   too many chunks. The lever is chunk count, and it belongs to `src/city/carthage/`.

## Grading

### CORRECTED — the face was inside out, and round two's fix pointed the deck at the back

**Read this before the section below it, which is wrong.** Round two's magenta measurement was
real and its conclusion was not. `revolve` derives its normal from the profile tangent as
`(-dy, dr)`, which points outward **only while y descends down the point list**. Every other
lathe on the man is written crown-first. `skullProfile` was written **jaw-first**, so its
normals pointed into the head, `quadFacing` derived matching inward winding, and
`side: FrontSide` culled the near half of every man's face — mean dot of winding with the
outward radial over the face arc **-0.324**, 76 of 123 triangles inward.

So the face was not dark, it was **inside out**: a camera in front of a man saw *through* it to
the inside of the back of his skull, at the back skull's depth, so every helmet bowl, hair dome
and beard between the two won the depth test. That is what produced "0 magenta at azimuth 0 and
121,407 at PI" — the tile was visible **only from behind him, through his own skull**. Adding
PI to `framePlate` therefore pointed all ten plates at his back *for real*, which is why every
head plate since has photographed a neck guard and a nape band, and why the deck looked
"materially harder". Reversing eight profile points takes the dot to **+0.540** and adds no
triangles; the same magenta measurement then inverts and strengthens to **466,141 face pixels
at the front against 0 at the back**. The PI is gone.

**Three passes have now got this sign wrong. The invariant is the measurement, not the sign:
paint `Mat.Face` magenta, sweep the azimuth, and the peak is the front.**

**`probe-soldiermesh` reports 0 disagreements on that piece and always did, and it is not an
all-clear.** It asks whether a shading normal opposes its own winding, and `quadFacing` derives
one from the other — so both faced the wrong way in perfect agreement. A whole class of
inside-out geometry is invisible to it. Test against an *outward radial*, not against itself.

Three more full revolutions fell out of the same audit, the same family as the four closed
domes: the **beard was a 360-degree hoop at mouth height** (82 % of Germanics and 42 % of
Romans had no mouth), the **spangenhelm brow band was a complete turn**, also at mouth height,
and the **fur cap was a full revolution** to y -0.045, so a capped Juthungi measured exactly
**0 face pixels**. All three Roman brow bands hung below the rim as 36 mm visors across the
eyes. The nose now projects 25.8 mm against a life-size 25, from 14.

Visible face-tile pixels at the shipped framing: `juth-head` **580 -> 157,649**, `legio-head`
**744 -> 84,782**. Both head plates now show eyes with whites, irises, pupils and lash lines,
brows, a nose with a shadow under it, and a mouth line. Still short: the eyes are hard-edged
cut-outs that stair-step on the lids, the nose is a faceted slab with a seam, and **the face
*tile* itself was never touched** — its low contrast against the skull's own ring creases, and
the 256 px band it now has and does not use, are the obvious next pass and are unblocked.

**Every azimuth in `shoot-model.mjs`'s plate table was picked while the camera stood behind the
man**, so anything he carries in front of himself was out of shot. `juth-head` is fixed
(-0.45 to +0.45; his javelin bundle stood between the lens and his nose, and it is the thing
that looks like pale shards across his face). **The other eight plates have the same latent
problem and nobody has audited them.**

### The isolated-model deck photographed the back of the man's head, every round

**Azimuth 0 was behind him.** `viewer/main.ts`'s `framePlate` documents "azimuth is measured
from the man's front", and `shoot-model.mjs` records that the first version of its plate table
had the convention backwards and "shot ten plates of a legionary's back" — the correction went
into the *table*, not the camera, so it swapped which plates were wrong and fixed none. With
the face tile painted magenta and one head shot at four azimuths, magenta pixels come to
**0 at azimuth 0 and 121,407 at PI**. The posed man faces **-Z**: the mesh is built facing +Z
(scutum socket z +0.20, nose z +0.075) and `iOrient.x` is 0 in the viewer, so the half-turn is
in the authored clips' root. Fixed in `framePlate`. **Every isolated-model grade before this
graded a man's back**, and the deck is materially harder now: on an unchanged model the octave
ratio goes 1.475 -> 1.734 purely from turning the camera round, because a front carries far
more pixel-scale structure than a back.

**`viewer.html` never loads `LightingSystem`.** `tcShadowGeom`/`tcSoftShadow` are not present as
text in any of its 24 fragment programs. The deck grades soldiers under three's stock PCF with
one non-cascaded sun; the battle grades them under `tcSoftShadow` with four cascades.

**`grade.ts` has already drifted from `PostFX`.** Of the five uniforms they share, one
disagrees: `uGrain` is 0.006 in `PostFX` and **0.016** in the viewer's mirror — so the model
deck is still shot at the grain level that measured 0.00 % smooth-region against Rome II's
7.09 %. Exporting `PostFX`'s two shader bodies and deleting the mirror is still the right fix
and is still not done.

### The 12 `tcShadowGeom` errors do not reproduce at HEAD, and "12" was one program

Zero failing programs across nine arms — ultra/high/medium/low, Rome and Carthage, field and
assault, a 62 s battle, quality churn, a shadow-map recompile, the main-menu path and the
viewer — 124 fragment programs at maximum coverage, all clean. The mechanism is real and one
`shadowMap.type` away: the **declaration** of `tcShadowGeom` sits behind
`SHADOWMAP_TYPE_PCF && USE_SHADOWMAP && USE_CSM && CSM_CASCADES`
(`softShadow.glsl.ts:119`) while the **use** injected into `lights_fragment_begin`
(`LightingSystem.ts:319`) needs only the last three. Forced with `BasicShadowMap`, 14 of 25
patched materials fail — two of them soldier materials — and each failing program's log holds
exactly **12 `ERROR:` lines**: 4 unrolled cascades x 3 errors. So "12 identical errors" was one
program's dump at `CSM_CASCADES=4`, not twelve programs. It cannot fire today because
`LightingSystem.init` sets `PCFShadowMap` before any material carries `USE_CSM`. Fix it on the
*call* side — `CSM_SOFT_SHADOW_CALL` (`softShadow.glsl.ts:243`) should emit
`#if defined( SHADOWMAP_TYPE_PCF )` / the call / `#else` / stock `getShadow` / `#endif`. The
`SHADOWMAP_TYPE_PCF` term in the declaration guard is correct and must not be dropped: three
declares `directionalShadowMap` as `sampler2DShadow` only under PCF.

### Three closed domes, and no battle frame could ever have shown them

The same defect in three places, each hiding the thing under it:

- **`Piece.HairShort` was a full revolution** 4-9 mm proud of the skull running to y = -0.035 —
  below the brow, below both eye boxes, across the top of the nose. Every bare-headed man's
  face was sealed inside his own hair.
- **Every helmet bowl was a full revolution** down to y = -0.016, with the eyes at +0.024 and
  the brow at +0.050: Gallic, ridge, Coolus and spangen all enclosed both, and the reinforce
  below sat at jaw height binding nothing. The Gallic shell was also radius 0.109 over a skull
  of 0.082 — **27 mm of padding all round** against a real lining's eight or ten.
- **The "brow" box was at y = -0.012**, 55 mm below the real supraorbital ridge, so it lay
  across the eyes; the "jaw" box's front face at z = 0.0575 was *inside* a skull of radius
  0.0678 and drew nothing at all.

All three are fixed with one mechanism — `revolve` now takes an `arc`. The general lesson is
the one the inside-out normals taught: **a lathe is axisymmetric and a head is not**, so any
head part built as a full revolution is covering something.

**Still open, same family:** the Germanic `HairLong` is modelled as a curtain that closes over
the face from the fringe to the beard at every hash, which is why a Juthungi head plate cannot
photograph a face.

### A tile repeat ran backwards on every closed ring in the game

`MeshBuilder.tileUv` wrapped with `(s * repeat) % 1` **per vertex**, and a modulo between two
vertices does not wrap the surface between them — it runs the whole tile backwards, compressed
into one column. Even at `repeat = 1` every ring had one, because `tube`, `revolve` and `sweep`
close with `(s + 1) % segments` and reuse vertex 0. At `repeatU: 3` on the mail and scale
torsos, **three of ten columns** did it. `repeatStops` puts the seam on a duplicated vertex, so
it costs vertices and **not one triangle**. Two of the same family alongside it:
`box(..., repeat)` fed 0 and 1 through the same modulo, which is 0 for both, so every corner of
a repeated box face landed on **one texel** (five engine call sites); and five hand-rolled
grids outside the soldier still carry the defect, now behind the deliberately ugly name
`tileUvWrapped`.

### R measures the reference pool's upscale, not the model — stop steering by it

**This retires the target "drive R under 1.4".** `reference-crops/` is cut from the ten Rome II
press plates at **285x380 to 570x760 native** and lanczos-upscaled to 900x1200, i.e. **1.58x to
3.16x up**; our plates are shot at 1800x2400 and resampled 2x **down** to the same grid. That is
a three- to six-fold relative resolution difference between the pools, and it is most of what
R measures.

Proved by putting **our own unchanged plates through the reference pool's own chain** — no
model change at all, only the resampling:

| plate | native | up 1.58x | up 2.37x |
|---|---|---|---|
| praet-torso | 1.042 | 0.795 | **0.633** |
| legio-front | 2.411 | 1.421 | 0.859 |
| juth-front  | 1.363 | 0.848 | **0.630** |

The reference band is 0.520-0.621. Two of three of our own plates land in or beside it purely
from being resampled the way the reference was. HANDOFF already recorded that at each pool's
native size the two **overlap** (ours 1.29-2.13, Rome II 0.87-2.15); round two read the
normalisation as what "makes the separation clean". It is the other way round — the
normalisation *manufactures* it. Quote the separation as **confounded by resampling**, not as
100 % clean.

The practical consequence, measured three separate ways in one session and all agreeing:
**every change that makes our texture finer or more physically correct moves energy from E2
into E1 and R goes up.** Halving the material tile's world size: E2 -12 to -15 % on three
plates. Tripling the cloth weave toward a real 5 mm thread: E1 +21 %, E2 -8 % pooled. Moving
the weave's amplitude into an irregular slub: the same loss again. Two of those three were
reverted on the measurement, and the third was kept only because a texel-density fix was
landed underneath it. **Our atlas content already sits in the 2-4 px octaves at this
magnification; there is nowhere for added detail to go except the 1 px band, where the render's
own filtering throws it away and the upscaled reference has nothing to compare against.**

What is still worth using from this instrument: the **absolutes within our own pool**, and
`--repro`, which measured a floor here of **0.22 % worst plate and 0.05 % pooled** on this
machine — so it is a genuinely sharp differencer of our own tree against itself. What is not
worth using is R against the reference. Matching the two pools' native resolution before
measuring is the fix, and it means either shooting our plates at the crops' true pixel size or
finding press material at ours.

### "No normal map, no roughness map" was a starved sampler, not an absent one

Three independent critics named it and all three were reading the same real defect by the
wrong name. Both maps have been present for months. Arm-differencing the live material
(`tools/probe-kitmaps.mjs`, drift floor **exactly 0.00000/255**, base and base2 bit-identical)
puts numbers on it: deleting the normal map alone costs **8.8-21.5 % of E1** and changes
**33-64 % of figure pixels**; `flat-all` costs 35-47 % of E1.

The actual defect was **texel density**. At the isolated deck's magnification one atlas texel
covered **2.0 to 4.7 screen pixels** on a 128 px tile — the sampler is on mip 0 everywhere, so
nothing is mip-starved, everything is *magnified* and interpolated up. A bilinear smear and a
missing map are indistinguishable to an eye. Measured by piece at `praet-torso`:
Segmentata was at 2.0x magnification, Tunic 2.6x, Scale 4.1x, head and arms 4.7x. At 256 px
tiles that halves to 1.2-2.3x, which is where it now stands.

Two things fall out of this that are worth carrying:

- **Head and arms are the second-worst-sampled surface on the man** (1056 texels/m median),
  and that is part of why the face has no features. Texels, not paint.
- **Texel density varies 13.1x across one man's pieces** — bare legs 570 texels/m against a
  quiver at 7470 (`tools/probe-soldieruv.mjs`, which now reads the sheet size out of the live
  module rather than carrying its own stale copy). One man whose material grain changes
  thirteen-fold from piece to piece cannot read as authored.

### Every torso was tiled 1.8:1 stretched, and nothing tied a repeat to a surface

`repeatU`/`repeatV` were hand-written at each `tube` call with nothing connecting either to
the geometry. The mail body ran 3 tiles around a 0.87 m circumference and 4 along a 0.65 m
length — one tile covering **291 mm by 164 mm**, so a 9 mm riveted ring rendered as a
**16 x 9 mm oval** on every mailed man in the game, which is why a coif photographed as a
sheet of embossed lozenges. Scale ran 1.4:1, the tunic 1.5:1.

Fixed by `MAT_TILE_M` (how much of a man one tile of each material covers) plus `tileRepeat`,
which divides the surface's own mean circumference and path length by it. The segmentata torso
comes out **unchanged** at 453 x 449 mm — it was the one surface already square — which is the
check that the arithmetic is not inventing a correction. `MeshBuilder.repeatStops` clamps a
repeat to the division count on its own, so **LOD2 is untouched and still measures exactly 313
triangles / 280 vertices**.

Two traps found inside this, both now written into the code:

1. **Rounding a tile count can only go up or down, and on a small surface down is a long way.**
   A leg is 0.35 m round against a 0.27 m wool tile, so `round(1.3)` is 1 and the bracae came
   out 30 % *coarser* than authored. `tileRepeat` takes the old repeats as a floor.
2. **Correcting the size without adding texels measurably makes the plate worse** — it shrinks
   the same 128 texels into fewer screen pixels. That is why the sheet went to 2048 x 1536.

**Still open, same family, and it is the largest single surface on the man.**
`MeshBuilder.shieldPanel` maps **one tile across a whole 1.02 m board** — 4.4 screen pixels per
texel, by far the worst on the figure, and it is why a scutum's inner face photographs as a
featureless black smear across 12-20 % of two plates. It is also one of the five hand-rolled
grids still carrying the `tileUvWrapped` seam defect, so fixing the tiling and the seam is one
job. Not attempted here: seven call sites and a rim topology indexed by column, against a
shield whose boss was only just repaired.

### The metal F0 rewrite shipped half-applied

The long note above `IRON` argues that a conductor has no diffuse lobe and that its colour is
its measured F0, and the **albedos were duly raised** — iron 0.78, bronze 0.88/0.70/0.40. The
**metalness values were never moved**: iron 0.45, plate 0.5, bronze 0.74, mail 0.36, scale 0.52,
bands 0.48. That left every metal a soldier wears half dielectric with a metal's albedo, which
is the one combination that same note warns is worse than either end, and it is what
`praet-torso` photographed — a bronze squamata as one smooth extruded gold ribbon with no seam
between one scale and the next. All six are now at metalness 1, bronze at roughness 0.30.

The recorded counter-measurement ("raising metalness darkens armour, verified twice") does
reproduce as a fall in median plate luminance, largest on the two most metal-heavy plates. It
is the fix rather than the cost: what goes dark is the gutter between two scale rows and the
overlap under a girdle plate. **Moving one half of a two-variable change and leaving the other
is not the conservative choice, it is the worst point in the space** — worth remembering
generally, since it survived here for months behind a comment that described the whole fix.

### A "paused" model plate is not still

Found while building the arm probe, and it is a live hazard for anything that differences two
frames of the viewer. `viewer/main.ts` feeds the rAF delta to `soldierRig`, which advances
`uTime`, and `anim/skinShader.ts` adds a `sin(uTime * 0.55 + hash)` idle lean of +/-0.014 rad
about the feet — roughly +/-27 device px of head swing at `legio-front` — plus a cloak-hem
wave on the same clock. Two screenshots of the same plate are two different poses. Pinning
both (a constant rAF timestamp, and `uTime` pinned through
`renderer.properties.get(mat).uniforms`) takes an arm-differencing floor from **17.1/255 over
63 % of pixels to exactly 0**. Note this does **not** affect `shoot-model.mjs` decks, which
measured a `--repro` floor of 0.22 % worst plate in the same session — the harness controls it
per plate. It bites live-page probes only.

### `grade.ts` is fixed; `viewer.html` still does not load `LightingSystem`

`uGrain` is now **0.006**, matching `PostFX`. `uSharpen` had the same class of error and is now
**0.28**: it mirrored a *default* that `PostFX.ts:1530` overwrites from the quality tier every
frame, so the deck ran a value the product never uses. Every model deck this project has graded
before this was shot at 0.016, the level measured to leave 0.00 % of a plate reading as a
smooth region against Rome II's 7.09 %.

**The de-duplication was deliberately not done.** The right fix is still to hoist `PostFX`'s two
shader bodies to module-level exports and delete the mirror — they are anonymous template
literals at `PostFX.ts:851-960` and `1095-1134`, referenced nowhere else in the file, so it is a
pure hoist. It was not attempted because the frame-budget workstream holds `src/render/PostFX.ts`
in its own worktree with 26 insertions against `b7d8aaf`, and losing that is a worse outcome
than a mirror with the drift now corrected. Two further divergences are recorded and unfixed:
`Grade` pins `uExposure` at 1 where `PostFX` drives it from the sky preset (**1.42-5.1** in
practice, the largest tonal divergence left), and `uTime` is pinned at 0 on purpose for
reproducible plates and must stay that way through any refactor.

**`LightingSystem` is still not loaded, and the map to load it is now complete.** The viewer's
`Stage` builds three hand-rolled lights and sets `PCFSoftShadowMap` — a **third** shadow mode
that neither `Engine` (`PCFShadowMap` via `LightingSystem.ts:192`) nor the rig uses, so the deck
grades under fixed 3x3 PCF with one non-cascaded sun. `LightingSystem`'s constructor takes zero
arguments and `init`/`preRender` touch only `scene, camera, renderer, quality{tier,
shadowCascades, shadowMapSize}, rig.orbitRadius, tryGet('sky')`, so a five-field shim is
enough — or copy `src/city/preview.ts`, which stands up a real `Engine` with `SkySystem` and
`LightingSystem` for exactly this reason. Four hazards, in order: `TC_CLOUD_SHADOW` is defined
unconditionally but its uniforms are only bound when a sky exists, so with no sky
`directLight.color` is multiplied by garbage and `cloudShadowsEnabled` is private with no
setter; `installShaderChunks` mutates `THREE.ShaderChunk` process-wide and throws if the CSM
call text does not match; every lit material must be patched or it renders 4x too bright, which
`discoverMaterials` only fixes on a 16-frame timer; and `Stage`'s own sun, fill and bounce must
be removed or the man is double-lit and the CSM light indices shift.

### The octave instrument, and the constants that do not transfer

`tools/probe-octave.mjs` measures 1/2/4/8/16 px band energy on figure pixels only and prints
R = E1/E2 **plus the absolute bands**, because a 0.7 px Gaussian takes R down 43.9 % *and* E2
down 19.2 % — R alone is gameable and the absolutes are the guard. `--selftest` proves it.
**Round one's constants are in different units and must not be quoted against these:** the
reference pool reads **0.520-0.621** here, not 1.20-1.35, because both pools are normalised to
900x1200 first. At each pool's own native size the same decomposition gives ours 1.29-2.13
against Rome II 0.87-2.15 — *overlapping*. Normalising is what makes the separation clean.

Reproducibility floor **0.11-0.30 % pooled, 0.58 % worst plate** over three shoots of a
byte-identical tree, so unlike trap 6's battle frames **cross-session A/B is valid on this
deck**. `report.json` records the commit but not the working tree, and two decks at one commit
can be different trees — hash `git diff HEAD -- src/` beside it.

**Our absolute mid-band energy is already above the reference's** (E2 1.78x, E4 1.28x). The
excess by band is 4.5x at 1 px and ~1.3x at 4-16 px — round one's coarse-scale parity finding,
reproduced by a second instrument. Read the absolutes *within* our pool only; the cross-pool
ratios are confounded by content and key and already run the "wrong" way.

### The isolated-model deck — a strictly better instrument, and it says 20/20

`tools/shoot-model.mjs` photographs **one soldier, large**, deterministically posed and framed
on a neutral ground, driven through `/viewer.html` so it renders the game's own geometry, atlas
and shaders. `tools/model-deck.mjs` pairs those against single-soldier crops cut from the same
ten Rome II press plates, re-encodes both pools through one encoder at one quality, balances the
counts, shuffles from a seed and writes the key outside the deck.

Why it is better: every earlier round graded a battle screenshot in which a man is a few hundred
pixels among nine thousand, and both round-23 graders sorted largely on terrain, vegetation and
framing. On the isolated deck **both graders scored 20/20 and tagged 20 of 20 mechanisms
[FIGURE]** — no call rested on background, and the adversarial grader proved it rather than
asserting it (see the one-pixel-spike note above). It also found things no battle frame could:
the inside-out normals, the culled box faces and the reversed shield boss were all found this
way within an hour, after surviving twenty-three blind rounds.

**Read `screenshots/*-key.json` for what a round was.** `report.json` records commit, argv, dpr,
output size and the full plate spec; `model-deck.mjs` refuses a source whose record is missing or
says `hud: true`.

The two known limits, both open: our plates stand on a neutral ground while the crops are cut out
of a battle, so background can sort the deck in a glance even though it is not load-bearing; and
the byte ratio between the pools is **0.51-0.53** (ours 60 KB against 118 KB at identical
quantisation tables), which is not an encoder leak but an honest measure of how much less
structure our figures carry.

### The battle deck

`tools/blind-compare.mjs` against `reference/rome2/` (ten Rome II press plates), built from
`tools/shoot.mjs --set=deck`. `reference/siege/` (25 user images) and `reference/rome3d/` (YouTube
stills) are **mechanics and layout reference only, never blind-deck plates** — mixed provenance
would flatter or unfairly penalise us.

### Round 23, the final round — 40 of 40, on a deck built to be harder

Run at `fc5ed39` (which is `023240d` plus the harness work) on `--set=deck`: ten frames, no
two sharing a follow target, two maps, hours 07:30-16:24, one frame at `high` rather than
ultra. Deck at seed 8813, 10 ours against 10 Rome II plates, all three gates passed.

**Both graders scored 20/20.** A cold grader with no repo context, mean confidence 87.8, its
two least-confident calls at 58 and 68 (`deck-pydna-horizon`, which is nearly featureless
grass, and `deck-pydna-terrain`). An adversarial grader, mean confidence 91.2. Neither made
an error, and neither needed to be told the split was 10/10 — both arrived at it.

**The deck-independence fix did not move the result.** That is the useful finding. One map,
one hour and three near-duplicate pairs were suspected of inflating every earlier round;
removing all three changed nothing, so the separation was never resting on family
resemblance. Take the twenty-two earlier rounds' *accuracy* figures as unreliable and their
*direction* as confirmed.

**Neither grader led with aliasing.** Ranked cues, both graders independently:

1. **Shield and insignia authoring.** Flat discs and quads carrying crisp wear-free vector
   emblems, no boss geometry, no rim bevel, no wood grain, against press plates whose
   shields have a modelled spindle boss casting its own shadow onto the shield face. Both
   graders named this first or second and it is the one cue the cold grader said it could
   defend *mechanically* — "a canvas texture on a flat disc cannot fake wood grain plus a
   boss that casts onto the face, and I can point at those pixels."
2. **Faceless cloned characters.** "One head, one helmet, one torso, cloned across ~250 men";
   torsos read as stacked identical rings. **This is in direct tension with the measured fact
   below that the crowd carries 57-59 kit masks, 119 statures and 252 tunic colours.** Both
   are true: the variation is in the instance buffers and does not reach the screen. The
   defect is that faces and kit silhouettes do not vary, not that the data is missing, and
   "add more variation" remains the wrong fix.
3. **Untextured ground and flat-shaded architecture.** `deck-city` drew the single highest
   confidence in the deck at 98 — "untextured flat-shaded prisms, windows as painted
   rectangles, roof planes meeting in razor edges with no gutter, tile relief or dirt".
4. **No smooth region anywhere in frame.** The adversarial grader's strongest single scalar:
   percentage of 32x32 tiles with local Laplacian std < 1.0. Plates 0.31-15.10%, ours
   0.00-0.05%, **20/20 with nine of our frames at exactly 0.00**. It could not decide whether
   the mechanism is renderer dither or terrain polygon faceting, and said so.

**The honest caveat, from the adversarial grader and worth more than the score.** Nine of ten
plates are eye-level cinematic close-ups with sky, depth of field and dark blurred
backgrounds; nine of ten of ours are elevated RTS-camera field shots packed edge to edge with
vegetation. Every >90% tell it found is downstream of that. The anti-aliasing workstream
partially controlled for it — restricted to the top 20% most detailed 256px tiles the
separation *widened*, plates 0.516 against ours 1.953 — so it is not the whole story, but
**camera and subject distance are still not matched between the pools and that is now the
largest confound in the instrument.** Matching them pairwise, one class against the other at
the same angle and field of view, is the single highest-value change left.

**A protocol note nobody should have to rediscover.** The adversarial grader disclosed that
its session context automatically included a `git status` of this repository and recent
commit subjects, one of which said soldiers "read as clones" — a cue it then reported
independently. **A grader spawned inside this repo is never fully cold.** Its calls should be
treated as contaminated on any point the surrounding commits touch, and a genuinely cold read
needs an agent that has never seen the tree.

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
- **Every deck built before `f6aaaa6` was graded on a 1.25x upscale.** The 20% crop leaves
  1920x864 and the harness resized it back to 1920x1080 — a period-4.995 resampling comb an
  adversarial grader read straight out of the files. It never sorted the deck, because it was
  applied to both sides, but it means every round to date measured pixel-scale energy on
  interpolated pixels. Fixed: the output shape now follows the pools, the deck comes out
  1536x864, and the geometry is a pure crop (verified at 1.98/255 mean difference against an
  independent crop, which is q88 re-encoding and nothing else). Round 23 predates the fix.

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

### The atlas widening, priced

Measured with both arms interleaved in one browser session and the sim clock pinned so each
arm renders the identical men at the identical instant, on pinned detached worktrees at
`751dd0d` and `b7d8aaf`.

| | before | after |
|---|---|---|
| draws — wide / romanline / city / wall / skyline / melee | 131 / 153 / 200 / 211 / 178 / 135 | **identical** |
| whole-frame triangles, all six cameras | — | **byte-identical** |
| LOD2 triangles / vertices, all three factions | 313 / 280 | **313 / 280, bit-identical buffers** |
| LOD0 vertices, Rome / Germanic / Carthage | 5263 / 4528 / 7057 | 5297 / 4617 / 7091 |
| LOD1 vertices | 3132 / 2753 / 4388 | 3156 / 2805 / 4412 |
| soldier atlas resident | 25.17 MB | **50.33 MB** |
| asset textures, whole scene | 99.5 MB | **124.6 MB** |
| `buildSoldierAtlas` | 104 ms median | **309 ms median** |
| frame time, romanline and melee | — | **no measurable change**, every CI spans zero |

Two things the commit summary got wrong and the body got right. **"No vertex" is false** — tile
seams duplicate a vertex column, so LOD0 gains 34-89 vertices and LOD1 24-52, about +22 KB of
geometry across all nine builds. And **"texture memory only" is false**: the bake is 3.05x, so
+205 ms warm and up to +500 ms cold on a loaded machine, once at load.

**LOD2 keeping its tiling is provable rather than asserted.** Raw UVs must differ, because a
tile is now 256/1536 of the sheet and `matUv`'s 3-texel inset is 3/256 of a tile instead of
3/128. Divide both out into tile space and the LOD2 UV hashes are identical on both arms while
LOD0's and LOD1's differ, which is exactly the intended fix.

**Not this commit, but found by it: `romanline` is 153 draws against round two's recorded 139,
and it is already 153 at the merge-base.** `tools/shoot.mjs` is byte-identical between the r2
tip and `b7d8aaf`, so the camera did not move; the merge that pulled in the Carthage fabric and
the water surface is where the scene changed. `city` moved the other way, 218 to 200, for the
same reason. Neither figure is a soldier regression.
