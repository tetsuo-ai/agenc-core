import { requireFiles, read, fail, ok } from "./checks.mjs";
requireFiles(["index.html", "main.js", "player.js", "asteroids.js", "hud.js"]);
const html = read("index.html");
if (!/type\s*=\s*["']module["']/.test(html)) fail("index.html must load the entry as an ES module");
if (!/main\.js/.test(html)) fail("index.html must reference main.js");
const exportsSomething = (source) => source.split("\n").some((line) => /^export\s/.test(line.trimStart()));
for (const file of ["player.js", "asteroids.js", "hud.js"]) {
  if (!exportsSomething(read(file))) fail(`${file} exports nothing`);
}
ok("module layout present: main.js, player.js, asteroids.js, hud.js as ES modules");
