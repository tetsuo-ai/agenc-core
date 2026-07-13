import { describe, expect, it, vi } from "vitest";
import {
  applyRuntimeSandboxToSpawn,
  transformWithRuntimeSandbox,
} from "../../../src/tools/system/apply-runtime-sandbox.js";
import { UnifiedExecError } from "../../../src/unified-exec/types.js";
import type { UnifiedExecRuntimeSandbox } from "../../../src/unified-exec/types.js";
import type { PermissionProfile } from "../../../src/sandbox/engine/index.js";

function fakeProfile(): PermissionProfile {
  return {
    fileSystem: { kind: "workspace_write", entries: [] },
    network: { kind: "enabled" },
  } as PermissionProfile;
}

function fakeRuntimeSandbox(
  preference: "require" | "auto" = "require",
): UnifiedExecRuntimeSandbox {
  return {
    permissionProfile: fakeProfile(),
    sandboxPolicyCwd: process.cwd(),
    preference,
  };
}

describe("applyRuntimeSandboxToSpawn (TOOL-03/04) — behavioral", () => {
  it("passes through when no runtime sandbox context is attached", () => {
    const result = applyRuntimeSandboxToSpawn({
      toolArgs: { command: "echo hi" },
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
    });
    expect(result.program).toBe("/bin/echo");
    expect(result.args).toEqual(["hi"]);
    expect(result.env.PATH).toBe("/usr/bin");
  });

  it("rewrites program/args via SandboxManager.transform when isolation is applied", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: { PATH: "/sandbox/bin", SANDBOX: "1" },
      arg0: "wrapper",
    });
    const selectInitial = vi.fn().mockReturnValue("bwrap");
    const manager = {
      selectInitial,
      transform,
    } as never;

    const result = transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
      runtimeSandbox: fakeRuntimeSandbox("require"),
      sandboxManager: manager,
    });

    expect(selectInitial).toHaveBeenCalled();
    expect(transform).toHaveBeenCalled();
    expect(result.program).toBe("/sandbox/wrapper");
    expect(result.args).toEqual(["/bin/echo", "hi"]);
    expect(result.cwd).toBe("/sandboxed");
    expect(result.env.SANDBOX).toBe("1");
  });

  it("threads allowGpu through to SandboxManager.transform when set", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: {},
    });
    const manager = {
      selectInitial: vi.fn().mockReturnValue("macos_seatbelt"),
      transform,
    } as never;

    transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: {},
      runtimeSandbox: { ...fakeRuntimeSandbox("require"), allowGpu: true },
      sandboxManager: manager,
    });

    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({ allowGpu: true }),
    );
  });

  it("omits allowGpu from the transform request when not set", () => {
    const transform = vi.fn().mockReturnValue({
      command: ["/sandbox/wrapper", "/bin/echo", "hi"],
      cwd: "/sandboxed",
      env: {},
    });
    const manager = {
      selectInitial: vi.fn().mockReturnValue("macos_seatbelt"),
      transform,
    } as never;

    transformWithRuntimeSandbox({
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: {},
      runtimeSandbox: fakeRuntimeSandbox("require"),
      sandboxManager: manager,
    });

    expect(transform.mock.calls[0]?.[0]).not.toHaveProperty("allowGpu");
  });

  it("fails closed when preference is require and no platform sandbox is selected", () => {
    const manager = {
      selectInitial: vi.fn().mockReturnValue("none"),
      transform: vi.fn(),
    } as never;

    expect(() =>
      transformWithRuntimeSandbox({
        program: "/bin/echo",
        args: ["hi"],
        cwd: process.cwd(),
        env: { PATH: "/usr/bin" },
        runtimeSandbox: fakeRuntimeSandbox("require"),
        sandboxManager: manager,
      }),
    ).toThrow(UnifiedExecError);

    expect(manager.transform).not.toHaveBeenCalled();
  });
});
