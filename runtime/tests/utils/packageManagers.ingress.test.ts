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

import {
  getOsRelease,
  getPackageManagerForIngress,
  type PackageManager,
} from "../../src/utils/nativeInstaller/packageManagers.js";

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

it.skipIf(process.platform !== "linux")(
  "runs ownership probes with captured PATH",
  async () => {
    const release = await getOsRelease();
    const families = new Set([release?.id ?? "", ...(release?.idLike ?? [])]);
    const expected: { command: string; manager: PackageManager } | null =
      families.has("arch")
        ? { command: "pacman", manager: "pacman" }
        : families.has("alpine")
          ? { command: "apk", manager: "apk" }
          : families.has("debian")
            ? { command: "dpkg", manager: "deb" }
            : families.has("fedora") ||
                families.has("rhel") ||
                families.has("suse")
              ? { command: "rpm", manager: "rpm" }
              : null;
    if (expected === null) return;

    const root = mkdtempSync(join(tmpdir(), "agenc-package-manager-ingress-"));
    roots.push(root);
    const capturedBin = join(root, "captured-bin");
    const ambientBin = join(root, "ambient-bin");
    mkdirSync(capturedBin);
    mkdirSync(ambientBin);
    const capturedCommand = join(capturedBin, expected.command);
    const ambientCommand = join(ambientBin, expected.command);
    writeFileSync(capturedCommand, "#!/bin/sh\necho 'owned by agenc'\n");
    writeFileSync(ambientCommand, "#!/bin/sh\nexit 1\n");
    chmodSync(capturedCommand, 0o755);
    chmodSync(ambientCommand, 0o755);
    process.env.PATH = ambientBin;

    await expect(
      getPackageManagerForIngress({
        environment: {
          ...process.env,
          PATH: capturedBin,
        },
        cwd: root,
      }),
    ).resolves.toBe(expected.manager);
    await expect(
      getPackageManagerForIngress({ environment: {}, cwd: root }),
    ).resolves.toBe("unknown");
  },
);
