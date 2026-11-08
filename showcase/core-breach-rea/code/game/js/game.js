// CORE BREACH game logic: fixed-point player movement, sector movers,
// thinker/state-machine actors, hitscan/sight, pickups and attract mode.
import {
  FRACUNIT, ANG45, ANG90, ANG180, fx, fmul, fdiv, fabs, clamp,
  fineCos, fineSin, pointToAngle, angleToRad, angleDelta, turnToward,
  srand, rand32, randByte, randRange, randomTable, pointToDist,
} from "./fixed.js";

const PLAYER_RADIUS = 16;
const PLAYER_HEIGHT = 56;
const STEP_HEIGHT = 24;
const VIEW_HEIGHT = 41;
const USE_RANGE = 72;

const ENEMY_DEFS = {
  cutter: {
    health: 46, speed: 0x2c000, radius: 18, height: 40, sight: 760,
    melee: 56, damage: 9, cooldown: 36, pain: 0.62, alert: "cutter",
  },
  drone: {
    health: 70, speed: 0x18000, radius: 18, height: 36, sight: 1000,
    ranged: 720, damage: 12, cooldown: 72, pain: 0.5, alert: "drone",
    projectileSpeed: 0x48000,
  },
  sentinel: {
    health: 320, speed: 0x10000, radius: 24, height: 64, sight: 1150,
    ranged: 1000, damage: 7, cooldown: 96, pain: 0.22, alert: "sentinel",
    burst: 3,
  },
};

const WEAPON_DEFS = {
  rivet: { ammo: "rivet", cost: 1, cooldown: 7, damage: 18, range: 1600, spread: 0, pellets: 1 },
  scatter: { ammo: "scatter", cost: 1, cooldown: 24, damage: 7, range: 900, spread: 0.16, pellets: 7 },
  arc: { ammo: "arc", cost: 1, cooldown: 26, damage: 42, range: 1200, spread: 0, projectile: true },
};

// Authored trailer route.  Scenic pauses use lookAt / lookAngle so the
// attract controller can turn smoothly and linger on the view windows.
const ROUTE = [
  { x: 420, y: 128 },
  { x: 690, y: 128 },
  { x: 1000, y: 180 },
  { x: 1380, y: 192 },
  { x: 1696, y: 110, pause: 30 },                 // scatter cannon
  { x: 1700, y: 192 },
  { x: 1824, y: 304, pause: 16 },                 // yellow keycard
  { x: 1700, y: 260, pause: 45, lookAt: [1696, 288], combat: true, focus: ["cutter"] },
  { x: 1700, y: 192 },
  { x: 1150, y: 192 },
  { x: 1088, y: 350, use: true, face: [1088, 416] },
  { x: 1088, y: 520 },
  { x: 1088, y: 700 },
  { x: 1180, y: 760 },
  { x: 1360, y: 780, pause: 120, lookAt: [1792, 780] }, // outdoor windows
  { x: 1180, y: 800 },
  { x: 900, y: 820 },
  { x: 704, y: 820, use: true, face: [704, 896] },       // service lift
  { x: 704, y: 820, waitLift: true },
  { x: 590, y: 832 },
  { x: 470, y: 820, pause: 50, lookAt: [448, 704], combat: true, focus: ["cutter"] },
  { x: 400, y: 832 },
  { x: 340, y: 930 },
  { x: 512, y: 1000 },
  { x: 512, y: 1024, pause: 45, lookAt: [640, 1024] },   // coolant pool
  { x: 512, y: 1100 },
  { x: 450, y: 1180 },
  { x: 320, y: 1248, pause: 14 },                 // cyan keycard
  { x: 520, y: 1216 },
  { x: 640, y: 1216, use: true, face: [672, 1216] },
  { x: 800, y: 1216 },
  { x: 960, y: 1216 },
  { x: 1080, y: 1216 },
  { x: 1260, y: 1260 },
  { x: 1632, y: 1232, pause: 30 },                // arc launcher
  { x: 1560, y: 1260, pause: 120, lookAt: [1504, 1312], combat: true, focus: ["drone", "sentinel"] }, // arc blast
  { x: 1500, y: 1240, pause: 100, lookAt: [1408, 1024], combat: true, focus: ["sentinel", "drone"] }, // arc blast
  { x: 1460, y: 1300, pause: 35, lookAt: [1400, 1280] }, // reactor core
  { x: 1680, y: 1470 },
  { x: 1700, y: 1560, use: true, face: [1696, 1600] },   // exit switch
];

export class Game {
  constructor(level, audio) {
    this.level = level;
    this.audio = audio;
    this.state = "title";
    this.tic = 0;
    this.inputOverride = null;
    this.prevUse = false;
    this.keys = Object.create(null);
    this.mouseDown = false;
    this.mouseDX = 0;
    this.useQueued = false;
    this.weaponRequest = 0;
    this.message = "";
    this.messageTime = 0;
    this.damageFlash = 0;
    this.kills = 0;
    this.totalEnemies = 0;
    this.secrets = 0;
    this.totalEnemies = 0;
    this.totalSecrets = 0;
    this.attract = false;
    this.attractIndex = 0;
    this.attractWait = 0;
    this.attractPause = 0;
    this.attractTarget = null;
    this.attractStats = this.freshAttractStats();
    this.reachedCore = false;
    this.lastPos = { x: 0, y: 0 };
    this.stuckTics = 0;
    this.rngTable = randomTable();
    this.reset();
  }

  freshAttractStats() {
    return {
      startTic: this.tic || 0,
      durationTics: 0,
      healthMin: 100, healthMax: 100,
      armorMin: 0, armorMax: 0,
      fireTics: 0, flashTics: 0, flashRun: 0, maxFlashRun: 0,
      useMisses: 0, useTargets: [],
      weaponShots: { rivet: 0, scatter: 0, arc: 0 },
      weaponTargets: {},
      scatterCutterShots: 0,
      arcHeavyShots: 0,
      noTargetShots: 0,
      fights: { cutter: false, drone: false, sentinel: false },
      features: {
        door: false, yellowDoor: false, cyanDoor: false, lift: false,
        coolant: false, outdoor: false, reactor: false, core: false, complete: false,
      },
      arcBlasts: 0,
      targetTics: 0,
    };
  }

  recordAttractTick() {
    const st = this.attractStats, p = this.player;
    st.healthMin = Math.min(st.healthMin, p.health);
    st.healthMax = Math.max(st.healthMax, p.health);
    st.armorMin = Math.min(st.armorMin, p.armor);
    st.armorMax = Math.max(st.armorMax, p.armor);
    if (this.attractTarget) st.targetTics++;
    if (p.weaponAnim > 0) {
      st.flashTics++;
      st.flashRun++;
      st.maxFlashRun = Math.max(st.maxFlashRun, st.flashRun);
    } else {
      st.flashRun = 0;
    }
  }

  reset() {
    srand(0xC0DEB4EA);
    this.rngTable = randomTable();
    this.tic = 0;
    this.kills = 0;
    this.totalEnemies = 0;
    this.secrets = 0;
    this.message = "";
    this.messageTime = 0;
    this.damageFlash = 0;
    this.attractIndex = 0;
    this.attractWait = 0;
    this.attractPause = 0;
    this.attractTarget = null;
    this.attractStats = this.freshAttractStats();
    this.reachedCore = false;
    this.prevUse = false;
    this.useQueued = false;
    this.weaponRequest = 0;
    this.mouseDX = 0;

    this.sectors = this.level.sectors.map((s) => {
      const r = {
        ...s,
        floor: s.floor,
        ceil: s.ceil,
        light: s.light,
        baseLight: s.light,
        lightTimer: 0,
        doorState: s.door ? "closed" : null,
        doorTimer: 0,
        doorSpeed: 2,
        liftState: s.lift ? "idle" : null,
        liftTimer: 0,
        liftTarget: s.lift ? s.lift.high : 0,
      };
      if (s.door) r.ceil = s.floor; // starts shut
      if (s.lift) r.floor = s.lift.high;
      return r;
    });
    this.totalSecrets = this.sectors.filter((s) => s.secret).length;
    const start = this.level.playerStart || this.level.things.find((t) => t.kind === "player");
    const startSec = this.sectors[start.sector] || this.sectors[0];
    this.player = {
      x: fx(start.x), y: fx(start.y), z: fx(startSec.floor),
      vx: 0, vy: 0, vz: 0,
      angle: pointToAngle(1, 0) + Math.round((start.angle / 360) * 4294967296) >>> 0,
      radius: PLAYER_RADIUS, height: PLAYER_HEIGHT, viewHeight: VIEW_HEIGHT * FRACUNIT,
      health: 100, armor: 0,
      ammo: { rivet: 50, scatter: 8, arc: 2 },
      owner: { rivet: true, scatter: false, arc: false },
      weapon: "rivet", weaponFrame: 0, weaponAnim: 0, weaponCooldown: 0,
      keys: { yellow: false, cyan: false },
      sector: startSec.id, bob: 0, bobPhase: 0, onGround: true,
      damageTimer: 0, sectorSeen: new Set(),
      dead: false,
    };

    this.actors = [];
    this.projectiles = [];
    this.effects = [];
    for (const t of this.level.things) {
      if (t.kind === "player") continue;
      const sec = this.sectors[t.sector] || startSec;
      if (t.kind === "enemy") {
        const def = ENEMY_DEFS[t.enemy];
        this.actors.push({
          id: this.actors.length, kind: "enemy", enemy: t.enemy, x: fx(t.x), y: fx(t.y),
          z: fx(sec.floor), angle: Math.round((t.angle / 360) * 4294967296) >>> 0,
          radius: def.radius, height: def.height, health: def.health,
          stateName: "idle", stateTics: 0, frame: 0, dead: false, removed: false,
          alerted: false, cooldown: randRange(30), attackDone: false, pain: def.pain,
          sector: t.sector, deathTics: 0, baseSector: sec.floor,
        });
        this.totalEnemies++;
      } else if (t.kind === "pickup") {
        this.actors.push({
          id: this.actors.length, kind: "pickup", item: t.item, x: fx(t.x), y: fx(t.y),
          z: fx(sec.floor), angle: 0, radius: t.radius, height: t.height,
          sector: t.sector, taken: false, bob: 0,
        });
      } else if (t.kind === "decor") {
        this.actors.push({
          id: this.actors.length, kind: "decor", item: t.item, x: fx(t.x), y: fx(t.y),
          z: fx(sec.floor), angle: 0, radius: t.radius, height: t.height, sector: t.sector,
        });
      }
    }
    this.markSeenSector();
  }

  startGame() {
    this.reset();
    this.state = "playing";
    this.attract = false;
    this.audio.resume();
  }
  startAttract() {
    this.reset();
    this.state = "playing";
    this.attract = true;
    this.attractStats.startTic = this.tic;
    this.attractStats.healthMin = this.attractStats.healthMax = this.player.health;
    this.attractStats.armorMin = this.attractStats.armorMax = this.player.armor;
    this.audio.resume();
  }

  // ------------------------------------------------------------------ input
  keyboardInput() {
    const k = this.keys;
    let forward = 0, strafe = 0;
    if (k["KeyW"] || k["ArrowUp"]) forward++;
    if (k["KeyS"] || k["ArrowDown"]) forward--;
    if (k["KeyD"] || k["ArrowRight"]) strafe++;
    if (k["KeyA"] || k["ArrowLeft"]) strafe--;
    let turn = 0;
    if (this.mouseDX) turn = this.mouseDX * 0.045;
    this.mouseDX = 0;
    const use = this.useQueued;
    this.useQueued = false;
    let weapon = this.weaponRequest;
    this.weaponRequest = 0;
    return { forward, strafe, turn, fire: this.mouseDown || !!k["ControlLeft"] || !!k["ControlRight"], use, weapon };
  }

  getInput() {
    if (this.inputOverride) {
      const o = this.inputOverride;
      return {
        forward: +o.forward || 0, strafe: +o.strafe || 0, turn: +o.turn || 0,
        fire: !!o.fire, use: !!o.use, weapon: o.weapon | 0,
      };
    }
    if (this.attract) return this.attractInput();
    return this.keyboardInput();
  }

  // ------------------------------------------------------------------ tick
  tick() {
    this.tic++;
    if (this.damageFlash > 0) this.damageFlash--;
    if (this.messageTime > 0) this.messageTime--;
    if (this.player.weaponAnim > 0) this.player.weaponAnim--;
    if (this.player.weaponCooldown > 0) this.player.weaponCooldown--;

    if (this.state === "playing") {
      const input = this.getInput();
      const useEdge = input.use && !this.prevUse;
      this.prevUse = input.use;
      if (this.player.dead) {
        this.state = "dead";
        return;
      }
      this.updateSectors();
      this.updatePlayer(input, useEdge);
      this.updateActors();
      this.updateProjectiles();
      this.updateEffects();
      this.updatePickups();
      this.updateMessages();
      this.updateSecrets();
      if (this.attract) this.updateAttract(input);
      if (this.attract) this.recordAttractTick();
      if (this.attract && this.state === "done") {
        this.attractPause++;
        if (this.attractPause > 140) {
          this.reset();
          this.state = "playing";
          this.attract = true;
        }
      }
    } else if (this.state === "done" || this.state === "dead") {
      if (this.attract) {
        this.attractPause++;
        if (this.attractPause > 140) {
          this.reset();
          this.state = "playing";
          this.attract = true;
        }
      }
    }
  }

  updateMessages() {
    if (this.messageTime === 0 && this.message) this.message = "";
  }

  setMessage(m, t = 90) { this.message = m; this.messageTime = t; }

  // ------------------------------------------------------------------ sectors
  updateSectors() {
    for (const s of this.sectors) {
      if (s.flicker) {
        s.lightTimer++;
        if (s.lightTimer % 3 === 0) {
          const t = (this.tic * 0.11 + s.id * 0.7);
          const f = (Math.sin(t) + Math.sin(t * 2.7)) * 0.25 + 0.5;
          s.light = Math.round(s.lightMin + (s.lightMax - s.lightMin) * clamp(f, 0, 1));
        }
      }
      if (s.doorState) this.updateDoor(s);
      if (s.liftState) this.updateLift(s);
    }
    // carry the player/actors standing on a moving floor
    for (const s of this.sectors) {
      if (!s.liftState && !s.doorState) continue;
      if (this.player.sector === s.id) {
        const fz = fx(s.floor);
        if (this.player.z < fz && fz - this.player.z < fx(40)) this.player.z = fz;
      }
    }
  }

  updateDoor(s) {
    const targetOpen = s.floor + 128;
    if (s.doorState === "opening") {
      s.ceil += s.doorSpeed;
      if (s.ceil >= targetOpen) { s.ceil = targetOpen; s.doorState = "open"; s.doorTimer = 150; }
    } else if (s.doorState === "open") {
      s.doorTimer--;
      if (s.doorTimer <= 0) s.doorState = "closing";
    } else if (s.doorState === "closing") {
      // reopen if the player is inside the door sector
      if (this.player.sector === s.id) { s.doorState = "opening"; this.audio.door(); return; }
      s.ceil -= s.doorSpeed;
      if (s.ceil <= s.floor) { s.ceil = s.floor; s.doorState = "closed"; }
    }
  }

  activateDoor(s, key) {
    if (s.doorState === "closed" || s.doorState === "closing") {
      if (key === "yellow" && !this.player.keys.yellow) { this.setMessage("YELLOW KEYCARD REQUIRED"); this.audio.empty(); return false; }
      if (key === "cyan" && !this.player.keys.cyan) { this.setMessage("CYAN KEYCARD REQUIRED"); this.audio.empty(); return false; }
      s.doorState = "opening";
      this.audio.door();
      this.setMessage((key || "BULKHEAD") + " DOOR OPENING", 60);
      if (this.attract) {
        this.attractStats.features.door = true;
        if (key === "yellow") this.attractStats.features.yellowDoor = true;
        if (key === "cyan") this.attractStats.features.cyanDoor = true;
      }
      return true;
    }
    return false;
  }

  updateLift(s) {
    const low = s.lift.low, high = s.lift.high;
    if (s.liftState === "moving") {
      if (this.attract && this.player.sector === s.id) this.attractStats.features.lift = true;
      if (s.floor < s.liftTarget) {
        s.floor += 2;
        if (s.floor >= s.liftTarget) { s.floor = s.liftTarget; s.liftState = "wait"; s.liftTimer = 100; }
      } else if (s.floor > s.liftTarget) {
        s.floor -= 2;
        if (s.floor <= s.liftTarget) { s.floor = s.liftTarget; s.liftState = "wait"; s.liftTimer = 100; }
      }
    } else if (s.liftState === "wait") {
      s.liftTimer--;
      if (s.liftTimer <= 0) {
        s.liftTarget = s.floor > (low + high) / 2 ? low : high;
        s.liftState = "moving";
        this.audio.lift();
      }
    }
  }

  activateLift(s) {
    if (s.liftState === "moving") return false;
    const mid = (s.lift.low + s.lift.high) / 2;
    s.liftTarget = s.floor > mid ? s.lift.low : s.lift.high;
    s.liftState = "moving";
    s.liftTimer = 0;
    this.audio.lift();
    this.setMessage("SERVICE LIFT " + (s.liftTarget === s.lift.high ? "UP" : "DOWN"), 60);
    return true;
  }

  // ------------------------------------------------------------------ movement
  sectorAt(x, y) {
    const wx = x / FRACUNIT, wy = y / FRACUNIT;
    for (let i = 0; i < this.sectors.length; i++) {
      const s = this.sectors[i];
      const p = s.poly;
      let inside = true;
      for (let j = 0; j < p.length; j++) {
        const a = p[j], b = p[(j + 1) % p.length];
        if ((b[0] - a[0]) * (wy - a[1]) - (b[1] - a[1]) * (wx - a[0]) < -1e-5) { inside = false; break; }
      }
      if (inside) return s;
    }
    return null;
  }

  markSeenSector() {
    const s = this.sectorAt(this.player.x, this.player.y);
    if (!s) return;
    this.player.sector = s.id;
    if (s.secret && !this.player.sectorSeen.has(s.id)) {
      this.player.sectorSeen.add(s.id);
      this.secrets++;
      this.audio.secret();
      this.setMessage("SECRET AREA FOUND", 100);
    }
  }

  updateSecrets() {
    const s = this.sectorAt(this.player.x, this.player.y);
    if (!s) return;
    this.player.sector = s.id;
    if (s.secret && !this.player.sectorSeen.has(s.id)) {
      this.player.sectorSeen.add(s.id);
      this.secrets++;
      this.audio.secret();
      this.setMessage("SECRET AREA FOUND", 100);
    }
  }

  lineBlocks(line, sec) {
    if (line.special === "secret_door" && !line.open) return true;
    if (line.special === "solid") return true;
    if (line.window) return true;
    if (line.back < 0) return true;
    if (line.special === "door") {
      const ds = this.sectors[line.doorSector];
      if (ds && ds.ceil <= ds.floor + 1) return true;
    }
    return false;
  }

  pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const qx = x1 + dx * t, qy = y1 + dy * t;
    return Math.hypot(px - qx, py - qy);
  }

  moveBlocked(actor, nx, ny, sec) {
    const r = actor.radius;
    const target = this.sectorAt(nx, ny);
    if (!target) return true;
    const cur = this.sectorAt(actor.x, actor.y);
    const curFloor = cur ? cur.floor : target.floor;
    if (target.floor - curFloor > STEP_HEIGHT) return true;
    if (target.ceil - target.floor < actor.height) return true;
    if (target.floor > actor.z / FRACUNIT + 0.01 && actor.z / FRACUNIT + STEP_HEIGHT < target.floor) return true;
    const px = nx / FRACUNIT, py = ny / FRACUNIT;
    for (const line of this.level.lines) {
      if (!this.lineBlocks(line, target)) continue;
      const d = this.pointSegDist(px, py, line.x1, line.y1, line.x2, line.y2);
      if (d < r) return true;
    }
    return false;
  }

  tryMove(actor, dx, dy) {
    if (!dx && !dy) return true;
    let nx = actor.x + dx, ny = actor.y + dy;
    let target = this.sectorAt(nx, ny);
    if (!this.moveBlocked(actor, nx, ny, target)) {
      actor.x = nx; actor.y = ny;
      if (target) {
        actor.sector = target.id;
        if (actor === this.player) {
          const fz = fx(target.floor);
          if (fz > actor.z && fz - actor.z <= fx(STEP_HEIGHT)) actor.z = fz;
          if (fz < actor.z && actor.z - fz > fx(48)) actor.vz = Math.min(actor.vz, 0);
        }
      }
      return true;
    }
    // axis slide
    nx = actor.x + dx; ny = actor.y;
    if ((dx || dy) && !this.moveBlocked(actor, nx, ny, this.sectorAt(nx, ny))) {
      actor.x = nx; actor.sector = (this.sectorAt(nx, ny) || target).id; return true;
    }
    nx = actor.x; ny = actor.y + dy;
    if (!this.moveBlocked(actor, nx, ny, this.sectorAt(nx, ny))) {
      actor.y = ny; actor.sector = (this.sectorAt(nx, ny) || target).id; return true;
    }
    // wall slide: find the deepest blocking wall and remove inward motion
    const px = (actor.x + dx) / FRACUNIT, py = (actor.y + dy) / FRACUNIT;
    let best = null, bestD = Infinity;
    for (const line of this.level.lines) {
      if (!this.lineBlocks(line, target)) continue;
      const d = this.pointSegDist(px, py, line.x1, line.y1, line.x2, line.y2);
      if (d < bestD) { bestD = d; best = line; }
    }
    if (best) {
      let nx2 = -(best.y2 - best.y1), ny2 = best.x2 - best.x1;
      const l = Math.hypot(nx2, ny2) || 1;
      nx2 /= l; ny2 /= l;
      let d2 = dx * nx2 + dy * ny2;
      // push out along normal
      if (d2 < 0) { dx -= d2 * nx2; dy -= d2 * ny2; }
      nx = actor.x + dx; ny = actor.y + dy;
      if (!this.moveBlocked(actor, nx, ny, this.sectorAt(nx, ny))) {
        actor.x = nx; actor.y = ny; actor.sector = (this.sectorAt(nx, ny) || target).id; return true;
      }
    }
    actor.vx = fmul(actor.vx, 0x4000);
    actor.vy = fmul(actor.vy, 0x4000);
    return false;
  }

  updatePlayer(input, useEdge) {
    const p = this.player;
    if (p.dead) return;
    // turning
    if (input.turn) p.angle = (p.angle + Math.round(input.turn * 0x04000000)) >>> 0;
    const cos = fineCos(p.angle), sin = fineSin(p.angle);
    const fwd = Math.round(clamp(input.forward, -1, 1) * FRACUNIT);
    const str = Math.round(clamp(input.strafe, -1, 1) * FRACUNIT);
    const accel = 0x3000;
    const ax = fmul(fmul(fwd, cos), accel) - fmul(fmul(str, sin), accel);
    const ay = fmul(fmul(fwd, sin), accel) + fmul(fmul(str, cos), accel);
    p.vx += ax;
    p.vy += ay;
    // friction
    p.vx = fmul(p.vx, 0xe800);
    p.vy = fmul(p.vy, 0xe800);
    if (fabs(p.vx) < 0x800) p.vx = 0;
    if (fabs(p.vy) < 0x800) p.vy = 0;
    const max = this.attract ? 0x80000 : 0x50000;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > max) { p.vx = p.vx / sp * max; p.vy = p.vy / sp * max; }
    this.tryMove(p, p.vx | 0, p.vy | 0);

    const sec = this.sectorAt(p.x, p.y) || this.sectors[p.sector] || this.sectors[0];
    p.sector = sec.id;
    const floorZ = fx(sec.floor), ceilZ = fx(sec.ceil);
    p.vz -= 0x4000;
    p.z += p.vz;
    if (p.z <= floorZ) { p.z = floorZ; p.vz = 0; p.onGround = true; }
    else p.onGround = false;
    if (p.z + fx(p.height) > ceilZ) { p.z = ceilZ - fx(p.height); if (p.vz > 0) p.vz = 0; }
    if (p.onGround) {
      const speed = Math.hypot(p.vx, p.vy) / FRACUNIT;
      p.bobPhase += speed * 0.20;
      p.bob = Math.sin(p.bobPhase) * 1.6 * FRACUNIT;
    } else p.bob *= 0.9;

    // coolant / damage floors
    if (sec.damage > 0 && p.z <= floorZ + 0x1000) {
      p.damageTimer++;
      if (this.attract) this.attractStats.features.coolant = true;
      if (p.damageTimer % 16 === 0) {
        this.damagePlayer(sec.damage);
        this.setMessage("COOLANT BURN", 45);
      }
    } else p.damageTimer = 0;

    // weapon switch
    if (input.weapon) {
      const names = ["rivet", "scatter", "arc"];
      const w = names[input.weapon - 1];
      if (w && p.owner[w] && p.weapon !== w) { p.weapon = w; this.audio.switchOn(); }
    }
    // fire
    if (input.fire) {
      if (this.attract) this.attractStats.fireTics++;
      this.fireWeapon();
    }
    // use
    if (useEdge) this.useLine();
    // weapon animation
    if (p.weaponAnim > 0) {
      p.weaponFrame = p.weaponAnim > 3 ? 1 : p.weaponAnim > 1 ? 2 : 3;
    } else p.weaponFrame = 0;
  }

  // ------------------------------------------------------------------ use
  findUsableLine(allowed = null) {
    const p = this.player;
    const px = p.x / FRACUNIT, py = p.y / FRACUNIT;
    const dir = angleToRad(p.angle);
    const dx = Math.cos(dir), dy = Math.sin(dir);
    let best = null, bestScore = Infinity;
    for (const line of this.level.lines) {
      if (line.special === "none") continue;
      if (allowed && !allowed.includes(line.special)) continue;
      const mx = (line.x1 + line.x2) / 2, my = (line.y1 + line.y2) / 2;
      const d = Math.hypot(mx - px, my - py);
      if (d > USE_RANGE + 40) continue;
      const ang = Math.atan2(my - py, mx - px);
      let diff = Math.abs(((ang - dir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff > Math.PI / 2.2) continue;
      const score = d + diff * 20;
      if (score < bestScore) { bestScore = score; best = line; }
    }
    return best;
  }

  useLine() {
    const best = this.findUsableLine();
    if (!best) {
      if (this.attract) {
        this.attractStats.useMisses++;
      } else {
        this.setMessage("NOTHING TO USE", 30);
      }
      return false;
    }
    if (best.special === "door") {
      const s = this.sectors[best.doorSector];
      this.activateDoor(s, best.key);
    } else if (best.special === "lift") {
      const s = this.sectors[best.liftSector];
      this.activateLift(s);
    } else if (best.special === "secret_door") {
      best.open = !best.open;
      this.audio.switchOn();
      this.setMessage(best.open ? "SECRET PANEL OPEN" : "SECRET PANEL CLOSED", 60);
      if (best.open && best.secretSector >= 0) {
        const s = this.sectors[best.secretSector];
        if (s && !p.sectorSeen.has(s.id)) {
          // discovered by opening the panel; counted when entered
        }
      }
    } else if (best.special === "exit") {
      this.finishLevel();
    }
    if (this.attract) this.attractStats.useTargets.push(best.special);
    return true;
  }

  finishLevel() {
    if (this.state !== "playing") return;
    this.state = "done";
    if (this.attract) {
      this.reachedCore = true;
      this.attractStats.durationTics = this.tic - this.attractStats.startTic;
      this.attractStats.features.core = true;
      this.attractStats.features.reactor = true;
      this.attractStats.features.complete = true;
    }
    this.audio.exit();
    this.setMessage("CORE SHUTDOWN COMPLETE", 200);
  }

  // ------------------------------------------------------------------ combat
  fireWeapon() {
    const p = this.player;
    if (p.weaponCooldown > 0) return;
    const def = WEAPON_DEFS[p.weapon];
    if (!p.owner[p.weapon]) return;
    if (p.ammo[def.ammo] <= 0) { this.audio.empty(); this.setMessage("OUT OF AMMO", 40); p.weaponCooldown = 10; return; }
    p.ammo[def.ammo] -= def.cost;
    p.weaponCooldown = def.cooldown;
    p.weaponAnim = 6;
    if (this.attract) {
      this.attractStats.weaponShots[p.weapon]++;
      if (!this.attractTarget) this.attractStats.noTargetShots++;
      else {
        const target = this.attractTarget;
        const d = Math.hypot((target.x - p.x) / FRACUNIT, (target.y - p.y) / FRACUNIT);
        const key = p.weapon + ":" + target.enemy;
        this.attractStats.weaponTargets[key] = (this.attractStats.weaponTargets[key] || 0) + 1;
        this.attractStats.fights[target.enemy] = true;
        if (p.weapon === "scatter" && target.enemy === "cutter" && d < 220) {
          this.attractStats.scatterCutterShots++;
        }
        if (p.weapon === "arc" && (target.enemy === "drone" || target.enemy === "sentinel")) {
          this.attractStats.arcHeavyShots++;
        }
      }
    }
    if (p.weapon === "rivet") this.audio.shootRivet();
    else if (p.weapon === "scatter") this.audio.shootScatter();
    else this.audio.shootArc();
    this.alertEnemies(p.x / FRACUNIT, p.y / FRACUNIT, 900);

    if (def.projectile) {
      this.spawnProjectile(p.x, p.y, p.z + fx(32), p.angle, 0x60000, def.damage, "arc", true);
      return;
    }
    const spread = def.spread;
    for (let i = 0; i < def.pellets; i++) {
      let ang = p.angle;
      if (spread) {
        const off = (randByte() / 255 - 0.5) * spread * 2;
        ang = (p.angle + Math.round(off * 0x100000000 / (Math.PI * 2))) >>> 0;
      }
      this.hitscan(pxRound(p.x), pxRound(p.y), p.z + fx(34), ang, def.range, def.damage, true);
    }
  }

  hitscan(x, y, z, angle, range, damage, fromPlayer) {
    const dir = angleToRad(angle);
    const dx = Math.cos(dir), dy = Math.sin(dir);
    const px = x / FRACUNIT, py = y / FRACUNIT;
    let bestT = range;
    let hit = null;
    for (const line of this.level.lines) {
      if (!this.lineBlocks(line, null)) continue;
      const t = raySeg(px, py, dx, dy, line.x1, line.y1, line.x2, line.y2);
      if (t > 0 && t < bestT) { bestT = t; hit = null; }
    }
    const targets = fromPlayer ? this.actors.filter((a) => a.kind === "enemy" && !a.dead) :
      [{ kind: "player", x: this.player.x, y: this.player.y, radius: PLAYER_RADIUS, enemy: "player" }];
    for (const a of targets) {
      const ax = a.x / FRACUNIT, ay = a.y / FRACUNIT;
      const ox = ax - px, oy = ay - py;
      const t = ox * dx + oy * dy;
      if (t <= 0 || t >= bestT) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp <= a.radius) { bestT = t; hit = a; }
    }
    if (hit) {
      if (fromPlayer) this.damageEnemy(hit, damage, "player");
      else this.damagePlayer(damage);
      return true;
    }
    if (bestT < range) this.audio.impact();
    return false;
  }

  spawnProjectile(x, y, z, angle, speed, damage, type, fromPlayer) {
    const dir = angleToRad(angle);
    this.projectiles.push({
      kind: "projectile", x, y, z,
      vx: Math.round(Math.cos(dir) * speed), vy: Math.round(Math.sin(dir) * speed),
      angle, damage, type, fromPlayer, radius: 6, height: 12,
      owner: fromPlayer ? "player" : "enemy", life: 200, sector: this.player.sector,
    });
  }

  updateProjectiles() {
    for (const pr of this.projectiles) {
      pr.life--;
      if (pr.life <= 0) { pr.dead = true; continue; }
      pr.x += pr.vx; pr.y += pr.vy;
      const sec = this.sectorAt(pr.x, pr.y);
      if (!sec) { pr.dead = true; continue; }
      pr.sector = sec.id;
      if (pr.z < fx(sec.floor)) pr.z = fx(sec.floor);
      if (pr.x < 0 || pr.y < 0) { pr.dead = true; continue; }
      // wall collision
      const px = pr.x / FRACUNIT, py = pr.y / FRACUNIT;
      for (const line of this.level.lines) {
        if (!this.lineBlocks(line, sec)) continue;
        if (this.pointSegDist(px, py, line.x1, line.y1, line.x2, line.y2) < pr.radius) { pr.dead = true; break; }
      }
      if (pr.dead) { this.explode(pr); continue; }
      // actor collision
      if (pr.fromPlayer) {
        for (const a of this.actors) {
          if (a.kind !== "enemy" || a.dead) continue;
          if (Math.hypot(a.x - pr.x, a.y - pr.y) < a.radius * FRACUNIT + pr.radius * FRACUNIT) {
            pr.dead = true;
            this.explode(pr);
            break;
          }
        }
      } else {
        const p = this.player;
        if (Math.hypot(p.x - pr.x, p.y - pr.y) < fx(p.radius + pr.radius) && Math.abs(p.z + fx(28) - pr.z) < fx(40)) {
          pr.dead = true;
          this.explode(pr);
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  updateEffects() {
    for (const e of this.effects) {
      e.tics++;
      if (e.tics >= e.life) e.dead = true;
    }
    this.effects = this.effects.filter((e) => !e.dead);
  }

  explode(pr) {
    this.audio.explosion();
    if (pr.type === "arc") {
      if (this.attract) this.attractStats.arcBlasts++;
      this.effects.push({
        kind: "arc", x: pr.x, y: pr.y, z: pr.z, sector: pr.sector,
        tics: 0, life: 20, radius: 54,
      });
      const cx = pr.x, cy = pr.y;
      for (const a of this.actors) {
        if (a.kind !== "enemy" || a.dead) continue;
        if (Math.hypot(a.x - cx, a.y - cy) < fx(96)) this.damageEnemy(a, pr.damage, "blast");
      }
      const p = this.player;
      if (Math.hypot(p.x - cx, p.y - cy) < fx(80)) this.damagePlayer(10);
      this.damageFlash = Math.max(this.damageFlash, 6);
    }
  }

  damageEnemy(a, amount, source) {
    if (a.dead) return;
    a.health -= amount;
    if (a.health <= 0) {
      a.dead = true;
      a.stateName = "death";
      a.stateTics = 0;
      a.frame = 0;
      a.deathTics = 0;
      this.kills++;
      this.audio.death(a.enemy);
      return;
    }
    a.alerted = true;
    if (randByte() / 255 < a.pain) {
      a.stateName = "pain";
      a.stateTics = 0;
      a.frame = 0;
      this.audio.pain(a.enemy);
    }
  }

  damagePlayer(amount) {
    const p = this.player;
    if (p.dead || this.state !== "playing") return;
    // Trailer mode uses normal 0..100 HUD values and survives through
    // reduced incoming damage plus a small recovery floor, not inflated HP.
    if (this.attract) amount = Math.max(1, Math.round(amount * 0.18));
    let dmg = amount;
    if (p.armor > 0) {
      const absorbed = Math.min(p.armor, Math.floor(amount / 3));
      p.armor -= absorbed;
      dmg -= absorbed;
    }
    p.health -= dmg;
    this.damageFlash = 6;
    this.audio.playerHurt();
    if (p.health <= 0) {
      if (this.attract) {
        p.health = 16;
      } else {
        p.health = 0;
        p.dead = true;
        this.audio.playerDie();
        this.state = "dead";
      }
    }
  }

  // ------------------------------------------------------------------ enemies
  alertEnemies(x, y, radius) {
    for (const a of this.actors) {
      if (a.kind !== "enemy" || a.dead) continue;
      if (Math.hypot(a.x / FRACUNIT - x, a.y / FRACUNIT - y) < radius) a.alerted = true;
    }
  }

  canSee(a) {
    const p = this.player;
    const dx = (p.x - a.x) / FRACUNIT, dy = (p.y - a.y) / FRACUNIT;
    const dist = Math.hypot(dx, dy);
    if (dist > ENEMY_DEFS[a.enemy].sight) return false;
    const ang = pointToAngle(p.x - a.x, p.y - a.y);
    const facing = angleDelta(ang, a.angle);
    if (Math.abs(facing) > ANG90 && dist > 180) return false;
    return this.los(a.x / FRACUNIT, a.y / FRACUNIT, p.x / FRACUNIT, p.y / FRACUNIT);
  }

  los(x1, y1, x2, y2) {
    for (const line of this.level.lines) {
      if (line.window) continue;
      if (line.special === "solid") {
        if (segIntersect(x1, y1, x2, y2, line.x1, line.y1, line.x2, line.y2)) return false;
        continue;
      }
      if (line.special === "secret_door" && line.open) continue;
      if (line.back >= 0) {
        if (line.special === "door") {
          const ds = this.sectors[line.doorSector];
          if (ds && ds.ceil > ds.floor + 4) continue;
        } else continue;
      }
      if (segIntersect(x1, y1, x2, y2, line.x1, line.y1, line.x2, line.y2)) return false;
    }
    return true;
  }

  updateActors() {
    const p = this.player;
    for (const a of this.actors) {
      if (a.kind === "pickup") { a.bob = Math.sin((this.tic + a.id * 7) * 0.07) * 2; continue; }
      if (a.kind !== "enemy") continue;
      const def = ENEMY_DEFS[a.enemy];
      if (a.dead) {
        a.deathTics++;
        a.frame = Math.min(3, (a.deathTics / 8) | 0);
        if (a.deathTics > 40) a.removed = true;
        continue;
      }
      a.stateTics++;
      if (a.stateName === "pain") {
        if (a.stateTics > 8) { a.stateName = "walk"; a.stateTics = 0; }
        continue;
      }
      const dist = Math.hypot((p.x - a.x) / FRACUNIT, (p.y - a.y) / FRACUNIT);
      const see = this.canSee(a);
      if (!a.alerted && (see || dist < 180)) {
        a.alerted = true;
        this.audio.alert(a.enemy);
      }
      if (!a.alerted) {
        a.angle = (a.angle + 0x00100000) >>> 0;
        a.frame = ((this.tic / 16) | 0) % 2;
        continue;
      }
      const toP = pointToAngle(p.x - a.x, p.y - a.y);
      a.angle = turnToward(a.angle, toP, a.enemy === "cutter" ? 0x08000000 : 0x03000000);
      if (a.cooldown > 0) a.cooldown--;

      if (a.stateName === "attack") {
        if (!a.attackDone && a.stateTics >= 8) {
          a.attackDone = true;
          this.enemyAttack(a, dist);
        }
        if (a.stateTics > 26) { a.stateName = "walk"; a.stateTics = 0; a.cooldown = def.cooldown; }
        a.frame = a.stateTics < 10 ? 0 : 1;
        continue;
      }
      // chase
      const wantRange = a.enemy === "cutter" ? 40 : a.enemy === "drone" ? 260 : 380;
      if (dist > wantRange && see) {
        const speed = def.speed;
        const dir = angleToRad(a.angle);
        const dx = Math.round(Math.cos(dir) * speed);
        const dy = Math.round(Math.sin(dir) * speed);
        if (!this.tryMove(a, dx, dy)) {
          // strafe around the obstacle
          const sdir = dir + Math.PI / 2;
          this.tryMove(a, Math.round(Math.cos(sdir) * speed), Math.round(Math.sin(sdir) * speed));
        }
        a.stateName = "walk";
        a.frame = ((this.tic / 5) | 0) % 4;
      } else {
        a.stateName = see ? "idle" : "walk";
        a.frame = ((this.tic / 12) | 0) % 2;
      }
      if (see && a.cooldown <= 0 && dist < (a.enemy === "cutter" ? 60 : def.ranged)) {
        a.stateName = "attack";
        a.stateTics = 0;
        a.attackDone = false;
        a.frame = 0;
        this.audio.alert(a.enemy);
      }
      // keep on floor
      const sec = this.sectors[a.sector] || this.sectors[0];
      if (a.enemy === "drone") {
        a.z = fx(sec.floor + 34) + Math.round(Math.sin(this.tic * 0.08 + a.id) * fx(4));
      } else {
        a.z = fx(sec.floor);
      }
    }
  }

  enemyAttack(a, dist) {
    const p = this.player;
    const def = ENEMY_DEFS[a.enemy];
    if (a.enemy === "cutter") {
      if (dist < 68) {
        this.damagePlayer(def.damage);
        this.audio.pain("cutter");
      }
    } else if (a.enemy === "drone") {
      const spread = (randByte() / 255 - 0.5) * 0.12;
      const ang = (a.angle + Math.round(spread * 0x100000000 / (Math.PI * 2))) >>> 0;
      this.spawnProjectile(a.x, a.y, a.z + fx(20), ang, def.projectileSpeed, def.damage, "ion", false);
    } else {
      for (let i = 0; i < def.burst; i++) {
        const spread = (randByte() / 255 - 0.5) * 0.08;
        const ang = (a.angle + Math.round(spread * 0x100000000 / (Math.PI * 2))) >>> 0;
        this.hitscan(a.x, a.y, a.z + fx(40), ang, def.ranged, def.damage, false);
      }
    }
  }

  // ------------------------------------------------------------------ pickups
  updatePickups() {
    const p = this.player;
    for (const a of this.actors) {
      if (a.kind !== "pickup" || a.taken) continue;
      if (Math.hypot(a.x - p.x, a.y - p.y) > fx(a.radius + p.radius)) continue;
      if (Math.abs(a.z - p.z) > fx(64)) continue;
      this.applyPickup(a);
    }
  }

  applyPickup(a) {
    const p = this.player;
    let msg = "";
    switch (a.item) {
      case "ammo": p.ammo.rivet += 20; p.ammo.scatter += 4; msg = "Picked up a box of ammunition"; break;
      case "health": p.health = Math.min(100, p.health + 10); msg = "Picked up a health vial"; break;
      case "patch_cell": p.health = Math.min(100, p.health + 25); msg = "Picked up a patch cell"; break;
      case "trauma_kit": p.health = Math.min(100, p.health + 50); msg = "Picked up a trauma kit"; break;
      case "armor": p.armor = Math.min(100, p.armor + 50); msg = "Picked up armor plating"; break;
      case "heavy_plating": p.armor = Math.min(100, p.armor + 100); msg = "Picked up heavy plating"; break;
      case "yellow_key": p.keys.yellow = true; msg = "Picked up the yellow keycard"; this.audio.key(); break;
      case "cyan_key": p.keys.cyan = true; msg = "Picked up the cyan keycard"; this.audio.key(); break;
      case "rivet": p.owner.rivet = true; p.ammo.rivet += 40; msg = "Picked up the rivet gun"; break;
      case "scatter": p.owner.scatter = true; p.ammo.scatter += 12; msg = "Picked up the scatter cannon"; break;
      case "arc": p.owner.arc = true; p.ammo.arc += 5; msg = "Picked up the arc launcher"; break;
      default: msg = "Picked up an item"; break;
    }
    a.taken = true;
    this.audio.pickup();
    this.setMessage(msg, 90);
    if (a.item === "rivet" || a.item === "scatter" || a.item === "arc") p.weapon = a.item;
  }

  // ------------------------------------------------------------------ attract
  attractVisibleTarget(centerAngle = this.player.angle, anyAngle = false, focus = null) {
    const p = this.player;
    let best = null, bestD = Infinity;
    for (const a of this.actors) {
      if (a.kind !== "enemy" || a.dead) continue;
      const dx = a.x - p.x, dy = a.y - p.y;
      const d = Math.hypot(dx / FRACUNIT, dy / FRACUNIT);
      if (d > 640) continue;
      // Save the close-range Cutter encounters for the scatter cannon.
      if (!p.owner.scatter && a.enemy === "cutter") continue;
      if (focus && !focus.includes(a.enemy)) continue;
      const aa = pointToAngle(dx, dy);
      // Only enemies actually inside the current view cone are targets.
      if (!anyAngle && Math.abs(angleDelta(aa, centerAngle)) > 0x20000000) continue;
      if (!this.los(p.x / FRACUNIT, p.y / FRACUNIT, a.x / FRACUNIT, a.y / FRACUNIT)) continue;
      if (d < bestD) { bestD = d; best = a; }
    }
    return { target: best, dist: bestD };
  }

  attractWeaponFor(target, dist) {
    const p = this.player;
    if (!target) return null;
    if (target.enemy === "cutter") {
      if (p.owner.scatter && dist < 190) return "scatter";
      return p.owner.rivet ? "rivet" : "scatter";
    }
    // Drones and Sentinels get the arc launcher so the blast is visible.
    if (p.owner.arc) return "arc";
    return p.owner.rivet ? "rivet" : "scatter";
  }

  attractInput() {
    const p = this.player;
    const route = ROUTE;
    this.attractTarget = null;
    if (this.attractIndex >= route.length) {
      return { forward: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 };
    }
    const wp = route[this.attractIndex];
    const dx = wp.x * FRACUNIT - p.x, dy = wp.y * FRACUNIT - p.y;
    const dist = Math.hypot(dx / FRACUNIT, dy / FRACUNIT);

    if (wp.waitLift) {
      const lift = this.sectors.find((s) => s.lift);
      if (lift && lift.floor <= lift.lift.low + 2) {
        this.attractIndex++;
        this.attractWait = 0;
      }
      return { forward: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 };
    }

    if (wp.use && dist < 34) {
      // Align with the use surface, then press use only if a real door,
      // lift or exit line is under the trace.
      const face = wp.face || [wp.x, wp.y + 8];
      const faceAngle = pointToAngle(face[0] * FRACUNIT - p.x, face[1] * FRACUNIT - p.y);
      const diff = angleDelta(faceAngle, p.angle);
      const turn = clamp(diff / 0x04000000, -0.24, 0.24);
      if (Math.abs(diff) > 0x04000000) {
        return { forward: 0, strafe: 0, turn, fire: false, use: false, weapon: 0 };
      }
      const usable = this.findUsableLine(["door", "lift", "exit"]);
      if (usable) {
        this.attractIndex++;
        this.attractWait = 0;
        return { forward: 0, strafe: 0, turn, fire: false, use: true, weapon: 0 };
      }
      this.attractWait++;
      if (this.attractWait > 90) {
        this.attractIndex++;
        this.attractWait = 0;
      }
      return { forward: 0, strafe: 0, turn, fire: false, use: false, weapon: 0 };
    }

    // Scenic pause: look at the authored point and gently sweep the view.
    if (wp.pause && dist < 30) {
      this.attractWait++;
      let lookAngle = wp.lookAt
        ? pointToAngle(wp.lookAt[0] * FRACUNIT - p.x, wp.lookAt[1] * FRACUNIT - p.y)
        : p.angle;
      if (this.attractWait > 20) {
        const sweep = Math.round(Math.sin((this.attractWait - 20) * 0.035) * 0x00800000);
        lookAngle = (lookAngle + sweep) >>> 0;
      }
      let turn = clamp(angleDelta(lookAngle, p.angle) / 0x04000000, -0.22, 0.22);
      const seen = this.attractVisibleTarget(lookAngle, !!wp.combat, wp.focus || null);
      let fire = false, weapon = 0;
      if (seen.target) {
        const aa = pointToAngle(seen.target.x - p.x, seen.target.y - p.y);
        const diff = angleDelta(aa, p.angle);
        if (wp.combat || Math.abs(diff) < 0x20000000) turn = clamp(diff / 0x04000000, -0.26, 0.26);
        weapon = this.attractWeaponChoice(seen.target, seen.dist, weapon);
        this.attractTarget = seen.target;
        const phase = (this.tic + this.attractIndex * 19) % 40;
        if (Math.abs(diff) < 0x06000000 && phase < 26) fire = true;
      }
      if (this.attractWait >= wp.pause) {
        this.attractIndex++;
        this.attractWait = 0;
      }
      return { forward: 0, strafe: 0, turn, fire, use: false, weapon };
    }

    if (dist < 18) {
      this.attractIndex++;
      this.attractWait = 0;
      return { forward: 0, strafe: 0, turn: 0, fire: false, use: false, weapon: 0 };
    }

    const targetAngle = pointToAngle(dx, dy);
    // Slow, deliberate heading changes; add a small sweep so the camera
    // looks around while moving rather than tracking a rail.
    const lookOffset = Math.round(Math.sin(this.tic * 0.006 + this.attractIndex * 0.9) * 0x00600000);
    let desired = (targetAngle + lookOffset) >>> 0;
    let forward = Math.abs(angleDelta(targetAngle, p.angle)) < 0x20000000 ? 1 : 0;

    let turn = clamp(angleDelta(desired, p.angle) / 0x04000000, -0.20, 0.20);
    if (Math.abs(turn) < 0.01) turn = 0;

    const seen = this.attractVisibleTarget(targetAngle);
    let fire = false, weapon = 0;
    if (seen.target) {
      const aa = pointToAngle(seen.target.x - p.x, seen.target.y - p.y);
      const diff = angleDelta(aa, p.angle);
      if (Math.abs(diff) < 0x20000000) turn = clamp(diff / 0x04000000, -0.26, 0.26);
      const want = this.attractWeaponFor(seen.target, seen.dist);
      if (want && p.weapon !== want && p.owner[want]) {
        weapon = ["rivet", "scatter", "arc"].indexOf(want) + 1;
      }
      this.attractTarget = seen.target;
      const phase = (this.tic + this.attractIndex * 19) % 40;
      if (Math.abs(diff) < 0x06000000 && phase < 26) fire = true;
      if (seen.dist < 420) forward *= 0.45;
    }
    return { forward, strafe: 0, turn, fire, use: false, weapon };
  }

  attractWeaponChoice(target, dist, current) {
    const want = this.attractWeaponFor(target, dist);
    if (!want || this.player.weapon === want) return 0;
    if (!this.player.owner[want]) return 0;
    return ["rivet", "scatter", "arc"].indexOf(want) + 1;
  }

  updateAttract(input) {
    // stuck detector: if the route stops making progress, skip ahead
    const moved = Math.hypot((this.player.x - this.lastPos.x) / FRACUNIT, (this.player.y - this.lastPos.y) / FRACUNIT);
    this.lastPos = { x: this.player.x, y: this.player.y };
    if (moved < 0.4) this.stuckTics++; else this.stuckTics = 0;
    if (this.stuckTics > 300) {
      this.stuckTics = 0;
      const wp = ROUTE[this.attractIndex];
      if (!(wp && wp.use)) {
        this.attractIndex = Math.min(ROUTE.length - 1, this.attractIndex + 1);
      }
    }
    // Never leave the trailer: keep normal HUD values while giving the
    // player a small repair floor during the longer combat sequence.
    if (this.player.health < 35) this.player.health = 35;
    if (this.player.health > 100) this.player.health = 100;
    if (this.player.armor > 100) this.player.armor = 100;
    if (this.player.ammo.rivet < 12) this.player.ammo.rivet = 60;
    if (this.player.ammo.scatter < 4) this.player.ammo.scatter = 12;
    if (this.player.ammo.arc < 1) this.player.ammo.arc = 5;
    const sec = this.sectors[this.player.sector];
    if (sec && sec.sky) this.attractStats.features.outdoor = true;
    if (sec && (sec.id === 12 && this.player.x > fx(1280))) this.attractStats.features.outdoor = true;
    if (sec && sec.id >= 35 && sec.id <= 40) this.attractStats.features.reactor = true;
  }

  // ------------------------------------------------------------------ info
  timeString() {
    const secs = Math.floor(this.tic / 35);
    const m = Math.floor(secs / 60), s = secs % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  snapshot() {
    const p = this.player;
    return {
      state: this.state, tic: this.tic, attract: this.attract, reachedCore: this.reachedCore,
      player: {
        x: p.x / FRACUNIT, y: p.y / FRACUNIT, z: p.z / FRACUNIT, angle: p.angle,
        health: p.health, armor: p.armor, ammo: { ...p.ammo }, weapon: p.weapon,
        keys: { ...p.keys }, owner: { ...p.owner }, sector: p.sector,
      },
      enemies: this.actors.filter((a) => a.kind === "enemy" && !a.removed).map((a) => ({
        id: a.id, type: a.enemy, x: a.x / FRACUNIT, y: a.y / FRACUNIT, z: a.z / FRACUNIT,
        angle: a.angle, health: a.health, state: a.stateName, dead: !!a.dead, alerted: a.alerted,
        sector: a.sector,
      })),
      map: this.level,
      kills: this.kills, totalEnemies: this.totalEnemies,
      secrets: this.secrets, totalSecrets: this.totalSecrets,
      attractStats: {
        ...this.attractStats,
        weaponShots: { ...this.attractStats.weaponShots },
        weaponTargets: { ...this.attractStats.weaponTargets },
        fights: { ...this.attractStats.fights },
        features: { ...this.attractStats.features },
        useTargets: [...this.attractStats.useTargets],
      },
    };
  }
}

function pxRound(v) { return v; }

function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy;
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * s2 - (cy - ay) * s1) / den;
  const u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

function raySeg(px, py, dx, dy, x1, y1, x2, y2) {
  const sx = x2 - x1, sy = y2 - y1;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((x1 - px) * sy - (y1 - py) * sx) / den;
  const u = ((x1 - px) * dy - (y1 - py) * dx) / den;
  if (t <= 0 || u < 0 || u > 1) return -1;
  return t;
}
