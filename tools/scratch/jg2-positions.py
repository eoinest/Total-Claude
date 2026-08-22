"""Every monument's world position on the landmarks branch, from the frame's two anchors.

Same arithmetic as `jg2-edge.py`; printed so a camera can be parked at a named monument
without booting the game. `place()` also clamps z into `[CITY_Z_MIN(x) + 20, CITY_Z_MAX]`,
which this does NOT model — a row whose printed z is close to the wall may be clamped, and the
built scene is the authority. Flagged in the output.
"""
import math
import os
import re

KX, KZ, HALF, PRECINCT = 0.443, 0.35, 1400.0, 1.07
GATE_X, GATE_Z = 72.0, 529.7456
X0 = GATE_X - KX * (-497)
Z0 = GATE_Z + KZ * 2045
CITY_Z_MAX = HALF - 26

p = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'city', 'rome', 'survey.ts')
s = open(p).read()
rows = []
for r in re.split(r"\n  \{\n", s):
    m = re.search(r"id:\s*'([^']+)'", r)
    if not m:
        continue
    d = {'id': m.group(1)}
    for k in ('e', 'n', 'len', 'wid', 'bearing', 'draw', 'drawY'):
        mm = re.search(rf"\b{k}:\s*(-?[\d.]+)", r)
        if mm:
            d[k] = float(mm.group(1))
    d['axis'] = 'z' if re.search(r"axis:\s*'z'", r) else 'x'
    d['soft'] = 'soft: true' in r
    mc = re.search(r"complex:\s*'([^']+)'", r)
    d['complex'] = mc.group(1) if mc else ''
    rows.append(d)

print(f"X0 = {X0:.3f}  Z0 = {Z0:.3f}  CITY_Z_MAX = {CITY_Z_MAX:.0f}\n")
print(f"  {'id':22} {'e':>6} {'n':>6} {'x':>8} {'z':>8} {'draw':>6} "
      f"{'drawn L':>8} {'off +Z?':>8}  complex")
for d in sorted(rows, key=lambda q: q.get('n', 0), reverse=True):
    if 'e' not in d:
        continue
    x = X0 + KX * d['e']
    z = Z0 - KZ * d['n']
    dr = d.get('draw', 1.0)
    off = 'OFF-MAP' if z > CITY_Z_MAX else ''
    print(f"  {d['id']:22} {d['e']:6.0f} {d['n']:6.0f} {x:8.1f} {z:8.1f} {dr:6.3f} "
          f"{d.get('len', 0)*dr:8.1f} {off:>8}  {d['complex']}")
