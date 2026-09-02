import { afterEach, describe, expect, test, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { shellDeletionProtectedRoots } from "src/tools/system/shell-mutation-permission.js";

describe("shell deletion protected roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("protects the configured home when there is no session to ask", () => {
    // The guard runs for bare tool use too, where no session and therefore no
    // ConfigStore exists. It must still name the home directory a shell
    // command may not remove.
    vi.stubEnv("AGENC_HOME", "/srv/agenc-home");

    expect(shellDeletionProtectedRoots(undefined)).toContain(
      resolve("/srv/agenc-home"),
    );
  });

  test("protects the platform default home when the variable is unset", () => {
    // Reading AGENC_HOME directly left this case unguarded: with the variable
    // unset the home is <platform home>/.agenc, and a raw env read contributes
    // nothing at all. Resolving through the canonical home authority is what
    // closes that gap.
    vi.stubEnv("AGENC_HOME", "");

    expect(shellDeletionProtectedRoots(undefined)).toContain(
      resolve(join(homedir(), ".agenc")),
    );
  });
});
