/**
 * The moving picture behind the menu.
 *
 * Nine real frames of this game — `public/press/`, shot by `tools/shoot.mjs --set=press` and
 * described in `manifest.json` beside them — laid full-bleed behind both menu sheets, with a
 * camera that never stops moving and that **travels somewhere new as the player goes deeper**.
 * The front door looks at the legionary line. Pressing BATTLE flies in to the battlefield that
 * is currently selected. Pressing Carthage flies to Carthage; choosing the storm flies from the
 * Punic field army to the wall it has to climb.
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
 *     which `MainMenu` does only after the sheet has laid out and faded in. First paint and
 *     time-to-interactive are therefore the same bytes and the same frames as before it existed.
 *   - The first plate is chosen by `srcset` with a capped `sizes`, so a laptop takes the
 *     1,440-wide rendition at 236.2 kB, a phone takes the 960 at 88.8 kB, and nothing takes
 *     the 470 kB 1,920 — see `SIZES`, where a bare `100vw` was measured taking it.
 *   - No second plate is fetched on mount. One arrives when the pointer crosses a battlefield
 *     the player has not chosen, and one more only after they have been on the screen long
 *     enough to have read it. A visitor who clicks BATTLE in three seconds pays for one image.
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
 */

import { HERO, PRESS_PLATES, type PressPlate } from './pressPlates';
import { HUD_MIN_WIDTH } from './NetLobby';
import type { MapId } from '../maps';
import type { ScenarioId } from '../sim/battleConfig';

/**
 * Which frame stands behind which battle.
 *
 * The backdrop always shows the battle the menu currently names, and that is the whole
 * mechanism by which "going deeper travels somewhere new" is honest rather than decorative:
 * the picture is not wallpaper that happens to change, it is the engagement being chosen.
 *
 * `press-carth-elephants` is the Punic field army rather than a wall, and it is here because
 * the owner named it — *"or perhaps watching an elephant's charge idk."* It is also the frame
 * the manifest calls "the most arresting single frame in the set and the one nobody mistakes
 * for another game", which is a good reason to put it where a choice can reach it.
 *
 * Pydna has no wall and the menu greys its assault out, so both of its keys are the same frame
 * rather than one of them being absent: a lookup that can miss would fall back to the front
 * door's plate, and the one moment that must never happen is the moment a player is looking at
 * the row that explains why the storm is unavailable.
 */
const PLATE_FOR: Record<string, string> = {
  'campus-martius:field': 'press-rome-line',
  'campus-martius:assault': 'press-rome-wall',
  'carthage:field': 'press-carth-elephants',
  'carthage:assault': 'press-carth-wall',
  'pydna:field': 'press-pydna-clash',
  'pydna:assault': 'press-pydna-clash',
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
 * The arithmetic, from the manifest's own `type.panelP95` and the sheet's new colour. Gold
 * `#d9b25f` has relative luminance 0.49, so 4.5:1 needs the background under it at
 * `(0.49 + 0.05) / 4.5 - 0.05 = 0.070`. The sheet is `rgba(30,24,17,.8)` to
 * `rgba(14,11,8,.88)`, mean alpha 0.84 and own luminance about 0.01, so what reaches the eye
 * is `0.84 x 0.01 + 0.16 x (1 - a) x panelP95`. Solving for the worst frame in the set —
 * `press-rome-city`, `panelP95` 0.558, measured `scrimForGold` 0.65 — gives `a >= 0.31`;
 * `press-rome-wall` at 0.545 gives 0.29, `press-rome-host` at 0.525 gives 0.27, and
 * `press-rome-line` at 0.252 needs none at all.
 *
 * Subtracting a flat 0.30 reproduces that: 0.35 where the manifest says 0.65, 0.20 on the
 * hero, and 0 on the two frames it already calls quiet. Every one of those clears its own
 * requirement with headroom, and the ordering the measurement established is preserved — a
 * frame the instrument called dangerous is still the frame that gets the most scrim.
 *
 * 0.30 is therefore what an 84 %-opaque blurred sheet is *worth* in scrim, and it is
 * subtracted rather than multiplied because that is the shape of the relationship: the sheet
 * removes a fixed amount of the frame, it does not scale it.
 */
const SHEET_IS_WORTH = 0.3;
const scrimUnderSheet = (p: PressPlate): number => Math.max(0, p.scrimForGold - SHEET_IS_WORTH);

/**
 * How wide a rendition to ask for, and why it is capped at the middle one.
 *
 * A bare `100vw` is the obvious spelling and it was wrong, measured: on a 1,600 px window the
 * browser correctly resolved 1,600 and took the only rendition at least that wide — the hero's
 * 1,920, which is **470 kB**. Twice the 1,440 for a picture that is behind a 0.20 scrim, a
 * 3.5 % grain and, over most of its area, an 84 %-opaque blurred sheet.
 *
 * The manifest had already reached this conclusion about its own files: *"only the hero also
 * has 1920 … the third one buys almost nothing behind a menu."* Capping `sizes` is how that
 * sentence is enforced rather than merely agreed with. Measured after the change, on the four
 * arms of `tools/scratch/menu-degrade.mjs`: a 1,600 px window now takes the 1,440 rather than
 * the 1,920, and nothing takes the 1,920 at all. The 960 is reached only by a viewport of 960
 * CSS pixels or narrower, which is the honest reading of `sizes` and is a phone rather than
 * the 1,100 px laptop this file's first draft claimed — a window between 961 and 1,440 needs
 * more than 960 real pixels and correctly asks for the next one up.
 *
 * `(max-width: …) 100vw, 1440px` rather than `min(100vw, 1440px)`: the media-query form has
 * been understood by every browser that understands `srcset` at all, and `min()` inside
 * `sizes` is a good deal newer than the oldest Safari this project still renders on.
 */
const SIZES = '(max-width: 1440px) 100vw, 1440px';

/** The front door's own frame: the hero, which is the one that says nine thousand men. */
const DOOR_PLATE = HERO.id;

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
  img: HTMLImageElement;
  id: string | null;
}

export class MenuBackdrop {
  private root: HTMLElement;
  private slots: [Slot, Slot];
  private scrim: HTMLElement;
  private front = 0;
  private current: string | null = null;
  private armed = false;
  private disposed = false;
  private pending: Deferred | null = null;
  /** False when this device gets one still and no motion. Decided once, in `arm`. */
  private motion = false;
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
    drift.appendChild(img);
    travel.appendChild(drift);
    layer.appendChild(travel);
    return { layer, travel, img, id: null };
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
    // Everything else waits until the visitor has demonstrably stayed. `defer` gives the
    // browser the chance to say the page is busy; the ceiling stops it waiting for ever on a
    // page that never goes idle.
    this.pending = defer(() => {
      this.pending = null;
      this.prefetch(map, scenario === 'assault' ? 'field' : 'assault');
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
    const want = screen === 'home' ? DOOR_PLATE : (PLATE_FOR[`${map}:${scenario}`] ?? DOOR_PLATE);
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
        next.img.srcset = p.srcset;
        next.img.sizes = SIZES;
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
   * from fetching all nine because the menu opened.
   */
  prefetch(map: MapId, scenario: ScenarioId): void {
    if (this.disposed || !this.armed || this.thrifty) return;
    const want = PLATE_FOR[`${map}:${scenario}`];
    if (!want || want === this.current) return;
    const p = plate(want);
    const img = new Image();
    img.decoding = 'async';
    img.setAttribute('fetchpriority', 'low');
    img.sizes = SIZES;
    img.srcset = p.srcset;
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
   * constructed with no decoded 1,440-wide frames still held and no compositor layers still
   * animating. The node itself is `.menu-bg`, which `MainMenu` removes with the rest of the
   * menu when the fade finishes; this only stops the work.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending) { undefer(this.pending); this.pending = null; }
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.root.classList.add('bd-parked');
    for (const s of this.slots) { s.img.removeAttribute('srcset'); s.img.removeAttribute('src'); }
  }
}
