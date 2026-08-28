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
  getRipgrepStatus,
  probeRipgrepAvailable,
} from "../../src/utils/ripgrep.js";

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
  "probes ripgrep with the captured environment",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-ripgrep-ingress-"));
    roots.push(root);
    const capturedBin = join(root, "captured-bin");
    const ambientBin = join(root, "ambient-bin");
    mkdirSync(capturedBin);
    mkdirSync(ambientBin);
    const capturedRipgrep = join(capturedBin, "rg");
    const ambientRipgrep = join(ambientBin, "rg");
    writeFileSync(capturedRipgrep, "#!/bin/sh\necho 'ripgrep 14.1.0'\n");
    writeFileSync(ambientRipgrep, "#!/bin/sh\necho 'not ripgrep'\n");
    chmodSync(capturedRipgrep, 0o755);
    chmodSync(ambientRipgrep, 0o755);
    process.env.PATH = ambientBin;

    const ingress = {
      environment: {
        ...process.env,
        PATH: capturedBin,
        USE_BUILTIN_RIPGREP: "0",
      },
      systemExecutablePath: capturedRipgrep,
    };
    expect(getRipgrepStatus(ingress)).toMatchObject({
      mode: "system",
      working: null,
    });
    await expect(probeRipgrepAvailable(ingress)).resolves.toBe(true);
  },
);
