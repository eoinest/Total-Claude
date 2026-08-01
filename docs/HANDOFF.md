# Handoff — live state

Written after a machine crash took down seven background agents at once. This is the state
that must survive a context compaction. Update it, do not let it rot.

## Agent roster and where each one was

All seven were mid-task when the machine crashed. Their transcripts are on disk and each can be
resumed with `SendMessage` to its id; resuming replays its own context, so a short "resume,
here is what changed" message is enough.

| id | workstream | last known position |
|---|---|---|
| `abfdfd21b8a18fae1` | Melee: holding ground, stalled fights, `R` key, stragglers | had a worktree on 5571, running the reach case |
| `ab83c382c1be69638` | Wall geometry: wider curtain, parallel stairs, scaffolding inside, gate shut | mid-flip of scaffolding to the city side |
| `ace11fa044ae8d5a8` | Siege: wall traversal, gate breach, heavy ram, tower ramp, **ram jamming the gate** | writing the public order API and plan executor |
| `aebaeeaacbc24699a` | Artillery: wrong projectiles, catapults off walls, slinger zero damage, **+ GroundDamage shadow bug** | building its measurement instrument |
| `af6a196672fecfb34` | Rome streets: quilt, wider streets, monument overlap, **owns the YouTube reference** | replacing the BSP subdivider with a spine-and-rib planner |
| `ab5ab86a89c1c4c64` | Soldier fidelity | **FINISHED** — committed `5ec90a5` |
| `a26c20d608c42a659` | Lighting: lift figures out of silhouette | just launched, barely started |

**The crash was almost certainly resource exhaustion.** Seven agents each running a vite server
plus headless Chromium has driven this machine to load 18 before, where `ps` took two minutes and
one agent's transcript was lost outright. Any resume must tell them to serialise hard: one server
at a time, killed when the measurement finishes, never a shot pass and a determinism check
concurrently.

## Tree state

`HEAD` was `5ec90a5`. **The working tree does not compile** when the three city/siege agents are
mid-edit — expected, not a fault. Errors seen: `subdivide`/`streetWidth`/`STREETS` in
`insulae.ts`, `steps` in `wall.ts`, `ON_LINK` and a `SiegeRam` literal in `Siege.ts`.

If work must be parked again: `git stash push -u -m "..."` the agent files, which returns `main`
to a compiling state, and `git stash pop` to restore. Do not commit a non-compiling tree.

## The player's outstanding list, with owners

Everything below came from the player. Items not listed here are done and committed.

- snaking/rotation in the gate chokepoint, units squeezing through — melee
- **units standing face to face not fighting** — melee, highest priority, this is the game not working
- `R` run key appears to do nothing — melee
- stragglers stuck behind the wall should rejoin — melee
- wall much wider; stairs parallel not perpendicular; scaffolding inside — wall geometry
- gate shut by default — wall geometry owns the door, siege owns the mechanic
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
6. Machine load makes frame timing meaningless — an *unchanged* tree has measured slower than a
   changed one. Use in-session interleaved A/B and report both arms.

## Grading

`tools/blind-compare.mjs` against `reference/rome2/` (ten Rome II press plates). It has been fixed
four times for leaking a wordmark, camera EXIF, a mislabelled key, and file size. `reference/siege/`
(25 user images) and `reference/rome3d/` (YouTube stills) are **mechanics and layout reference
only, never blind-deck plates** — mixed provenance would flatter or unfairly penalise us.

**Twenty-plus blind rounds have run and every one has separated the deck.** No workstream has
reached parity. What has changed is the named cause, three times over: contact shadowing, then
material-boundary blend, then crowd clone repetition, now luminance. Say this plainly rather than
letting a clean round imply parity.
