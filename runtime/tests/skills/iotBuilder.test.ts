import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { loadPluginManifest } from "../../src/plugins/manifest.js";

const PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../plugins/iot-builder",
);
const SKILL_ROOT = join(PLUGIN_ROOT, "skills", "iot-builder");
const REFERENCES_ROOT = join(SKILL_ROOT, "references");

const EXPECTED_REFERENCES = [
  "boards/identify.md",
  "boards/esp32.md",
  "boards/arduino.md",
  "boards/raspberry-pi.md",
  "boards/rp2040.md",
  "boards/orange-pi.md",
  "boards/radxa.md",
  "boards/stm32.md",
  "toolchains/platformio.md",
  "toolchains/arduino-cli.md",
  "toolchains/esp-idf.md",
  "toolchains/micropython.md",
  "workflows/when-stuck.md",
  "workflows/end-to-end.md",
  "safety.md",
] as const;

test("iot-builder is an optional plugin, not a bundled runtime skill", async () => {
  const loaded = await loadPluginManifest(PLUGIN_ROOT);
  assert.ok(loaded);
  assert.equal(loaded.manifest.name, "iot-builder");
  assert.equal(loaded.manifest.skills, "./skills");
  assert.equal(loaded.manifest.interface?.displayName, "IoT Builder");

  const { getBundledSkills } = await import("../../src/skills/bundledSkills.js");
  assert.equal(
    getBundledSkills().some((command) => command.name === "iot-builder"),
    false,
  );
});

test("iot-builder plugin keeps measurement-first and safety guidance", async () => {
  const skill = await readFile(join(SKILL_ROOT, "SKILL.md"), "utf8");
  assert.match(skill, /name: iot-builder/u);
  assert.match(skill, /Identify the hardware — by measuring, not by recalling/u);
  assert.match(skill, /identifies the \*\*chip\*\*, not the \*\*board\*\*/u);
  assert.match(skill, /read-flash 0 ALL backup\.bin/u);
  assert.match(skill, /A clean build and a verified flash prove nothing/u);
  assert.match(skill, /Never re-run a failed command unchanged/u);
  assert.match(skill, /Keep HARDWARE\.md current — it is your memory/u);
  assert.match(skill, /Electrical safety/u);

  for (const relativePath of EXPECTED_REFERENCES) {
    const content = await readFile(join(REFERENCES_ROOT, relativePath), "utf8");
    assert.ok(content.length > 500, `${relativePath} is non-trivial`);
  }

  const identify = await readFile(
    join(REFERENCES_ROOT, "boards", "identify.md"),
    "utf8",
  );
  assert.match(identify, /Rung 0 — ask for the purchase listing FIRST/u);
  assert.match(identify, /pins_arduino\.h/u);
  assert.match(identify, /esp_chip_info/u);
  assert.match(identify, /HARDWARE\.md/u);
  assert.match(identify, /ASSUMED/u);

  const stuck = await readFile(
    join(REFERENCES_ROOT, "workflows", "when-stuck.md"),
    "utf8",
  );
  assert.match(stuck, /prove NOTHING about behaviour/u);
  assert.match(stuck, /Two attempts per hypothesis/u);
  assert.match(stuck, /\/resolve/u);
});
