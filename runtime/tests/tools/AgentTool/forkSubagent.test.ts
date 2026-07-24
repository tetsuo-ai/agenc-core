import { describe, expect, it } from "vitest";

import { FORK_AGENT } from "./forkSubagent.js";

describe("forked agent limits", () => {
  it("does not impose an implicit turn cap", () => {
    expect(FORK_AGENT).not.toHaveProperty("maxTurns");
  });
});
