import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { formatUnifiedExecToolContent } from "../../src/tools/system/exec-result-format.js";

let root: string;
let manager: UnifiedExecProcessManager;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-retained-test-"));
  manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root });
});
afterEach(async () => { await manager.closeAll("fixture complete"); await rm(root, { recursive: true, force: true }); });

test("an excerpt retains retrievable private output without rerunning the command", async () => {
  const output = await manager.execCommand({ cmd: "printf 'start\\n'; seq 1 3000; printf 'end\\n'", max_output_tokens: 100, retainOutput: true });
  expect(output.exitCode).toBe(0);
  expect(output.truncated).toBe(true);
  expect(output.output.length).toBeLessThan(1000);
  const path = output.retained_output_path!;
  expect(path.startsWith(root + "/")).toBe(true);
  const saved = await readFile(path, "utf8");
  expect(saved).toContain("\n1500\n");
  expect(saved).toContain("end\n");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(formatUnifiedExecToolContent(output)).toContain(path);
});

test("process exit wakes a long wait, while cancellation still stops a live process", async () => {
  const start = Date.now();
  const done = await manager.execCommand({ cmd: "printf done", yield_time_ms: 30000, retainOutput: true });
  expect(done.exitCode).toBe(0);
  expect(done.retained_output_path).toBeUndefined();
  expect(Date.now() - start).toBeLessThan(5000);
  const controller = new AbortController();
  const running = manager.execCommand({ cmd: "sleep 20", yield_time_ms: 30000, __abortSignal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  const stopped = await running;
  clearTimeout(timer);
  expect(stopped.process_id).toBeUndefined();
  expect(stopped.exitCode).not.toBe(0);
});
