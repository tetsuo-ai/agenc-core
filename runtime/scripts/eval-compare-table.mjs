#!/usr/bin/env node
// Print a markdown comparison of the compare-agents.sh reports in a directory.
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reports live under runtime/eval/reports/<run>/ (gitignored). The run name
// and the tag are plain tokens taken as basenames, so no argument can point
// the reader outside that directory.
const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const run = basename(process.argv[2] ?? "latest");
const rawTag = basename(process.argv[3] ?? "");
if (!TOKEN.test(run) || (rawTag !== "" && !TOKEN.test(rawTag))) {
  console.error("run and tag must be letters, digits, dots, underscores or dashes");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "eval", "reports", run);
if (!existsSync(dir)) {
  console.error(`no reports under eval/reports/${run}`);
  process.exit(2);
}
const tag = rawTag === "" ? "" : `-${rawTag}`;
const agents = ["agenc", "hermes", "opencode"];
const load = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
const seconds = (ms) => `${Math.round((ms ?? 0) / 1000)} s`;
const label = (report) => `${report.run?.agent?.name ?? "?"} ${report.run?.agent?.version ?? ""}`.trim();
const taskCell = (task) => {
  if (!task) return "-";
  const verdict = task.status === "passed" ? "ok" : "FAIL";
  return `${seconds(task.durationMs)} ${verdict}`;
};

const commands = agents.map((a) => [a, load(`${a}${tag}-commands.json`)]).filter(([, r]) => r);
if (commands.length > 0) {
  console.log("## Command tasks\n");
  console.log("| agent | passed | total wall | per task |\n| --- | --- | --- | --- |");
  for (const [, r] of commands) {
    const tasks = r.tasks.filter((t) => t.id !== "asteroid-drift-15");
    const passed = tasks.filter((t) => t.status === "passed").length;
    const durations = tasks.map((t) => t.durationMs ?? 0);
    console.log(`| ${label(r)} | ${passed} of ${tasks.length} | ${seconds(durations.reduce((a, b) => a + b, 0))} | ${seconds(Math.min(...durations))} to ${seconds(Math.max(...durations))} |`);
  }
  const ids = [...new Set(commands.flatMap(([, r]) => r.tasks.map((t) => t.id)))].filter((id) => id !== "asteroid-drift-15");
  console.log(`\n| task | ${commands.map(([, r]) => label(r)).join(" | ")} |\n| --- |${" --- |".repeat(commands.length)}`);
  for (const id of ids) {
    const cells = commands.map(([, r]) => taskCell(r.tasks.find((x) => x.id === id)));
    console.log(`| ${id} | ${cells.join(" | ")} |`);
  }
}
const sessions = agents.map((a) => [a, load(`${a}${tag}-session.json`)]).filter(([, r]) => r);
if (sessions.length > 0) {
  console.log("\n## Session task\n");
  console.log("| agent | status | wall | verifiers passed | steps recorded |\n| --- | --- | --- | --- | --- |");
  for (const [, r] of sessions) {
    const s = r.tasks.find((t) => t.id === "asteroid-drift-15");
    if (!s) continue;
    const verifiers = s.verifiers ?? [];
    const steps = s.commands ?? s.steps ?? [];
    console.log(`| ${label(r)} | ${s.status} | ${seconds(s.durationMs)} | ${verifiers.filter((v) => v.status === "passed").length} of ${verifiers.length} | ${steps.length} |`);
  }
}
