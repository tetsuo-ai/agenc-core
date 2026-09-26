import { describe, expect, it } from "vitest";
import { isPluginPayloadEntry } from "../../src/mcp-client/plugin-catalog-cache.js";

describe("isPluginPayloadEntry", () => {
  it.each([
    "server.mjs",
    "manifest.json",
    "src/index.ts",
    "bin/plugin",
    "readme.md",
  ])("includes payload file %s in the identity hash", (name) => {
    expect(isPluginPayloadEntry(name)).toBe(true);
  });

  it.each([
    ".DS_Store",
    "nested/.DS_Store",
    "Thumbs.db",
    "win\\Thumbs.db",
    "desktop.ini",
    "._icon",
    "assets/._hidden",
    ".#lock",
    "notes.md~",
    ".foo.swp",
    "file.swp",
    "file.swo",
    "file.swn",
  ])("omits bookkeeping entry %s from the identity hash", (name) => {
    expect(isPluginPayloadEntry(name)).toBe(false);
  });
});
