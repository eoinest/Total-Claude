/**
 * Tiny DOM helpers used by the HUD.
 *
 * The rule everywhere below the hot path: build structure once, then only ever
 * mutate leaf text / transforms / class lists. Nothing in `update()` may call
 * `innerHTML`, read a layout property, or create an element.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: Element
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

/** Structure-building only: never call this from a per-frame path. */
export function html<T extends Element>(parent: T, markup: string): T {
  parent.innerHTML = markup;
  return parent;
}

/**
 * A bare inline SVG. `body` is raw SVG markup; the wrapper carries the class so
 * CSS `currentColor` fills work.
 */
export function icon(paths: string, cls = '', viewBox = '0 0 24 24'): string {
  return `<svg class="ic ${cls}" viewBox="${viewBox}" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** Write text only when it actually changed — avoids needless style/layout invalidation. */
export function setText(n: HTMLElement, s: string): void {
  if (n.textContent !== s) n.textContent = s;
}

/** Set a CSS custom property only when the rounded value changed. */
export function setVar(n: HTMLElement, name: string, v: string): void {
  if (n.style.getPropertyValue(name) !== v) n.style.setProperty(name, v);
}

export function setClass(n: Element, cls: string, on: boolean): void {
  if (n.classList.contains(cls) !== on) n.classList.toggle(cls, on);
}

/**
 * Horizontal bar fill driven by `scaleX`, so the browser composites it instead of
 * re-laying-out. CSS supplies the transition, which is why values tween for free.
 */
export function setFill(n: HTMLElement, frac: number): void {
  const q = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 1000;
  const s = `scaleX(${q})`;
  if (n.style.transform !== s) n.style.transform = s;
}

/** Retrigger a CSS animation without forcing a reflow read. */
export function pulse(n: Element): void {
  const a = n.classList.contains('pa');
  n.classList.toggle('pa', !a);
  n.classList.toggle('pb', a);
}

/** Backing-store size for a canvas so it is crisp on HiDPI. Returns the DPR used. */
export function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number, cap = 2.5): number {
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return dpr;
}

export const fmtClock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m < 10 ? '0' : ''}${m}:${(s % 60) < 10 ? '0' : ''}${s % 60}`;
};

/** 1234 -> "1 234", so four-digit army counts stay readable at a glance. */
export const fmtCount = (n: number): string => {
  const v = Math.round(n);
  return v < 1000 ? String(v) : `${Math.floor(v / 1000)} ${String(v % 1000).padStart(3, '0')}`;
};
