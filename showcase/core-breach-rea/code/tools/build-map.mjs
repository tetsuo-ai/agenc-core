#!/usr/bin/env node
/**
 * CORE BREACH map compiler.
 *
 * Reads maps/reactor7.source.json (convex sector rectangles plus door / lift /
 * window / secret-line annotations) and emits game/js/level.js:
 *   vertices, linedefs, sidedefs, sectors, segs, subsectors (BSP leaves),
 *   nodes (BSP), blockmap, reject, things.
 *
 * The BSP is built over the convex sector polygons themselves.  A split line
 * is always an existing polygon edge; polygons are clipped into front/back
 * fragments.  Leaves are therefore convex sub-polygons of one sector, which
 * is exactly what the renderer needs for wall projection and visplanes.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "/work";
const SRC = path.join(ROOT, "maps/reactor7.source.json");
const OUT = path.join(ROOT, "game/js/level.js");
const BLOCK = 128;

const src = JSON.parse(fs.readFileSync(SRC, "utf8"));
const EPS = 1e-6;

function area2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointOnSeg(p, a, b, eps = 1e-6) {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > eps * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -eps && dot <= len2 + eps;
}

function splitAtVertices(a, b, vertices) {
  const pts = [a];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const inner = [];
  for (const v of vertices) {
    if ((v[0] === a[0] && v[1] === a[1]) || (v[0] === b[0] && v[1] === b[1])) continue;
    if (!pointOnSeg(v, a, b)) continue;
    const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / len2;
    if (t > 1e-7 && t < 1 - 1e-7) inner.push({ t, v });
  }
  inner.sort((p, q) => p.t - q.t);
  for (const it of inner) pts.push(it.v);
  pts.push(b);
  return pts;
}

// ---------------------------------------------------------------- sectors
const sectors = src.sectors.map((s, id) => {
  const [x1, y1, x2, y2] = s.rect;
  const poly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  if (area2(poly) < 0) poly.reverse();
  return {
    id,
    name: s.name,
    poly,
    floor: s.floor,
    ceil: s.ceil,
    light: s.light | 0,
    lightMin: s.lightMin ?? s.light,
    lightMax: s.lightMax ?? s.light,
    floorTex: s.floorTex,
    ceilTex: s.ceilTex,
    wallTex: s.wallTex,
    special: s.door ? "door" : s.lift ? "lift" : s.damage ? "damage" : "none",
    door: s.door || null,
    lift: s.lift || null,
    damage: s.damage || 0,
    secret: !!s.secret,
    sky: !!s.sky,
    flicker: !!s.flicker,
    tag: s.tag || 0,
    exitLine: s.exitLine || null,
    secretDoor: s.secretDoor || null,
  };
});

// All map vertices, used to split T-junctions and to place secret doors.
const vertexSet = new Map();
function addVertex(x, y) { vertexSet.set(`${x},${y}`, [x, y]); }
for (const s of sectors) for (const p of s.poly) addVertex(p[0], p[1]);
for (const s of src.sectors) {
  if (s.secretDoor) { addVertex(s.secretDoor[0], s.secretDoor[1]); addVertex(s.secretDoor[2], s.secretDoor[3]); }
  if (s.exitLine) { addVertex(s.exitLine[0], s.exitLine[1]); addVertex(s.exitLine[2], s.exitLine[3]); }
}
for (const w of src.windows || []) { addVertex(w[0], w[1]); addVertex(w[2], w[3]); }
const vertices = [...vertexSet.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
const vertexIndex = new Map(vertices.map((v, i) => [`${v[0]},${v[1]}`, i]));

// Directed split edges, grouped by undirected key.
const groups = new Map();
for (const sec of sectors) {
  const ordered = [];
  for (let i = 0; i < sec.poly.length; i++) {
    const a = sec.poly[i], b = sec.poly[(i + 1) % sec.poly.length];
    const pts = splitAtVertices(a, b, vertices);
    for (let j = 0; j < pts.length - 1; j++) {
      const p = pts[j], q = pts[j + 1];
      const ia = vertexIndex.get(`${p[0]},${p[1]}`);
      const ib = vertexIndex.get(`${q[0]},${q[1]}`);
      if (ia === undefined || ib === undefined) throw new Error("bad vertex");
      const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      if (g.length >= 2) throw new Error(`edge ${key} shared by >2 sectors`);
      g.push({ a: ia, b: ib, sector: sec.id });
      ordered.push({ a: ia, b: ib, sec: sec.id, key });
    }
  }
  sec.edges = ordered;
}

// ---------------------------------------------------------------- linedefs
const linedefs = [];
const lineByKey = new Map();
for (const [key, dirs] of groups) {
  const d0 = dirs[0];
  const d1 = dirs[1] || null;
  const v1 = vertices[d0.a], v2 = vertices[d0.b];
  const line = {
    id: linedefs.length,
    v1: d0.a, v2: d0.b,
    x1: v1[0], y1: v1[1],
    x2: v2[0], y2: v2[1],
    front: d0.sector,
    back: d1 ? d1.sector : -1,
    flags: 0,
    special: "none",
    tag: 0,
    key: null,
    open: false,
    window: false,
    sides: [],
  };
  const fs = sectors[line.front];
  const bs = line.back >= 0 ? sectors[line.back] : null;
  function makeSide(sec) {
    return { sector: sec.id, upper: "-", middle: "-", lower: "-", pegUpper: 0, pegLower: 0 };
  }
  const fside = makeSide(fs);
  fside.upper = bs && bs.ceil < fs.ceil ? fs.wallTex : "-";
  fside.lower = bs && bs.floor > fs.floor ? fs.wallTex : "-";
  fside.middle = !bs ? fs.wallTex : "-";
  line.sides.push(fside);
    if (bs) {
      const bside = makeSide(bs);
      bside.upper = fs.ceil < bs.ceil ? bs.wallTex : "-";
      bside.lower = fs.floor > bs.floor ? bs.wallTex : "-";
      line.sides.push(bside);
      line.flags |= 1;
      // Indoor/outdoor boundaries are solid walls unless a window cut-out
      // is declared below.  Without this the outdoor sky/rock leaks into
      // every shared edge of a sky sector.
      if (!!fs.sky !== !!bs.sky) {
        line.special = "solid";
        fside.middle = fs.wallTex;
        bside.middle = bs.wallTex;
      }
    }
  // Door sectors: every border line is a useable door line.
  for (const sec of [fs, bs]) {
    if (!sec) continue;
    if (sec.door) {
      line.special = "door";
      line.tag = sec.tag;
      line.key = sec.door === "yellow" ? "yellow" : sec.door === "cyan" ? "cyan" : null;
      line.doorSector = sec.id;
      line.sides[0].middle = sec.wallTex;
      if (line.sides[1]) line.sides[1].middle = sec.wallTex;
    }
    if (sec.lift) {
      line.special = "lift";
      line.tag = sec.lift.tag;
      line.liftSector = sec.id;
    }
  }
  linedefs.push(line);
  lineByKey.set(key, line.id);
}
for (const sec of sectors) for (const e of sec.edges) e.line = lineByKey.get(e.key);

// Mark window / secret / exit segments.  Endpoints are map vertices, and the
// edges were split there, so every matching sub-edge is marked.
function forEachLineOnSegment(x1, y1, x2, y2, cb) {
  const a = [x1, y1], b = [x2, y2];
  for (const l of linedefs) {
    const p = [l.x1, l.y1], q = [l.x2, l.y2];
    if (pointOnSeg(p, a, b) && pointOnSeg(q, a, b)) cb(l);
  }
}
for (const w of src.windows || []) {
  forEachLineOnSegment(w[0], w[1], w[2], w[3], (l) => {
    l.window = true;
    l.special = "none";
    l.flags |= 2;
    l.sides.forEach((s) => { s.upper = s.upper === "-" ? sectors[s.sector].wallTex : s.upper; s.lower = s.lower === "-" ? sectors[s.sector].wallTex : s.lower; s.middle = "WINDOW"; });
  });
}
for (const sec of sectors) {
  if (sec.secretDoor) {
    forEachLineOnSegment(sec.secretDoor[0], sec.secretDoor[1], sec.secretDoor[2], sec.secretDoor[3], (l) => {
      l.special = "secret_door";
      l.secretSector = sec.id;
      l.open = false;
      l.sides.forEach((s) => { s.middle = "PANEL_DARK"; });
    });
  }
  if (sec.exitLine) {
    forEachLineOnSegment(sec.exitLine[0], sec.exitLine[1], sec.exitLine[2], sec.exitLine[3], (l) => {
      l.special = "exit";
      l.tag = 666;
      l.sides[0].middle = "EXIT";
    });
  }
}

// Sector polygons with split edges and linedef tags, used by the BSP.
function sectorPolygon(sec) {
  // Reconstruct ordered sub-edges from sec.poly + split vertices.
  const ordered = [];
  for (let i = 0; i < sec.poly.length; i++) {
    const a = sec.poly[i], b = sec.poly[(i + 1) % sec.poly.length];
    const pts = splitAtVertices(a, b, vertices);
    for (let j = 0; j < pts.length - 1; j++) {
      const ia = vertexIndex.get(`${pts[j][0]},${pts[j][1]}`);
      const ib = vertexIndex.get(`${pts[j + 1][0]},${pts[j + 1][1]}`);
      const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
      ordered.push({ v: pts[j], line: lineByKey.get(key), sector: sec.id });
    }
  }
  const verts = ordered.map((e) => e.v);
  const lines = ordered.map((e) => e.line);
  // ordered contains the start vertex of each edge; close the polygon.
  return { sector: sec.id, verts, lines };
}

// ---------------------------------------------------------------- BSP
const SUB_EPS = 1e-4;
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.verts.length; i++) {
    const p = poly.verts[i], q = poly.verts[(i + 1) % poly.verts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function clipPoly(poly, line, keepFront) {
  const [x1, y1, x2, y2] = line;
  const side = (p) => (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
  const out = { sector: poly.sector, verts: [], lines: [] };
  const n = poly.verts.length;
  for (let i = 0; i < n; i++) {
    const A = poly.verts[i], B = poly.verts[(i + 1) % n];
    const la = poly.lines[i];
    const sa = side(A), sb = side(B);
    const ina = keepFront ? sa >= -SUB_EPS : sa <= SUB_EPS;
    const inb = keepFront ? sb >= -SUB_EPS : sb <= SUB_EPS;
    if (ina) out.verts.push(A);
    if (ina !== inb) {
      const t = sa / (sa - sb);
      const P = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
      out.verts.push(P);
    }
  }
  // assign edge tags by collinearity with original edges
  const originals = [];
  for (let i = 0; i < n; i++) originals.push({ A: poly.verts[i], B: poly.verts[(i + 1) % n], line: poly.lines[i] });
  for (let i = 0; i < out.verts.length; i++) {
    const A = out.verts[i], B = out.verts[(i + 1) % out.verts.length];
    let tag = null;
    for (const o of originals) {
      if (o.line == null) continue;
      if (pointOnSeg(A, o.A, o.B, 1e-4) && pointOnSeg(B, o.A, o.B, 1e-4)) { tag = o.line; break; }
    }
    out.lines.push(tag);
  }
  return out;
}
function cleanPoly(poly) {
  if (poly.verts.length < 3) return null;
  // remove duplicate consecutive vertices
  const vs = [], ls = [];
  for (let i = 0; i < poly.verts.length; i++) {
    const a = poly.verts[i], b = poly.verts[(i + 1) % poly.verts.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4) continue;
    vs.push(a); ls.push(poly.lines[i]);
  }
  if (vs.length < 3) return null;
  if (Math.abs(polyArea({ verts: vs })) < 1e-3) return null;
  return { sector: poly.sector, verts: vs, lines: ls };
}
function bboxOf(polys) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of polys) for (const v of p.verts) {
    if (v[0] < minx) minx = v[0]; if (v[0] > maxx) maxx = v[0];
    if (v[1] < miny) miny = v[1]; if (v[1] > maxy) maxy = v[1];
  }
  return [minx, miny, maxx, maxy];
}
const nodes = [];
const subsectors = [];
function buildBSP(polys, depth) {
  polys = polys.map(cleanPoly).filter(Boolean);
  if (polys.length === 0) return null;
  if (polys.length === 1 || depth > 60) {
    for (const p of polys) {
      subsectors.push({ sector: p.sector, verts: p.verts, edgeLines: p.lines, bbox: bboxOf([p]) });
    }
    return { leaf: subsectors.length - polys.length };
  }
  // Try edges from every polygon, longest first.
  const candidates = [];
  for (const p of polys) for (let i = 0; i < p.verts.length; i++) {
    const a = p.verts[i], b = p.verts[(i + 1) % p.verts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 16) candidates.push({ a, b, len });
  }
  candidates.sort((p, q) => q.len - p.len);
  for (const c of candidates) {
    const line = [c.a[0], c.a[1], c.b[0], c.b[1]];
    const front = [], back = [];
    let fCount = 0, bCount = 0;
    for (const p of polys) {
      const f = cleanPoly(clipPoly(p, line, true));
      const b = cleanPoly(clipPoly(p, line, false));
      if (f) { front.push(f); fCount++; }
      if (b) { back.push(b); bCount++; }
    }
    if (fCount === 0 || bCount === 0) continue;
    // avoid a degenerate split where one side is the same single polygon
    if (front.length === polys.length && back.length === polys.length) continue;
    const fi = buildBSP(front, depth + 1);
    const bi = buildBSP(back, depth + 1);
    const idx = nodes.length;
    nodes.push({ line, front: fi, back: bi, bbox: bboxOf(polys) });
    return { node: idx };
  }
  // No splitter found: emit as leaves.
  for (const p of polys) {
    subsectors.push({ sector: p.sector, verts: p.verts, edgeLines: p.lines, bbox: bboxOf([p]) });
  }
  return { leaf: subsectors.length - polys.length };
}

const polys = sectors.map(sectorPolygon);
const rootRef = buildBSP(polys, 0);
function encodeRef(r) { return r && r.node !== undefined ? r.node : -1 - (r ? r.leaf : 0); }
for (const n of nodes) {
  n.frontRef = encodeRef(n.front);
  n.backRef = encodeRef(n.back);
}
const root = encodeRef(rootRef);

// Convert node leaves to the renderer layout.
for (const ss of subsectors) {
  ss.poly = ss.verts.map((v) => [Math.round(v[0]), Math.round(v[1])]);
  ss.edgeLines = ss.edgeLines.map((l) => (l == null ? -1 : l));
  delete ss.verts;
}

// Segs (one per leaf wall edge; used as the map data model / verification).
const segs = [];
for (let si = 0; si < subsectors.length; si++) {
  const ss = subsectors[si];
  for (let i = 0; i < ss.poly.length; i++) {
    const line = ss.edgeLines[i];
    if (line < 0) continue;
    const a = ss.poly[i], b = ss.poly[(i + 1) % ss.poly.length];
    segs.push({ v1: [a[0], a[1]], v2: [b[0], b[1]], line, frontSector: ss.sector, subsector: si });
  }
}

// ---------------------------------------------------------------- things
const thingDefs = {
  player: { kind: "player", radius: 16, height: 56 },
  rivet: { kind: "pickup", item: "rivet", radius: 12, height: 20 },
  scatter: { kind: "pickup", item: "scatter", radius: 12, height: 20 },
  arc: { kind: "pickup", item: "arc", radius: 12, height: 20 },
  ammo: { kind: "pickup", item: "ammo", radius: 12, height: 16 },
  health: { kind: "pickup", item: "health", radius: 12, height: 16 },
  patch_cell: { kind: "pickup", item: "patch_cell", radius: 12, height: 16 },
  trauma_kit: { kind: "pickup", item: "trauma_kit", radius: 12, height: 16 },
  armor: { kind: "pickup", item: "armor", radius: 12, height: 16 },
  heavy_plating: { kind: "pickup", item: "heavy_plating", radius: 12, height: 16 },
  ykey: { kind: "pickup", item: "yellow_key", radius: 10, height: 16 },
  cyan: { kind: "pickup", item: "cyan_key", radius: 10, height: 16 },
  cutter: { kind: "enemy", enemy: "cutter", radius: 18, height: 40 },
  drone: { kind: "enemy", enemy: "drone", radius: 18, height: 36 },
  sentinel: { kind: "enemy", enemy: "sentinel", radius: 24, height: 64 },
  core: { kind: "decor", item: "core", radius: 32, height: 140 },
  tower: { kind: "decor", item: "tower", radius: 24, height: 118 },
};
function sectorAt(x, y) {
  for (const s of sectors) {
    const p = s.poly;
    let inside = true;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < -1e-6) { inside = false; break; }
    }
    if (inside) return s.id;
  }
  return -1;
}
const things = src.things.map((t, id) => {
  const def = thingDefs[t.type];
  if (!def) throw new Error(`unknown thing type ${t.type}`);
  return {
    id, type: t.type, kind: def.kind, item: def.item || null, enemy: def.enemy || null,
    x: t.x, y: t.y, angle: t.angle ?? 0,
    radius: def.radius, height: def.height,
    sector: sectorAt(t.x, t.y),
  };
});
const playerStart = things.find((t) => t.type === "player");

// ---------------------------------------------------------------- blockmap
let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
for (const s of sectors) for (const p of s.poly) {
  minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
  miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
}
const ox = Math.floor(minx / BLOCK) * BLOCK - BLOCK;
const oy = Math.floor(miny / BLOCK) * BLOCK - BLOCK;
const bw = Math.ceil((maxx - ox) / BLOCK) + 2;
const bh = Math.ceil((maxy - oy) / BLOCK) + 2;
const bmLines = Array.from({ length: bw * bh }, () => []);
const bmThings = Array.from({ length: bw * bh }, () => []);
function blocksFor(x1, y1, x2, y2) {
  const ax = Math.max(0, Math.floor((Math.min(x1, x2) - ox) / BLOCK));
  const bx = Math.min(bw - 1, Math.floor((Math.max(x1, x2) - ox) / BLOCK));
  const ay = Math.max(0, Math.floor((Math.min(y1, y2) - oy) / BLOCK));
  const by = Math.min(bh - 1, Math.floor((Math.max(y1, y2) - oy) / BLOCK));
  const out = [];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) out.push(y * bw + x);
  return out;
}
for (const l of linedefs) for (const b of blocksFor(l.x1, l.y1, l.x2, l.y2)) bmLines[b].push(l.id);
for (const t of things) {
  const b = blocksFor(t.x - t.radius, t.y - t.radius, t.x + t.radius, t.y + t.radius);
  for (const i of b) bmThings[i].push(t.id);
}

// ---------------------------------------------------------------- reject
const nsec = sectors.length;
const reject = new Uint8Array(nsec * nsec);
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy;
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * s2 - (cy - ay) * s1) / den;
  const u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}
function center(s) {
  let x = 0, y = 0;
  for (const p of s.poly) { x += p[0]; y += p[1]; }
  return [x / s.poly.length, y / s.poly.length];
}
for (let i = 0; i < nsec; i++) for (let j = 0; j < nsec; j++) {
  if (i === j) { reject[i * nsec + j] = 0; continue; }
  const a = center(sectors[i]), b = center(sectors[j]);
  let blocked = false;
  for (const l of linedefs) {
    if (l.back < 0 || l.special === "secret_door") {
      if (segIntersect(a[0], a[1], b[0], b[1], l.x1, l.y1, l.x2, l.y2)) { blocked = true; break; }
    }
  }
  reject[i * nsec + j] = blocked ? 1 : 0;
}

// ---------------------------------------------------------------- output
const level = {
  name: src.name,
  sky: src.sky,
  bounds: [minx, miny, maxx, maxy],
  vertices,
  sectors: sectors.map((s) => ({
    id: s.id, name: s.name, floor: s.floor, ceil: s.ceil, light: s.light,
    lightMin: s.lightMin, lightMax: s.lightMax, floorTex: s.floorTex,
    ceilTex: s.ceilTex, wallTex: s.wallTex, special: s.special,
    door: s.door, lift: s.lift, damage: s.damage, secret: s.secret,
    sky: s.sky, flicker: s.flicker, tag: s.tag, poly: s.poly,
  })),
  lines: linedefs.map((l) => ({
    id: l.id, v1: l.v1, v2: l.v2,
    x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
    front: l.front, back: l.back,
    flags: l.flags, special: l.special, tag: l.tag, key: l.key,
    open: l.open, window: l.window, doorSector: l.doorSector ?? -1,
    liftSector: l.liftSector ?? -1, secretSector: l.secretSector ?? -1,
    sides: l.sides,
  })),
  sidedefs: linedefs.flatMap((l, lineId) => l.sides.map((s, side) => ({ line: lineId, side, ...s }))),
  segs,
  subsectors,
  nodes: nodes.map((n) => ({ line: n.line, front: n.frontRef, back: n.backRef, bbox: n.bbox.map(Math.round) })),
  root,
  blockmap: { originX: ox, originY: oy, width: bw, height: bh, blockSize: BLOCK, lines: bmLines, things: bmThings },
  reject: Array.from(reject),
  things,
  playerStart,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, "// generated by tools/build-map.mjs - do not edit by hand\nexport const LEVEL = " + JSON.stringify(level) + ";\n");
console.log("sectors", sectors.length, "lines", linedefs.length, "subsectors", subsectors.length, "nodes", nodes.length, "segs", segs.length, "things", things.length);
console.log("blockmap", bw, "x", bh, "reject", reject.length, "bytes");
console.log("wrote", OUT);
