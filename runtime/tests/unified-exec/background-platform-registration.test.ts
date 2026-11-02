import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { expect, test } from "vitest";

// Collect the real test modules without running their process fixtures. This
// checks unsupported-platform discovery on every CI host, including Linux.
const collector = `
import vm from 'node:vm';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { source, platform } = JSON.parse(input);
const registered = [];
const context = vm.createContext({ process: { platform } });
const stub = new vm.SyntheticModule(
  ['describe', 'it', 'expect', 'afterEach', 'vi', 'setTimeout',
   'UnifiedExecProcessManager', 'managerPool', 'startBackgroundSession',
   'waitForSessionExit', 'formatSessionEndNotice'],
  function () {
    this.setExport('describe', (_name, body) => body());
    this.setExport('it', name => registered.push(name));
    this.setExport('expect', () => { throw new Error('test body ran during collection'); });
    this.setExport('afterEach', () => {});
    this.setExport('vi', { hoisted: fn => fn(), mock: () => {} });
    this.setExport('setTimeout', async () => {});
    this.setExport('UnifiedExecProcessManager', class {});
    this.setExport('managerPool', () => ({ create() {}, async closeAll() {} }));
    for (const name of ['startBackgroundSession', 'waitForSessionExit', 'formatSessionEndNotice'])
      this.setExport(name, () => {});
  }, { context });
await stub.link(() => { throw new Error('unexpected stub import'); });
await stub.evaluate();
const mod = new vm.SourceTextModule(source, {
  context,
  importModuleDynamically: async () => stub,
});
await mod.link(async () => stub);
await mod.evaluate();
process.stdout.write(JSON.stringify(registered));
`;

test.each(["linux", "darwin", "win32"])("background process fixtures register only on supported hosts (%s)", (platform) => {
  for (const [file, count] of [
    ["quiet-poll-process-state.test.ts", 3],
    ["session-end-oom.test.ts", 2],
  ] as const) {
    const source = transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText;
    const output = execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", collector], {
      input: JSON.stringify({ source, platform }), encoding: "utf8", timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(JSON.parse(output), file).toHaveLength(platform === "win32" ? 0 : count);
  }
});
