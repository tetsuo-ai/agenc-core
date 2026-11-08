import { LEVEL } from "./level.js";
import { makeTextures } from "./textures.js";
import { makeSprites } from "./sprites.js";
import { Audio } from "./audio.js";
import { Game } from "./game.js";
import { Renderer } from "./render.js";

const canvas = document.getElementById("screen");
const textures = makeTextures();
const sprites = makeSprites();
const audio = new Audio();
const game = new Game(LEVEL, audio);
const renderer = new Renderer(canvas, LEVEL, textures, sprites);

const params = new URLSearchParams(location.search);
if (params.get("attract") === "1") game.startAttract();
else if (params.get("autostart") === "1") game.startGame();

function resize() {
  const scale = Math.max(1, Math.min(window.innerWidth / 320, window.innerHeight / 200));
  canvas.style.width = Math.floor(320 * scale) + "px";
  canvas.style.height = Math.floor(200 * scale) + "px";
}
window.addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------ input
const keys = game.keys;
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab"].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (e.code === "Escape") {
    if (game.state === "playing") game.state = "paused";
    else if (game.state === "paused") game.state = "playing";
    if (document.pointerLockElement) document.exitPointerLock();
    return;
  }
  if (e.code === "KeyE" || e.code === "Space") {
    if (game.state === "playing") game.useQueued = true;
    if (game.state === "title") { audio.resume(); game.startGame(); canvas.requestPointerLock?.(); }
  }
  if (e.code === "Enter" && (game.state === "title" || game.state === "dead" || game.state === "done")) {
    audio.resume(); game.startGame(); canvas.requestPointerLock?.();
  }
  if (e.code === "KeyR" && (game.state === "dead" || game.state === "done")) {
    audio.resume(); game.startGame(); canvas.requestPointerLock?.();
  }
  if (e.code >= "Digit1" && e.code <= "Digit3") game.weaponRequest = +e.code.slice(5);
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; game.mouseDown = false; });

canvas.addEventListener("click", async () => {
  audio.resume();
  if (game.state === "title") { game.startGame(); }
  else if (game.state === "dead" || game.state === "done") { game.startGame(); }
  else if (game.state === "paused") { game.state = "playing"; }
  try { await canvas.requestPointerLock(); } catch (e) {}
});
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0) {
    game.mouseDown = true;
    audio.resume();
    if (game.state === "title") { game.startGame(); canvas.requestPointerLock?.(); }
  }
});
window.addEventListener("mouseup", (e) => { if (e.button === 0) game.mouseDown = false; });
window.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === canvas && game.state === "playing") game.mouseDX += e.movementX;
});
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && game.state === "playing" && !game.attract) {
    // don't auto-pause on the first click; only when lock is lost while playing
  }
});

// ------------------------------------------------------------------ loop
let last = performance.now();
let acc = 0;
let frozen = false;
const TIC_MS = 1000 / 35;
function frame(now) {
  if (frozen) { requestAnimationFrame(frame); return; }
  let dt = now - last;
  last = now;
  if (dt > 200) dt = 200;
  acc += dt;
  let steps = 0;
  while (acc >= TIC_MS && steps < 6) {
    game.tick();
    acc -= TIC_MS;
    steps++;
  }
  renderer.render(game);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ hooks
window.__GAME__ = {
  get state() { return game.state; },
  get tic() { return game.tic; },
  get player() { return game.snapshot().player; },
  get enemies() { return game.snapshot().enemies; },
  get map() { return LEVEL; },
  get kills() { return game.kills; },
  get totalEnemies() { return game.totalEnemies; },
  get secrets() { return game.secrets; },
  get totalSecrets() { return game.totalSecrets; },
  get message() { return game.message; },
  get input() { return game.inputOverride; },
  set input(v) {
    game.inputOverride = v ? { ...v } : null;
  },
  advanceTics(n = 1) {
    for (let i = 0; i < n; i++) game.tick();
    renderer.render(game);
  },
  startGame() { audio.resume(); game.startGame(); },
  startAttract() { audio.resume(); game.startAttract(); },
  restart() { audio.resume(); game.startGame(); },
  attract: {
    get index() { return game.attractIndex; },
    get reachedCore() { return game.reachedCore; },
    get state() { return game.state; },
    get stats() { return game.snapshot().attractStats; },
    start() { audio.resume(); game.startAttract(); },
  },
  freeze(v) { frozen = !!v; },
  use() { game.useQueued = true; },
  teleport(x, y, angleDeg = null) {
    const p = game.player;
    p.x = Math.round(x * 65536); p.y = Math.round(y * 65536);
    const sec = game.sectorAt(p.x, p.y) || game.sectors[0];
    p.sector = sec.id; p.z = Math.round(sec.floor * 65536);
    p.vx = 0; p.vy = 0; p.vz = 0;
    if (angleDeg !== null) p.angle = Math.round((angleDeg / 360) * 4294967296) >>> 0;
    game.markSeenSector();
  },
  lookAt(x, y) {
    const p = game.player;
    const ang = Math.atan2(y - p.y / 65536, x - p.x / 65536);
    p.angle = Math.round((ang / (Math.PI * 2)) * 4294967296) >>> 0;
  },
  render() { renderer.render(game); },
};
window.__DEBUG__ = { game, renderer, LEVEL, sprites };
