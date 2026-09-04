import { requireFiles, requireAny, ok } from "./checks.mjs";
requireFiles(["index.html"]);
requireAny([/<canvas/i], "index.html or the scripts must create a canvas");
requireAny([/requestAnimationFrame/], "a requestAnimationFrame loop");
requireAny([/ArrowLeft|ArrowRight|KeyA|KeyD|keydown/], "arrow-key input handling");
ok("scaffold present: index.html, canvas, rAF loop, keyboard input");
