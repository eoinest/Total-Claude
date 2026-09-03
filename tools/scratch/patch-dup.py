import re

# ---- transport.ts: the knob -------------------------------------------------
p = 'src/net/transport.ts'
s = open(p, encoding='utf-8').read()

old = """  /** Test-only. Corrupts what this peer commits. See `PeerFault`. */
  fault?: PeerFault | null;
}"""
new = """  /** Test-only. Corrupts what this peer commits. See `PeerFault`. */
  fault?: PeerFault | null;
  /** Test-only. Sends every signalling message twice. See `PeerLinkOptions.dupSignal`. */
  dupSignal?: boolean;
}"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  const brokers = (params.get('p2pbrokers') ?? '').trim();"""
new = """  // `?p2pdup=1`: every signalling message goes out twice. A public broker can deliver a
  // duplicate on its own, and the host publishes its offer on a timer *and* on a knock, so this
  // is an ordinary condition rather than an exotic one. See `PeerLink.sendSignal`.
  if (params.get('p2pdup') === '1') out.dupSignal = true;
  const brokers = (params.get('p2pbrokers') ?? '').trim();"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    sendDelayMs: o.sendDelayMs ?? 0,
    fault: o.fault ?? null,
  });"""
new = """    sendDelayMs: o.sendDelayMs ?? 0,
    fault: o.fault ?? null,
    dupSignal: o.dupSignal ?? false,
  });"""
assert s.count(old) == 1
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('patched transport.ts')

# ---- PeerLink.ts: the option, the sender, and every call site ---------------
p = 'src/net/PeerLink.ts'
s = open(p, encoding='utf-8').read()

# The option on the interface. Anchor on the fault option, which is the last test-only one.
m = re.search(r"\n  /\*\*[^\n]*\n(?:[^\n]*\n)*?  fault\?: PeerFault \| null;\n", s)
assert m, 'fault option'
s = s[:m.end()] + """  /**
   * Test-only: send every signalling message **twice**.
   *
   * Not exotic. A public MQTT broker can redeliver, and this design produces duplicates by
   * itself — the host publishes its offer on `OFFER_REPEAT_MS` *and* immediately on a knock. A
   * duplicate offer arriving inside the two awaits of the answer path killed a session whose
   * data channel was already open; `qa-p2p`'s `dup` arm is the standing check that it cannot.
   */
  dupSignal?: boolean;
""" + s[m.end():]

open(p, 'w', encoding='utf-8').write(s)
print('patched PeerLink.ts (option)')
