import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  createTuiGateProject,
  teardownTuiGateState,
  writeTuiGateTrust,
} from "../scripts/tui-gate-state.mjs";
import {
  activeOneShotCount,
  createPipelineGateLifecycle,
  createPipelineGateState,
  resolvePipelineGateOutcome,
  runOwnedOneShotProcess,
  terminateActiveOneShots,
} from "../scripts/check-llm-pipeline/runner.mjs";

const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runnerPath = path.join(
  runtimeRoot,
  "scripts",
  "check-llm-pipeline",
  "runner.mjs",
);

describe("LLM pipeline gate state", () => {
  test("runner uses the shared owned-state and trust lifecycle", () => {
    const source = readFileSync(runnerPath, "utf8");

    for (const sharedAuthority of [
      "createTuiGateProject",
      "createTuiGateState",
      "startTuiGateDaemon",
      "teardownTuiGateState",
      "writeTuiGateTrust",
    ]) {
      expect(source).toContain(sharedAuthority);
    }
    expect(source).not.toContain("ensureProjectTrusted");
    expect(source).not.toContain("let trustFile");
    expect(source).not.toContain("mkdtemp(");

    const stateStart = source.indexOf(
      "gateStatePromise = createPipelineGateState",
    );
    const handlerInstall = source.indexOf(
      "installTuiGateSignalHandlers(cleanup)",
      stateStart,
    );
    const stateReady = source.indexOf(
      "gateState = await gateStatePromise",
      handlerInstall,
    );
    const projectCreate = source.indexOf(
      "pipelineCwd = createTuiGateProject(gateState)",
      stateReady,
    );
    const trustWrite = source.indexOf(
      "await writeTuiGateTrust(runnerEnv, [pipelineCwd])",
      projectCreate,
    );
    const daemonStart = source.indexOf(
      "await startTuiGateDaemon(gateState, BIN_AGENC)",
      trustWrite,
    );
    const scenariosStart = source.indexOf(
      "code = await runPipelineScenarios(mockServer)",
      daemonStart,
    );
    const orderedLifecycle = [
      stateStart,
      handlerInstall,
      stateReady,
      projectCreate,
      trustWrite,
      daemonStart,
      scenariosStart,
    ];
    expect(stateStart).toBeGreaterThan(-1);
    for (let index = 1; index < orderedLifecycle.length; index += 1) {
      expect(orderedLifecycle[index]).toBeGreaterThan(
        orderedLifecycle[index - 1],
      );
    }
    expect(source).toContain("runnerEnv = gateState.env");
  });

  test.skipIf(process.platform === "win32")(
    "shared state stays private under a permissive umask and leaves operator state untouched",
    async () => {
      const operatorRoot = mkdtempSync(
        path.join(tmpdir(), "agenc-llm-pipeline-operator-"),
      );
      const operatorMarker = path.join(operatorRoot, "marker");
      writeFileSync(operatorMarker, "operator-state\n", { mode: 0o600 });
      const originalUmask = process.umask(0o000);
      let gateState;
      let privateRoot;

      try {
        const baseUrl = "http://127.0.0.1:43210";
        gateState = await createPipelineGateState(baseUrl, {
          ...process.env,
          AGENC_HOME: path.join(operatorRoot, ".agenc"),
          HOME: operatorRoot,
          OPENAI_API_KEY: "operator-openai-secret",
          XAI_API_KEY: "operator-xai-secret",
        });
        privateRoot = gateState.root;
        const project = createTuiGateProject(gateState);
        const trustPath = await writeTuiGateTrust(gateState.env, [project]);

        expect(statSync(gateState.agencHome).mode & 0o777).toBe(0o700);
        expect(statSync(trustPath).mode & 0o777).toBe(0o600);
        expect(gateState.env.HOME).not.toBe(operatorRoot);
        expect(gateState.env.AGENC_HOME).not.toBe(
          path.join(operatorRoot, ".agenc"),
        );
        expect(gateState.env.XAI_API_KEY).toBeUndefined();
        expect(gateState.env.OPENAI_API_KEY).toBeUndefined();
        expect(gateState.env.AGENC_PROVIDER).toBe("openai-compatible");
        expect(gateState.env.AGENC_MODEL).toBe("local-pipeline-model");
        expect(gateState.env.OPENAI_COMPATIBLE_BASE_URL).toBe(`${baseUrl}/v1`);
        expect(gateState.env.OPENAI_COMPATIBLE_API_KEY).toBe(
          "local-pipeline-key",
        );
        expect(readdirSync(operatorRoot)).toEqual(["marker"]);
        expect(readFileSync(operatorMarker, "utf8")).toBe("operator-state\n");
      } finally {
        process.umask(originalUmask);
        if (gateState !== undefined) {
          await teardownTuiGateState(gateState, runnerPath);
        }
        rmSync(operatorRoot, { recursive: true, force: true });
      }

      expect(privateRoot).toBeDefined();
      expect(existsSync(privateRoot!)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "timed-out one-shots are force-settled before rejection",
    async () => {
      const fixtureRoot = mkdtempSync(
        path.join(tmpdir(), "agenc-llm-pipeline-child-"),
      );
      const pidPath = path.join(fixtureRoot, "pid");
      let childPid;
      try {
        const source = [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join("\n");
        await expect(runOwnedOneShotProcess({
          executable: process.execPath,
          args: ["--input-type=module", "-e", source],
          cwd: fixtureRoot,
          env: process.env,
          timeoutMs: 500,
          termGraceMs: 50,
          killGraceMs: 1_000,
          label: "ignoring fixture",
        })).rejects.toThrow("ignoring fixture exceeded 500ms");

        childPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        let livenessError;
        try {
          process.kill(childPid!, 0);
        } catch (error) {
          livenessError = error;
        }
        expect((livenessError as NodeJS.ErrnoException | undefined)?.code).toBe(
          "ESRCH",
        );
        expect(activeOneShotCount()).toBe(0);
      } finally {
        await terminateActiveOneShots({
          termGraceMs: 50,
          killGraceMs: 1_000,
        }).catch(() => {});
        if (Number.isSafeInteger(childPid) && childPid! > 0) {
          try {
            process.kill(childPid!, "SIGKILL");
          } catch {
            // The expected path already proved the retained child exited.
          }
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "cleanup closes the active child and refuses a racing spawn",
    async () => {
      const fixtureRoot = mkdtempSync(
        path.join(tmpdir(), "agenc-llm-pipeline-race-"),
      );
      const firstPidPath = path.join(fixtureRoot, "first-pid");
      const secondPidPath = path.join(fixtureRoot, "second-pid");
      const lifecycle = createPipelineGateLifecycle();
      let firstPid;
      try {
        const childSource = (pidPath: string) => [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join("\n");
        const firstRun = runOwnedOneShotProcess({
          executable: process.execPath,
          args: ["--input-type=module", "-e", childSource(firstPidPath)],
          cwd: fixtureRoot,
          env: process.env,
          timeoutMs: 10_000,
          termGraceMs: 50,
          killGraceMs: 1_000,
          label: "first fixture",
          lifecycle,
        });
        for (let attempt = 0; attempt < 100 && !existsSync(firstPidPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        firstPid = Number.parseInt(readFileSync(firstPidPath, "utf8"), 10);

        lifecycle.beginCleanup();
        const cleanup = terminateActiveOneShots({
          termGraceMs: 50,
          killGraceMs: 1_000,
        });
        await expect(runOwnedOneShotProcess({
          executable: process.execPath,
          args: ["--input-type=module", "-e", childSource(secondPidPath)],
          cwd: fixtureRoot,
          env: process.env,
          timeoutMs: 10_000,
          label: "second fixture",
          lifecycle,
        })).rejects.toThrow("LLM pipeline gate is shutting down");
        await cleanup;
        await firstRun;

        expect(existsSync(secondPidPath)).toBe(false);
        expect(activeOneShotCount()).toBe(0);
        let livenessError;
        try {
          process.kill(firstPid!, 0);
        } catch (error) {
          livenessError = error;
        }
        expect((livenessError as NodeJS.ErrnoException | undefined)?.code).toBe(
          "ESRCH",
        );
      } finally {
        await terminateActiveOneShots({
          termGraceMs: 50,
          killGraceMs: 1_000,
        }).catch(() => {});
        if (Number.isSafeInteger(firstPid) && firstPid! > 0) {
          try {
            process.kill(firstPid!, "SIGKILL");
          } catch {
            // The expected path already proved the retained child exited.
          }
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  test("run and cleanup failures remain independently visible", () => {
    const runError = new Error("run failed");
    const cleanupError = new Error("cleanup failed");

    try {
      resolvePipelineGateOutcome(2, runError, cleanupError);
      throw new Error("expected combined failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        runError,
        cleanupError,
      ]);
    }
  });
});
