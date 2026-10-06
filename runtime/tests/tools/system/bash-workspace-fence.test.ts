import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createBashTool as createUnboundBashTool } from "../../../src/tools/system/bash.js";
import {
  createWorkspaceOperationLifetime,
  runWithWorkspaceOperationLifetime,
} from "../../../src/workspace/tool-operation-lifetime.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

describe("system.bash workspace-operation containment", () => {
  it("removes a detached delayed writer before the operation lifetime settles", async () => {
    if (process.platform === "win32") return;
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agenc-bash-editor-descendant-"),
    );
    const path = join(workspaceRoot, "loaded.ts");
    const launcherPath = join(workspaceRoot, "detached-launcher.cjs");
    await writeFile(path, "before\n", "utf8");
    const detachedLauncher = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "if(process.argv[2]==='writer'){",
      "setTimeout(()=>fs.writeFileSync(process.argv[3],'after\\n'),700);",
      "}else{",
      "const child=spawn(process.execPath,[__filename,'writer',process.argv[2]],{detached:true,stdio:'ignore'});",
      "child.unref();",
      "}",
    ].join("");
    await writeFile(launcherPath, detachedLauncher, "utf8");
    const tool = bindExplicitDangerBoundary(
      createUnboundBashTool({
        cwd: workspaceRoot,
        unrestricted: true,
      }),
    );
    const lifetime = createWorkspaceOperationLifetime(() => {});

    const result = await runWithWorkspaceOperationLifetime(lifetime, () =>
      tool.execute({
        command: process.execPath,
        args: [launcherPath, path],
      }),
    );
    expect(result).toMatchObject({
      isError: true,
      metadata: {
        exitCode: 0,
        stopReason: "residual_process",
        timedOut: false,
      },
    });
    expect(result.content).toContain("left a residual process tree");
    await lifetime.release();
    await lifetime.settled();

    await delay(900);
    expect(await readFile(path, "utf8")).toBe("before\n");
  });
});
