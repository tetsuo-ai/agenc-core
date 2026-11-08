// Procedural sprite and first-person weapon art.  Every frame is generated
// here from primitive shapes into palette-indexed bitmaps; index 0 is
// transparent.
import { C } from "./palette.js";

function mk(w, h) { return { w, h, data: new Uint8Array(w * h) }; }
function set(t, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return;
  t.data[y * t.w + x] = c;
}
function rect(t, x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(t, xx, yy, c);
}
function ellipse(t, cx, cy, rx, ry, c) {
  for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
    if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) set(t, cx + x, cy + y, c);
  }
}
function circle(t, cx, cy, r, c) { ellipse(t, cx, cy, r, r, c); }
function hline(t, x0, x1, y, c) { for (let x = x0; x <= x1; x++) set(t, x, y, c); }
function line(t, x0, y0, x1, y1, c, thick = 1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    for (let oy = 0; oy < thick; oy++) for (let ox = 0; ox < thick; ox++) set(t, x + ox, y + oy, c);
    if (x === x1 && y === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
function poly(t, pts, c) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    line(t, a[0], a[1], b[0], b[1], c);
  }
}

// ------------------------------------------------------------------ enemies
function cutterFrame(rot, phase, mode) {
  const t = mk(56, 56);
  const cx = 28;
  const bob = mode === "walk" ? Math.round(Math.sin(phase * 1.7) * 2) : 0;
  const face = Math.cos((rot / 8) * Math.PI * 2); // 1 front, -1 back
  const side = Math.sin((rot / 8) * Math.PI * 2);
  const bodyW = 14 + Math.round(4 * Math.abs(face));
  const cy = 30 + bob;

  if (mode === "death") {
    // collapsed chassis, wheels off, smoke
    ellipse(t, cx, cy + 12, 20, 6, C(1, 2));
    ellipse(t, cx, cy + 11, 16, 4, C(2, 4));
    ellipse(t, cx - 18, cy + 14, 6, 6, C(1, 1));
    ellipse(t, cx + 20, cy + 12, 6, 6, C(1, 1));
    line(t, cx - 12, cy + 8, cx + 8, cy + 2, C(6, 8), 2);
    for (let i = 0; i < 6; i++) set(t, cx - 10 + i * 4, cy - 2 - (i % 2) * 4, C(6, 10 + (i % 3)));
    return t;
  }

  // wheels
  for (const wx of [cx - 14, cx + 14]) {
    ellipse(t, wx, cy + 12, 8, 8, C(1, 1));
    ellipse(t, wx, cy + 12, 6, 6, C(2, 3));
    ellipse(t, wx, cy + 12, 3, 3, C(1, 8));
    line(t, wx - 5, cy + 12, wx + 5, cy + 12, C(1, 0));
  }
  // chassis
  ellipse(t, cx, cy, bodyW, 12, C(1, 2));
  ellipse(t, cx, cy - 1, bodyW - 2, 9, C(2, 4));
  rect(t, cx - bodyW + 3, cy - 5, bodyW * 2 - 6, 3, C(6, 6));
  // saw arms
  const reach = mode === "attack" ? 22 : 14;
  for (const s of [-1, 1]) {
    const ax = cx + s * (bodyW - 2);
    const tx = cx + s * reach;
    const ty = cy + (mode === "attack" ? -2 : 4);
    line(t, ax, cy - 2, tx, ty, C(2, 5), 3);
    circle(t, tx, ty, mode === "attack" ? 7 : 5, C(3, 8));
    circle(t, tx, ty, mode === "attack" ? 4 : 3, C(1, 1));
    for (let i = 0; i < 6; i++) {
      const a = phase + i * Math.PI / 3;
      line(t, tx, ty, tx + Math.cos(a) * (mode === "attack" ? 8 : 6), ty + Math.sin(a) * (mode === "attack" ? 8 : 6), C(3, 12));
    }
  }
  // eye / sensor
  const ex = cx + Math.round(side * 5);
  const ey = cy - 5;
  circle(t, ex, ey, 4, C(14, 4));
  circle(t, ex + Math.round(face), ey - 1, 2, C(14, 14));
  // antenna
  line(t, cx, cy - 12, cx + Math.round(side * 4), cy - 22, C(1, 1), 1);
  set(t, cx + Math.round(side * 4), cy - 23, C(14, 12));
  if (mode === "attack") {
    set(t, cx + 20, cy - 8, C(7, 15));
    set(t, cx + 22, cy - 9, C(6, 14));
  }
  return t;
}

function droneFrame(rot, phase, mode) {
  const t = mk(56, 56);
  const cx = 28, cy = 24 + (mode === "walk" ? Math.round(Math.sin(phase) * 3) : 0);
  const face = Math.cos((rot / 8) * Math.PI * 2);
  const side = Math.sin((rot / 8) * Math.PI * 2);
  if (mode === "death") {
    ellipse(t, cx, 44, 18, 5, C(1, 1));
    ellipse(t, cx, 40, 12, 4, C(10, 3));
    for (let i = 0; i < 8; i++) set(t, cx - 14 + i * 4, 34 - (i % 3) * 3, C(11, 8 + (i % 4)));
    return t;
  }
  // rotor arms
  for (const s of [-1, 1]) {
    line(t, cx + s * 8, cy, cx + s * 20, cy - 6, C(2, 4), 3);
    ellipse(t, cx + s * 22, cy - 7, 8, 3, C(1, 4));
    line(t, cx + s * 22 - 7, cy - 8, cx + s * 22 + 7, cy - 8, C(3, 7));
  }
  // hull
  ellipse(t, cx, cy, 14, 11, C(12, 2));
  ellipse(t, cx, cy - 1, 11, 8, C(12, 4));
  ellipse(t, cx + Math.round(side * 3), cy - 2, 7, 6, C(11, 3));
  // eye
  const ex = cx + Math.round(side * 5);
  circle(t, ex, cy - 2, 5, C(10, 3));
  circle(t, ex, cy - 2, 3, mode === "attack" ? C(11, 15) : C(11, 11));
  circle(t, ex, cy - 3, 1, C(15, 15));
  // thruster
  ellipse(t, cx, cy + 11, 5, 3, C(10, 2));
  if (mode === "attack") {
    circle(t, ex, cy - 2, 7, C(11, 9));
    set(t, cx + 18, cy - 2, C(11, 15));
  }
  return t;
}

function sentinelFrame(rot, phase, mode) {
  const t = mk(72, 72);
  const cx = 36;
  const face = Math.cos((rot / 8) * Math.PI * 2);
  const side = Math.sin((rot / 8) * Math.PI * 2);
  if (mode === "death") {
    ellipse(t, cx, 58, 24, 7, C(1, 1));
    rect(t, cx - 18, 46, 36, 10, C(8, 3));
    line(t, cx - 18, 52, cx - 30, 64, C(1, 2), 4);
    line(t, cx + 18, 52, cx + 30, 64, C(1, 2), 4);
    for (let i = 0; i < 10; i++) set(t, cx - 20 + i * 4, 40 - (i % 4) * 3, C(6, 8 + (i % 5)));
    return t;
  }
  const stride = mode === "walk" ? Math.round(Math.sin(phase) * 4) : 0;
  // legs
  line(t, cx - 9, 40, cx - 14 - stride, 62, C(1, 2), 5);
  line(t, cx + 9, 40, cx + 14 + stride, 62, C(1, 2), 5);
  rect(t, cx - 20 - stride, 60, 12, 5, C(2, 3));
  rect(t, cx + 8 + stride, 60, 12, 5, C(2, 3));
  // torso
  rect(t, cx - 14, 18, 28, 24, C(8, 2));
  rect(t, cx - 12, 20, 24, 20, C(8, 4));
  rect(t, cx - 10, 24, 20, 6, C(1, 3));
  // head
  rect(t, cx - 8, 8, 16, 10, C(8, 3));
  rect(t, cx - 6, 10, 12, 4, C(14, 3));
  const ex = cx + Math.round(side * 3);
  rect(t, ex - 5, 11, 10, 2, C(14, 15));
  // shoulder cannons
  for (const s of [-1, 1]) {
    rect(t, cx + s * 14 - (s < 0 ? 8 : 0), 20, 8, 6, C(2, 4));
    line(t, cx + s * 17, 22, cx + s * 24, 22 + (mode === "attack" ? -4 : 0), C(2, 7), 3);
  }
  if (mode === "attack") {
    for (const s of [-1, 1]) {
      circle(t, cx + s * 26, 22 - 4, 4, C(6, 15));
      set(t, cx + s * 26, 22 - 4, C(15, 15));
    }
  }
  // panel lights
  for (let i = 0; i < 4; i++) set(t, cx - 8 + i * 5, 32, C(10, 9 + (i % 3)));
  return t;
}

const ENEMY_FRAME_COUNTS = { idle: 2, walk: 4, attack: 2, pain: 1, death: 4 };
function buildEnemySheet(draw) {
  const sheet = {};
  for (let rot = 0; rot < 8; rot++) {
    sheet[rot] = {};
    for (const [state, count] of Object.entries(ENEMY_FRAME_COUNTS)) {
      const frames = [];
      for (let f = 0; f < count; f++) {
        const phase = (f / Math.max(1, count)) * Math.PI * 2;
        frames.push(draw(rot, phase, state));
      }
      sheet[rot][state] = frames;
    }
  }
  return sheet;
}

// ------------------------------------------------------------------ pickups
function pickupIcon(kind) {
  const t = mk(28, 28);
  const cx = 14, cy = 16;
  if (kind === "ammo") {
    rect(t, cx - 10, cy - 6, 20, 14, C(1, 2));
    rect(t, cx - 9, cy - 5, 18, 12, C(5, 5));
    for (let i = 0; i < 5; i++) rect(t, cx - 8 + i * 4, cy - 3, 2, 8, C(7, 12));
    rect(t, cx - 10, cy - 8, 20, 3, C(2, 4));
  } else if (kind === "health" || kind === "patch_cell" || kind === "trauma_kit") {
    // Green medical canister with a white pulse trace; no cross.
    const big = kind === "trauma_kit";
    const mid = kind === "patch_cell";
    const w = big ? 20 : mid ? 16 : 13;
    const h = big ? 18 : mid ? 15 : 12;
    const left = cx - ((w / 2) | 0);
    const top = cy - ((h / 2) | 0);
    rect(t, left, top + 1, w, h, C(0, 1));
    rect(t, left + 1, top + 1, w - 2, h - 1, C(8, 5));
    rect(t, left + 2, top + 2, w - 4, h - 3, C(8, 8));
    rect(t, left + 2, top + 3, 2, h - 5, C(9, 10));
    rect(t, left + 2, top, w - 4, 2, C(2, 5));
    rect(t, left + 1, top + h - 2, w - 2, 2, C(1, 3));
    // White pulse trace across the green label.
    const py = top + 4;
    const x0 = left + 3, x1 = left + w - 4;
    hline(t, x0, x1, py, C(15, 15));
    hline(t, x0, x1, py + 1, C(15, 13));
    const mx = left + ((w / 2) | 0);
    line(t, mx - 2, py, mx - 1, py - 2, C(15, 15));
    line(t, mx - 1, py - 2, mx, py + 1, C(15, 15));
    line(t, mx, py + 1, mx + 2, py, C(15, 15));
    set(t, left + w - 3, top + 1, C(9, 12));
  } else if (kind === "armor" || kind === "heavy_plating") {
    const ramp = kind === "armor" ? 12 : 13;
    rect(t, cx - 9, cy - 8, 18, 5, C(2, 4));
    rect(t, cx - 8, cy - 3, 16, 12, C(ramp, 5));
    rect(t, cx - 6, cy - 1, 12, 9, C(ramp, 8));
    rect(t, cx - 2, cy - 2, 4, 8, C(3, 11));
    set(t, cx - 5, cy + 2, C(11, 14)); set(t, cx + 5, cy + 2, C(11, 14));
  } else if (kind === "yellow_key" || kind === "cyan_key") {
    const col = kind === "yellow_key" ? 7 : 11;
    rect(t, cx - 7, cy - 10, 14, 18, C(1, 2));
    rect(t, cx - 6, cy - 9, 12, 16, C(col, 5));
    rect(t, cx - 6, cy - 9, 12, 4, C(col, 11));
    rect(t, cx - 3, cy - 2, 6, 6, C(1, 2));
    rect(t, cx - 2, cy - 1, 4, 4, C(15, 14));
    for (let i = 0; i < 3; i++) set(t, cx - 4 + i * 3, cy + 7, C(col, 13));
  }
  return t;
}

// ------------------------------------------------------------------ weapons
function weaponFrame(kind, frame) {
  const t = mk(120, 76);
  const recoil = frame === 1 ? 5 : frame === 2 ? 3 : frame === 3 ? 1 : 0;
  const flash = frame === 1;
  const body = C(2, 8);
  const bodyHi = C(3, 11);
  const bodyLo = C(1, 4);
  const grip = C(4, 6);
  if (kind === "rivet") {
    // body
    rect(t, 44, 38 + recoil, 24, 30, bodyLo);
    rect(t, 47, 40 + recoil, 18, 26, body);
    rect(t, 49, 42 + recoil, 6, 20, bodyHi);
    rect(t, 40, 44 + recoil, 40, 8, C(1, 6));
    // barrel
    rect(t, 52, 18 + recoil, 10, 22, body);
    rect(t, 55, 20 + recoil, 4, 18, bodyHi);
    rect(t, 49, 16 + recoil, 16, 4, C(1, 5));
    // grip
    line(t, 48, 62, 40, 75, grip, 10);
    // ammo feed
    rect(t, 64, 46 + recoil, 12, 8, C(5, 7));
    for (let i = 0; i < 3; i++) rect(t, 66 + i * 3, 48 + recoil, 2, 5, C(7, 14));
    if (flash) {
      circle(t, 57, 13, 8, C(7, 15));
      circle(t, 57, 13, 4, C(15, 15));
      for (let i = 0; i < 6; i++) line(t, 57, 13, 57 + (i - 3) * 4, 3, C(6, 14));
    }
  } else if (kind === "scatter") {
    rect(t, 38, 40 + recoil, 44, 24, bodyLo);
    rect(t, 42, 42 + recoil, 36, 20, C(4, 7));
    rect(t, 44, 44 + recoil, 10, 16, C(5, 9));
    rect(t, 46, 22 + recoil, 12, 22, body);
    rect(t, 62, 22 + recoil, 12, 22, body);
    rect(t, 48, 24 + recoil, 4, 16, bodyHi);
    rect(t, 64, 24 + recoil, 4, 16, bodyHi);
    rect(t, 44, 18 + recoil, 16, 5, C(1, 5));
    rect(t, 60, 18 + recoil, 16, 5, C(1, 5));
    rect(t, 48, 48 + recoil, 24, 6, C(5, 8));
    line(t, 52, 64, 44, 75, grip, 10);
    if (flash) {
      circle(t, 52, 14, 9, C(7, 15));
      circle(t, 68, 14, 9, C(7, 15));
      circle(t, 60, 17, 10, C(6, 14));
    }
  } else {
    // arc launcher
    rect(t, 40, 34 + recoil, 42, 34, bodyLo);
    rect(t, 44, 37 + recoil, 34, 28, C(10, 6));
    rect(t, 46, 40 + recoil, 8, 20, C(11, 6));
    rect(t, 48, 20 + recoil, 26, 18, body);
    rect(t, 52, 14 + recoil, 18, 8, C(10, 5));
    rect(t, 56, 10 + recoil, 10, 5, C(11, 12));
    for (let i = 0; i < 5; i++) {
      const y = 24 + i * 7 + recoil;
      line(t, 46, y, 76, y, C(11, 6 + (i % 3)));
    }
    rect(t, 46, 52 + recoil, 30, 6, C(5, 7));
    line(t, 50, 64, 42, 75, grip, 9);
    if (flash) {
      circle(t, 61, 8, 10, C(11, 14));
      circle(t, 61, 8, 5, C(15, 15));
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        line(t, 61, 8, 61 + Math.cos(a) * 16, 8 + Math.sin(a) * 16, C(11, 12));
      }
    }
  }
  return t;
}

export function makeSprites() {
  const enemies = {
    cutter: { sheet: buildEnemySheet(cutterFrame), height: 46, width: 52, spriteScale: 1.0 },
    drone: { sheet: buildEnemySheet(droneFrame), height: 44, width: 52, spriteScale: 1.0 },
    sentinel: { sheet: buildEnemySheet(sentinelFrame), height: 76, width: 66, spriteScale: 1.0 },
  };
  const pickups = {};
  for (const k of ["ammo", "health", "patch_cell", "trauma_kit", "armor", "heavy_plating", "yellow_key", "cyan_key"]) {
    pickups[k] = pickupIcon(k);
  }
  const weapons = {
    rivet: [0, 1, 2, 3].map((f) => weaponFrame("rivet", f)),
    scatter: [0, 1, 2, 3].map((f) => weaponFrame("scatter", f)),
    arc: [0, 1, 2, 3].map((f) => weaponFrame("arc", f)),
  };
  const projectiles = [];
  for (let f = 0; f < 2; f++) {
    const t = mk(20, 20);
    circle(t, 10, 10, 7 - f, C(11, 10 + f * 3));
    circle(t, 10, 10, 4 - f, C(15, 14));
    set(t, 8, 8, C(15, 15)); set(t, 12, 12, C(10, 14));
    projectiles.push(t);
  }
  // Expanding arc-launcher blast ring, four frames.
  const effects = { arc: [] };
  for (let f = 0; f < 4; f++) {
    const t = mk(56, 56);
    const r = 5 + f * 7;
    if (f < 2) {
      circle(t, 28, 28, 5 + f * 3, C(15, 15));
      circle(t, 28, 28, 3 + f * 2, C(7, 15));
    }
    for (let a = 0; a < Math.PI * 2; a += 0.10) {
      const x = 28 + Math.cos(a) * r;
      const y = 28 + Math.sin(a) * r * 0.72;
      set(t, x, y, C(11, Math.max(3, 13 - f * 2)));
      set(t, x + 1, y, C(11, Math.max(2, 10 - f)));
      set(t, x, y + 1, C(6, Math.max(3, 14 - f * 2)));
    }
    for (let i = 0; i < 10; i++) {
      const a = i * Math.PI * 2 / 10 + f * 0.22;
      const x = 28 + Math.cos(a) * (r + 7);
      const y = 28 + Math.sin(a) * (r + 7) * 0.72;
      line(t, 28, 28, x, y, C(6, Math.max(3, 14 - f * 2)));
    }
    effects.arc.push(t);
  }
  const decor = {};
  {
    const t = mk(80, 144);
    const cx = 40;
    rect(t, 10, 134, 60, 8, C(1, 2));
    rect(t, 16, 16, 48, 120, C(1, 3));
    rect(t, 20, 20, 40, 112, C(2, 5));
    rect(t, 24, 24, 8, 104, C(3, 8));
    for (let i = 0; i < 6; i++) {
      const y = 24 + i * 18;
      rect(t, 14, y, 52, 6, C(1, 2));
      rect(t, 16, y + 1, 48, 3, i % 2 ? C(11, 10) : C(6, 12));
      rect(t, 54, y + 2, 10, 2, C(7, 13));
    }
    rect(t, 32, 30, 16, 96, C(6, 5));
    rect(t, 35, 34, 10, 88, C(6, 9));
    rect(t, 38, 38, 4, 80, C(15, 15));
    for (let i = 0; i < 8; i++) {
      const y = 40 + i * 10;
      rect(t, 34, y, 12, 2, C(7, 15));
    }
    rect(t, 22, 10, 36, 8, C(2, 4));
    rect(t, 30, 4, 20, 6, C(1, 2));
    for (let i = 0; i < 4; i++) { set(t, 18 + i * 14, 14, C(11, 12)); }
    decor.core = t;
  }
  {
    const t = mk(64, 120);
    rect(t, 12, 30, 40, 84, C(1, 2));
    rect(t, 16, 34, 32, 76, C(2, 3));
    for (let y = 38; y < 108; y += 8) hline(t, 18, 46, y, C(6, 5));
    rect(t, 24, 0, 16, 34, C(1, 2));
    rect(t, 28, 4, 8, 26, C(6, 8));
    for (let i = 0; i < 4; i++) circle(t, 32, 8 + i * 7, 2 + (i % 2), C(7, 12 + i));
    decor.tower = t;
  }
  return { enemies, pickups, weapons, projectiles, effects, decor };
}
