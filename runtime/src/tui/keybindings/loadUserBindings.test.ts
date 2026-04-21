/**
 * Wave 2-B: user-bindings loader tests.
 *
 * Fixtures live under a fresh temp directory per test so the production
 * `HOME` layout stays untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Logger } from "../../utils/logger.js";
import { DEFAULT_BINDINGS } from "./defaultBindings.js";
import {
  USER_BINDINGS_FILENAME,
  loadUserBindings,
  userBindingsPath,
} from "./loadUserBindings.js";

interface CapturingLogger extends Logger {
  readonly warnings: string[];
}

function makeCapturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => undefined,
  };
}

let tempHome = "";

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-tui-bindings-"));
  fs.mkdirSync(path.join(tempHome, ".agenc"), { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("loadUserBindings", () => {
  test("returns DEFAULT_BINDINGS when the file is missing", () => {
    const logger = makeCapturingLogger();
    const result = loadUserBindings(tempHome, logger);
    expect(result.chat).toEqual(DEFAULT_BINDINGS.chat);
    expect(result.modal).toEqual(DEFAULT_BINDINGS.modal);
    expect(result.global).toEqual(DEFAULT_BINDINGS.global);
    expect(logger.warnings).toEqual([]);
  });

  test("merges a valid override on top of the defaults", () => {
    fs.writeFileSync(
      userBindingsPath(tempHome),
      JSON.stringify({ chat: { "ctrl+j": "chat:submit" } }),
    );
    const logger = makeCapturingLogger();
    const result = loadUserBindings(tempHome, logger);
    expect(result.chat["ctrl+j"]).toBe("chat:submit");
    // Defaults still present for anything the user didn't override.
    expect(result.chat.enter).toBe("chat:submit");
    expect(logger.warnings).toEqual([]);
  });

  test("falls back to defaults and warns on malformed JSON", () => {
    fs.writeFileSync(userBindingsPath(tempHome), "{ this is not json ");
    const logger = makeCapturingLogger();
    const result = loadUserBindings(tempHome, logger);
    expect(result.chat).toEqual(DEFAULT_BINDINGS.chat);
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]).toMatch(/malformed JSON/);
  });

  test("skips unknown contexts and warns", () => {
    fs.writeFileSync(
      userBindingsPath(tempHome),
      JSON.stringify({ nonsense: { "ctrl+q": "chat:cancel" } }),
    );
    const logger = makeCapturingLogger();
    const result = loadUserBindings(tempHome, logger);
    // Defaults preserved because the only context in the file was unknown.
    expect(result.chat).toEqual(DEFAULT_BINDINGS.chat);
    expect(logger.warnings.some((m) => m.includes("unknown context"))).toBe(
      true,
    );
  });

  test("skips unknown commands and warns", () => {
    fs.writeFileSync(
      userBindingsPath(tempHome),
      JSON.stringify({ chat: { "ctrl+q": "bogus:command" } }),
    );
    const logger = makeCapturingLogger();
    const result = loadUserBindings(tempHome, logger);
    // The bogus binding was skipped, defaults untouched.
    expect(result.chat["ctrl+q"]).toBeUndefined();
    expect(result.chat.enter).toBe("chat:submit");
    expect(logger.warnings.some((m) => m.includes("unknown command"))).toBe(
      true,
    );
    // And the canonical path helper stays in sync with the filename constant
    // so fixture paths in sibling tests can't drift from the loader.
    expect(userBindingsPath("/tmp/x")).toBe(
      path.join("/tmp/x", ".agenc", USER_BINDINGS_FILENAME),
    );
  });
});
