edits = []

# 1. agree.ts -- the load-bearing statement of why uf64 is the detector.
edits.append(('src/net/agree.ts',
""" * with about 29 bits of headroom against 1–3 ULP of libm disagreement. `UnitGroupState` has no
 * such firewall. A session that watched the pool hash would find its desync nearly two orders
 * of magnitude later in simulated time, by which point the battle it would have to name is
 * long gone.
""",
""" * with about 29 bits of headroom against 1–3 ULP of libm disagreement. A session that watched
 * the pool hash would find its desync nearly two orders of magnitude later in simulated time,
 * by which point the battle it would have to name is long gone.
 *
 * **Why `uf64` is faster is not what this file used to say.** It said `UnitGroupState` has no
 * such firewall, and that is measurably wrong: all fourteen `UNIT_F64_FIELDS` are float32
 * values in a float64 box — 36 of 36 readings across twelve units and three frames of the
 * shipped battle had their low 29 mantissa bits zero, and a one-float64-ULP nudge to any of
 * them was gone within a tick (`tools/scratch/ulpfields.mjs`, 3 Sep 2026). `uf64` is a float64
 * hash *of float32 values*, and it is sensitive for a different reason: it is **per unit and
 * aggregated over 37 of them**, where the pool hash averages one man's disagreement into
 * thousands. Both layers are behind the same quantisation firewall; one of them reports what
 * gets through it sooner. See `NetSession.testMarker`, which was injecting a difference this
 * state cannot hold.
""" ))

# 2. qa-net's one-ulp: two `why` lines repeating the old claim.
edits.append(('tools/qa-net.mjs',
"'the float32 pool has a quantisation firewall with ~29 bits of headroom; UnitGroupState has none'",
"'both layers are behind the same float32 firewall; uf64 reports what gets through it sooner '\n    + 'because it is per-unit rather than averaged over thousands of men (see agree.ts)'"))

edits.append(('tools/qa-net.mjs',
"'the magnitude §1.4 measured for a real libm disagreement. Nothing about the order stream is wrong here — the arithmetic is'",
"'one float32 ULP: what a 1-3 float64 ULP libm disagreement leaves behind when it lands near a '\n    + 'rounding boundary and gets through the quantisation firewall, which is the only case that '\n    + 'reaches this state at all. Nothing about the order stream is wrong here — the arithmetic is'"))

# 3. qa-p2p's desync arm.
edits.append(('tools/qa-p2p.mjs',
"""      kind === 'ulp' ? 'one UnitGroupState float64 field moved by one unit in the last place, '
        + 'which is the magnitude a libm disagreement actually has (§1.4)'""",
"""      kind === 'ulp' ? 'one UnitGroupState position moved by one float32 ULP, which is what a '
        + '1-3 float64 ULP libm disagreement leaves behind when it gets through the quantisation '
        + 'firewall at all — a float64 ULP is not representable in this state (§13.9)'"""))

for path, old, new in edits:
    s = open(path, encoding='utf-8').read()
    assert s.count(old) == 1, f'{path}: {old[:60]}'
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))
    print('patched', path)
