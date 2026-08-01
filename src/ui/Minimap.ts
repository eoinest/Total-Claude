/**
 * Canvas minimap.
 *
 * Shaded relief is baked once from the terrain heightfield into an offscreen buffer;
 * after that a redraw is a blit plus a few dozen rectangles, so it can run at 10 Hz
 * without touching the frame budget. Click to jump the camera, drag to sweep it.
 *
 * The window is deliberately tighter than the 2800 m battlefield — the fighting all
 * happens within a few hundred metres of the walls, and a map scaled to the empty corners
 * of the terrain would render every unit as a single pixel. It is not *as* tight as it
 * used to be: with 21 cohorts the Roman line alone spans ±330 m and the cavalry wings sit
 * out at ±420 m, so the default window has to hold ±800 m or half the order of battle
 * lands on the frame. Three steps are offered — the tactical view, the default, and the
 * whole terrain — cycled from the stud in the corner or with M.
 */

import type { EngineContext } from '../core/Engine';
import * as THREE from 'three';
import { Faction } from '../sim/types';
import { el, html, setText, sizeCanvas } from './dom';
import type { HudModel } from './model';
import { FACTION_UI, mixHex, PLAYER_FACTION } from './theme';

/** Half-width of the mapped area in metres, per zoom step. */
const ZOOMS = [480, 800, 1400] as const;
const ZOOM_LABEL = ['CLOSE', 'FIELD', 'ALL'] as const;
const DEFAULT_ZOOM = 1;
/** Relief buffer resolution. The whole terrain is baked, so any zoom is a crop of it. */
const RELIEF = 384;
/** The relief bake covers this half-extent, matching `terrain.HALF_EXTENT`. */
const RELIEF_M = 1400;

interface HeightField {
  data: Float32Array;
  res: number;
  spacing: number;
  halfExtent: number;
}

interface Segment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

/** Accept whatever shape the city system ends up exposing for its wall geometry. */
function normaliseSegments(raw: unknown): Segment[] {
  const out: Segment[] = [];
  if (!Array.isArray(raw)) return out;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const s of raw) {
    if (Array.isArray(s) && s.length >= 4) {
      const a = num(s[0]), b = num(s[1]), c = num(s[2]), d = num(s[3]);
      if (a !== null && b !== null && c !== null && d !== null) out.push({ x1: a, z1: b, x2: c, z2: d });
      continue;
    }
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const pair = (ax: string, az: string, bx: string, bz: string): boolean => {
      const a = num(o[ax]), b = num(o[az]), c = num(o[bx]), d = num(o[bz]);
      if (a === null || b === null || c === null || d === null) return false;
      out.push({ x1: a, z1: b, x2: c, z2: d });
      return true;
    };
    if (pair('x1', 'z1', 'x2', 'z2')) continue;
    if (pair('ax', 'az', 'bx', 'bz')) continue;
    const from = o.from ?? o.a ?? o.start;
    const to = o.to ?? o.b ?? o.end;
    if (from && to && typeof from === 'object' && typeof to === 'object') {
      const f = from as Record<string, unknown>;
      const t = to as Record<string, unknown>;
      const a = num(f.x), b = num(f.z), c = num(t.x), d = num(t.z);
      if (a !== null && b !== null && c !== null && d !== null) out.push({ x1: a, z1: b, x2: c, z2: d });
    }
  }
  return out;
}

const RAY_DIR = new THREE.Vector3();
const RAY_TMP = new THREE.Vector3();

export class Minimap {
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private g!: CanvasRenderingContext2D;
  private relief: HTMLCanvasElement | null = null;
  /** World half-extent the relief buffer covers. */
  private reliefM = RELIEF_M;
  private walls: Segment[] = [];
  private wallsChecked = false;
  private size = 0;
  private dpr = 1;
  private dragging = false;
  private zoom = DEFAULT_ZOOM;
  private zoomLabel!: HTMLElement;
  private needle!: HTMLElement;
  private needleDeg = 999;
  private offs: Array<() => void> = [];

  constructor(private model: HudModel) {}

  /** Half-width of the mapped area in metres at the current step. */
  private get viewM(): number {
    return ZOOMS[this.zoom];
  }

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.root = el('div', 'minimap hud-panel interactive', parent);
    html(
      this.root,
      `<div class="mm-frame">
         <canvas></canvas>
         <button class="mm-compass" type="button" title="Drag to turn the view · click for north">
           <span class="mm-rose"><i>N</i></span>
           <span class="mm-needle"></span>
         </button>
         <button class="mm-zoom" type="button" title="Map range (M)">FIELD</button>
         <span class="mm-rivet tl"></span><span class="mm-rivet tr"></span>
         <span class="mm-rivet bl"></span><span class="mm-rivet br"></span>
       </div>`
    );
    this.canvas = this.root.querySelector('canvas') as HTMLCanvasElement;
    this.zoomLabel = this.root.querySelector('.mm-zoom') as HTMLElement;
    this.needle = this.root.querySelector('.mm-needle') as HTMLElement;
    this.attachCompass(this.root.querySelector('.mm-compass') as HTMLElement, ctx);
    this.zoomLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cycleZoom();
    });
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('[hud] 2D context unavailable for the minimap');
    this.g = g;

    const toWorld = (ev: PointerEvent): { x: number; z: number } => {
      const r = this.canvas.getBoundingClientRect();
      const u = (ev.clientX - r.left) / Math.max(1, r.width);
      const v = (ev.clientY - r.top) / Math.max(1, r.height);
      return { x: (u * 2 - 1) * this.viewM, z: (v * 2 - 1) * this.viewM };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      const p = toWorld(e);
      ctx.rig.jumpTo(p.x, p.z);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const p = toWorld(e);
      ctx.rig.jumpTo(p.x, p.z);
    });
    const stop = (e: PointerEvent): void => {
      this.dragging = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
  }

  /**
   * A named route to yaw beside the two field drags (left on nothing, middle anywhere): drag
   * the rose to turn, click it to face north. Rotation cannot ride the right button, which
   * issues orders. 0.014 rad per pixel puts a full revolution in 450 px of travel, faster per
   * pixel than a field drag because the rose is a stud rather than the whole viewport.
   */
  private attachCompass(el: HTMLElement, ctx: EngineContext): void {
    let turning = false;
    let lastX = 0;
    let travel = 0;
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      turning = true;
      travel = 0;
      lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
      el.classList.add('turning');
    };
    const move = (e: PointerEvent): void => {
      if (!turning) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      travel += Math.abs(dx);
      ctx.rig.rotateBy(-dx * 0.014);
    };
    const up = (e: PointerEvent): void => {
      if (!turning) return;
      turning = false;
      el.releasePointerCapture?.(e.pointerId);
      el.classList.remove('turning');
      if (travel < 4) ctx.rig.faceNorth();
    };
    const bind = (type: string, fn: (e: PointerEvent) => void): void => {
      el.addEventListener(type, fn as EventListener);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener));
    };
    bind('pointerdown', down);
    bind('pointermove', move);
    bind('pointerup', up);
    bind('pointercancel', up);
  }

  relayout(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    this.dpr = sizeCanvas(this.canvas, r.width, r.height);
    this.size = r.width;
  }

  /** Step through the map ranges. Bound to the corner stud and to M. */
  cycleZoom(): void {
    this.zoom = (this.zoom + 1) % ZOOMS.length;
    setText(this.zoomLabel, ZOOM_LABEL[this.zoom]);
  }

  /** Bake the shaded relief. Cheap enough to run on init and on nothing else. */
  buildRelief(field: HeightField): void {
    const c = document.createElement('canvas');
    c.width = RELIEF;
    c.height = RELIEF;
    const g = c.getContext('2d');
    if (!g) return;
    const img = g.createImageData(RELIEF, RELIEF);
    const px = img.data;

    const sample = (x: number, z: number): number => {
      const f = field;
      const fx = (x + f.halfExtent) / f.spacing;
      const fz = (z + f.halfExtent) / f.spacing;
      const ix = Math.max(0, Math.min(f.res - 2, Math.floor(fx)));
      const iz = Math.max(0, Math.min(f.res - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - ix));
      const tz = Math.max(0, Math.min(1, fz - iz));
      const i00 = iz * f.res + ix;
      const h00 = f.data[i00];
      const h10 = f.data[i00 + 1];
      const h01 = f.data[i00 + f.res];
      const h11 = f.data[i00 + f.res + 1];
      return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    };

    let lo = Infinity;
    let hi = -Infinity;
    const heights = new Float32Array(RELIEF * RELIEF);
    // Baked over the whole battlefield once, so changing zoom is a crop of this buffer
    // rather than a re-bake. `min(RELIEF_M, halfExtent)` keeps it honest if the terrain
    // ever ships a smaller field than the architecture's 1400 m.
    const half = Math.min(RELIEF_M, field.halfExtent);
    const step = (half * 2) / RELIEF;
    for (let j = 0; j < RELIEF; j++) {
      const wz = -half + (j + 0.5) * step;
      for (let i = 0; i < RELIEF; i++) {
        const wx = -half + (i + 0.5) * step;
        const h = sample(wx, wz);
        heights[j * RELIEF + i] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    const span = Math.max(0.5, hi - lo);

    for (let j = 0; j < RELIEF; j++) {
      for (let i = 0; i < RELIEF; i++) {
        const k = j * RELIEF + i;
        const h = heights[k];
        const t = (h - lo) / span;
        // Hypsometric tint: the map is a bronze plate with the ground etched into it, not
        // a satellite photograph, so colour stays subordinate to the blips — but the range
        // has to be wide enough that the plate reads as terrain rather than as mud.
        // Measured: the plate used to sit at 0.069 relative luminance against blips that
        // peaked near 0.14, so the ground was competing with the army for the eye. Pulling
        // the top of the ramp down and the blips up puts the order of battle on top, which
        // is the only thing this panel exists to show.
        const r0 = 34 + t * 84;
        const g0 = 32 + t * 73;
        const b0 = 24 + t * 47;
        // Lambert from the north-west, the same quarter the scene sun comes from.
        const hl = heights[k - 1 >= j * RELIEF ? k - 1 : k];
        const hu = heights[k - RELIEF >= 0 ? k - RELIEF : k];
        const dx = (h - hl) / step;
        const dz = (h - hu) / step;
        const shade = Math.max(0.34, Math.min(1.8, 1 + (dx * 0.5 + dz * 0.5) * 6.5));
        const o = k * 4;
        px[o] = Math.min(255, r0 * shade);
        px[o + 1] = Math.min(255, g0 * shade);
        px[o + 2] = Math.min(255, b0 * shade);
        px[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.relief = c;
    this.reliefM = half;
  }

  private tryWalls(ctx: EngineContext): void {
    if (this.wallsChecked) return;
    this.wallsChecked = true;
    const city = ctx.tryGet('city') as { getWallSegments?: () => unknown } | undefined;
    if (!city || typeof city.getWallSegments !== 'function') return;
    try {
      this.walls = normaliseSegments(city.getWallSegments());
    } catch {
      this.walls = [];
    }
  }

  /** World metres to minimap canvas pixels (CSS units). */
  private mx(x: number): number {
    const v = this.viewM;
    return ((x + v) / (v * 2)) * this.size;
  }
  private my(z: number): number {
    const v = this.viewM;
    return ((z + v) / (v * 2)) * this.size;
  }

  draw(ctx: EngineContext): void {
    if (this.size < 4) this.relayout();
    if (this.size < 4) return;
    this.tryWalls(ctx);

    const g = this.g;
    const s = this.size;
    const view = this.viewM;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, s, s);

    if (this.relief) {
      // Crop the baked relief to the current window.
      const px = (RELIEF / (this.reliefM * 2)) * view * 2;
      const off = (RELIEF - px) * 0.5;
      g.drawImage(this.relief, off, off, px, px, 0, 0, s, s);
    } else {
      g.fillStyle = '#4c4b3a';
      g.fillRect(0, 0, s, s);
    }

    // ---- City walls ----
    // Deliberately quiet. At 0.85 alpha the Aurelian curtain was the brightest line on the
    // plate — brighter than any unit — and the eye went to the architecture instead of to
    // the army. It is a landmark, not a combatant.
    if (this.walls.length) {
      g.strokeStyle = 'rgba(226, 208, 168, 0.42)';
      g.lineWidth = 1.3;
      g.beginPath();
      for (const w of this.walls) {
        g.moveTo(this.mx(w.x1), this.my(w.z1));
        g.lineTo(this.mx(w.x2), this.my(w.z2));
      }
      g.stroke();
    }

    // ---- Camera footprint ----
    this.drawFrustum(ctx, g);

    // ---- Unit blips ----
    // Enemy first so the player's own units read on top of a contested spot.
    const mPerPx = (view * 2) / s;
    for (const pass of [1, 0]) {
      for (const v of this.model.views) {
        if (v.destroyed) continue;
        const own = v.faction === PLAYER_FACTION;
        if ((own ? 0 : 1) !== pass) continue;
        const fui = FACTION_UI[v.faction];
        // Brightened by surviving strength toward the faction's own lit tone rather than
        // toward white: white took Roman oxblood to salmon and cost the two sides the only
        // difference they have at three pixels. A fresh unit is bright, a spent one is dark,
        // both stay unmistakably red or blue.
        const bright = 0.2 + v.strengthFrac * 0.75;
        const col = v.routing ? mixHex(fui.raw, 0x000000, 0.45) : mixHex(fui.raw, fui.litRaw, bright);

        const px = this.mx(v.cx);
        const py = this.my(v.cz);
        // Blips are scaled by surviving strength as well as by footprint. Thirty-six
        // formations packed into a 400 m line otherwise merge into two solid bars: a
        // spent cohort that draws two thirds the size of a fresh one both tells the truth
        // and leaves the gap that makes the cluster countable.
        const scale = 0.6 + 0.4 * v.strengthFrac;
        const w = Math.max(3.2, (v.frontage / mPerPx) * scale);
        const d = Math.max(2.4, (v.depth / mPerPx) * scale);
        const sel = this.model.isSelected(v.id);

        g.save();
        g.translate(px, py);
        // -facing keeps the blip's long edge across the direction the unit looks.
        g.rotate(-v.unit.facing);
        g.fillStyle = col;
        g.globalAlpha = v.routing ? 0.6 : 1;
        g.fillRect(-w * 0.5, -d * 0.5, w, d);
        g.globalAlpha = 1;
        // The dark outline is what actually separates two touching blips, so it is drawn
        // even when the blip is barely three pixels across — but *outside* the fill, not
        // straddling its edge. A centred 1 px stroke on a 3 px blip eats two thirds of the
        // faction colour, which is exactly how a line of cohorts turned into a grey smear.
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(6, 5, 3, 0.95)';
        g.strokeRect(-w * 0.5 - 0.5, -d * 0.5 - 0.5, w + 1, d + 1);
        if (sel) {
          g.strokeStyle = '#f2dd9e';
          g.lineWidth = 1.5;
          g.strokeRect(-w * 0.5 - 2, -d * 0.5 - 2, w + 4, d + 4);
        }
        // A tick on the leading edge shows which way it faces. Only worth drawing when
        // the blip is big enough for the tick to belong to it rather than to its neighbour.
        if (w > 4) {
          g.strokeStyle = 'rgba(255, 246, 224, 0.75)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(0, -d * 0.5);
          g.lineTo(0, -d * 0.5 - 2.2);
          g.stroke();
        }
        g.restore();
      }
    }

    // ---- Camera focus ----
    // The frustum quad shrinks to nothing when the camera is down among the men, so the
    // focus always gets its own mark.
    const fx = this.mx(ctx.rig.focus.x);
    const fz = this.my(ctx.rig.focus.z);
    g.strokeStyle = 'rgba(242, 221, 158, 0.95)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(fx - 4, fz);
    g.lineTo(fx - 1.4, fz);
    g.moveTo(fx + 1.4, fz);
    g.lineTo(fx + 4, fz);
    g.moveTo(fx, fz - 4);
    g.lineTo(fx, fz - 1.4);
    g.moveTo(fx, fz + 1.4);
    g.lineTo(fx, fz + 4);
    g.stroke();

    // The needle is a DOM element on the rose, because that control is also the grab
    // handle for turning. The plate is drawn north-up, and the view looks along
    // +(sin yaw, cos yaw), so an arrow drawn pointing up needs 180 - yaw of clockwise turn
    // to point where the camera is looking.
    const deg = Math.round(180 - (ctx.rig.yaw * 180) / Math.PI);
    if (deg !== this.needleDeg) {
      this.needleDeg = deg;
      this.needle.style.transform = `rotate(${deg}deg)`;
    }
  }

  private drawFrustum(ctx: EngineContext, g: CanvasRenderingContext2D): void {
    const cam = ctx.camera;
    const plane = ctx.rig.focus.y;
    const pts: Array<[number, number]> = [];
    const ndc: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [nx, ny] of ndc) {
      RAY_TMP.set(nx, ny, 0.5).unproject(cam);
      RAY_DIR.copy(RAY_TMP).sub(cam.position).normalize();
      // Rays above the horizon get clamped to the far edge of the map so the outline
      // stays a closed quad instead of shooting to infinity.
      let t = RAY_DIR.y < -0.001 ? (cam.position.y - plane) / -RAY_DIR.y : 4000;
      t = Math.min(t, 4000);
      pts.push([cam.position.x + RAY_DIR.x * t, cam.position.z + RAY_DIR.z * t]);
    }
    g.beginPath();
    g.moveTo(this.mx(pts[0][0]), this.my(pts[0][1]));
    for (let i = 1; i < 4; i++) g.lineTo(this.mx(pts[i][0]), this.my(pts[i][1]));
    g.closePath();
    g.fillStyle = 'rgba(242, 221, 158, 0.10)';
    g.fill();
    g.strokeStyle = 'rgba(242, 221, 158, 0.7)';
    g.lineWidth = 1.2;
    g.stroke();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.root.remove();
  }

  /** Exposed so the HUD can note whether the city ever turned up. */
  get wallCount(): number {
    return this.walls.length;
  }

  static readonly playerFaction: Faction = PLAYER_FACTION;
}
