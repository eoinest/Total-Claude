/**
 * The lobby: make a room, or join one.
 *
 * Reached from the front door, or directly at `?mp=1`. It is four fields and two buttons and
 * it does exactly one thing — turn a relay address and a room code into the URL that boots a
 * relayed battle — because everything else about the pairing is settled by the handshake,
 * which is the only party that can see both clients.
 *
 * ## Why this carries its own styles
 *
 * `menu.css` and `hud.css` are shared files with several agents live in them, and a lobby that
 * needed a stylesheet edit would be a merge conflict on somebody else's afternoon for the sake
 * of nine rules. The overlay is self-contained and borrows the menu's palette by eye. If it
 * survives, folding it into `menu.css` is a tidy-up with no behaviour in it.
 *
 * ## The relay address is a field and not a constant
 *
 * `tools/deploy-vercel.mjs` uploads a static tree with no build step, so there is nowhere to
 * bake a production relay URL in (`docs/MULTIPLAYER.md` §4.3). It defaults to
 * `ws://<this host>:5959`, which is what `node tools/relay.mjs` serves, and is remembered in
 * `localStorage` so nobody types it twice. Once `net/worker.ts` is deployed the default becomes
 * that `wss://…workers.dev` origin and this field becomes the escape hatch rather than the
 * normal path.
 */

import { CODE_ALPHABET, CODE_LEN, validCode } from '../net/protocol';

const KEY = 'tc.net.relay';
const CSS = `
.tc-lobby{position:fixed;inset:0;z-index:120;display:grid;place-items:center;
  background:radial-gradient(120% 90% at 50% 0%,#241a12 0%,#0d0a08 70%);
  font:400 15px/1.5 ui-serif,Georgia,serif;color:#e8dcc6}
.tc-lobby .card{width:min(620px,92vw);padding:30px 34px 26px;border:1px solid #6b5735;
  border-radius:3px;background:linear-gradient(#1d1610,#14100c);
  box-shadow:0 18px 60px #000a}
.tc-lobby h1{margin:0 0 4px;font:600 26px/1.1 ui-serif,Georgia,serif;letter-spacing:.06em;
  color:#e9c877;text-transform:uppercase}
.tc-lobby p{margin:0 0 18px;color:#a89a7d;font-size:13.5px}
.tc-lobby label{display:block;margin:14px 0 5px;font-size:11.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#a3906a}
.tc-lobby input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #5c4a2d;
  border-radius:2px;background:#0e0b08;color:#f0e6d2;font:400 15px/1.3 ui-monospace,monospace;
  letter-spacing:.08em}
.tc-lobby input:focus{outline:none;border-color:#c9a24a;box-shadow:0 0 0 2px #c9a24a33}
.tc-lobby .row{display:flex;gap:12px;margin-top:20px}
.tc-lobby button{flex:1;padding:11px 14px;border:1px solid #7a6238;border-radius:2px;
  background:linear-gradient(#3a2c1a,#241a10);color:#f0dfb4;font:600 13px/1 ui-serif,Georgia,serif;
  letter-spacing:.13em;text-transform:uppercase;cursor:pointer}
.tc-lobby button:hover{border-color:#c9a24a;color:#fff3d4}
.tc-lobby button.ghost{flex:0 0 auto;padding:11px 16px;background:#1a140e}
.tc-lobby .note{margin-top:16px;min-height:2.6em;font-size:13px;color:#bfae8c;
  word-break:break-all}
.tc-lobby .note b{color:#e9c877}
.tc-lobby .bad{color:#e2564b}
.tc-lobby .back{margin-top:18px;display:inline-block;color:#8e7d5f;font-size:12.5px;
  text-decoration:none;letter-spacing:.1em;text-transform:uppercase}
.tc-lobby .back:hover{color:#e9c877}
`;

const httpOf = (ws: string): string => ws.replace(/^ws/, 'http');

/** Default relay address: whatever host served the page, on the relay's own port. */
const defaultRelay = (): string => {
  const stored = localStorage.getItem(KEY);
  if (stored) return stored;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname || '127.0.0.1'}:5959`;
};

export function showLobby(host: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.className = 'tc-lobby';
  root.innerHTML = `<div class="card">
    <h1>Two commanders</h1>
    <p>One battle, both armies, on two machines. The host chooses the ground and the orders
       of battle; the challenger takes the other side. Every order goes through a relay, which
       is what makes the two simulations one battle rather than two.</p>
    <label for="tc-relay">Relay address</label>
    <input id="tc-relay" spellcheck="false" autocomplete="off">
    <label for="tc-room">Room code</label>
    <input id="tc-room" spellcheck="false" autocomplete="off" maxlength="${CODE_LEN}"
      placeholder="${'—'.repeat(CODE_LEN)}">
    <div class="row">
      <button type="button" id="tc-host">Create a room</button>
      <button type="button" id="tc-join">Join that room</button>
    </div>
    <div class="note" id="tc-note"></div>
    <a class="back" href="?">&lsaquo; Back to the front door</a>
  </div>`;
  host.append(root);

  const relay = root.querySelector('#tc-relay') as HTMLInputElement;
  const room = root.querySelector('#tc-room') as HTMLInputElement;
  const note = root.querySelector('#tc-note') as HTMLElement;
  relay.value = defaultRelay();
  room.value = (new URLSearchParams(location.search).get('room') ?? '').toUpperCase();
  room.addEventListener('input', () => {
    room.value = room.value.toUpperCase().split('')
      .filter((c) => CODE_ALPHABET.includes(c)).join('');
  });

  const say = (html: string, bad = false): void => {
    note.innerHTML = html;
    note.classList.toggle('bad', bad);
  };

  const go = (code: string, asHost: boolean): void => {
    localStorage.setItem(KEY, relay.value.trim());
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('net', relay.value.trim());
    u.searchParams.set('room', code);
    if (asHost) {
      // Straight to the setup sheet: the host still has a battle to choose, and `startStep`
      // opens there for any URL that names one.
      u.searchParams.set('menu', 'battle');
    } else {
      u.searchParams.set('host', '0');
    }
    location.href = u.toString();
  };

  (root.querySelector('#tc-host') as HTMLButtonElement).addEventListener('click', () => {
    say('Asking the relay for a room…');
    fetch(`${httpOf(relay.value.trim())}/new`)
      .then((r) => r.json() as Promise<{ room: string }>)
      .then((j) => {
        const invite = new URL(location.href);
        invite.search = '';
        invite.searchParams.set('net', relay.value.trim());
        invite.searchParams.set('room', j.room);
        invite.searchParams.set('host', '0');
        say(`Room <b>${j.room}</b>. Send this to your opponent:<br>`
          + `<code>${invite.toString()}</code>`);
        void navigator.clipboard?.writeText(invite.toString()).catch(() => { /* no clipboard */ });
        room.value = j.room;
        setTimeout(() => go(j.room, true), 900);
      })
      .catch((e) => say(`No relay at <b>${relay.value}</b> &mdash; ${String(e)}. `
        + 'Start one with <code>node tools/relay.mjs</code>.', true));
  });

  (root.querySelector('#tc-join') as HTMLButtonElement).addEventListener('click', () => {
    const code = room.value.trim().toUpperCase();
    if (!validCode(code)) {
      say(`A room code is ${CODE_LEN} characters from ${CODE_ALPHABET}. `
        + 'The confusable pairs are left out on purpose.', true);
      return;
    }
    go(code, false);
  });
}
