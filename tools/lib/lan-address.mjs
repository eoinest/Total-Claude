/**
 * Which of this machine's addresses the *other* machine can reach.
 *
 * ## Why this is not one line
 *
 * `os.networkInterfaces()` on a Mac that has ever run a VPN, a container runtime or an AirDrop
 * transfer returns a list, not an answer. On the machine this was written on it returns two
 * entries and the choice is obvious; on a machine with Docker Desktop, Tailscale and an iPhone
 * tethered it returns eight, several of them non-internal IPv4 addresses that a laptop on the
 * same Wi-Fi cannot route to. Handing the wrong one to the other player produces the exact
 * failure this whole pass exists to remove: a URL that looks right, resolves, and hangs.
 *
 * So the interfaces are *ranked* rather than filtered, every candidate is returned with the
 * reason it scored what it did, and the caller can print the runners-up. `--lan=` overrides the
 * choice entirely, because a ranking is a heuristic and the host is the one who can see the
 * router.
 *
 * ## The ranking, and the evidence for each rule
 *
 *   1. **Not internal.** `lo0`/`127.0.0.1` is the address the previous pass correctly refused to
 *      build an invite out of.
 *   2. **IPv4 only.** Not because IPv6 is wrong — a link-local `fe80::` would often work — but
 *      because it must be typed and read aloud, and `http://[fe80::1c2b:...%en0]:5958` has a
 *      zone index in it that is meaningless on the other machine.
 *   3. **A private range.** `10/8`, `172.16/12`, `192.168/16`. A globally routable v4 address on
 *      a laptop means either a very unusual network or a captive-portal fiction; either way it
 *      is not the one the machine next door reaches.
 *   4. **Not a known point-to-point or virtual interface.** `utun*` is macOS's VPN/Back-to-My-Mac
 *      tunnel family, `awdl*`/`llw*` are AirDrop and low-latency Wi-Fi, `bridge*` is Internet
 *      Sharing and the VM bridge, `vnic*`/`vmenet*`/`vboxnet*`/`docker*` are hypervisors.
 *      `169.254/16` is the address a machine gives itself when DHCP failed, which is precisely
 *      the state in which nothing will reach it.
 *   5. **`en0` before `en1` before the rest.** On every Mac shipped this decade `en0` is the
 *      built-in interface — Wi-Fi on a laptop, Ethernet on a desktop. It is a tiebreak, not a
 *      rule, and it only ever separates two candidates that are otherwise equal.
 *
 * A candidate that fails 1, 2 or 4 is *excluded*, not merely demoted, because there is no
 * network on which handing somebody a `169.254` address or an AirDrop interface is the right
 * answer. Failing 3 demotes: an unusual network is still a network.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

/** Interface-name prefixes that are never the address to hand somebody. See rule 4. */
const VIRTUAL = ['utun', 'awdl', 'llw', 'bridge', 'vnic', 'vmenet', 'vboxnet', 'docker', 'tap',
  'tun', 'ap', 'gif', 'stf', 'anpi', 'ipsec'];

const isPrivate4 = (ip) => /^10\./.test(ip)
  || /^192\.168\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** DHCP failed and the machine named itself. Nothing reaches this. */
const isLinkLocal4 = (ip) => /^169\.254\./.test(ip);

export const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1'
  || host === '::1' || host === '[::1]' || /^127\./.test(host) || host.endsWith('.localhost');

/**
 * Every address this machine could plausibly be reached at, best first.
 *
 * Returns `{ ip, iface, private: boolean, score, why }[]`. Empty means there is no LAN address,
 * which is a real state — a Mac with Wi-Fi off and no cable has exactly `lo0` — and the caller
 * must say so rather than inventing one.
 */
export function lanCandidates({ interfaces = os.networkInterfaces() } = {}) {
  const out = [];
  for (const [iface, addrs] of Object.entries(interfaces ?? {})) {
    for (const a of addrs ?? []) {
      // Node <18 reported `family` as the number 4; current Node reports 'IPv4'. Accept both.
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (isLinkLocal4(a.address)) continue;
      if (VIRTUAL.some((p) => iface.startsWith(p))) continue;
      const priv = isPrivate4(a.address);
      // en0 = 100, en1 = 99, … en9 = 91; every other name = 0. A tiebreak, per rule 5.
      const m = iface.match(/^en(\d+)$/);
      const builtIn = m ? Math.max(0, 100 - Number(m[1])) : 0;
      out.push({
        ip: a.address,
        iface,
        private: priv,
        score: (priv ? 1000 : 0) + builtIn,
        why: priv ? `${iface}, a private address` : `${iface}, not in a private range`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip));
}

/**
 * The one address to print, or `null`.
 *
 * `prefer` is `--lan=` and is taken verbatim when it is one of the candidates; when it is not,
 * it is still taken, and the caller is expected to say that it was overridden — a host who
 * types an address knows something `os.networkInterfaces()` does not, such as which of two
 * subnets the other laptop is on.
 */
export function lanAddress({ prefer = '', interfaces = os.networkInterfaces() } = {}) {
  const all = lanCandidates({ interfaces });
  if (prefer) {
    const hit = all.find((c) => c.ip === prefer);
    // A finite score, not `Infinity`: this object is JSON-serialised into `--json` output and
    // `JSON.stringify(Infinity)` is `null`, which reads as "unscored" rather than "top".
    return hit ?? { ip: prefer, iface: '(given)', private: isPrivate4(prefer), score: 9999,
      why: 'given on the command line with --lan=', overridden: true };
  }
  return all[0] ?? null;
}

/**
 * The name Bonjour actually answers to on this machine, and the reason `os.hostname()` is not it.
 *
 * `os.hostname()` returns whatever the DHCP server handed back — on this machine, and on any
 * machine on an AT&T router, `Mac.attlocal.net`. The old spelling was
 * `os.hostname().replace(/\.local\.?$/, '') + '.local'`, which turns that into
 * **`Mac.attlocal.net.local`**: a name that resolves to nothing, printed by `npm run host` under
 * the words "Mac to Mac", and — worse — fed to Vite's `allowedHosts`. So the only name Vite
 * would answer to did not resolve, and `Ernests-MacBook-Pro-2.local`, which *does* resolve to
 * this machine's LAN address, was refused by the DNS-rebinding guard. Both halves wrong, in
 * opposite directions, from one expression that was written twice.
 *
 * macOS keeps the Bonjour name separately, and `scutil --get LocalHostName` is the only thing
 * that knows it. Measured here: `scutil` says `Ernests-MacBook-Pro-2`, `os.hostname()` says
 * `Mac.attlocal.net`, and `dns-sd`/`ping` resolve `Ernests-MacBook-Pro-2.local` to 192.168.1.77.
 *
 * Spelled **once**, in this file, because it was previously spelled twice — in
 * `tools/host-lan.mjs` and in `tools/lib/vite-runner.mjs`, the second under a comment that
 * said "spelled once, [because] used in two places that must agree". They did agree. They were
 * both wrong.
 *
 * Off darwin, or with `scutil` unavailable, this falls back to the old derivation, which is
 * right on a Linux box whose hostname is not a FQDN. `null` is never returned: a caller that
 * gets a name still has to be prepared for it not to resolve, which is why every place that
 * prints one also prints the address.
 */
export function mdnsName({ platform = process.platform, exec = null } = {}) {
  if (platform === 'darwin') {
    try {
      const run = exec ?? ((c, a) => execFileSync(c, a, { encoding: 'utf8', timeout: 2000 }));
      const said = String(run('scutil', ['--get', 'LocalHostName'])).trim();
      if (said) return `${said.replace(/\.local\.?$/, '')}.local`;
    } catch {
      // No scutil, or it refused. Fall through to the derivation below.
    }
  }
  return `${os.hostname().replace(/\.local\.?$/, '')}.local`;
}
