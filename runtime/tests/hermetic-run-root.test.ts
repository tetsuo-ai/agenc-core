import { realpathSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createHermeticRunRoot } from "./helpers/hermetic-env.mjs";

// The hermetic run root is the base of every sandboxed home, workspace and
// socket path a test sees. Two properties keep the suite honest on every
// platform:
//   1. it is already canonical, so a test that compares a path it was handed
//      against `realpath()` of the same path sees one string, not two;
//   2. it stays short, because Unix-domain socket paths are capped at 104
//      bytes on macOS and 108 on Linux.
// On macOS `/tmp` is a symlink to `/private/tmp`; using the symlink as the
// base broke both (1) and every "no symlink ancestor" assertion in the suite.
describe("createHermeticRunRoot", () => {
  it.runIf(process.platform !== "win32")(
    "returns a canonical path: realpath of the root is the root itself",
    () => {
      const root = createHermeticRunRoot("agv-test-");
      try {
        expect(realpathSync(root)).toBe(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "bases the root on the canonical temp directory of the platform",
    () => {
      // macOS: /private/tmp, the real directory behind the /tmp symlink.
      // Linux: /tmp itself. One assertion, no platform-specific skip, so the
      // suite registers zero skipped tests on every default-suite runner.
      const expectedBase =
        process.platform === "darwin" ? "/private/tmp" : "/tmp";
      const root = createHermeticRunRoot("agv-test-");
      try {
        expect(root.startsWith(`${expectedBase}/agv-test-`)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the root short enough for a Unix-domain socket path",
    () => {
      const root = createHermeticRunRoot("agv-test-");
      try {
        // 104 bytes minus room for "<home>/.agenc/daemon.sock"-shaped suffixes.
        expect(Buffer.byteLength(root)).toBeLessThan(60);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
