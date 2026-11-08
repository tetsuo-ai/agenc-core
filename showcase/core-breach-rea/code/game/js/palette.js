// CORE BREACH palette and light tables.  All colours are generated here;
// nothing is copied from any existing game.
export const PALETTE = new Uint8Array(256 * 3);
export const RGBA32 = new Uint32Array(256);

function ramp(base, shade) {
  const t = shade / 15;
  // keep a warm/cool tint, clamp to 0..255
  return [
    Math.max(0, Math.min(255, Math.round(base[0] * t))),
    Math.max(0, Math.min(255, Math.round(base[1] * t))),
    Math.max(0, Math.min(255, Math.round(base[2] * t))),
  ];
}

// 16 ramps x 16 shades = 256 indexed colours.  Index 0 is the transparent
// black used by sprites; walls/flats never use it as an opaque colour.
export const RAMPS = [
  [0, 0, 0],        // 0  black / transparent
  [70, 82, 94],     // 1  steel dark
  [132, 146, 158],  // 2  steel
  [205, 216, 224],  // 3  light steel
  [100, 68, 42],    // 4  brown
  [184, 112, 48],   // 5  copper
  [244, 156, 60],   // 6  orange
  [255, 218, 92],   // 7  amber
  [92, 170, 82],    // 8  green
  [150, 240, 120],  // 9  bright green
  [56, 156, 168],   // 10 teal
  [110, 238, 245],  // 11 cyan
  [76, 124, 220],   // 12 blue
  [190, 96, 216],   // 13 violet
  [236, 76, 76],    // 14 red
  [255, 246, 226],  // 15 pale
];

for (let r = 0; r < 16; r++) {
  for (let s = 0; s < 16; s++) {
    const i = r * 16 + s;
    const [rr, gg, bb] = ramp(RAMPS[r], s);
    PALETTE[i * 3] = rr;
    PALETTE[i * 3 + 1] = gg;
    PALETTE[i * 3 + 2] = bb;
    RGBA32[i] = (255 << 24) | (bb << 16) | (gg << 8) | rr;
  }
}
// pure black is opaque for the renderer background (index 0 stays
// transparent for sprites, but the screen is initialised to a sky colour).
RGBA32[0] = (255 << 24) | (0 << 16) | (0 << 8) | 0;

// Colour helper for texture/sprite generators.
export function C(rampIndex, shade) {
  return rampIndex * 16 + Math.max(0, Math.min(15, shade | 0));
}

// 32 light levels, each a 256-byte palette remap.  Level 31 is identity.
export const LIGHT_LEVELS = 32;
export const LIGHT = new Uint8Array(LIGHT_LEVELS * 256);
for (let l = 0; l < LIGHT_LEVELS; l++) {
  const f = l / (LIGHT_LEVELS - 1);
  for (let r = 0; r < 16; r++) {
    for (let s = 0; s < 16; s++) {
      const i = r * 16 + s;
      // Darker levels compress the ramp toward its darkest shade, but keep
      // a small ambient glow so dark corridors are still readable.
      const ns = Math.round(s * (0.32 + 0.68 * f));
      LIGHT[l * 256 + i] = r * 16 + Math.max(0, Math.min(15, ns));
    }
  }
}
export function lightIndex(level255, dist) {
  if (level255 <= 0) return 0;
  let l = (level255 - Math.min(150, dist * 0.042)) / 7.6; // 0..31
  if (l < 0) l = 0;
  if (l > 31) l = 31;
  return l | 0;
}
