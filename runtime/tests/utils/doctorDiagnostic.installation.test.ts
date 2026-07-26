import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findActiveGeneratedWrapper,
  getCurrentInstallationType,
  getInstallationPath,
  retainOnlyMultipleInstallations,
} from "../../src/utils/doctorDiagnostic.js";
import {
  renderGeneratedWrapperContent,
  type GeneratedWrapper,
} from "../../src/utils/generated-wrapper.js";

const roots: string[] = [];

function fixture(): {
  root: string;
  runtimeBin: string;
  wrapperPath: string;
  wrapper: GeneratedWrapper;
} {
  const root = mkdtempSync(join(tmpdir(), "agenc-doctor-install-"));
  roots.push(root);
  const runtimeBin = join(root, "runtime", "bin", "agenc");
  const wrapperPath = join(root, "bin", "agenc");
  const agencHome = join(root, ".agenc");
  mkdirSync(join(root, "runtime", "bin"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(runtimeBin, "#!/usr/bin/env node\n");
  writeFileSync(
    wrapperPath,
    renderGeneratedWrapperContent({
      kind: "posix",
      nodeBin: process.execPath,
      runtimeBin,
      agencHome,
    }),
  );
  chmodSync(wrapperPath, 0o755);
  return {
    root,
    runtimeBin,
    wrapperPath,
    wrapper: {
      kind: "posix",
      path: wrapperPath,
      nodeBin: process.execPath,
      runtimeBin,
      agencHome,
    },
  };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("Doctor installation detection", () => {
  it("recognizes a canonical wrapper that launches the exact active runtime", async () => {
    const { runtimeBin, wrapperPath, wrapper } = fixture();
    await expect(
      findActiveGeneratedWrapper({
        invokedPath: runtimeBin,
        commandPath: wrapperPath,
      }),
    ).resolves.toEqual(wrapper);
  });

  it("rejects a canonical wrapper for a different runtime", async () => {
    const { root, wrapperPath } = fixture();
    const otherRuntime = join(root, "runtime", "bin", "other");
    writeFileSync(otherRuntime, "#!/usr/bin/env node\n");
    await expect(
      findActiveGeneratedWrapper({
        invokedPath: otherRuntime,
        commandPath: wrapperPath,
      }),
    ).resolves.toBeNull();
  });

  it("classifies and displays a proven standalone install as native", async () => {
    const { wrapper } = fixture();
    await expect(
      getCurrentInstallationType({ activeGeneratedWrapper: wrapper }),
    ).resolves.toBe("native");
    await expect(
      getInstallationPath({
        installationType: "native",
        activeGeneratedWrapper: wrapper,
      }),
    ).resolves.toBe(wrapper.path);
  });

  it("does not call one detected installation multiple", () => {
    expect(
      retainOnlyMultipleInstallations([
        { type: "native", path: "/home/example/.local/bin/agenc" },
      ]),
    ).toEqual([]);
  });

  it("deduplicates repeated PATH hits but retains two distinct installs", () => {
    expect(
      retainOnlyMultipleInstallations([
        { type: "npm-global", path: "/home/example/.local/bin/agenc" },
        { type: "native", path: "/home/example/.local/bin/agenc" },
      ]),
    ).toEqual([]);
    expect(
      retainOnlyMultipleInstallations([
        { type: "native", path: "/home/example/.local/bin/agenc" },
        { type: "npm-global", path: "/usr/local/bin/agenc" },
      ]),
    ).toEqual([
      { type: "native", path: "/home/example/.local/bin/agenc" },
      { type: "npm-global", path: "/usr/local/bin/agenc" },
    ]);
  });
});
