/**
 * The moving picture behind the menu.
 *
 * Real frames of this game — `public/press/`, shot by `node tools/shoot-press.mjs` and
 * described in `manifest.json` beside them — laid full-bleed behind both menu sheets, with a
 * camera that never stops moving and that **travels somewhere new as the player goes deeper**.
 * The front door looks at one of them, drawn at random for the session. Pressing BATTLE flies
 * in to the battlefield that is currently selected. Pressing Carthage flies to Carthage;
 * choosing the storm flies from the Punic field army to the wall it has to climb.
 *
 * ---------------------------------------------------------------------------
 * Sep 2026: sharper, more of them, and randomised
 * ---------------------------------------------------------------------------
 *
 * The owner asked for three things at once and only the first of them was a bug.
 *
 *   1. **Sharper.** It was soft, and the reason is measured rather than guessed: the sums that
 *      set `sizes` and the rendition ladder were done in CSS pixels on a 2x display. See
 *      `SIZES` below for the table. The frame on the setup screen of a 16-inch Retina Mac was
 *      a 1,440 px picture across 5,838 device pixels.
 *   2. **More of them.** Nine became twenty-three, which is `tools/shoot.mjs` and
 *      `tools/shoot-press.mjs` rather than this file. Forty-five cameras were shot for it and
 *      twenty-two were looked at and cut, each with its reason recorded.
 *   3. **Randomised.** Which is this file, and which is two different rules for two screens —
 *      see `forBattle` and `pick`.
 *
 * The three are coupled in one place worth naming here: **randomising the front door is what
 * killed the hero's privileged rendition.** The old ladder gave one frame a 1920 and the other
 * eight a 1440, on the argument that only the hero was ever looked at full-bleed. Once any
 * frame can be the first thing a stranger sees, a ladder that stops early on eight frames out
 * of nine is a ladder that is wrong eight times out of nine.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a live 3D scene, with the number
 * ---------------------------------------------------------------------------
 *
 * The brief for this pass asked for the engine itself running behind the menu, on the grounds
 * that the engine is right there. It was measured before it was refused, and the refusal is
 * not about how *long* a scenic world takes to build — it is about how long the main thread is
 * **unavailable** while it does.
 *
 * `tools/scratch/backdrop-cost.mjs` builds sky, lighting, terrain and city into a throwaway
 * `Engine` and runs a `requestAnimationFrame` heartbeat throughout, so the largest gap between
 * two beats is the freeze a player would feel. Apple M4 Max, dev server, machine load 6.5–9.9:
 *
 * | phase | campus-martius | carthage | pydna |
 * |---|---:|---:|---:|
 * | `new Engine` + `sky` + `lighting` | 31 ms, **block 0** | 41 ms, **block 0** | 48 ms, **block 3** |
 * | `terrain.init` | 3,596 ms, **block 2,177** | 4,026 ms, **block 2,466** | 4,166 ms, **block 2,463** |
 * | `city.init` | 2,482 ms, block 497 | 2,082 ms, block 497 | — |
 * | `compileAsync` | 771 ms, block 756 | 734 ms, block 719 | 582 ms, block 571 |
 *
 * `tools/scratch/terrain-split.mjs` then opened the worst cell. It is one call —
 * `map.terrain.build(seedLabel)`, a 2,049 × 2,049 heightfield, 4.2 million cells — and it costs
 * **2,331 / 2,193 / 1,340 ms** with nothing awaited inside it. It is also **not memoised**: an
 * immediate second call to the same builder with the same seed costs 2,695 / 1,834 / 1,318 ms.
 *
 * So a live backdrop is not a two-second wait. It is a **2.2 second frozen menu**, during which
 * a click on BEGIN BATTLE is queued rather than served — and then the battle pays the identical
 * 2.2 seconds again, because the second build is not cheaper than the first. That is the
 * opposite of the constraint this pass was given: *a player who clicks straight into a battle
 * must never wait on scenery.*
 *
 * **What would change this, in one line.** Memoise `MapDefinition.terrain.build` by
 * `seedLabel`. The backdrop's heightfield would then *be* the battle's heightfield, the
 * 2.2 seconds would move from the loading screen to a moment the player is not waiting, and a
 * live camera over the real ground would cost the ~500 ms `city.init` block and nothing else.
 * `src/terrain/` is another workstream's ground and a memoised builder is a change a
 * determinism pin can feel, so it is named here rather than done. The measurement to re-take is
 * the `terrain.init` row above.
 *
 * The prior attempt at this screen — `origin/e/ui/cinematic-menu`, seven commits, 21 Aug —
 * reached the same refusal from the weaker premise that the *total* was 2,340–2,662 ms, and
 * shipped 2.99 MB of pre-rendered `.webm` instead. That branch is superseded: `public/press/`
 * is real renders of the current build with a measured legibility manifest and it is already on
 * `main`, so merging the old plates would add three megabytes of duplicate wallpaper. What is
 * kept from it is kept on purpose and marked where it appears: the reduced-motion rule, the
 * `saveData`/2G rule, the Safari `requestIdleCallback` fallback with a handle that remembers
 * its own kind, and the discipline of parking work for a layer nobody is looking at.
 *
 * ---------------------------------------------------------------------------
 * What it costs, which is the whole point
 * ---------------------------------------------------------------------------
 *
 * A guest's cold load was cut from 6,828 ms to 350 ms in `docs/MULTIPLAYER.md` §14 and this
 * pass is forbidden from spending it. So **nothing here is on the critical path**:
 *
 *   - `index.html` references no plate, and this module fetches none until `arm()` is called,
 *     which `MainMenu` does only after the sheet has laid out and faded in.
 *   - The plate is chosen by `srcset` from an honest `sizes`, so each device takes one
 *     rendition of one frame — 41 to 116 kB at 960, 118 to 528 kB at 2560 — and no device is
 *     handed a rendition it cannot show. See `SIZES`.
 *   - No second plate is fetched on mount. One arrives when the pointer crosses a battlefield
 *     the player has not chosen, and one more only after they have been on the screen long
 *     enough to have read it. A visitor who clicks BATTLE in three seconds pays for one image.
 *
 * Measured, and it is the only reason any of the above is worth writing down.
 * `node tools/qa-hostload.mjs --reps=4`, over `192.168.1.77` with the cache cleared through
 * CDP for every rep — the guest, not the host. Two sessions before the change and three after,
 * on a machine shared with other agents at load 9 to 18.
 *
 * | the menu page, 30 Mbit/s Wi-Fi | before A | before B | after A | after B | after C |
 * |---|---:|---:|---:|---:|---:|
 * | first contentful paint | 92 ms | 90 ms | **88 ms** | **90 ms** | 366 ms |
 * | time to interactive | 347 | 343 | **349** | **347** | 936 |
 * | (its four reps) | 349/348/345/345 | 342/345/342/343 | 349/350/345/348 | 345/347/482/347 | 939/942/933/933 |
 * | `/bundle` before interactive | 837 kB / 4 | 837 kB / 4 | **839 kB / 4** | **839 kB / 4** | 839 kB / 4 |
 * | bytes once settled | 1.15 MB / 8 | 1.15 MB / 8 | **1.17 MB / 8** | **1.17 MB / 8** | 1.14 MB / 8 |
 *
 * **Session C is a machine artefact and is printed rather than dropped.** Its *unthrottled*
 * arm — the same page with no network emulation at all — reads 264 ms against session A's 93,
 * which is the tell: nothing on a 30 Mbit link explains a page getting three times slower with
 * the throttle off, and the box was at load 18 with three other agents on it. Dropping it
 * would have been dropping the run that did not flatter.
 *
 * **What the honest reading is.** First paint does not move. Interactive reads 343 and 347
 * before, 347 and 349 after — 6 ms across sixteen reps of an instrument whose own spread
 * inside one session reached 137 ms (the 482 in after B) and across sessions 593 ms. This tool
 * cannot resolve a 6 ms difference and the design predicts none.
 *
 * The critical path moved by **2 kB**: `/bundle` 837 to 839, which is this module and
 * `pressPlates.ts` growing from nine entries to twenty-three. The settled row went up by
 * 20 kB, and that number is the interesting one — the plates are now up to 78 % wider in each
 * dimension, and the settled cost is flat because AVIF paid for the density. On the 1,280 px
 * 1x client `qa-hostload` emulates, the old policy fetched a 1,440 WebP and the new one
 * fetches a 1,920 AVIF for about the same bytes and a sharper picture.
 *
 * `tools/scratch/menu-critical.mjs`, against the built server over the same LAN address, puts
 * **842 kB over 6 requests** before the menu is interactive and no image among them on two
 * reps of three. On the third, two plates land inside the 250 ms that probe takes to observe
 * interactive at all — which is 160 ms later than `qa-hostload` observes it, so that rep is
 * the instrument's resolution rather than a plate on the critical path. The property is a
 * design one and it is stated as such: `MainMenu` calls `arm()` after the sheet has faded in,
 * and nothing here fetches before `arm()`.
 *
 * **One cost the rotation really does add, and it is not on the critical path.** A returning
 * visitor used to get the whole page from cache — 212 B on a warm revisit. They now get a
 * different frame, so the warm revisit fetches one plate: 280 to 604 kB across the three
 * sessions. That is the feature working, and it is the price of it.
 *
 * ---------------------------------------------------------------------------
 * Motion, and the machines that should not be asked for any
 * ---------------------------------------------------------------------------
 *
 * Both moves are `transform` and `opacity` on their own layers, which the compositor runs
 * without the main thread, and they are composed across two nested elements so that the ambient
 * drift and the travel between vantages never have to be reconciled in JavaScript.
 *
 * The rule for who gets motion is measured rather than sniffed, which is the client-side form
 * of the argument `tools/lib/work-budget.mjs` makes about agent browsers: price the work and
 * observe before granting, rather than counting handles or reading a user agent. Before the
 * drift starts, `afford()` watches the menu's own frame cadence for half a second. A machine
 * that cannot composite a still menu at better than 20 ms a frame is a machine with something
 * more important to do, and it gets one static frame.
 *
 * On top of that, four declared refusals, none of which needs a measurement to be certain:
 * `prefers-reduced-motion: reduce`, `saveData`, a 2G effective connection, and a viewport
 * narrower than `HUD_MIN_WIDTH` — the width at which `NetLobby` already refuses to start a
 * battle at all. A device that has been told it is too narrow to play on does not get wallpaper.
 *
 * **Density answers to the same gate, and that is new.** Refusing a slow machine the animation
 * and then handing it the widest plate in the set answers half the question: a 2,560-wide AVIF
 * is 6.6 megapixels to decode and a 26 MB compositor layer to hold, on a machine that was
 * already missing frames doing nothing. `sizesNow()` drops it one rung — see `SIZES_REDUCED`,
 * which also says what it cannot do, which is help the first plate.
 */

import { HERO, PRESS_PLATES, type PressPlate } from './pressPlates';
import { HUD_MIN_WIDTH } from './NetLobby';
import type { MapId } from '../maps';
import type { ScenarioId } from '../sim/battleConfig';

/**
 * ---------------------------------------------------------------------------
 * Which frame stands behind which screen, and what "at random" is allowed to mean
 * ---------------------------------------------------------------------------
 *
 * This used to be a six-entry table mapping `map:scenario` to one hard-coded frame, because
 * there was one frame per battle to map to. There are now several, and the owner asked for
 * them to be randomised. Randomising is not one rule, because the two screens are not doing
 * the same job:
 *
 *   - **The front door names no battle.** Its picture is the game's face and may be any frame
 *     in the set. That is the whole of the variety the owner asked for: a visitor who comes
 *     back tomorrow sees a different battle.
 *
 *   - **The setup screen names one.** The backdrop's entire claim is that going deeper
 *     *travels somewhere*: press Carthage and the camera flies to Carthage. A frame drawn at
 *     random from the whole set would break that on the first roll, and it would break it
 *     worst at the exact moment it matters — a player looking at the greyed-out storm row on
 *     Pydna, being told there is no wall, over a picture of a wall.
 *
 * So the deeper screens draw at random **from the frames of the battle the menu names**, which
 * is why `map` and `scenario` are on every `PressPlate`. `PLATE_FOR` is gone; the grouping is
 * derived from the manifest instead of restated beside it, so a frame added to `public/press/`
 * is in the rotation the moment `tools/make-brand.mjs` runs, and cannot be in the rotation for
 * a battle it is not a picture of.
 *
 * Pydna still has no assault, and the fall-through is deliberate and ordered: the frames of
 * this exact battle, else any frame of this map, else — which cannot happen while the manifest
 * has three maps in it — the whole set. Falling back to *the map* rather than to the front
 * door's plate is what keeps the greyed-storm moment honest: the picture is still Pydna.
 */
const forBattle = (map: MapId, scenario: ScenarioId): readonly PressPlate[] => {
  const exact = PRESS_PLATES.filter((p) => p.map === map && p.scenario === scenario);
  if (exact.length > 0) return exact;
  const sameMap = PRESS_PLATES.filter((p) => p.map === map);
  return sameMap.length > 0 ? sameMap : PRESS_PLATES;
};

/**
 * The roll, and why it is not `Math.random`.
 *
 * Not for entropy quality — nothing here needs any. `tools/check-determinism.mjs` bans
 * `Math.random()` outright in `src/sim`, `src/ai` and `src/units`, where the only legal source
 * of randomness is `Rng` from `src/util/rand.ts`, seeded off the battle so that two machines
 * fight the same one. `src/ui` is outside that scan, so a `Math.random()` here would pass the
 * gate and would then be a call somebody has to *prove* never reaches a battle. A different API
 * cannot be mistaken for the simulation's, and that is the whole reason for it.
 *
 * The modulo is biased by about one part in a hundred million against a set of this size, which
 * is four orders of magnitude below the point at which anyone could observe it in wallpaper.
 */
const roll = (n: number): number => {
  if (n <= 1) return 0;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
};

/**
 * How much scrim this frame needs *behind the menu sheet*, which is not what was measured.
 *
 * `scrimForGold` in `public/press/manifest.json` is the smallest black alpha at which gold
 * type clears 4.5:1 laid **directly on the frame**, and the manifest is explicit that this is
 * the harder case: *"`scrimForGold` below is the number for type laid DIRECTLY on a frame …
 * the one to check if the sheet ever thins."* This pass thinned the sheet, so the number has
 * to be re-derived rather than either used raw or ignored.
 *
 * The arithmetic, from the manifest's own `type.panelP95` and the sheet's colour. Gold
 * `#d9b25f` has relative luminance 0.49, so 4.5:1 needs the background under it at
 * `(0.49 + 0.05) / 4.5 - 0.05 = 0.070`. The sheet is `rgba(30,24,17,.8)` to
 * `rgba(14,11,8,.88)`, mean alpha 0.84 and own luminance about 0.01, so what reaches the eye
 * is `0.84 x 0.01 + 0.16 x (1 - a) x panelP95`. Setting that to 0.070 and solving:
 *
 *     a >= 1 - 0.385 / panelP95
 *
 * ---------------------------------------------------------------------------
 * This was `scrimForGold - 0.30`, and the flat subtraction has now been measured wrong
 * ---------------------------------------------------------------------------
 *
 * That approximation was fitted to a nine-frame set whose brightest panel region measured
 * `panelP95` 0.558, and across that set it cleared the requirement everywhere with headroom.
 * Two things then moved at once. The set grew to twenty-three frames, several of them shot
 * into a low sun with sky reaching well down the frame; and `PANEL_BOX` in
 * `tools/make-brand.mjs` was corrected, because the old box was measuring a region a tenth of
 * a frame higher than the sheet actually covers. The brightest `panelP95` in the set is now
 * **0.828**, which the formula above says needs `a >= 0.535` — and `0.70 - 0.30` is 0.40.
 * The approximation was not slightly off, it was short by a third on three frames.
 *
 * So the approximation is gone and the arithmetic it approximated is used directly. Every
 * plate carries its own `panelP95` and gets exactly the scrim its own measurement asks for:
 * 0.535 on `press-rome-grey`, 0.275 on `press-rome-city`, and **zero** on the dark frames —
 * `press-rome-melee` at 0.070, `press-rome-cavalry` at 0.077, `press-carth-elephants` at
 * 0.094 — which is more pictures showing through unscrimmed than the flat rule allowed.
 *
 * The model ignores the sheet's `backdrop-filter: blur`, which lowers local contrast further,
 * so it errs toward more scrim than is needed rather than less.
 *
 * `SCRIM_CEILING` is a guard rather than a tuning knob. A frame whose panel region is brighter
 * than about 0.86 asks for more than 0.55, and at that point the backdrop is darker than the
 * gradient it replaced — the honest answer for such a frame is not to have it in the set, and
 * `tools/make-brand.mjs` says so when it measures one.
 */
const GOLD_ON_SHEET = 0.385;
const SCRIM_CEILING = 0.55;
const scrimUnderSheet = (p: PressPlate): number =>
  Math.min(SCRIM_CEILING, Math.max(0, 1 - GOLD_ON_SHEET / Math.max(p.panelP95, 1e-6)));

/**
 * ---------------------------------------------------------------------------
 * How wide a rendition to ask for, and the CSS-pixel mistake this replaces
 * ---------------------------------------------------------------------------
 *
 * This was `(max-width: 1440px) 100vw, 1440px`, and the argument written here for it was that
 * a bare `100vw` on a 1,600 px window took the 1,920 rendition for little gain, so the ask was
 * capped at the middle rung. **That whole measurement was in CSS pixels.** On a 2x display
 * every CSS pixel is two device pixels and `srcset` knows it, so the cap was not saving a
 * marginal rendition — it was refusing the only one that would have been sharp.
 *
 * `tools/scratch/menu-density.mjs` inverts the real chain in the live page. `object-fit: cover`
 * scales the frame until it covers a viewport that is rarely 16:9; `.bd-travel` scales it again
 * by the vantage, 1.18 at the front door and 1.42 on the setup screen; `.bd-drift` adds 1.035
 * to 1.06; and then the display doubles it. Measured, at the front door:
 *
 * | window | cover | x travel x drift | drawn CSS | x dpr | it was given |
 * |---|---:|---:|---:|---:|---|
 * | 1366x768 @1 | 1.000 | | 1,669 | 1,669 | 1440 |
 * | 1920x1080 @1 | 1.000 | | 2,345 | 2,345 | 1440 |
 * | 1512x982 @2 | 1.155 | | 2,132 | **4,265** | 1440, hero 1920 |
 * | 1728x1117 @2 | 1.149 | | 2,426 | **4,851** | 1440, hero 1920 |
 *
 * On the setup screen the last row is **5,838**. So the owner, on a 16-inch Retina Mac, was
 * looking at a 1,440 px picture across 5,838 device pixels — 4.05x — and the reason he said it
 * looked soft is that it was.
 *
 * ---------------------------------------------------------------------------
 * What `sizes` says now
 * ---------------------------------------------------------------------------
 *
 * The over-scale is stated honestly and the browser is left to do the density arithmetic
 * itself, which is the one thing `srcset` is genuinely good at and the reason there is no
 * hand-rolled picker here. Three branches, each a number off the table above:
 *
 *   - **`(max-width: 720px) 100vw`** — a deliberate cap, not an honest figure. `cover` on a
 *     portrait phone wants nearly four times the viewport width, and at `dpr: 3` that is a 4K
 *     plate for a 390 px screen. A phone gets its own width and the frame is soft on it; it is
 *     the one class of device for which that is obviously the right trade.
 *   - **`(min-aspect-ratio: 16/9) 124vw`** — a window at least as wide as the frame crops
 *     nothing, so the whole over-scale is 1.18 x 1.05 = 1.239.
 *   - **`(min-aspect-ratio: 8/5) 138vw`** — 16:10 and wider than 1.6 puts `cover` at up to
 *     1.111, and 1.111 x 1.239 = 1.377.
 *   - **`143vw`** — everything else, which on a desktop is the 1.54-ish shape of a Mac's
 *     browser window: `cover` 1.155 x 1.239 = 1.431. A window taller than about 4:3 is under-
 *     served on purpose, for the same reason as the phone.
 *
 * **Pegged to the front door, not to the setup screen.** The vantage changes at runtime and
 * `sizes` cannot, so one of the two screens has to be the one it is right for. Pegging to the
 * setup screen's 1.42 would move a 1,366 px 1x laptop from the 1920 rung to the 2560 — four
 * times the bytes of what it has today, on a machine that cannot show the difference. Pegging
 * to the door leaves the setup screen asking for 1.20x less than it paints across, which on
 * every 2x Mac lands on the same top rung anyway and on a 1x laptop is one rung of softness on
 * the second screen. That is the cheaper mistake and it is made deliberately.
 *
 * The media-query form rather than `min(100vw, …)`: every browser that understands `srcset` at
 * all understands media queries, and `min()` inside `sizes` is a good deal newer than the
 * oldest Safari this project still renders on.
 *
 * ---------------------------------------------------------------------------
 * Measured after, on the same instrument and the same seven machines
 * ---------------------------------------------------------------------------
 *
 * | window | front door | setup | before | after |
 * |---|---:|---:|---:|---:|
 * | 1366x768 @1 | 1,669 | 2,008 | 1.16x / 1.39x | **0.87x / 1.05x** |
 * | 1920x1080 @1 | 2,345 | 2,822 | 1.63x / 1.96x | **0.92x / 1.10x** |
 * | 1440x900 @2 | 3,911 | 4,706 | 2.71x / 3.27x | **1.53x / 1.84x** |
 * | 1512x982 @2 | 4,265 | 5,133 | 2.96x / 3.57x | **1.67x / 2.00x** |
 * | **1728x1117 @2** | 4,854 | 5,842 | **3.37x / 4.05x** | **1.90x / 2.28x** |
 * | 1920x1080 @2 | 4,690 | 5,644 | 3.26x / 3.92x | **1.83x / 2.20x** |
 *
 * The painted columns are from the after run and the before run's differ by up to three pixels
 * in five thousand, because `.bd-drift` is a 64-second animation and the two runs sampled it at
 * different phases. The before column is the eight frames that were **not** the hero; the hero
 * itself was at 2.53x and 3.04x on the worst row, and that asymmetry is gone. **Every 1x machine is now at or
 * below 1:1** — the picture on those has more pixels than the display can draw — and the 2x
 * machines are where the remaining upscale lives, because 2560 is where the ladder stops and
 * `PLATE_WIDTHS` in `tools/make-brand.mjs` says why with the numbers.
 */
const SIZES = [
  '(max-width: 720px) 100vw',
  '(min-aspect-ratio: 16/9) 124vw',
  '(min-aspect-ratio: 8/5) 138vw',
  '143vw',
].join(', ');

/**
 * The same picture, one rung down, for a machine that has said it cannot afford the full one.
 *
 * The affordance gate below already refuses *motion* to a machine that cannot composite a still
 * menu at better than 20 ms a frame, and to anything declaring `saveData` or a 2G link. Density
 * has to answer to the same gate, and for a reason the motion rule does not cover: a 2560-wide
 * AVIF is not just 340 kB of network, it is **6.6 megapixels to decode and a 26 MB compositor
 * layer to hold**, on a machine that was already missing frames doing nothing. Refusing it the
 * animation and then handing it the biggest plate in the set is answering half the question.
 *
 * `55vw` is not a taste, it is the arithmetic that reliably drops exactly one rung on the
 * machines that matter. The ladder is 960/1440/1920/2560 and a browser takes the smallest rung
 * at least as wide as `sizes x devicePixelRatio`, so on the 16-inch 2x Mac the honest 143vw
 * asks for 4,942 and takes 2560; `55vw` asks for 1,901 and takes 1920. On a 1x laptop it drops
 * from 1920 to 960, which is further than one rung and is deliberate — a 1x machine that cannot
 * composite a still menu is not a machine to spend two megapixels on.
 *
 * It cannot help the **first** plate on a slow machine, and that is not an oversight: the gate
 * is a measurement that takes half a second, and half a second after `arm()` the first plate is
 * already chosen and in flight. Sniffing something faster was the alternative and is the thing
 * `afford()` exists to avoid. What this does cover is every plate after it — the setup screen,
 * every hover, every battle the player looks at — which on a session of any length is most of
 * them.
 */
const SIZES_REDUCED = '(max-width: 720px) 100vw, 55vw';

const byId = new Map(PRESS_PLATES.map((p) => [p.id, p]));
const plate = (id: string): PressPlate => byId.get(id) ?? HERO;

/**
 * A vantage: where in the frame the camera is looking, and how close.
 *
 * `x`/`y` are the point of the frame to centre, in fractions of its width and height, and `z`
 * is the over-scale. 1.0 would be the whole frame edge to edge; both of these are above it,
 * because a camera that can travel needs somewhere to travel to.
 *
 * The two numbers are read off the frames rather than invented. The manifest gives each frame's
 * row-major 3×3 mean luminance, and on the hero it is
 * `[0.22, 0.20, 0.11 / 0.027, 0.030, 0.026 / 0.012, 0.012, 0.010]` — the top row is four to
 * twenty times brighter than the bottom two. So the front door sits high enough to keep the lit
 * sky in the frame, and the setup screen drops to `y 0.62`, into the dark ranks, where a sheet
 * full of gold type has the least to fight.
 */
interface Vantage { x: number; y: number; z: number }

/**
 * Two vantages per screen, and the pairing is the design.
 *
 * The front door sits back and high; pressing BATTLE moves in and down — to the same frame when
 * the chosen battlefield is Rome's field battle, and to a different one otherwise. Nothing cuts.
 */
const DOOR: Vantage = { x: 0.5, y: 0.42, z: 1.18 };
const SETUP: Vantage = { x: 0.46, y: 0.62, z: 1.42 };

export type BackdropScreen = 'home' | 'setup';

/** `requestIdleCallback`, with the fallback Safari needed until 17.4, and a typed handle. */
type Deferred = { kind: 'idle' | 'timer'; id: number };
const defer = (fn: () => void, timeout: number): Deferred =>
  (typeof requestIdleCallback === 'function'
    ? { kind: 'idle', id: requestIdleCallback(fn, { timeout }) }
    : { kind: 'timer', id: window.setTimeout(fn, Math.min(timeout, 400)) });
const undefer = (h: Deferred): void => {
  if (h.kind === 'idle') cancelIdleCallback(h.id);
  else clearTimeout(h.id);
};

/** The subset of `NetworkInformation` this reads. Absent in Safari and Firefox; all optional. */
interface SaveDataHints { saveData?: boolean; effectiveType?: string }
const netHints = (): SaveDataHints =>
  (navigator as Navigator & { connection?: SaveDataHints }).connection ?? {};

interface Slot {
  layer: HTMLElement;
  travel: HTMLElement;
  /** The AVIF ladder. The `<img>` below is the one WebP a browser without AVIF falls back to. */
  avif: HTMLSourceElement;
  img: HTMLImageElement;
  id: string | null;
}

export class MenuBackdrop {
  private root: HTMLElement;
  private slots: [Slot, Slot];
  private scrim: HTMLElement;
  private front = 0;
  private current: string | null = null;
  /** Screen key to the frame it drew. Written once per key; see `pick`. */
  private readonly chosen = new Map<string, string>();
  /** Every frame already handed to a key this session, so nothing repeats while others are free. */
  private readonly spent = new Set<string>();
  private armed = false;
  private disposed = false;
  private pending: Deferred | null = null;
  /** False when this device gets one still and no motion. Decided once, in `arm`. */
  /**
   * `null` until `afford()` has finished measuring, then the answer.
   *
   * Three states rather than two, because "not yet known" and "no" want opposite defaults and
   * a boolean has to pick one. Movement treats an unknown as no — nothing may animate before
   * the machine has been asked. Density treats it as yes — the first plate is chosen and in
   * flight long before the gate resolves, and a `false` default would quietly hand every
   * machine, fast or slow, a rendition one rung below the one it asked for.
   */
  private motion: boolean | null = null;
  private readonly reduced: boolean;
  private readonly thrifty: boolean;
  private readonly tooNarrow: boolean;

  constructor(host: HTMLElement) {
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hints = netHints();
    this.thrifty = !!hints.saveData || /(^|-)2g$/.test(hints.effectiveType ?? '');
    this.tooNarrow = window.innerWidth < HUD_MIN_WIDTH;

    // `.menu-bg` is the mount point `public/press/manifest.json` names, and it is the class the
    // stylesheet already targets — no second class is added here, because a hook that only one
    // side of the pair knows about is how a stylesheet and a module quietly stop agreeing.
    this.root = host;
    // Wallpaper, announced to nobody. A screen reader that reads out a battlefield before the
    // menu has said anything is worse than silence, and every frame's real `alt` text is on the
    // plate in `pressPlates.ts` for the places that do want it.
    this.root.setAttribute('aria-hidden', 'true');
    this.slots = [this.makeSlot(), this.makeSlot()];
    for (const s of this.slots) this.root.appendChild(s.layer);
    this.scrim = document.createElement('div');
    this.scrim.className = 'bd-scrim';
    this.root.appendChild(this.scrim);
    const grain = document.createElement('div');
    grain.className = 'bd-grain';
    this.root.appendChild(grain);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private makeSlot(): Slot {
    const layer = document.createElement('div');
    layer.className = 'bd-slot';
    const travel = document.createElement('div');
    travel.className = 'bd-travel';
    const drift = document.createElement('div');
    drift.className = 'bd-drift';
    /*
     * `<picture>`, and the two formats are not two qualities of the same thing.
     *
     * The AVIF ladder is on the `<source>`; the single WebP is the `<img>`'s own `src`. AVIF
     * is 26 % smaller than WebP at equal measured detail on the worst frame in the set and
     * both smaller and sharper on the smooth ones, which is the whole reason the density rise
     * this pass is about is affordable at all. Safari below 16.4 cannot decode it and can
     * still run this game's WebGL2, so it gets the `<img>` — at exactly the width and quality
     * every browser was served before this pass, which makes the fallback a known quantity
     * rather than a new one.
     *
     * A `<source>` is chosen on its `type` before anything is fetched, so a browser never
     * pays for both. The `error` handler below still fires on the `<img>` whichever was
     * chosen, because that is where an image failure is reported for the whole element.
     */
    const picture = document.createElement('picture');
    const avif = document.createElement('source');
    avif.type = 'image/avif';
    // `sizes` is deliberately not set here. `show` writes it beside the `srcset` on every
    // assignment, because what this machine can afford is not known at construction — the
    // affordance gate takes half a second to answer. A value set here would be inert (there
    // is no `srcset` yet) and would read as though it were the one in force.
    const img = document.createElement('img');
    img.className = 'bd-img';
    img.decoding = 'async';
    img.alt = '';
    // Low, and it is the whole cost argument in one attribute: a picture behind a menu must
    // never be scheduled ahead of the modules the menu itself is made of.
    img.setAttribute('fetchpriority', 'low');
    /*
     * A plate that will not load leaves the gradient, which is a complete screen.
     *
     * `.menu-bg` keeps the radial-and-linear it has always had as its floor, so hiding a broken
     * image is a full recovery rather than a hole — the menu looks exactly as it did before this
     * module existed. Without this it is a broken-image glyph in the middle of the front door.
     *
     * **It does not silence the console, and it cannot.** A 404 on an `<img>` is logged by the
     * browser whatever the page does, and three `qa-net` arms assert that this page raises no
     * console error — the same coupling `index.html` documents at length for the favicon. So the
     * standing constraint is that `public/press/` must exist wherever this page is served.
     * `tools/optimize-assets.mjs` re-emits only what the texture manifest lists under
     * `dist/assets`, which is exactly why these files live at `public/press/` and not under it.
     */
    // Not `{ once: true }`: the two slots carry every plate the session shows, so the handler
    // has to survive to catch a second failure in the same slot.
    img.addEventListener('error', () => { img.style.display = 'none'; });
    picture.appendChild(avif);
    picture.appendChild(img);
    drift.appendChild(picture);
    travel.appendChild(drift);
    layer.appendChild(travel);
    return { layer, travel, avif, img, id: null };
  }

  /**
   * How much picture this machine is being offered, right now.
   *
   * `thrifty` and `tooNarrow` are known at construction and so reach even the first plate;
   * `motion` is the measured gate and only reaches the ones after it. Read on every assignment
   * rather than cached, because the gate resolves half a second in and the answer legitimately
   * changes once.
   */
  private sizesNow(): string {
    return this.thrifty || this.tooNarrow || this.motion === false
      ? SIZES_REDUCED : SIZES;
  }

  /**
   * Which frame this key gets, decided once and then remembered.
   *
   * The memo is not an optimisation, it is the whole of "it must not flash or pop". `refresh()`
   * in `MainMenu` is the single writer that drives this screen and it calls `show()` on every
   * pass — a hover, a map change, a scenario change, a return to the front door — so a chooser
   * that rolled on every call would change the picture under a player who had merely moved the
   * mouse. Rolling once per key makes `show()` idempotent for that key, which is the property
   * the one-writer design already depends on everywhere else.
   *
   * It is also what makes the roll happen *before first paint*: the front door's key is
   * resolved inside `arm()`, on the same turn that sets the `<img>`'s `src`, so there is never
   * a moment where one frame is on screen and another is being decided.
   *
   * `spent` is the no-repeats rule. A frame already given to another screen is taken out of the
   * pool, so a session that visits the front door and then three battlefields shows four
   * different pictures rather than the same Carthage frame twice. When a battle has fewer
   * frames left than screens asking — Pydna's two, if both had already been spent — the filter
   * empties and the full pool comes back, because showing a repeat is better than showing
   * nothing and far better than showing the wrong battle.
   */
  private pick(key: string, from: readonly PressPlate[]): string {
    const already = this.chosen.get(key);
    if (already !== undefined) return already;
    const fresh = from.filter((p) => !this.spent.has(p.id));
    const pool = fresh.length > 0 ? fresh : from;
    const id = pool[roll(pool.length)].id;
    this.chosen.set(key, id);
    this.spent.add(id);
    return id;
  }

  /**
   * Start fetching, and decide whether this machine gets motion.
   *
   * Called by `MainMenu` **after** the sheet has laid out and faded in, which is what keeps the
   * cold load's 350 ms intact: until this runs the backdrop is four empty divs and zero bytes.
   */
  arm(screen: BackdropScreen, map: MapId, scenario: ScenarioId): void {
    if (this.armed || this.disposed) return;
    this.armed = true;
    void this.afford().then((ok) => {
      if (this.disposed) return;
      this.motion = ok;
      this.root.classList.toggle('bd-still-only', !ok);
    });
    this.show(screen, map, scenario, true);
    /*
     * Everything else waits until the visitor has demonstrably stayed. `defer` gives the
     * browser the chance to say the page is busy; the ceiling stops it waiting for ever on a
     * page that never goes idle.
     *
     * **Which plate this warms changed when the front door started rolling dice, and the old
     * choice became wrong rather than merely suboptimal.** It used to warm the *opposite*
     * scenario, and that was right: the front door always showed the hero, the hero was also
     * `campus-martius:field`'s plate, so pressing BATTLE on the default battle needed no fetch
     * at all and the only unwarmed thing nearby was the storm. Now the front door's frame is
     * drawn from the whole set and is almost never the one the setup screen will want, so
     * BATTLE — the single likeliest next press on this screen, and the one the whole front door
     * is pointing at — became the one plate nobody had warmed.
     *
     * On a session that opened straight onto the setup sheet there is no such gap, because
     * `show` above has already fetched that battle; there the opposite scenario is still the
     * useful guess. `prefetch` would decline the redundant one anyway (`want === this.current`),
     * so this is about spending the one warm fetch well rather than about avoiding a mistake.
     */
    const flip: ScenarioId = scenario === 'assault' ? 'field' : 'assault';
    this.pending = defer(() => {
      this.pending = null;
      this.prefetch(map, screen === 'home' ? scenario : flip);
    }, 2400);
  }

  /**
   * Can this machine afford to animate?
   *
   * Half a second of the menu's own frame cadence, measured before anything moves. This is the
   * client-side form of `tools/lib/work-budget.mjs`'s argument — observe the machine, do not
   * count handles or read a user agent — and it catches what a user-agent string cannot: a
   * laptop on battery that has dropped its refresh rate, a GPU already busy with the owner's
   * game in another window, and a browser whose compositor has fallen back to software.
   *
   * 20 ms is the threshold and it is deliberately generous. A 60 Hz machine idles at 16.7 ms
   * and a 30 Hz one at 33 ms; the point is not to demand 60 fps for wallpaper, it is to refuse
   * to add compositor work to a machine that is already missing frames doing nothing.
   */
  private afford(): Promise<boolean> {
    if (this.reduced || this.thrifty || this.tooNarrow || document.hidden) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const gaps: number[] = [];
      let last = performance.now();
      const end = last + 500;
      const beat = (now: number): void => {
        gaps.push(now - last);
        last = now;
        if (this.disposed) { resolve(false); return; }
        if (now < end && gaps.length < 60) { requestAnimationFrame(beat); return; }
        // The first gap is the scheduling of the first callback and is not a frame.
        const g = gaps.slice(1).sort((a, b) => a - b);
        resolve(g.length > 0 && g[Math.floor(g.length / 2)] <= 20);
      };
      requestAnimationFrame(beat);
    });
  }

  /**
   * Fly to the frame for this screen and this battle.
   *
   * One code path for the opening move and for every later one, deliberately: the push-in a
   * visitor sees when the front door appears is the same gesture they see when they press
   * Carthage, so the screen has one camera rather than two.
   */
  show(screen: BackdropScreen, map: MapId, scenario: ScenarioId, first = false): void {
    if (this.disposed || !this.armed) return;
    const want = screen === 'home'
      ? this.pick('home', PRESS_PLATES)
      : this.pick(`${map}:${scenario}`, forBattle(map, scenario));
    const vantage = screen === 'home' ? DOOR : SETUP;
    const p = plate(want);

    this.scrim.style.setProperty('--bd-scrim', scrimUnderSheet(p).toFixed(2));

    if (want !== this.current) {
      const nextIdx = this.current === null ? this.front : 1 - this.front;
      const next = this.slots[nextIdx];
      const prev = this.slots[this.front];
      if (next.id !== want) {
        // Clear the hide a previous failure may have left on this slot: the two slots are
        // reused for every plate the session shows, so a 404 on Carthage must not blank the
        // frame that lands in the same slot afterwards.
        next.img.style.removeProperty('display');
        // The `<source>` first, then the `<img>`. A browser that has already begun selecting
        // for this element re-runs the whole selection when either changes, so the order only
        // decides whether one redundant WebP request can be started and then abandoned.
        next.avif.sizes = this.sizesNow();
        next.avif.srcset = p.srcset;
        next.img.src = p.src;
        next.id = want;
      }
      // Enter from slightly wider than the vantage being flown to, so the incoming frame is
      // still moving when it becomes visible and the change reads as travel rather than a cut.
      if (first || !this.motion) this.setVantage(next, vantage);
      else {
        this.setVantage(next, { x: vantage.x, y: vantage.y, z: vantage.z * 1.1 });
        requestAnimationFrame(() => { if (!this.disposed) this.setVantage(next, vantage); });
      }
      next.layer.classList.add('on');
      if (prev !== next) prev.layer.classList.remove('on');
      this.front = nextIdx;
      this.current = want;
      return;
    }
    // Same frame, new vantage: the camera moves within the picture rather than between two.
    // This is the front-door-to-setup move on Rome's field battle, and it is the best of the
    // three, because nothing dissolves — the camera simply goes somewhere.
    this.setVantage(this.slots[this.front], vantage);
  }

  private setVantage(s: Slot, v: Vantage): void {
    s.travel.style.setProperty('--bd-x', `${((0.5 - v.x) * 100).toFixed(2)}%`);
    s.travel.style.setProperty('--bd-y', `${((0.5 - v.y) * 100).toFixed(2)}%`);
    s.travel.style.setProperty('--bd-z', v.z.toFixed(3));
  }

  /**
   * Decode the frame behind a battlefield the pointer is merely crossing.
   *
   * The switch a player is a quarter of a second away from making is then already in memory.
   * One image, on hover, for a battle they have actually looked at — which is a different thing
   * from fetching all forty-five because the menu opened.
   *
   * **Through `pick`, not around it.** This is the one place where randomising could have
   * quietly cost bytes instead of saving them: a prefetch that rolled its own frame would warm
   * one picture and `show()` would then fetch a different one, so every hover would pay twice
   * and the cache would be worse than useless. `pick` is memoised per key, so the frame this
   * warms *is* the frame that arrives — and the roll for that battle happens here, on hover,
   * which is earlier than it otherwise would and therefore strictly better.
   *
   * The `<img>` this builds carries no `srcset`, deliberately: it warms the WebP fallback for
   * a browser that has no AVIF, and the AVIF ladder for one that does, by way of the
   * `<picture>` shape below. A bare `Image()` cannot express a `<source>`, so it is built as
   * one — six lines rather than a link-rel-preload, which cannot express `sizes` correctly on
   * every browser this still runs on.
   */
  prefetch(map: MapId, scenario: ScenarioId): void {
    if (this.disposed || !this.armed || this.thrifty) return;
    const want = this.pick(`${map}:${scenario}`, forBattle(map, scenario));
    if (want === this.current) return;
    const p = plate(want);
    const picture = document.createElement('picture');
    const avif = document.createElement('source');
    avif.type = 'image/avif';
    avif.sizes = this.sizesNow();
    avif.srcset = p.srcset;
    const img = document.createElement('img');
    img.decoding = 'async';
    img.alt = '';
    img.setAttribute('fetchpriority', 'low');
    picture.appendChild(avif);
    picture.appendChild(img);
    img.src = p.src;
  }

  private onVisibility = (): void => {
    // A hidden tab composites nothing anybody can see. Parking the drift is the same discipline
    // the superseded branch applied to a video stream it had deliberately kept loaded.
    this.root.classList.toggle('bd-parked', document.hidden);
  };

  /**
   * Take the picture down and let go of the bytes.
   *
   * Called from `MainMenu.commit`, **before** it resolves, so the battle's `Engine` is
   * constructed with no decoded 2,560-wide frames still held and no compositor layers still
   * animating. The node itself is `.menu-bg`, which `MainMenu` removes with the rest of the
   * menu when the fade finishes; this only stops the work.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending) { undefer(this.pending); this.pending = null; }
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.root.classList.add('bd-parked');
    // The `<source>` as well as the `<img>`: leaving a `srcset` on the source keeps the
    // selected AVIF alive for as long as the element is, which is the opposite of the point.
    for (const s of this.slots) {
      s.avif.removeAttribute('srcset');
      s.img.removeAttribute('srcset');
      s.img.removeAttribute('src');
    }
  }
}
