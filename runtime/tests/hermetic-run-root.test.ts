import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { createHermeticRunRoot } from "./helpers/hermetic-env.mjs";

const HERMETIC_ENV_URL = new URL("./helpers/hermetic-env.mjs", import.meta.url)
  .href;

// Runs the worker setup the way a plain `vitest` run does: no prelauncher run
// root, so the home and its TMPDIR come from the ambient temp directory. It
// needs a fresh process because a worker mints its home only once.
const PLAIN_VITEST_SETUP_PROBE = `
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getOrCreateHermeticTestHome,
  sanitizeHermeticEnv,
} from ${JSON.stringify(HERMETIC_ENV_URL)};
const home = getOrCreateHermeticTestHome();
sanitizeHermeticEnv(process.env, home);
const temp = tmpdir();
console.log(JSON.stringify({
  home,
  homeRealpath: realpathSync(home),
  temp,
  tempRealpath: realpathSync(temp),
}));
`;

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

// The macOS default TMPDIR (`/var/folders/...`) is a symlinked path, so a
// plain `vitest` run used to hand every test a non-canonical home and TMPDIR.
// A symlinked temp directory reproduces that on any POSIX platform.
describe("getOrCreateHermeticTestHome without the prelauncher", () => {
  it.runIf(process.platform !== "win32")(
    "roots the home and TMPDIR at the real path of a symlinked temp directory",
    () => {
      const root = createHermeticRunRoot("agv-test-");
      try {
        const realTemp = join(root, "real-temp");
        const linkedTemp = join(root, "linked-temp");
        mkdirSync(realTemp);
        symlinkSync(realTemp, linkedTemp, "dir");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TEMP: linkedTemp,
          TMP: linkedTemp,
          TMPDIR: linkedTemp,
        };
        delete env.AGENC_TEST_HERMETIC_RUN_ROOT;

        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", PLAIN_VITEST_SETUP_PROBE],
          { encoding: "utf8", env, timeout: 30_000 },
        );

        expect(result.status, result.stderr).toBe(0);
        const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
        const paths = JSON.parse(lastLine) as {
          home: string;
          homeRealpath: string;
          temp: string;
          tempRealpath: string;
        };
        expect(paths.home).toBe(paths.homeRealpath);
        expect(paths.temp).toBe(paths.tempRealpath);
        expect(paths.home.startsWith(`${realTemp}${sep}`)).toBe(true);
        expect(paths.temp).toBe(join(paths.home, "tmp"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
