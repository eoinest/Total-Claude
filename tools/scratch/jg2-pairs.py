"""Monument-pair clearance, tagged by declared `complex`, with the *right* sign convention.

`tools/scratch/judge-monuments.mjs` computed this in the browser and got it **wrong**, in
exactly the way `ROME-FABRIC.md` §8.8 warns about: it built each oriented box as
`u = (hw·cos, −hw·sin)` where the rotation convention in use is `u = (hw·cos, +hw·sin)`, which
mirrors every rotated box about its own centre and is invisible on an axis-aligned one. It
reported the Basilica Ulpia and Trajan's Column interpenetrating by 13.6 m; the city's own
`assertNoFootprintOverlaps` reported two abutments at 1.0 m.

*"An instrument that agrees with the document it is checking is not thereby correct"* — and one
that disagrees with it is not thereby right either. This recomputes the population from the
boxes the probe recorded, using `tools/probe-fabric.mjs`'s own `obPoly` convention, so the
answer is comparable with the external gate rather than with a private convention.

  python3 tools/scratch/jg2-pairs.py /tmp/tc-jg2/mon-6c975e8.json
"""
import json
import math
import sys
import itertools

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tc-jg2/mon-6c975e8.json'
d = json.load(open(path))
ABUT = 2.5          # probe-fabric T.ABUT_DEPTH_M
ABUT_FRAC = 0.05    # probe-fabric T.ABUT_FRAC
STREET = 7.0        # probe-fabric T.CLEAR_MON_MON


def poly(x, z, hw, hd, rot):
    """probe-fabric's obPoly, verbatim in its convention."""
    c, s = math.cos(rot), math.sin(rot)
    ux, uz = c * hw, s * hw
    vx, vz = -s * hd, c * hd
    return [(x - ux - vx, z - uz - vz), (x + ux - vx, z + uz - vz),
            (x + ux + vx, z + uz + vz), (x - ux + vx, z - uz + vz)]


def axes(P):
    out = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        ex, ez = b[0] - a[0], b[1] - a[1]
        l = math.hypot(ex, ez) or 1.0
        out.append((-ez / l, ex / l))
    return out


def sat(A, B):
    """+ clear separation along the best axis, − penetration depth. Boxes only."""
    max_sep, min_ov = -1e18, 1e18
    for ax, az in axes(A) + axes(B):
        pa = [p[0] * ax + p[1] * az for p in A]
        pb = [p[0] * ax + p[1] * az for p in B]
        sep = max(min(pa) - max(pb), min(pb) - max(pa))
        max_sep = max(max_sep, sep)
        min_ov = min(min_ov, min(max(pa), max(pb)) - max(min(pa), min(pb)))
    return max_sep if max_sep > 0 else -min_ov


def clip_area(A, B):
    """Sutherland-Hodgman then shoelace, as probe-fabric does it."""
    out = list(A)
    for i in range(len(B)):
        a, b = B[i], B[(i + 1) % len(B)]
        ex, ez = b[0] - a[0], b[1] - a[1]
        nxt = []
        for j in range(len(out)):
            p, q = out[j], out[(j + 1) % len(out)]
            sp = ex * (p[1] - a[1]) - ez * (p[0] - a[0])
            sq = ex * (q[1] - a[1]) - ez * (q[0] - a[0])
            if sp >= 0:
                nxt.append(p)
            if (sp >= 0) != (sq >= 0):
                t = sp / (sp - sq)
                nxt.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
        out = nxt
        if not out:
            return 0.0
    s = 0.0
    for j in range(len(out)):
        p, q = out[j], out[(j + 1) % len(out)]
        s += p[0] * q[1] - q[0] * p[1]
    return abs(s) * 0.5


rows = [r for r in d['rows'] if not r['soft'] and r['box']['w'] is not None]
boxes = {}
for r in rows:
    rot = math.radians(r['rotDeg'])
    boxes[r['id']] = dict(
        p=poly(r['x'], r['z'], r['box']['w'] / 2, r['box']['d'] / 2, rot),
        area=r['box']['w'] * r['box']['d'],
        complex=r['complex'],
    )

print(f"{len(rows)} drawn masonry monuments in {path}\n")
print(f"  {'m':>8}  {'m2':>8}  {'same cx':>7}  pair")
pairs = []
for a, b in itertools.combinations(sorted(boxes), 2):
    A, B = boxes[a], boxes[b]
    v = sat(A['p'], B['p'])
    if v > 60:
        continue
    ar = clip_area(A['p'], B['p']) if v < 0 else 0.0
    same = A['complex'] is not None and A['complex'] == B['complex']
    pairs.append((v, ar, same, a, b, A['complex'], B['complex'], min(A['area'], B['area'])))
pairs.sort()
for v, ar, same, a, b, ca, cb, minarea in pairs[:34]:
    print(f"  {v:8.2f}  {ar:8.1f}  {str(same):>7}  {a} / {b}   [{ca}|{cb}]")

print()
bad = [p for p in pairs if not p[2] and p[0] < STREET]
print(f"G8's own population — pairs NOT in one complex closer than {STREET} m: {len(bad)}")
for v, ar, same, a, b, ca, cb, m in bad:
    print(f"    {v:.2f} m  {a} / {b}")

inc = [p for p in pairs if p[2]]
print(f"\npairs inside one declared complex: {len(inc)}")
deep = [p for p in inc if p[0] < -ABUT]
print(f"  interpenetrating deeper than ABUT_DEPTH_M {ABUT} m: {len(deep)}")
for v, ar, same, a, b, ca, cb, m in deep:
    print(f"    {v:.2f} m, {ar:.0f} m2 ({100*ar/m:.1f} % of the smaller box)  {a} / {b}")
frac = [p for p in inc if p[0] < 0 and p[1] > ABUT_FRAC * p[7]]
print(f"  overlapping by more than ABUT_FRAC {ABUT_FRAC} of the smaller box: {len(frac)}")
for v, ar, same, a, b, ca, cb, m in frac:
    print(f"    {v:.2f} m, {ar:.0f} m2 = {100*ar/m:.1f} % of {m:.0f} m2  {a} / {b}")
mid = [p for p in inc if ABUT < p[0] < STREET]
print(f"  gap in ({ABUT}, {STREET}) m — neither a party wall nor a street: {len(mid)}")
for v, ar, same, a, b, ca, cb, m in mid:
    print(f"    {v:.2f} m  {a} / {b}  [{ca}]")
far = [p for p in inc if p[0] >= STREET]
print(f"  gap >= {STREET} m — declared one building, standing a street apart: {len(far)}")
for v, ar, same, a, b, ca, cb, m in far:
    print(f"    {v:.2f} m  {a} / {b}  [{ca}]")

# ---------------------------------------------------------------------------
# The check the gate is missing: is a declared `complex` actually ONE piece of
# continuous fabric?
#
# Not "every pair abuts" — a chain of abutments is one building without its ends
# touching. The correct statement is **connectivity**: the graph whose nodes are the
# complex's rows and whose edges are pairs joined at a party wall must be a single
# component. That can fail, it fails for a complex used as a set label rather than as a
# statement about the ground, and it does not demand that distant members touch.
print("\n" + "=" * 76)
print("IS EACH DECLARED COMPLEX ONE PIECE OF FABRIC? (connectivity under a party wall)")
members = {}
for r in rows:
    if r['complex']:
        members.setdefault(r['complex'], []).append(r['id'])
gap = {}
for v, ar, same, a, b, ca, cb, m in pairs:
    gap[(a, b)] = v
    gap[(b, a)] = v
for join in (ABUT, 4.0, STREET):
    print(f"\n  edge = a joint at <= {join} m")
    for cx, ids in sorted(members.items()):
        parent = {i: i for i in ids}

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        for a, b in itertools.combinations(ids, 2):
            g = gap.get((a, b))
            if g is not None and g <= join:
                parent[find(a)] = find(b)
        comps = {}
        for i in ids:
            comps.setdefault(find(i), []).append(i)
        verdict = 'ONE PIECE' if len(comps) == 1 else f'{len(comps)} PIECES'
        print(f"    {cx:20} {len(ids)} rows  ->  {verdict}")
        if len(comps) > 1:
            for c in comps.values():
                print(f"        {{{', '.join(sorted(c))}}}")
