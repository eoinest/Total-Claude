"""How many *size* relations between Rome's monuments are inverted by the authored `draw`?

`e/city/rome-landmarks` reports **0 of 860 spatial relations inverted** — is the Pantheon
still north of the Theatre of Pompey — and that number is real and is a proof. This is the
same question asked about the other thing a person reads off two buildings in one frame:
**which of them is bigger.** A per-monument authored footprint has no reason to preserve it,
and nothing in the tree counts it.

The ruler is the survey's own published `len` (the real dimension the row departs from), so
this measures the departure the row declares against the fact the row cites — it is not an
independent read of the archaeology, and it does not need to be: the question is whether the
*declared* scale preserves the *declared* order.

  python3 tools/scratch/jg2-size-relations.py
"""
import re
import os
import itertools

p = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'city', 'rome', 'survey.ts')
s = open(p).read()

rows = []
for r in re.split(r"\n  \{\n", s):
    m = re.search(r"id:\s*'([^']+)'", r)
    if not m:
        continue
    d = {'id': m.group(1), 'soft': 'soft: true' in r}
    for k in ('len', 'wid', 'draw', 'e', 'n'):
        mm = re.search(rf"\b{k}:\s*(-?[\d.]+)", r)
        if mm:
            d[k] = float(mm.group(1))
    rows.append(d)

# Off-map south, per layout.ts `offMapSouth`: these five plus the Janiculum are not drawn.
OFF = {'palatine', 'circus-maximus', 'aventine-temples', 'baths-caracalla',
       'caelian-villas', 'janiculum'}

on = [d for d in rows if d['id'] not in OFF and not d['soft'] and 'len' in d]
for d in on:
    d['drawn'] = d['len'] * d.get('draw', 1.0)

print(f"{len(on)} drawn masonry monuments\n")

inv = []
tot = 0
for a, b in itertools.combinations(on, 2):
    if abs(a['len'] - b['len']) < 1e-6:
        continue
    tot += 1
    real = a['len'] - b['len']
    drawnd = a['drawn'] - b['drawn']
    if real * drawnd < 0:
        big, small = (a, b) if real > 0 else (b, a)
        inv.append((big, small, abs(real), abs(drawnd)))

inv.sort(key=lambda t: -t[2])
print(f"INVERTED SIZE RELATIONS: {len(inv)} of {tot} pairs "
      f"({100.0*len(inv)/tot:.1f} %)\n")
print(f"  {'really bigger':22} {'really smaller':22} {'real m':>8} {'drawn m':>9}")
for big, small, r, dd in inv:
    print(f"  {big['id']:22} {small['id']:22} "
          f"{big['len']:.0f} v {small['len']:.0f}".ljust(66)
          + f"  {big['drawn']:.0f} v {small['drawn']:.0f}")

# The worst single inversion, by how far the order is reversed.
print("\nworst reversals by drawn ratio against real ratio:")
scored = []
for big, small, r, dd in inv:
    rr = big['len'] / small['len']
    dr = big['drawn'] / small['drawn']
    scored.append((rr / dr, big['id'], small['id'], rr, dr))
scored.sort(reverse=True)
for f, a, b, rr, dr in scored[:10]:
    print(f"  {a:22} / {b:22} real {rr:5.2f}x -> drawn {dr:5.2f}x   ({f:4.1f}x wrong)")

# ---------------------------------------------------------------------------
# The subset that matters at 1.75 m: pairs close enough to appear in one frame.
# World positions from the frame's two anchors, as in jg2-positions.py.
import math
KX, KZ = 0.443, 0.35
X0 = 72.0 - KX * (-497)
Z0 = 529.7456 + KZ * 2045
for d in on:
    d['x'] = X0 + KX * d['e']
    d['z'] = Z0 - KZ * d['n']

for radius in (150, 250, 400):
    near_tot = near_inv = 0
    worst = []
    for a, b in itertools.combinations(on, 2):
        if abs(a['len'] - b['len']) < 1e-6:
            continue
        if math.hypot(a['x'] - b['x'], a['z'] - b['z']) > radius:
            continue
        near_tot += 1
        if (a['len'] - b['len']) * (a['drawn'] - b['drawn']) < 0:
            near_inv += 1
            big, small = (a, b) if a['len'] > b['len'] else (b, a)
            worst.append((big['len'] / small['len'], big['drawn'] / small['drawn'],
                          big['id'], small['id'],
                          math.hypot(a['x'] - b['x'], a['z'] - b['z'])))
    pc = 100.0 * near_inv / near_tot if near_tot else 0.0
    print(f"\nwithin {radius} world m of each other: {near_inv} of {near_tot} inverted ({pc:.1f} %)")
    worst.sort(key=lambda t: -(t[0] / t[1]))
    for rr, dr, a, b, dist in worst:
        print(f"    {a:20} / {b:20} real {rr:5.2f}x -> drawn {dr:5.2f}x   {dist:5.0f} m apart")
