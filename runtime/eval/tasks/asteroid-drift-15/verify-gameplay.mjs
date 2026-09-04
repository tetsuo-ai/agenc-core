import { requireAny, ok } from "./checks.mjs";
requireAny([/game\s*over/i], "a Game Over state");
requireAny([/localStorage/], "localStorage for the best score");
requireAny([/paus/i], "a pause state");
ok("gameplay markers present: game over, localStorage, pause");
