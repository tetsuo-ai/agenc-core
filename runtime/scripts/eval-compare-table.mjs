#!/usr/bin/env node
// Print a markdown comparison of the compare-agents.sh reports in a directory.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "eval/reports";
const tag = process.argv[3] ? `-${process.argv[3]}` : "";
const agents = ["agenc", "hermes", "opencode"];
const load = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
const seconds = (ms) => `${Math.round((ms ?? 0) / 1000)} s`;
const label = (report) => `${report.run?.agent?.name ?? "?"} ${report.run?.agent?.version ?? ""}`.trim();

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
    const cells = commands.map(([, r]) => { const t = r.tasks.find((x) => x.id === id); return t ? `${seconds(t.durationMs)} ${t.status === "passed" ? "ok" : "FAIL"}` : "-"; });
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
