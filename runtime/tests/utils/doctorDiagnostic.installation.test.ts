import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import {
  detectConfigurationIssues,
  detectMultipleInstallations,
  findActiveGeneratedWrapper,
  getCurrentInstallationType,
  getInstallationPath,
  isRunningFromPrivateNodeRuntime,
  retainOnlyMultipleInstallations,
} from "../../src/utils/doctorDiagnostic.js";
import {
  renderGeneratedWrapperContent,
  type GeneratedWrapper,
} from "../../src/utils/generated-wrapper.js";

const roots: string[] = [];
const originalExecPath = process.execPath;
const originalAgencHome = process.env.AGENC_HOME;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const hadBun = Reflect.has(globalThis, "Bun");
const originalBun = Reflect.get(globalThis, "Bun");
const hadMacro = Reflect.has(globalThis, "MACRO");
const originalMacro = Reflect.get(globalThis, "MACRO");

function restoreEnvironment(): void {
  process.execPath = originalExecPath;
  if (originalAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = originalAgencHome;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (hadBun) {
    Reflect.set(globalThis, "Bun", originalBun);
  } else {
    Reflect.deleteProperty(globalThis, "Bun");
  }
  if (hadMacro) {
    Reflect.set(globalThis, "MACRO", originalMacro);
  } else {
    Reflect.deleteProperty(globalThis, "MACRO");
  }
}

function executableName(): string {
  return process.platform === "win32" ? "agenc.exe" : "agenc";
}

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    process.platform === "win32" ? "test executable\n" : "#!/bin/sh\n",
  );
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function forceBundledFallback(root: string): void {
  process.execPath = join(root, "missing-runtime");
  Reflect.set(globalThis, "Bun", { embeddedFiles: ["test"] });
  Reflect.set(globalThis, "MACRO", {
    PACKAGE_URL: "@tetsuo-ai/runtime",
    VERSION: "test",
  });
}

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

beforeEach(() => {
  Reflect.set(globalThis, "MACRO", {
    PACKAGE_URL: "@tetsuo-ai/runtime",
    VERSION: "test",
  });
});

afterEach(() => {
  restoreEnvironment();
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

  it.skipIf(process.platform === "win32")(
    "finds the active wrapper only through captured PATH",
    async () => {
      const { root, runtimeBin, wrapperPath, wrapper } = fixture();
      const ambientBin = join(root, "ambient-bin");
      mkdirSync(ambientBin);
      process.env.PATH = ambientBin;

      await expect(
        findActiveGeneratedWrapper({
          invokedPath: runtimeBin,
          environment: { PATH: dirname(wrapperPath) },
          cwd: root,
        }),
      ).resolves.toEqual(wrapper);
    },
  );

  it("proves a direct private-Node runtime without relying on a PATH wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-private-runtime-"));
    roots.push(root);
    const runtimePath = join(
      root,
      "node_modules",
      "@tetsuo-ai",
      "runtime",
      "bin",
      "agenc",
    );
    const nodePath = join(
      root,
      "node_modules",
      ".agenc-node",
      "bin",
      "node",
    );

    expect(
      isRunningFromPrivateNodeRuntime({ nodePath, runtimePath }),
    ).toBe(true);
    expect(
      isRunningFromPrivateNodeRuntime({
        nodePath: process.execPath,
        runtimePath,
      }),
    ).toBe(false);
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

  it("locates a bundled fallback only through the captured PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-doctor-captured-path-"));
    roots.push(root);
    const capturedBin = join(root, "captured-bin");
    const ambientBin = join(root, "ambient-bin");
    const capturedExecutable = join(capturedBin, executableName());
    const ambientExecutable = join(ambientBin, executableName());
    writeExecutable(capturedExecutable);
    writeExecutable(ambientExecutable);
    forceBundledFallback(root);
    process.env.PATH = [ambientBin, originalPath]
      .filter((entry): entry is string => entry !== undefined && entry.length > 0)
      .join(delimiter);

    await expect(
      getInstallationPath({
        installationType: "native",
        activeGeneratedWrapper: null,
        environment: {
          ...process.env,
          PATH: capturedBin,
          HOME: join(root, "captured-home"),
        },
      }),
    ).resolves.toBe(capturedExecutable);
  });

  it.skipIf(process.platform === "win32")(
    "uses captured HOME for the bundled native fallback",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agenc-doctor-captured-home-"));
      roots.push(root);
      const emptyBin = join(root, "empty-bin");
      const capturedHome = join(root, "captured-home");
      const ambientHome = join(root, "ambient-home");
      mkdirSync(emptyBin);
      const capturedExecutable = join(
        capturedHome,
        ".local",
        "bin",
        executableName(),
      );
      writeExecutable(capturedExecutable);
      writeExecutable(
        join(ambientHome, ".local", "bin", executableName()),
      );
      forceBundledFallback(root);
      process.env.PATH = emptyBin;
      process.env.HOME = ambientHome;

      await expect(
        getInstallationPath({
          installationType: "native",
          activeGeneratedWrapper: null,
          environment: { PATH: emptyBin, HOME: capturedHome },
        }),
      ).resolves.toBe(capturedExecutable);
    },
  );

  it("finds managed installs only under the captured AgenC home", async () => {
    const { root, wrapper } = fixture();
    const capturedAgencHome = join(root, "captured-agenc-home");
    const ambientAgencHome = join(root, "ambient-agenc-home");
    const capturedLocalBinary = join(
      capturedAgencHome,
      "local",
      "node_modules",
      ".bin",
      "agenc",
    );
    const ambientLocalBinary = join(
      ambientAgencHome,
      "local",
      "node_modules",
      ".bin",
      "agenc",
    );
    writeExecutable(capturedLocalBinary);
    writeExecutable(ambientLocalBinary);
    process.env.AGENC_HOME = ambientAgencHome;

    const emptyBin = join(root, "empty-bin");
    const capturedProfile = join(root, "captured-profile");
    mkdirSync(emptyBin);
    mkdirSync(capturedProfile);
    const home = resolveHomeContext(
      { AGENC_HOME: capturedAgencHome },
      { platformHome: capturedProfile },
    );
    const stateRepository = new RuntimeStateRepository(home, {
      storage: "memory",
    });
    try {
      await expect(
        detectMultipleInstallations(
          wrapper,
          stateRepository,
          {
            AGENC_HOME: capturedAgencHome,
            HOME: capturedProfile,
            PATH: emptyBin,
          },
          capturedAgencHome,
          root,
        ),
      ).resolves.toEqual([
        {
          type: "npm-local",
          path: join(capturedAgencHome, "local"),
        },
        { type: "native", path: wrapper.path },
      ]);
    } finally {
      stateRepository.close();
    }
  });

  it("uses captured USERPROFILE and Path for native PATH warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-doctor-profile-"));
    roots.push(root);
    const capturedProfile = join(root, "captured-profile");
    const ambientProfile = join(root, "ambient-profile");
    const agencHome = join(root, "agenc-home");
    mkdirSync(capturedProfile);
    mkdirSync(ambientProfile);
    mkdirSync(agencHome);
    process.env.HOME = ambientProfile;

    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: capturedProfile },
    );
    const stateRepository = new RuntimeStateRepository(home, {
      storage: "memory",
    });
    try {
      const capturedLocalBin = join(capturedProfile, ".local", "bin");
      const ambientLocalBin = join(ambientProfile, ".local", "bin");
      const baseEnvironment = {
        AGENC_HOME: agencHome,
        USERPROFILE: capturedProfile,
        SHELL: "/bin/zsh",
        DISABLE_INSTALLATION_CHECKS: "1",
      };
      const clean = await detectConfigurationIssues(
        "native",
        stateRepository,
        { ...baseEnvironment, Path: capturedLocalBin },
        root,
        agencHome,
      );
      const warned = await detectConfigurationIssues(
        "native",
        stateRepository,
        { ...baseEnvironment, Path: ambientLocalBin },
        root,
        agencHome,
      );

      expect(
        clean.some(({ issue }) => issue.includes("not in your PATH")),
      ).toBe(false);
      expect(
        warned.some(({ issue }) => issue.includes("not in your PATH")),
      ).toBe(true);
    } finally {
      stateRepository.close();
    }
  });

  it("checks local accessibility against captured PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-doctor-local-path-"));
    roots.push(root);
    const capturedProfile = join(root, "captured-profile");
    const ambientBin = join(root, "ambient-bin");
    const capturedBin = join(root, "captured-bin");
    const agencHome = join(root, "agenc-home");
    mkdirSync(capturedProfile);
    mkdirSync(ambientBin);
    mkdirSync(capturedBin);
    mkdirSync(agencHome);
    writeExecutable(join(ambientBin, executableName()));
    writeExecutable(join(capturedBin, executableName()));
    process.env.PATH = ambientBin;

    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: capturedProfile },
    );
    const stateRepository = new RuntimeStateRepository(home, {
      storage: "memory",
    });
    try {
      const baseEnvironment = {
        AGENC_HOME: agencHome,
        HOME: capturedProfile,
        SHELL: "/bin/zsh",
        DISABLE_INSTALLATION_CHECKS: "1",
      };
      const warned = await detectConfigurationIssues(
        "npm-local",
        stateRepository,
        { ...baseEnvironment, PATH: join(root, "empty-bin") },
        root,
        agencHome,
      );
      const clean = await detectConfigurationIssues(
        "npm-local",
        stateRepository,
        { ...baseEnvironment, PATH: capturedBin },
        root,
        agencHome,
      );

      expect(warned).toContainEqual({
        issue: "Local installation not accessible",
        fix: `Create alias: alias agenc="${join(agencHome, "local", "agenc")}"`,
      });
      expect(
        clean.some(({ issue }) => issue === "Local installation not accessible"),
      ).toBe(false);
    } finally {
      stateRepository.close();
    }
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
