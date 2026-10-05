import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { prepareDirectBwrapPlan } from "../../../src/sandbox/linux-launcher/direct-bwrap.js";
import { spawnContainedProcess, terminateProcessTreeAndReport, waitForContainedProcessSettlement } from "../../../src/utils/supervisedProcess.js";

const runtime = fileURLToPath(new URL("../../../", import.meta.url));
const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
let root: string, cwd: string, temp: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-direct-kernel-"));
  cwd = path.join(root, "work"); temp = path.join(root, "temp");
  fs.mkdirSync(cwd); fs.mkdirSync(temp);
  for (const name of [".git", ".agenc", ".agents"]) fs.mkdirSync(path.join(cwd, name));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function run(command: string, direct: boolean, options: { network?: string; abort?: boolean; revokeAfterSpawn?: boolean } = {}) {
  const profile = { fileSystem: { kind: "restricted", includePlatformDefaults: true, entries: [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: cwd }, access: "write" },
  ] }, network: options.network ?? "disabled" };
  const args = [path.join(runtime, "bin/agenc-linux-sandbox"), "--sandbox-policy-cwd", cwd,
    "--command-cwd", cwd, "--session-temp-root", temp, "--permission-profile", JSON.stringify(profile),
    "--", "/bin/bash", "-c", command];
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, NODE_ENV: "production" };
  const controller = new AbortController();
  let admissions = 0;
  const child = spawnContainedProcess(process.execPath, args, { cwd, env, linuxContainment: "subreaper",
    ...(direct ? { directBwrap: {
      prepare() {
        const plan = prepareDirectBwrapPlan({ program: process.execPath, args, cwd, env });
        expect(plan, "kernel fixture must exercise the guarded direct path").toBeDefined();
        return plan;
      },
      validateAdmission() {
        admissions++;
        if (options.revokeAfterSpawn && admissions === 2) throw new Error("fixture authority revoked");
      }, signal: controller.signal,
    } } : {}),
  });
  expect(child.spawnargs.slice(1)).toEqual(direct ? ["--bootstrap-v2"] : []);
  let stdout = "", stderr = "", proof = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  child.stdio[3]!.on("data", data => { proof += data; });
  child.stdin.end();
  if (options.abort) controller.abort();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve); child.once("error", reject);
    });
    await waitForContainedProcessSettlement(child);
    let cleanup: Awaited<ReturnType<typeof terminateProcessTreeAndReport>> | undefined;
    let cleanupError: unknown;
    try { cleanup = await terminateProcessTreeAndReport(child); } catch (error) { cleanupError = error; }
    return { code, stdout, stderr, proof, cleanup, cleanupError };
  } finally { clearTimeout(watchdog); }
}

test.each([false, true])("keeps filesystem confinement and closes every transport descriptor (direct=%s)", async direct => {
  const outside = path.join(root, "outside"); fs.writeFileSync(outside, "retained");
  const code = `import os,json
denied=[]
for p in ${JSON.stringify([outside, path.join(cwd, ".git/new"), path.join(cwd, ".agenc/new"), path.join(cwd, ".agents/new")])}:
 try:
  with open(p,'w') as f: f.write('BAD')
 except PermissionError: denied.append(p)
 except OSError as e:
  if e.errno==30: denied.append(p)
  else: raise
fds=[]
for fd in range(3,32):
 try: os.fstat(fd);fds.append(fd)
 except OSError: pass
with open('allowed','w') as f:f.write('once')
print(json.dumps({'denied':len(denied),'fds':fds,'env':os.environ.get('NODE_ENV')}))`;
  const result = await run("python3 -c " + quote(code), direct);
  expect(result.code, result.stderr).toBe(0);
  expect(result.cleanupError).toBeUndefined(); expect(result.proof).toBe("SC");
  expect(JSON.parse(result.stdout)).toEqual({ denied: 4, fds: [], env: "production" });
  expect(fs.readFileSync(outside, "utf8")).toBe("retained");
  expect(fs.readFileSync(path.join(cwd, "allowed"), "utf8")).toBe("once");
});

test.each(["disabled", "enabled"])("keeps socket policy equivalent to the launcher (%s)", async network => {
  const code = "import socket\ntry:\n s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.close();print('allowed')\nexcept PermissionError: print('blocked')";
  const command = "python3 -c " + quote(code);
  const original = await run(command, false, { network });
  const candidate = await run(command, true, { network });
  for (const result of [original, candidate]) {
    expect(result.code, result.stderr).toBe(0); expect(result.cleanupError).toBeUndefined();
    expect(result.proof).toBe("SC");
    expect(result.stdout.trim()).toBe(network === "disabled" ? "blocked" : "allowed");
  }
});

test("preserves descendant cleanup proof and never replays a failed effect", async () => {
  const result = await run("printf X >> effects; (trap '' TERM; sleep 0.2; printf BAD >> leaked; sleep 60) >/dev/null 2>&1 & exit 7", true);
  expect(result.code, result.stderr).toBe(7); expect(result.cleanupError).toBeUndefined();
  expect(result.proof).toMatch(/^SR?C$/);
  expect(fs.readFileSync(path.join(cwd, "effects"), "utf8")).toBe("X");
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(fs.existsSync(path.join(cwd, "leaked"))).toBe(false);
});

test("withholds a revoked launch and retains the missing-proof failure", async () => {
  const result = await run("printf X >> effects", true, { revokeAfterSpawn: true });
  expect(fs.existsSync(path.join(cwd, "effects"))).toBe(false);
  expect(result.proof).toBe(""); expect(result.cleanupError).toBeInstanceOf(Error);
});

test("settles an immediately aborted committed launch without replay", async () => {
  const result = await run("printf X >> effects; sleep 60", true, { abort: true });
  const file = path.join(cwd, "effects");
  expect(fs.existsSync(file) ? fs.readFileSync(file).length : 0).toBeLessThanOrEqual(1);
  // A command may start after handoff. Cancellation is not a no-effect proof.
  expect(result.code).not.toBe(0);
  if (result.cleanupError === undefined) expect(result.proof).toMatch(/^SR?C$/);
});
