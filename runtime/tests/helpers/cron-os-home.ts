import { vi } from "vitest";

// Cron locks deliberately ignore HOME and AGENC_HOME. Substitute only the OS
// home syscall in these disposable tests; production has no environment override.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return {
    ...os,
    userInfo: (options?: { encoding?: BufferEncoding | "buffer" }) => {
      const home = process.env.AGENC_TEST_HERMETIC_HOME;
      if (!home) throw new Error("Cron tests require an owned hermetic OS-home fixture");
      return { ...os.userInfo(), homedir: options?.encoding === "buffer" ? Buffer.from(home) : home };
    },
  };
});

export const cronOsHomeWorkerPrelude = `
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const fixtureOsHome = process.env.AGENC_TEST_HERMETIC_HOME;
if (!fixtureOsHome) throw new Error("Missing owned cron OS-home fixture");
const originalUserInfo = os.userInfo;
os.userInfo = (options) => ({ ...originalUserInfo(), homedir: options?.encoding === "buffer" ? Buffer.from(fixtureOsHome) : fixtureOsHome });
syncBuiltinESMExports();
`;
