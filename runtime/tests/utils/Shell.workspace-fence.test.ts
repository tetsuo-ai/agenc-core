import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import { runWithCurrentRuntimeSession } from "../../src/session/current-session.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { runWithCwdOverride } from "../../src/utils/cwd.js";
import { exec } from "../../src/utils/Shell.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import {
  beginWorkspaceToolOperation,
  endWorkspaceToolOperation,
  workspaceMutationCoordinators,
} from "../../src/workspace/mutation-coordinator.js";
import {
  createWorkspaceOperationLifetime,
  runWithWorkspaceOperationLifetime,
} from "../../src/workspace/tool-operation-lifetime.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

afterEach(() => {
  workspaceMutationCoordinators.clearForTests();
});

describe("Shell workspace-operation lifetime", () => {
  it("contains detached descendants before releasing the Editor fence", async () => {
    if (process.platform === "win32") return;
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "agenc-shell-editor-descendant-"),
    );
    const path = join(workspaceRoot, "loaded.ts");
    const launcherPath = join(workspaceRoot, "launcher.cjs");
    await writeFile(path, "before\n", "utf8");
    await writeFile(
      launcherPath,
      [
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e',",
        JSON.stringify(
          "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'after\\n'),700);",
        ),
        ",process.argv[2]],{detached:true,stdio:'ignore'});",
        "child.unref();",
      ].join(""),
      "utf8",
    );
    const configStore = new ConfigStore({
      home: join(workspaceRoot, ".agenc-test-home"),
      env: {},
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      projectTrusted: false,
    });
    const runtimeSession = {
      conversationId: "00000000-0000-4000-8000-000000000224",
      services: {
        configStore,
        runtimeOptions: resolveAgentRuntimeOptions({}),
        userShell: {
          path: "/bin/bash",
          commandWrapperArgv: [],
          childEnvironment: { ...process.env },
          deriveExecArgs: (input: string) => ["-c", input],
        },
      },
    } as unknown as Session;
    await runWithCanonicalSettingsAuthority(
      configStore,
      () =>
        runWithCurrentRuntimeSession(runtimeSession, async () => {
          const operation = beginWorkspaceToolOperation(
            workspaceRoot,
            "generic-shell",
          );
          const lifetime = createWorkspaceOperationLifetime(() => {
            endWorkspaceToolOperation(operation);
          });
          const shellCommand = await runWithWorkspaceOperationLifetime(
            lifetime,
            () =>
              runWithCwdOverride(workspaceRoot, () =>
                exec(
                  `${JSON.stringify(process.execPath)} ${JSON.stringify(launcherPath)} ${JSON.stringify(path)}`,
                  new AbortController().signal,
                  "bash",
                  {
                    preventCwdChanges: true,
                    sandboxExecutionBroker: explicitDangerBroker,
                    sandboxExecutionSurface: "tool",
                  },
                ),
              ),
          );
          await shellCommand.result;
          await lifetime.release();
          await lifetime.settled();

          expect(() =>
            workspaceMutationCoordinators.acquireEditor(workspaceRoot, {
              workspaceRoot,
              editorInstanceId: "editor-after-generic-shell",
            }),
          ).not.toThrow();
          await delay(900);
          expect(await readFile(path, "utf8")).toBe("before\n");
          shellCommand.cleanup();
        }),
    );
  });
});
