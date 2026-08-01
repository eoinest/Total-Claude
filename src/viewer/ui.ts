/**
 * Panel widgets.
 *
 * Hand-rolled rather than reaching for a GUI library: the whole control set is six widget
 * kinds, and a dependency would be shipped to every visitor of the deployed site for the sake
 * of a page most of them will never open.
 */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class Panel {
  readonly root: HTMLElement;
  private current: HTMLElement;
  /** The group most recently opened, so a caller can hide one that is irrelevant. */
  lastGroup!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    const head = el('div', 'vw-title');
    head.append(el('b', undefined, 'TOTAL CLAUDE — MODEL VIEWER'));
    head.append(el('span', undefined, 'drag orbit · wheel zoom · right-drag pan'));
    root.append(head);
    this.current = root;
  }

  group(title: string): this {
    const g = el('div', 'vw-group');
    g.append(el('h3', undefined, title));
    this.root.append(g);
    this.current = g;
    this.lastGroup = g;
    return this;
  }

  private row(label?: string): HTMLElement {
    const r = el('div', 'vw-row');
    if (label !== undefined) r.append(el('label', undefined, label));
    this.current.append(r);
    return r;
  }

  /**
   * Explanatory prose, collapsed.
   *
   * Every note in this panel earns its place, but expanded they pushed the last two control
   * groups below the fold at 900 px and a reviewer could not reach — or read — the very
   * documentation that explains the instruments. Collapsed behind a "why" they cost one line
   * each and the whole control set fits.
   */
  note(text: string): this {
    const d = el('details', 'vw-note');
    const sum = el('summary', undefined, 'why');
    d.append(sum, el('p', undefined, text));
    this.current.append(d);
    return this;
  }

  select(
    label: string,
    options: { value: string; label: string; group?: string }[],
    value: string,
    onChange: (v: string) => void
  ): HTMLSelectElement {
    const r = this.row(label);
    const s = el('select');
    let group: HTMLOptGroupElement | null = null;
    for (const o of options) {
      const opt = el('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.group) {
        if (!group || group.label !== o.group) {
          group = el('optgroup');
          group.label = o.group;
          s.append(group);
        }
        group.append(opt);
      } else {
        group = null;
        s.append(opt);
      }
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    const wrap = el('div', 'vw-fill');
    wrap.append(s);
    r.append(wrap);
    return s;
  }

  /** A row of buttons acting as one exclusive choice. */
  segmented<T extends string>(
    label: string, choices: { value: T; label: string; title?: string }[], value: T,
    onChange: (v: T) => void
  ): (v: T) => void {
    const r = this.row(label);
    const seg = el('div', 'vw-seg vw-fill');
    const buttons = choices.map((c) => {
      const b = el('button', undefined, c.label);
      if (c.title) b.title = c.title;
      b.addEventListener('click', () => onChange(c.value));
      seg.append(b);
      return b;
    });
    r.append(seg);
    const sync = (v: T): void => {
      choices.forEach((c, i) => buttons[i].classList.toggle('vw-on', c.value === v));
    };
    sync(value);
    return sync;
  }

  toggle(label: string, value: boolean, onChange: (v: boolean) => void): (v: boolean) => void {
    const r = this.row();
    const b = el('button', 'vw-fill', label);
    let v = value;
    const sync = (nv: boolean): void => {
      v = nv;
      b.classList.toggle('vw-on', v);
    };
    b.addEventListener('click', () => {
      sync(!v);
      onChange(v);
    });
    sync(value);
    r.append(b);
    return sync;
  }

  /** The row a widget was just added to, so a caller can hide one that is irrelevant. */
  lastRow!: HTMLElement;

  /** Several toggles sharing a row, for the flags that read as a set. */
  toggleRow(
    items: { label: string; value: boolean; title?: string; onChange: (v: boolean) => void }[]
  ): ((v: boolean) => void)[] {
    const r = this.row();
    this.lastRow = r;
    const seg = el('div', 'vw-seg vw-fill');
    const syncs: ((v: boolean) => void)[] = [];
    for (const it of items) {
      const b = el('button', undefined, it.label);
      if (it.title) b.title = it.title;
      let v = it.value;
      const sync = (nv: boolean): void => {
        v = nv;
        b.classList.toggle('vw-on', v);
      };
      b.addEventListener('click', () => {
        sync(!v);
        it.onChange(v);
      });
      sync(it.value);
      seg.append(b);
      syncs.push(sync);
    }
    r.append(seg);
    return syncs;
  }

  slider(
    label: string, min: number, max: number, step: number, value: number,
    onInput: (v: number) => void, format: (v: number) => string = (v) => v.toFixed(2)
  ): (v: number) => void {
    const r = this.row(label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el('span', 'vw-val', format(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    });
    const wrap = el('div', 'vw-fill');
    wrap.append(input);
    r.append(wrap, out);
    return (v: number): void => {
      input.value = String(v);
      out.textContent = format(v);
    };
  }

  /**
   * An exact value, typed.
   *
   * A slider quantised to 0.001 cannot reproduce a man whose hash came out of `Math.random()`,
   * and "reproduce exactly what I was looking at" is the first thing anyone asks of a review
   * tool. Commit on Enter or blur; a partial value while typing must not redraw.
   */
  textValue(label: string, value: string, onCommit: (v: string) => void): (v: string) => void {
    const r = this.row(label);
    const input = el('input');
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    const commit = (): void => onCommit(input.value.trim());
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') commit();
    });
    input.addEventListener('blur', commit);
    const wrap = el('div', 'vw-fill');
    wrap.append(input);
    r.append(wrap);
    return (v: string): void => {
      if (document.activeElement !== input) input.value = v;
    };
  }

  buttons(items: { label: string; title?: string; onClick: () => void }[]): this {
    const r = this.row();
    const seg = el('div', 'vw-seg vw-fill');
    for (const it of items) {
      const b = el('button', undefined, it.label);
      if (it.title) b.title = it.title;
      b.addEventListener('click', it.onClick);
      seg.append(b);
    }
    r.append(seg);
    return this;
  }

  /**
   * The piece list.
   *
   * This is the instrument the siege engines' part view taught: the useful question about a
   * kit piece is never "is it right" but "is it *there*". Click a row to solo it — everything
   * else vanishes and you are left looking at one helmet in mid-air. Ctrl-click hides it
   * instead. Rows the current man's hash did not select are dimmed, so the difference between
   * "this unit never wears one" and "this one is broken" is visible without doing anything.
   */
  pieces(
    entries: { id: number; name: string; colour: string }[],
    onSolo: (id: number) => void,
    onToggle: (id: number) => void
  ): (present: number[], solo: number, hidden: Set<number>, tris: Map<number, number>) => void {
    const box = el('div', 'vw-pieces');
    const rows = new Map<number, { row: HTMLElement; cost: HTMLElement }>();
    for (const p of entries) {
      const row = el('div', 'vw-piece');
      const swatch = el('i');
      swatch.style.background = p.colour;
      // The swatch is the legend for the Piece IDs shading mode: this is that piece's colour
      // on the model, from the same hue walk the shader runs.
      const cost = el('em', undefined, '');
      row.append(swatch, el('span', undefined, p.name), cost);
      row.addEventListener('click', (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) onToggle(p.id);
        else onSolo(p.id);
      });
      box.append(row);
      rows.set(p.id, { row, cost });
    }
    this.current.append(box);
    return (present, solo, hidden, tris): void => {
      const set = new Set(present);
      for (const [id, { row, cost }] of rows) {
        row.classList.toggle('vw-absent', !set.has(id) || hidden.has(id));
        row.classList.toggle('vw-solo', solo === id);
        const t = tris.get(id) ?? 0;
        cost.textContent = t ? `${t}t` : '—';
      }
    };
  }
}
