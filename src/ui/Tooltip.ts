/**
 * The rich unit tooltip: the full stat block, flavour text and the unit's formation
 * and ability list.
 *
 * Content is rebuilt from scratch each time it is shown. That is fine — showing a
 * tooltip is a human-speed event, and it keeps the per-frame path free of any of this.
 */

import { formation } from '../sim/formations';
import { html, icon } from './dom';
import { abilityIcon, formationGlyph, standardGlyph, UNIT_CLASS_ICON } from './icons';
import type { UnitView } from './model';
import { drawPortrait } from './portrait';
import { abilityUI, FACTION_UI, MORALE_UI, ORDER_LABEL, UNIT_CLASS_LABEL } from './theme';

/** Ceilings used to normalise the stat bars, taken from the top of the roster's range. */
const MAX = {
  attack: 66,
  damage: 44,
  ap: 22,
  defence: 54,
  armour: 70,
  shield: 40,
  charge: 54,
  vsCav: 32,
  morale: 100,
  discipline: 1.8,
  walk: 3,
  run: 8.4,
  reach: 2.8,
  range: 340,
  mdamage: 92,
};

interface Row {
  label: string;
  value: string;
  frac: number;
  /** Renders in the accent colour — used for the stat that defines the unit. */
  hot?: boolean;
}

function rowsFor(v: UnitView): Array<{ head: string; rows: Row[] }> {
  const d = v.def;
  const groups: Array<{ head: string; rows: Row[] }> = [
    {
      head: 'Melee',
      rows: [
        { label: 'Attack', value: String(d.meleeAttack), frac: d.meleeAttack / MAX.attack },
        { label: 'Damage', value: String(d.meleeDamage), frac: d.meleeDamage / MAX.damage },
        { label: 'AP damage', value: String(d.apDamage), frac: d.apDamage / MAX.ap },
        { label: 'Defence', value: String(d.meleeDefence), frac: d.meleeDefence / MAX.defence },
        { label: 'Reach', value: `${d.reach.toFixed(1)} m`, frac: d.reach / MAX.reach },
      ],
    },
    {
      head: 'Protection',
      rows: [
        { label: 'Armour', value: String(d.armour), frac: d.armour / MAX.armour },
        { label: 'Shield', value: d.shieldDefence ? String(d.shieldDefence) : '—', frac: d.shieldDefence / MAX.shield },
      ],
    },
    {
      head: 'Charge',
      rows: [
        { label: 'Charge bonus', value: String(d.chargeBonus), frac: d.chargeBonus / MAX.charge, hot: d.chargeBonus >= 36 },
        { label: 'Versus cavalry', value: String(d.bonusVsCavalry), frac: d.bonusVsCavalry / MAX.vsCav, hot: d.bonusVsCavalry >= 22 },
      ],
    },
    {
      head: 'Spirit',
      rows: [
        { label: 'Morale', value: String(d.morale), frac: d.morale / MAX.morale, hot: d.morale >= 88 },
        { label: 'Discipline', value: d.discipline.toFixed(2), frac: d.discipline / MAX.discipline },
      ],
    },
    {
      head: 'March',
      rows: [
        { label: 'Walk', value: `${d.walkSpeed.toFixed(1)} m/s`, frac: d.walkSpeed / MAX.walk },
        { label: 'Run', value: `${d.runSpeed.toFixed(1)} m/s`, frac: d.runSpeed / MAX.run },
        { label: 'Stamina', value: `${d.stamina}s`, frac: d.stamina / 95 },
      ],
    },
  ];

  if (d.missile) {
    groups.splice(3, 0, {
      head: `Missile · ${d.missile.kind}`,
      rows: [
        { label: 'Range', value: `${d.missile.range} m`, frac: d.missile.range / MAX.range, hot: d.missile.range >= 160 },
        { label: 'Damage', value: String(d.missile.damage), frac: d.missile.damage / MAX.mdamage },
        { label: 'AP damage', value: String(d.missile.apDamage), frac: d.missile.apDamage / MAX.mdamage },
        { label: 'Ammunition', value: String(d.missile.ammo), frac: Math.min(1, d.missile.ammo / 30) },
      ],
    });
  }
  return groups;
}

export class Tooltip {
  private root: HTMLElement;
  private shownFor = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tip';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  hide(): void {
    if (this.root.style.display !== 'none') this.root.style.display = 'none';
    this.shownFor = -1;
  }

  /**
   * Show the tooltip anchored above `anchor`. `live` adds the unit's current condition
   * on top of the static stat block.
   */
  show(v: UnitView, anchor: DOMRect, viewW: number, viewH: number): void {
    const d = v.def;
    const fui = FACTION_UI[v.faction];
    const groups = rowsFor(v);

    let statHtml = '';
    for (const g of groups) {
      statHtml += `<div class="tip-grp"><div class="tip-head">${g.head}</div>`;
      for (const r of g.rows) {
        const pct = Math.max(0, Math.min(1, r.frac)) * 100;
        statHtml +=
          `<div class="tip-row${r.hot ? ' hot' : ''}">` +
          `<span class="tip-lab">${r.label}</span>` +
          `<span class="tip-track"><i style="width:${pct.toFixed(1)}%"></i></span>` +
          `<span class="tip-val">${r.value}</span></div>`;
      }
      statHtml += `</div>`;
    }

    const forms = d.formations
      .map((f) => {
        const fd = formation(f);
        const cur = v.unit.formationId === f;
        return `<span class="tip-chip${cur ? ' cur' : ''}" title="${fd.description}">${icon(formationGlyph(f), 'chip-ic')}${fd.name}</span>`;
      })
      .join('');

    const abils = d.abilities
      .map((a) => {
        const au = abilityUI(a);
        return `<span class="tip-chip">${icon(abilityIcon(a), 'chip-ic')}${au.name}</span>`;
      })
      .join('');

    const mor = MORALE_UI[v.morale];
    html(
      this.root,
      `<div class="tip-top">
         <div class="tip-por"><canvas></canvas></div>
         <div class="tip-id">
           <div class="tip-name">${v.title}</div>
           <div class="tip-native">${d.nativeName}</div>
           <div class="tip-meta">
             ${icon(standardGlyph(v.faction), 'tip-std')}
             <span>${fui.short}</span><span class="tip-dot">·</span>
             <span>${UNIT_CLASS_LABEL[d.unitClass]}</span>
           </div>
           <div class="tip-live">
             <span>${v.alive} / ${v.initial} men</span>
             <span class="tip-dot">·</span>
             <span style="color:${mor.colour}">${mor.label}</span>
             <span class="tip-dot">·</span>
             <span>${ORDER_LABEL[v.order]}</span>
             ${v.kills > 0 ? `<span class="tip-dot">·</span><span>${v.kills} kills</span>` : ''}
           </div>
         </div>
       </div>
       <div class="tip-stats">${statHtml}</div>
       <div class="tip-flavour">${d.description}</div>
       <div class="tip-chips"><div class="tip-head">Formations</div>${forms}</div>
       ${abils ? `<div class="tip-chips"><div class="tip-head">Abilities</div>${abils}</div>` : ''}`
    );

    const c = this.root.querySelector('canvas') as HTMLCanvasElement | null;
    if (c) {
      const cw = 62;
      const ch = 78;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      c.style.width = `${cw}px`;
      c.style.height = `${ch}px`;
      const g = c.getContext('2d');
      if (g) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawPortrait(g, cw, ch, d);
      }
    }

    this.root.dataset.f = fui.key;
    this.root.style.display = 'block';
    this.root.style.visibility = 'hidden';
    // One layout read per show is acceptable; this never happens inside a frame budget.
    const r = this.root.getBoundingClientRect();
    let left = anchor.left + anchor.width * 0.5 - r.width * 0.5;
    left = Math.max(8, Math.min(viewW - r.width - 8, left));
    let top = anchor.top - r.height - 12;
    if (top < 8) top = Math.min(viewH - r.height - 8, anchor.bottom + 12);
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    this.root.style.visibility = 'visible';
    this.shownFor = v.id;
  }

  get visibleFor(): number {
    return this.shownFor;
  }
}
