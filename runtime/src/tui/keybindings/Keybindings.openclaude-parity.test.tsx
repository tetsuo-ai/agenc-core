import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadUserBindingsSync } from "./loadUserBindings.js";
import { getShortcutDisplay } from "./shortcutFormat.js";

afterEach(() => {
  delete process.env.AGENC_HOME;
});

describe("OpenClaude keybinding parity", () => {
  test("user binding files update shortcut display text", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-keybindings-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "keybindings.json"),
        JSON.stringify({
          bindings: [
            {
              context: "Chat",
              bindings: {
                "Alt+Enter": "chat:newline",
              },
            },
          ],
        }),
      );
      process.env.AGENC_HOME = home;

      const loaded = loadUserBindingsSync();

      expect(loaded.warnings).toEqual([]);
      expect(getShortcutDisplay("chat:newline", "chat", "Ctrl+J")).toBe(
        "Alt+Enter",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
