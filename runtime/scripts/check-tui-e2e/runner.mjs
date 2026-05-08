/**
 * AgenC TUI E2E gate runner.
 *
 * Discovers scenarios under `./scenarios`, runs each in turn, captures
 * failures, dumps full PTY output to `/tmp/tui-e2e-failure-<scenario>.log`
 * on failure, and exits non-zero if any scenario failed.
 *
 * Scenarios run serially. They share the user's daemon and HOME, so
 * parallelism would cause cross-contamination. Phase B will introduce
 * temp-HOME isolation and enable parallel execution.
 */
import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TuiSession } from "./harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(SCRIPT_DIR, "scenarios");
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Restart the user's daemon so each gate run starts from a clean session
 * registry, fresh permission policy cache, no accumulated state from
 * earlier runs. Without this, scenarios near the end of a multi-scenario
 * run start failing with `Timed out waiting for daemon response` because
 * the daemon's session/permission state has drifted.
 */
function restartDaemon() {
  const result = spawnSync(
    process.execPath,
    [BIN_AGENC, "daemon", "restart"],
    { encoding: "utf8", timeout: 30_000 },
  );
  return result.status === 0;
}

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function color(c, s) {
  return process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s;
}

async function discoverScenarios() {
  const entries = await readdir(SCENARIOS_DIR);
  return entries
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

async function loadScenario(name) {
  const fileUrl = pathToFileURL(path.join(SCENARIOS_DIR, name)).href;
  const mod = await import(fileUrl);
  if (typeof mod.default !== "function") {
    throw new Error(`scenario ${name} must export a default async function`);
  }
  return {
    name,
    meta: mod.meta ?? {},
    run: mod.default,
  };
}

async function runScenario(scenario) {
  const startedAt = Date.now();
  const session = new TuiSession({
    args: scenario.meta.args ?? [],
    useTempHome: scenario.meta.useTempHome === true,
    ...(scenario.meta.cwd ? { cwd: scenario.meta.cwd } : {}),
  });
  const debug = process.env.TUI_E2E_DEBUG === "1";
  const timeoutMs = scenario.meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`scenario timeout after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([scenario.run(session), timeoutPromise]);
    session.assertNoCrash();
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      capturedOutput: debug ? session.raw : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error,
      capturedOutput: session.raw,
    };
  } finally {
    clearTimeout(timer);
    try {
      await session.exitGracefully({ timeout: 2_000 });
    } catch {
      session.kill();
    }
    try {
      await session.cleanup();
    } catch {
      // best-effort
    }
  }
}

async function dumpFailureLog(scenario, result) {
  const logPath = `/tmp/tui-e2e-failure-${scenario.name.replace(/\.mjs$/, "")}.log`;
  const header = [
    `# TUI E2E failure: ${scenario.name}`,
    `# Description: ${scenario.meta.description ?? "(none)"}`,
    `# Duration: ${result.durationMs}ms`,
    `# Error: ${result.error?.message ?? String(result.error)}`,
    "",
    "## Captured PTY output (raw)",
    "",
  ].join("\n");
  await writeFile(logPath, header + (result.capturedOutput ?? ""), "utf8");
  return logPath;
}

async function main() {
  const names = await discoverScenarios();
  if (names.length === 0) {
    console.log(color("yellow", "no scenarios found under scenarios/"));
    return 0;
  }
  console.log(
    color("bold", `agenc TUI e2e gate (${names.length} scenarios)`),
  );
  process.stdout.write(color("dim", "  restarting daemon for clean baseline ... "));
  const restarted = restartDaemon();
  console.log(color("dim", restarted ? "ok" : "skipped"));
  console.log("");

  const failed = [];
  const skipped = [];
  let passed = 0;
  for (const name of names) {
    const scenario = await loadScenario(name);
    process.stdout.write(`  ${color("dim", "→")} ${name} … `);
    if (scenario.meta.skip) {
      console.log(
        `${color("yellow", "SKIP")} ${color("dim", `(${scenario.meta.skip})`)}`,
      );
      skipped.push({ name, reason: scenario.meta.skip });
      continue;
    }
    const result = await runScenario(scenario);
    if (result.ok) {
      passed += 1;
      console.log(
        `${color("green", "PASS")} ${color("dim", `(${result.durationMs}ms)`)}`,
      );
      if (process.env.TUI_E2E_DEBUG === "1" && result.capturedOutput) {
        const logPath = `/tmp/tui-e2e-pass-${name.replace(/\.mjs$/, "")}.log`;
        await writeFile(logPath, result.capturedOutput, "utf8");
        console.log(`      ${color("dim", `debug log: ${logPath}`)}`);
      }
    } else {
      const logPath = await dumpFailureLog(scenario, result);
      console.log(
        `${color("red", "FAIL")} ${color("dim", `(${result.durationMs}ms)`)}`,
      );
      console.log(
        `      ${color("red", "✗")} ${result.error?.message ?? String(result.error)}`,
      );
      console.log(`      ${color("dim", `log: ${logPath}`)}`);
      failed.push({ name, error: result.error, logPath });
    }
  }

  console.log("");
  const totalRan = passed + failed.length;
  const skipNote = skipped.length > 0 ? `, ${skipped.length} skipped` : "";
  if (failed.length === 0) {
    console.log(
      color("green", `✓ ${passed}/${totalRan} passed${skipNote}`),
    );
    if (skipped.length > 0) {
      for (const s of skipped) {
        console.log(`    ${color("yellow", "skip")} ${s.name}: ${s.reason}`);
      }
    }
    return 0;
  }
  console.log(
    color(
      "red",
      `✗ ${failed.length}/${totalRan} failed (${passed} passed${skipNote})`,
    ),
  );
  for (const f of failed) {
    console.log(`    - ${f.name}: ${f.error?.message ?? String(f.error)}`);
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(color("red", `runner crashed: ${error?.stack ?? error}`));
    process.exit(2);
  });
