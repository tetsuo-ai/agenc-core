// BSP / visplane / wall / sprite renderer for CORE BREACH.
// 320x200, 8-bit palette, 168-pixel view window + 32-pixel status bar.
import { PALETTE, RGBA32, LIGHT, lightIndex, C } from "./palette.js";
import { drawText, textWidth } from "./font.js";
import { ANG45, angleToRad } from "./fixed.js";

const W = 320;
const H = 200;
const VIEW_H = 168;
const CX = 160;
const CY = 84;
const PROJ = 160;
const YSCALE = 160;
const NEAR = 1.0;

const COL = {
  black: C(0, 1),
  dark: C(1, 2),
  panel: C(1, 3),
  steel: C(2, 7),
  steelHi: C(3, 12),
  white: C(15, 15),
  amber: C(7, 14),
  amberHi: C(7, 15),
  orange: C(6, 13),
  red: C(14, 12),
  redHi: C(14, 15),
  green: C(9, 12),
  cyan: C(11, 13),
  cyanHi: C(11, 15),
  blue: C(12, 10),
};

export class Renderer {
  constructor(canvas, level, textures, sprites) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(W, H);
    this.u32 = new Uint32Array(this.image.data.buffer);
    this.pixels = new Uint8Array(W * H);
    this.zbuf = new Float32Array(W * H);
    this.clipTop = new Float32Array(W);
    this.clipBottom = new Float32Array(W);
    this.level = level;
    this.textures = textures;
    this.sprites = sprites;
    this.visplanes = new Map();
    this.wallSeen = new Set();
    this.view = { x: 0, y: 0, z: 0, angle: 0, cos: 1, sin: 0, proj: PROJ };
    this.tic = 0;
    this.flash = 0;
    this.lastSprites = 0;
  }

  setLevel(level) { this.level = level; }

  // ------------------------------------------------------------- primitives
  put(x, y, color, depth = 0, light = 31) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= VIEW_H) return;
    const i = y * W + x;
    if (depth >= this.zbuf[i]) return;
    this.zbuf[i] = depth;
    this.pixels[i] = LIGHT[(light << 8) + color];
  }
  putRaw(x, y, color) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    this.pixels[y * W + x] = color;
  }
  text(x, y, s, color, scale = 1) {
    drawText((px, py, c) => this.putRaw(px, py, c), x, y, s, color, scale);
  }
  panel(x, y, w, h, fill, edge) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.putRaw(xx, yy, fill);
    for (let xx = x; xx < x + w; xx++) { this.putRaw(xx, y, edge); this.putRaw(xx, y + h - 1, edge); }
    for (let yy = y; yy < y + h; yy++) { this.putRaw(x, yy, edge); this.putRaw(x + w - 1, yy, edge); }
  }

  // ------------------------------------------------------------- main frame
  render(game) {
    this.tic = game.tic;
    this.flash = game.damageFlash || 0;
    this.pixels.fill(0, 0, W * VIEW_H);
    this.zbuf.fill(Infinity);
    this.clipTop.fill(0);
    this.clipBottom.fill(VIEW_H - 1);
    this.visplanes.clear();
    this.wallSeen.clear();
    this.lastSprites = 0;

    if (game.state === "title") {
      this.drawTitle(game);
      this.present();
      return;
    }
    if (game.state === "dead") {
      this.drawDeath(game);
      this.present();
      return;
    }
    if (game.state === "done") {
      this.drawComplete(game);
      this.present();
      return;
    }

    const p = game.player;
    this.view.x = p.x / 65536;
    this.view.y = p.y / 65536;
    this.view.z = (p.z + p.viewHeight + p.bob) / 65536;
    this.view.angle = p.angle >>> 0;
    const rad = angleToRad(this.view.angle);
    this.view.cos = Math.cos(rad);
    this.view.sin = Math.sin(rad);

    this.drawSky(game);
    this.traverse(game);
    this.drawVisplanes(game);
    this.drawSprites(game);
    this.drawWeapon(game);
    this.drawHUD(game);
    if (game.state === "paused") this.drawPause(game);
    this.present();
  }

  present() {
    const pix = this.pixels, u = this.u32;
    for (let i = 0, n = W * H; i < n; i++) u[i] = RGBA32[pix[i]];
    this.ctx.putImageData(this.image, 0, 0);
  }

  // ------------------------------------------------------------- sky
  drawSky(game) {
    const sky = this.textures.sky;
    const skyW = sky.w, skyH = sky.h;
    const base = (this.view.angle >>> 0) / 4294967296 * Math.PI * 2;
    for (let x = 0; x < W; x++) {
      const a = base + Math.atan((x + 0.5 - CX) / PROJ);
      let u = ((a / (Math.PI * 2)) % 1 + 1) % 1 * skyW | 0;
      if (u < 0) u += skyW;
      for (let y = 0; y < VIEW_H; y++) {
        const v = Math.min(skyH - 1, (y * skyH / VIEW_H) | 0);
        const c = sky.data[v * skyW + u];
        const i = y * W + x;
        this.pixels[i] = c;
        this.zbuf[i] = Infinity;
      }
    }
  }

  // ------------------------------------------------------------- BSP
  traverse(game) {
    const level = this.level;
    if (level.root < 0) {
      this.renderSubsector(game, -1 - level.root);
      return;
    }
    const stack = [level.root];
    while (stack.length) {
      const ref = stack.pop();
      if (ref < 0) {
        this.renderSubsector(game, -1 - ref);
        continue;
      }
      const n = level.nodes[ref];
      if (!this.bboxVisible(n.bbox)) continue;
      const [x1, y1, x2, y2] = n.line;
      const side = (x2 - x1) * (this.view.y - y1) - (y2 - y1) * (this.view.x - x1);
      // Near child first (front-to-back).
      if (side >= 0) {
        stack.push(n.back);
        stack.push(n.front);
      } else {
        stack.push(n.front);
        stack.push(n.back);
      }
    }
  }

  bboxVisible(b) {
    const [minx, miny, maxx, maxy] = b;
    const pts = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]];
    const c = this.view.cos, s = this.view.sin;
    let anyFront = false, anyInside = false;
    let minSX = Infinity, maxSX = -Infinity;
    for (const p of pts) {
      const dx = p[0] - this.view.x, dy = p[1] - this.view.y;
      const tz = dx * c + dy * s;
      const tx = -dx * s + dy * c;
      if (tz >= NEAR) {
        anyFront = true;
        const sx = tx * PROJ / tz;
        if (sx < minSX) minSX = sx;
        if (sx > maxSX) maxSX = sx;
        if (sx > -W && sx < W) anyInside = true;
      }
    }
    if (!anyFront) return false;
    if (anyInside) return true;
    return !(maxSX < -W || minSX > W);
  }

  renderSubsector(game, si) {
    const ss = this.level.subsectors[si];
    const sec = this.level.sectors[ss.sector];
    if (!sec) return;
    // floors / ceilings
    if (sec.floor !== sec.ceil) {
      if (sec.floor !== undefined) this.collectPlane(ss, sec.floor, sec.floorTex, sec.light, false, sec);
      if (!sec.sky) this.collectPlane(ss, sec.ceil, sec.ceilTex, sec.light, true, sec);
    }
    // walls
    const poly = ss.poly;
    for (let i = 0; i < poly.length; i++) {
      const lineId = ss.edgeLines[i];
      if (lineId < 0) continue;
      const a = poly[i], b = poly[(i + 1) % poly.length];
      this.drawWall(game, ss, lineId, a, b, sec);
    }
  }

  // ------------------------------------------------------------- visplanes
  collectPlane(ss, z, texName, light, isCeil, sec) {
    if (sec.sky && isCeil) return;
    if (z === this.view.z) return;
    const vp = this.projectPlanePoly(ss.poly, z, isCeil);
    if (!vp) return;
    const key = ss.sector * 2 + (isCeil ? 1 : 0);
    let plane = this.visplanes.get(key);
    if (!plane) {
      plane = { sector: ss.sector, z, tex: texName, light, isCeil, spans: [] };
      this.visplanes.set(key, plane);
    }
    for (const sp of vp.spans) plane.spans.push(sp);
  }

  projectPlanePoly(poly, z, isCeil) {
    const c = this.view.cos, s = this.view.sin;
    const vx = this.view.x, vy = this.view.y;
    let pts = [];
    for (const p of poly) {
      const dx = p[0] - vx, dy = p[1] - vy;
      pts.push({ tx: -dx * s + dy * c, tz: dx * c + dy * s });
    }
    // clip against tz >= NEAR
    const clipped = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ina = a.tz >= NEAR, inb = b.tz >= NEAR;
      if (ina) clipped.push(a);
      if (ina !== inb) {
        const t = (NEAR - a.tz) / (b.tz - a.tz);
        clipped.push({ tx: a.tx + (b.tx - a.tx) * t, tz: NEAR });
      }
    }
    if (clipped.length < 3) return null;
    const scr = [];
    for (const p of clipped) {
      const sx = CX + p.tx * PROJ / p.tz;
      const sy = CY - (z - this.view.z) * YSCALE / p.tz;
      scr.push([sx, sy]);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of scr) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < 0 || minX > W - 1 || maxY < 0 || minY > VIEW_H - 1) return null;
    const spans = [];
    const x0 = Math.max(0, Math.ceil(minX));
    const x1 = Math.min(W - 1, Math.floor(maxX));
    for (let x = x0; x <= x1; x++) {
      let y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < scr.length; i++) {
        const a = scr[i], b = scr[(i + 1) % scr.length];
        if ((a[0] <= x && b[0] >= x) || (b[0] <= x && a[0] >= x)) {
          if (Math.abs(b[0] - a[0]) < 1e-9) {
            y0 = Math.min(y0, a[1], b[1]); y1 = Math.max(y1, a[1], b[1]);
          } else {
            const t = (x - a[0]) / (b[0] - a[0]);
            const y = a[1] + (b[1] - a[1]) * t;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (!isFinite(y0) || !isFinite(y1)) continue;
      let sy0 = Math.max(0, Math.ceil(y0));
      let sy1 = Math.min(VIEW_H - 1, Math.floor(y1));
      if (sy0 > sy1) continue;
      spans.push([x, sy0, sy1]);
    }
    if (!spans.length) return null;
    return { spans };
  }

  drawVisplanes(game) {
    const c = this.view.cos, s = this.view.sin;
    const rightX = -s, rightY = c;
    for (const vp of this.visplanes.values()) {
      const tex = this.textures.flats[vp.tex] || this.textures.flats.FLOOR_PLATE;
      const tw = tex.w, th = tex.h;
      const tm = tw - 1, thm = th - 1;
      const z = vp.z;
      const vx = this.view.x, vy = this.view.y, vz = this.view.z;
      const sec = this.level.sectors[vp.sector];
      let lightBase = sec ? sec.light : 128;
      const anim = vp.tex === "COOLANT_FLAT" ? (this.tic * 0.35) : (this.tic * 0.05);
      for (const [x, y0, y1] of vp.spans) {
        const sx = (x + 0.5 - CX) / PROJ;
        for (let y = y0; y <= y1; y++) {
          const sy = (CY - (y + 0.5)) / YSCALE;
          if (Math.abs(sy) < 1e-7) continue;
          const t = (z - vz) / sy;
          if (t <= 0) continue;
          const idx = y * W + x;
          if (t >= this.zbuf[idx]) continue;
          const wx = vx + t * (c + rightX * sx);
          const wy = vy + t * (s + rightY * sx);
          let u = Math.floor(wx + anim) & tm;
          let v = Math.floor(wy + anim) & thm;
          if (u < 0) u += tw;
          if (v < 0) v += th;
          const color = tex.data[v * tw + u];
          const li = lightIndex(lightBase, t * 0.7 + Math.abs(z - vz) * 0.25);
          this.zbuf[idx] = t;
          this.pixels[idx] = LIGHT[(li << 8) + color];
        }
      }
    }
  }

  // ------------------------------------------------------------- walls
  drawWall(game, ss, lineId, a, b, sec) {
    const line = this.level.lines[lineId];
    if (!line) return;
    if (line.special === "secret_door" && line.open) return;
    // Deduplicate a wall segment encountered from both sides of a BSP leaf.
    const segKey = lineId + ":" + (a[0] | 0) + "," + (a[1] | 0) + ":" + (b[0] | 0) + "," + (b[1] | 0);
    if (this.wallSeen.has(segKey)) return;
    this.wallSeen.add(segKey);
    // Determine the side facing the camera from the geometry, not from the
    // leaf's sector tag.  This keeps BSP split fragments consistent.
    const cross = (line.x2 - line.x1) * (this.view.y - line.y1) - (line.y2 - line.y1) * (this.view.x - line.x1);
    let sideIdx, sec2;
    if (cross > 0) {
      sideIdx = 0;
      sec2 = this.level.sectors[line.front];
    } else {
      sideIdx = 1;
      sec2 = line.back >= 0 ? this.level.sectors[line.back] : null;
    }
    if (!sec2) return;
    sec = sec2;

    const other = line.back >= 0 ? this.level.sectors[line.back] : null;
    const side = line.sides[sideIdx] || line.sides[0];
    const wallTexName = side.middle !== "-" ? side.middle : side.upper !== "-" ? side.upper : side.lower;
    const closed = line.special === "secret_door" && !line.open;
    const doorClosed = other && (other.ceil <= other.floor + 1) && (line.special === "door");
    const solid = !other || closed || doorClosed || line.special === "solid";

    // transform segment
    const c = this.view.cos, s = this.view.sin;
    let A = this.toView(a[0], a[1]);
    let B = this.toView(b[0], b[1]);
    if (A.tz < NEAR && B.tz < NEAR) return;
    if (A.tz < NEAR) {
      const t = (NEAR - A.tz) / (B.tz - A.tz);
      A = { tx: A.tx + (B.tx - A.tx) * t, tz: NEAR };
    } else if (B.tz < NEAR) {
      const t = (NEAR - B.tz) / (A.tz - B.tz);
      B = { tx: B.tx + (A.tx - B.tx) * t, tz: NEAR };
    }
    let sx1 = CX + A.tx * PROJ / A.tz;
    let sx2 = CX + B.tx * PROJ / B.tz;
    let z1 = A.tz, z2 = B.tz;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let u1 = 0, u2 = len;
    if (sx1 > sx2) { [sx1, sx2] = [sx2, sx1]; [z1, z2] = [z2, z1]; [u1, u2] = [u2, u1]; }
    if (sx2 < 0 || sx1 > W - 1) return;
    const x0 = Math.max(0, Math.ceil(sx1 - 0.5));
    const x1 = Math.min(W - 1, Math.floor(sx2 - 0.5));
    if (x0 > x1) return;

    const wallTop = sec.ceil, wallBot = sec.floor;
    let openTop = wallTop, openBot = wallBot;
    if (other) {
      openTop = Math.min(sec.ceil, other.ceil);
      openBot = Math.max(sec.floor, other.floor);
    }
    if (solid) { openTop = wallTop; openBot = wallBot; }

    const texName = wallTexName && wallTexName !== "-" ? wallTexName : sec.wallTex;
    const tex = this.textures.walls[texName] || this.textures.walls.PANEL;
    const tw = tex.w, th = tex.h, tm = tw - 1, thm = th - 1;
    const lightBase = sec.light;

    for (let x = x0; x <= x1; x++) {
      const t = (x + 0.5 - sx1) / (sx2 - sx1 || 1);
      const it = 1 - t;
      const invz = it / z1 + t / z2;
      const depth = 1 / invz;
      const uWorld = (u1 * it / z1 + u2 * t / z2) / invz;
      const yTop = CY - (wallTop - this.view.z) * YSCALE / depth;
      const yBot = CY - (wallBot - this.view.z) * YSCALE / depth;
      const yOpenTop = CY - (openTop - this.view.z) * YSCALE / depth;
      const yOpenBot = CY - (openBot - this.view.z) * YSCALE / depth;
      const topClip = this.clipTop[x], botClip = this.clipBottom[x];
      if (topClip > botClip) continue;

      if (solid) {
        // middle / full wall
        const yy0 = Math.max(Math.min(yTop, yBot), topClip);
        const yy1 = Math.min(Math.max(yTop, yBot), botClip);
        if (yy0 <= yy1) {
          for (let y = Math.ceil(yy0); y <= Math.floor(yy1); y++) {
            const zw = this.view.z + (CY - (y + 0.5)) * depth / YSCALE;
            let v = Math.floor(sec.ceil - zw) & thm;
            if (v < 0) v += th;
            const u = (Math.floor(uWorld) & tm);
            const color = tex.data[v * tw + u];
            if (color === 0) continue;
            const li = lightIndex(lightBase, depth);
            this.put(x, y, color, depth, li);
          }
        }
        const wmin = Math.min(yTop, yBot), wmax = Math.max(yTop, yBot);
        if (wmin <= topClip && wmax >= botClip) {
          this.clipTop[x] = VIEW_H;
          this.clipBottom[x] = -1;
        } else if (wmin <= topClip) {
          this.clipTop[x] = Math.min(VIEW_H, Math.max(topClip, wmax));
        } else if (wmax >= botClip) {
          this.clipBottom[x] = Math.max(-1, Math.min(botClip, wmin));
        }
        continue;
      }

      // upper
      if (openTop < sec.ceil) {
        const yy0 = Math.max(Math.min(yTop, yOpenTop), topClip);
        const yy1 = Math.min(Math.max(yTop, yOpenTop), botClip);
        if (yy0 <= yy1) {
          const utex = this.textures.walls[side.upper !== "-" ? side.upper : sec.wallTex] || tex;
          for (let y = Math.ceil(yy0); y <= Math.floor(yy1); y++) {
            const zw = this.view.z + (CY - (y + 0.5)) * depth / YSCALE;
            let v = Math.floor(side.pegUpper ? (sec.ceil - zw) : (openTop - zw)) & (utex.h - 1);
            if (v < 0) v += utex.h;
            const u = Math.floor(uWorld) & (utex.w - 1);
            const color = utex.data[v * utex.w + u];
            if (color === 0) continue;
            this.put(x, y, color, depth, lightIndex(lightBase, depth));
          }
        }
        if (yOpenTop > topClip) this.clipTop[x] = Math.min(VIEW_H, Math.max(topClip, yOpenTop));
      }
      // lower
      if (openBot > sec.floor) {
        const yy0 = Math.max(Math.min(yOpenBot, yBot), topClip);
        const yy1 = Math.min(Math.max(yOpenBot, yBot), botClip);
        if (yy0 <= yy1) {
          const ltex = this.textures.walls[side.lower !== "-" ? side.lower : sec.wallTex] || tex;
          for (let y = Math.ceil(yy0); y <= Math.floor(yy1); y++) {
            const zw = this.view.z + (CY - (y + 0.5)) * depth / YSCALE;
            let v = Math.floor(side.pegLower ? (zw - sec.floor) : (zw - openBot)) & (ltex.h - 1);
            if (v < 0) v += ltex.h;
            const u = Math.floor(uWorld) & (ltex.w - 1);
            const color = ltex.data[v * ltex.w + u];
            if (color === 0) continue;
            this.put(x, y, color, depth, lightIndex(lightBase, depth));
          }
        }
        if (yOpenBot < botClip) this.clipBottom[x] = Math.max(-1, Math.min(botClip, yOpenBot));
      }
      if (yOpenTop >= yOpenBot) {
        // degenerate opening at this column: no usable portal this column
        this.clipTop[x] = VIEW_H;
        this.clipBottom[x] = -1;
      }
    }
  }

  toView(wx, wy) {
    const dx = wx - this.view.x, dy = wy - this.view.y;
    const c = this.view.cos, s = this.view.sin;
    return { tx: -dx * s + dy * c, tz: dx * c + dy * s };
  }

  // ------------------------------------------------------------- sprites
  drawSprites(game) {
    const list = [];
    const vx = this.view.x, vy = this.view.y, vz = this.view.z;
    const c = this.view.cos, s = this.view.sin;
    const add = (obj, img, worldH, light) => {
      if (!img) return;
      const dx = obj.x / 65536 - vx, dy = obj.y / 65536 - vy;
      const tz = dx * c + dy * s;
      if (tz <= NEAR) return;
      const tx = -dx * s + dy * c;
      const sx = CX + tx * PROJ / tz;
      const w = img.w * (worldH / img.h) * YSCALE / tz;
      const h = worldH * YSCALE / tz;
      if (sx + w / 2 < 0 || sx - w / 2 > W - 1) return;
      list.push({ sx, sz: tz, w, h, img, light, z: (obj.z || 0) / 65536, base: worldH });
    };
    for (const a of game.actors) {
      if (a.kind === "enemy") {
        if (a.removed) continue;
        const sheet = this.sprites.enemies[a.enemy];
        if (!sheet) continue;
        const img = this.enemyFrame(a, sheet);
        if (!img) continue;
        const sec = this.level.sectors[a.sector] || { light: 128 };
        add(a, img, a.deathTime !== undefined && a.stateName === "death" ? 20 : sheet.height, sec.light);
      } else if (a.kind === "pickup") {
        if (a.taken) continue;
        const img = this.sprites.pickups[a.item];
        if (!img) continue;
        const sec = this.level.sectors[a.sector] || { light: 128 };
        add(a, img, 18, sec.light);
      } else if (a.kind === "projectile") {
        const img = this.sprites.projectiles[this.tic & 1];
        const sec = this.level.sectors[a.sector] || { light: 160 };
        add(a, img, 12, sec.light);
      } else if (a.kind === "effect") {
        const frames = this.sprites.effects && this.sprites.effects[a.kind];
        if (!frames) continue;
        const img = frames[Math.min(frames.length - 1, (a.tics / 3.5) | 0)];
        const sec = this.level.sectors[a.sector] || { light: 220 };
        add(a, img, 56, sec.light || 220);
      } else if (a.kind === "decor") {
        const img = this.sprites.decor[a.item];
        if (!img) continue;
        const sec = this.level.sectors[a.sector] || { light: 160 };
        add(a, img, a.height, sec.light);
      }
    }
    for (const e of game.effects || []) {
      const frames = this.sprites.effects && this.sprites.effects[e.kind];
      if (!frames) continue;
      const img = frames[Math.min(frames.length - 1, (e.tics / 3.5) | 0)];
      const sec = this.level.sectors[e.sector] || { light: 220 };
      add(e, img, 56, sec.light || 220);
    }
    list.sort((p, q) => q.sz - p.sz);
    this.lastSprites = list.length;
    for (const sp of list) {
      const img = sp.img, iw = img.w, ih = img.h;
      const left = sp.sx - sp.w / 2;
      const top = CY - (sp.z + sp.base * 0.5 - vz) * YSCALE / sp.sz - sp.h / 2;
      const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W - 1, Math.floor(left + sp.w));
      const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(VIEW_H - 1, Math.floor(top + sp.h));
      for (let x = x0; x <= x1; x++) {
        const u = Math.min(iw - 1, Math.max(0, ((x - left) / sp.w * iw) | 0));
        for (let y = y0; y <= y1; y++) {
          const v = Math.min(ih - 1, Math.max(0, ((y - top) / sp.h * ih) | 0));
          const color = img.data[v * iw + u];
          if (color === 0) continue;
          const li = lightIndex(sp.light, sp.sz);
          this.put(x, y, color, sp.sz, li);
        }
      }
    }
  }

  enemyFrame(a, sheet) {
    let state = a.stateName || "idle";
    if (state === "chase") state = "walk";
    if (!sheet.sheet[0][state]) state = "idle";
    const rel = ((a.angle >>> 0) - (this.view.angle >>> 0)) >>> 0;
    const rot = (((rel / ANG45) | 0) + 4) & 7;
    const frames = sheet.sheet[rot][state];
    const f = frames[a.frame % frames.length];
    return f;
  }

  // ------------------------------------------------------------- weapon / hud
  drawWeapon(game) {
    const p = game.player;
    const frames = this.sprites.weapons[p.weapon];
    if (!frames) return;
    const img = frames[p.weaponFrame || 0];
    const x0 = (W - img.w) / 2 | 0;
    const y0 = VIEW_H - img.h + 4;
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const color = img.data[y * img.w + x];
      if (color === 0) continue;
      this.putRaw(x0 + x, y0 + y, color);
    }
  }

  drawHUD(game) {
    const p = game.player;
    // status bar
    this.panel(0, VIEW_H, W, H - VIEW_H, COL.dark, COL.amber);
    for (let x = 0; x < W; x += 8) this.putRaw(x, VIEW_H, COL.panel);
    this.text(6, VIEW_H + 5, "HP", COL.red, 1);
    this.text(22, VIEW_H + 4, String(p.health | 0).padStart(3, " "), COL.white, 2);
    this.text(62, VIEW_H + 5, "AR", COL.cyan, 1);
    this.text(78, VIEW_H + 4, String(p.armor | 0).padStart(3, " "), COL.cyanHi, 2);
    const wname = p.weapon === "rivet" ? "RIVET" : p.weapon === "scatter" ? "SCATTER" : "ARC";
    const ammo = p.ammo[p.weapon] | 0;
    this.text(122, VIEW_H + 5, wname, COL.green, 1);
    this.text(122, VIEW_H + 14, String(ammo).padStart(3, " "), COL.amberHi, 2);
    // keycards
    let kx = 200;
    if (p.keys.yellow) { this.panel(kx, VIEW_H + 6, 14, 20, COL.amber, COL.amberHi); this.text(kx + 2, VIEW_H + 13, "Y", COL.black, 1); }
    kx += 20;
    if (p.keys.cyan) { this.panel(kx, VIEW_H + 6, 14, 20, COL.cyan, COL.cyanHi); this.text(kx + 2, VIEW_H + 13, "C", COL.black, 1); }
    // weapon slots
    const owned = ["rivet", "scatter", "arc"];
    for (let i = 0; i < 3; i++) {
      const x = 236 + i * 26;
      const on = p.owner[owned[i]];
      this.panel(x, VIEW_H + 6, 22, 19, on ? (p.weapon === owned[i] ? COL.amber : COL.panel) : COL.dark, on ? COL.amberHi : COL.dark);
      this.text(x + 5, VIEW_H + 12, String(i + 1), on ? COL.white : COL.panel, 1);
    }
    // messages
    if (game.message && game.messageTime > 0) {
      const w = textWidth(game.message, 1);
      const x = Math.max(4, (W - w) / 2) | 0;
      this.panel(x - 4, 4, w + 8, 13, COL.black, COL.amber);
      this.text(x, 7, game.message, COL.white, 1);
    }
    // damage flash
    if (this.flash > 0) {
      for (let y = 0; y < VIEW_H; y++) for (let x = 0; x < W; x++) {
        if (x > 14 && x < W - 15 && y > 14 && y < VIEW_H - 15) continue;
        if ((x + y + this.tic) & 3) continue;
        this.pixels[y * W + x] = C(14, 5 + (this.flash & 7));
      }
    }
    // crosshair
    const hx = W / 2 | 0, hy = VIEW_H / 2 | 0;
    this.putRaw(hx - 3, hy, COL.amberHi); this.putRaw(hx + 3, hy, COL.amberHi);
    this.putRaw(hx, hy - 3, COL.amberHi); this.putRaw(hx, hy + 3, COL.amberHi);
  }

  drawPause(game) {
    for (let y = 40; y < 130; y++) for (let x = 60; x < 260; x++) {
      if ((x + y) & 1) this.putRaw(x, y, COL.black);
    }
    this.panel(80, 64, 160, 48, COL.black, COL.amber);
    this.text(120, 72, "PAUSED", COL.white, 2);
    this.text(96, 94, "CLICK TO RESUME", COL.amberHi, 1);
  }

  // ------------------------------------------------------------- screens
  drawTitle(game) {
    // backdrop: use sky + dark panels
    this.drawSky(game);
    this.panel(20, 18, 280, 154, COL.black, COL.amber);
    for (let y = 22; y < 168; y++) for (let x = 24; x < 296; x++) {
      if (x % 3 === 0 || y % 3 === 0) continue;
      this.putRaw(x, y, COL.dark);
    }
    // reactor ring graphic
    const cx = 160, cy = 72;
    for (let r = 44; r > 10; r -= 6) {
      for (let a = 0; a < 360; a += 2) {
        const rad = a * Math.PI / 180;
        this.putRaw(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r, r % 12 === 0 ? COL.amber : COL.steel);
      }
    }
    this.text(60, 22, "CORE BREACH", COL.amberHi, 3);
    this.text(48, 54, "A FUSION STATION HAS GONE ROGUE.", COL.cyan, 1);
    this.text(48, 64, "YOU ARE THE ENGINEER SENT TO SHUT IT DOWN.", COL.cyan, 1);
    this.text(56, 100, "WASD / ARROWS   MOVE", COL.green, 1);
    this.text(56, 110, "MOUSE          TURN", COL.green, 1);
    this.text(56, 120, "CLICK / CTRL   FIRE", COL.green, 1);
    this.text(56, 130, "E / SPACE      USE", COL.green, 1);
    this.text(56, 140, "1 2 3          WEAPONS", COL.green, 1);
    this.text(56, 150, "ESC            PAUSE", COL.green, 1);
    this.text(102, 164, "CLICK TO DEPLOY", COL.amberHi, 1);
  }

  drawDeath(game) {
    this.pixels.fill(0, 0, W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((x + y + this.tic) % 7 === 0) this.putRaw(x, y, 224);
      else if ((x * 3 + y) % 11 === 0) this.putRaw(x, y, C(14, 5));
      else this.putRaw(x, y, COL.black);
    }
    this.panel(40, 50, 240, 96, COL.black, COL.red);
    this.text(52, 62, "CORE BREACH FAILED", COL.redHi, 2);
    this.text(96, 92, "DECK 7 IS STILL HOT.", COL.white, 1);
    this.text(120, 112, "PRESS R TO RETRY", COL.amberHi, 1);
    this.text(96, 128, "TIME " + game.timeString(), COL.cyan, 1);
  }

  drawComplete(game) {
    this.pixels.fill(0, 0, W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      this.putRaw(x, y, (x > 20 && x < 300 && y > 20 && y < 180) ? COL.dark : COL.black);
    }
    this.panel(30, 30, 260, 140, COL.black, COL.amber);
    this.text(34, 42, "DECK 7 SECURED", COL.amberHi, 3);
    this.text(60, 78, "REACTOR CORE SHUT DOWN.", COL.cyan, 1);
    this.text(60, 96, "TIME   " + game.timeString(), COL.white, 1);
    this.text(60, 108, "KILLS  " + game.kills + " / " + game.totalEnemies, COL.white, 1);
    this.text(60, 120, "SECRETS " + game.secrets + " / " + game.totalSecrets, COL.white, 1);
    this.text(60, 140, "PRESS R TO RUN IT AGAIN", COL.amberHi, 1);
  }
}
