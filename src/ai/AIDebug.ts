import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { Faction, UnitOrder } from '../sim/types';
import type { AIWorld } from './AIWorld';
import type { GeneralAISystem } from './GeneralAI';
import type { PathfindingSystem } from './Pathfinding';
import type { TacticalAISystem } from './TacticalAI';
import { AIProfile, setAIProfiling } from './profile';

/**
 * F3 overlay: everything the AI currently believes, drawn on the ground.
 *
 * Off by default and genuinely free when off — the scene objects are not created until
 * the first press, and `update` returns on the first line. When on it draws:
 *
 *   - the navigation grid, coloured by movement cost, with impassable cells in red
 *   - each unit's chosen path or destination, in its faction colour
 *   - a threat bar over every unit and a marker on whatever it has decided to attack
 *   - each general's target of main effort, its line, and its reserve's objective
 *   - a text panel with the phase, the plan and the measured AI cost per tick
 */

const KEY = 'F3';
/** Draw every Nth nav cell — the full 401x401 grid is more dots than information. */
const GRID_STRIDE = 3;
/** Line vertices reserved for the dynamic overlay (paths, threats, markers). */
const MAX_LINE_VERTS = 24000;

const COL_ROME = new THREE.Color(0xd8462f);
const COL_GERM = new THREE.Color(0x4f8fd0);
const COL_EFFORT = new THREE.Color(0xffd34d);
const COL_THREAT = new THREE.Color(0xff5566);
const COL_PATH = new THREE.Color(0x7be0a0);
const COL_BLOCKED = new THREE.Color(0xff2b2b);

export class AIDebugSystem implements Subsystem {
  readonly name = 'ai-debug';
  readonly order = 46;

  private world: AIWorld;
  private tactical: TacticalAISystem;
  private general: GeneralAISystem;
  private nav!: PathfindingSystem;
  private battle!: BattleSystem;

  private enabled = false;
  private built = false;
  private group?: THREE.Group;
  private gridPoints?: THREE.Points;
  private lines?: THREE.LineSegments;
  private linePos?: Float32Array;
  private lineCol?: Float32Array;
  private panel?: HTMLDivElement;
  private vertCount = 0;
  private textTimer = 0;

  constructor(world: AIWorld, tactical: TacticalAISystem, general: GeneralAISystem) {
    this.world = world;
    this.tactical = tactical;
    this.general = general;
  }

  init(ctx: EngineContext): void {
    this.nav = ctx.get<PathfindingSystem>('pathfinding');
    this.battle = ctx.get<BattleSystem>('battle');
  }

  /** Programmatic toggle, used by the verification harness. */
  setEnabled(on: boolean, ctx: EngineContext): void {
    if (on === this.enabled) return;
    this.enabled = on;
    setAIProfiling(on);
    if (on && !this.built) this.build(ctx);
    if (this.group) this.group.visible = on;
    if (this.panel) this.panel.style.display = on ? 'block' : 'none';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  update(dt: number, ctx: EngineContext): void {
    if (ctx.input.keyPressed(KEY)) this.setEnabled(!this.enabled, ctx);
    if (!this.enabled) return;

    this.drawDynamic();
    this.textTimer += dt;
    if (this.textTimer > 0.25) {
      this.textTimer = 0;
      this.updatePanel();
    }
  }

  // -------------------------------------------------------------------------
  // Construction (first press only)
  // -------------------------------------------------------------------------

  private build(ctx: EngineContext): void {
    this.built = true;
    this.group = new THREE.Group();
    this.group.name = 'ai-debug';
    this.group.matrixAutoUpdate = false;

    // ---- Nav grid, coloured by cost ----
    const g = this.nav.grid;
    const cells: number[] = [];
    const cols: number[] = [];
    const cost = new THREE.Color();
    for (let cz = 0; cz < g.res; cz += GRID_STRIDE) {
      for (let cx = 0; cx < g.res; cx += GRID_STRIDE) {
        const i = cz * g.res + cx;
        const x = g.toWorld(cx);
        const z = g.toWorld(cz);
        cells.push(x, g.height[i] + 0.35, z);
        if (g.blocked[i]) {
          cols.push(COL_BLOCKED.r, COL_BLOCKED.g, COL_BLOCKED.b);
        } else {
          // Green on the flat through to orange on ground that will cost you.
          const t = Math.min(1, (g.cost[i] - 1) / 2.2);
          cost.setRGB(0.15 + t * 0.85, 0.75 - t * 0.5, 0.2);
          cols.push(cost.r, cost.g, cost.b);
        }
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(cells, 3));
    gridGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.gridPoints = new THREE.Points(
      gridGeo,
      new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: true, depthWrite: false })
    );
    this.gridPoints.name = 'ai-nav-grid';
    this.group.add(this.gridPoints);

    // ---- Dynamic lines ----
    this.linePos = new Float32Array(MAX_LINE_VERTS * 3);
    this.lineCol = new Float32Array(MAX_LINE_VERTS * 3);
    const lineGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.linePos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.lineCol, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('position', posAttr);
    lineGeo.setAttribute('color', colAttr);
    lineGeo.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 })
    );
    this.lines.name = 'ai-debug-lines';
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    ctx.scene.add(this.group);

    // ---- Text panel ----
    const panel = document.createElement('div');
    panel.id = 'ai-debug-panel';
    panel.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:50;font:11px/1.35 ui-monospace,Menlo,monospace;' +
      'color:#e8e2d2;background:rgba(12,12,14,0.72);padding:8px 10px;border-radius:4px;' +
      'white-space:pre;pointer-events:none;max-width:52ch;';
    (document.getElementById('hud-root') ?? document.body).appendChild(panel);
    this.panel = panel;
  }

  // -------------------------------------------------------------------------
  // Per-frame drawing
  // -------------------------------------------------------------------------

  private vertex(x: number, y: number, z: number, c: THREE.Color): void {
    if (!this.linePos || !this.lineCol) return;
    if (this.vertCount >= MAX_LINE_VERTS) return;
    const i = this.vertCount * 3;
    this.linePos[i] = x;
    this.linePos[i + 1] = y;
    this.linePos[i + 2] = z;
    this.lineCol[i] = c.r;
    this.lineCol[i + 1] = c.g;
    this.lineCol[i + 2] = c.b;
    this.vertCount++;
  }

  private segment(x1: number, z1: number, x2: number, z2: number, c: THREE.Color, lift = 1.2): void {
    this.vertex(x1, this.nav.groundHeight(x1, z1) + lift, z1, c);
    this.vertex(x2, this.nav.groundHeight(x2, z2) + lift, z2, c);
  }

  private cross(x: number, z: number, r: number, c: THREE.Color, lift = 1.5): void {
    this.segment(x - r, z, x + r, z, c, lift);
    this.segment(x, z - r, x, z + r, c, lift);
  }

  private drawDynamic(): void {
    if (!this.lines) return;
    this.vertCount = 0;

    for (const rec of this.world.info.values()) {
      const u = rec.unit;
      if (u.destroyed) continue;
      const col = u.faction === Faction.Rome ? COL_ROME : COL_GERM;

      // Front-rank bar, so formation width and facing are both readable.
      const rx = Math.cos(u.facing);
      const rz = -Math.sin(u.facing);
      this.segment(
        u.x - rx * rec.halfFront, u.z - rz * rec.halfFront,
        u.x + rx * rec.halfFront, u.z + rz * rec.halfFront,
        col, 2.0
      );
      // Facing tick.
      this.segment(u.x, u.z, u.x + Math.sin(u.facing) * 12, u.z + Math.cos(u.facing) * 12, col, 2.0);

      // Ordered destination, or the whole path if one was computed.
      const path = this.nav.pathFor(u.id);
      if (path && path.ok && path.n >= 2 && u.order !== UnitOrder.Hold) {
        for (let i = 1; i < path.n; i++) {
          this.segment(path.pts[(i - 1) * 2], path.pts[(i - 1) * 2 + 1], path.pts[i * 2], path.pts[i * 2 + 1], COL_PATH, 1.0);
        }
      } else if (u.order !== UnitOrder.Hold) {
        this.segment(u.x, u.z, u.targetX, u.targetZ, COL_PATH, 1.0);
      }

      // Threat bar: length proportional to the pressure the unit feels.
      if (rec.threat > 0.01) {
        const len = Math.min(40, rec.threat * 26);
        this.segment(u.x - 3, u.z, u.x - 3 + len, u.z, COL_THREAT, 6);
      }
      // Who we are attacking.
      if (u.order === UnitOrder.AttackUnit && u.targetUnitId >= 0) {
        const t = this.battle.unitById(u.targetUnitId);
        if (t && !t.destroyed) this.segment(u.x, u.z, t.x, t.z, COL_THREAT, 3.2);
      }
    }

    // Army-level intent.
    for (const f of [Faction.Rome, Faction.Germanic] as Faction[]) {
      const plan = this.general.planOf(f);
      if (!plan) continue;
      const col = f === Faction.Rome ? COL_ROME : COL_GERM;
      const rx = Math.cos(plan.lineFacing);
      const rz = -Math.sin(plan.lineFacing);
      // The intended line.
      this.segment(
        plan.lineX - rx * plan.lineHalf, plan.lineZ - rz * plan.lineHalf,
        plan.lineX + rx * plan.lineHalf, plan.lineZ + rz * plan.lineHalf,
        col, 8
      );
      // Target of main effort, and the axis from the line to it.
      this.cross(plan.effortX, plan.effortZ, 16, COL_EFFORT, 9);
      this.segment(plan.lineX, plan.lineZ, plan.effortX, plan.effortZ, COL_EFFORT, 8.5);
      if (plan.reserveCommitted) this.cross(plan.reserveTargetX, plan.reserveTargetZ, 10, col, 10);
    }

    const geo = this.lines.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, this.vertCount);
  }

  private updatePanel(): void {
    if (!this.panel) return;
    const lines: string[] = [];
    lines.push(
      `AI  path ${AIProfile.avg.pathfinding.toFixed(2)}  tac ${AIProfile.avg.tactical.toFixed(2)}  ` +
      `gen ${AIProfile.avg.general.toFixed(2)}  = ${AIProfile.totalAvg().toFixed(2)} ms  ` +
      `(peak ${AIProfile.totalPeak().toFixed(2)})`
    );
    const s = this.nav.stats;
    lines.push(
      `nav req ${s.requests} straight ${s.straightLine} astar ${s.searches} fail ${s.failures} ` +
      `narrow ${s.narrowRetries} q${s.queueDepth} nodes ${s.nodesLastTick} flows ${s.flowRebuilds} walls ${s.cityObstacles}`
    );
    for (const f of [Faction.Rome, Faction.Germanic] as Faction[]) {
      lines.push(`${f === Faction.Rome ? 'ROME' : 'JUTH'}  ${this.general.summary(f)}`);
    }
    lines.push('');
    for (const rec of this.world.info.values()) {
      const u = rec.unit;
      if (u.destroyed) continue;
      const tag = u.faction === Faction.Rome ? 'R' : 'J';
      lines.push(
        `${tag}${String(u.id).padStart(2)} ${u.typeId.slice(0, 16).padEnd(16)} ` +
        `${this.general.roleOf(u.id).padEnd(9)} ${this.tactical.describe(u.id).padEnd(16)} ` +
        `${String(u.alive).padStart(3)}m ${u.morale.toFixed(0).padStart(3)}mo ` +
        `${rec.inContact ? 'CONTACT' : `${rec.nearestEnemyDist.toFixed(0)}m`}`
      );
    }
    this.panel.textContent = lines.join('\n');
  }

  dispose(): void {
    this.gridPoints?.geometry.dispose();
    (this.gridPoints?.material as THREE.Material | undefined)?.dispose();
    this.lines?.geometry.dispose();
    (this.lines?.material as THREE.Material | undefined)?.dispose();
    this.panel?.remove();
    this.group?.parent?.remove(this.group);
  }
}
