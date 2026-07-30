/**
 * Cursor and modifier tracking for the HUD.
 *
 * `core/Input` only sees events that reach the canvas, so the moment the cursor moves
 * over a HUD panel its position goes stale — which is exactly when the HUD needs to
 * know where the cursor is. It also drops every `keydown` carrying ctrl or meta, so
 * `input.ctrl` never becomes true and ctrl-click could not be read from it.
 *
 * This listens at the window in the capture phase, changes nothing and preventDefaults
 * nothing; it only records state. Modifier flags come off the events themselves, which
 * is the one source that is always correct.
 */

export class PointerTracker {
  /** CSS pixels relative to the canvas. */
  x = 0;
  y = 0;
  /** True while the cursor is over an interactive HUD element. */
  overUi = false;
  /** The `.interactive` element under the cursor, if any. */
  uiElement: HTMLElement | null = null;
  ctrl = false;
  shift = false;
  alt = false;
  /** Modifier snapshot taken on the most recent pointerdown. */
  downCtrl = false;
  downShift = false;
  downAlt = false;

  private rect = { left: 0, top: 0 };
  private el: HTMLElement;
  private disposers: Array<() => void> = [];

  constructor(canvas: HTMLElement) {
    this.el = canvas;
    this.measure();

    const mods = (e: MouseEvent | KeyboardEvent): void => {
      this.ctrl = e.ctrlKey || e.metaKey;
      this.shift = e.shiftKey;
      this.alt = e.altKey;
    };

    const onMove = (e: PointerEvent): void => {
      mods(e);
      this.x = e.clientX - this.rect.left;
      this.y = e.clientY - this.rect.top;
      const t = e.target as Element | null;
      const ui = t && t.closest ? (t.closest('.interactive') as HTMLElement | null) : null;
      this.uiElement = ui;
      this.overUi = ui !== null;
    };

    const onDown = (e: PointerEvent): void => {
      onMove(e);
      this.downCtrl = this.ctrl;
      this.downShift = this.shift;
      this.downAlt = this.alt;
    };

    const onKey = (e: KeyboardEvent): void => mods(e);
    const onBlur = (): void => {
      this.ctrl = this.shift = this.alt = false;
    };

    this.add('pointermove', onMove as EventListener);
    this.add('pointerdown', onDown as EventListener);
    this.add('pointerup', onMove as EventListener);
    this.add('keydown', onKey as EventListener);
    this.add('keyup', onKey as EventListener);
    this.add('blur', onBlur as EventListener);
  }

  private add(type: string, fn: EventListener): void {
    window.addEventListener(type, fn, { capture: true, passive: true });
    this.disposers.push(() => window.removeEventListener(type, fn, { capture: true }));
  }

  /** Re-read the canvas offset. Called on resize only — never per frame. */
  measure(): void {
    const r = this.el.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
