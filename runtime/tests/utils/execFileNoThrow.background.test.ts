import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { execFileNoThrowWithCwd } from "../../src/utils/execFileNoThrow.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const alive = (pid: number) => {
  if (process.platform === "linux") {
    try { if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ")) return false; } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test.skipIf(process.platform === "win32")("background execution ignores stdin and owns a separate process group", async () => {
  const script = "const fs=require('fs');const cp=require('child_process');console.log(JSON.stringify({pid:process.pid,group:cp.execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim(),stdinIsPipe:fs.fstatSync(0).isFIFO()}));";
  const result = await execFileNoThrowWithCwd(process.execPath, ["-e", script], { background: true });
  expect(result.code).toBe(0);
  const observed = JSON.parse(result.stdout);
  expect(observed.group).toBe(String(observed.pid));
  expect(observed.stdinIsPipe).toBe(false);
});

test.skipIf(process.platform === "win32")("background abort waits for a TERM-resistant parent and descendant to stop", async () => {
  const root = mkdtempSync(join(canonicalTmpdir(), "agenc-background-abort-")); roots.push(root);
  const pidFile = join(root, "pids.json");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const script = `const cp=require('child_process');const fs=require('fs');process.on('SIGTERM',()=>{});const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const running = execFileNoThrowWithCwd(process.execPath, ["-e", script], { background: true, abortSignal: controller.signal, timeout: 4000 });
  let pids: number[] = [];
  try {
    for (let attempt = 0; attempt < 100 && pids.length === 0; attempt++) {
      try { pids = JSON.parse(readFileSync(pidFile, "utf8")); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(pids).toHaveLength(2);
    controller.abort();
    const result = await running;
    expect(result.code).not.toBe(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}, 10_000);
