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

- ~~gate chokepoint snaking~~ — **done** `ab8b957`, lateral drift 0.202 → 0.063 m/s
- ~~units standing face to face not fighting~~ — **done** `ab8b957`, 0 → 708-772 blows in 60 s
- ~~`R` run key does nothing~~ — **done** `ab8b957`, sim-side 1.55 → 3.383 m/s
- ~~stragglers stuck behind the wall~~ — **done** `ab8b957`, 94 → 30 stranded
- ~~wall much wider; stairs parallel not perpendicular; scaffolding inside~~ — **done.** Curtain
  3.5 → 6.0 m (`CURTAIN_T` in `wall.ts`), clear standing band 1.57 → 2.21-4.06 m, which is 4-6 ranks
  at the sim's 0.72 m pitch instead of 2; nine flights parallel to the face, 14.2-20.4 m along the
  wall against 3.28-3.79 m of projection into the pomerium; scaffold, crane, plank deck and putlogs
  all on the city side. `probe-wall` 12 → 19 assertions, all green.
- ~~gate shut by default~~ — **done.** `GateOut.open` is `false` at build time, the leaves are
  modelled shut with a drawbar and a bricked lunette, and `CitySystem` no longer clears the
  carriageway out of the occupancy grid for a shut gate. Siege opens it with
  `setGateOpen('porta-flaminia', true)`; the door plane is published by `getGateDoor()`.
- soldiers use stairs, move laterally along the wall, descend into the city — siege
- much larger wall-breaking ram — siege
- tower drawbridge backwards (ropes forward, door opens backwards) — siege
- **ram jams the gate it just broke** and cannot rout because it is a machine — siege
- scorpion/catapult fire arrows instead of bolts and stones — artillery
- big catapults off the walls, manned, immobile, aiming, animated — artillery
- streets read as a patched quilt; wider and more streets; monuments dropped across housing — streets
- **trampled ground receives no shadows** — artillery (owns `src/vfx/`)
- soldiers at 2-4% luminance — lighting

Done: flags now use the median soldier (`5e5ce44`); soldier materials (`5ec90a5`).

## Measured facts that must not be re-derived

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
- **Do not raise ambient.** Darkest-quartile luminance: **ours 0.159, Rome II 0.122** — our shadows
  are already 30% brighter. Warm/cool separation, (b/r in darkest quartile) ÷ (b/r elsewhere):
  **ours 1.11, Rome II 1.85**. So the defect is *hue muddle at too high a level*, not darkness:
  our lit and shadowed pixels are nearly the same hue. The fix is more contrast between the two
  ambient hemispheres at equal or lower total, which is what the chromatic ground bounce does
  (sky-to-bounce hue contrast 3.55 → 9.3 at luminance 0.1013 → 0.1016).
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
  before the harness clock fix was roughly double the truth.**
- `fixedUpdate` 3.657 ms at 8,632 men idle, 3.964 ms routing across the wall, against a 4 ms budget.
- Draw calls: city 205, wall 216, cap 220. Soldier draws 121-122.

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
6. **A typecheck is not proof of life.** Three commits stacked on a tree that white-screened.
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
   `-e node_modules`. A bare `sleep` is blocked in a backgrounded Bash call (exit 144) — use an
   `until` loop, and prefer the foreground for anything that must wait on a dev server.
9. Machine load makes frame timing meaningless — an *unchanged* tree has measured slower than a
   changed one. Use in-session interleaved A/B and report both arms.

## Grading

`tools/blind-compare.mjs` against `reference/rome2/` (ten Rome II press plates). It has been fixed
four times for leaking a wordmark, camera EXIF, a mislabelled key, and file size. `reference/siege/`
(25 user images) and `reference/rome3d/` (YouTube stills) are **mechanics and layout reference
only, never blind-deck plates** — mixed provenance would flatter or unfairly penalise us.

**Twenty-one blind rounds have run and every one has separated the deck.** Round 21 was 20/20 for
an adversarial grader *and* 20/20 for an independent cold grader with no repo context — 40 of 40.
No workstream has reached parity. The named cause has moved five times: contact shadowing,
material-boundary blend, crowd clone repetition, luminance, and now **aliasing**, which is the
first to separate cleanly as a single scalar. Say this plainly rather than letting a clean round
imply parity.

**The harness has now leaked five times, and the fifth was created by the fix for the fourth.**
Wordmark, EXIF, mislabelled key, file size — and then equalising size by binary-searching each
frame's JPEG *quality*, which wrote provenance into the quantisation tables (luma DQT sum: ours
mean 1426, Rome II mean 977; 72-78% separation from the header alone). Worse than what it
replaced, because quality is visible: our frames carry more high-frequency detail, so equal bytes
bought them fewer bits, and **the harness was manufacturing the artefacts it then asked a critic
to grade.** Fixed at `51d50be` — one quality for all frames, length padded past the EOI marker.
Any deck run before `51d50be` is void.

Verified clean, so stop re-checking: the 20% bottom crop clears all ten wordmarks, and no EXIF or
ICC survives. Known and accepted: the deck is not ten independent trials — our ten frames share
one map, one grass asset, one helmet and one time of day, and the near-duplicate pairs are on our
side only, which inflates any grader's apparent accuracy.

`reference/museum/` holds 41 licence-verified photographs (PD/CC0/CC BY/CC BY-SA, provenance in
`ASSETS.md`) for **accuracy only** — a grader separates photography from rendering on sensor noise
alone. `reference/rome2/` remains the sole battle-plate pool, still only ten plates, and that is
the weakest part of the instrument.
