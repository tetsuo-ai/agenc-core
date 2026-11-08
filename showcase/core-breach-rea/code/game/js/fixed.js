// 16.16 fixed point and 32-bit binary angles recovered from the 1993
// shareware engine binary:
//   * FRACUNIT = 0x10000 (the engine's fixed shift is 16)
//   * ANG90 = 0x40000000, ANG180 = 0x80000000, ANG270 = 0xc0000000
//   * fine trig uses 8192 steps: index = (angle + ANG90) >>> 19
//     (R_ScaleFromGlobalAngle at 0x42f18 indexes &DAT_00005a84 this way)
// The tables below are generated, not copied from the binary.

export const FRACBITS = 16;
export const FRACUNIT = 1 << FRACBITS;
export const ANG45 = 0x20000000;
export const ANG90 = 0x40000000;
export const ANG180 = 0x80000000;
export const ANG270 = 0xc0000000;
export const ANG360 = 0x100000000;
export const FINE_ANGLES = 8192;
export const FINE_SHIFT = 19;
export const FINE_MASK = FINE_ANGLES - 1;

export function i32(v) { return v | 0; }
export function fx(v) { return (v * FRACUNIT) | 0; }
export function toFloat(v) { return v / FRACUNIT; }
export function fmul(a, b) { return Math.floor((a * b) / 65536); }
export function fdiv(a, b) {
  if (b === 0) return a < 0 ? -0x7fffffff : 0x7fffffff;
  const r = (a * 65536) / b;
  if (r > 0x7fffffff) return 0x7fffffff;
  if (r < -0x7fffffff) return -0x7fffffff;
  return Math.trunc(r) | 0;
}
export function fabs(v) { return v < 0 ? -v : v; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Generated fine sine, 16.16 units, one full turn in 8192 entries.
export const SINE = new Int32Array(FINE_ANGLES);
export const COSINE = new Int32Array(FINE_ANGLES);
for (let i = 0; i < FINE_ANGLES; i++) {
  const a = (i / FINE_ANGLES) * Math.PI * 2;
  SINE[i] = Math.round(Math.sin(a) * 65536) | 0;
  COSINE[i] = Math.round(Math.cos(a) * 65536) | 0;
}
export function fineSin(angle) { return SINE[(angle >>> 0) >>> FINE_SHIFT & FINE_MASK]; }
export function fineCos(angle) { return COSINE[(angle >>> 0) >>> FINE_SHIFT & FINE_MASK]; }

export function angleToRad(angle) {
  return ((angle >>> 0) / 4294967296) * Math.PI * 2;
}
export function radToAngle(rad) {
  let a = (rad / (Math.PI * 2)) * 4294967296;
  return (a >>> 0);
}
export function pointToAngle(dx, dy) {
  return radToAngle(Math.atan2(dy, dx));
}
export function angleDelta(a, b) {
  // signed shortest difference a-b
  let d = ((a >>> 0) - (b >>> 0)) | 0;
  return d;
}
export function pointToDist(dx, dy) {
  return Math.floor(Math.hypot(dx, dy));
}
export function turnToward(cur, target, maxTurn) {
  let d = angleDelta(target, cur);
  if (d > maxTurn) d = maxTurn;
  if (d < -maxTurn) d = -maxTurn;
  return ((cur >>> 0) + d) >>> 0;
}

// Deterministic xorshift32.  A fresh shuffled 256-entry byte table is built
// for each level from this generator, mirroring the engine's use of a
// pre-generated random table without copying its values.
let state = 0x1f123bb5;
export function srand(seed) { state = seed >>> 0 || 0x1f123bb5; }
export function rand32() {
  let x = state;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  state = x;
  return x;
}
export function randByte() { return rand32() & 0xff; }
export function randRange(n) { return rand32() % n; }
export function randomTable() {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rand32() % (i + 1);
    const tmp = t[i]; t[i] = t[j]; t[j] = tmp;
  }
  return t;
}
