import { COMMAND_WRAPPERS } from "../../src/utils/shell/transparent-wrappers.js";
import { describe, expect, it } from "vitest";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import { matchedDangerousShellCommandLabel } from "../../src/permissions/dangerous-patterns.js";

const examples: Record<string, string> = {
  setarch: "setarch x86_64 -R", linux32: "linux32", linux64: "linux64", eatmydata: "eatmydata", catchsegv: "catchsegv",
  nice: "nice -n 5", ionice: "ionice -c3", chrt: "chrt -f 1", taskset: "taskset -c 0",
  setsid: "setsid -f", timeout: "timeout 5", stdbuf: "stdbuf -oL", env: "env FOO=bar",
  nohup: "nohup", busybox: "busybox", toybox: "toybox", watch: "watch -n1", time: "time -p",
  xargs: "xargs -0", command: "command", exec: "exec", sudo: "sudo -u root", builtin: "builtin",
  noglob: "noglob", nocorrect: "nocorrect", "-": "-", doas: "doas -u root", chronic: "chronic", unbuffer: "unbuffer",
};
const builtins = new Set(["command", "exec", "sudo", "builtin", "noglob", "nocorrect", "-", "doas"]);
const cases = Object.entries(examples).flatMap(([name, invocation]) => builtins.has(name)
  ? [[name, invocation]] : [[name, invocation], [`g${name}`, `g${invocation}`]]);
const wrappers = cases.map(([, invocation]) => invocation!);

it("requires an executable fixture for every registered transparent wrapper and alias", () => {
  expect(cases.map(([name]) => name).sort()).toEqual([...COMMAND_WRAPPERS.keys()].sort());
});
function classify(command: string) {
  return classifyShellWorkspaceWritePolicy({ toolName: "exec_command", args: { command }, workspaceRoot: "/repo", allowWorkspaceWrites: true, allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: true });
}
describe("transparent wrapper security parity", () => {
  it.each(wrappers)("%s cannot hide protected writes", wrapper => {
    expect(classify(`${wrapper} tee ~/.bashrc`).blocked).toBe(true);
    expect(classify(`${wrapper} rm -rf .git`).blocked).toBe(true);
    expect(classify(`${wrapper} ${wrapper.includes("watch") ? `"sh -c 'tee ~/.bashrc'"` : `sh -c 'tee ~/.bashrc'`}`).blocked).toBe(true);
  });
  it.each(wrappers)("%s cannot hide the rm floor", wrapper => {
    expect(matchedDangerousShellCommandLabel(`${wrapper} rm -rf /`)).not.toBeNull();
    expect(matchedDangerousShellCommandLabel(`${wrapper} sh -c 'rm -rf /'`)).not.toBeNull();
  });
});


it.each(wrappers)("%s keeps inert text inert", wrapper => {
  expect(classify(`${wrapper} echo tee ~/.bashrc`).blocked).toBe(false);
  expect(matchedDangerousShellCommandLabel(`${wrapper} echo rm -rf /`)).toEqual(matchedDangerousShellCommandLabel(`${wrapper} echo safe`));
});


it.each([
  "ionice --class=idle -- tee ~/.bashrc", "chrt --other 0 -- tee ~/.bashrc",
  "taskset --cpu-list 0 -- tee ~/.bashrc", "busybox sh -c 'tee ~/.bashrc'",
  "watch --exec sh -c 'tee ~/.bashrc'", "watch --differences=permanent -n .5 'tee ~/.bashrc'",
  "env -S \"sh -c 'tee ~/.bashrc'\"", "env -C /repo/.git tee config", "env -- FOO=bar tee ~/.bashrc",
  "env -S \"-C /repo/.git tee config\"",
  "/usr/bin/time -o ~/.bashrc true", "exec env nohup ionice -c3 taskset -c 0 setsid tee ~/.bashrc",
])("preserves option and command-text semantics: %s", command => {
  expect(classify(command).blocked).toBe(true);
});

it.each([
  "ionice --help rm -rf /", "taskset -p 1", "chrt --max", "busybox --help rm -rf /",
  "command -v rm", "timeout --help rm -rf /", "watch --version rm -rf /",
])("does not invent an executed command for %s", command => {
  expect(classify(command).blocked).toBe(false);
  expect(matchedDangerousShellCommandLabel(command)).toBeNull();
});


it.each(["env", "genv"])("%s split-string obeys the rm floor without trailing argv", wrapper => {
  expect(matchedDangerousShellCommandLabel(`${wrapper} -S 'rm -rf /'`)).not.toBeNull();
});
