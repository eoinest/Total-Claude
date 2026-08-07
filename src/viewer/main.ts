import * as THREE from 'three';
import { ALL_FACTIONS, FACTIONS, Faction, type UnitTypeDef } from '../sim/types';
import { ALL_UNITS, isCavalry, unitType } from '../units/roster';
import {
  EngineKind, emptyPose, engineKindOf, enginePose, isEngineUnit, type EnginePose,
} from '../units/engines';
import { emptyKit, resolveKit } from '../units/kit';
import { hash01 } from '../util/rand';
import { SoldierRig, type CaptureLight, type ManPose } from './soldierRig';
import { EngineRig, type EngineView } from './engineRig';
import { Stage, type LightPreset } from './stage';
import { pieceColour, setPartsDebug } from './partsDebug';
import { SkeletonOverlay } from './skeleton';
import { MAN_RIG } from '../anim/rig';
import { Panel } from './ui';

/**
 * TOTAL CLAUDE model viewer.
 *
 * A second page beside the game that shows every model the project generates, one at a time
 * and up close. Nothing here is loaded from disk — the soldiers, the horses and the siege
 * engines are all built in code at boot, exactly as the battle builds them — so what the
 * viewer draws is the same geometry, the same atlas and the same shaders the game draws
 * rather than an export of them.
 *
 * Four views, and the reason for each:
 *
 *   SINGLE   one man, orbitable, at a tier you choose. The base case.
 *   LOD      all four tiers side by side in the same pose, labelled with their measured
 *            triangle counts and the distance each takes over at. LOD popping is a defect you
 *            cannot see one tier at a time.
 *   RANK     twenty-four men of one unit type, each with his own hash. Kit variance is a
 *            property of a *crowd*; one man tells you nothing about whether the spread works.
 *   ENGINE   a siege engine and its crew, scrubbable through the loading cycle, with the
 *            part-identity view that separates "missing" from "hidden".
 *
 * The roster is enumerated at runtime from `ALL_UNITS`, and factions from the units that
 * exist rather than from a literal, so a faction landing in the roster after this was written
 * appears in the dropdown without anyone editing this file.
 */

// ---------------------------------------------------------------------------
// Names the enums cannot supply at runtime
// ---------------------------------------------------------------------------

/**
 * `Piece` is a `const enum`, so there is no reverse map to read a name out of. Listing them
 * is duplication, but the alternative is a viewer whose most useful panel says "piece 17".
 * A piece added past the end of this table is simply not listed, which is a smaller failure
 * than a wrong label — and the part-ID colour view still shows it.
 */
const PIECE_NAMES: Record<number, string> = {
  0: 'Head', 1: 'Hair (short)', 2: 'Hair (long)', 3: 'Beard',
  4: 'Helm — Imperial Gallic', 5: 'Helm — ridge', 6: 'Helm — Coolus',
  7: 'Helm — spangenhelm', 8: 'Helm — fur cap',
  9: 'Crest — transverse', 10: 'Crest — longitudinal', 11: 'Crest — plume', 12: 'Crest — horns',
  13: 'Tunic', 14: 'Focale', 15: 'Torso (bare)',
  16: 'Armour — segmentata', 17: 'Armour — mail', 18: 'Armour — scale', 19: 'Armour — leather',
  20: 'Legs (bare)', 21: 'Trousers', 22: 'Boots', 23: 'Cloak',
  24: 'Shield — scutum', 25: 'Shield — oval', 26: 'Shield — round',
  27: 'Sword', 28: 'Spear', 29: 'Axe', 30: 'Bow', 31: 'Quiver',
  32: 'Pilum', 33: 'Javelin bundle', 34: 'Torc', 35: 'Sword (sheathed)',
};

/** LOD2 speaks a different, coarser vocabulary — eight silhouette groups, not 36 pieces. */
const COARSE_NAMES: Record<number, string> = {
  0: 'Body', 1: 'Helmet', 2: 'Armour', 3: 'Shield (big)',
  4: 'Shield (round)', 5: 'Pole arm', 6: 'Blade', 7: 'Cloak',
};

/**
 * LOD band edges as fractions of `quality.lodFarDistance`.
 *
 * `LOD_FRACTION` is module-private in `UnitRenderSystem.ts:112` and `src/units` belongs to
 * another workstream, so the values are restated here. They multiply
 * `QUALITY_PRESETS.high.lodFarDistance`, which is 220. The report asks for the export.
 */
const LOD_FRACTION = [0.14, 0.4, 2.0];
const LOD_FAR_HIGH = 220;
const LOD_LABELS = ['LOD0', 'LOD1', 'LOD2', 'IMPOSTOR'];

/**
 * How far the horse mesh sits above its own origin, metres.
 *
 * Restated from `HORSE_GROUND_LIFT` in `src/units/horseMesh.ts` only because the skeleton
 * overlay needs it and `SoldierRig` already applies it internally when it pushes the mount.
 */
const HORSE_LIFT = 0.075;

/** Where the four men stand in the LOD ladder, metres. */
const LADDER_X = [-2.25, -0.75, 0.75, 2.25];

type Mode = 'single' | 'lod' | 'rank' | 'engine';
type KindChoice = 'auto' | 'scorpio' | 'onager';

interface State {
  unitId: string;
  mode: Mode;
  lod: 0 | 1 | 2 | 3;
  clip: number;
  gait: number;
  playing: boolean;
  phase: number;
  speed: number;
  hash: number;
  melee: boolean;
  /** 0 off · 1 piece ids · 2 bone ids · 3 skin weights. */
  parts: number;
  skeleton: boolean;
  wireframe: boolean;
  ground: boolean;
  gauge: boolean;
  shadows: boolean;
  turntable: boolean;
  longLens: boolean;
  rider: boolean;
  seatProbe: boolean;
  preset: LightPreset;
  solo: number;
  hidden: Set<number>;
  engineCycle: boolean;
  engineDraw: number;
  engineCrew: boolean;
  battery: boolean;
  engineKind: KindChoice;
}

const bitOf = (p: number): number => (p < 24 ? 2 ** p : 2 ** (p - 24));

class Viewer {
  private readonly stage: Stage;
  private readonly rig: SoldierRig;
  private readonly engines: EngineRig;
  private readonly panel: Panel;
  private readonly readout: HTMLElement;
  private readonly tagLayer: HTMLElement;
  private readonly tags: HTMLElement[] = [];
  private readonly skeleton = new SkeletonOverlay();
  private readonly seatMark: THREE.Mesh;
  private readonly pelvisMark: THREE.Mesh;

  private readonly state: State = {
    unitId: ALL_UNITS[0]?.id ?? 'legio-cohort',
    mode: 'single',
    lod: 0,
    clip: 0,
    gait: 0,
    playing: true,
    phase: 0,
    speed: 1,
    hash: 0.37,
    melee: false,
    parts: 0,
    skeleton: false,
    wireframe: false,
    ground: true,
    gauge: true,
    shadows: true,
    turntable: false,
    longLens: false,
    rider: true,
    seatProbe: false,
    preset: 'studio',
    solo: -1,
    hidden: new Set<number>(),
    engineCycle: true,
    engineDraw: 1,
    engineCrew: true,
    battery: false,
    engineKind: 'auto',
  };

  /**
   * Handles back into the panel.
   *
   * Every control is two-way, because the viewer is driven from three directions — the panel,
   * the keyboard and `window.__viewer` — and a panel that only listens goes stale the moment
   * a harness or a shortcut moves the state. The first pass had exactly that: a screenshot
   * showed the readout saying "Tribal Warband" over a dropdown still reading "Legionary
   * Cohort", which is the kind of thing that makes a tool untrustworthy in one glance.
   */
  private readonly sync: {
    mode?: (v: Mode) => void;
    lod?: (v: string) => void;
    kind?: (v: KindChoice) => void;
    phase?: (v: number) => void;
    hash?: (v: number) => void;
    draw?: (v: number) => void;
    pieces?: (present: number[], solo: number, hidden: Set<number>, tris: Map<number, number>) => void;
    hashText?: (v: string) => void;
    siegeGroup?: HTMLElement;
    riderRow?: HTMLElement;
    play?: (v: boolean) => void;
    parts?: (v: string) => void;
    light?: (v: boolean) => void;
    flags: Record<string, (v: boolean) => void>;
    unit?: HTMLSelectElement;
    clip?: HTMLSelectElement;
    gait?: HTMLSelectElement;
    clipRow?: HTMLElement;
    gaitRow?: HTMLElement;
  } = { flags: {} };

  private fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  /** Rolling mean frame time. The number to read: fps is pinned to the display refresh. */
  private frameMs = 0;
  private readoutAccum = 0;
  /** Seconds left on the "copied" confirmation. */
  private copied = 0;
  private engineT = 0;
  private lastPhaseShown = -1;
  private lastReport = '';
  private readonly kit = emptyKit();
  private readonly poseProbe: EnginePose = emptyPose();
  private readonly project = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, panelRoot: HTMLElement, readout: HTMLElement) {
    this.stage = new Stage(canvas);
    this.rig = new SoldierRig(Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy()));
    // On the soldiers' base params, atlas maps and all — see `SoldierRig.materialBase`.
    this.engines = new EngineRig(this.rig.materialBase);
    this.stage.scene.add(this.rig.group, this.engines.group, this.skeleton.object);
    this.readout = readout;

    // The seating probe. Basic material and no depth test, because the whole point is to see
    // a point that is *inside* the horse.
    const mark = (colour: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 12, 8),
        new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.95 })
      );
      m.renderOrder = 50;
      m.visible = false;
      m.name = 'viewer-mark';
      this.stage.scene.add(m);
      return m;
    };
    this.seatMark = mark(0x35d0ff);
    this.pelvisMark = mark(0xffd23f);

    this.tagLayer = document.createElement('div');
    this.tagLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    canvas.parentElement?.append(this.tagLayer);

    this.panel = new Panel(panelRoot);
    this.buildPanel();
    this.onUnitChanged(true);
    this.installKeys();
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  private get def(): UnitTypeDef {
    return unitType(this.state.unitId);
  }

  private unitOptions(): { value: string; label: string; group: string }[] {
    // Grouped by faction, but only over factions that actually field something — a roster
    // half-way through gaining one should not show an empty heading.
    const out: { value: string; label: string; group: string }[] = [];
    const seen = new Set<Faction>();
    for (const f of ALL_FACTIONS) {
      const units = ALL_UNITS.filter((u) => u.faction === f);
      if (units.length === 0) continue;
      seen.add(f);
      for (const u of units) {
        out.push({ value: u.id, label: `${u.name} · ${u.unitClass}`, group: FACTIONS[f].shortName });
      }
    }
    // A unit whose faction is not in `ALL_FACTIONS` yet is still listed rather than lost.
    for (const u of ALL_UNITS) {
      if (!seen.has(u.faction)) {
        out.push({ value: u.id, label: `${u.name} · ${u.unitClass}`, group: `FACTION ${u.faction}` });
      }
    }
    return out;
  }

  private clipOptions(): { value: string; label: string; group: string }[] {
    return this.rig.manFacts.map((f) => ({
      value: String(f.index),
      label: `${f.name}  (${f.frames}f · ${f.duration.toFixed(2)}s)`,
      group: f.loop ? 'Looping' : 'One-shot',
    }));
  }

  private gaitOptions(): { value: string; label: string; group: string }[] {
    return this.rig.horseFacts.map((f) => ({
      value: String(f.index), label: `${f.name}  (${f.frames}f)`, group: 'Mount',
    }));
  }

  private kindOf(def: UnitTypeDef): EngineKind {
    const k = this.state.engineKind;
    if (k === 'scorpio') return EngineKind.Scorpio;
    if (k === 'onager') return EngineKind.Onager;
    return engineKindOf(def);
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  private buildPanel(): void {
    const s = this.state;
    const p = this.panel;

    p.group('Subject');
    this.sync.unit = p.select('Unit', this.unitOptions(), s.unitId, (v) => {
      s.unitId = v;
      this.onUnitChanged(true);
    });
    this.sync.mode = p.segmented<Mode>('View', [
      { value: 'single', label: 'Single', title: 'One man, orbitable' },
      { value: 'lod', label: 'LOD', title: 'All four tiers side by side, labelled' },
      { value: 'rank', label: 'Rank', title: '24 men, each with his own hash — kit variance' },
      { value: 'engine', label: 'Engine', title: 'Siege engine and crew' },
    ], s.mode, (v) => {
      s.mode = v;
      this.syncPanel();
      this.frameSubject();
    });
    this.sync.hash = p.slider('Hash', 0, 1, 0.001, s.hash, (v) => {
      s.hash = v;
      this.refreshPieces();
    }, (v) => v.toFixed(3));
    this.sync.hashText = p.textValue('Hash (exact)', s.hash.toFixed(6), (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) return;
      s.hash = n;
      this.syncPanel();
    });
    p.buttons([
      { label: 'Reroll hash', onClick: () => this.reroll() },
      { label: 'Frame', title: 'Fit the camera to the subject', onClick: () => this.frameSubject() },
      { label: 'Copy report', title: 'Every number on screen plus the exact state to reproduce it', onClick: () => this.copyReport() },
    ]);
    p.note('The hash is the single 0..1 number every appearance choice comes from — helmet, beard, shield device, metal, stature. Two men with the same hash are identical by construction.');

    p.group('Animation');
    this.sync.clip = p.select('Clip', this.clipOptions(), String(s.clip), (v) => {
      s.clip = Number(v);
      s.phase = 0;
    });
    this.sync.clipRow = this.sync.clip.closest('.vw-row') as HTMLElement;
    this.sync.gait = p.select('Mount gait', this.gaitOptions(), String(s.gait), (v) => {
      s.gait = Number(v);
    });
    this.sync.gaitRow = this.sync.gait.closest('.vw-row') as HTMLElement;
    this.sync.play = p.toggle('Play / pause  (space)', s.playing, (v) => { s.playing = v; });
    this.sync.phase = p.slider('Playhead', 0, 1, 0.001, 0, (v) => {
      s.phase = v;
      s.playing = false;
      this.sync.play?.(false);
    }, (v) => v.toFixed(3));
    p.slider('Speed', 0.05, 2, 0.05, s.speed, (v) => { s.speed = v; }, (v) => `${v.toFixed(2)}x`);
    p.buttons([
      { label: '← frame', onClick: () => this.step(-1) },
      { label: 'frame →', onClick: () => this.step(1) },
      { label: 'hit frame', title: 'Jump to the clip’s authored contact frame', onClick: () => this.toHit() },
    ]);

    p.group('Tier');
    this.sync.lod = p.segmented('LOD', [
      { value: '0', label: 'LOD0' }, { value: '1', label: 'LOD1' },
      { value: '2', label: 'LOD2' }, { value: '3', label: 'Impostor' },
    ], String(s.lod), (v) => {
      s.lod = Number(v) as 0 | 1 | 2 | 3;
      this.syncPanel();
    });
    p.buttons([
      { label: `${(LOD_FRACTION[0] * LOD_FAR_HIGH).toFixed(0)} m`, title: 'Stand at the LOD0→LOD1 edge', onClick: () => this.stand(0) },
      { label: `${(LOD_FRACTION[1] * LOD_FAR_HIGH).toFixed(0)} m`, title: 'LOD1→LOD2 edge', onClick: () => this.stand(1) },
      { label: `${(LOD_FRACTION[2] * LOD_FAR_HIGH).toFixed(0)} m`, title: 'LOD2→impostor edge', onClick: () => this.stand(2) },
      { label: 'close', title: 'Back to arm’s length', onClick: () => this.frameSubject() },
    ]);
    p.note('The distance buttons put the camera where the game switches tier at the "high" preset. It is the only honest way to judge a tier: LOD2 is a few hundred triangles and is meant to be seen from 88 metres. The readout prints how many screen pixels tall a 1.75 m man is at that range, which is the number that decides whether a tier is good enough.');

    p.group('Diagnostics');
    this.sync.parts = p.segmented('Shading', [
      { value: '0', label: 'Lit' },
      { value: '1', label: 'Piece IDs', title: 'Flat colour per piece id (p). The Pieces list below is the legend — each swatch is that piece’s colour on the model.' },
      { value: '2', label: 'Bone IDs', title: 'Flat colour per primary bone — how the mesh is partitioned across the skeleton' },
      { value: '3', label: 'Weights', title: 'Second-influence weight: black = one bone, hot = a 50/50 blend. Every joint that deforms must show a band.' },
    ], String(s.parts), (v) => this.setParts(Number(v)));
    const [wf, ml] = p.toggleRow([
      { label: 'Wireframe', value: s.wireframe, onChange: (v) => { s.wireframe = v; this.setWireframe(v); } },
      { label: 'Melee kit', value: s.melee, title: 'Draw the melee weapon rather than the missile one', onChange: (v) => { s.melee = v; this.refreshPieces(); } },
    ]);
    const [gr, ga, sh] = p.toggleRow([
      { label: 'Ground', value: s.ground, onChange: (v) => { s.ground = v; this.stage.setGroundVisible(v); } },
      { label: '2 m rule', value: s.gauge, onChange: (v) => { s.gauge = v; this.stage.setGaugeVisible(v); } },
      { label: 'Shadows', value: s.shadows, onChange: (v) => { s.shadows = v; this.stage.setShadows(v); } },
    ]);
    const [tt, lt, ll, sk] = p.toggleRow([
      { label: 'Turntable', value: s.turntable, onChange: (v) => { s.turntable = v; this.stage.setTurntable(v); } },
      { label: 'Field light', value: s.preset === 'field', title: 'Swap the neutral studio probe for the battle’s own sun and sky', onChange: (v) => { s.preset = v ? 'field' : 'studio'; this.stage.setLightPreset(s.preset); } },
      { label: 'Long lens', value: s.longLens, title: 'Near-orthographic: 6° lens pulled back, so proportion and silhouette can be judged without perspective', onChange: (v) => { s.longLens = v; this.stage.setLongLens(v); this.frameSubject(); } },
      { label: 'Skeleton', value: s.skeleton, title: 'Joints and bones for this exact frame, drawn through the mesh (k)', onChange: (v) => { s.skeleton = v; } },
    ]);
    const riderToggles = p.toggleRow([
      { label: 'Rider', value: s.rider, title: 'Show the man on the horse, or the horse alone', onChange: (v) => { s.rider = v; } },
      { label: 'Seat probe', value: s.seatProbe, title: 'Mark the animated saddle point and the rider’s pelvis', onChange: (v) => { s.seatProbe = v; } },
    ]);
    const [rd, sp] = riderToggles;
    this.sync.riderRow = p.lastRow;
    this.sync.light = lt;
    Object.assign(this.sync.flags, {
      wireframe: wf, melee: ml, ground: gr, gauge: ga, shadows: sh,
      turntable: tt, longLens: ll, skeleton: sk, rider: rd, seatProbe: sp,
    });
    p.note('Seat probe: blue is the saddle top on this frame of the gait, gold is where the rider’s pelvis landed. They should stay one hip’s clearance apart through a whole gallop. A rider pinned to a rest-pose offset drifts; one whose boots were placed there floats a metre up.');

    p.group('Siege engine');
    this.sync.siegeGroup = p.lastGroup;
    this.sync.kind = p.segmented<KindChoice>('Machine', [
      { value: 'auto', label: 'Auto', title: 'Whatever this unit fields' },
      { value: 'scorpio', label: 'Scorpio' },
      { value: 'onager', label: 'Onager' },
    ], s.engineKind, (v) => {
      s.engineKind = v;
      this.frameSubject();
    });
    const [ec, cr, bt] = p.toggleRow([
      { label: 'Cycle', value: s.engineCycle, title: 'Run the reload cycle instead of holding a draw', onChange: (v) => { s.engineCycle = v; } },
      { label: 'Crew', value: s.engineCrew, onChange: (v) => { s.engineCrew = v; } },
      { label: 'Battery', value: s.battery, title: 'Three machines at the roster pitch', onChange: (v) => { s.battery = v; this.frameSubject(); } },
    ]);
    Object.assign(this.sync.flags, { engineCycle: ec, engineCrew: cr, battery: bt });
    this.sync.draw = p.slider('Draw', 0, 1, 0.01, s.engineDraw, (v) => {
      s.engineDraw = v;
      s.engineCycle = false;
      this.sync.flags.engineCycle?.(false);
    });

    p.group('Pieces — click to solo, ⌘/ctrl-click to hide');
    const entries = Object.keys(PIECE_NAMES).map(Number).map((id) => ({
      id, name: PIECE_NAMES[id], colour: `#${pieceColour(id).getHexString()}`,
    }));
    this.sync.pieces = p.pieces(entries, (id) => this.solo(id), (id) => this.hide(id));
    p.buttons([
      { label: 'Show all pieces', onClick: () => { this.state.solo = -1; this.state.hidden.clear(); this.refreshPieces(); } },
    ]);
    p.note('A piece the shader has collapsed to a point and a piece drawn inside the body look identical in a lit frame. Solo one and the ambiguity is gone: it is either in front of you or it does not exist. At LOD2 the list switches to the eight coarse groups the far mesh is built from.');
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Push the whole state into the panel. Cheap, and it cannot go half-stale. */
  private syncPanel(): void {
    const s = this.state;
    if (this.sync.unit) this.sync.unit.value = s.unitId;
    if (this.sync.clip) this.sync.clip.value = String(s.clip);
    if (this.sync.gait) this.sync.gait.value = String(s.gait);
    this.sync.mode?.(s.mode);
    this.sync.lod?.(String(s.lod));
    this.sync.kind?.(s.engineKind);
    this.sync.hash?.(s.hash);
    this.sync.hashText?.(s.hash.toFixed(6));
    this.sync.draw?.(s.engineDraw);
    this.sync.play?.(s.playing);
    this.sync.parts?.(String(s.parts));
    this.sync.light?.(s.preset === 'field');
    const flags = s as unknown as Record<string, boolean>;
    for (const [k, f] of Object.entries(this.sync.flags)) f(flags[k]);
    // Rows that mean nothing in the current view are hidden rather than left to mislead: the
    // crew's clip comes from `crewClip`, so a Clip dropdown beside a siege engine is a lie.
    if (this.sync.gaitRow) this.sync.gaitRow.style.display = isCavalry(this.def) && s.mode !== 'engine' ? '' : 'none';
    if (this.sync.clipRow) this.sync.clipRow.style.display = s.mode === 'engine' ? 'none' : '';
    // Controls that cannot do anything for this subject are hidden, not left enabled and
    // inert. A "Rider" button lit beside a man on foot is a button that has already lied.
    if (this.sync.siegeGroup) this.sync.siegeGroup.style.display = s.mode === 'engine' ? '' : 'none';
    if (this.sync.riderRow) this.sync.riderRow.style.display = isCavalry(this.def) && s.mode !== 'engine' ? '' : 'none';
    this.refreshPieces();
  }

  private onUnitChanged(reframe: boolean): void {
    const def = this.def;
    if (isEngineUnit(def) && this.state.mode !== 'engine') this.state.mode = 'engine';
    else if (!isEngineUnit(def) && this.state.mode === 'engine') this.state.mode = 'single';
    // A mounted man belongs in a seated clip; a footed one starts at attention.
    const want = isCavalry(def) ? 'rideIdle' : 'idleAlertReady';
    const f = this.rig.manFacts.find((c) => c.name === want);
    if (f) this.state.clip = f.index;
    this.syncPanel();
    if (reframe) this.frameSubject();
  }

  private setParts(mode: number): void {
    this.state.parts = mode;
    setPartsDebug(mode);
    // The engine shader only has the one diagnostic, so bone and weight modes leave the
    // machine shaded. Right: a siege engine has no skeleton and no skin weights to show.
    this.engines.setDebugParts(mode === 1);
    this.sync.parts?.(String(mode));
  }

  /**
   * Put the whole readout, plus the state needed to get back to it, on the clipboard.
   *
   * A finding you cannot hand to anyone is a finding you have to re-find. The reproduction
   * block is deliberately a list of `__viewer` calls rather than prose: paste it into the
   * console and you are looking at exactly the frame the numbers came from, including the
   * camera, which is the part everyone forgets to write down.
   */
  private copyReport(): void {
    const s = this.state;
    const cam = this.stage.camera.position;
    const tgt = this.stage.controls.target;
    const clip = this.rig.manFacts[s.clip]?.name ?? String(s.clip);
    const gait = this.rig.horseFacts[s.gait]?.name ?? String(s.gait);
    const text = [
      `TOTAL CLAUDE model viewer — ${new Date().toISOString()}`,
      '',
      this.lastReport,
      '',
      'reproduce (paste into the console on /viewer.html):',
      `  __viewer.setUnit('${s.unitId}'); __viewer.setMode('${s.mode}'); __viewer.setLod(${s.lod});`,
      `  __viewer.setClipByName('${clip}'); __viewer.setGaitByName('${gait}');`,
      `  __viewer.setHash(${s.hash}); __viewer.setPhase(${s.phase});`,
      `  __viewer.setParts(${s.parts}); __viewer.setLight('${s.preset}');`,
      s.solo >= 0 ? `  __viewer.solo(${s.solo});` : '',
      `  __viewer.camera(${cam.x.toFixed(3)}, ${cam.y.toFixed(3)}, ${cam.z.toFixed(3)}, ${tgt.x.toFixed(3)}, ${tgt.y.toFixed(3)}, ${tgt.z.toFixed(3)});`,
    ].filter(Boolean).join('\n');
    void navigator.clipboard?.writeText(text).catch(() => { /* clipboard denied; nothing to do */ });
    this.copied = 1.6;
  }

  private reroll(): void {
    this.state.hash = Math.random();
    this.syncPanel();
  }

  private solo(id: number): void {
    this.state.solo = this.state.solo === id ? -1 : id;
    this.refreshPieces();
    if (this.state.solo < 0) {
      this.frameSubject();
      return;
    }
    // Put the camera on the piece. Soloing is only useful if you can then see the thing, and
    // a helmet isolated at 1.6 m is off the top of a frame fitted to a whole man.
    const lod = Math.min(2, this.state.lod) as 0 | 1 | 2;
    const b = this.rig.pieceBounds(this.def.faction, lod).get(id);
    if (!b) return;
    // Bind-space bounds against a posed man: pad generously so a swinging arm's sword is
    // still in shot.
    const r = Math.max(0.18, b.r * 2.2);
    this.stage.frame(b.cx, b.cy, b.cz, r, r, r, -0.85, 0.1);
    // Clear of the piece: at this zoom a rule 300 mm away fills a third of the frame.
    this.stage.placeGaugeBeside(b.cx, b.cy, b.cz, r * 1.8 + 0.25);
  }

  private hide(id: number): void {
    const h = this.state.hidden;
    if (h.has(id)) h.delete(id);
    else h.add(id);
    this.refreshPieces();
  }

  /** Piece ids this man's hash actually selected, in the vocabulary of the current tier. */
  private presentPieces(): number[] {
    const kit = resolveKit(this.def, this.state.hash, this.kit);
    const present: number[] = [];
    if (this.state.lod === 2) {
      for (let i = 0; i < 8; i++) if (kit.maskCoarse & (1 << i)) present.push(i);
    } else {
      const hi = this.state.melee ? kit.maskHiMelee : kit.maskHi;
      for (let i = 0; i < 24; i++) if (kit.maskLo & bitOf(i)) present.push(i);
      for (let i = 24; i < 48; i++) if (hi & bitOf(i)) present.push(i);
    }
    return present;
  }

  private refreshPieces(): void {
    const lod = Math.min(2, this.state.lod) as 0 | 1 | 2;
    this.sync.pieces?.(
      this.presentPieces(), this.state.solo, this.state.hidden,
      this.rig.pieceTriangles(this.def.faction, lod)
    );
  }

  private setWireframe(on: boolean): void {
    for (const g of [this.rig.group, this.engines.group]) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        if ('wireframe' in mat) mat.wireframe = on;
      });
    }
  }

  private step(dir: number): void {
    const f = this.rig.manFacts[this.state.clip];
    this.state.playing = false;
    this.sync.play?.(false);
    this.state.phase = (this.state.phase + dir / Math.max(1, f.frames) + 1) % 1;
    this.sync.phase?.(this.state.phase);
  }

  private toHit(): void {
    const f = this.rig.manFacts[this.state.clip];
    if (f.hitFrame < 0) return;
    this.state.playing = false;
    this.sync.play?.(false);
    this.state.phase = f.hitFrame;
    this.sync.phase?.(this.state.phase);
  }

  private stand(edge: number): void {
    this.stage.standOff(LOD_FRACTION[edge] * LOD_FAR_HIGH);
  }

  /**
   * Subject extents, in metres, as (centre, half-size) — the box the camera is fitted to.
   *
   * The heights include what sticks out above a man's head: a raised pilum reaches about
   * 2.6 m and clipping the point off is the kind of thing a viewer must not do, so the boxes
   * are the *kit's* extent rather than the body's.
   */
  private subjectBox(): { cx: number; cy: number; cz: number; hw: number; hh: number; hd: number } {
    const s = this.state;
    const def = this.def;
    if (s.mode === 'lod') return { cx: 0, cy: 1.35, cz: 0, hw: 3.1, hh: 1.35, hd: 0.6 };
    if (s.mode === 'rank') {
      const cav = isCavalry(def);
      const cols = cav ? 4 : 6;
      const rows = cav ? 2 : 4;
      const dx = cav ? 1.5 : 0.86;
      const dz = cav ? 2.4 : 0.95;
      return {
        cx: 0, cy: 1.3, cz: -((rows - 1) * dz) / 2,
        hw: ((cols - 1) * dx) / 2 + 0.7,
        hh: 1.4,
        hd: ((rows - 1) * dz) / 2 + 0.8,
      };
    }
    if (s.mode === 'engine') {
      const big = this.kindOf(def) === EngineKind.Onager;
      const n = s.battery ? 3 : 1;
      const pitch = big ? 6.2 : 4.4;
      return {
        cx: 0, cy: big ? 1.5 : 1.05, cz: -0.5,
        hw: ((n - 1) * pitch) / 2 + (big ? 2.4 : 2.0),
        hh: big ? 1.7 : 1.25,
        hd: big ? 3.0 : 2.1,
      };
    }
    if (isCavalry(def)) return { cx: 0, cy: 1.3, cz: 0, hw: 0.95, hh: 1.35, hd: 1.6 };
    return { cx: 0, cy: 1.18, cz: 0, hw: 0.62, hh: 1.32, hd: 0.55 };
  }

  /**
   * Frame one man for a comparison plate: fill a stated *fraction of frame height* rather
   * than fit a box.
   *
   * The distinction matters because the reference side of the isolated deck is a crop out of
   * a Rome II press plate, cut so the man fills a known share of the output. Magnification is
   * the single largest confound the blind harness has left — "camera and subject distance are
   * still not matched between the pools" — so the harness has to be able to *dial* it rather
   * than accept whatever a bounding-box fit gives.
   */
  private framePlate(azimuth: number, elevation: number, fill: number, aimY?: number): void {
    const box = this.subjectBox();
    // Frame the *man*, not his bounding box.
    //
    // `subjectBox` reaches 2.64 m because a raised pilum is inside it, so a "fill 0.88" that
    // fits the box puts the man himself at 58 % of frame height. Against a press-plate crop
    // in which a soldier fills ~90 %, that is a two-thirds magnification mismatch — and
    // magnification is the largest confound the blind instrument has left. A press plate
    // crops the spear tip without hesitation and so does this.
    const man = { cx: box.cx, cy: 0.95, cz: box.cz, hh: 0.95 };
    const b = this.stage.plateMode && this.state.mode === 'single' ? { ...box, ...man } : box;
    const cam = this.stage.camera;
    const fovY = (cam.fov * Math.PI) / 180;
    // `fill` above 1 is a *close-up*, not an error: the head plates crop inside the man, and
    // clamping it to 1 silently turned every one of them back into a full figure.
    const wantHalf = b.hh / Math.max(0.05, fill);
    const dist = wantHalf / Math.tan(fovY / 2);
    // A head plate has to aim at the head. Fitting the body box and then zooming leaves the
    // camera pointed at the navel with the head off the top of the frame.
    const ty = aimY ?? b.cy;
    this.stage.controls.target.set(b.cx, ty, b.cz);
    cam.position.set(
      b.cx + Math.sin(azimuth) * Math.cos(elevation) * dist,
      ty + Math.sin(elevation) * dist,
      b.cz + Math.cos(azimuth) * Math.cos(elevation) * dist
    );
    this.stage.controls.update();
    this.stage.aimSun(b.cx, b.cy, b.cz);
  }

  private frameSubject(): void {
    const b = this.subjectBox();
    // Machines are looked at from the front quarter, men from their own right-front. A siege
    // engine viewed from behind is three crewmen and a rear tripod leg, which is what the
    // soldier's default angle gave.
    const engine = this.state.mode === 'engine';
    this.stage.frame(
      b.cx, b.cy, b.cz, b.hw, b.hh, b.hd,
      engine ? 1.05 : -0.85, engine ? 0.2 : 0.14
    );
    this.stage.placeGaugeBeside(b.cx, b.cy, b.cz, b.hw + 0.45);
    this.stage.aimSun(b.cx, b.cy, b.cz);
  }

  private installKeys(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.state.playing = !this.state.playing;
          this.sync.play?.(this.state.playing);
          break;
        case 'ArrowLeft': this.step(-1); break;
        case 'ArrowRight': this.step(1); break;
        case '1': case '2': case '3': case '4': {
          this.state.lod = (Number(e.key) - 1) as 0 | 1 | 2 | 3;
          this.syncPanel();
          break;
        }
        case 'r': this.reroll(); break;
        case 'f': this.frameSubject(); break;
        case 'p': this.setParts((this.state.parts + 1) % 4); break;
        case 'k':
          this.state.skeleton = !this.state.skeleton;
          this.syncPanel();
          break;
        default: break;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  private filters(): { lo: number; hi: number; coarse: number } {
    const s = this.state;
    if (s.solo >= 0) {
      return {
        lo: s.solo < 24 ? bitOf(s.solo) : 0,
        hi: s.solo >= 24 ? bitOf(s.solo) : 0,
        coarse: s.solo < 8 ? 1 << s.solo : 0,
      };
    }
    let lo = 0xffffff;
    let hi = 0xffffff;
    let coarse = 0xff;
    for (const id of s.hidden) {
      if (id < 24) lo &= ~bitOf(id);
      else hi &= ~bitOf(id);
      if (id < 8) coarse &= ~(1 << id);
    }
    return { lo, hi, coarse };
  }

  private man(
    def: UnitTypeDef, variant: number, lod: 0 | 1 | 2 | 3,
    x: number, y: number, z: number, yaw: number, clip: number, phase: number,
    scale: number, lean = 0
  ): ManPose {
    const f = this.filters();
    return {
      def, variant, lod, x, y, z, yaw, clip, phase, scale, lean,
      // A trace of field dirt. Zero is a showroom finish nobody in this army has.
      grime: 0.12,
      melee: this.state.melee,
      maskFilterLo: f.lo,
      maskFilterHi: f.hi,
      maskFilterCoarse: f.coarse,
    };
  }

  /** Stature and phase spread, from the same hashes and salts the render system uses. */
  private manVary(variant: number): { scale: number; phaseOff: number } {
    const seed = Math.floor(variant * 16777216);
    return {
      scale: 1 + (hash01(seed, 74) - 0.5) * 0.075,
      phaseOff: hash01(seed, 71),
    };
  }

  /**
   * The lights the impostor atlas should be captured under.
   *
   * Taken from the stage rather than fixed, so the billboard tier is photographed in the same
   * light the mesh tiers stand in. Without this, switching to the field preset leaves the far
   * tier lit by a studio probe and the LOD ladder shows a lighting seam that is the viewer's
   * fault rather than the pipeline's.
   */
  private captureLight(): CaptureLight {
    const sun = this.stage.sun;
    const dir = sun.position.clone().sub(sun.target.position).normalize();
    return {
      key: this.state.preset,
      direction: dir,
      colour: sun.color.clone(),
      ambient: new THREE.Color(this.state.preset === 'field' ? 0x9dbcdc : 0xc9d6e4),
    };
  }

  private compose(dt: number): void {
    const s = this.state;
    const def = this.def;
    this.rig.begin();
    this.engines.begin();
    this.seatMark.visible = false;
    this.pelvisMark.visible = false;
    this.skeleton.hide();

    if (s.mode === 'engine') this.composeEngine(def, dt);
    else if (s.mode === 'lod') this.composeLod(def);
    else if (s.mode === 'rank') this.composeRank(def);
    else this.composeSingle(def);

    this.rig.end(dt);
    this.engines.end();
  }

  private pushManOrRider(
    def: UnitTypeDef, variant: number, lod: 0 | 1 | 2 | 3,
    x: number, z: number, yaw: number, phase: number, probe = false
  ): void {
    const v = this.manVary(variant);
    const scale = def.appearance.heightScale * v.scale;
    if (!isCavalry(def)) {
      this.rig.pushMan(this.man(def, variant, lod, x, 0, z, yaw, this.state.clip, phase, scale));
      if (probe && this.state.skeleton) {
        this.skeleton.poseMan(this.state.clip, phase, x, 0, z, yaw, scale);
      }
      return;
    }
    // A rider's tier is his horse's tier, and the impostor never carries cavalry — the game
    // clamps mounted men to LOD2 for the reason you can see here: a billboard captured on
    // foot has no horse in it.
    const hl = Math.min(2, lod) as 0 | 1 | 2;
    const horse = { lod: hl, x, y: 0, z, yaw, clip: this.state.gait, phase, variant };
    this.rig.pushHorse(horse);
    const seat = this.rig.seatRider(horse, this.state.clip, scale);
    if (this.state.rider) {
      this.rig.pushMan(this.man(
        def, variant, hl, seat.x, seat.y, seat.z, yaw, this.state.clip, phase, scale, seat.lean
      ));
    }
    if (probe && this.state.skeleton) {
      // With the rider hidden, show the animal's rig — that is the one you are looking at.
      if (this.state.rider) this.skeleton.poseMan(this.state.clip, phase, seat.x, seat.y, seat.z, yaw, scale);
      else this.skeleton.poseHorse(this.state.gait, phase, x, HORSE_LIFT, z, yaw, 1);
    }
    if (probe && this.state.seatProbe) {
      this.seatMark.position.set(...seat.saddle);
      this.pelvisMark.position.set(...seat.pelvis);
      this.seatMark.visible = true;
      this.pelvisMark.visible = this.state.rider;
    }
  }

  private composeSingle(def: UnitTypeDef): void {
    if (this.state.lod === 3) this.rig.prepareImpostors(this.stage.renderer, def, this.captureLight());
    this.pushManOrRider(def, this.state.hash, this.state.lod, 0, 0, 0, this.state.phase, true);
  }

  /**
   * The four tiers in a row, same man, same frame.
   *
   * 1.5 m apart, close enough that the eye compares silhouettes directly. That is the value
   * of the view: the numbers say LOD1 is half of LOD0 and LOD2 a fourteenth, but what you
   * need to know is which *feature* went, and only a side-by-side shows that.
   */
  private composeLod(def: UnitTypeDef): void {
    this.rig.prepareImpostors(this.stage.renderer, def, this.captureLight());
    for (let l = 0; l < 4; l++) {
      this.pushManOrRider(def, this.state.hash, l as 0 | 1 | 2 | 3, LADDER_X[l], 0, 0, this.state.phase);
    }
  }

  /**
   * Twenty-four men, six to a rank, at the roster's own 0.86 m lateral spacing.
   *
   * Each man's hash comes from his index, so the spread is the spread this unit type actually
   * produces. Phase offset and stature use the render system's own salts, because a rank in
   * exact lockstep at identical height is the loudest instancing tell there is — hiding it
   * here would make the viewer flatter than the game and useless for judging variance.
   */
  private composeRank(def: UnitTypeDef): void {
    const cav = isCavalry(def);
    const cols = cav ? 4 : 6;
    const rows = cav ? 2 : 4;
    const dx = cav ? 1.5 : 0.86;
    const dz = cav ? 2.4 : 0.95;
    if (this.state.lod === 3) this.rig.prepareImpostors(this.stage.renderer, def, this.captureLight());
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const variant = hash01(r * cols + c + 1, 17);
        const phase = (this.state.phase + this.manVary(variant).phaseOff) % 1;
        this.pushManOrRider(
          def, variant, this.state.lod,
          (c - (cols - 1) / 2) * dx, -r * dz, 0, phase
        );
      }
    }
  }

  private composeEngine(def: UnitTypeDef, dt: number): void {
    const s = this.state;
    const kind = this.kindOf(def);
    // Shots per minute back to a gap in seconds. A unit with no missile block still gets a
    // sane clock so the machine can be scrubbed.
    const reload = def.missile ? 60 / Math.max(1, def.missile.rate) : 12;
    if (s.engineCycle) {
      this.engineT += dt * s.speed;
      if (this.engineT > reload + 2) this.engineT = 0;
    }
    const n = s.battery ? 3 : 1;
    const pitch = kind === EngineKind.Onager ? 6.2 : 4.4;
    for (let k = 0; k < n; k++) {
      const view: EngineView = {
        kind,
        x: (k - (n - 1) / 2) * pitch,
        z: 0,
        yaw: 0,
        elev: 0.12,
        // Staggered, because a battery photographed at a random moment shows one gun wound,
        // one loading and one on the winch — synchronised guns are the tell that they are props.
        sinceShot: s.engineCycle
          ? (this.engineT + k * reload * 0.37) % (reload + 2)
          : this.drawToTime(s.engineDraw, reload),
        reload,
        variant: hash01(k + 3, 41),
        abandoned: false,
      };
      const pose = this.engines.push(view);
      if (!s.engineCrew) continue;
      const crew = this.engines.crew(view, pose);
      for (let c = 0; c < crew.length; c++) {
        const variant = hash01(k * 11 + c + 5, 29);
        this.rig.pushMan(this.man(
          def, variant, Math.min(2, s.lod) as 0 | 1 | 2,
          crew[c].x, 0, crew[c].z, crew[c].yaw, crew[c].clip,
          (this.engineT * 0.8 + variant) % 1,
          def.appearance.heightScale * this.manVary(variant).scale
        ));
      }
    }
  }

  /**
   * Invert the winch ramp so the Draw slider means what it says.
   *
   * `enginePose` is a function of time since the shot, not of draw, and its wind segment eases
   * with a smoothstep — so feeding it a linear time would make the slider's middle third cover
   * most of the visible travel. Bisection rather than algebra: sixteen iterations of a
   * monotone function once a frame is free, and it survives the ramp being re-shaped.
   */
  private drawToTime(draw: number, reload: number): number {
    if (draw >= 0.999) return reload + 1.5;
    let lo = 0;
    let hi = reload + 2;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (enginePose(mid, reload, this.poseProbe).draw < draw) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private advance(dt: number): void {
    const s = this.state;
    if (!s.playing) return;
    const f = this.rig.manFacts[s.clip];
    s.phase += (dt * s.speed) / Math.max(0.05, f.duration);
    // `%` keeps the sign of the dividend, so wrap into [0,1) explicitly rather than trusting it.
    if (f.loop) s.phase = ((s.phase % 1) + 1) % 1;
    else if (s.phase >= 1 || s.phase < 0) s.phase = 0;
    // Writing the slider every frame is 60 DOM mutations a second for a control nobody is
    // reading that precisely.
    if (Math.abs(s.phase - this.lastPhaseShown) > 0.01) {
      this.lastPhaseShown = s.phase;
      this.sync.phase?.(s.phase);
    }
  }

  private updateTags(): void {
    const want = this.state.mode === 'lod' ? 4 : 0;
    while (this.tags.length < want) {
      const t = document.createElement('div');
      t.className = 'vw-tag';
      this.tagLayer.append(t);
      this.tags.push(t);
    }
    for (let i = 0; i < this.tags.length; i++) {
      this.tags[i].style.display = i < want ? '' : 'none';
    }
    if (!want) return;

    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    const edges = [
      `to ${(LOD_FRACTION[0] * LOD_FAR_HIGH).toFixed(0)} m`,
      `to ${(LOD_FRACTION[1] * LOD_FAR_HIGH).toFixed(0)} m`,
      `to ${(LOD_FRACTION[2] * LOD_FAR_HIGH).toFixed(0)} m`,
      'beyond',
    ];
    for (let i = 0; i < want; i++) {
      this.project.set(LADDER_X[i], 2.05, 0).project(this.stage.camera);
      this.tags[i].style.left = `${(this.project.x * 0.5 + 0.5) * rect.width}px`;
      this.tags[i].style.top = `${(-this.project.y * 0.5 + 0.5) * rect.height}px`;
      const tris = this.rig.triangles(this.def.faction, i as 0 | 1 | 2 | 3);
      // "union", not "tris": the header beside it prints the drawn figure, and two different
      // numbers under one word 2x apart is how a reviewer budgets a man at the wrong cost.
      this.tags[i].innerHTML = i === 3
        ? `<b>${LOD_LABELS[i]}</b>\n2 tris\n${edges[i]}`
        : `<b>${LOD_LABELS[i]}</b>\nunion ${tris.toLocaleString()}\n${edges[i]}`;
    }
  }

  /** The clip a standing scale check should be measured on. */
  private get idleClip(): number {
    return this.rig.manFacts.find((c) => c.name === 'idleAlertReady')?.index ?? 0;
  }

  /**
   * How many screen pixels tall a 1.75 m man is at a given range, at the current lens and
   * viewport. A switch distance in metres is not a judgement you can make without it.
   */
  private pixelsAt(distance: number): number {
    const h = this.stage.renderer.domElement.clientHeight;
    const fovY = (this.stage.camera.fov * Math.PI) / 180;
    return (1.75 / (2 * distance * Math.tan(fovY / 2))) * h;
  }

  private drawnAs(def: UnitTypeDef): string {
    if (this.state.mode === 'engine') {
      return `${this.kindOf(def) === EngineKind.Onager ? 'onager' : 'scorpio'} + crew (soldier mesh)`;
    }
    if (isCavalry(def)) return 'soldier mesh + horse mesh';
    return 'soldier mesh, on foot';
  }

  private updateReadout(): void {
    const s = this.state;
    const def = this.def;
    const info = this.stage.renderer.info.render;
    const f = this.rig.manFacts[s.clip];
    const meshes = [...this.rig.drawnMeshes(), ...this.engines.drawnMeshes()];
    const instances = meshes.reduce((a, m) => a + m.count, 0);
    const soloName = s.lod === 2 ? COARSE_NAMES[s.solo] : PIECE_NAMES[s.solo];

    const present = this.presentPieces();
    const meshLod = Math.min(2, s.lod) as 0 | 1 | 2;
    const scale = def.appearance.heightScale * this.manVary(s.hash).scale;

    const lines: string[] = [];
    lines.push(`<b>${def.name}</b>  ${def.nativeName}`);
    lines.push(`${FACTIONS[def.faction]?.shortName ?? `faction ${def.faction}`} · ${def.unitClass} · ${def.strength} men`);
    // What geometry the pipeline actually produces for this roster entry, spelled out.
    //
    // Not decoration. `unitClass` is what the *simulation* needs; the mesh path is chosen
    // separately, and the two can disagree while a new unit is being wired up. War Elephants
    // are classed `heavy-cavalry` so that the sim pushes and kills them like a mount — which
    // means, until an elephant mesh exists, the renderer draws them as a man on a horse. A
    // viewer that quietly showed a horse there would be lying about the state of the project.
    lines.push(`drawn as  ${this.drawnAs(def)}`);
    lines.push('');
    if (s.mode === 'engine') {
      const kind = this.kindOf(def);
      lines.push(`machine   ${kind === EngineKind.Onager ? 'onager' : 'scorpio'} · ${this.engines.triangles(kind).toLocaleString()} tris`);
      lines.push(`crew      ${s.engineCrew ? 'shown' : 'hidden'} · ${s.engineCycle ? 'cycling' : `draw ${s.engineDraw.toFixed(2)}`}`);
    } else if (s.lod === 3) {
      lines.push('tier      IMPOSTOR · 2 tris · billboard captured from LOD1 at 8 yaws');
      // Both measured off this viewer's own plates and both are the pipeline's, not the
      // viewer's — which is the point of showing the tier at all.
      lines.push('          <span class="vw-bad">casts no shadow</span> (no depth material) and reads darker than the');
      lines.push('          mesh tiers. Not measured in-app — compare it yourself in LOD view.');
    } else {
      // Three different triangle numbers, and conflating them is how a viewer lies.
      //
      //   union   the whole faction geometry, shared by every man of that faction
      //   drawn   what THIS man's kit mask actually rasterises
      //   scene   what the renderer reports, which double-counts for the shadow pass and
      //           includes the floor and the measuring rule
      const union = this.rig.triangles(def.faction, meshLod);
      const drawn = this.rig.drawnTriangles(def.faction, meshLod, present);
      lines.push(`tier      ${LOD_LABELS[s.lod]} · union ${union.toLocaleString()} · <b>drawn ${drawn.toLocaleString()}</b> for this kit (${((drawn / Math.max(1, union)) * 100).toFixed(0)}%)`);
      // Two heights, because they answer different questions: the standing figure is the one
      // to check a scale review against, the current frame is the one on screen.
      const rest = this.rig.restStature(def.faction, this.idleClip, scale);
      const now = this.rig.statureAt(def.faction, s.clip, s.phase, scale);
      lines.push(`stature   ${rest.toFixed(3)} m standing · ${now.toFixed(3)} m this frame · scale ${scale.toFixed(3)}`);
      lines.push(`rig       ${MAN_RIG.boneCount} bones · 2 influences max per vertex${s.skeleton ? ` · overlay at frame ${Math.floor(s.phase * f.frames)}` : ''}`);
      lines.push(`clip      ${f.name} · ${f.frames}f · ${f.duration.toFixed(2)}s · ${f.loop ? 'loop' : 'one-shot'}`);
      lines.push(`playhead  ${s.phase.toFixed(3)} · frame ${Math.floor(s.phase * f.frames)}/${f.frames}${f.hitFrame >= 0 ? ` · hit@${f.hitFrame.toFixed(2)}` : ''}`);
      if (isCavalry(def)) {
        const g = this.rig.horseFacts[s.gait];
        const sr = this.rig.seatReport(s.gait, s.clip, scale);
        lines.push(`mount     ${g.name} · ${this.rig.horseTriangles(meshLod).toLocaleString()} tris`);
        // The number that actually varies is the saddle's travel; the clearance is a constant
        // *by construction*, because the solve subtracts the rider's own clip-mean pelvis from
        // the animated saddle height. Presenting that constant as a PASS was dressing an
        // identity up as a test — it could never fail, on any mount, for any rider. What is
        // worth showing is that the saddle moves this far and the rider tracks all of it.
        lines.push(`saddle    ${sr.low.toFixed(3)}-${sr.high.toFixed(3)} m over ${sr.frames}f · ${((sr.high - sr.low) * 100).toFixed(1)} cm of travel through the gait`);
        lines.push(`seat      rider pelvis pinned ${(sr.clearance * 100).toFixed(1)} cm above it, by construction — not a measurement`);
      }
    }
    lines.push(`hash      ${s.hash.toFixed(4)} <span class="vw-dim">(type a value in the panel to reproduce a man exactly)</span>`);
    lines.push(`coverage  a 1.75 m man is ${this.pixelsAt(LOD_FRACTION[0] * LOD_FAR_HIGH).toFixed(0)} px at 31 m · ${this.pixelsAt(LOD_FRACTION[1] * LOD_FAR_HIGH).toFixed(0)} px at 88 m · ${this.pixelsAt(LOD_FRACTION[2] * LOD_FAR_HIGH).toFixed(1)} px at 440 m`);
    lines.push('');
    // `renderer.info.render.triangles` counts every pass. The floor and the 2 m rule are in
    // there too, so it is a load proxy and not a model measurement — say so rather than let
    // someone quote it as an asset cost.
    // `renderer.info` counts submitted index-buffer triangles across every pass, so for an
    // instanced kit-union mesh it is union x instances x passes and overstates the real
    // rasterised load ~3x. The rig counts what the masks actually admit.
    const sceneDrawn = this.rig.drawnTotal + this.engines.drawnTotal;
    lines.push(`subject   ${instances} instances · <b>${sceneDrawn.toLocaleString()} tris rasterised</b> (models only — the floor and the rule are not counted)`);
    // `calls` looks like a constant and is not: it is one draw per tier however many men are
    // in it, which is what instancing buys and the single most load-bearing fact about this
    // renderer. Said out loud, because a reviewer who reads 26 draws for 1 man and 26 for 24
    // reasonably concludes the counter is broken.
    lines.push(`frame     ${info.calls} draws (instanced: one per tier, not per man) · ${info.triangles.toLocaleString()} tris submitted, all passes`);
    lines.push(`          ${this.frameMs.toFixed(2)} ms mean over 0.35 s · ${this.fps.toFixed(0)} fps <span class="vw-dim">(display-capped; the ms is a mean, so it does not quantise)</span>`);
    lines.push(`view      ${this.stage.lightPreset} light${s.parts ? ` · ${['', 'PIECE IDs', 'BONE IDs', 'WEIGHTS'][s.parts]}` : ''}${s.hidden.size ? ` · ${s.hidden.size} hidden` : ''}`);

    // The whole point of soloing is to distinguish "this man does not wear one" from "the
    // geometry is missing", and an empty frame cannot tell you which. The mask can, so say it.
    if (s.solo >= 0) {
      const worn = present.includes(s.solo);
      const tris = this.rig.pieceTriangles(def.faction, meshLod).get(s.solo) ?? 0;
      lines.push(worn
        ? `<b>SOLO ${soloName ?? s.solo}</b> · ${tris.toLocaleString()} tris authored · this piece IS in this man's mask, so an empty frame means the geometry is missing.`
        : `<span class="vw-bad">SOLO ${soloName ?? s.solo}</span> · ${tris.toLocaleString()} tris authored · this piece is NOT in this man's mask, so an empty frame is correct. Reroll the hash to find a man who wears it.`);
    }
    if (instances === 0) {
      lines.push('<span class="vw-bad">nothing drawn — the piece filter removed every instance</span>');
    }
    if (this.copied > 0) lines.push('<b>report copied to the clipboard</b>');
    this.readout.innerHTML = lines.join('\n');
    // Kept as plain text so "Copy report" hands over something a ticket can hold.
    this.lastReport = lines.join('\n').replace(/<[^>]+>/g, '');
  }

  start(): void {
    let last = performance.now();
    const loop = (now: number): void => {
      // Clamped at both ends. The upper bound stops a backgrounded tab resuming with a
      // half-second step; the lower bound matters because `performance.now()` can go
      // backwards across a tab suspend, and a negative dt ran the playhead below zero and
      // printed a negative frame number.
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      this.fpsAccum += dt;
      this.fpsFrames++;
      if (this.fpsAccum > 0.35) {
        this.fps = this.fpsFrames / this.fpsAccum;
        this.frameMs = (this.fpsAccum / this.fpsFrames) * 1000;
        this.fpsAccum = 0;
        this.fpsFrames = 0;
      }
      this.advance(dt);
      this.compose(dt);
      this.stage.render();
      this.updateTags();
      if (this.copied > 0) this.copied -= dt;
      this.readoutAccum += dt;
      if (this.readoutAccum > 0.12) {
        this.readoutAccum = 0;
        this.updateReadout();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize(): void {
    const canvas = this.stage.renderer.domElement;
    this.stage.resize(canvas.clientWidth, canvas.clientHeight);
  }

  /** Harness API — see `window.__viewer`. */
  api(): Record<string, unknown> {
    return {
      setUnit: (id: string): void => {
        this.state.unitId = id;
        this.onUnitChanged(true);
      },
      setMode: (m: Mode): void => {
        this.state.mode = m;
        this.syncPanel();
        this.frameSubject();
      },
      setLod: (l: 0 | 1 | 2 | 3): void => {
        this.state.lod = l;
        this.syncPanel();
      },
      setClipByName: (name: string): boolean => {
        const f = this.rig.manFacts.find((c) => c.name === name);
        if (!f) return false;
        this.state.clip = f.index;
        this.syncPanel();
        return true;
      },
      setGaitByName: (name: string): boolean => {
        const f = this.rig.horseFacts.find((c) => c.name === name);
        if (!f) return false;
        this.state.gait = f.index;
        this.syncPanel();
        return true;
      },
      setPhase: (p: number): void => {
        this.state.phase = p;
        this.state.playing = false;
        this.sync.phase?.(p);
        this.syncPanel();
      },
      setPlaying: (p: boolean): void => {
        this.state.playing = p;
        this.sync.play?.(p);
      },
      setParts: (mode: boolean | number): void => this.setParts(typeof mode === 'number' ? mode : (mode ? 1 : 0)),
      setHash: (h: number): void => {
        this.state.hash = h;
        this.syncPanel();
      },
      setLight: (p: LightPreset): void => {
        this.state.preset = p;
        this.stage.setLightPreset(p);
        this.syncPanel();
      },
      setEngineKind: (k: KindChoice): void => {
        this.state.engineKind = k;
        this.syncPanel();
        this.frameSubject();
      },
      setFlag: (k: keyof State, v: boolean): void => {
        (this.state as unknown as Record<string, boolean>)[k as string] = v;
        if (k === 'ground') this.stage.setGroundVisible(v);
        if (k === 'gauge') this.stage.setGaugeVisible(v);
        if (k === 'shadows') this.stage.setShadows(v);
        if (k === 'turntable') this.stage.setTurntable(v);
        if (k === 'wireframe') this.setWireframe(v);
        if (k === 'longLens') { this.stage.setLongLens(v); this.frameSubject(); }
        this.syncPanel();
      },
      solo: (id: number): void => this.solo(id),
      frame: (): void => this.frameSubject(),
      /**
       * Set up one *plate*: a single man, deterministically posed and framed, on a
       * neutral ground under the game's own light. This is the whole of the isolated-model
       * capture harness's contract with the viewer (`tools/shoot-model.mjs`).
       *
       * `fill` is the fraction of frame height the man's own bounding box should occupy, so
       * the harness can match a Rome II press-plate crop's magnification rather than
       * guessing a camera distance. `azimuth` is measured from the man's front.
       */
      plate: (o: {
        unit: string; hash: number; lod?: 0 | 1 | 2 | 3;
        clip?: string; phase?: number;
        azimuth?: number; elevation?: number; fill?: number; aimY?: number;
        light?: LightPreset; chrome?: boolean; graded?: boolean;
      }): void => {
        const s = this.state;
        s.unitId = o.unit;
        s.hash = o.hash;
        s.lod = o.lod ?? 0;
        s.mode = 'single';
        s.playing = false;
        s.parts = 0;
        s.skeleton = false;
        s.wireframe = false;
        s.turntable = false;
        s.solo = -1;
        s.hidden.clear();
        this.onUnitChanged(false);
        if (o.clip) {
          const f = this.rig.manFacts.find((c) => c.name === o.clip);
          if (f) s.clip = f.index;
        }
        s.phase = o.phase ?? 0.32;
        s.preset = o.light ?? 'field';
        this.stage.setPlate(o.chrome === false || o.chrome === undefined);
        if (o.light) this.stage.setLightPreset(o.light);
        // Graded by default. An ungraded plate photographs the absence of the game's
        // output chain rather than the model — see `grade.ts`.
        this.stage.setGraded(o.graded !== false);
        this.framePlate(o.azimuth ?? -0.85, o.elevation ?? 0.06, o.fill ?? 0.86, o.aimY);
        this.syncPanel();
      },
      /** Re-aim without rebuilding the man — the turntable, one angle per call. */
      plateAim: (azimuth: number, elevation: number, fill: number, aimY?: number): void =>
        this.framePlate(azimuth, elevation, fill, aimY),
      /** Restore an exact camera, for a pasted reproduction block. */
      camera: (cx: number, cy: number, cz: number, tx: number, ty: number, tz: number): void => {
        this.stage.controls.target.set(tx, ty, tz);
        this.stage.camera.position.set(cx, cy, cz);
        this.stage.controls.update();
      },
      report: (): string => this.lastReport,
      orbit: (az: number, el: number, dist: number): void => {
        const t = this.stage.controls.target;
        this.stage.camera.position.set(
          t.x + Math.sin(az) * Math.cos(el) * dist,
          t.y + Math.sin(el) * dist,
          t.z + Math.cos(az) * Math.cos(el) * dist
        );
        this.stage.controls.update();
      },
      units: (): { id: string; name: string; faction: number; unitClass: string }[] =>
        ALL_UNITS.map((u) => ({ id: u.id, name: u.name, faction: u.faction, unitClass: u.unitClass })),
      clips: (): string[] => this.rig.manFacts.map((c) => c.name),
      gaits: (): string[] => this.rig.horseFacts.map((c) => c.name),
      stats: (): Record<string, number> => {
        const info = this.stage.renderer.info.render;
        const meshes = [...this.rig.drawnMeshes(), ...this.engines.drawnMeshes()];
        return {
          instances: meshes.reduce((a, m) => a + m.count, 0),
          draws: info.calls,
          triangles: info.triangles,
          fps: this.fps,
          trisPerMan: this.rig.triangles(this.def.faction, this.state.lod),
          rasterised: this.rig.drawnTotal + this.engines.drawnTotal,
          phase: this.state.phase,
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const panelRoot = document.getElementById('viewer-panel') as HTMLElement;
const readout = document.getElementById('viewer-readout') as HTMLElement;
const boot = document.getElementById('viewer-boot') as HTMLElement;

const viewer = new Viewer(canvas, panelRoot, readout);
viewer.resize();
window.addEventListener('resize', () => viewer.resize());
viewer.start();
boot.classList.add('vw-gone');

// The same contract as the game's `window.__game`: a stable handle for screenshot harnesses
// and probes, so a regression in the viewer can be caught the way one in the battle is.
(window as unknown as { __viewer: Record<string, unknown> }).__viewer = {
  ready: true,
  ...viewer.api(),
};
