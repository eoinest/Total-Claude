/**
 * Procedural unit portraits.
 *
 * Every unit card carries a bust drawn on a canvas rather than an imported image, so
 * nothing has to ship. The look is a struck bronze cameo: a faction-tinted plate with
 * engraved tooling, and a figure lit from the upper left by the same warm sun the
 * battlefield uses.
 *
 * The figure is painted part by part — shield, torso, cloak, head, helmet, crest — each
 * with its own tonal gradient and a hairline of near-black between it and its
 * neighbours. That separation is what makes the bust still read as a man in armour at
 * 44 px; a single flat silhouette at this size collapses into a blob.
 *
 * Every shape choice comes out of the unit's own `appearance` block, so a Praetorian
 * with a longitudinal crest and a scale cuirass and a bare-chested fanatic in a fur cap
 * are unmistakable from one another without a label.
 */

import { Faction, type UnitTypeDef } from '../sim/types';
import { FACTION_UI } from './theme';

/** Design box: everything below is authored in a 100 x 100 space. */
const BOX = 100;

const OUTLINE = 'rgba(7, 5, 3, 0.9)';

type G = CanvasRenderingContext2D;

// Tonal pairs: [lit, shadowed]. Warm on the sun side, cool in shadow.
const T = {
  iron: ['#a29c8c', '#494336'],
  bronze: ['#a38048', '#2a1d0b'],
  steel: ['#9ba196', '#282c25'],
  leather: ['#856039', '#2a1e12'],
  mail: ['#96968b', '#33332c'],
  cloth: ['#c2b28d', '#443c2e'],
  tunicRome: ['#c34145', '#521215'],
  tunicGerm: ['#79805e', '#282c1e'],
  cloakRome: ['#a33234', '#3a0f10'],
  cloakGerm: ['#5a6a7c', '#1f262e'],
  woodRome: ['#c84d51', '#5c1a1d'],
  woodGerm: ['#a99054', '#3d3218'],
  skin: ['#c69769', '#4a3120'],
  face: ['#a2794f', '#301c0c'],
  hair: ['#7a5530', '#20140a'],
  hairFair: ['#b18f5c', '#3a2812'],
  crestRome: ['#d2413a', '#54100e'],
  crestGerm: ['#9a8b66', '#31291b'],
  horn: ['#ddd2b0', '#4b422c'],
  shaft: ['#9b7749', '#332616'],
  blade: ['#dfe2d6', '#565850'],
  horse: ['#8b6a49', '#291e12'],
} as const;

type Tone = readonly [string, string];

// ---------------------------------------------------------------------------
// Painting helpers
// ---------------------------------------------------------------------------

function ellipse(g: G, cx: number, cy: number, rx: number, ry: number, rot = 0): void {
  g.moveTo(cx + rx * Math.cos(rot), cy + rx * Math.sin(rot));
  g.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
}

function roundBar(g: G, x1: number, y1: number, x2: number, y2: number, w: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * w * 0.5;
  const ny = (dx / l) * w * 0.5;
  g.moveTo(x1 + nx, y1 + ny);
  g.lineTo(x2 + nx, y2 + ny);
  g.lineTo(x2 - nx, y2 - ny);
  g.lineTo(x1 - nx, y1 - ny);
  g.closePath();
}

/**
 * Fill a shape with a top-left-to-bottom-right tonal ramp, outline it in near-black,
 * then run a warm rim over the outline on the lit side only. The rim is what stops a
 * stack of flat fills from reading as paper cut-outs.
 */
function paint(g: G, tone: Tone, build: (g: G) => void, outline = 1.5): void {
  g.beginPath();
  build(g);
  const grad = g.createLinearGradient(22, 4, 84, 96);
  grad.addColorStop(0, tone[0]);
  grad.addColorStop(1, tone[1]);
  g.fillStyle = grad;
  g.fill();
  if (outline <= 0) return;
  g.lineWidth = outline;
  g.strokeStyle = OUTLINE;
  g.stroke();
  const rim = g.createLinearGradient(16, -8, 80, 88);
  rim.addColorStop(0, 'rgba(255, 236, 192, 0.85)');
  rim.addColorStop(0.4, 'rgba(255, 226, 174, 0.16)');
  rim.addColorStop(1, 'rgba(255, 226, 174, 0)');
  g.lineWidth = outline * 0.75;
  g.strokeStyle = rim;
  g.stroke();
}

// ---------------------------------------------------------------------------
// Anatomy
// ---------------------------------------------------------------------------

function armourTone(def: UnitTypeDef): Tone {
  switch (def.appearance.armour) {
    case 'segmentata': return T.iron;
    case 'squamata': return T.bronze;
    case 'hamata': return T.mail;
    case 'leather': return T.leather;
    case 'cloth': return def.faction === Faction.Rome ? T.cloth : T.tunicGerm;
    default: return def.faction === Faction.Rome ? T.tunicRome : T.tunicGerm;
  }
}

function shoulders(g: G, def: UnitTypeDef): void {
  const heavy = def.armour >= 38;
  const halfW = heavy ? 38 : 32;
  const top = 71;
  g.moveTo(50 - halfW, BOX + 8);
  g.lineTo(50 - halfW, top + 9);
  g.quadraticCurveTo(50 - halfW + 2, top, 50 - halfW * 0.52, top - 2.5);
  g.quadraticCurveTo(50, top - 8, 50 + halfW * 0.52, top - 2.5);
  g.quadraticCurveTo(50 + halfW - 2, top, 50 + halfW, top + 9);
  g.lineTo(50 + halfW, BOX + 8);
  g.closePath();
}

function neck(g: G): void {
  g.moveTo(43.5, 75);
  g.lineTo(43.5, 56);
  g.lineTo(56.5, 56);
  g.lineTo(56.5, 75);
  g.closePath();
}

function skull(g: G): void {
  ellipse(g, 50, 44.6, 12.2, 14.4);
  g.moveTo(39.6, 47);
  g.quadraticCurveTo(41.2, 60, 50, 62);
  g.quadraticCurveTo(58.8, 60, 60.4, 47);
  g.closePath();
}

/** A trimmed third-century beard: by 271 the clean-shaven Augustan look is long gone. */
function shortBeard(g: G): void {
  g.moveTo(41.4, 51);
  g.quadraticCurveTo(40.6, 60.6, 50, 64.4);
  g.quadraticCurveTo(59.4, 60.6, 58.6, 51);
  g.quadraticCurveTo(55, 58.4, 50, 58.4);
  g.quadraticCurveTo(45, 58.4, 41.4, 51);
  g.closePath();
}

function beard(g: G): void {
  g.moveTo(40.4, 49.6);
  g.quadraticCurveTo(38.6, 66, 50, 72.4);
  g.quadraticCurveTo(61.4, 66, 59.6, 49.6);
  g.quadraticCurveTo(56, 56.6, 50, 56.6);
  g.quadraticCurveTo(44, 56.6, 40.4, 49.6);
  g.closePath();
}

function looseHair(g: G): void {
  g.moveTo(36.6, 50);
  g.quadraticCurveTo(34.4, 27, 50, 26);
  g.quadraticCurveTo(65.6, 27, 63.4, 50);
  g.quadraticCurveTo(60.4, 40, 56, 38);
  g.quadraticCurveTo(50, 42, 44, 38);
  g.quadraticCurveTo(39.6, 40, 36.6, 50);
  g.closePath();
}

/** The helmet bowl, minus cheek pieces and neck guard (drawn separately). */
function helmetBowl(g: G, def: UnitTypeDef): void {
  const k = def.appearance.helmet;
  if (k === 'fur-cap') {
    g.moveTo(36, 45);
    g.quadraticCurveTo(32.6, 22, 50, 21.4);
    g.quadraticCurveTo(67.4, 22, 64, 45);
    g.quadraticCurveTo(58, 38.6, 50, 39);
    g.quadraticCurveTo(42, 38.6, 36, 45);
    g.closePath();
    return;
  }
  if (k === 'spangenhelm') {
    g.moveTo(35.4, 47);
    g.lineTo(48.4, 19.6);
    g.lineTo(51.6, 19.6);
    g.lineTo(64.6, 47);
    g.lineTo(58.6, 43.4);
    g.lineTo(41.4, 43.4);
    g.closePath();
    return;
  }
  const brow = k === 'coolus' ? 41.5 : 40.5;
  g.moveTo(35.6, brow + 4.6);
  g.quadraticCurveTo(35, 27.4, 50, 26.2);
  g.quadraticCurveTo(65, 27.4, 64.4, brow + 4.6);
  g.lineTo(62.4, brow + 1.4);
  g.lineTo(37.6, brow + 1.4);
  g.closePath();
}

function helmetFittings(g: G, def: UnitTypeDef): void {
  const k = def.appearance.helmet;
  if (k === 'spangenhelm') {
    // Nasal bar down the face.
    roundBar(g, 50, 42, 50, 56, 4.4);
    return;
  }
  if (k === 'none' || k === 'fur-cap') return;
  const brow = k === 'coolus' ? 41.5 : 40.5;
  // Brow band: a narrow reinforcing strip, not a visor.
  g.moveTo(34.6, brow + 1);
  g.lineTo(65.4, brow + 1);
  g.lineTo(65.4, brow + 4.8);
  g.lineTo(34.6, brow + 4.8);
  g.closePath();
  if (k === 'coolus') return;
  // Cheek guards, kept narrow so the face stays open.
  g.moveTo(35.8, brow + 4.4);
  g.quadraticCurveTo(37.4, 60, 42.6, 61.6);
  g.quadraticCurveTo(40.4, 52, 40.8, brow + 4.4);
  g.closePath();
  g.moveTo(64.2, brow + 4.4);
  g.quadraticCurveTo(62.6, 60, 57.4, 61.6);
  g.quadraticCurveTo(59.6, 52, 59.2, brow + 4.4);
  g.closePath();
  // Neck guard flaring behind.
  g.moveTo(63.6, brow + 4);
  g.quadraticCurveTo(72.6, 52, 68, 58);
  g.quadraticCurveTo(64, 51, 60.4, brow + 9);
  g.closePath();
}

function crest(g: G, def: UnitTypeDef): boolean {
  switch (def.appearance.crest) {
    case 'transverse':
      g.moveTo(29.4, 31);
      g.quadraticCurveTo(50, 3.4, 70.6, 31);
      g.quadraticCurveTo(60.4, 21.6, 50, 21);
      g.quadraticCurveTo(39.6, 21.6, 29.4, 31);
      g.closePath();
      return true;
    case 'longitudinal':
      g.moveTo(44.6, 24);
      g.quadraticCurveTo(41.6, 5.6, 50, 3.6);
      g.quadraticCurveTo(58.4, 5.6, 55.4, 24);
      g.closePath();
      return true;
    case 'plume':
      g.moveTo(45.4, 24);
      g.quadraticCurveTo(35.4, 11, 42.6, 2);
      g.quadraticCurveTo(49.4, 11, 52, 6.4);
      g.quadraticCurveTo(56.6, 15.4, 54.6, 24);
      g.closePath();
      return true;
    case 'horns':
      g.moveTo(37.6, 35);
      g.quadraticCurveTo(19.6, 31.6, 13.6, 9.6);
      g.quadraticCurveTo(24.6, 23.6, 40.6, 27.4);
      g.closePath();
      g.moveTo(62.4, 35);
      g.quadraticCurveTo(80.4, 31.6, 86.4, 9.6);
      g.quadraticCurveTo(75.4, 23.6, 59.4, 27.4);
      g.closePath();
      return true;
    case 'feather':
      g.moveTo(59.6, 29);
      g.quadraticCurveTo(71.6, 17.6, 69.4, 5.6);
      g.quadraticCurveTo(62.4, 15.6, 56.6, 26.6);
      g.closePath();
      return true;
    default:
      return false;
  }
}

function cloak(g: G): void {
  g.moveTo(15, BOX + 8);
  g.quadraticCurveTo(6, 86, 20, 69);
  g.quadraticCurveTo(29, 61, 41, 66);
  g.lineTo(37, BOX + 8);
  g.closePath();
}

function shieldShape(g: G, def: UnitTypeDef): boolean {
  switch (def.appearance.shield) {
    case 'scutum':
      g.moveTo(-2, BOX + 8);
      g.lineTo(-2, 64);
      g.quadraticCurveTo(-1, 55, 9, 54);
      g.lineTo(29, 54);
      g.quadraticCurveTo(34, 60, 34, 71);
      g.lineTo(34, BOX + 8);
      g.closePath();
      return true;
    case 'oval':
      ellipse(g, 13, 84, 22, 29);
      return true;
    case 'hexagonal':
      g.moveTo(13, 53);
      g.lineTo(34, 63);
      g.lineTo(34, BOX + 8);
      g.lineTo(-8, BOX + 8);
      g.lineTo(-8, 63);
      g.closePath();
      return true;
    case 'round':
      ellipse(g, 12, 82, 24, 24);
      return true;
    default:
      return false;
  }
}

/** Returns the tone the weapon should be painted with, or null for no weapon. */
/** The weapon actually drawn — a sword is swapped for a polearm sidearm if there is one. */
function drawnWeapon(def: UnitTypeDef): string {
  const w = def.appearance.weapon;
  const side = def.appearance.sidearm;
  const polearm = side === 'pilum' || side === 'spear' || side === 'javelin' || side === 'framea';
  if ((w === 'gladius' || w === 'spatha') && polearm) return side as string;
  return w;
}

function weaponShaft(g: G, def: UnitTypeDef): boolean {
  const w = drawnWeapon(def);
  if (w === 'spear' || w === 'pike' || w === 'javelin' || w === 'framea' || w === 'pilum') {
    roundBar(g, 86, BOX + 8, 71, 19, 4);
    return true;
  }
  if (w === 'axe' || w === 'club') {
    roundBar(g, 82, BOX + 8, 71, 17, 4);
    return true;
  }
  if (w === 'bow') {
    roundBar(g, 74, 2, 74, 84, 3.4);
    return true;
  }
  // Sword held blade-up and canted out, so the blade clears the shoulder.
  roundBar(g, 72.4, 82, 87, 28, 4.6);
  return true;
}

function weaponHead(g: G, def: UnitTypeDef): boolean {
  const w = drawnWeapon(def);
  if (w === 'spear' || w === 'pike' || w === 'javelin' || w === 'framea' || w === 'pilum') {
    // Leaf blade with a shoulder, fully inside the frame.
    g.moveTo(71.4, 21);
    g.quadraticCurveTo(64.6, 12, 70.2, 1.6);
    g.quadraticCurveTo(77.6, 11, 75.2, 21);
    g.closePath();
    return true;
  }
  if (w === 'axe') {
    g.moveTo(71, 19);
    g.quadraticCurveTo(90, 12, 92, 32);
    g.quadraticCurveTo(81, 26, 72.6, 28);
    g.closePath();
    return true;
  }
  if (w === 'club') {
    ellipse(g, 70, 19, 9.6, 12, -0.2);
    return true;
  }
  if (w === 'bow') {
    // Recurved limb, drawn as a crescent outside the string.
    g.moveTo(74, 0);
    g.bezierCurveTo(92, 20, 92, 66, 74, 86);
    g.lineTo(79.4, 86);
    g.bezierCurveTo(97.4, 66, 97.4, 20, 79.4, 0);
    g.closePath();
    return true;
  }
  // Crossguard across the blade, plus a rounded pommel at the grip.
  roundBar(g, 78.4, 34.6, 92, 26, 4.2);
  ellipse(g, 71.4, 84.4, 3.4, 3.4);
  return true;
}

function horseHead(g: G): void {
  g.moveTo(101, BOX + 8);
  g.quadraticCurveTo(92, 78, 78, 62);
  g.quadraticCurveTo(68, 52, 70.4, 36);
  g.quadraticCurveTo(72, 23.6, 80, 17.6);
  g.quadraticCurveTo(85.4, 13.6, 87, 5.4);
  g.lineTo(85.6, -4);
  g.lineTo(91, 5);
  g.lineTo(95, -2.6);
  g.lineTo(95.4, 9);
  g.quadraticCurveTo(99, 20, 101, 36);
  g.closePath();
}

function horseMuzzle(g: G): void {
  g.moveTo(70.6, 36);
  g.quadraticCurveTo(58.6, 33.4, 56.4, 43);
  g.quadraticCurveTo(61, 50.6, 71.4, 48);
  g.closePath();
}

function scorpioFrame(g: G): void {
  roundBar(g, 10, 63, 92, 63, 4.6);
  roundBar(g, 21, 49, 21, 79, 5.4);
  roundBar(g, 82, 49, 82, 79, 5.4);
  roundBar(g, 51, 61, 51, 98, 4.4);
}

// ---------------------------------------------------------------------------
// Engraving
// ---------------------------------------------------------------------------

function shieldDevice(g: G, def: UnitTypeDef): void {
  const sh = def.appearance.shield;
  if (sh === 'none') return;
  const gold = 'rgba(232, 197, 122, 0.82)';
  const dark = 'rgba(10, 7, 4, 0.6)';

  if (sh === 'round' || sh === 'oval') {
    const cx = sh === 'round' ? 12 : 13;
    const cy = sh === 'round' ? 82 : 84;
    g.lineWidth = 2.2;
    g.strokeStyle = dark;
    g.beginPath();
    g.arc(cx, cy, 6.4, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = gold;
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.fill();
    // Germanic spiral / sunwheel spokes.
    g.strokeStyle = gold;
    g.lineWidth = 1.6;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
      g.lineTo(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14);
      g.stroke();
    }
    return;
  }
  // Legionary thunderbolt over a boss.
  g.strokeStyle = dark;
  g.lineWidth = 2.2;
  g.beginPath();
  g.ellipse(15, 78, 6.6, 8.4, 0, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = gold;
  g.beginPath();
  g.moveTo(20, 60);
  g.lineTo(10.4, 76.6);
  g.lineTo(16, 76.6);
  g.lineTo(11.6, 94);
  g.lineTo(23, 74.6);
  g.lineTo(17.2, 74.6);
  g.closePath();
  g.fill();
}

function armourDetail(g: G, def: UnitTypeDef): void {
  const a = def.appearance.armour;
  g.lineWidth = 1.3;
  if (a === 'segmentata') {
    g.strokeStyle = 'rgba(8, 6, 4, 0.55)';
    for (let i = 0; i < 4; i++) {
      const y = 79 + i * 5.6;
      g.beginPath();
      g.moveTo(36, y);
      g.quadraticCurveTo(56, y + 3.6, 76, y - 1.4);
      g.stroke();
    }
  } else if (a === 'squamata' || a === 'hamata') {
    // Rows of dots for scales and rings.
    g.fillStyle = 'rgba(8, 6, 4, 0.4)';
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 9; c++) {
        const x = 36 + c * 3.6 + (r % 2 ? 1.8 : 0);
        const y = 78 + r * 4.4;
        g.beginPath();
        g.arc(x, y, 0.95, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function eye(g: G, def: UnitTypeDef): void {
  // A single catchlight where the face is visible reads as a person, not a mannequin.
  const covered = def.appearance.helmet === 'spangenhelm';
  if (covered) return;
  g.fillStyle = 'rgba(10, 7, 4, 0.9)';
  g.beginPath();
  g.ellipse(45.2, 51, 2.1, 1.5, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(54.8, 51, 2.1, 1.5, 0, 0, Math.PI * 2);
  g.fill();
  // Nose and mouth as two short shadows: enough for the face to have a direction.
  g.strokeStyle = 'rgba(10, 7, 4, 0.42)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(49.4, 52.4);
  g.lineTo(48.6, 57);
  g.stroke();
  g.beginPath();
  g.moveTo(46.6, 59.6);
  g.lineTo(53.2, 59.6);
  g.stroke();
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function drawFigure(g: G, def: UnitTypeDef): void {
  const ap = def.appearance;
  const rome = def.faction === Faction.Rome;
  const mounted = def.unitClass === 'heavy-cavalry' || def.unitClass === 'light-cavalry';
  const artillery = def.unitClass === 'artillery';
  const torso: Tone = ap.bareChested ? T.skin : armourTone(def);

  // ---- Behind the figure ----
  if (weaponShaft(g, def)) {
    paint(g, ap.weapon === 'bow' ? T.shaft : T.shaft, (c) => weaponShaft(c, def));
    paint(g, ap.weapon === 'bow' ? T.shaft : T.blade, (c) => weaponHead(c, def));
  }

  if (mounted) {
    paint(g, T.horse, horseHead, 1.7);
    paint(g, T.horse, horseMuzzle, 1.4);
  }

  if (ap.cloak) paint(g, rome ? T.cloakRome : T.cloakGerm, cloak, 1.6);

  // ---- Body ----
  paint(g, torso, (c) => shoulders(c, def), 1.7);
  armourDetail(g, def);
  paint(g, ap.bareChested ? T.skin : T.face, neck, 1.4);
  paint(g, T.face, skull, 1.5);
  eye(g, def);

  if (!rome && ap.helmet !== 'spangenhelm') paint(g, T.hairFair, beard, 1.4);
  else if (rome && ap.helmet !== 'none') paint(g, T.hair, shortBeard, 1.3);
  if (ap.helmet === 'none') paint(g, rome ? T.hair : T.hairFair, looseHair, 1.4);

  // ---- Helmet ----
  if (ap.helmet !== 'none') {
    const shell: Tone = ap.helmet === 'fur-cap' ? T.leather : ap.helmet === 'spangenhelm' ? T.steel : T.bronze;
    paint(g, shell, (c) => helmetBowl(c, def), 1.6);
    if (ap.helmet !== 'fur-cap') {
      // Polished metal takes one hard highlight; cloth and fur take none.
      g.save();
      g.beginPath();
      helmetBowl(g, def);
      g.clip();
      const hl = g.createLinearGradient(34, 18, 58, 48);
      hl.addColorStop(0, 'rgba(255, 244, 214, 0.72)');
      hl.addColorStop(1, 'rgba(255, 244, 214, 0)');
      g.fillStyle = hl;
      g.beginPath();
      g.ellipse(43.6, 33.4, 6, 8.6, -0.42, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    paint(g, shell, (c) => helmetFittings(c, def), 1.4);
    // Shadow the brow under the brim.
    g.save();
    g.beginPath();
    skull(g);
    g.clip();
    const br = g.createLinearGradient(0, 44.6, 0, 58);
    br.addColorStop(0, 'rgba(8, 5, 3, 0.72)');
    br.addColorStop(0.55, 'rgba(8, 5, 3, 0.22)');
    br.addColorStop(1, 'rgba(8, 5, 3, 0)');
    g.fillStyle = br;
    g.fillRect(34, 44.6, 32, 14);
    g.restore();
  }

  // Roman crests are red horsehair; Germanic headgear is bone and horn.
  const crestTone: Tone = ap.crest === 'horns' ? T.horn : rome ? T.crestRome : T.crestGerm;
  g.beginPath();
  if (crest(g, def)) {
    const grad = g.createLinearGradient(22, 0, 80, 40);
    grad.addColorStop(0, crestTone[0]);
    grad.addColorStop(1, crestTone[1]);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = OUTLINE;
    g.stroke();
  }

  // ---- In front ----
  if (artillery) paint(g, T.shaft, scorpioFrame, 1.6);
  else if (shieldShape(g, def)) {
    paint(g, rome ? T.woodRome : T.woodGerm, (c) => shieldShape(c, def), 1.8);
    shieldDevice(g, def);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Paint a portrait filling `w x h` CSS pixels. The caller must already have applied
 * the device-pixel-ratio transform.
 */
export function drawPortrait(g: G, w: number, h: number, def: UnitTypeDef): void {
  const fui = FACTION_UI[def.faction];
  const rome = def.faction === Faction.Rome;
  g.clearRect(0, 0, w, h);

  // ---- Plate ----
  // Deliberately dark. Twenty-one of these tile the bottom of the screen, and at the
  // brighter oxblood they used to carry the card row was the most luminous mass in the
  // frame — the HUD winning a fight it is not supposed to be in. The faction is still
  // read from the tint, the figure and the hairline along the bottom edge.
  const bg = g.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, rome ? '#48191c' : '#152634');
  bg.addColorStop(0.5, rome ? '#260f10' : '#0c161f');
  bg.addColorStop(1, '#070505');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // A halo behind where the head will sit. Without it the lower half of the bust sinks
  // into the plate and the whole card reads as a dark smudge.
  const halo = g.createRadialGradient(w * 0.5, h * 0.4, h * 0.04, w * 0.5, h * 0.42, h * 0.66);
  halo.addColorStop(0, rome ? 'rgba(148, 68, 54, 0.36)' : 'rgba(72, 108, 142, 0.36)');
  halo.addColorStop(0.62, rome ? 'rgba(86, 37, 30, 0.2)' : 'rgba(38, 62, 86, 0.2)');
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, w, h);

  // Warm key light from the upper left, matching the battlefield sun.
  const key = g.createRadialGradient(w * 0.24, h * 0.08, 1, w * 0.24, h * 0.08, h * 1.2);
  key.addColorStop(0, 'rgba(255, 230, 178, 0.3)');
  key.addColorStop(0.5, 'rgba(184, 132, 62, 0.08)');
  key.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = key;
  g.fillRect(0, 0, w, h);

  // Engraved tooling: a struck-metal texture that survives downscaling.
  g.save();
  g.globalAlpha = 0.1;
  g.strokeStyle = '#f0dcb0';
  g.lineWidth = Math.max(0.5, h / 100);
  for (let y = h * 0.05; y < h; y += Math.max(2.6, h / 20)) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y - h * 0.02);
    g.stroke();
  }
  g.restore();

  // ---- Figure ----
  g.save();
  // Cover-fit the design box and sit the figure on the bottom edge. Cropping the
  // shoulders is fine; distorting the man is not.
  const k = Math.max(w / BOX, h / BOX) * 1.02;
  g.translate(w * 0.5 - BOX * 0.5 * k, h - BOX * k * 0.97);
  g.scale(k, k);

  // Ground shadow so the figure is not pasted flat onto the plate.
  g.save();
  g.globalAlpha = 0.45;
  g.filter = 'blur(2px)';
  g.fillStyle = '#050403';
  g.beginPath();
  g.ellipse(50, 99, 46, 8, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  g.lineJoin = 'round';
  drawFigure(g, def);
  g.restore();

  // ---- Frame ----
  const vig = g.createLinearGradient(0, h * 0.4, 0, h);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.46)');
  g.fillStyle = vig;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  // A hairline of faction colour along the bottom edge ties card to army.
  g.fillStyle = fui.colour;
  g.globalAlpha = 0.9;
  g.fillRect(0, h - Math.max(1, h * 0.02), w, Math.max(1, h * 0.02));
  g.globalAlpha = 1;
}
