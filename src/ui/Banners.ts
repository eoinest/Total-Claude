/**
 * Unit banners: the thing that lets a player read a Total War battlefield at a glance.
 *
 * One small plaque per unit, pinned to the visual centre of its block and floated above
 * the men — faction standard, unit-class device, a strength bar and a morale strip,
 * with the unit's name appearing on hover, selection or while Alt is held.
 *
 * Placement is the whole problem. The anchor is the mean of the *screen* positions of the
 * unit's living men, read from the soldier pool at the frame's own interpolation alpha —
 * not the projection of their world centroid, and not anything out of the HUD's 10 Hz
 * digest. Both of those shortcuts were tried and both read as detached: projecting a
 * centroid puts the plaque up to 21 px off the middle of a wide block seen obliquely,
 * because perspective is nonlinear, and a 100 ms-old shape offset lags a unit that is
 * breaking or wheeling. See `centre`.
 *
 * Projection is DOM rather than sprites so the type stays vector-crisp at any zoom.
 * Only a `transform` is written per frame, which the compositor absorbs; content is
 * refreshed at 10 Hz alongside the rest of the HUD.
 *
 * Banners fade out as the camera comes down among the troops — at charge distance the
 * player wants the battle, not the interface — and dim again at extreme range.
 *
 * They are also hit targets: the banner is the thing a player aims at to pick a unit
 * out of a melee, so `unitAt` publishes each plaque's screen box and
 * `SelectionController` tests it before it tests the ground footprint. That test is done
 * here in screen space rather than with `pointer-events: auto`, because the engine's
 * `Input` listens on the canvas: a DOM element that swallows the pointer also swallows
 * the wheel and the right button, which would kill zoom and camera rotation over every
 * one of the three dozen plaques on screen.
 */

import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { SoldierState, type UnitGroupState } from '../sim/types';
import { el, html, icon, setClass, setFill } from './dom';
import { standardGlyph, UNIT_CLASS_ICON } from './icons';
import type { HudModel, UnitView } from './model';
import { ScreenProjector, terrainOccludes, type ScreenPoint } from './picking';
import { FACTION_UI, MORALE_UI, type MoraleState } from './theme';

/**
 * One bay of the Aurelian Wall: its ground-plan line and the absolute height of its top.
 *
 * `CitySystem.getWallSegments` reports `height` as the masonry's rise above its own
 * footing — 1.1 m for a bare footing, 6.5 m for finished curtain — so the ground under the
 * bay has to be added before it can be compared with a sight line's world y.
 */
export interface WallSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  topY: number;
}

interface BannerEls {
  view: UnitView;
  root: HTMLElement;
  strFill: HTMLElement;
  morStrip: HTMLElement;
  name: HTMLElement;
  transform: string;
  off: boolean;
  /** Screen box in CSS pixels, meaningful only while `hit` is true. */
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
  hit: boolean;
  /** Camera distance, so overlapping plaques resolve to the nearest unit. */
  dist: number;
  last: { str: number; morale: MoraleState; selected: boolean; hovered: boolean; routing: boolean };
}

/** Scratch for one man's head and the plaque plane above it; reused, never allocated. */
const HEAD: ScreenPoint = { x: 0, y: 0, inRange: false };
const TOP: ScreenPoint = { x: 0, y: 0, inRange: false };

/**
 * Height of the plaque plane above a man's feet.
 *
 * A man is 1.75 m and the standard he carries tops out at ~3.4 m (a 3.1 m staff plus its
 * finial), so the plaque's spike is planted just clear of the tallest thing a soldier
 * carries. Averaged over the block, that puts the spike at the top of the crowd and the
 * plate itself well above it.
 */
const CLEAR_M = 3.6;
/** Standing height of a man, i.e. the top of the block's silhouette. */
const HEAD_M = 1.75;
/** Riders sit ~1.1 m higher, and so do their standards. */
const MOUNTED_LIFT_M = 1.15;
/** Pixels of slack around a plaque's box, so a 25 px target is not a pixel hunt. */
const HIT_PAD_PX = 3;
/** Below this opacity a plaque is fading out of a close-up and stops being clickable. */
const HIT_MIN_ALPHA = 0.25;
/**
 * Minimum pixels between the bottom of the plaque and the mean head in the block.
 *
 * Only bites when the projection flattens vertical offsets to nothing — a block at
 * extreme range, or a near-overhead camera — where 3.6 m of world clearance is worth less
 * than three pixels and the plaque would otherwise land on the men.
 */
const HEAD_GAP_PX = 3;


/**
 * Lower median of `a[0..n)`, in place, by quickselect.
 *
 * Quickselect rather than a sort because this runs per unit per frame: linear on average
 * against `n log n`, and at 35 units of ~320 men that is the difference between a few
 * thousand comparisons and a few tens of thousands. The array is scratch and the reordering
 * is deliberate — nothing reads it afterwards.
 *
 * The *lower* median is taken rather than averaging the two central order statistics, so the
 * result is always a value some real soldier actually has. Averaging them would reintroduce,
 * in miniature, exactly the interpolation this function exists to avoid.
 */
function lowerMedian(a: Float32Array, n: number): number {
  if (n === 1) return a[0];
  let lo = 0;
  let hi = n - 1;
  const k = (n - 1) >> 1;
  while (lo < hi) {
    // Median-of-three pivot: an already-sorted or reverse-sorted run is the common case here,
    // because members are visited in slot order and a formed-up unit is nearly monotonic on
    // screen. A naive first-element pivot degrades to O(n^2) on exactly that input.
    const mid = (lo + hi) >> 1;
    if (a[mid] < a[lo]) { const t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
    if (a[hi] < a[lo]) { const t = a[hi]; a[hi] = a[lo]; a[lo] = t; }
    if (a[hi] < a[mid]) { const t = a[hi]; a[hi] = a[mid]; a[mid] = t; }
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i]; a[i] = a[j]; a[j] = t;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[lo];
}

export class Banners {
  private layer!: HTMLElement;
  private items: BannerEls[] = [];
  private generation = -1;
  /** Unscaled layout box of one plaque, measured out of the frame loop. */
  private baseW = 25;
  private baseH = 43;
  private needMeasure = true;
  enabled = true;
  /** Dimmed while the opening title card owns the screen. */
  hushed = false;
  /**
   * Pixels at the bottom of the viewport occupied by the card bar. Banners projecting
   * into it are dropped rather than left half-buried under the panel.
   */
  bottomReserve = 0;
  /**
   * The city's wall bays, when `CitySystem` is registered.
   *
   * The terrain occlusion test works off the heightfield, and the Aurelian Wall is
   * geometry rather than terrain, so without this a cohort standing inside the city shows
   * its plaque straight through eight metres of masonry.
   */
  wallSegments: readonly WallSegment[] = [];

  /** View-projection formed once per frame and applied to every man. */
  private readonly proj = new ScreenProjector();
  /**
   * Output of `centre`: the plaque's screen anchor in CSS pixels, plus a world point that
   * stands in for the block where the fade needs a range and the occlusion test a sight
   * line.
   */
  private anchorX = 0;
  private anchorY = 0;
  private anchorWx = 0;
  private anchorWy = 0;
  private anchorWz = 0;

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement): void {
    this.layer = el('div', 'bnr-layer', parent);
  }

  /** Re-read the plaque box. Called on resize and on a UI-scale change, never per frame. */
  remeasure(): void {
    this.needMeasure = true;
  }

  private build(): void {
    this.layer.textContent = '';
    this.items.length = 0;
    for (const v of this.model.views) {
      const fui = FACTION_UI[v.faction];
      const root = el('div', 'bnr', this.layer);
      root.dataset.f = fui.key;
      root.dataset.unit = String(v.id);
      html(
        root,
        `<span class="bnr-plate">
           <span class="bnr-std">${icon(standardGlyph(v.faction), 'bnr-std-ic')}</span>
           <span class="bnr-ic">${icon(UNIT_CLASS_ICON[v.def.unitClass], 'bnr-cls')}</span>
         </span>
         <span class="bnr-bar"><i></i></span>
         <span class="bnr-mor"></span>
         <span class="bnr-pole"></span>
         <span class="bnr-name">${v.title}</span>`
      );
      this.items.push({
        view: v,
        root,
        strFill: root.querySelector('.bnr-bar > i') as HTMLElement,
        morStrip: root.querySelector('.bnr-mor') as HTMLElement,
        name: root.querySelector('.bnr-name') as HTMLElement,
        transform: '',
        off: false,
        hx0: 0, hy0: 0, hx1: 0, hy1: 0,
        hit: false,
        dist: 0,
        last: { str: -1, morale: 'steady', selected: false, hovered: false, routing: false },
      });
    }
    this.needMeasure = true;
  }

  /**
   * One layout read, on build or after a resize. The hit box has to be derived from the
   * real box because `--ui-scale` is a player setting, and reading it per frame would
   * put a forced reflow in the render path.
   */
  private measure(): void {
    this.needMeasure = false;
    const first = this.items[0];
    if (!first) return;
    const w = first.root.offsetWidth;
    const h = first.root.offsetHeight;
    if (w > 0) this.baseW = w;
    if (h > 0) this.baseH = h;
  }

  /** 10 Hz content refresh. */
  sync(): void {
    if (this.generation !== this.model.generation) {
      this.generation = this.model.generation;
      this.build();
    }
    if (this.needMeasure) this.measure();
    for (const b of this.items) {
      const v = b.view;
      const L = b.last;
      if (Math.abs(v.strengthFrac - L.str) > 0.004) {
        L.str = v.strengthFrac;
        setFill(b.strFill, v.strengthFrac);
      }
      if (v.morale !== L.morale) {
        L.morale = v.morale;
        b.morStrip.style.background = MORALE_UI[v.morale].colour;
        setClass(b.root, 'wobble', v.morale === 'wavering' || v.morale === 'breaking');
      }
      const sel = this.model.isSelected(v.id);
      if (sel !== L.selected) {
        L.selected = sel;
        setClass(b.root, 'sel', sel);
      }
      if (v.routing !== L.routing) {
        L.routing = v.routing;
        setClass(b.root, 'routing', v.routing);
      }
    }
  }

  /**
   * Unit whose plaque covers this point, or -1. Nearest to the camera wins where two
   * overlap, which is the one drawn on top of the pile.
   */
  unitAt(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const b of this.items) {
      if (!b.hit) continue;
      if (x < b.hx0 || x > b.hx1 || y < b.hy0 || y > b.hy1) continue;
      if (b.dist < bestD) {
        bestD = b.dist;
        best = b.view.id;
      }
    }
    return best;
  }

  /**
   * Screen-space centre of a unit's living men, written into `this.anchor*`.
   *
   * Returns the number of men projected, or 0 when none of them are in front of the eye.
   *
   * Two decisions here, both of which cost something and both of which were arrived at by
   * measurement rather than taste:
   *
   * **Every living man, not a sample.** A subsample's mean is only unbiased if its phase
   * is random, and `members` runs in slot order: a 24-man golden-ratio sample of a
   * twenty-file cohort came out 1.3 files off centre, which is 46 px on a block 670 px
   * wide — worse than the error it was there to remove. Randomising the phase per frame
   * trades bias for shimmer, and per unit leaves the bias in place. Enumerating is exact,
   * needs no assumption about how the sim lays out slots, and gives an anchor that does not
   * step when a man dies. It costs one pass over the army per frame, in the same order as
   * the pass the unit renderer already makes.
   *
   * **Read from the pool at the frame's own alpha**, i.e. the positions
   * `UnitRenderSystem` is drawing the men at — not the HUD's 10 Hz digest. A marching
   * cohort barely deforms in 100 ms, but a routing unit's men scatter while its formation
   * anchor keeps walking, and a wheeling or charging one changes shape inside a single
   * tick. Sampling per frame removes that whole class of staleness rather than arguing
   * about its size.
   */
  /** Scratch for the per-frame medians; grown to the largest unit seen, never shrunk. */
  private mHeadX = new Float32Array(0);
  private mHeadY = new Float32Array(0);
  private mTopY = new Float32Array(0);
  private mWx = new Float32Array(0);
  private mWz = new Float32Array(0);

  private centre(battle: BattleSystem, u: UnitGroupState, alpha: number, lift: number): number {
    const pool = battle.pool;
    const members = u.members;
    const px = pool.px;
    const py = pool.py;
    const pz = pool.pz;
    const cx = pool.x;
    const cy = pool.y;
    const cz = pool.z;
    const state = pool.state;
    const headM = HEAD_M + lift;

    const cap = members.length;
    if (this.mHeadX.length < cap) {
      this.mHeadX = new Float32Array(cap);
      this.mHeadY = new Float32Array(cap);
      this.mTopY = new Float32Array(cap);
      this.mWx = new Float32Array(cap);
      this.mWz = new Float32Array(cap);
    }
    let n = 0;
    let footTop = -Infinity;
    for (let k = 0; k < members.length; k++) {
      const i = members[k];
      const st = state[i];
      if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
      const x = px[i] + (cx[i] - px[i]) * alpha;
      const y = py[i] + (cy[i] - py[i]) * alpha;
      const z = pz[i] + (cz[i] - pz[i]) * alpha;
      // The top of his head, which is what the eye reads as the block, and the plaque
      // plane above it, where the spike is planted. One transform serves both.
      if (!this.proj.projectPair(x, y + headM, z, CLEAR_M - HEAD_M, HEAD, TOP)) continue;
      if (!HEAD.inRange) continue;
      this.mHeadX[n] = HEAD.x;
      this.mHeadY[n] = HEAD.y;
      this.mTopY[n] = TOP.y;
      this.mWx[n] = x;
      this.mWz[n] = z;
      if (y > footTop) footTop = y;
      n++;
    }
    if (n === 0) return 0;

    /*
     * Median, not mean, in every axis.
     *
     * The mean is the centre of *mass*, and a unit is not always one mass. Send a cohort
     * through a gate and a dozen men snag on the jamb while the rest march on: the mean sits
     * in the empty ground between the two groups, so the plaque hovers over nobody and points
     * at neither part of the unit. The player's words for it were that the flag "is like
     * pulled into two locations". A lone straggler 200 m behind drags a 320-man block's
     * anchor by 0.6 m of world space, and a tenth of the unit drags it a fifth of the way.
     *
     * The median ignores them. It moves only when *half* the unit moves, which is exactly
     * the condition under which the block's visual centre has genuinely shifted, and it
     * always lands on a value some real soldier has rather than on an interpolation between
     * two crowds. Componentwise — the median x and the median y are taken independently, so
     * the anchor is not necessarily any one man's position, which is the standard and cheap
     * approximation to a geometric median and is entirely adequate at this scale.
     *
     * Cost is linear by quickselect rather than the `n log n` a sort would need, so this is
     * the same order as the mean it replaces. Measured at 35 units of ~320 men it is a few
     * tens of thousands of comparisons a frame against a 1.5 ms HUD budget currently spending
     * 0.23 ms.
     */
    this.anchorX = lowerMedian(this.mHeadX, n);
    // Vertical: the plaque plane, floored so it always clears the head it sits above. Both
    // terms are medians so the floor still compares like with like.
    this.anchorY = Math.min(lowerMedian(this.mTopY, n), lowerMedian(this.mHeadY, n) - HEAD_GAP_PX);
    this.anchorWx = lowerMedian(this.mWx, n);
    this.anchorWz = lowerMedian(this.mWz, n);
    this.anchorWy = footTop + CLEAR_M + lift;
    return n;
  }

  /**
   * True when the Aurelian Wall stands between the eye and the plaque.
   *
   * A ground-plan segment intersection per bay, and then one height comparison at the
   * crossing — so a camera raised high enough to look over the parapet still sees the
   * plaques of the units behind it, which a plan-only test would wrongly hide. Compared
   * against the wall-walk rather than the merlons on purpose: erring towards showing a
   * plaque is much cheaper than a battlefield whose markers blink out near the city.
   */
  private wallOccludes(
    ex: number, ey: number, ez: number,
    tx: number, ty: number, tz: number
  ): boolean {
    const segs = this.wallSegments;
    const rx = tx - ex;
    const rz = tz - ez;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const bx = s.x2 - s.x1;
      const bz = s.z2 - s.z1;
      const den = rx * bz - rz * bx;
      if (den === 0) continue;
      const qx = s.x1 - ex;
      const qz = s.z1 - ez;
      const t = (qx * bz - qz * bx) / den;
      if (t <= 0 || t >= 1) continue;
      const u = (qx * rz - qz * rx) / den;
      if (u < 0 || u > 1) continue;
      if (ey + (ty - ey) * t < s.topY) return true;
    }
    return false;
  }

  /**
   * Per-frame projection. `showNames` comes from the Alt key.
   *
   * Called from `preRender`, after `Engine.frame` has finalised the camera and called
   * `updateMatrixWorld` — projecting in `update` leaves every plaque one frame stale,
   * which reads as the whole HUD sliding behind the world while the camera pans.
   */
  place(
    ctx: EngineContext,
    battle: BattleSystem,
    heightAt: (x: number, z: number) => number,
    showNames: boolean
  ): void {
    if (!this.enabled) {
      if (this.layer.style.display !== 'none') this.layer.style.display = 'none';
      for (const b of this.items) b.hit = false;
      return;
    }
    if (this.layer.style.display === 'none') this.layer.style.display = '';
    setClass(this.layer, 'names', showNames);
    setClass(this.layer, 'hushed', this.hushed);

    // CSS pixels, not drawing-buffer pixels: `.bnr-layer` is laid out in CSS pixels and
    // the renderer's backing store is up to 2x that under `quality.maxPixelRatio`.
    const w = ctx.viewW;
    const h = ctx.viewH;
    const hovered = this.model.hoveredId;
    // Terrain occlusion is only trustworthy from a raised camera. Down among the men the
    // sight line grazes the ground and every hillock reads as a blocker, so the test is
    // skipped there — the distance fade already keeps close-quarters views clear.
    const testOcclusion = ctx.rig.zoom > 0.45;
    const cam = ctx.camera;
    const alpha = ctx.time.alpha;
    this.proj.begin(cam, w, h);
    for (const b of this.items) {
      const v = b.view;
      const u = v.unit;
      b.hit = false;
      // Read live rather than from the 10 Hz digest: a wiped-out unit must lose its plaque
      // on the frame it dies, not up to 100 ms later.
      let hide = u.destroyed || u.alive === 0;

      let ax = 0;
      let ay = 0;
      let az = 0;
      let px = 0;
      let py = 0;
      let d = 0;
      if (!hide) {
        const mounted = v.def.unitClass === 'heavy-cavalry' || v.def.unitClass === 'light-cavalry';
        if (this.centre(battle, u, alpha, mounted ? MOUNTED_LIFT_M : 0) === 0) hide = true;
        else {
          px = this.anchorX;
          py = this.anchorY;
          ax = this.anchorWx;
          az = this.anchorWz;
          // The fade and the sight line want a world point, and the highest of the sampled
          // men's feet is the right one: the map rises 25-40 m across the battlefield, so a
          // cohort drawn up across a slope has its uphill file metres above its own centre,
          // and a sight line aimed at the mean would clip its own hillside.
          ay = Math.max(this.anchorWy, heightAt(ax, az) + CLEAR_M);
          d = Math.hypot(cam.position.x - ax, cam.position.y - ay, cam.position.z - az);
          hide =
            px < -80 || px > w + 80 ||
            py < -60 || py > h - this.bottomReserve;
        }
      }

      if (!hide) {
        // Nothing inside 28 m: down at eye level the player wants men, not markers, and
        // a plaque sitting on the contact line is the worst thing the HUD can do.
        const near = Math.min(1, Math.max(0, (d - 28) / 42));
        const far = 1 - Math.min(0.62, Math.max(0, (d - 900) / 900));
        const opacity = near * far;
        if (opacity < 0.02) hide = true;
        else {
          // Slack grows fast with range. At a grazing angle the eight-sample line
          // clips every hillock between here and there, and a battlefield where the
          // banners vanish whenever the camera drops is worse than one where a banner
          // occasionally shows through a rise. The wall test carries no such slack
          // because it is exact geometry rather than a heightfield guess, so it runs at
          // every zoom.
          if (
            (testOcclusion && terrainOccludes(cam, ax, ay, az, heightAt, 4 + d * 0.06)) ||
            this.wallOccludes(cam.position.x, cam.position.y, cam.position.z, ax, ay, az)
          ) {
            hide = true;
          } else {
            // Near-constant screen size, easing down at long range so a distant wing
            // reads as distant, and growing in with the fade so the last thing to leave
            // a close-up is a small mark rather than a full-size icon.
            const s = Math.max(0.62, Math.min(1.12, 1.12 - d / 2400)) * (0.6 + 0.4 * near);
            const t = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
            if (t !== b.transform) {
              b.transform = t;
              b.root.style.transform = t;
            }
            const a = opacity.toFixed(2);
            if (b.root.style.opacity !== a) b.root.style.opacity = a;

            // `transform-origin` is the box's bottom centre and the two translates put
            // that point on the anchor, so the scaled box is symmetric about it. No
            // layout read: the unscaled box was measured once.
            if (opacity >= HIT_MIN_ALPHA) {
              const bw = this.baseW * s * 0.5 + HIT_PAD_PX;
              const bh = this.baseH * s + HIT_PAD_PX;
              b.hx0 = px - bw;
              b.hx1 = px + bw;
              b.hy0 = py - bh;
              b.hy1 = py + HIT_PAD_PX;
              b.dist = d;
              b.hit = true;
            }
          }
        }
      }

      if (hide !== b.off) {
        b.off = hide;
        setClass(b.root, 'off', hide);
      }
      // Hover is applied here rather than in the 10 Hz tick: a highlight that answers
      // up to 100 ms after the cursor arrives feels broken, and a class toggle costs
      // nothing when it only fires on a change.
      const hov = !hide && hovered === v.id;
      if (hov !== b.last.hovered) {
        b.last.hovered = hov;
        setClass(b.root, 'hov', hov);
      }
    }
  }

  dispose(): void {
    this.layer.remove();
  }
}
