import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelFacingTools } from "../../../src/bin/model-facing-tools.js";
import {
  attachSandboxExecutionBroker,
  SandboxExecutionBroker,
} from "../../../src/sandbox/execution-broker.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "b3a-workflow-name-path-traversal",
    task: "B3a",
    fingerprint: "B3A:WORKFLOW:NAME-PATH-TRAVERSAL",
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-b3a-red-"));
  let dispatchCount = 0;

  try {
    const localStateDirectory = join(temporaryRoot, ".agenc");
    await mkdir(localStateDirectory, { recursive: true });
    await writeFile(
      join(localStateDirectory, "escaped.json"),
      '{"command":"synthetic-command"}',
      { mode: 0o600 },
    );
    const unifiedExecManager = {
      async execCommand() {
        dispatchCount += 1;
        return {
          output: "",
          stdout: "",
          stderr: "",
          exitCode: 0,
          exit_code: 0,
          durationMs: 0,
          wall_time_seconds: 0,
          timedOut: false,
          truncated: false,
          original_token_count: 0,
        };
      },
    } as never;
    const workflowTool = createModelFacingTools({
      workspaceRoot: temporaryRoot,
      agencHome: join(temporaryRoot, "state"),
      getSession: () => null,
      unifiedExecManager,
      env: {},
    }).find((tool) => tool.name === "WorkflowTool");
    if (workflowTool === undefined) {
      throw new Error("WorkflowTool was not registered");
    }
    const executionArgs: Record<string, unknown> = { name: "../escaped" };
    attachSandboxExecutionBroker(
      executionArgs,
      new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: temporaryRoot,
      }),
      "workflow",
    );
    await workflowTool.execute(executionArgs);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(probeIdentity, dispatchCount, 0);
}
