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
         <span class="mm-n">N</span>
         <button class="mm-zoom" type="button" title="Map range (M)">FIELD</button>
         <span class="mm-rivet tl"></span><span class="mm-rivet tr"></span>
         <span class="mm-rivet bl"></span><span class="mm-rivet br"></span>
       </div>`
    );
    this.canvas = this.root.querySelector('canvas') as HTMLCanvasElement;
    this.zoomLabel = this.root.querySelector('.mm-zoom') as HTMLElement;
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
        const r0 = 42 + t * 104;
        const g0 = 40 + t * 90;
        const b0 = 30 + t * 58;
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
    if (this.walls.length) {
      g.strokeStyle = 'rgba(232, 216, 178, 0.85)';
      g.lineWidth = 1.6;
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
        // Lightened toward white by strength, but only a little: mixing better than half
        // way turned Roman red into salmon and cost the two sides their only difference at
        // this size. A fresh unit is bright, a spent one is dark, both are still faction red.
        const bright = 0.12 + v.strengthFrac * 0.26;
        const col = v.routing ? mixHex(fui.raw, 0x000000, 0.45) : mixHex(fui.raw, 0xffffff, bright);

        const px = this.mx(v.cx);
        const py = this.my(v.cz);
        // Blips are scaled by surviving strength as well as by footprint. Thirty-six
        // formations packed into a 400 m line otherwise merge into two solid bars: a
        // spent cohort that draws two thirds the size of a fresh one both tells the truth
        // and leaves the gap that makes the cluster countable.
        const scale = 0.6 + 0.4 * v.strengthFrac;
        const w = Math.max(2.4, (v.frontage / mPerPx) * scale);
        const d = Math.max(1.8, (v.depth / mPerPx) * scale);
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
        // even when the blip is barely two pixels across.
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(6, 5, 3, 0.95)';
        g.strokeRect(-w * 0.5, -d * 0.5, w, d);
        if (sel) {
          g.strokeStyle = '#f2dd9e';
          g.lineWidth = 1.5;
          g.strokeRect(-w * 0.5 - 1.4, -d * 0.5 - 1.4, w + 2.8, d + 2.8);
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

    // ---- Compass needle ----
    const cx = s - 15;
    const cy = 15;
    g.save();
    g.translate(cx, cy);
    g.fillStyle = 'rgba(10, 8, 5, 0.62)';
    g.beginPath();
    g.arc(0, 0, 10, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(217, 178, 95, 0.5)';
    g.lineWidth = 1;
    g.stroke();
    g.rotate(-ctx.rig.yaw);
    g.fillStyle = '#f2dd9e';
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(3.4, 5.2);
    g.lineTo(0, 2.6);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(242, 221, 158, 0.45)';
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(-3.4, 5.2);
    g.lineTo(0, 2.6);
    g.closePath();
    g.fill();
    g.restore();
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
    this.root.remove();
  }

  /** Exposed so the HUD can note whether the city ever turned up. */
  get wallCount(): number {
    return this.walls.length;
  }

  static readonly playerFaction: Faction = PLAYER_FACTION;
}
