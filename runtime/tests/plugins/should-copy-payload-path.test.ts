import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { shouldCopyPluginPayloadPath } from "../../src/plugins/resolution.js";

const PLUGIN_ROOT = "/tmp/plugin-payload-copy";

function payloadPath(...parts: string[]): string {
  return join(PLUGIN_ROOT, ...parts);
}

describe("shouldCopyPluginPayloadPath", () => {
  it("copies ordinary payload files and the plugin root itself", () => {
    expect(shouldCopyPluginPayloadPath(PLUGIN_ROOT, PLUGIN_ROOT)).toBe(true);
    expect(
      shouldCopyPluginPayloadPath(PLUGIN_ROOT, payloadPath("commands", "foo.md")),
    ).toBe(true);
    expect(
      shouldCopyPluginPayloadPath(PLUGIN_ROOT, payloadPath(".gitignore")),
    ).toBe(true);
    expect(
      shouldCopyPluginPayloadPath(
        PLUGIN_ROOT,
        payloadPath(".github", "workflows", "ci.yml"),
      ),
    ).toBe(true);
  });

  it("refuses VCS metadata so a signed digest cannot cover checkout dirs", () => {
    expect(
      shouldCopyPluginPayloadPath(PLUGIN_ROOT, payloadPath(".git", "config")),
    ).toBe(false);
    expect(
      shouldCopyPluginPayloadPath(
        PLUGIN_ROOT,
        payloadPath("nested", ".git", "HEAD"),
      ),
    ).toBe(false);
    expect(
      shouldCopyPluginPayloadPath(
        PLUGIN_ROOT,
        payloadPath("pkg", ".svn", "entries"),
      ),
    ).toBe(false);
    expect(
      shouldCopyPluginPayloadPath(
        PLUGIN_ROOT,
        payloadPath("pkg", ".hg", "store"),
      ),
    ).toBe(false);
  });

  it("refuses a path that leaves the plugin root through a VCS directory", () => {
    expect(shouldCopyPluginPayloadPath(PLUGIN_ROOT, "/tmp/.git/config")).toBe(
      false,
    );
  });
});
