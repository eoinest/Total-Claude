#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 * Boots the game in Chromium with a real WebGL context, fast-forwards the simulation
 * to a chosen moment, parks the camera at a named viewpoint and writes a PNG. This is
 * the ground truth the critic agents judge — nobody grades this project from source.
 *
 * Usage:
 *   node tools/shoot.mjs                          # every shot in the default set
 *   node tools/shoot.mjs --set=deck               # the ten-frame blind deck, varied
 *   node tools/shoot.mjs --shots=wide,closeup     # a subset
 *   node tools/shoot.mjs --out=screenshots/pass3  # alternate output directory
 *   node tools/shoot.mjs --w=2560 --h=1440        # resolution
 *   node tools/shoot.mjs --list                   # list available shots
 *   node tools/shoot.mjs --hud                    # WITH the interface — never gradeable
 *
 * **The HUD is hidden unless you ask for it.** See `SHOW_HUD` below for why the default was
 * inverted; the short version is that a blind deck shot with the interface up grades the
 * interface. Every run records `hud: <bool>` in `report.json`, and `tools/blind-compare.mjs`
 * refuses to build a deck from a directory whose record is missing or says `true`.
 *
 * Exit code is non-zero if the page logged an uncaught error or any shot failed, so
 * agents can use it as a build gate.
 */

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Recorded in `report.json` so a deck can be traced back to the tree that produced it. */
/**
 * The tree object of `src/`, which is what actually decides what a frame looks like.
 *
 * `COMMIT` moves when a shot table is retuned, and a shot table is not a renderer. The
 * invariant a deck needs is that every frame in it came out of the *same renderer*, and that
 * is this hash: identical `src` tree, identical pixels for identical inputs. Recorded beside
 * the commit rather than instead of it — the commit is still how a human finds the tree.
 */
const SRC_TREE = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD:src'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
/** `<commit>:src`, so a prior pass that predates `SRC_TREE` can still be checked exactly. */
const srcTreeOf = (commit) => {
  try { return execFileSync('git', ['rev-parse', `${commit}:src`], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

const COMMIT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
})();

// ---------------------------------------------------------------------------
// Shot definitions. Each is a repeatable camera + time so successive passes are
// directly comparable — the whole point is diffing "before" against "after".
//   x, z    world focus in metres
//   zoom    0 = eye level among the troops, 1 = strategic overview
//   yaw     radians; Math.PI looks north (toward the attackers)
//   at      simulated seconds to fast-forward before shooting
// ---------------------------------------------------------------------------
const SHOTS = {
  establishing: {
    // Auto-framed from behind the player's own line, looking at the enemy — the classic
    // Total War establishing composition, with your own men large in the foreground and
    // the opposing host beyond. A fixed focus cannot do this: at zoom 0.82 a man is 5 px,
    // and at 0.55 the 320 m gap between the armies does not fit, so the camera ended up
    // photographing the empty ground between them.
    desc: 'From behind the Roman line, looking north at the Juthungi host',
    follow: 'ownLine', zoom: 0.70, at: 1,
  },
  wide: {
    // 0.95 is very nearly full zoom-out: an almost top-down strategic view in which the
    // armies are a few pixels tall and the ground's field patchwork is the only thing
    // legible. 0.72 keeps the whole line of battle in frame while men still read as men,
    // which is what this shot is for.
    desc: 'High three-quarter view of the whole battlefield and the city behind',
    x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2,
  },
  romanline: {
    // Auto-framed on the actual front rank. A hand-placed focus goes stale the moment the
    // order of battle, the terrain or the deployment changes, and it did: the line ended
    // up in the top-left corner with 90% of the frame full of grass.
    desc: 'Low telephoto along the Roman front rank — reads armour, shields, ranks',
    follow: 'romanFront', zoom: 0.36, at: 2,
  },
  germanhorde: {
    // Auto-framed on the frontmost warband, like romanline. Every hand-placed value this
    // shot has had photographed empty grass: formations put rank N at
    // z = anchor - N*spacing, so a coordinate that looks like it is "at" the mass is
    // usually just outside it, facing the wrong way.
    desc: 'Into the Juthungi mass at eye level — reads variety and disorder',
    follow: 'germanFront', zoom: 0.36, at: 2,
  },
  clash: {
    // Auto-framed: hand-picked coordinates kept missing, because where the lines
    // actually meet is an emergent property of the AI's chosen ground and shifts by
    // tens of metres between passes. `follow` resolves the focus at shoot time.
    desc: 'The moment the lines meet, mid-height, oblique',
    follow: 'contact', zoom: 0.30, at: 72,
  },
  melee: {
    desc: 'Ground level inside the melee — the hardest test of animation and gore',
    follow: 'contact', zoom: 0.30, at: 88,
  },
  cavalry: {
    // The old camera (210, 60) at yaw 1.6pi looked north-west into the Roman rear, with
    // every cavalry action 25-40 m behind it. This framing was verified by the AI agent
    // to put the wedge on the wing with the battle line receding into the dust behind.
    // `follow: 'cavalry'` averages every mounted unit, and with three Roman wings plus
    // four Juthungi raider bands spread across a 900 m front that centroid lands in the
    // infantry between them. Framed on the single largest surviving mounted unit instead.
    desc: 'The cavalry wing sweeping the flank',
    follow: 'cavalryUnit', zoom: 0.30, at: 70,
  },
  city: {
    // Was (60, 400) zoom 0.62, which put the camera *inside* the Via Flaminia tomb field
    // rather than on the city. Pulled back and lifted so the wall reads as the foreground
    // and the districts behind it fill the frame.
    desc: 'The Aurelian Wall with the city behind it',
    x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06, at: 2,
  },
  wall: {
    // Looking *along* the curtain rather than square at it. The wall's outer face points
    // north (-Z, toward the battlefield) and Rome is at 41.9N, so that face is in shade at
    // every hour of the day - brick courses cannot read on a permanently shadowed
    // surface. An oblique view down the wall line puts the sun raking across the
    // brickwork and shows the tower spacing at the same time.
    desc: 'Along the Aurelian Wall - raking light on brick courses, towers, scaffolding',
    follow: 'wall', zoom: 0.62, at: 2,
  },
  skyline: {
    desc: 'Rome behind the wall - Mausoleum, Pantheon, theatres',
    x: -180, z: 780, zoom: 0.80, yaw: Math.PI * 0.05, at: 2,
  },
  deepcity: {
    desc: 'Deep into the city - insulae density and landmark silhouettes',
    x: -20, z: 1050, zoom: 0.86, yaw: Math.PI * 0.1, at: 2,
  },
  terrain: {
    desc: 'Empty countryside — judges terrain material, vegetation and lighting alone',
    x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, at: 2,
  },
  // Both river shots are auto-framed on the live water, for the same reason the combat
  // shots are auto-framed on the live engagement. The hardcoded focus points these two
  // shipped with were ~110 m east of the channel — `riverCentreX(z)` in
  // src/terrain/topography.ts is a two-term meander, so the Tiber sits at x ≈ -868 at
  // z = -300 and x ≈ -930 at the ford, not at the -760/-820 these shots asked for. The
  // result was two photographs of dry fields with the water in a corner, which is how a
  // hand-built Tiber went un-inspected. `follow` probes `heightAt` against `waterLevel`
  // and cannot go stale when the meander is retuned.
  river: {
    desc: 'The Tiber, its cut bank, flood terrace and sand bars',
    // `z` is the line the water probe walks; `yawOffset` swings off the channel bearing so
    // the shot is oblique to the water rather than straight down it.
    follow: 'water', x: -760, z: -300, zoom: 0.72, yaw: Math.PI * 0.15, yawOffset: 0.55, at: 2,
  },
  ford: {
    desc: 'The gravel ford across the Tiber',
    follow: 'water', x: -820, z: -520, zoom: 0.42, yaw: Math.PI * 0.9, yawOffset: 1.35, at: 2,
  },
  aftermath: {
    desc: 'Late battle: corpses, routs, dust and blood on the ground',
    follow: 'corpses', zoom: 0.34, at: 190,
  },
  /*
   * Raking light. Added because the shading workstream measured that **no camera in this
   * table rakes**: sun-versus-camera bearing is -174 deg at `clash`, +138 at `romanline` and
   * `midcrowd`, -114 at `wide`. At `clash` the sun sits almost directly behind the viewer, so
   * every shadow in the frame falls away from camera and is invisible — the shot list was
   * hiding the shadow work it was meant to grade. This framing measures 84 deg, which is the
   * only near-broadside angle found, and is the frame to judge contact shadows and penumbra on.
   */
  raking: {
    desc: 'Raking sun across the Roman line — the only shot where shadows face the camera',
    x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2,
  },
  /*
   * A frame with a horizon in it.
   *
   * Two workstreams independently found that essentially none of our frames contain sky: at
   * zoom >= 0.6 the RTS camera's pitch fills the viewport with ground, on both maps, so the
   * Pydna agent could not compose anything comparable to the sky-and-mountains reference plate
   * and the shading agent measured 0.03% of frame above 90% luminance against 0.61% across the
   * plates — a 20x gap it correctly attributed to composition rather than to the tone curve,
   * since not one of our graded frames contained sky or fire while all ten plates did. Zoom is
   * the lever: pitch runs 39 deg at 0.58 and 54 deg at 0.82, so a low zoom is the only way to
   * put the horizon in shot.
   */
  horizon: {
    desc: 'Low camera with sky and horizon — the highlight and aerial-perspective control',
    x: -420, z: -120, zoom: 0.12, yaw: Math.PI * 0.62, at: 2,
  },
  // A wide camera during the collapse was the one combination the other fourteen missed:
  // `wide` is wide but fires at t+2 when nobody has routed, and `aftermath` is late but sits
  // at zoom 0.34 following the corpse pile. Neither puts thousands of scattered men in frame
  // at once, which is precisely the geometry the LOD1 band is worst at — a rout spreads a
  // unit over 120 m, so men who would have been one tight LOD2 clump straddle the boundary.
  // A pass that never renders this frame cannot see the spike it produces.
  // Pinned to the worst frame a 5-point sweep of zoom x time could find, so the pass guards
  // its own ceiling rather than a frame that merely looks busy. Measured reported triangles:
  //
  //     t+130 z0.60  15.03 M      t+156 z0.74  16.30 M
  //     t+136 z0.68  14.45 M      t+162 z0.52  13.82 M
  //     t+171 z0.60  18.30 M  <-- this one
  //
  // Note it gets worse as men *die*: 7,879 men at t+130 render fewer triangles than 7,010 at
  // t+171. Headcount is not the driver — a rout spreads a unit over ~120 m, so men who were
  // one tight clump at LOD2 end up straddling the LOD1 boundary, and the shadow cascades
  // stretch to cover a wider spread. Attribution at this frame (probe-rider --lod) is
  // soldiers 2.47 M, city 2.31 M, grass 1.30 M, terrain 0.41 M: 6.97 M unique against
  // 18.30 M reported, i.e. ~2.6x for cascades and the depth prepass. It runs at 13.65 ms.
  rout: {
    desc: 'Wide view mid-collapse — the pass\'s triangle ceiling, 18.3 M reported / 6.97 M unique',
    x: 0, z: 60, zoom: 0.60, yaw: Math.PI * 0.82, at: 171,
  },

  /*
   * ---------------------------------------------------------------------------
   * The blind deck: ten frames that are ten trials.
   * ---------------------------------------------------------------------------
   *
   * `node tools/shoot.mjs --set=deck` shoots exactly these, and nothing above should be
   * used to build a blind deck again.
   *
   * The problem this fixes is not resolution or framing, it is that the ten frames the
   * critic has been grading were never independent. They shared one map, one grass asset,
   * one helmet, one hour of one afternoon and one quality tier, and three of the ten pairs
   * were near-duplicates of each other — `establishing`/`wide` differ by 0.02 zoom,
   * `clash`/`melee` are the same follow target sixteen seconds apart, `raking`/`romanline`
   * both look along the Roman line. The Rome II pool has no such structure: ten plates from
   * ten battles. So a grader who identifies two of ours gets the other eight for free on
   * family resemblance, and reports 10/10 for a renderer that might only have failed twice.
   * Nothing about the harness's crop, encode or byte pass touches that.
   *
   * What varies here, deliberately, one axis at a time where possible:
   *
   *   map        six Campus Martius, four Pydna — different terrain, ground textures,
   *              vegetation and latitude. Pydna is 40.3N in June against Rome's 41.9N in
   *              March, so even at the same clock hour the sun sits elsewhere.
   *   hour       07:30 to 19:00 across the set, against the single 17:00 default that every
   *              graded frame before this shared. Low sun, high sun, and dusk.
   *   quality    `deck-rout` is shot at `high`, not ultra. Every graded frame in this
   *              project's history was ultra, so the deck has never contained an honest
   *              picture of what most players are actually looking at, and a tier nobody
   *              photographs is a tier nobody fixes.
   *
   *              It is `high` rather than `low`, and the reason is worth recording because
   *              `low` was tried first and was wrong. The tiers do not only change render
   *              settings: `maxSoldiers` is 1,600 at low and 3,200 at medium against an
   *              order of battle of 8,632. A low-tier frame therefore photographs a
   *              different battle — the shot came back with 1,189 men where ultra has
   *              8,632 — and headcount, not filtering, is what a grader would sort on. That
   *              is a confound dressed up as honesty. `high` caps at 10,000, so every man
   *              stays on the field, and it still turns the dial down properly: shadow maps
   *              at a quarter the area, grass density 1 against 1.5, and the pixel ratio at
   *              1.5 rather than 2.
   *   subject    one frame per scene family. No two frames here share a follow target.
   *
   * Anything with a `map` or `hour` costs a page load — see the grouping note below. Ten
   * frames land in eight loads, about four minutes.
   */
  'deck-line': {
    desc: 'DECK: behind the Roman line at first light, looking north at the host',
    follow: 'ownLine', zoom: 0.70, at: 1, hour: 7.5,
  },
  'deck-horde': {
    desc: 'DECK: into the Juthungi mass under a high sun — variety and disorder',
    follow: 'germanFront', zoom: 0.36, at: 2, hour: 12.0,
  },
  'deck-clash': {
    desc: 'DECK: the lines meeting, mid-afternoon',
    follow: 'contact', zoom: 0.30, at: 72, hour: 14.3,
  },
  'deck-cavalry': {
    desc: 'DECK: the cavalry wing sweeping the flank, late light',
    follow: 'cavalryUnit', zoom: 0.30, at: 70, hour: 16.4,
  },
  'deck-city': {
    desc: 'DECK: the Aurelian Wall with the city behind it',
    x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06, at: 2, hour: 9.8,
  },
  'deck-aftermath': {
    desc: 'DECK: late battle — corpses, routs, dust and blood on the ground',
    follow: 'corpses', zoom: 0.34, at: 190, hour: 16.4,
  },
  // Pydna: different ground, different vegetation, different latitude and season. Its own
  // default hour is 17:00 and its presets run 08:30 to 19:00.
  'deck-pydna-horizon': {
    // 16:00, not the 19:00 preset. At 19:00 the frame came back at a few percent luminance
    // with a blown sun blob on the skyline and nothing else legible — a frame a grader
    // sorts as "the dark one" without looking at the rendering, which is the same class of
    // mistake as leaving the HUD up.
    desc: 'DECK: Pydna in the late afternoon, low camera with sky and horizon',
    map: 'pydna', hour: 16.0,
    x: -420, z: -120, zoom: 0.12, yaw: Math.PI * 0.62, at: 2,
  },
  'deck-pydna-line': {
    desc: 'DECK: Pydna, telephoto along the front rank in the morning',
    map: 'pydna', hour: 8.5,
    follow: 'romanFront', zoom: 0.36, at: 2,
  },
  'deck-pydna-terrain': {
    desc: 'DECK: Pydna countryside at noon — terrain, vegetation and lighting alone',
    map: 'pydna', hour: 12.5,
    x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, at: 2,
  },
  'deck-rout': {
    // The honest non-ultra frame. Captured, not simulated: the engine builds a different
    // shadow cascade set and a different grass density at this tier, so downscaling an
    // ultra render would be a picture of something the game never draws.
    desc: 'DECK: wide view mid-collapse, shot at the HIGH quality tier',
    quality: 'high', hour: 16.2,
    x: 0, z: 60, zoom: 0.60, yaw: Math.PI * 0.82, at: 171,
  },

  /*
   * ---------------------------------------------------------------------------
   * `--set=ab1`: the paired blind instrument.
   * ---------------------------------------------------------------------------
   *
   * `--set=deck` shoots ten frames that go into a *pooled* deck — one shuffled line-up the
   * grader sorts wholesale. This set feeds a *paired* deck instead: each of our frames is
   * shown beside one Rome II press plate of the same subject and the grader is asked which
   * of the two is the real game. Pairing changes what the shot list has to do.
   *
   *   - **Subject is matched inside the pair, so subject cannot be the tell.** A pooled deck
   *     can afford a frame of the Tiber, because there is nothing to compare it to. A pair
   *     cannot: whatever our frame shows, the plate beside it must show the same thing, or
   *     the grader sorts on "one of these is a river and Rome II press shots are battles".
   *     So every entry here is chosen to have a counterpart in the press set — a line of
   *     battle, a melee, a march, a wall from outside, a parapet, cavalry, an aftermath.
   *   - **Cross-pair inference is still a leak.** Seven of our fourteen frames coming back
   *     under one identical sun, while fourteen press plates come from fourteen different
   *     battles, decodes the deck without looking at a single soldier. So the hour varies
   *     across the set exactly as it does in `deck-*`, and it costs a page load per value.
   *   - **Both maps and both scenarios.** Campus Martius in 271 and Carthage in 146, field
   *     and assault. Four worlds, so no family resemblance runs the length of our pool.
   *
   * The assault frames use `wall`, which resolves a camera against the live curtain the way
   * `tools/probe-siege.mjs` does — the rig has no elevation control, so getting an eye onto a
   * parapet means overriding the ground sampler for the duration of the shot. See `wall`
   * below.
   */

  // ---- Campus Martius, 271 AD ----------------------------------------------
  'ab-rome-line': {
    desc: 'AB: the Roman front rank at battle zoom, ranks receding obliquely',
    follow: 'romanFront', zoom: 0.34, at: 6, hour: 9.0,
  },
  'ab-rome-melee': {
    desc: 'AB: inside the melee at close zoom',
    follow: 'contact', zoom: 0.11, at: 96, hour: 15.0,
  },
  'ab-rome-march': {
    desc: 'AB: the legionary cohorts on the march, before contact',
    follow: 'romanFront', zoom: 0.22, at: 40, hour: 7.8,
  },
  'ab-rome-wall': {
    desc: 'AB: the Aurelian Wall from outside, mid-assault — towers, ladders, ram, host',
    scenario: 'assault', hour: 14.3, at: 170,
    wall: { bay: 2, stand: 90, lift: 20, zoom: 0.46, yaw: 'in', yawAdd: -0.55 },
  },
  'ab-rome-parapet': {
    desc: 'AB: men in the embrasures of the Aurelian parapet, shooting down',
    scenario: 'assault', hour: 11.0, at: 96,
    wall: { bay: -2, stand: 0.2, lift: 'walk+1.6', zoom: 0.19, yaw: 'along', yawAdd: Math.PI },
  },
  'ab-rome-cavalry': {
    desc: 'AB: the equites wing sweeping the flank',
    follow: 'cavalryUnit', zoom: 0.26, at: 70, hour: 16.6,
  },
  'ab-rome-aftermath': {
    desc: 'AB: the field after the break — corpses, routs, dust, blood',
    follow: 'corpses', zoom: 0.22, at: 200, hour: 16.0,
  },

  // ---- Carthage, spring 146 BC ---------------------------------------------
  // `opponent: 2` is `Faction.Carthage`, which is what puts a Punic order of battle on the
  // field and — under `assault`, because `CARTHAGE_PLAN.garrison` is Carthage — puts the
  // Romans on the outside of the wall for once.
  'ab-carth-line': {
    desc: 'AB: the Punic front rank at battle zoom, the city works behind',
    map: 'carthage', opponent: 2, follow: 'enemyFront', zoom: 0.28, at: 6, hour: 10.2,
  },
  'ab-carth-melee': {
    desc: 'AB: inside the melee at close zoom, Punic line',
    map: 'carthage', opponent: 2, follow: 'contact', zoom: 0.11, at: 96, hour: 13.4,
  },
  'ab-carth-march': {
    desc: 'AB: the Punic line advancing — Libyan, Iberian and Gallic blocks',
    map: 'carthage', opponent: 2, follow: 'enemyFront', zoom: 0.24, at: 40, hour: 8.6,
  },
  'ab-carth-wall': {
    desc: 'AB: the wall of Carthage from outside, mid-assault',
    map: 'carthage', opponent: 2, scenario: 'assault', hour: 15.2, at: 170,
    wall: { bay: 2, stand: 90, lift: 20, zoom: 0.46, yaw: 'in', yawAdd: -0.55 },
  },
  'ab-carth-parapet': {
    desc: 'AB: the Punic garrison in the embrasures of Carthage',
    map: 'carthage', opponent: 2, scenario: 'assault', hour: 12.2, at: 96,
    wall: { bay: -2, stand: 0.2, lift: 'walk+1.6', zoom: 0.19, yaw: 'along', yawAdd: Math.PI },
  },
  'ab-carth-elephants': {
    // Paired against the press set's own elephant plate, so "the one with the elephants" is
    // not the answer to that pair.
    desc: 'AB: the Punic elephant line advancing in front of the centre',
    map: 'carthage', opponent: 2, follow: 'unitType', unitType: 'war-elephants',
    zoom: 0.30, at: 44, hour: 16.0,
  },
  'ab-carth-wide': {
    desc: 'AB: the whole field before Carthage from high up, both hosts drawn up',
    map: 'carthage', opponent: 2, follow: 'ownLine', zoom: 0.62, at: 4, hour: 17.2,
  },

  /*
   * ---------------------------------------------------------------------------
   * `--set=ab2`: round two, with a matched capture policy.
   * ---------------------------------------------------------------------------
   *
   * Round one of the paired instrument returned 14/14 for three independent graders, and all
   * three raised the same two methodological faults about the *deck* rather than about the
   * renderer. Both are answered here, because a round that does not answer them cannot
   * distinguish "we fixed the rendering" from "the graders ran out of framing cues".
   *
   *   1. **Capture-policy leak.** Ours were gameplay grabs from a high tactical camera; the
   *      Rome II side is press and cinematic captures at ground level. One grader: "after
   *      four pairs I could have started picking on framing alone." Every field shot here
   *      therefore names an eye height, an aim height, a standoff and a field of view in
   *      metres and degrees — see the `cam` block in the page evaluate — chosen against the
   *      plate it is paired with. The reference set was measured for this: eleven of the
   *      fourteen eligible plates put the camera between 1.2 and 2.3 m with the horizon in
   *      the upper third, and the three that do not are the elevated siege frames, which the
   *      three assault shots here match instead.
   *   2. **One lighting setup.** Five of round one's fourteen came back under one low warm
   *      sun at roughly one azimuth — a learnable signature independent of any rendering
   *      tell. The hours below span 8.6 to 17.6 and no two are within twenty minutes, and
   *      four frames are overcast and one is rain, which round one had none of.
   *
   * **The standoffs are set by arithmetic, not by taste.** At a distance `d` with a vertical
   * field of view `F`, the focus plane spans `2 d tan(F/2)` metres, so a 1.75 m man occupies
   * `1.75 / (2 d tan(F/2))` of frame height. The reference plates put a mid-ground man at
   * roughly a third of the frame, which for these fields of view is six to ten metres, not
   * the thirteen to thirty this set was first written with. The first pass at these numbers
   * came back with a thin band of soldiers across the middle of an acre of empty grass — a
   * *worse* framing match than the tactical camera it replaced, because it had the reference's
   * eye height and none of its subject size. Depression is then set to put the horizon about
   * a third down from the top, which is where the reference plates keep it: with the frame
   * centred on the aim point, that is `atan((eye - aim) / dist) ~ 0.17 * F / 2`.
   *
   * The aim heights then follow from where the reference keeps its horizon. With the frame
   * centred on the aim point the true horizon sits at `0.5 - 0.5 tan(d) / tan(F/2)` of frame
   * height from the top, where `d = atan((eye - aim) / dist)`, so an entry that wants the
   * plates' upper-third horizon has to tilt *down* a few degrees and therefore aim at a point
   * near the ground. That reads oddly next to a 2 m eye height and it is simply what the
   * geometry requires: a level camera puts the horizon dead centre, which none of the
   * reference plates do. The two elevated overviews were the worst offenders in the first
   * pass — at 150 m over a 400 m standoff the horizon was *off the top of the frame*, which
   * is a bird's-eye plate and not the high oblique s2-03 and s2-19 actually are.
   *
   * The `eye >= aim + 0.2` constraint on every entry is not aesthetic. `RTSCamera.place`
   * refuses to put the eye closer than 1.7 m to the plane it thinks is the ground, and at
   * `zoom: 0` that plane sits `aim - 1.55` below the focus, so an entry that aims above its
   * own eye gets silently lifted. A frame that wants to look *up* at its subject does it by
   * standing lower, not by tilting.
   */

  // ---- Campus Martius, 271 AD ----------------------------------------------
  'ab2-rome-line': {
    // vs s2-04 (Pydna): packed ranks from just above helmet height, strongly compressed.
    desc: 'AB2: the Roman front rank from helmet height, telephoto down the line',
    follow: 'romanFront', at: 6, hour: 9.0, weather: 'clear',
    // Measured at 10 degrees off the sun without this, i.e. straight into it: the men are
    // backlit, their front faces are the shadowed ones and the upper half of the frame is one
    // flat cream. The hour cannot fix it — the Roman line faces north on this map, so its
    // front is away from the sun at every hour there is — so the camera swings instead.
    // 1.2 rad puts the sun at about 80 degrees, which is the cross-light the reference's own
    // march and warband plates are shot under and the best form modelling available here.
    yawAdd: 1.2,
    cam: { eye: 2.05, aim: 1.32, dist: 8, fov: 30 },
  },
  'ab2-rome-melee': {
    // vs s2-00: inside the fight, camera in the grass, level.
    desc: 'AB2: inside the melee at eye level',
    follow: 'contact', at: 96, hour: 15.0, weather: 'clear',
    /*
     * The one shot where standoff does not buy distance.
     *
     * `contact` resolves to the densest 40 m cell of a melee eight thousand men deep, so at
     * eye height the camera is *inside* the press however far back it is set: measured, 14 m
     * of standoff put the nearest man at 0.75 m and 17 m put him at 0.88. Three metres bought
     * thirteen centimetres. What came back was a shield filling the lower half of the frame
     * and no legible action behind it.
     *
     * The reference melee plates are shot at about this eye height, and their fights are
     * *loose* — men in pairs with ground between them — which is a property of their
     * simulation and not of their camera. Ours is a solid block, so the only lever left is to
     * put the lens above the helmets and look down into it. 2.55 m is a head taller than the
     * tallest man here, which is a cameraman on a box rather than a tactical map view, and it
     * is the closest match available without pretending our formations are theirs.
     */
    cam: { eye: 2.55, aim: 1.05, dist: 20, fov: 34 },
  },
  'ab2-rome-march': {
    // vs s2-13: a column on the march, camera at a bystander's height beside the road.
    desc: 'AB2: the cohorts on the march, from the side of the line',
    follow: 'romanFront', at: 40, hour: 11.5, weather: 'clear',
    cam: { eye: 1.90, aim: 1.22, dist: 6.5, fov: 34 },
  },
  'ab2-rome-cavalry': {
    // vs s2-15: cataphracts three-quarter front, the camera below the riders.
    desc: 'AB2: the equites wing, from below the riders',
    follow: 'cavalryUnit', at: 70, hour: 13.0, weather: 'clear',
    cam: { eye: 1.55, aim: 0.82, dist: 8, fov: 30 },
  },
  'ab2-rome-aftermath': {
    // vs s2-02: a killing at close range, camera low. `contact` rather than `corpses`:
    // round one pointed this at the corpse centroid and photographed a heap of bodies in an
    // empty field, against a plate of three *living* men with one going down between them.
    // Two graders flagged the pair as not subject-matched and they were right. At t+190 the
    // ground is already littered, so framing the fight gets the bodies for nothing.
    desc: 'AB2: still fighting over ground already littered, low and close',
    // t+140, not t+190: by 190 the lines had come apart on this map and `contact` framed men
    // standing about in grass rather than a fight. The ground is already littered at 140.
    follow: 'contact', at: 140, hour: 12.8, weather: 'overcast',
    // 16 m and a higher eye. t+140 is a denser fight than t+190 was, so the same twelve
    // metres that framed men standing about at 190 put a shield 0.46 m from the lens at 140.
    cam: { eye: 1.95, aim: 0.95, dist: 16, fov: 38 },
  },
  'ab2-rome-wall': {
    // vs s2-17: 2.35:1 siege plate, tower against a curtain, camera up and well back.
    desc: 'AB2: the Aurelian Wall from outside, mid-assault, elevated and long',
    scenario: 'assault', hour: 14.3, at: 170, weather: 'clear',
    wall: { bay: 2, stand: 10, lift: 0, yaw: 'in', yawAdd: 0.55 },
    // 9 m, not 16. At sixteen metres the eye clears a twelve-metre curtain from eighty metres
    // out and photographs the rooftops behind it — a picture of the city, not of the assault
    // on its wall. Below the parapet the masonry is the subject and the ranks are in front of
    // it, which is what s2-17 shows. The yaw also swings off a sun measured at 14.7 degrees.
    cam: { eye: 9, aim: 6, dist: 60, fov: 26 },
  },
  'ab2-rome-parapet': {
    // vs s2-12: men on a high work, looking out and down over the city.
    desc: 'AB2: the Aurelian parapet, looking down the walk and out over the city',
    scenario: 'assault', hour: 11.0, at: 96, weather: 'clear',
    wall: { bay: -2, stand: 0.2, lift: 0, yaw: 'along', yawAdd: Math.PI },
    cam: { base: 'walk', eye: 1.70, aim: -2.5, dist: 34, fov: 38 },
  },

  // ---- Carthage, spring 146 BC ---------------------------------------------
  'ab2-carth-line': {
    // vs s2-09: front rank of a spear line, camera at chest height, city behind.
    desc: 'AB2: the Punic front rank at chest height, the works behind',
    map: 'carthage', opponent: 2, follow: 'enemyFront', at: 6, hour: 10.2, weather: 'overcast',
    // A Punic line is one or two ranks deep, so a camera square to its face photographs
    // scattered men in a field. s2-09 looks *along* a rank, which is how a thin line fills a
    // frame, so this swings a radian off square and comes in to six metres.
    yawAdd: 1.0,
    // 9 m, not 6: at six the swing put a man's shoulder 1.08 m from the lens.
    cam: { eye: 1.55, aim: 0.61, dist: 9, fov: 34 },
  },
  'ab2-carth-melee': {
    // vs s2-01: close melee in tall grass, camera almost on the ground.
    desc: 'AB2: inside the Punic melee, camera almost in the grass',
    /*
     * `unitType`, not `contact`, and this is the same class of fault as the `enemyFront` one.
     *
     * `contact` takes the densest cell of *anything* fighting, and on Carthage at t+96 that
     * is a cavalry clash on a flank — so the frame came back as a wall of horses against a
     * plate of infantry in tall grass. The selector was doing exactly what it says; what it
     * says is not "an infantry melee". Naming the unit makes the subject a property of the
     * shot table rather than of whichever fight happens to be busiest.
     */
    map: 'carthage', opponent: 2, follow: 'unitType', unitType: 'libyan-spearmen',
    at: 110, hour: 13.4, weather: 'overcast',
    /*
     * And the opposite correction to `ab2-rome-melee`, which is worth writing down because
     * it is the argument against tuning the two together.
     *
     * The same standoff that buries the camera in a legionary press leaves it well outside a
     * Punic one: measured, 16 m put the nearest man at **11.59 m** here against 0.88 m there.
     * A Punic line is Libyan spearmen, Iberian scutarii and Gallic warbands at different
     * frontages and different depths, and it simply does not pack the way a cohort does. So
     * this one comes *in* to 8 m and keeps its low eye, while the Roman one goes up over the
     * helmets. Two shots of the same nominal subject, corrected in opposite directions, from
     * one measurement each.
     */
    cam: { eye: 1.75, aim: 0.85, dist: 11, fov: 36 },
  },
  'ab2-carth-march': {
    // vs s2-16: a barbarian mass advancing, close, camera low among them.
    desc: 'AB2: the Punic line advancing, close and low',
    map: 'carthage', opponent: 2, follow: 'enemyFront', at: 40, hour: 8.6, weather: 'clear',
    cam: { eye: 1.70, aim: 0.97, dist: 7, fov: 34 },
  },
  'ab2-carth-elephants': {
    // vs s2-08: elephants behind a spear line at dusk. Paired so "the one with the
    // elephants" is not the answer to that pair.
    desc: 'AB2: the Punic elephant line at dusk, from in front of the spears',
    map: 'carthage', opponent: 2, follow: 'unitType', unitType: 'war-elephants',
    at: 44, hour: 17.6, weather: 'clear',
    cam: { eye: 2.25, aim: 0.97, dist: 14, fov: 30 },
  },
  'ab2-carth-wall': {
    // vs s2-19: a city being stormed, seen from well above, fires and smoke.
    desc: 'AB2: Carthage being stormed, from high above the curtain',
    map: 'carthage', opponent: 2, scenario: 'assault', hour: 15.2, at: 170, weather: 'overcast',
    wall: { bay: 2, stand: 40, lift: 0, yaw: 'in', yawAdd: -0.35 },
    // 200 m out at 45 m up, not 520 at 110. The far version put the whole city in a strip
    // across the middle of an empty plain; s2-19 fills its frame with roofs. Depression stays
    // at 11 degrees so the horizon holds the 0.15 the plate keeps it at.
    cam: { eye: 45, aim: 5, dist: 200, fov: 32 },
  },
  'ab2-carth-parapet': {
    // vs s2-14: a high vantage over a valley with armies below. Rain, which round one
    // had none of anywhere.
    desc: 'AB2: the Punic garrison on the crest, the ground far below, in rain',
    map: 'carthage', opponent: 2, scenario: 'assault', hour: 12.2, at: 96, weather: 'rain',
    wall: { bay: -2, stand: 0.2, lift: 0, yaw: 'along', yawAdd: Math.PI },
    cam: { base: 'crest', eye: 1.70, aim: -9.0, dist: 46, fov: 34 },
  },
  'ab2-carth-wide': {
    // vs s2-03: both hosts drawn up, seen from high and far, horizon high in frame.
    desc: 'AB2: the whole field before Carthage, both hosts drawn up',
    map: 'carthage', opponent: 2, follow: 'ownLine', at: 4, hour: 15.4, weather: 'clear',
    // 280 m, not 480. s2-03 is a *high oblique of formations*, and its blocks are legible as
    // blocks; at 480 m ours were specks on an empty plain, which is a picture of ground.
    cam: { eye: 36, aim: 0, dist: 180, fov: 34 },
  },
};

/** Named shot sets. `--set=deck` is the only pool a blind round should be built from. */
const SETS = {
  deck: Object.keys(SHOTS).filter((k) => k.startsWith('deck-')),
  /** The paired blind instrument, round one. See the block comment above `ab-rome-line`. */
  ab1: Object.keys(SHOTS).filter((k) => k.startsWith('ab-') && !k.startsWith('ab2-')),
  /** Round two, with a matched capture policy. See the block comment above `ab2-rome-line`. */
  ab2: Object.keys(SHOTS).filter((k) => k.startsWith('ab2-')),
  all: Object.keys(SHOTS).filter((k) => !k.startsWith('deck-') && !k.startsWith('ab-')),
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

if (args.has('list')) {
  for (const [k, v] of Object.entries(SHOTS)) {
    const world = [v.map ?? '', v.hour !== undefined ? `${v.hour}h` : '', v.quality ?? ''].filter(Boolean).join(' ');
    console.log(`${k.padEnd(20)} t+${String(v.at).padStart(3)}s  ${world.padEnd(16)} ${v.desc}`);
  }
  console.log(`\nsets: ${Object.entries(SETS).map(([k, v]) => `${k} (${v.length})`).join(', ')}`);
  process.exit(0);
}

const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots');
const QUALITY = args.get('quality') ?? 'ultra';
const requested = args.get('shots')
  ? String(args.get('shots')).split(',').map((s) => s.trim()).filter(Boolean)
  : (SETS[args.get('set') ?? 'all'] ?? null);
if (!requested) {
  console.error(`Unknown set "${args.get('set')}". Available: ${Object.keys(SETS).join(', ')}`);
  process.exit(2);
}
const PORT = Number(args.get('port') ?? 5199);
/** Device pixel ratio. 1 is what every historical plate was shot at — see the note at `newPage`. */
const DPR = Number(args.get('dpr') ?? 1);
/*
 * The HUD is OFF by default, and turning it on costs you a keystroke.
 *
 * It used to be the other way round: `--nohud` was opt-in, and `tools/blind-compare.mjs`
 * never mentioned it. That is leak six. A lighting deck was void because the flag was
 * omitted, and all three of its graders sorted the deck on the faction-strength bar in the
 * top plaque — a perfect tell with no relationship whatever to render quality. Five earlier
 * leaks (wordmark, EXIF, mislabelled key, file size, quantisation tables) were each closed
 * by somebody resolving to be careful, and a sixth got in anyway. So the default is inverted
 * rather than documented: the careless invocation now produces the *safe* artefact.
 *
 * What the HUD puts in a frame, measured on the 18-shot pass at `95b7f5d`: the top plaque
 * (ROME / JUTHUNGI, gold eagles, a red-and-blue advantage bar, the phase name, transport
 * buttons and a settings cog), a top-left debug readout that prints `5.6 ms/f 179 fps
 * draws 143 tris 9131k men 8632 units 35 sel 0 1x t+2s` in plain text, and a right-hand
 * event feed. Any one of them decodes the deck.
 *
 * Pass `--hud` if you are photographing the interface itself. Whichever way it goes it is
 * printed on stdout and recorded in `report.json`, and `blind-compare.mjs` refuses any deck
 * whose frames came from a `--hud` pass or from a directory with no such record at all.
 * `--nohud` is still accepted, and is now a no-op, so existing invocations keep working.
 */
const SHOW_HUD = args.has('hud') && !args.has('nohud');
// Parallel agents each pass their own --port so they never fight over one server.
// Leaving it running is opt-in, because an orphaned vite holds the port for everyone.
const KEEP_SERVER = args.has('keep');

for (const s of requested) {
  if (!SHOTS[s]) {
    console.error(`Unknown shot "${s}". Available: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

let server = null;
async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  if (await waitForServer(base, 1200)) {
    console.log(`• reusing dev server already on ${PORT}`);
    return base;
  }
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', TC_NO_HMR: '1' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  if (!(await waitForServer(base, 60000))) {
    console.error('vite failed to start:\n' + serverLog.slice(-4000));
    throw new Error('dev server did not come up');
  }
  return base;
}

function stopServer() {
  if (server && !KEEP_SERVER) {
    server.kill('SIGTERM');
    server = null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = [];
let failed = 0;
let browser = null;
/** 'hidden' | 'absent' | 'refused' | 'n/a' — recorded, because a silent failure here is a leak. */
let overlayHidden = 'n/a';

try {
  const base = await startServer();
  await mkdir(OUT, { recursive: true });

  browser = await chromium.launch({
    args: [
      // Software rasterisation still gives a real GL context; SwiftShader is
      // deterministic across machines, which matters for A/B comparison.
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
    ],
  });

  /*
   * Device pixel ratio, and the reason this is a flag rather than a constant.
   *
   * `QUALITY_PRESETS.ultra.maxPixelRatio` is 2, but the engine takes
   * `min(maxPixelRatio, window.devicePixelRatio)` and a headless Chromium reports 1. So
   * **every graded plate this project has ever produced was rendered at one sample per
   * pixel**, while a player on the retina display this is developed on gets two. The blind
   * deck has been photographing a configuration the product does not ship, and in the
   * direction that flatters the reference: one sample per pixel is exactly the condition
   * under which the aliasing separator is worst.
   *
   * The default stays 1 so that round 22 is comparable with the twenty-one before it — a
   * measurement that changes two things at once measures neither. `--dpr=2` shoots the
   * other arm, and the value is recorded in `report.json` so a deck can never again be
   * silently one thing or the other. A dpr-2 pass writes a WxH screenshot at the same
   * nominal size; the extra samples are spent inside the renderer, not on the file.
   */
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  /*
   * ---------------------------------------------------------------------------
   * Scene groups: one page load per distinct world.
   * ---------------------------------------------------------------------------
   *
   * Every graded frame this project has ever produced came off one map, at one hour, in
   * one season, at one quality tier. That is not ten trials, it is one trial photographed
   * ten times, and it inflates a grader's apparent accuracy: identify two or three of ours
   * and the rest fall by family resemblance — same grass, same helmet, same low sun, same
   * hazy distance. The near-duplicate pairs make it worse and they are on our side only,
   * because the ten press plates come from ten different battles.
   *
   * `map`, `hour`, `scenario` and `quality` are fixed before the engine is constructed —
   * the tier sizes the soldier pool and the shadow cascades at `init`, and the map is
   * published to `src/maps` by `resolveConfig` before `TerrainSystem.init` runs — so they
   * cannot be changed on a live page. Shots carrying any of them are therefore grouped and
   * each group gets its own load. A shot table with none of them (which is every shot
   * defined above) collapses to exactly one group and one page load, so nothing changes
   * for the six other tools and agents that drive this file.
   *
   * `hour` alone *is* live-settable — `SkySystem.setTimeOfDay` re-derives the sun direction
   * from the real equatorial-to-horizontal transform and `LightingSystem` reads
   * `sky.sunDirection` every frame — but it is folded into the group key anyway. Doing it
   * at load means the HDRI probe and the sky preset are chosen for that hour rather than
   * blended onto a rig built for another one.
   */
  // `opponent` joins the key for the same reason `map` does: it is read by `deployBattle`
  // when the armies are placed, before the first frame, and cannot be changed on a live page.
  /*
   * `weather` joins the key even though it is live-settable, and that is deliberate.
   *
   * Rain and ground mist are *accumulated* — `Weather.emit` spawns into the shared particle
   * ring at a rate, so a sky switched to `rain` one frame before the shutter photographs an
   * empty sky with four raindrops in it. Setting it at load and letting the fast-forward to
   * `at` fill the ring is the only way the frame shows the weather it claims. The cost is a
   * page load per distinct sky, which is the same trade `hour` already makes and for a
   * closely related reason.
   */
  const groupKey = (s) => JSON.stringify([
    s.map ?? null, s.hour ?? null, s.scenario ?? null, s.quality ?? QUALITY, s.opponent ?? null,
    s.weather ?? null,
  ]);
  const groups = new Map();
  for (const name of requested) {
    const k = groupKey(SHOTS[name]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(name);
  }

  /**
   * `?battle=` is base64url of a partial config; `sanitiseConfig` refills the rest. The
   * same encoding `MainMenu.encodeConfig` writes and `tools/shoot-carthage.mjs` uses.
   */
  const battleToken = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let gl = null;
  async function loadScene(shot) {
    const cfg = {};
    if (shot.map) cfg.map = shot.map;
    if (shot.hour !== undefined) cfg.timeOfDay = shot.hour;
    if (shot.scenario) cfg.scenario = shot.scenario;
    // 2 is `Faction.Carthage`; `sanitiseConfig` maps anything else back to the Germanic
    // opponent, so an unrecognised value degrades to the shipped battle rather than failing.
    if (shot.opponent !== undefined) cfg.opponent = shot.opponent;
    // `--battle=<token>` still grades a configured order of battle rather than the
    // historical one, and wins over the per-shot fields when both are given: it is the
    // caller being explicit about the whole config.
    const battleArg = args.get('battle')
      ? `&battle=${args.get('battle')}`
      : (Object.keys(cfg).length ? `&battle=${battleToken(cfg)}` : '');
    const q = shot.quality ?? QUALITY;
    const url = `${base}/?harness=1&quality=${q}&w=${W}&h=${H}${battleArg}`;
    console.log(`• loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // A `{ timeout }` object in the *argument* slot is silently treated as page data and
    // the wait falls back to the 30 s default — nineteen tools in this repo had that bug.
    // Third positional, always.
    /*
     * 420 s, not 180. Carthage builds a second city plan and a second curtain at boot and
     * `tools/probe-siege.mjs` already had to raise its own deadline for exactly this: past
     * three minutes the harness stopped reporting what it was measuring and started
     * reporting `Timeout 180000ms exceeded`, which reads as "the scene is broken" and is
     * not. Generous, and the elapsed time is printed so a genuine hang is still visible.
     */
    const bootT0 = Date.now();
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
    console.log(`• world ready in ${((Date.now() - bootT0) / 1000).toFixed(1)} s`);

    if (!gl) {
      // Confirm we actually got a hardware-ish GL context, not a stub. Once is enough.
      gl = await page.evaluate(() => {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl2');
        if (!g) return { ok: false };
        const dbg = g.getExtension('WEBGL_debug_renderer_info');
        return {
          ok: true,
          renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
          vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
        };
      });
      console.log(`• webgl2: ${gl.ok ? `${gl.vendor} / ${gl.renderer}` : 'UNAVAILABLE'}`);
      if (!gl.ok) throw new Error('WebGL2 unavailable in the harness browser');
    }

    /*
     * Weather, applied to the live page.
     *
     * Round one's second methodological fault, raised by all three graders: **our frames
     * cluster on one lighting setup** — low warm sun, long raking shadows, roughly one
     * azimuth, across five of the fourteen. That is a learnable signature with no
     * relationship to rendering, and it is the same class of mistake as fourteen frames off
     * one map. The hour already varies; the sky did not, because nothing in this file had
     * ever asked for anything but `clear`.
     *
     * `setWeather` is live-settable — it swaps a preset that drives wind, dust wetness, mist
     * and rain rate, none of which are baked at init — so unlike `map` and `scenario` it
     * costs no page load and does not join the group key.
     */
    if (shot.weather) {
      const got = await page.evaluate((w) => {
        const vfx = window.__game?.engine?.context?.tryGet?.('vfx');
        if (!vfx || typeof vfx.setWeather !== 'function') return null;
        vfx.setWeather(w);
        return vfx.weatherKind;
      }, shot.weather);
      if (got === null) throw new Error('vfx subsystem has no setWeather; cannot honour a per-shot weather');
      if (got !== shot.weather) throw new Error(`weather ${shot.weather} was not applied (vfx reports ${got})`);
    }

    // The hour is applied again on the live page as well as through the token, because
    // `sanitiseConfig` is entitled to reject a value the token asked for and a silently
    // ignored hour would put two frames in the deck under the same sun.
    if (shot.hour !== undefined) {
      const got = await page.evaluate((h) => {
        const sky = window.__game?.engine?.context?.tryGet?.('sky');
        if (!sky || typeof sky.setTimeOfDay !== 'function') return null;
        sky.setTimeOfDay(h);
        return sky.timeOfDay;
      }, shot.hour);
      if (got === null) throw new Error('sky subsystem has no setTimeOfDay; cannot honour a per-shot hour');
      if (Math.abs(got - shot.hour) > 0.01) throw new Error(`hour ${shot.hour} was not applied (sky reports ${got})`);
    }
    await applyHudPolicy();
  }

  async function applyHudPolicy() {
  if (!SHOW_HUD) {
    // Belt and braces: hide the HUD root outright, and re-hide it before every shot in
    // case a subsystem re-creates or unhides its own nodes.
    await page.addStyleTag({
      content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
    });
    /*
     * A DOM strip does not remove *world-space* interface, and this harness has never
     * accounted for that. `WorldOverlay` is a THREE.Group added straight to the scene —
     * selection footprints, facing arrows, order paths, the right-drag formation ghost —
     * so `#hud-root { display: none }` leaves every one of them rendering. Nothing is
     * selected under `?autoplay=1`, which is why it has never shown up in a graded frame,
     * and which is exactly the kind of accident that stops being true one commit later.
     * TypeScript's `private` is compile-time only, so the group is reachable at runtime.
     */
    overlayHidden = await page.evaluate(() => {
      const hud = window.__game?.engine?.context?.tryGet?.('hud');
      const ov = hud && hud.overlay;
      if (!ov) return 'absent';
      try { ov.visible = false; return ov.visible === false ? 'hidden' : 'refused'; }
      catch { return 'refused'; }
    });
    console.log(`• HUD off (default). DOM stripped, world overlay ${overlayHidden}.`);
  } else {
    console.log('• --hud: INTERFACE VISIBLE. These frames must never enter a blind deck.');
  }
  }

  // Shoot in ascending sim time within each group, so we only ever fast-forward.
  const ordered = [...groups.values()].flatMap((names) => [...names].sort((a, b) => SHOTS[a].at - SHOTS[b].at));
  let loadedKey = null;

  for (const name of ordered) {
    const shot = SHOTS[name];
    const t0 = Date.now();
    try {
      // Inside the try, so a group whose world fails to build costs that group and not the
      // rest of the pass. `loadedKey` is only advanced on success, so the next shot in a
      // broken group retries rather than shooting whatever happens to be on screen.
      const k = groupKey(shot);
      if (k !== loadedKey) { await loadScene(shot); loadedKey = k; }
      const info = await page.evaluate(
        async ({ s }) => {
          const g = window.__game;
          // Advance in fixed 0.5 s steps rather than one variable jump to the target.
          // `advance(n)` divides n into frames, so the number and size of steps depended
          // on how far the previous shot had already got — which meant the same shot
          // reached a *different* battle state depending on which other shots were
          // requested alongside it. Two runs of `aftermath` reached 6,329 and 6,892 men.
          // A fixed grid makes any subset of shots follow the same path.
          const STEP = 0.5;
          while (g.simTime() < s.at - 1e-6) {
            g.advance(Math.min(STEP, s.at - g.simTime()));
          }

          // Resolve an auto-framed shot against the live battle. Hand-picked focus
          // points drift out of date every time the AI or the terrain changes where the
          // armies choose to meet, which repeatedly produced beautiful photographs of
          // empty grass.
          let fx = s.x, fz = s.z, fyaw = s.yaw;
          let waterDebug = null;
          if (s.follow) {
            const b = g.battle;
            const p = b.pool;
            let sx = 0, sz = 0, n = 0;
            const cells = new Map();
            /*
             * Faction centroids, used to look along the axis between the two armies.
             *
             * Three slots, not two, and this is a fix rather than a tidy-up. `Faction` runs
             * Rome 0, Germanic 1, **Carthage 2**, so on a Punic order of battle every man
             * wrote to `cx[2]` of a two-element array: `undefined + x` is `NaN`, `fx` came
             * out `NaN`, and `setCamera(NaN, NaN, ...)` parked the rig at the origin. Every
             * auto-framed shot of a Carthaginian army was therefore a photograph of
             * whatever happens to be at (0, 0). `tools/shoot-carthage.mjs` exists partly
             * because of this and says so in its header.
             */
            const cx = [0, 0, 0], cz = [0, 0, 0], cn = [0, 0, 0];

            for (let i = 0; i < p.count; i++) {
              const st = p.state[i];
              const f = p.faction[i];
              if (st !== 11 && st !== 10) { cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++; }
              let take = false;
              if (s.follow === 'contact') take = st === 4;            // Fighting
              else if (s.follow === 'corpses') take = st === 11 || st === 10;
              if (take) {
                sx += p.x[i]; sz += p.z[i]; n++;
                // Also bucket into a coarse grid, because a battle usually has more than
                // one contact: the cavalry meet on a flank well before the main lines do,
                // and the centroid of two separate fights lands in the empty ground
                // between them. The densest cell is the fight worth photographing.
                const gx = Math.floor((p.x[i] + 1400) / 40);
                const gz = Math.floor((p.z[i] + 1400) / 40);
                const key = gz * 128 + gx;
                const cell = cells.get(key);
                if (cell) { cell.x += p.x[i]; cell.z += p.z[i]; cell.n++; }
                else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
              }
            }

            /*
             * Which faction is the enemy, resolved from the field rather than assumed to be 1.
             *
             * Rome is always 0 here (`deployBattle` puts the player there on every scenario
             * this harness shoots). The opponent is whichever *other* faction actually has
             * men on the ground, which is 1 on the shipped battle and 2 on a Punic one.
             */
            const foe = cn[2] > cn[1] ? 2 : 1;

            if (s.follow === 'ownLine') {
              // Centroid of the player faction's living men, and of the enemy's, so the
              // camera can sit behind one and aim along the axis at the other.
              const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
              const bx = cn[foe] ? cx[foe] / cn[foe] : 0, bz = cn[foe] ? cz[foe] / cn[foe] : 0;
              // Focus on our own line. The orbit then puts the eye behind it, so the whole
              // enemy host falls beyond the focus instead of behind the camera.
              fx = ax; fz = az;
              fyaw = Math.atan2(bx - ax, bz - az);
              n = -1;
            }

            // `enemyFront` is `germanFront` with the faction resolved from the field, so the
            // same shot definition frames a warband on the Campus Martius and a Libyan
            // spear block in front of Carthage.
            if (n === 0 && (s.follow === 'romanFront' || s.follow === 'germanFront'
                            || s.follow === 'enemyFront')) {
              // Frame ONE front-line infantry unit, not the army's centroid. Averaging
              // rank 0 across a 660 m frontage plus the second line and the archers put
              // the focus in open ground between the lines, with the nearest cohort in a
              // corner. A single block fills the frame and is what the shot is for.
              const want = s.follow === 'romanFront' ? 0 : foe;
              let bestLine = null;
              let bestLight = null;
              for (const u of b.units) {
                if (u.destroyed || u.faction !== want || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                // Heavy infantry only. The rule "nearest the enemy" otherwise picks the
                // urban cohorts refusing the flanks, since they sit a few metres forward
                // of the main line — and the legionary cohort is the unit whose kit this
                // shot exists to show.
                /*
                 * Heavy infantry for Rome; for the enemy, its own line class.
                 *
                 * The Juthungi warband is `light-infantry` and the rule was written for it.
                 * The Punic line — Libyan spearmen, Iberian scutarii, the Sacred Band — is
                 * **`spear-infantry`**, and the previous version of this comment asserted it
                 * was `heavy-infantry`. It is not, and `roster.ts` has said so all along. So
                 * the fixed rule still matched nothing on the Punic line and the shot fell
                 * through to whichever skirmisher happened to be frontmost: `ab2-carth-line`
                 * came back as scattered Iberian caetrati in an open field against a plate of
                 * a packed sarissa hedge, and every number about it was in band.
                 *
                 * A guess about a unit class, written into a comment as though it were a
                 * measurement, survived one round of being "fixed" because the fix was checked
                 * against the comment rather than against the roster.
                 *
                 * And widening the class list was still not enough, which is the second half
                 * of the lesson. "Frontmost of the accepted classes" picks a *skirmisher*,
                 * because skirmishers are deployed in front of the line — that is what they
                 * are for. So the accepted set is now ranked rather than flat: the line
                 * classes are preferred outright and light infantry is a fallback for a host
                 * that has no line, which is the Juthungi case the original rule was written
                 * for. Two candidates are tracked, and the skirmisher is only used if the
                 * other is empty.
                 */
                const isLine = want === 0
                  ? cls === 'heavy-infantry'
                  : (cls === 'heavy-infantry' || cls === 'spear-infantry');
                const isFallback = want !== 0 && cls === 'light-infantry';
                if (!isLine && !isFallback) continue;
                // "Frontmost" = nearest the enemy. Rome faces -Z, the Juthungi face +Z.
                const ahead = (a, c) => !c || (want === 0 ? a.z < c.z : a.z > c.z);
                if (isLine) { if (ahead(u, bestLine)) bestLine = u; }
                else if (ahead(u, bestLight)) bestLight = u;
              }
              const best = bestLine ?? bestLight;
              if (best) {
                fx = best.x;
                fz = best.z;
                // A unit's front faces along `facing`, so put the camera on that side and
                // look back at it, swung 0.6 rad off square for an oblique read of the
                // ranks rather than a flat elevation.
                fyaw = best.facing + Math.PI + 0.6;
                n = -1;
              }
            }

            if (s.follow === 'water') {
              // Walk the terrain across the map at this z and find the open water: the span
              // where the ground sits below the river's surface. Derived from the live
              // heightfield, so retuning the meander cannot leave this shot photographing
              // a dry field again.
              const terrain = g.engine.context.tryGet('terrain');
              const level = terrain?.waterLevel;
              if (terrain && typeof level === 'number' && typeof terrain.heightAt === 'function') {
                // Widest span of x at this z where the ground sits below the water surface.
                // `start` is null when no run is open: a numeric sentinel like -1 is wrong
                // here because world x is itself negative on this side of the map.
                const widestWetSpan = (z) => {
                  let bestA = null, bestB = null, start = null;
                  const close = (end) => {
                    if (start === null) return;
                    if (bestA === null || end - start > bestB - bestA) { bestA = start; bestB = end; }
                    start = null;
                  };
                  for (let x = -1380; x <= 1380; x += 4) {
                    if (terrain.heightAt(x, z) < level) { if (start === null) start = x; }
                    else close(x);
                  }
                  close(1380);
                  return bestA === null ? null : { a: bestA, b: bestB, centre: (bestA + bestB) / 2 };
                };
                const here = widestWetSpan(s.z);
                if (here) {
                  // Channel bearing from the wet centre 60 m up- and downstream, so the yaw
                  // is oblique to the water rather than square to the map axes.
                  const up = widestWetSpan(s.z + 60)?.centre ?? here.centre;
                  const down = widestWetSpan(s.z - 60)?.centre ?? here.centre;
                  fx = here.centre;
                  fz = s.z;
                  fyaw = Math.atan2(up - down, 120) + (s.yawOffset ?? 0.6);
                  waterDebug = { z: s.z, span: [here.a, here.b], width: here.b - here.a, centre: here.centre };
                  n = -1;
                } else {
                  waterDebug = { z: s.z, span: null, note: 'no ground below waterLevel on this line' };
                }
              } else {
                waterDebug = { note: 'terrain subsystem or waterLevel unavailable' };
              }
            }

            if (n === 0 && s.follow === 'wall') {
              // Frame a real wall bay rather than a guessed coordinate. The curtain
              // follows the hill crest, so its z varies by 130 m across the map and a
              // hardcoded point lands on open ground as easily as on masonry.
              const city = g.engine.context.tryGet('city');
              const segs = city?.getWallSegments?.() ?? [];
              if (segs.length) {
                // Pick a bay left of the gate: far enough along the curtain that several
                // towers recede into the distance behind it.
                const seg = segs[Math.max(0, Math.floor(segs.length * 0.3))];
                // Focus on the masonry itself, lifted to mid-height so the camera is not
                // pitched into the grass, and look at the curtain obliquely rather than
                // along it: a pure end-on view is mostly foreshortened tower, while ~35
                // degrees off the wall axis shows the face, the courses and the towers
                // receding at once.
                fx = (seg.x1 + seg.x2) / 2;
                fz = (seg.z1 + seg.z2) / 2 - 6;
                fyaw = Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1) + 0.62;
                n = -1; // signal: focus already resolved, skip the centroid paths
              }
            }

            // The largest living unit of one named type. Exists for the elephants, which are
            // neither `heavy-cavalry` nor infantry and so are reachable by no other selector
            // in this table.
            if (s.follow === 'unitType') {
              let best = null;
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                if (b.typeOf(u).id !== s.unitType) continue;
                if (!best || u.alive > best.alive) best = u;
              }
              if (best) {
                fx = best.x;
                fz = best.z;
                fyaw = best.facing + Math.PI + 0.35;
                n = -1;
              }
            }

            if (s.follow === 'cavalryUnit') {
              // Biggest living mounted unit, and look at its front obliquely.
              let best = null;
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
                if (!best || u.alive > best.alive) best = u;
              }
              if (best) {
                fx = best.x;
                fz = best.z;
                fyaw = best.facing + Math.PI + 0.7;
                n = -1;
              }
            }

            if (n === 0 && s.follow === 'cavalry') {
              // Centroid of the mounted units still in the fight.
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
                sx += u.x * u.alive; sz += u.z * u.alive; n += u.alive;
              }
            }

            if (n === -1) { /* already resolved above */ }
            else if (cells.size > 0) {
              // Take the densest 40 m cell and use ITS OWN centroid. Averaging it with its
              // neighbours was fine when the battle was one short clash, but now that it
              // lasts minutes and spreads along a 600 m front there are several contact
              // clusters, and blending the best cell with its neighbours pulled the focus
              // into the empty ground between two of them.
              let bestKey = -1, bestN = 0;
              for (const [k, c] of cells) if (c.n > bestN) { bestN = c.n; bestKey = k; }
              const best = cells.get(bestKey);
              fx = best.x / best.n; fz = best.z / best.n;
            }
            else if (n > 0) { fx = sx / n; fz = sz / n; }
            else {
              // Nothing matched (too early, or everyone already dead): fall back to the
              // midpoint between the two armies rather than to a stale constant.
              const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
              const bx = cn[foe] ? cx[foe] / cn[foe] : 0, bz = cn[foe] ? cz[foe] / cn[foe] : 0;
              fx = (ax + bx) / 2; fz = (az + bz) / 2;
            }

            // Look along the axis between the armies, swung 55 degrees off so the shot is
            // oblique to the line of battle rather than straight down it.
            if (n !== -1 && cn[0] && cn[foe]) {
              const ax = cx[0] / cn[0], az = cz[0] / cn[0];
              const bx = cx[foe] / cn[foe], bz = cz[foe] / cn[foe];
              fyaw = Math.atan2(bx - ax, bz - az) + 0.96;
            }
          }
          /*
           * ---------------------------------------------------------------------------
           * `wall`: a camera resolved against the live curtain.
           * ---------------------------------------------------------------------------
           *
           * Ported from `tools/probe-siege.mjs`, which owns the siege cameras and worked
           * this out first. Two things make a wall shot different from every other shot in
           * this file:
           *
           *   - **The wall is generated, so a world coordinate is a guess with a shelf
           *     life.** The curtain follows the hill crest and the gate is where the road
           *     crosses it, not at the centre of any bay. So a shot names a *bay offset from
           *     the gate* and a *standoff along that bay's own outward normal*, and the page
           *     resolves both against `city.getGarrisonBays()` at shoot time.
           *   - **The rig has no elevation control.** `jumpTo` puts the focus on
           *     `heightAt(focus)` and booms the eye up and back from there, so every camera
           *     in this file looks *down* at a point on the ground. Aim at a point 13 m out
           *     from a curtain and you photograph grass with masonry along the top edge; the
           *     parapet is 8-12 m above the focus and out of frame. The only lever is the
           *     ground sampler itself, so it is replaced with a constant for the duration of
           *     the shot and restored immediately after — `lift: 'crest'` puts the eye level
           *     with the battlement, `'walk'` with the wall-walk, a number is metres above
           *     the terrain at the focus.
           *
           * Restoring matters here in a way it does not in probe-siege: that tool shoots
           * nothing but wall cameras, this one interleaves them with field shots, and a
           * sampler left pinned at crest height would silently lift every subsequent frame.
           */
          let wallDebug = null;
          const rig = g.engine.rig;
          /*
           * -------------------------------------------------------------------------
           * `cam`: an explicit camera, in metres and degrees, instead of a zoom number.
           * -------------------------------------------------------------------------
           *
           * Round one of the paired blind instrument came back 14/14 for all three graders,
           * and all three raised the same methodological fault unprompted: **our side is
           * gameplay grabs from a high tactical camera and the Rome II side is press and
           * cinematic captures at ground level.** One of them wrote "after four pairs I could
           * have started picking on framing alone". That is not a rendering property and it
           * has no business in a rendering instrument.
           *
           * The framing came out that way because `setCamera` takes a single `zoom` scalar
           * and `RTSCamera` derives everything from it — boom distance on an exponential
           * curve, pitch on `lerp(0.05, 1.03, smoothstep(z)^1.35)`, field of view on
           * `lerp(32, 52, smoothstep(z))` — and then `place()` refuses to let the eye sit
           * closer to the ground than `lerp(1.7, 22, smoothstep(z))`. That last clamp is the
           * one that does the damage: at `zoom: 0.34`, the shot that photographs a line of
           * battle, the curve asks for an eye 2.8 m up and the clamp overrides it to 7.2 m
           * while the aim point stays on the grass — so the true depression is 25 degrees
           * where the reference plates sit at 3 to 8. The camera is not high because anyone
           * chose a high camera. It is high because a collision guard said so.
           *
           * So a shot may now name what a photographer names, and the curves are bypassed:
           *
           *   eye    metres above the ground at the focus. 1.6-2.2 is a standing man.
           *   aim    metres above that same ground that the lens is pointed at.
           *   dist   metres from the focus, horizontally. This is the framing control.
           *   fov    vertical field of view in degrees. This is the focal length.
           *
           * Depression falls out of the three lengths — `atan((eye - aim) / dist)` — which is
           * the honest way round: you cannot independently choose an eye height, an aim point,
           * a standoff and an angle, and a parameter set that pretends you can is a parameter
           * set that silently ignores one of them.
           *
           * Implementation is four overrides on the live rig. `private` in TypeScript is a
           * compile-time fiction, `radius` is a prototype getter that an own property shadows,
           * and `heightAt` is already overridden this way by the `wall` path below. The
           * `- L` in the height override cancels `place()`'s own "look slightly above the
           * focus" lift so that `aim` means what it says; `zoom` is pinned to 0 so that lift
           * is the known 1.55 m rather than a function of a zoom this shot no longer uses.
           *
           * Everything is put back afterwards, for the same reason the wall path puts its
           * sampler back: this file interleaves shots inside one page load, and a rig left
           * pinned silently reframes every frame after it.
           */
          let camDebug = null;
          let wallBay = null;
          if (s.wall) {
            const city = g.engine.context.tryGet('city');
            const bays = city && city.getGarrisonBays ? city.getGarrisonBays() : null;
            if (!bays || !bays.length) throw new Error('wall camera asked for, but this map has no garrison bays');
            const gateIdx = bays.findIndex((b) => b.isGate);
            const bay = bays[Math.max(0, Math.min(bays.length - 1, (gateIdx < 0 ? 0 : gateIdx) + s.wall.bay))];
            const mx = (bay.x0 + bay.x1) * 0.5;
            const mz = (bay.z0 + bay.z1) * 0.5;
            fx = mx + bay.nx * s.wall.stand;
            fz = mz + bay.nz * s.wall.stand;

            if (!rig.__savedHeightAt) rig.__savedHeightAt = rig.heightAt;
            const lift = s.wall.lift;
            let liftY = null;
            if (lift === 'walk') liftY = bay.walkY;
            else if (lift === 'crest') liftY = bay.crestY;
            else if (typeof lift === 'string' && lift.startsWith('walk+')) liftY = bay.walkY + Number(lift.slice(5));
            else if (typeof lift === 'string' && lift.startsWith('walk-')) liftY = bay.walkY - Number(lift.slice(5));
            else if (typeof lift === 'string' && lift.startsWith('crest+')) liftY = bay.crestY + Number(lift.slice(6));
            else if (typeof lift === 'number') liftY = rig.__savedHeightAt(fx, fz) + lift;
            rig.heightAt = liftY === null ? rig.__savedHeightAt : () => liftY;

            // 'in' looks at the city across the curtain, 'out' away from it, 'along' down
            // the length of the walk. Written down rather than resolved, the yaw goes stale
            // the first time the wall line is re-cut.
            let wy = s.wall.yaw;
            if (wy === 'in') wy = Math.atan2(-bay.nx, -bay.nz);
            else if (wy === 'out') wy = Math.atan2(bay.nx, bay.nz);
            else if (wy === 'along') wy = Math.atan2(bay.dx, bay.dz);
            fyaw = wy + (s.wall.yawAdd ?? 0);
            wallDebug = {
              bayIndex: bay.index, stage: bay.stage, walkY: +bay.walkY.toFixed(2),
              crestY: +bay.crestY.toFixed(2), focusY: liftY === null ? null : +liftY.toFixed(2),
            };
            wallBay = bay;
          }
          if (!s.wall && !s.cam && rig.__savedHeightAt) {
            // A previous wall or `cam` shot in this page load pinned the sampler; put it back.
            rig.heightAt = rig.__savedHeightAt;
          }
          if (s.cam) {
            if (!rig.__savedHeightAt) rig.__savedHeightAt = rig.heightAt;
            if (!rig.__savedCam) {
              rig.__savedCam = {
                pitchForZoom: rig.pitchForZoom,
                fovForZoom: rig.fovForZoom,
                radius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
              };
            }
            /*
             * What "the ground" means for this shot.
             *
             * `terrain` is the heightfield at the focus, which is what a field camera wants.
             * `walk` and `crest` are the wall-walk and the battlement of the bay the `wall`
             * block above resolved, because a camera standing on a parapet is not standing on
             * the terrain and expressing its height above the terrain would make every
             * assault frame depend on how deep the ditch happens to be that day.
             */
            const base = s.cam.base ?? 'terrain';
            const groundY = base === 'walk' && wallBay ? wallBay.walkY
              : base === 'crest' && wallBay ? wallBay.crestY
                : rig.__savedHeightAt(fx, fz);
            // `place()` adds this to the look-at target; pinning zoom to 0 pins it to 1.55.
            const LIFT = 1.55;
            const eye = s.cam.eye, aim = s.cam.aim, dist = s.cam.dist;
            const rise = eye - aim + LIFT;
            const R = Math.hypot(rise, dist);
            const P = Math.atan2(rise, dist);
            rig.zoom = 0;
            rig.zoomTarget = 0;
            rig.pitchForZoom = () => P;
            rig.fovForZoom = () => s.cam.fov;
            Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
            rig.heightAt = () => groundY + aim - LIFT;
            camDebug = {
              eye, aim, dist, fov: s.cam.fov,
              depressionDeg: +((Math.atan2(eye - aim, dist) * 180) / Math.PI).toFixed(2),
              base, radius: +R.toFixed(2), pitchDeg: +((P * 180) / Math.PI).toFixed(2),
              groundY: +groundY.toFixed(2),
            };
          } else if (rig.__savedCam) {
            rig.pitchForZoom = rig.__savedCam.pitchForZoom;
            rig.fovForZoom = rig.__savedCam.fovForZoom;
            if (rig.__savedCam.radius) Object.defineProperty(rig, 'radius', rig.__savedCam.radius);
            else delete rig.radius;
            rig.__savedCam = null;
          }
          // `yawAdd` on a `cam` shot, so a frame can be swung off the sun without moving the
          // subject. Shooting into a low sun turns the whole upper third into one flat
          // cream wash, which is a lighting-setup signature rather than a rendering one and
          // is precisely what round two is trying to stop clustering on.
          if (s.cam) g.setCamera(fx, fz, 0, fyaw + (s.yawAdd ?? 0));
          else if (s.wall) g.setCamera(fx, fz, s.wall.zoom ?? s.zoom, fyaw);
          else g.setCamera(fx, fz, s.zoom, fyaw);

          // Settle on the *synthetic* clock. Feeding `performance.now()` here would
          // jump Time's accumulator forward by however long the fast-forward took,
          // producing one clamped 250 ms frame that poisons the rolling fps average
          // for every subsequent measurement. `advance` keeps the clock continuous.
          // 0.25 s ≈ 15 frames, enough for camera smoothing, LOD hysteresis and TAA
          // history to converge.
          g.advance(0.25);

          // Measure real cost rather than trusting the in-engine average. Frame inputs
          // stay on the synthetic clock so Time's accumulator is never jumped.
          //
          // `gl.finish()` is not a reliable barrier here: under ANGLE-on-Metal it
          // returns before the GPU has drained, which reported 0.25 ms/frame for a
          // 1.3 M-triangle scene. A 1x1 `readPixels` forces a genuine round trip,
          // because the result cannot be produced until the pipeline has flushed.
          /*
           * Drive the clock from our own counter, not from `Time.elapsed`.
           *
           * `Time.beginFrame` does `raw = now - lastNow; lastNow = now; frameDt = clamp(raw,
           * 0, 0.25)`. Feeding it `elapsed * 1000 + 16.7` — a timestamp recomputed from the
           * clock the previous call just advanced — makes `raw` come out as *exactly the
           * previous frameDt*. It is a fixed point, and it holds for all thirty frames.
           *
           * Which value it locks onto is bistable and depends on whether synthetic `elapsed`
           * has outrun `performance.now()` when the loop starts. Early in a deck it pins at 0.
           * Later — after fast-forwarding to t+78 s, which costs 78 s of `elapsed` but only a
           * few wall seconds on an idle machine — it pins at the 0.25 s clamp, which is five
           * fixed sim steps per rendered frame at the `maxStepsPerFrame` cap.
           *
           * So the harness charged **five 30 Hz ticks to every rendered frame** and reported
           * render+5x-sim as if it were frame cost. At `melee`, identical code: 22.68 ms that
           * way against 9.37 ms at a true 1/60 s frame — 14.04 ms of it simulation, about
           * 2.8 ms a tick at 8,128 men, which is inside the 4 ms budget and merely counted
           * five times. Corroborated across 493 historical shot records: `clash` at 0.23 s of
           * overshoot ran 3.1-9.4 ms over 15 runs, and at 5.80-5.87 s of overshoot ran
           * 20.4-24.0 ms over 15 runs. Same shot, same camera.
           *
           * The perverse consequence, which is why this survived so long: the faster and
           * quieter the machine, the further `elapsed` outruns the wall clock, the more likely
           * the 0.25 s branch, and **the worse the number reported**. A run on a loaded machine
           * looked healthy and a run on an idle one looked like a 30% regression.
           *
           * `resync()` drops `lastNow`, and the counter below then supplies real 1/60 s deltas
           * that owe nothing to `elapsed`.
           */
          const N = 30;
          const gl = g.engine.renderer.getContext();
          const px = new Uint8Array(4);
          const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

          g.engine.time.resync();
          let clock = g.engine.time.elapsed * 1000;
          const step = () => { clock += 1000 / 60; g.engine.frame(clock); };

          step();
          sync();
          const t0 = performance.now();
          for (let i = 0; i < N; i++) step();
          sync();
          const msPerFrame = (performance.now() - t0) / N;

          /*
           * How far the nearest man in shot actually is, and where the horizon falls.
           *
           * `cam.dist` is the standoff from the *focus*, and a focus resolved by `follow` is
           * the centre of a formation twenty metres deep — so a shot that names a nine-metre
           * standoff puts the camera inside the block and photographs one man's ear. That is
           * exactly what the first ground-level pass did, and eyeballing contact sheets to
           * find it is slow and unrepeatable. Two numbers make the framing a measurement:
           * the range to the nearest living man in front of the lens, which is what decides
           * how big a soldier is in frame, and the horizon's height, which is the single
           * strongest compositional signature of the reference set (it sits in the upper
           * third on eleven of the fourteen eligible plates).
           */
          let nearestMan = null;
          let horizonFrac = null;
          let sunAngle = null;
          let sunElev = null;
          {
            const cam = rig.camera;
            const fwd = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
            const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
            let best = Infinity;
            const pl = g.battle.pool;
            for (let i = 0; i < pl.count; i++) {
              const st = pl.state[i];
              if (st === 11 || st === 10) continue;
              const dx = pl.x[i] - px, dy = (pl.y ? pl.y[i] : 0) + 0.9 - py, dz = pl.z[i] - pz;
              if (dx * fwd.x + dy * fwd.y + dz * fwd.z <= 0) continue;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < best) best = d2;
            }
            if (best < Infinity) nearestMan = +Math.sqrt(best).toFixed(2);
            // Elevation of the true horizon above the optical axis, as a fraction of frame
            // height measured from the top. 0.5 is dead centre; the plates average ~0.33.
            const halfTan = Math.tan((cam.fov * Math.PI) / 360);
            const pitchDown = Math.asin(-fwd.y);
            horizonFrac = +(0.5 - (Math.tan(pitchDown) / halfTan) * 0.5).toFixed(3);
            /*
             * How far off the sun the lens is pointing, in degrees. 0 is straight into it.
             *
             * Not a curiosity. Inside about 45 degrees of a low sun the frame fills with
             * veiling — bloom, god rays and forward Mie scatter all peak at once — and every
             * surface in it goes to one flat cream regardless of what it is made of. That is
             * a *lighting-setup* signature, the exact thing round two exists to stop the deck
             * clustering on, and it is invisible in a shot table that records only an hour.
             */
            const sky = g.engine.context.tryGet('sky');
            const sd = sky && sky.sunDirection;
            if (sd) {
              const fl = Math.hypot(fwd.x, fwd.z) || 1e-6;
              const sl = Math.hypot(sd.x, sd.z) || 1e-6;
              const c = (fwd.x * sd.x + fwd.z * sd.z) / (fl * sl);
              sunAngle = +((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI).toFixed(1);
              sunElev = +((Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180) / Math.PI).toFixed(1);
            }
          }

          let men = 0;
          let units = 0;
          let corpses = 0;
          for (const u of g.battle.units) {
            if (!u.destroyed) { units++; men += u.alive; }
          }
          const pool = g.battle.pool;
          for (let i = 0; i < pool.count; i++) if (pool.state[i] === 11) corpses++;

          const st = g.engine.stats();
          return {
            simTime: g.simTime(), men, units, corpses, waterDebug, wallDebug, camDebug,
            nearestMan, horizonFrac, sunAngle, sunElev,
            weather: g.engine.context.tryGet('vfx')?.weatherKind ?? 'n/a',
            focusX: Math.round(fx), focusZ: Math.round(fz), yaw: +fyaw.toFixed(2),
            draws: st.calls, tris: st.tris, programs: st.programs,
            msPerFrame, fps: 1000 / msPerFrame,
          };
        },
        { s: shot }
      );

      if (!SHOW_HUD) {
        await page.evaluate(() => {
          const r = document.getElementById('hud-root');
          if (r) r.style.setProperty('display', 'none', 'important');
          const hud = window.__game?.engine?.context?.tryGet?.('hud');
          if (hud && hud.overlay) hud.overlay.visible = false;
        });
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, type: 'png' });
      results.push({ name, file, ...info, ms: Date.now() - t0, desc: shot.desc });
      console.log(
        `  ✓ ${name.padEnd(14)} t+${String(Math.round(info.simTime)).padStart(3)}s  ` +
        `${String(info.men).padStart(5)} men  ${String(info.units).padStart(2)} units  ` +
        `${String(info.draws).padStart(4)} draws  ${(info.tris / 1e6).toFixed(2)}M tris  ` +
        `${info.msPerFrame.toFixed(2)}ms/f  @(${info.focusX},${info.focusZ})` +
        (info.nearestMan === null ? '' : `  near ${String(info.nearestMan).padStart(6)}m  horizon ${info.horizonFrac}`) +
        (info.sunAngle === null ? '' : `  sun ${String(info.sunAngle).padStart(5)}deg@${info.sunElev}`)
      );
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}: ${err.message}`);
      results.push({ name, error: err.message, desc: shot.desc });
    }
  }

  if (consoleErrors.length) {
    failed++;
    console.error(`\n⚠ ${consoleErrors.length} console error(s):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.error(`   ${e}`);
  }

  /*
   * `report.json` is now the shot pass's provenance record as well as its log, and
   * `tools/blind-compare.mjs` will not build a deck out of a directory that lacks one.
   * `hud` is the field that matters: false means this directory is safe to grade blind,
   * true means it is not, and *missing* means nobody knows — all three are distinct, and
   * the third is the one that produced leak six.
   */
  /*
   * A partial re-shoot must not destroy the provenance of the frames it did not touch.
   *
   * `--shots=a,b` into a directory that already holds a fourteen-frame pass used to overwrite
   * `report.json` with a two-entry one, so the deck's own record would then describe two of
   * its members and be silent about the other twelve. Silence is the state that produced leak
   * six. Retuning one badly framed pair is a normal thing to want — the alternative is a
   * forty-minute full pass for one frame, which is the pressure that gets provenance skipped.
   *
   * So the record merges by shot name, and it refuses to merge across anything that has to be
   * uniform for the frames to belong in one deck: the HUD policy, the pixel ratio, the frame
   * size, the quality tier and the commit. A mixed-commit directory is not a pass, it is two
   * passes in a trench coat, and a deck built from one would be measuring the difference
   * between them as if it were a difference between renderers.
   */
  const recPath = path.join(OUT, 'report.json');
  const passes = [];
  let merged = results;
  if (existsSync(recPath)) {
    const prior = JSON.parse(await readFile(recPath, 'utf8'));
    const fixed = { hud: SHOW_HUD, dpr: DPR, width: W, height: H, quality: QUALITY };
    const clash = Object.entries(fixed).filter(([k, v]) => prior[k] !== undefined && prior[k] !== v);
    // The renderer, not the commit. A pass written before `srcTree` existed is checked by
    // resolving its own commit's `src` tree, which is exact rather than lenient.
    const priorTree = prior.srcTree ?? (prior.commit ? srcTreeOf(prior.commit) : null);
    if (priorTree === null) clash.push(['srcTree', `unresolvable from commit ${prior.commit ?? '?'}`]);
    else if (priorTree !== SRC_TREE) clash.push(['srcTree', SRC_TREE]);
    if (clash.length) {
      console.error(`\nREFUSED to merge into ${path.relative(ROOT, recPath)}: `
        + clash.map(([k, v]) => `${k} was ${prior[k] ?? priorTree}, now ${v}`).join('; '));
      console.error('  Shoot the whole set into a clean directory instead.');
      failed++;
    } else {
      const byName = new Map((prior.shots ?? []).map((r) => [r.name, r]));
      for (const r of results) byName.set(r.name, r);
      merged = [...byName.values()];
      passes.push(...(prior.passes ?? [{ at: prior.at, argv: prior.argv }]));
    }
  }
  passes.push({ at: new Date().toISOString(), argv: process.argv.slice(2), commit: COMMIT, srcTree: SRC_TREE });

  await writeFile(
    recPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        tool: 'tools/shoot.mjs',
        argv: process.argv.slice(2),
        /** Every pass that contributed a frame to this directory, oldest first. */
        passes,
        hud: SHOW_HUD,
        dpr: DPR,
        worldOverlay: overlayHidden,
        blindSafe: !SHOW_HUD,
        commit: COMMIT,
        srcTree: SRC_TREE,
        width: W, height: H, quality: QUALITY, gl,
        shots: merged,
        consoleErrors: [...new Set(consoleErrors)],
      },
      null,
      2
    )
  );
  console.log(`\n→ ${results.filter((r) => !r.error).length}/${requested.length} shots written to ${path.relative(ROOT, OUT)}/`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  stopServer();
}

process.exit(failed > 0 ? 1 : 0);
