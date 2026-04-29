import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  keybindingsPathFromHome,
  loadUserBindingsSync,
} from "./loadUserBindings.js";

let agencHome: string;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-keybindings-"));
});

afterEach(() => {
  rmSync(agencHome, { recursive: true, force: true });
});

function writeKeybindings(value: unknown): void {
  mkdirSync(agencHome, { recursive: true });
  writeFileSync(
    keybindingsPathFromHome(agencHome),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

describe("loadUserBindingsSync", () => {
  test("merges upstream-shaped keybindings into the live binding map", () => {
    writeKeybindings({
      bindings: [
        {
          context: "Chat",
          bindings: {
            "ctrl+k": "chat:cancel",
            "ctrl+j": null,
          },
        },
        {
          context: "Confirmation",
          bindings: {
            x: "modal:deny",
          },
        },
      ],
    });

    const result = loadUserBindingsSync(agencHome);

    expect(result.warnings).toEqual([]);
    expect(result.bindings.chat["ctrl+k"]).toBe("chat:cancel");
    expect(result.bindings.chat["ctrl+j"]).toBeUndefined();
    expect(result.bindings.modal.x).toBe("modal:deny");
  });

  test("keeps reserved process-control shortcuts bound to AgenC defaults", () => {
    writeKeybindings({
      bindings: [
        {
          context: "Global",
          bindings: {
            "ctrl+c": "app:redraw",
            "ctrl+d": null,
          },
        },
      ],
    });

    const result = loadUserBindingsSync(agencHome);

    expect(result.bindings.global["ctrl+c"]).toBe("app:interrupt");
    expect(result.bindings.global["ctrl+d"]).toBe("app:exit");
    expect(result.warnings.map((warning) => warning.type)).toEqual([
      "reserved",
      "reserved",
    ]);
  });

  test("accepts legacy shortcut scaffolds without making them the live format", () => {
    writeKeybindings({
      shortcuts: [
        { keys: "Ctrl+K", action: "cancel" },
        { keys: "Shift+Tab", action: "cycleMode" },
      ],
    });

    const result = loadUserBindingsSync(agencHome);

    expect(result.warnings).toEqual([]);
    expect(result.bindings.chat["ctrl+k"]).toBe("chat:cancel");
    expect(result.bindings.chat["shift+tab"]).toBe("chat:cycleMode");
  });
});
