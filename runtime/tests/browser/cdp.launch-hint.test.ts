import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, vi } from "vitest";

import { launchBrowser, launchFailureHint } from "../../src/browser/cdp.js";
import {
  SandboxExecutionBroker,
  type SandboxPreparedSpawn,
} from "../../src/sandbox/execution-broker.js";

// What Chrome printed on Ubuntu 26.04 inside AgenC's Linux sandbox.
const SUID_ABORT =
  "[9:9:0923/171949.501230:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/google/chrome/chrome-sandbox is owned by root and has mode 4755.";
const NAMESPACE_ABORT =
  "[9:9:0923/173401.190279:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.";

async function launchFailure(stderr: string, overStdio = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenc-browser-hint-test-"));
  const worker = `process.stderr.write(${JSON.stringify(`${stderr}\n`)}, () => process.exit(1));`;
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: dir });
  vi.spyOn(broker, "prepareSpawn").mockImplementation((_surface, command) => {
    // overStdio stands for a launch through AgenC's Linux sandbox, where CDP
    // travels over stdin and stdout.
    const transformed = { program: process.execPath, args: ["-e", worker], cwd: dir, env: command.env,
      ...(overStdio ? { browserCdpOverStdio: true } : {}) };
    const signal = new AbortController().signal;
    return {
      run: operation => operation(transformed, signal),
      start: operation => operation(transformed, signal).value,
      runSync: operation => operation(transformed),
      spawnLifecycleParticipant: (_participantName, operation) => operation(transformed),
    } satisfies SandboxPreparedSpawn;
  });
  try {
    await launchBrowser({
      executablePath: process.execPath,
      userDataDir: dir,
      headless: true,
      noSandbox: false,
      proxyPort: 4567,
      sandboxExecutionBroker: broker,
    });
    throw new Error("launch unexpectedly succeeded");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("a Chromium sandbox abort inside AgenC's Linux sandbox points at no_sandbox", async () => {
  const message = await launchFailure(SUID_ABORT, true);
  expect(message).toMatch(/did not establish a CDP pipe/);
  expect(message).toContain("Set [browser] no_sandbox = true to run it under AgenC's sandbox alone.");
  expect(message).not.toContain("wrapper script");
});

test.skipIf(process.platform === "win32")("a Chromium sandbox abort outside AgenC's sandbox points at the installation", async () => {
  const message = await launchFailure(SUID_ABORT, false);
  expect(message).toContain("Fix the Chromium installation");
  expect(message).not.toContain("no_sandbox");
});

test.skipIf(process.platform === "win32")("any other launch failure keeps the wrapper script hint", async () => {
  const message = await launchFailure("error while loading shared libraries: libnss3.so");
  expect(message).toContain("set [browser].executable_path to a real Chromium binary");
  expect(message).not.toContain("no_sandbox");
});

test("both of Chromium's own-sandbox aborts are recognized inside AgenC's Linux sandbox", () => {
  expect(launchFailureHint(SUID_ABORT, true)).toContain("no_sandbox = true");
  expect(launchFailureHint(NAMESPACE_ABORT, true)).toContain("no_sandbox = true");
  expect(launchFailureHint("", true)).toContain("wrapper script");
});

test("outside AgenC's Linux sandbox, a sandbox abort never suggests turning Chromium's sandbox off", () => {
  for (const abort of [SUID_ABORT, NAMESPACE_ABORT]) {
    const hint = launchFailureHint(abort, false);
    expect(hint).toContain("Fix the Chromium installation");
    expect(hint).not.toContain("no_sandbox");
  }
});
