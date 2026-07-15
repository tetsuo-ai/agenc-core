import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildNeovimEmbedArgs,
  compareVersions,
  discoverNeovim,
  parseNeovimVersion,
  resolveNeovimExecutable,
} from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";

let dir: string;
let previousPath: string | undefined;

beforeEach(async () => {
  previousPath = process.env.PATH;
  dir = await mkdtemp(join(tmpdir(), "agenc-nvim-discovery-"));
});

afterEach(async () => {
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("embedded Neovim discovery", () => {
  it("parses version lines with suffix text", () => {
    expect(parseNeovimVersion("NVIM v0.12.0-dev\nBuild type: RelWithDebInfo")).toEqual({
      major: 0,
      minor: 12,
      patch: 0,
      raw: "NVIM v0.12.0-dev",
    });
    expect(parseNeovimVersion("not neovim")).toBeNull();
  });

  it("builds clean embedded args for hermetic mode and plain embedded args with user init", () => {
    expect(buildNeovimEmbedArgs(false)).toEqual(["--embed", "--clean", "-n"]);
    expect(buildNeovimEmbedArgs(true)).toEqual(["--embed"]);
  });

  it("prefers user init by default when a supported Neovim starts embedded mode", async () => {
    const executable = join(dir, "nvim-probe");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0-dev\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result.usable).toBe(true);
    if (result.usable) {
      expect(result.executable).toBe(executable);
      expect(result.args).toEqual(["--embed"]);
      expect(result.useUserInit).toBe(true);
    }
  });

  it("falls back to clean embedded mode when default user init cannot start", async () => {
    const executable = join(dir, "nvim-user-init-fails");
    await writeFile(
      executable,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nif [ \"$2\" = \"--clean\" ]; then exit 0; fi\necho 'init boom' >&2\nexit 5\n",
      "utf8",
    );
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({
      usable: true,
      args: ["--embed", "--clean", "-n"],
      useUserInit: false,
    });
  });

  it("uses the default probe timeout when no timeout is configured", async () => {
    const executable = join(dir, "nvim-default-timeout");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.2\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable });

    expect(result).toMatchObject({ usable: true });
  });

  it("searches PATH for configured relative executables before falling back to nvim", async () => {
    const executable = join(dir, "nvim-relative");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.1\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;

    await expect(resolveNeovimExecutable("nvim-relative")).resolves.toBe(executable);
    const result = await discoverNeovim({ executable: "nvim-relative", timeoutMs: 500 });

    expect(result).toMatchObject({
      usable: true,
      executable,
    });
  });

  it("returns a missing-binary fallback when configured and default executables are absent", async () => {
    process.env.PATH = dir;

    const result = await discoverNeovim({ executable: "not-nvim-here", timeoutMs: 20 });

    expect(result).toMatchObject({
      usable: false,
      reasonCode: "missing-binary",
      executable: null,
    });
  });

  it("treats an empty configured executable as absent and still searches PATH", async () => {
    const executable = join(dir, "nvim");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.3\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;

    const result = await discoverNeovim({ executable: "   ", timeoutMs: 500 });

    expect(result).toMatchObject({
      usable: true,
      executable,
    });
  });

  it("does not interpolate unsafe configured relative executables into the shell", async () => {
    const executable = join(dir, "nvim");
    const marker = join(dir, "shell-marker");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.4\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;

    const result = await discoverNeovim({
      executable: `nvim;touch ${marker}`,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ usable: true, executable });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors explicit user init config and rejects unsupported or malformed probe output", async () => {
    const oldExecutable = join(dir, "nvim-old");
    const badExecutable = join(dir, "nvim-bad");
    const initExecutable = join(dir, "nvim-init");
    await writeFile(oldExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.8.3\\n'; exit 0; fi\nexit 0\n", "utf8");
    await writeFile(badExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'hello\\n'; exit 0; fi\nexit 0\n", "utf8");
    await writeFile(initExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(oldExecutable, 0o755);
    await chmod(badExecutable, 0o755);
    await chmod(initExecutable, 0o755);

    const oldResult = await discoverNeovim({ executable: oldExecutable, timeoutMs: 500 });
    expect(oldResult).toMatchObject({ usable: false, reasonCode: "unsupported-version" });

    const badResult = await discoverNeovim({ executable: badExecutable, timeoutMs: 500 });
    expect(badResult).toMatchObject({ usable: false, reasonCode: "probe-failed" });

    const initResult = await discoverNeovim({
      executable: initExecutable,
      timeoutMs: 500,
      useUserInit: true,
    });
    expect(initResult).toMatchObject({
      usable: true,
      args: ["--embed"],
      useUserInit: true,
    });
  });

  it("honors explicit clean init config", async () => {
    const executable = join(dir, "nvim-clean");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nif [ \"$2\" = \"--clean\" ]; then exit 0; fi\nexit 9\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500, useUserInit: false });

    expect(result).toMatchObject({
      usable: true,
      args: ["--embed", "--clean", "-n"],
      useUserInit: false,
    });
  });

  it("records stderr when the version probe exits nonzero", async () => {
    const executable = join(dir, "nvim-fail");
    await writeFile(executable, "#!/bin/sh\necho 'boom' >&2\nexit 2\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) {
      expect(result.reason).toContain("boom");
    }
  });

  it("rejects a supported version that cannot start in embedded mode", async () => {
    const executable = join(dir, "nvim-no-embed");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\necho 'embed disabled' >&2\nexit 3\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) expect(result.reason).toContain("embed disabled");
  });

  it("records embedded mode probe signals when stderr is empty", async () => {
    const executable = join(dir, "nvim-embed-signal");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nkill -TERM $$\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) expect(result.reason).toContain("SIGTERM");
  });

  it("records embedded mode probe exit codes when stderr and signal are empty", async () => {
    const executable = join(dir, "nvim-embed-exit-code");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nexit 4\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) expect(result.reason).toContain("exit 4");
  });

  it("accepts embedded mode probes that stay alive and kills the probe child", async () => {
    const executable = join(dir, "nvim-embed-hangs");
    const pidFile = join(dir, "nvim-embed-hangs.pid");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nprintf $$ > '${pidFile}'\nsleep 5\n`, "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(await readFile(pidFile, "utf8"));

    expect(result).toMatchObject({ usable: true, executable });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("reports spawn errors from the embedded mode probe", async () => {
    const executable = join(dir, "nvim-embed-missing");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then rm "$0"; printf 'NVIM v0.12.0\\n'; exit 0; fi\nexit 0\n`, "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) expect(result.reason).toContain("failed the embedded mode probe");
  });

  it("records exit code and signal when a failed probe has no stderr", async () => {
    const codeExecutable = join(dir, "nvim-exit-code");
    const signalExecutable = join(dir, "nvim-signal");
    await writeFile(codeExecutable, "#!/bin/sh\nexit 7\n", "utf8");
    await writeFile(signalExecutable, "#!/bin/sh\nkill -TERM $$\n", "utf8");
    await chmod(codeExecutable, 0o755);
    await chmod(signalExecutable, 0o755);

    const codeResult = await discoverNeovim({ executable: codeExecutable, timeoutMs: 500 });
    expect(codeResult).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!codeResult.usable) expect(codeResult.reason).toContain("exit 7");

    const signalResult = await discoverNeovim({ executable: signalExecutable, timeoutMs: 500 });
    expect(signalResult).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!signalResult.usable) expect(signalResult.reason).toContain("SIGTERM");
  });

  it("records process spawn errors from an absolute configured executable", async () => {
    const result = await discoverNeovim({ executable: join(dir, "missing-absolute"), timeoutMs: 500 });

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-failed" });
    if (!result.usable) {
      expect(result.reason).toContain("missing-absolute");
    }
  });

  it("returns a timeout reason and kills a hanging probe", async () => {
    const executable = join(dir, "nvim-hang");
    const pidFile = join(dir, "nvim-hang.pid");
    await writeFile(executable, `#!/bin/sh\nprintf $$ > '${pidFile}'\nsleep 5\n`, "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(await readFile(pidFile, "utf8"));

    expect(result.usable).toBe(false);
    if (!result.usable) {
      expect(result.reasonCode).toBe("probe-timeout");
      expect(result.reason).toContain("did not answer");
    }
    expect(isProcessAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "kills a long-lived version-probe descendant that inherits the probe pipes",
    async () => {
      const executable = join(dir, "nvim-version-descendant");
      const descendantPidFile = join(dir, "nvim-version-descendant.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  sleep 60 &",
          `  printf '%s' "$!" > '${descendantPidFile}'`,
          "  printf 'NVIM v0.12.0\\n'",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);

      let descendantPid = 0;
      try {
        const result = await discoverNeovim({ executable, timeoutMs: 50 });
        descendantPid = Number(await readFile(descendantPidFile, "utf8"));
        await waitUntilDead(descendantPid);

        expect(result).toMatchObject({ usable: false, reasonCode: "probe-timeout" });
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        descendantPid ||= await readProcessIdIfPresent(descendantPidFile);
        killProcessIfAlive(descendantPid);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a closed-stdio version-probe descendant after a successful close",
    async () => {
      const executable = join(dir, "nvim-version-detached-descendant");
      const descendantPidFile = join(dir, "nvim-version-detached-descendant.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  sleep 60 </dev/null >/dev/null 2>&1 &",
          `  printf '%s' "$!" > '${descendantPidFile}'`,
          "  printf 'NVIM v0.12.0\\n'",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);

      let descendantPid = 0;
      try {
        const result = await discoverNeovim({ executable, timeoutMs: 500 });
        descendantPid = Number(await readFile(descendantPidFile, "utf8"));
        await waitUntilDead(descendantPid);

        expect(result).toMatchObject({ usable: true, executable });
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        descendantPid ||= await readProcessIdIfPresent(descendantPidFile);
        killProcessIfAlive(descendantPid);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a long-lived embedded-probe descendant after its leader exits successfully",
    async () => {
      const executable = join(dir, "nvim-embed-descendant");
      const descendantPidFile = join(dir, "nvim-embed-descendant.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  printf 'NVIM v0.12.0\\n'",
          "  exit 0",
          "fi",
          "sleep 60 &",
          `printf '%s' "$!" > '${descendantPidFile}'`,
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);

      let descendantPid = 0;
      try {
        const result = await discoverNeovim({ executable, timeoutMs: 500 });
        descendantPid = Number(await readFile(descendantPidFile, "utf8"));
        await waitUntilDead(descendantPid);

        expect(result).toMatchObject({ usable: true, executable });
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        descendantPid ||= await readProcessIdIfPresent(descendantPidFile);
        killProcessIfAlive(descendantPid);
      }
    },
  );

  it("ignores a late process exit after a timed out probe has already settled", async () => {
    const executable = join(dir, "nvim-late-exit");
    await writeFile(executable, "#!/bin/sh\nprintf 'NVIM v0.12.0\\n'\nsleep 1\n", "utf8");
    await chmod(executable, 0o755);

    const result = await discoverNeovim({ executable, timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result).toMatchObject({ usable: false, reasonCode: "probe-timeout" });
  });

  it("compares versions against the minimum tuple", () => {
    const version = { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" };

    expect(compareVersions(version, [0, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions(version, [0, 12, 0])).toBe(0);
    expect(compareVersions(version, [0, 12, 1])).toBeLessThan(0);
  });
});

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readProcessIdIfPresent(path: string): Promise<number> {
  try {
    return Number(await readFile(path, "utf8"));
  } catch {
    return 0;
  }
}

function killProcessIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and the cleanup signal.
  }
}
