import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LAUNCHED_PROCESS_OOM_SCORE_RAISE,
  preferLaunchedProcessAsOomVictim,
  type OomScoreFiles,
} from "../../src/utils/oom-preference.js";
import { runSupervisedProcess } from "../../src/utils/supervisedProcess.js";

function files(initial: string, fail?: "read" | "write") {
  const writes: Array<[string, string]> = [];
  const value: OomScoreFiles = {
    read: path => {
      if (fail === "read") throw new Error("ENOENT");
      return path.endsWith("/oom_score_adj") ? initial : "";
    },
    write: (path, text) => {
      if (fail === "write") throw new Error("EACCES");
      writes.push([path, text]);
    },
  };
  return { value, writes };
}

describe("preferLaunchedProcessAsOomVictim", () => {
  it("raises the inherited score of a launched process", () => {
    const fake = files("0\n");
    expect(preferLaunchedProcessAsOomVictim(4242, { platform: "linux", files: fake.value }))
      .toBe(LAUNCHED_PROCESS_OOM_SCORE_RAISE);
    expect(fake.writes).toEqual([["/proc/4242/oom_score_adj", `${LAUNCHED_PROCESS_OOM_SCORE_RAISE}\n`]]);
  });

  it("caps at the kernel maximum and never lowers a score", () => {
    const high = files("900");
    expect(preferLaunchedProcessAsOomVictim(7, { platform: "linux", files: high.value })).toBe(1000);
    expect(high.writes).toEqual([["/proc/7/oom_score_adj", "1000\n"]]);
    const max = files("1000");
    expect(preferLaunchedProcessAsOomVictim(7, { platform: "linux", files: max.value })).toBeUndefined();
    expect(max.writes).toEqual([]);
    const negative = files("-500");
    expect(preferLaunchedProcessAsOomVictim(7, { platform: "linux", files: negative.value })).toBe(-200);
  });

  it("is a no-op off Linux, for unsafe pids, malformed values and proc failures", () => {
    for (const [pid, platform, content, fail] of [
      [4242, "darwin", "0", undefined],
      [4242, "win32", "0", undefined],
      [1, "linux", "0", undefined],
      [0, "linux", "0", undefined],
      [undefined, "linux", "0", undefined],
      [4242, "linux", "garbage", undefined],
      [4242, "linux", "2000", undefined],
      [4242, "linux", "0", "read"],
      [4242, "linux", "0", "write"],
    ] as const) {
      const fake = files(content, fail);
      expect(preferLaunchedProcessAsOomVictim(pid, { platform, files: fake.value })).toBeUndefined();
    }
  });
});

describe.runIf(process.platform === "linux")("launched commands inherit the raised OOM score", () => {
  const own = Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim());
  const expected = Math.min(1000, own + LAUNCHED_PROCESS_OOM_SCORE_RAISE);

  it.each(["subreaper", undefined] as const)("through containment %s, including a grandchild", async containment => {
    const result = await runSupervisedProcess({
      program: "/bin/sh",
      // The inner sh is a grandchild of the launch root: inheritance, not a per-pid write.
      args: ["-c", "cat /proc/self/oom_score_adj; sh -c 'cat /proc/self/oom_score_adj'"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin" },
    }, { maxOutputBytes: 1_024, ...(containment ? { linuxContainment: containment } : {}) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8").trim().split(/\s+/).map(Number)).toEqual([expected, expected]);
    // The supervising process itself keeps its own score.
    expect(Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim())).toBe(own);
  });
});
