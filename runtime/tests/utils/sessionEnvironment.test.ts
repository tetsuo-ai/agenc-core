import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  disposeSessionEnvironment,
  getHookEnvFilePath,
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
  type SessionEnvironmentAuthority,
} from "../../src/utils/sessionEnvironment.js";

describe.skipIf(process.platform === "win32")(
  "session environment authority",
  () => {
    const roots: string[] = [];

    afterEach(async () => {
      await Promise.all(
        roots.splice(0).map((root) =>
          rm(root, { recursive: true, force: true }),
        ),
      );
    });

    async function authority(label: string): Promise<SessionEnvironmentAuthority> {
      const homePath = await mkdtemp(join(tmpdir(), `agenc-env-${label}-`));
      roots.push(homePath);
      return { homePath, sessionId: "same-session-id" };
    }

    test("isolates concurrent homes and invalidates only the selected session", async () => {
      const [homeA, homeB] = await Promise.all([
        authority("a"),
        authority("b"),
      ]);
      const [fileA, fileB] = await Promise.all([
        getHookEnvFilePath("Setup", 0, homeA),
        getHookEnvFilePath("Setup", 0, homeB),
      ]);
      await Promise.all([
        writeFile(fileA, "export AUTHORITY=A\n"),
        writeFile(fileB, "export AUTHORITY=B\n"),
      ]);

      await expect(
        Promise.all([
          getSessionEnvironmentScript(homeA),
          getSessionEnvironmentScript(homeB),
        ]),
      ).resolves.toEqual(["export AUTHORITY=A", "export AUTHORITY=B"]);

      await Promise.all([
        writeFile(fileA, "export AUTHORITY=A2\n"),
        writeFile(fileB, "export AUTHORITY=B2\n"),
      ]);
      invalidateSessionEnvCache(homeA);

      await expect(
        Promise.all([
          getSessionEnvironmentScript(homeA),
          getSessionEnvironmentScript(homeB),
        ]),
      ).resolves.toEqual(["export AUTHORITY=A2", "export AUTHORITY=B"]);

      disposeSessionEnvironment(homeB);
      await writeFile(fileB, "export AUTHORITY=B3\n");
      await expect(getSessionEnvironmentScript(homeB)).resolves.toBe(
        "export AUTHORITY=B3",
      );
    });
  },
);
