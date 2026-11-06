import { describe, expect, test } from "vitest";

import type { UnifiedExecRuntimeSandbox } from "../../../src/unified-exec/types.js";
import { PROCESS_DISCOVERY_GUIDANCE } from "../../../src/tools/system/local-server-guidance.js";
import { execProcessNamespaceNotice } from "../../../src/tools/system/exec-process-namespace.js";

const requireSandbox: UnifiedExecRuntimeSandbox = {
  permissionProfile: { fileSystem: { kind: "unrestricted" }, network: "disabled" },
  sandboxPolicyCwd: "/work",
  sessionTempRoot: "/tmp",
  preference: "require",
};

const NOTICE = `[sandbox] ${PROCESS_DISCOVERY_GUIDANCE}`;

function notice(
  command: string,
  runtimeSandbox: UnifiedExecRuntimeSandbox | undefined = requireSandbox,
): string | null {
  return execProcessNamespaceNotice({ command, runtimeSandbox });
}

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) {
    throw new Error("process.platform descriptor is unavailable");
  }
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("execProcessNamespaceNotice", () => {
  test.each([
    "ps aux",
    "pgrep -f nginx",
    "/usr/bin/pidof nginx",
    "/bin/ps",
    "  pidof sshd",
    "true; ps -p 1",
    "true && pgrep -x node",
    "ss -lntp | pidof nginx",
    "(ps -o pid=)",
    "timeout 5 ps",
  ])("explains a Linux require-sandbox process probe: %s", (command) => {
    expect(process.platform).toBe("linux");
    expect(notice(command)).toBe(NOTICE);
    expect(notice(command, { ...requireSandbox, preference: undefined })).toBe(NOTICE);
  });

  test.each([
    "appserver",
    "grep pslist",
    "echo 'ps aux'",
    "psaux",
    "myps",
    "pgrepped",
    "pidofx",
  ])("does not invent a probe from %s", (command) => {
    expect(notice(command)).toBeNull();
  });

  test("stays silent without a require-sandbox Linux exec", () => {
    expect(process.platform).toBe("linux");
    expect(execProcessNamespaceNotice({ command: "ps aux" })).toBeNull();
    expect(notice("ps aux", { ...requireSandbox, preference: "auto" })).toBeNull();
    expect(notice("ps aux", { ...requireSandbox, preference: "forbid" })).toBeNull();
    withPlatform("darwin", () => {
      expect(notice("ps aux")).toBeNull();
    });
    withPlatform("win32", () => {
      expect(notice("ps aux")).toBeNull();
    });
    expect(notice("ps aux")).toBe(NOTICE);
  });
});
