/**
 * Raw input capture. Normalises keyboard/mouse/wheel/touch into a per-frame
 * snapshot that gameplay code can poll without worrying about event timing.
 *
 * Deliberately dumb: it reports state, it does not decide what any input means.
 * Camera and order-issuing logic interpret it.
 */

export interface PointerState {
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
  /** Normalised device coordinates in [-1, 1], y up — ready for raycasting. */
  ndcX: number;
  ndcY: number;
  /** Movement since the previous frame while this button is held, in CSS pixels. */
  dx: number;
  dy: number;
  down: boolean;
  /** True only on the frame the button went down. */
  pressed: boolean;
  /** True only on the frame the button came up. */
  released: boolean;
  /** Where this drag began, in CSS pixels. */
  downX: number;
  downY: number;
  /** Seconds the button has been held. */
  heldFor: number;
  /** Total path length dragged since press — distinguishes a click from a box-select. */
  dragDist: number;
}

const BUTTONS = 3;

export class Input {
  readonly pointer: PointerState[] = [];
  /** Wheel delta accumulated this frame, normalised so one notch ~= 1. */
  wheel = 0;
  /** Cursor position even when no button is down. */
  mouseX = 0;
  mouseY = 0;
  ndcX = 0;
  ndcY = 0;
  /** True while the cursor is over the canvas. */
  hovering = false;
  /**
   * True once a real pointer position has been observed on the canvas.
   *
   * Edge-panning is gated on this as well as `hovering`, as a second line of defence: any
   * future path that sets `hovering` without a position must not be able to drive the camera
   * from a default of 0,0, which reads as the top-left corner and pans without being asked.
   */
  pointerSeen = false;

  private keys = new Set<string>();
  private keysPressed = new Set<string>();
  private keysReleased = new Set<string>();
  /**
   * Per-button position at the previous frame, so `dx/dy` is that button's own travel.
   *
   * These used to be derived from one shared cursor position, which is only right while
   * exactly one button is held: on the frame a button went down its delta was measured
   * against wherever the cursor had been last frame, so a middle-button drag jumped the
   * camera by the distance the mouse had travelled before the press.
   */
  private btnPrevX = [0, 0, 0];
  private btnPrevY = [0, 0, 0];
  private el: HTMLElement;
  private disposers: Array<() => void> = [];
  /** Set by the UI layer so world-space clicks are suppressed over HUD panels. */
  uiCapture = false;

  constructor(el: HTMLElement) {
    this.el = el;
    for (let i = 0; i < BUTTONS; i++) {
      this.pointer.push({
        x: 0, y: 0, ndcX: 0, ndcY: 0, dx: 0, dy: 0,
        down: false, pressed: false, released: false,
        downX: 0, downY: 0, heldFor: 0, dragDist: 0,
      });
    }
    this.attach();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window | Document,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions
  ): void {
    target.addEventListener(type as string, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type as string, fn as EventListener));
  }

  private attach(): void {
    const rectXY = (e: MouseEvent): [number, number] => {
      const r = this.el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this.listen(this.el, 'pointerdown', (e: PointerEvent) => {
      const b = e.button;
      if (b >= BUTTONS) return;
      const [x, y] = rectXY(e);
      const p = this.pointer[b];
      p.down = true;
      p.pressed = true;
      p.downX = x;
      p.downY = y;
      p.heldFor = 0;
      p.dragDist = 0;
      p.x = x;
      p.y = y;
      this.btnPrevX[b] = x;
      this.btnPrevY[b] = y;
      this.el.setPointerCapture?.(e.pointerId);
      // Middle-click autoscroll and right-click drag must not scroll the page.
      if (b !== 0) e.preventDefault();
    });

    this.listen(window, 'pointerup', (e: PointerEvent) => {
      const b = e.button;
      if (b >= BUTTONS) return;
      const p = this.pointer[b];
      if (p.down) {
        // The release position, so a marquee ended over a HUD panel still ends there.
        const [x, y] = rectXY(e);
        p.x = x;
        p.y = y;
        p.released = true;
      }
      p.down = false;
    });

    this.listen(this.el, 'pointermove', (e: PointerEvent) => {
      const [x, y] = rectXY(e);
      this.mouseX = x;
      this.mouseY = y;
      this.pointerSeen = true;
      for (const p of this.pointer) {
        if (p.down) {
          p.dragDist += Math.hypot(x - p.x, y - p.y);
          p.x = x;
          p.y = y;
        }
      }
    });

    /*
     * `pointerenter` carries a position, and it must be used.
     *
     * `hovering` alone used to enable edge-panning while `mouseX/mouseY` were still their
     * initial 0,0 — which is the top-left *corner*, so the camera edge-panned up and to the
     * left on its own with the cursor sitting harmlessly in the middle of the screen. It only
     * showed up once the pre-battle menu existed: the browser fires `pointerenter` on the
     * canvas the moment the menu overlay above it is removed, and no `pointermove` has
     * happened over the canvas yet, so the stale corner position was live for as long as the
     * player left the mouse still. It drifted the focus from (0, 120) to (-319, 9) in under
     * three seconds of play.
     */
    this.listen(this.el, 'pointerenter', (e: PointerEvent) => {
      const [x, y] = rectXY(e);
      this.mouseX = x;
      this.mouseY = y;
      this.pointerSeen = true;
      this.hovering = true;
    });
    this.listen(this.el, 'pointerleave', () => { this.hovering = false; });

    this.listen(this.el, 'wheel', (e: WheelEvent) => {
      // deltaMode 0 = pixels, 1 = lines, 2 = pages. Normalise to "notches".
      const scale = e.deltaMode === 1 ? 1 / 16 : e.deltaMode === 2 ? 1 / 2 : 1 / 100;
      this.wheel += e.deltaY * scale;
      e.preventDefault();
    }, { passive: false });

    // Document-wide, not canvas-only: the right button is the order button, and a player
    // who aims one at a unit card wants the order, not the browser's menu over the field.
    this.listen(document, 'contextmenu', (e: Event) => e.preventDefault());

    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      // Don't swallow browser shortcuts or typing in text fields.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const code = e.code;
      // Record the modifier itself before bailing out. Returning early on `e.ctrlKey`
      // meant `ControlLeft`/`ControlRight` never entered the key set, so `input.ctrl` was
      // permanently false and ctrl-click add-to-selection could never work.
      const isModifier = code === 'ControlLeft' || code === 'ControlRight'
        || code === 'MetaLeft' || code === 'MetaRight'
        || code === 'AltLeft' || code === 'AltRight'
        || code === 'ShiftLeft' || code === 'ShiftRight';
      // Still refuse to swallow genuine browser shortcuts (cmd/ctrl + a letter).
      if (!isModifier && (e.metaKey || e.ctrlKey)) return;
      if (!this.keys.has(code)) this.keysPressed.add(code);
      this.keys.add(code);
      if (code === 'Space' || code.startsWith('Arrow') || code === 'Tab') e.preventDefault();
    });

    this.listen(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.keysReleased.add(e.code);
    });

    // Losing focus must release everything, or units keep marching while you alt-tab.
    this.listen(window, 'blur', () => {
      for (const c of this.keys) this.keysReleased.add(c);
      this.keys.clear();
      for (const p of this.pointer) p.down = false;
    });
  }

  key(code: string): boolean {
    return this.keys.has(code);
  }
  keyPressed(code: string): boolean {
    return this.keysPressed.has(code);
  }
  keyReleased(code: string): boolean {
    return this.keysReleased.has(code);
  }
  get shift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }
  get alt(): boolean {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
  }
  get ctrl(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
  }

  get lmb(): PointerState { return this.pointer[0]; }
  get mmb(): PointerState { return this.pointer[1]; }
  get rmb(): PointerState { return this.pointer[2]; }

  /**
   * Refresh derived per-frame values. Call once at the very top of the frame,
   * before any system polls input.
   */
  beginFrame(dt: number, viewW: number, viewH: number): void {
    this.ndcX = (this.mouseX / viewW) * 2 - 1;
    this.ndcY = -(this.mouseY / viewH) * 2 + 1;

    for (let b = 0; b < BUTTONS; b++) {
      const p = this.pointer[b];
      p.dx = p.down ? p.x - this.btnPrevX[b] : 0;
      p.dy = p.down ? p.y - this.btnPrevY[b] : 0;
      this.btnPrevX[b] = p.x;
      this.btnPrevY[b] = p.y;
      p.ndcX = (p.x / viewW) * 2 - 1;
      p.ndcY = -(p.y / viewH) * 2 + 1;
      if (p.down) p.heldFor += dt;
    }
  }

  /** Clear one-shot edges. Call once at the very end of the frame. */
  endFrame(): void {
    this.wheel = 0;
    this.keysPressed.clear();
    this.keysReleased.clear();
    for (const p of this.pointer) {
      p.pressed = false;
      p.released = false;
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
