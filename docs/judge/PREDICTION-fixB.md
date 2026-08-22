# Prediction for `e/fix/game-tells-the-truth`, written from the diff before any result landed

Committed before the campaigns finished and before reading the branch's own `HANDOFF.md` entry,
so that neither their numbers nor mine can have shaped it. Branch `85d6b7d`, src measured through
the wire (`unitOutcome` present, `lateral` absent — a `main` base, as expected).

## What the diff does

`censusWall` now collects broken storm units and skips them:

```js
if (u.faction === w.storm && isBroken(u)) {
  routed.add(u.id);
  out.stormOnWall += st.onWall;   // still described as on the parapet
  continue;                        // but excluded from stormRun
}
```

`continue` is what does the work: the unit never reaches `byRun.set(...)`, so it cannot
contribute to `stormRun`, so it cannot contribute to `stormHolding`. **The `routed` Set is
populated at line 625 and never read again — it is dead.**

## The prediction, and it is a disagreement

**The rout exclusion was applied to condition A and not to condition B.** The break-in census is
unchanged:

```js
for (let i = 0; i < p.count; i++) {
  if (p.faction[i] !== w.storm || b.elevated[i] !== 0 || !p.aliveAt(i)) continue;
  ...
  if (depth < -INSIDE_MARGIN) out.stormInside++;
}
```

Same three tests as before — faction, `elevated`, alive. **No test on rout.**

Condition A is the one that has never fired in anything I have played (`stormHolding` 0 in every
sample of every run, 23 consecutive samples on Carthage while `stormOnWall` peaked at 308).
Condition B is the one that decides every siege. So:

1. **Rome still falls by `breakIn`, and at close to the same tick.** `main` decided at
   t+62.85 ± 0.15 on 12 of 12. I expect the reason to stay `objective`/`breakIn` and the tick
   to stay inside roughly t+60–90. **If Rome's t+63 defeat disappears, I am wrong about the
   mechanism and will say so.**
2. `stormHolding` stays under `WALL_FOOTHOLD` (24) on the shipped garrison. Excluding routers
   from a lodgement can only *reduce* it, and it was already zero.
3. **Carthage moves less than Rome**, and for a reason I measured rather than guessed: Rome's
   inside count was **100 % routers**; Carthage's was **40 formed against 22 routing** at the
   final instant. But since neither is now excluded from the break-in, I expect *both* to be
   close to unmoved.
4. The field battle is untouched by any of this — no wall, no objective — so the only movement
   there should be from the two UI commits, which cannot reach the simulation. **If the field
   battle's state hashes move at all, something in this pass reached the sim that was not meant
   to**, and that is worth more than anything else on this list.

## What would make me wrong, stated plainly

- Rome's verdict moving off `objective` on most seeds ⇒ my reading of the census is wrong.
- Rome's verdict tick moving by more than ~30 s ⇒ the rout exclusion reaches condition B by a
  path I did not find.
- The field battle's hashes changing ⇒ a UI commit reached the simulation.

The three UI fixes — the card keyed off the published `condition`, `mauled` as the missing word
between HELD and ROUTED, the `−0` counter, the frozen field note, and the wall order refused out
loud — are all things I asked for and all look right in the diff. They are graded separately from
the simulation question above, because a card that now tells the truth about a battle that is
still decided by men running away is a better card and the same battle.
