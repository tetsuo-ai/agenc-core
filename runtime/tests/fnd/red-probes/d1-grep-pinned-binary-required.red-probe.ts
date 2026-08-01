import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachSandboxExecutionBroker,
  SandboxExecutionBroker,
} from "../../../src/sandbox/execution-broker.js";
import {
  __resetRipgrepProbeForTests,
  __setRipgrepAvailabilityForTests,
  createGrepTool,
} from "../../../src/tools/system/grep.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "d1-grep-pinned-binary-required",
    task: "D1",
    fingerprint: "D1:GREP:PINNED-BINARY-REQUIRED",
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-d1-red-"));
  let observed: Readonly<{
    isError: boolean;
    searchedWithoutPinnedBinary: boolean;
    hasPinnedRuntimeRemediation: boolean;
  }> = Object.freeze({
    isError: true,
    searchedWithoutPinnedBinary: false,
    hasPinnedRuntimeRemediation: false,
  });

  try {
    await writeFile(join(temporaryRoot, "needle.txt"), "needle\n", {
      mode: 0o600,
    });
    __setRipgrepAvailabilityForTests(false);
    const executionArgs: Record<string, unknown> = {
      pattern: "needle",
      path: temporaryRoot,
      output_mode: "files_with_matches",
    };
    attachSandboxExecutionBroker(
      executionArgs,
      new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: temporaryRoot,
      }),
      "tool",
    );
    const result = await createGrepTool({
      allowedPaths: [temporaryRoot],
    }).execute(executionArgs);
    observed = Object.freeze({
      isError: result.isError === true,
      searchedWithoutPinnedBinary: result.content.includes("needle.txt"),
      hasPinnedRuntimeRemediation:
        result.content.includes("pinned ripgrep") &&
        (result.content.includes("doctor") ||
          result.content.includes("reinstall")),
    });
  } finally {
    __resetRipgrepProbeForTests();
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    observed,
    Object.freeze({
      isError: true,
      searchedWithoutPinnedBinary: false,
      hasPinnedRuntimeRemediation: true,
    }),
  );
}
