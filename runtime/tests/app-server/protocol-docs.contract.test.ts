import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_PROTOCOL_VERSION,
} from "../../src/app-server/protocol/index.js";
import { AGENC_SDK_DAEMON_PROTOCOL_VERSION } from "../../../packages/agenc-sdk/src/protocol.js";

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

  it("names the current protocol version in the daemon and SDK references", () => {
    const constantLine = (path: string): string | undefined =>
      readFileSync(new URL(path, import.meta.url), "utf8")
        .split("\n")
        .find((line) => line.includes("Protocol version constant:"));
    expect(AGENC_SDK_DAEMON_PROTOCOL_VERSION).toBe(AGENC_DAEMON_PROTOCOL_VERSION);
    expect(constantLine("../../../docs/reference/daemon.md")).toContain(
      `**\`${AGENC_DAEMON_PROTOCOL_VERSION}\`**`,
    );
    expect(constantLine("../../../docs/sdk.md")).toContain(
      `**\`${AGENC_SDK_DAEMON_PROTOCOL_VERSION}\`**`,
    );
  });
});
