import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tuiGateEnvironment } from "../../scripts/tui-gate-state.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function loadTraceModule() {
  vi.resetModules();
  return import("../../src/utils/tuiStartupTrace.js");
}

describe("TUI startup trace", () => {
  it("writes only to the exact bounded gate file and records each phase once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-tui-startup-trace-"));
    roots.push(root);
    const agencHome = join(root, ".agenc");
    await mkdir(agencHome, { mode: 0o700 });
    const tracePath = join(agencHome, "tui-startup-trace.jsonl");
    const outsidePath = join(root, "outside.jsonl");
    const env = {
      AGENC_HOME: agencHome,
      TUI_E2E_DEBUG: "1",
      TUI_E2E_STARTUP_TRACE: tracePath,
    };
    const { closeTuiStartupTrace, traceTuiStartupPhase } =
      await loadTraceModule();

    traceTuiStartupPhase("unit-phase", undefined, env);
    const first = await readFile(tracePath, "utf8");
    traceTuiStartupPhase("unit-phase", undefined, env);
    expect(await readFile(tracePath, "utf8")).toBe(first);

    traceTuiStartupPhase("wrong-destination", undefined, {
      ...env,
      TUI_E2E_STARTUP_TRACE: outsidePath,
    });
    await expect(stat(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });

    traceTuiStartupPhase("bounded-error", new Error("x".repeat(2_000)), env);
    const records = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map(({ phase }) => phase)).toEqual([
      "unit-phase",
      "bounded-error",
    ]);
    expect(Buffer.byteLength(JSON.stringify(records[1]), "utf8")).toBeLessThan(
      512,
    );
    closeTuiStartupTrace();
  });

  it("refuses a preexisting trace symlink without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-tui-startup-symlink-"));
    roots.push(root);
    const agencHome = join(root, ".agenc");
    const tracePath = join(agencHome, "tui-startup-trace.jsonl");
    const outsidePath = join(root, "outside.jsonl");
    await mkdir(agencHome, { mode: 0o700 });
    await writeFile(outsidePath, "outside\n", "utf8");
    await symlink(outsidePath, tracePath);
    const { traceTuiStartupPhase } = await loadTraceModule();

    traceTuiStartupPhase("must-not-follow", undefined, {
      AGENC_HOME: agencHome,
      TUI_E2E_DEBUG: "1",
      TUI_E2E_STARTUP_TRACE: tracePath,
    });

    expect(await readFile(outsidePath, "utf8")).toBe("outside\n");
    await rm(tracePath);
    traceTuiStartupPhase("must-stay-disabled", undefined, {
      AGENC_HOME: agencHome,
      TUI_E2E_DEBUG: "1",
      TUI_E2E_STARTUP_TRACE: tracePath,
    });
    await expect(stat(tracePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the exact environment produced by the private gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-tui-startup-gate-env-"));
    roots.push(root);
    const env = tuiGateEnvironment(root, { TUI_E2E_DEBUG: "1" });
    await mkdir(env.AGENC_HOME, { recursive: true, mode: 0o700 });
    const { closeTuiStartupTrace, traceTuiStartupPhase } =
      await loadTraceModule();

    traceTuiStartupPhase("gate-environment", undefined, env);

    expect(await readFile(env.TUI_E2E_STARTUP_TRACE, "utf8")).toMatch(
      /"phase":"gate-environment"/u,
    );
    closeTuiStartupTrace();
  });

  it("never lets hostile error conversion escape into TUI startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-tui-startup-hostile-"));
    roots.push(root);
    const agencHome = join(root, ".agenc");
    const tracePath = join(agencHome, "tui-startup-trace.jsonl");
    await mkdir(agencHome, { mode: 0o700 });
    const { traceTuiStartupPhase } = await loadTraceModule();
    const hostile = {
      toString(): string {
        throw new Error("detail-conversion-escaped");
      },
    };

    expect(() =>
      traceTuiStartupPhase("hostile-error", hostile, {
        AGENC_HOME: agencHome,
        TUI_E2E_DEBUG: "1",
        TUI_E2E_STARTUP_TRACE: tracePath,
      }),
    ).not.toThrow();
    await expect(stat(tracePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
