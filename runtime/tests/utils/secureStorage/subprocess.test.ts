import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeMissingExitCode, runSecureStorageCommand } from "../../../src/utils/secureStorage/subprocess.js";

describe("secure storage subprocess runner", () => {
  it("uses the same execa functions as an ESM import under the supported Node runtime", () => {
    const script = `import { loadExeca } from ${JSON.stringify(new URL("../../../src/utils/loadExeca.ts", import.meta.url).href)};
      const lazy = loadExeca();
      const direct = await import('execa');
      if (lazy.execa !== direct.execa || lazy.execaSync !== direct.execaSync) throw new Error('execa identity split');
      const result = lazy.execaSync(process.execPath, ['-e', 'process.stdout.write("kept\\\\n"); process.stderr.write("error\\\\n"); process.exitCode=7'], { reject: false });
      console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ exitCode: 7, stdout: "kept", stderr: "error" });
  });

  it("names why a child produced no exit code", () => {
    expect(describeMissingExitCode({ signal: "SIGKILL" })).toBe("signal SIGKILL");
    expect(describeMissingExitCode({ code: "ENOENT", originalMessage: "spawnSync helper ENOENT" })).toBe(
      "spawn error ENOENT; spawnSync helper ENOENT",
    );
    expect(describeMissingExitCode({ isMaxBuffer: true, timedOut: true })).toBe(
      "output exceeded the buffer limit; timed out",
    );
    expect(describeMissingExitCode({})).toBe("no exit code and no error reported");
  });

  it("reports the spawn failure instead of a bare undefined exit code", () => {
    const result = runSecureStorageCommand("/nonexistent/agenc-helper", ["read"], { reject: false });
    expect(result.exitCode).toBeUndefined();
    expect(result.failure).toContain("ENOENT");
  });

  it("still runs the helper when the process's own working directory is gone", () => {
    const doomed = mkdtempSync(join(tmpdir(), "agenc-dead-cwd-"));
    const script = `import { rmSync } from "node:fs";
      import { registerHooks } from "node:module";
      // Native Node strips TS but does not map source .js specifiers to .ts.
      registerHooks({ resolve(specifier, context, next) {
        return next(specifier === '../loadExeca.js' ? ${JSON.stringify(new URL("../../../src/utils/loadExeca.ts", import.meta.url).href)} : specifier, context);
      }});
      const { runSecureStorageCommand } = await import(${JSON.stringify(new URL("../../../src/utils/secureStorage/subprocess.ts", import.meta.url).href)});
      process.chdir(process.argv[1]);
      rmSync(process.argv[1], { recursive: true, force: true });
      const result = runSecureStorageCommand("/bin/echo", ["still here"], { reject: false, stdio: ["ignore", "pipe", "pipe"] });
      console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, failure: result.failure }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, doomed], { encoding: "utf8" });
    rmSync(doomed, { recursive: true, force: true });
    expect(child.status, child.stderr).toBe(0);
    const parsed = JSON.parse(child.stdout.trim());
    expect(parsed).toMatchObject({ exitCode: 0, stdout: "still here" });
  });
});
