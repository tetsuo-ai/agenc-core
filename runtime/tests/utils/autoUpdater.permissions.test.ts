import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { checkGlobalInstallPermissions } from "../../src/utils/autoUpdater.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "checks the global prefix with captured PATH and cwd",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-prefix-ingress-"));
    roots.push(root);
    const capturedBin = join(root, "captured-bin");
    const ambientBin = join(root, "ambient-bin");
    const capturedCwd = join(root, "captured-cwd");
    mkdirSync(capturedBin);
    mkdirSync(ambientBin);
    mkdirSync(capturedCwd);
    const capturedNpm = join(capturedBin, "npm");
    const ambientNpm = join(ambientBin, "npm");
    writeFileSync(capturedNpm, "#!/bin/sh\npwd\n");
    writeFileSync(ambientNpm, "#!/bin/sh\npwd\n");
    chmodSync(capturedNpm, 0o755);
    chmodSync(ambientNpm, 0o755);
    process.env.PATH = ambientBin;

    await expect(
      checkGlobalInstallPermissions({
        environment: { ...process.env, PATH: capturedBin },
        cwd: capturedCwd,
      }),
    ).resolves.toEqual({
      hasPermissions: true,
      npmPrefix: capturedCwd,
    });

    const environmentWithoutPath = { ...process.env };
    delete environmentWithoutPath.PATH;
    delete environmentWithoutPath.Path;
    await expect(
      checkGlobalInstallPermissions({
        environment: environmentWithoutPath,
        cwd: capturedCwd,
      }),
    ).resolves.toEqual({
      hasPermissions: false,
      npmPrefix: null,
    });
  },
);
