/**
 * Cursor tracking for the HUD.
 *
 * `core/Input` only sees events that reach the canvas, so the moment the cursor moves over
 * a HUD panel its position goes stale — which is exactly when the HUD needs to know where
 * the cursor is, and whether what is under it is a panel or the field.
 *
 * Live modifier state is *not* tracked here: `Input` records `ControlLeft`/`ControlRight`
 * now, so `input.ctrl`, `.shift` and `.alt` are all trustworthy. What is kept is the
 * modifier snapshot taken at pointerdown, because the meaning of a click is fixed when the
 * button goes down — releasing shift mid-drag must not turn an add-to-selection into a
 * replace — and a mouse event is the only source that reports it for certain.
 *
 * This listens at the window in the capture phase, changes nothing and preventDefaults
 * nothing; it only records state.
 */

export class PointerTracker {
  /** CSS pixels relative to the canvas. */
  x = 0;
  y = 0;
  /** True while the cursor is over an interactive HUD element. */
  overUi = false;
  /** The `.interactive` element under the cursor, if any. */
  uiElement: HTMLElement | null = null;
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

    const onMove = (e: PointerEvent): void => {
      this.x = e.clientX - this.rect.left;
      this.y = e.clientY - this.rect.top;
      const t = e.target as Element | null;
      const ui = t && t.closest ? (t.closest('.interactive') as HTMLElement | null) : null;
      this.uiElement = ui;
      this.overUi = ui !== null;
    };

    const onDown = (e: PointerEvent): void => {
      onMove(e);
      this.downCtrl = e.ctrlKey || e.metaKey;
      this.downShift = e.shiftKey;
      this.downAlt = e.altKey;
    };

    this.add('pointermove', onMove as EventListener);
    this.add('pointerdown', onDown as EventListener);
    this.add('pointerup', onMove as EventListener);
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
