// Procedural texture generation for CORE BREACH.
// Every pixel here is produced by the code in this file.  Textures are
// palette-indexed and are uploaded once at startup.
import { C } from "./palette.js";

let seed = 0x51f15e;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}
function ri(n) { return (rnd() * n) | 0; }

function mk(w, h) { return { w, h, data: new Uint8Array(w * h) }; }
function set(t, x, y, c) {
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return;
  t.data[(y | 0) * t.w + (x | 0)] = c;
}
function get(t, x, y) { return t.data[((y + t.h) % t.h) * t.w + ((x + t.w) % t.w)]; }
function rect(t, x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(t, xx, yy, c);
}
function hline(t, x0, x1, y, c) { for (let x = x0; x <= x1; x++) set(t, x, y, c); }
function vline(t, x, y0, y1, c) { for (let y = y0; y <= y1; y++) set(t, x, y, c); }
function dot(t, x, y, c) { set(t, x, y, c); }
function noise(t, x, y, w, h, base, spread, rampIdx) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const n = ri(spread) - (spread >> 1);
    set(t, xx, yy, C(rampIdx, base + n));
  }
}
function rivet(t, x, y, c = C(3, 12), d = C(1, 1)) {
  set(t, x, y, c); set(t, x + 1, y, d); set(t, x, y + 1, d);
}

function panel(name, baseRamp, baseShade, edgeRamp, edgeShade, grid = 16) {
  const t = mk(64, 64);
  noise(t, 0, 0, 64, 64, baseShade, 3, baseRamp);
  for (let y = 0; y < 64; y += grid) hline(t, 0, 63, y, C(edgeRamp, edgeShade));
  for (let x = 0; x < 64; x += grid) vline(t, x, 0, 63, C(edgeRamp, edgeShade));
  for (let y = 4; y < 64; y += grid) for (let x = 4; x < 64; x += grid) rivet(t, x, y);
  return t;
}

export function makeTextures() {
  const walls = {};
  const flats = {};

  walls.PANEL = panel("PANEL", 2, 9, 1, 3, 16);
  walls.PANEL_DARK = panel("PANEL_DARK", 1, 8, 0, 4, 16);

  // Pipe wall: vertical pipework with clamps.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 6, 3, 1);
    for (const x of [8, 22, 44, 57]) {
      for (let y = 0; y < 64; y++) {
        set(t, x, y, C(2, 4));
        set(t, x + 1, y, C(2, 10));
        set(t, x + 2, y, C(1, 3));
        set(t, x + 3, y, C(1, 1));
      }
    }
    for (let y = 12; y < 64; y += 20) {
      rect(t, 6, y, 6, 2, C(1, 10));
      rect(t, 42, y, 6, 2, C(1, 10));
      rect(t, 20, y + 6, 6, 2, C(1, 10));
      rect(t, 55, y + 6, 6, 2, C(1, 10));
    }
    walls.PIPE = t;
  }

  // Warning stripes.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 5, 3, 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const s = ((x + y) >> 3) & 1;
      set(t, x, y, s ? C(7, 11) : C(0, 1));
    }
    hline(t, 0, 63, 0, C(2, 6)); hline(t, 0, 63, 63, C(2, 4));
    walls.STRIPE = t;
    walls.HAZARD = t;
  }

  // Metal grate.
  {
    const t = mk(64, 64);
    rect(t, 0, 0, 64, 64, C(1, 2));
    for (let y = 2; y < 64; y += 8) for (let x = 2; x < 64; x += 8) {
      rect(t, x, y, 5, 5, C(2, 5));
      rect(t, x + 1, y + 1, 3, 3, C(0, 0));
      set(t, x, y + 5, C(1, 1));
    }
    for (let x = 0; x < 64; x += 16) vline(t, x, 0, 63, C(2, 3));
    walls.GRATE = t;
  }

  // Computer bank: terminal screens and LEDs.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 7, 2, 1);
    for (const [x, y, w, h, r] of [[4, 4, 24, 18, 11], [34, 4, 24, 18, 9], [4, 30, 24, 18, 10], [34, 30, 24, 18, 11]]) {
      rect(t, x, y, w, h, C(0, 2));
      rect(t, x + 1, y + 1, w - 2, h - 2, C(r, 4));
      for (let yy = y + 3; yy < y + h - 2; yy += 3) {
        for (let xx = x + 3; xx < x + w - 3; xx += 2) if (rnd() > 0.55) set(t, xx, yy, C(r, 10));
      }
      rect(t, x, y, w, 2, C(2, 8));
    }
    for (let i = 0; i < 14; i++) set(t, 3 + i * 4, 56, C(i % 3 === 0 ? 14 : 9, 12));
    walls.COMPUTER = t;
  }

  // Coolant-stained plating.
  {
    const t = panel("COOLANT", 1, 7, 10, 4, 16);
    for (let i = 0; i < 18; i++) {
      const x = ri(64), y = ri(64), r = 2 + ri(6);
      for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) {
        if (xx * xx + yy * yy < r * r && rnd() > 0.3) set(t, x + xx, y + yy, C(10, 4 + ri(5)));
      }
    }
    walls.COOLANT = t;
  }

  // Reactor core plating with glowing seams.
  {
    const t = mk(128, 128);
    noise(t, 0, 0, 128, 128, 6, 4, 1);
    for (let y = 0; y < 128; y += 32) for (let x = 0; x < 128; x += 32) {
      rect(t, x + 2, y + 2, 28, 28, C(1, 5));
      rect(t, x + 4, y + 4, 24, 24, C(2, 3));
      for (let yy = 0; yy < 24; yy += 4) hline(t, x + 5, x + 26, y + 5 + yy, C(1, 1));
      rivet(t, x + 6, y + 6);
      rivet(t, x + 25, y + 25);
    }
    for (let i = 0; i < 128; i++) {
      set(t, i, 63, C(6, 12)); set(t, i, 64, C(6, 14));
    }
    for (let i = 0; i < 128; i++) { set(t, 63, i, C(6, 10)); set(t, 64, i, C(6, 13)); }
    walls.CORE = t;
  }

  // Doors.
  function door(name, rampc, shade) {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, shade, 3, 1);
    for (let y = 0; y < 64; y += 16) {
      hline(t, 0, 63, y, C(0, 2));
      rect(t, 2, y + 2, 60, 12, C(rampc, 4));
      rect(t, 6, y + 4, 52, 3, C(rampc, 9));
    }
    vline(t, 31, 0, 63, C(0, 4));
    vline(t, 32, 0, 63, C(rampc, 13));
    for (let y = 6; y < 64; y += 16) { set(t, 4, y, C(3, 13)); set(t, 59, y, C(3, 13)); }
    walls[name] = t;
  }
  door("DOOR_Y", 7, 5);
  door("DOOR_C", 11, 4);

  // Exit switch panel.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 2, 3, 1);
    rect(t, 6, 10, 52, 44, C(0, 2));
    rect(t, 8, 12, 48, 40, C(14, 6));
    for (let y = 16; y < 48; y += 6) hline(t, 12, 52, y, C(14, 10));
    rect(t, 20, 24, 24, 10, C(15, 14));
    rect(t, 24, 26, 16, 6, C(14, 3));
    hline(t, 6, 57, 9, C(2, 9)); hline(t, 6, 57, 54, C(2, 5));
    walls.EXIT = t;
  }

  // Trim / light steel.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 10, 2, 2);
    for (let x = 0; x < 64; x += 8) {
      vline(t, x, 0, 63, C(3, 11));
      vline(t, x + 1, 0, 63, C(1, 2));
    }
    for (let y = 0; y < 64; y += 16) hline(t, 0, 63, y, C(1, 4));
    walls.TRIM = t;
  }

  // Rock / torn hull.
  {
    const t = mk(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const n = ri(5) + ((x * 7 + y * 13) % 9 === 0 ? 3 : 0);
      set(t, x, y, C(4, 3 + n));
    }
    for (let i = 0; i < 10; i++) {
      let x = ri(64), y = ri(64);
      for (let j = 0; j < 20; j++) {
        set(t, x, y, C(0, 2));
        x += ri(3) - 1; y += ri(3) - 1;
      }
    }
    walls.ROCK = t;
  }

  // Vent grille.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 4, 2, 1);
    for (let y = 4; y < 64; y += 8) {
      rect(t, 4, y, 56, 5, C(2, 5));
      for (let x = 6; x < 58; x += 4) rect(t, x, y + 1, 2, 3, C(0, 1));
    }
    for (let x = 0; x < 64; x += 16) vline(t, x, 0, 63, C(1, 2));
    walls.VENT = t;
  }

  // Extra tech wall.
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 5, 2, 2);
    for (let y = 0; y < 64; y += 16) for (let x = 0; x < 64; x += 16) {
      rect(t, x + 1, y + 1, 14, 14, C(1, 5));
      rect(t, x + 3, y + 3, 10, 10, C(10, 4));
      rect(t, x + 5, y + 5, 6, 6, C(11, 8));
      dot(t, x + 6, y + 6, C(11, 14));
    }
    walls.TECH = t;
  }

  // Flats.
  function floorPlate(name, rampc, shade, grid) {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, shade, 3, rampc);
    for (let y = 0; y < 64; y += grid) hline(t, 0, 63, y, C(1, 3));
    for (let x = 0; x < 64; x += grid) vline(t, x, 0, 63, C(1, 3));
    for (let y = 4; y < 64; y += grid) for (let x = 4; x < 64; x += grid) rivet(t, x, y, C(3, 8), C(0, 2));
    flats[name] = t;
  }
  floorPlate("FLOOR_PLATE", 2, 8, 16);
  floorPlate("FLOOR_GRATE", 1, 5, 8);
  floorPlate("TRIM_FLOOR", 2, 10, 16);
  floorPlate("TECH_FLOOR", 10, 6, 16);
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 9, 2, 2);
    for (let y = 0; y < 64; y += 16) for (let x = 0; x < 64; x += 16) {
      rect(t, x + 2, y + 2, 12, 12, C(3, 10));
      rect(t, x + 4, y + 4, 8, 8, C(15, 13));
    }
    flats.CEIL_PANEL = t;
  }
  {
    const t = mk(64, 64);
    noise(t, 0, 0, 64, 64, 8, 2, 15);
    for (let y = 0; y < 64; y += 16) hline(t, 0, 63, y, C(2, 5));
    for (let x = 0; x < 64; x += 16) vline(t, x, 0, 63, C(2, 5));
    for (let y = 2; y < 64; y += 16) for (let x = 2; x < 64; x += 16) {
      rect(t, x, y, 12, 12, C(15, 12));
      rect(t, x + 3, y + 3, 6, 6, C(15, 15));
    }
    flats.CEIL_LIGHT = t;
  }
  {
    const t = mk(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const n = Math.sin((x + y) * 0.3) * 3 + Math.sin(x * 0.17 - y * 0.23) * 2;
      set(t, x, y, C(10, 6 + Math.round(n) + ri(2)));
    }
    for (let i = 0; i < 8; i++) {
      hline(t, ri(64), ri(64), ri(64), C(11, 11));
    }
    flats.COOLANT_FLAT = t;
  }
  {
    // Calm, coherent rock.  Broad low-frequency mottling replaces the old
    // per-pixel brown/black grain, which turned into static at a distance.
    const t = mk(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const n = Math.sin((x * 2 + y) * 0.1963495) * 1.15
        + Math.sin((x - y * 2) * 0.1963495 + 1.7) * 0.65
        + Math.sin((x + y) * 0.0981748 + 0.4) * 0.85;
      const m = Math.sin((x * 3 - y) * 0.0981748 + 2.2) * 0.30;
      const shade = Math.max(4, Math.min(6, 5 + Math.round((n + m) * 0.55)));
      const band = Math.sin((x - y) * 0.0981748 + 0.8);
      set(t, x, y, C(band > 0.55 ? 1 : 4, shade));
    }
    // A few broad seams and worn patches; no fine per-pixel noise.
    for (let i = 0; i < 7; i++) {
      const x = ri(64), y = ri(64), len = 5 + ri(8);
      for (let j = 0; j < len; j++) {
        const sx = (x + j) & 63, sy = (y + ((j / 3) | 0)) & 63;
        set(t, sx, sy, C(1, 3));
        set(t, sx, (sy + 1) & 63, C(4, 4));
      }
    }
    for (let i = 0; i < 9; i++) {
      const x = ri(64), y = ri(64);
      for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 6; xx++) {
        set(t, (x + xx) & 63, (y + yy) & 63, C(4, 5));
      }
    }
    flats.ROCK_FLOOR = t;
  }

  // Sky: 512x128 panorama, dark upper atmosphere above an industrial
  // horizon.  Horizontal wrap is seamless.
  const sky = mk(512, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 512; x++) {
      const t = y / 127;
      let c;
      if (t < 0.40) c = C(12, 2 + ((t * 14) | 0));
      else if (t < 0.68) c = C(10, 4 + (((t - 0.40) * 26) | 0));
      else if (t < 0.84) c = C(11, 3 + (((t - 0.68) * 30) | 0));
      else c = C(4, 3 + (((t - 0.84) * 12) | 0));
      set(sky, x, y, c);
    }
  }
  // cloud bands
  for (let y = 12; y < 96; y++) for (let x = 0; x < 512; x++) {
    const v = Math.sin(x * 0.021 + y * 0.11) + Math.sin(x * 0.053 - y * 0.07) + Math.sin(x * 0.013 + y * 0.05);
    if (v > 1.35 && rnd() > 0.12) set(sky, x, y, C(13, 7 + ri(6)));
    else if (v > 1.1 && rnd() > 0.4) set(sky, x, y, C(12, 10 + ri(4)));
  }
  // a distant warm sun / reactor glow
  for (let y = 30; y < 62; y++) for (let x = 320; x < 352; x++) {
    const dx = x - 336, dy = y - 46;
    if (dx * dx + dy * dy < 100) set(sky, x, y, C(7, 13 + (ri(3))));
  }
  // stars in the upper band
  for (let i = 0; i < 120; i++) {
    const x = ri(512), y = ri(30);
    if (rnd() > 0.4) set(sky, x, y, C(15, 7 + ri(6)));
  }
  // horizon silhouettes: reactor towers
  for (let i = 0; i < 18; i++) {
    const x = (i * 61 + 17) % 512, w = 10 + ri(22), h = 8 + ri(26);
    rect(sky, x, 128 - h, w, h, C(1, 1));
    rect(sky, x + 2, 128 - h - 6, 4, 6, C(1, 2));
    for (let yy = 128 - h + 3; yy < 126; yy += 5) hline(sky, x + 2, x + w - 3, yy, C(6, 4));
  }
  // Calm, low-contrast horizon haze.  The old per-pixel orange/black
  // sparkle read as static where the coolant void exposed the sky.
  for (let y = 104; y < 128; y++) for (let x = 0; x < 512; x++) {
    const k = (y - 104) / 23;
    const band = Math.sin(x * 0.035 + y * 0.12) * 0.35;
    set(sky, x, y, C(4, 3 + Math.round(k * 2 + band)));
  }

  return { walls, flats, sky };
}
