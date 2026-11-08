#!/usr/bin/env node
// Automated acceptance checks for CORE BREACH.  Serves /work/game over a
// loopback HTTP server, drives the game in headless Chromium and writes the
// required screenshots.  Exits non-zero on any failed check.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/usr/local/lib/node_modules/playwright");

const ROOT = "/work/game";
const SHOTS = "/work/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  if (p === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
}

// Scan the shipped game tree, not just the live DOM, for legacy names and
// terms.  The terms are assembled from fragments so this checker can scan
// itself without false positives.
const LEGACY_TERMS = [
  ["do", "om"].join(""),
  ["e1", "m1"].join(""),
  ["map", "01"].join(""),
  ["b", "fg"].join(""),
  ["chain", "gun"].join(""),
  ["shot", "gun"].join(""),
  ["plas", "ma"].join("") + " gun",
  ["plas", "ma"].join("") + " rifle",
  ["de", "mon"].join(""),
  ["he", "ll"].join(""),
  ["i", "mp"].join(""),
  ["stimp", "ack"].join(""),
  ["medi", "kit"].join(""),
  ["med", "kit"].join(""),
  ["mega", "armor"].join(""),
  ["cyber", "de", "mon"].join(""),
  ["caco", "de", "mon"].join(""),
  ["re", "venant"].join(""),
  ["man", "cubus"].join(""),
  ["arch", "vile"].join(""),
  ["pink", "y"].join(""),
  ["baron", " of ", "he", "ll"].join(""),
  ["lost", " soul"].join(""),
  ["soul", " sphere"].join(""),
  ["health", " bonus"].join(""),
  ["armor", " bonus"].join(""),
  ["radiation", " suit"].join(""),
  ["super", " shot", "gun"].join(""),
  ["rocket", " launcher"].join(""),
  ["icon", " of sin"].join(""),
  ["do", "om", "guy"].join(""),
  ["do", "om", " marine"].join(""),
  ["u", "ac"].join(""),
  ["pho", "bos"].join(""),
  ["dei", "mos"].join(""),
];
function walkFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(?:js|mjs|html|css|json|md|txt)$/i.test(ent.name)) out.push(full);
  }
  return out;
}
function regexEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const legacyHits = [];
for (const file of walkFiles(ROOT)) {
  const text = fs.readFileSync(file, "utf8");
  const lower = text.toLowerCase();
  for (const term of LEGACY_TERMS) {
    const body = term.trim().split(/\s+/).map(regexEscape).join("\\s+");
    const re = new RegExp("\\b" + body + "\\b", "i");
    if (re.test(lower)) {
      const line = lower.slice(0, lower.search(re)).split("\n").length;
      legacyHits.push(`${path.relative(ROOT, file)}:${line}:${term}`);
    }
  }
}
check("no legacy ID terms in game files", legacyHits.length === 0, legacyHits.slice(0, 6).join(" | "));

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const pageErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(e.message));

try {
  await page.goto(base + "index.html", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state, null, { timeout: 15000 });
  await page.waitForTimeout(250);

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, name) }); };
  const reset = async (clearEnemies = true) => {
    await ev((clear) => {
      window.__GAME__.startGame();
      if (clear) window.__DEBUG__.game.actors = window.__DEBUG__.game.actors.filter((a) => a.kind !== "enemy");
      window.__GAME__.advanceTics(1);
    }, clearEnemies);
  };
  const useOnce = async () => {
    await ev(() => { window.__GAME__.input = { use: true }; window.__GAME__.advanceTics(1); window.__GAME__.input = null; });
  };
  const teleport = async (x, y, a) => {
    await ev(([x, y, a]) => { window.__GAME__.teleport(x, y, a); window.__GAME__.advanceTics(1); }, [x, y, a]);
  };

  // 1 title
  const titleState = await ev(() => window.__GAME__.state);
  check("title screen is the initial state", titleState === "title", titleState);
  await shot("01-title.png");

  // 2 start + screenshot
  await reset(false);
  const startP = await ev(() => window.__GAME__.player);
  check("start room spawn", Math.abs(startP.x - 128) < 1 && Math.abs(startP.y - 128) < 1 && startP.health === 100);
  await shot("02-start.png");

  // 3 wall collision
  await reset(true);
  await teleport(128, 128, 90);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(160); window.__GAME__.input = null; });
  let p = await ev(() => window.__GAME__.player);
  check("walls stop forward movement", p.y < 312 && p.y > 280, `y=${p.y.toFixed(1)}`);
  await teleport(128, 32, 0);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(220); window.__GAME__.input = null; });
  p = await ev(() => window.__GAME__.player);
  check("walls stop sideways movement", p.x < 500 && p.x > 440, `x=${p.x.toFixed(1)}`);

  // 4 stairs
  await teleport(576, 900, 270);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(260); window.__GAME__.input = null; });
  p = await ev(() => window.__GAME__.player);
  const stairSector = await ev(() => window.__DEBUG__.game.sectorAt(window.__DEBUG__.game.player.x, window.__DEBUG__.game.player.y)?.name);
  check("stairs can be climbed", p.z >= 56, `z=${p.z} sector=${stairSector}`);

  // 5 high ledge cannot be climbed (96-unit step)
  await teleport(1100, 600, 0);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(140); window.__GAME__.input = null; });
  p = await ev(() => window.__GAME__.player);
  check("high ledge blocks the player", p.x < 1153, `x=${p.x.toFixed(1)}`);

  // 6 yellow key door
  await reset(true);
  await teleport(1088, 350, 90);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(70); window.__GAME__.input = null; });
  await useOnce();
  let door = await ev(() => window.__DEBUG__.game.sectors.find((s) => s.door === "yellow"));
  let msg = await ev(() => window.__GAME__.message);
  check("yellow door stays shut without key", door.doorState === "closed" && /YELLOW/i.test(msg), msg);
  await teleport(1824, 304, 90);
  await ev(() => window.__GAME__.advanceTics(2));
  const keys1 = await ev(() => window.__GAME__.player.keys);
  check("yellow keycard pickup", keys1.yellow === true);
  await teleport(1088, 350, 90);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(75));
  door = await ev(() => window.__DEBUG__.game.sectors.find((s) => s.door === "yellow"));
  check("yellow door opens with key", door.doorState === "open" && door.ceil >= 120, `state=${door.doorState} ceil=${door.ceil}`);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(130); window.__GAME__.input = null; });
  p = await ev(() => window.__GAME__.player);
  check("player can walk through the yellow door", p.y > 430, `y=${p.y.toFixed(1)}`);

  // 7 lift
  await reset(true);
  await teleport(704, 820, 0);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(60));
  const lift = await ev(() => window.__DEBUG__.game.sectors.find((s) => s.lift));
  check("lift moves down when used", lift.floor <= 2, `floor=${lift.floor} state=${lift.liftState}`);

  // 8 cyan key door
  await teleport(600, 1216, 0);
  await ev(() => { window.__GAME__.input = { forward: 1 }; window.__GAME__.advanceTics(70); window.__GAME__.input = null; });
  await useOnce();
  door = await ev(() => window.__DEBUG__.game.sectors.find((s) => s.door === "cyan"));
  msg = await ev(() => window.__GAME__.message);
  check("cyan door stays shut without key", door.doorState === "closed" && /CYAN/i.test(msg), msg);
  await teleport(320, 1248, 90);
  await ev(() => window.__GAME__.advanceTics(2));
  const keys2 = await ev(() => window.__GAME__.player.keys);
  check("cyan keycard pickup", keys2.cyan === true);
  await teleport(600, 1216, 0);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(80));
  door = await ev(() => window.__DEBUG__.game.sectors.find((s) => s.door === "cyan"));
  check("cyan door opens with key", door.doorState === "open" && door.ceil >= 120, `state=${door.doorState} ceil=${door.ceil}`);

  // 9 pickups
  await reset(true);
  await ev(() => { window.__DEBUG__.game.player.ammo.rivet = 10; window.__GAME__.teleport(416, 224, 0); window.__GAME__.advanceTics(2); });
  let ammo = await ev(() => window.__GAME__.player.ammo.rivet);
  check("ammo pickup increases ammo", ammo > 10, `rivet=${ammo}`);
  await ev(() => { window.__DEBUG__.game.player.health = 50; window.__GAME__.teleport(64, 64, 0); window.__GAME__.advanceTics(2); });
  const hp = await ev(() => window.__GAME__.player.health);
  check("health pickup restores health", hp > 50, `hp=${hp}`);

  const pickupNames = await ev(() => window.__DEBUG__.LEVEL.things
    .filter((t) => t.kind === "pickup").map((t) => t.item));
  check("new pickup identifiers are used", ["patch_cell", "trauma_kit", "heavy_plating"].every((n) => pickupNames.includes(n)));
  const pickupResults = await ev(() => {
    const g = window.__DEBUG__.game;
    const out = {};
    for (const item of ["patch_cell", "trauma_kit", "heavy_plating"]) {
      window.__GAME__.startGame();
      g.actors = g.actors.filter((a) => a.kind !== "enemy");
      const a = g.actors.find((x) => x.kind === "pickup" && x.item === item);
      g.player.health = 50;
      g.player.armor = 0;
      if (!a) { out[item] = { found: false }; continue; }
      window.__GAME__.teleport(a.x / 65536, a.y / 65536, 0);
      g.tick(); g.tick();
      out[item] = { found: true, hp: g.player.health, armor: g.player.armor, msg: g.message, taken: a.taken };
    }
    return out;
  });
  check("patch cell gives +25 health", pickupResults.patch_cell.hp === 75 && /PATCH CELL/i.test(pickupResults.patch_cell.msg), JSON.stringify(pickupResults.patch_cell));
  check("trauma kit gives +50 health", pickupResults.trauma_kit.hp === 100 && /TRAUMA KIT/i.test(pickupResults.trauma_kit.msg), JSON.stringify(pickupResults.trauma_kit));
  check("heavy plating gives armor", pickupResults.heavy_plating.armor === 100 && /HEAVY PLATING/i.test(pickupResults.heavy_plating.msg), JSON.stringify(pickupResults.heavy_plating));
  const canisters = await ev(() => {
    const pickups = window.__DEBUG__.sprites.pickups;
    return ["health", "patch_cell", "trauma_kit"].map((k) => {
      const img = pickups[k];
      let green = 0, white = 0, red = 0;
      for (const v of img.data) {
        if (v >= 128 && v < 160) green++;
        if (v >= 240) white++;
        if (v >= 224 && v < 240) red++;
      }
      return { k, w: img.w, h: img.h, green, white, red };
    });
  });
  check("medical pickups are green canisters with white pulse traces",
    canisters.every((c) => c.green > 20 && c.white > 2 && c.red === 0), JSON.stringify(canisters));

  // 10 coolant damage
  await ev(() => { window.__DEBUG__.game.player.health = 100; window.__GAME__.teleport(512, 1024, 0); window.__GAME__.advanceTics(40); });
  const cool = await ev(() => ({ hp: window.__GAME__.player.health, msg: window.__GAME__.message }));
  check("coolant pool hurts the player", cool.hp < 100 && /COOLANT/i.test(cool.msg), `hp=${cool.hp} msg=${cool.msg}`);

  // 11 enemy wake / attack / death
  await reset(false);
  await ev(() => { window.__DEBUG__.game.actors = window.__DEBUG__.game.actors.filter((a) => a.kind !== "enemy" || a.enemy === "cutter"); });
  await teleport(900, 192, 0);
  await ev(() => window.__GAME__.advanceTics(120));
  const alerted = await ev(() => ({ hp: window.__GAME__.player.health, enemies: window.__GAME__.enemies.filter((e) => e.alerted).length }));
  check("enemy wakes and attacks", alerted.enemies > 0 && alerted.hp < 100, `hp=${alerted.hp} alerted=${alerted.enemies}`);
  await ev(() => {
    const g = window.__DEBUG__.game;
    const e = g.actors.find((a) => a.kind === "enemy" && !a.dead);
    for (let i = 0; i < 16 && e && !e.dead; i++) {
      window.__GAME__.lookAt(e.x / 65536, e.y / 65536);
      window.__GAME__.input = { fire: true };
      window.__GAME__.advanceTics(8);
    }
    window.__GAME__.input = null;
    window.__GAME__.advanceTics(40);
  });
  const kill = await ev(() => ({ kills: window.__GAME__.kills, alive: window.__GAME__.enemies.filter((e) => !e.dead).length }));
  check("enemy can be damaged and dies", kill.kills >= 1, `kills=${kill.kills} alive=${kill.alive}`);

  // 12 exit switch
  await reset(true);
  await teleport(1700, 1560, 90);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(2));
  const doneState = await ev(() => window.__GAME__.state);
  check("exit switch completes the level", doneState === "done", doneState);

  // 13 attract mode full loop
  await ev(() => window.__GAME__.startAttract());
  let reached = false;
  let done = false;
  let aStats = null;
  for (let i = 0; i < 150; i++) {
    await ev(() => window.__GAME__.advanceTics(50));
    const st = await ev(() => ({
      state: window.__GAME__.state,
      core: window.__GAME__.attract.reachedCore,
      idx: window.__GAME__.attract.index,
      stats: window.__GAME__.attract.stats,
    }));
    if (st.state === "done" || st.core) {
      reached = st.core; done = st.state === "done"; aStats = st.stats; break;
    }
  }
  check("attract mode reaches the reactor core", reached, `done=${done}`);
  check("attract loop lasts at least 75 seconds", !!aStats && aStats.durationTics >= 75 * 35, aStats ? `${aStats.durationTics} tics` : "no stats");
  check("attract HUD health and armor stay within 100", !!aStats && aStats.healthMax <= 100 && aStats.armorMax <= 100, aStats ? `hp<=${aStats.healthMax} ar<=${aStats.armorMax}` : "no stats");
  check("attract never shows NOTHING TO USE", !!aStats && aStats.useMisses === 0, aStats ? `misses=${aStats.useMisses}` : "no stats");
  check("attract fires only with an enemy in view", !!aStats && aStats.noTargetShots === 0, aStats ? `noTarget=${aStats.noTargetShots}` : "no stats");
  check("attract uses all three weapons", !!aStats && Object.values(aStats.weaponShots).every((n) => n > 0), aStats ? JSON.stringify(aStats.weaponShots) : "no stats");
  check("attract uses scatter on close Cutters and arc on heavies", !!aStats && aStats.scatterCutterShots > 0 && aStats.arcHeavyShots > 0, aStats ? `scatter=${aStats.scatterCutterShots} arc=${aStats.arcHeavyShots}` : "no stats");
  check("attract fights every enemy type", !!aStats && aStats.fights.cutter && aStats.fights.drone && aStats.fights.sentinel, aStats ? JSON.stringify(aStats.fights) : "no stats");
  check("attract shows arc blasts", !!aStats && aStats.arcBlasts > 0, aStats ? `blasts=${aStats.arcBlasts}` : "no stats");
  check("attract muzzle flash is intermittent", !!aStats && aStats.maxFlashRun <= 60 && aStats.flashTics < aStats.durationTics * 0.6, aStats ? `flash=${aStats.flashTics}/${aStats.durationTics} maxRun=${aStats.maxFlashRun}` : "no stats");
  check("attract visits every required beat", !!aStats && ["door", "yellowDoor", "cyanDoor", "lift", "coolant", "outdoor", "reactor", "core", "complete"].every((k) => aStats.features[k]), aStats ? JSON.stringify(aStats.features) : "no stats");
  await shot("14-attract-complete.png");
  await ev(() => window.__GAME__.advanceTics(170));
  const looped = await ev(() => ({ state: window.__GAME__.state, playing: window.__GAME__.state === "playing" }));
  check("attract mode loops back into the level", looped.playing, looped.state);

  // 14 performance (software headless; budget generous enough for 60fps)
  await reset(true);
  await teleport(1150, 1280, 0);
  const perf = await ev(() => {
    const g = window.__DEBUG__.game;
    const r = window.__DEBUG__.renderer;
    const t0 = performance.now();
    for (let i = 0; i < 80; i++) { g.tick(); r.render(g); }
    return (performance.now() - t0) / 80;
  });
  check("render+tic budget allows 60fps", perf < 30, `${perf.toFixed(2)} ms/frame`);

  // 15 screenshots of the required moments (fresh states)
  await ev(() => { window.__GAME__.startGame(); window.__DEBUG__.game.actors = window.__DEBUG__.game.actors.filter((a) => a.kind !== "enemy"); window.__GAME__.advanceTics(2); });
  await shot("02-start.png");
  await teleport(600, 128, 0);
  await shot("03-corridor.png");
  await teleport(1500, 780, 0);
  await shot("04-outdoor-sky.png");
  await teleport(840, 820, 180);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(16));
  await shot("06-lift.png");
  await ev(() => window.__GAME__.advanceTics(70));
  await teleport(1150, 1280, 0);
  await shot("07-reactor-hall.png");

  await reset(false);
  await ev(() => { window.__DEBUG__.game.actors = window.__DEBUG__.game.actors.filter((a) => a.kind !== "enemy" || a.enemy === "cutter"); });
  await ev(() => {
    const e = window.__DEBUG__.game.actors.find((a) => a.kind === "enemy");
    window.__GAME__.teleport(1000, 192, 0);
    if (e) window.__GAME__.lookAt(e.x / 65536, e.y / 65536);
    window.__GAME__.advanceTics(2);
  });
  await shot("05-fight.png");

  await reset(true);
  await teleport(1700, 1560, 90);
  await useOnce();
  await ev(() => window.__GAME__.advanceTics(2));
  await shot("08-level-complete.png");

  await reset(true);
  await ev(() => { window.__DEBUG__.game.damagePlayer(999); window.__GAME__.advanceTics(2); });
  await shot("09-death.png");

  await reset(true);
  await teleport(224, 750, 180);
  await ev(() => { window.__GAME__.freeze(true); window.__GAME__.advanceTics(2); });
  await shot("15-patch-cell.png");
  await ev(() => window.__GAME__.freeze(false));
  await reset(true);
  await teleport(320, 1120, 270);
  await ev(() => { window.__GAME__.freeze(true); window.__GAME__.advanceTics(2); });
  await shot("16-trauma-kit.png");
  await ev(() => window.__GAME__.freeze(false));

  // 16 attract-mode trailer moments
  const attractShot = async (kind, name) => {
    await ev(() => window.__GAME__.startAttract());
    const found = await ev((what) => {
      const g = window.__DEBUG__.game, r = window.__DEBUG__.renderer;
      for (let i = 0; i < 9000; i++) {
        g.tick();
        const s = g.attractStats;
        let hit = false;
        if (what === "cutter") {
          const t = g.attractTarget;
          const d = t ? Math.hypot((t.x - g.player.x) / 65536, (t.y - g.player.y) / 65536) : 999;
          hit = g.player.weapon === "scatter" && t && !t.dead && t.enemy === "cutter" && d < 190;
        }
        else if (what === "outdoor") hit = s.features.outdoor && g.player.sector === 12 && g.attractIndex >= 13;
        else if (what === "coolant") hit = s.features.coolant;
        else if (what === "arc") hit = s.arcBlasts > 0 && g.effects.length > 0 && g.attractTarget &&
          (g.attractTarget.enemy === "drone" || g.attractTarget.enemy === "sentinel");
        if (hit) {
          if (what === "cutter" && g.attractTarget) {
            window.__GAME__.lookAt(g.attractTarget.x / 65536, g.attractTarget.y / 65536);
          }
          if (what === "arc") {
            const e = g.effects.find((q) => q.kind === "arc");
            if (e) window.__GAME__.lookAt(e.x / 65536, e.y / 65536);
          }
          r.render(g);
          return { tic: g.tic, index: g.attractIndex };
        }
      }
      return null;
    }, kind);
    await ev(() => window.__GAME__.freeze(true));
    await shot(name);
    await ev(() => window.__GAME__.freeze(false));
    return found;
  };
  const cutterMoment = await ev(() => {
    const g = window.__DEBUG__.game, r = window.__DEBUG__.renderer;
    window.__GAME__.startGame();
    g.actors = g.actors.filter((a) => a.kind !== "enemy" ||
      (a.enemy === "cutter" && Math.abs(a.x / 65536 - 1088) < 8));
    g.player.owner.scatter = true;
    g.player.weapon = "scatter";
    g.player.ammo.scatter = 20;
    window.__GAME__.teleport(1088, 300, 270);
    const cutter = g.actors.find((a) => a.kind === "enemy" && a.enemy === "cutter");
    if (cutter) window.__GAME__.lookAt(cutter.x / 65536, cutter.y / 65536);
    g.tick();
    r.render(g);
    return cutter ? { tic: g.tic, target: cutter.enemy } : null;
  });
  await ev(() => window.__GAME__.freeze(true));
  await shot("10-attract-cutter.png");
  await ev(() => window.__GAME__.freeze(false));
  const outdoorMoment = await attractShot("outdoor", "11-attract-outdoor.png");
  const coolantMoment = await attractShot("coolant", "12-attract-coolant.png");
  const arcMoment = await ev(() => {
    const g = window.__DEBUG__.game, r = window.__DEBUG__.renderer;
    window.__GAME__.startGame();
    g.actors = g.actors.filter((a) => a.kind !== "enemy" ||
      (a.enemy === "drone" && Math.abs(a.y / 65536 - 1312) < 8));
    const drone = g.actors.find((a) => a.kind === "enemy" && a.enemy === "drone");
    if (drone) drone.health = 500;
    g.player.owner.arc = true;
    g.player.weapon = "arc";
    g.player.ammo.arc = 10;
    window.__GAME__.teleport(1504, 1180, 90);
    if (drone) window.__GAME__.lookAt(drone.x / 65536, drone.y / 65536);
    g.inputOverride = { fire: true };
    let found = null;
    for (let i = 0; i < 80; i++) {
      g.tick();
      if (g.effects.length) { found = { tic: g.tic, effects: g.effects.length }; break; }
    }
    g.inputOverride = null;
    if (found) {
      const e = g.effects[0];
      window.__GAME__.lookAt(e.x / 65536, e.y / 65536);
    }
    r.render(g);
    return found;
  });
  await ev(() => window.__GAME__.freeze(true));
  await shot("13-attract-arc-blast.png");
  await ev(() => window.__GAME__.freeze(false));
  check("new attract screenshots captured", !!cutterMoment && !!outdoorMoment && !!coolantMoment && !!arcMoment,
    [cutterMoment, outdoorMoment, coolantMoment, arcMoment].map((m) => m && m.tic).join(","));

  // 16 console clean
  check("no page exceptions", pageErrors.length === 0, pageErrors.join(" | "));
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (err) {
  checks.push({ name: "verification runner", ok: false, detail: err.message });
  console.error("ERROR", err.stack || err);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log("FAILED:", f.name, f.detail);
  process.exit(1);
}
process.exit(0);
