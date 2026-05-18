import { describe, expect, test } from "vitest";

import {
  collectPluginEnabledCandidateRecord,
  collectPluginEnabledCandidates,
} from "./toggles.js";

describe("plugin enabled toggles", () => {
  test("tracks direct, per-plugin table, and root table writes", () => {
    const candidates = collectPluginEnabledCandidates([
      ["plugins.sample@test.enabled", true],
      ["plugins.other@test", { enabled: false, ignored: true }],
      [
        "plugins",
        {
          "nested@test": { enabled: true },
          "skip@test": { name: "skip" },
        },
      ],
      ["unrelated.sample@test.enabled", false],
    ]);

    expect([...candidates.entries()]).toEqual([
      ["nested@test", true],
      ["other@test", false],
      ["sample@test", true],
    ]);
  });

  test("uses last write for repeated plugin IDs", () => {
    expect(
      collectPluginEnabledCandidateRecord([
        ["plugins.sample@test.enabled", true],
        ["plugins.sample@test", { enabled: false }],
      ]),
    ).toEqual({
      "sample@test": false,
    });
  });
});
