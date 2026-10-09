import { describe, expect, test } from "vitest";

import { buildStructuredSessionBootstrapArgv } from "../../src/app-server/session-bootstrap-argv.js";
import { readStartupCliFlags } from "../../src/bin/startup-cli-flags.js";
import { startupConfigLayerOptions } from "../../src/bin/startup-selection.js";
import { MAX_ADDITIONAL_WORKING_DIRECTORIES } from "../../src/contracts/additional-working-directories.js";

const EXECUTABLE = "node";
const ENTRYPOINT = "/opt/agenc/dist/agenc.js";

describe("buildStructuredSessionBootstrapArgv", () => {
  test.each([
    { name: "missing both", argv: [] as const },
    { name: "missing entrypoint", argv: ["node"] as const },
    { name: "blank executable", argv: ["", ENTRYPOINT] as const },
    { name: "whitespace entrypoint", argv: [EXECUTABLE, "  "] as const },
  ])("rejects $name", ({ argv }) => {
    expect(() =>
      buildStructuredSessionBootstrapArgv({ permissionMode: "plan" }, argv),
    ).toThrow(TypeError);
  });

  test("inherits only the executable and entrypoint from process argv", () => {
    const argv = buildStructuredSessionBootstrapArgv(
      {
        provider: "grok",
        model: "grok-4.6",
        profile: "fast",
        configPath: "/workspace/explicit-config.toml",
        permissionMode: "plan",
        addDirs: ["../shared workspace", "/tmp/shared"],
      },
      [
        EXECUTABLE,
        ENTRYPOINT,
        "--provider",
        "openai",
        "--model",
        "daemon-default",
        "--yolo",
        "daemon",
        "run",
      ],
    );

    expect(argv).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--provider",
      "grok",
      "--model",
      "grok-4.6",
      "--profile",
      "fast",
      "--config",
      "/workspace/explicit-config.toml",
      "--add-dir=../shared workspace",
      "--add-dir=/tmp/shared",
      "--permission-mode",
      "plan",
    ]);
  });

  test("omits blank optional flags and still pins permission mode", () => {
    expect(
      buildStructuredSessionBootstrapArgv(
        {
          provider: "  ",
          model: "",
          profile: undefined,
          permissionMode: "bypassPermissions",
        },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("deduplicates addDirs in first-seen order and rejects empty or overflowing paths", () => {
    expect(
      buildStructuredSessionBootstrapArgv(
        { addDirs: ["/tmp/a", "/tmp/b", "/tmp/a"] },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toEqual([
      EXECUTABLE,
      ENTRYPOINT,
      "--add-dir=/tmp/a",
      "--add-dir=/tmp/b",
    ]);

    expect(() =>
      buildStructuredSessionBootstrapArgv(
        { addDirs: [""] },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toThrow(/must not contain an empty path/u);

    expect(() =>
      buildStructuredSessionBootstrapArgv(
        {
          addDirs: Array.from(
            { length: MAX_ADDITIONAL_WORKING_DIRECTORIES + 1 },
            (_, index) => `/tmp/shared-${index}`,
          ),
        },
        [EXECUTABLE, ENTRYPOINT],
      ),
    ).toThrow(
      `session bootstrap addDirs accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
    );
  });
});

test("round trips per-task budgets from daemon selection to session config overrides", () => {
  const argv = buildStructuredSessionBootstrapArgv(
    { taskTokenBudget: 219000, taskMaxCalls: 17 },
    [EXECUTABLE, ENTRYPOINT, "--task-token-budget", "999999"],
  );
  expect(startupConfigLayerOptions({ cli: readStartupCliFlags(argv), cwd: "/workspace" }).cliOverrides)
    .toEqual({ task_token_budget: 219000, task_max_calls: 17 });
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid budget settings at bootstrap: %s", value => {
    for (const key of ["taskTokenBudget", "taskMaxCalls"] as const) {
      expect(() => buildStructuredSessionBootstrapArgv({ [key]: value }, [EXECUTABLE, ENTRYPOINT]))
        .toThrow(/non-negative safe integer/);
    }
  },
);

test("preserves explicit budget opt-outs through daemon bootstrap", () => {
  const argv = buildStructuredSessionBootstrapArgv({ taskTokenBudget: 0, taskMaxCalls: 0 }, [EXECUTABLE, ENTRYPOINT]);
  expect(startupConfigLayerOptions({ cli: readStartupCliFlags(argv), cwd: "/workspace" }).cliOverrides)
    .toEqual({ task_token_budget: 0, task_max_calls: 0 });
});
