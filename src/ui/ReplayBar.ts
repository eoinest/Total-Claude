import type { EngineContext } from '../core/Engine';
import { el, setClass, setText } from './dom';

/**
 * The strip that says a battle is being watched rather than fought, and the button that
 * changes that.
 *
 * "Take command from here" is not a feature that had to be built. A replay is the recorded
 * order log fed back at the ticks it was issued on, so *withholding the rest of the log* is
 * taking over — one comparison in `ReplaySystem.pump`. This button is the whole of the UI
 * for it, and everything downstream of the press is the ordinary game: the player's clicks
 * go into the same queue, get the same tick stamps, and append to the same log, so the
 * battle you take over can itself be saved and shared.
 *
 * It also carries the refusals, because a record that will not play has to say why on the
 * screen and not only in the console. There are two: a record made at a quality tier this
 * run cannot reproduce (`fittedUnitScale` will happily fit 1,515 men where 8,632 were
 * recorded, and the result is a plausible-looking different battle), and a record whose
 * checkpoints do not match — which means the game itself has moved under it.
 */
export interface ReplayProbe {
  /** `record` | `play` | `commanded`. */
  mode: string;
  playing: boolean;
  /** Orders left in the log. */
  remaining: number;
  /** Non-empty once the record has been refused, or a playback has left its record. */
  refusal: string;
  /** Tick of the first checkpoint that did not match, or -1. */
  divergedAt: number;
  takeCommand(): void;
}

export class ReplayBar {
  private root: HTMLElement | null = null;
  private badge!: HTMLElement;
  private note!: HTMLElement;
  private take!: HTMLButtonElement;
  private probe: ReplayProbe | null = null;
  /** True once this run has played anything, so a takeover keeps saying so. */
  private wasReplay = false;

  attach(parent: HTMLElement): void {
    this.root = el('div', 'replay-bar interactive', parent);
    this.root.style.display = 'none';
    this.badge = el('span', 'rp-badge', this.root);
    this.note = el('span', 'rp-note', this.root);
    this.take = el('button', 'rp-take interactive', this.root) as HTMLButtonElement;
    this.take.type = 'button';
    setText(this.take, 'TAKE COMMAND');
    this.take.addEventListener('click', () => this.probe?.takeCommand());
  }

  update(ctx: EngineContext): void {
    if (!this.root) return;
    this.probe ??= (ctx.tryGet('replay') as unknown as ReplayProbe | undefined) ?? null;
    const p = this.probe;
    if (!p) return;
    if (p.playing) this.wasReplay = true;

    const refused = p.refusal !== '';
    const show = p.playing || refused || (this.wasReplay && p.mode === 'commanded');
    this.root.style.display = show ? 'flex' : 'none';
    if (!show) return;

    setClass(this.root, 'bad', refused);
    this.take.style.display = p.playing ? '' : 'none';

    if (refused) {
      setText(this.badge, p.divergedAt >= 0 ? 'DIVERGED' : 'REFUSED');
      setText(this.note, p.refusal);
      return;
    }
    if (p.playing) {
      setText(this.badge, 'REPLAY');
      setText(this.note, p.remaining === 1 ? '1 order still to come'
        : `${p.remaining} orders still to come`);
      return;
    }
    setText(this.badge, 'YOURS');
    setText(this.note, 'the record has run out — the army is yours');
  }
}
