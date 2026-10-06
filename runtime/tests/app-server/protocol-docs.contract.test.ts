import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENC_DAEMON_METHODS } from "../../src/app-server/protocol/index.js";

describe("daemon protocol reference", () => {
  it("documents every public method by its full wire name", () => {
    const reference = readFileSync(
      new URL("../../../docs/reference/daemon.md", import.meta.url),
      "utf8",
    );
    const publicSection = reference.split(
      "### Public methods (`AGENC_DAEMON_METHODS`)",
    )[1]?.split("### Internal methods (`AGENC_DAEMON_INTERNAL_METHODS`)")[0];
    expect(publicSection).toBeDefined();
    const documented = new Set(
      [...(publicSection ?? "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]),
    );
    expect(
      AGENC_DAEMON_METHODS.filter((method) => !documented.has(method)),
    ).toEqual([]);
  });
});
