import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const guardPath = fileURLToPath(new URL("fixtures/startup-side-effect-guard.mjs", import.meta.url));
const capturePath = fileURLToPath(new URL("fixtures/startup-capture-runtime.mjs", import.meta.url));
const unknownOptions = ["--max-budget-usd", "--max-budget-usd=2", "--sandbox", "--fork", "-unknown", "--print=yes"];
const invalidInvocations = [
  ...unknownOptions.map((option) => ({
    argv: ["-p", option, "2", "not submitted"],
    message: `agenc: unknown option '${option}'. Use '--' before literal prompt text that starts with '-'.`,
  })),
  { argv: ["--model"], message: "agenc --model requires a value (usage: agenc --model <id|provider:id>)" },
  { argv: ["--resume="], message: "agenc --resume requires a session id (usage: agenc --resume <session-id>)" },
  { argv: ["--yolo"], message: "agenc: unknown option '--yolo'. Use '--dangerously-bypass-approvals-and-sandbox' instead." },
  { argv: ["--proactive"], message: "agenc: unknown option '--proactive'. Use '--autonomous' instead." },
];

for (const installed of [false, true]) {
  test(`invalid public startup has no effects (${installed ? "package only" : "linked runtime"})`, () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-preflight-"));
    try {
      const home = join(root, "home");
      const agencHome = join(root, "agenc-home");
      const workspace = join(root, "workspace");
      for (const directory of [home, agencHome, workspace]) mkdirSync(directory, { mode: 0o700 });
      let launcherRoot = packageRoot;
      if (installed) {
        launcherRoot = join(root, "launcher");
        mkdirSync(launcherRoot);
        for (const entry of ["bin", "src", "lib", "generated", "package.json"]) {
          cpSync(resolve(packageRoot, entry), join(launcherRoot, entry), { recursive: true });
        }
      }
      for (const invocation of invalidInvocations) {
        const result = spawnSync(process.execPath, ["--import", guardPath, join(launcherRoot, "bin", "agenc"), ...invocation.argv], {
          cwd: workspace,
          env: {
            HOME: home,
            USERPROFILE: home,
            AGENC_HOME: agencHome,
            PATH: dirname(process.execPath),
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(result.error, undefined);
        const ledger = result.stderr.match(/\nAGENC_STARTUP_EFFECTS=([^\n]+)\n/u);
        assert.ok(ledger, result.stderr);
        assert.deepEqual(JSON.parse(ledger[1]), [], result.stderr);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.slice(0, ledger.index).trim(), invocation.message);
        for (const directory of [home, agencHome, workspace]) assert.deepEqual(readdirSync(directory), []);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("public startup preserves command aliases, options, and literal prompt boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-preflight-pass-"));
  try {
    const home = join(root, "home");
    const agencHome = join(root, "agenc-home");
    const workspace = join(root, "workspace");
    for (const directory of [home, agencHome, workspace]) mkdirSync(directory, { mode: 0o700 });
    const invocations = [
      [],
      ["-p", "--", "--max-budget-usd", "2"],
      ["-p", "explain", "--max-budget-usd", "2"],
      ["-p", "-", "--fork"],
      ["--model", "grok-4.5", "--provider=grok", "--model=other", "-p", "hello"],
      ["--debug-file", "/tmp/debug.log", "--debug=permissions", "--bare", "-p", "hello"],
      ["--help", "--max-budget-usd"],
      ["--version", "--yolo"],
      ["--model", "--help"],
      ["--", "--help"],
      ["--autonomous", "--dangerously-bypass-approvals-and-sandbox", "-p", "hello"],
      ...[
        "help", "init", "daemon", "remote", "agent", "login", "logout", "whoami",
        "openai-login", "openai-logout", "openai-auth-status", "chatgpt-login",
        "chatgpt-logout", "chatgpt-auth-status", "grok-login", "grok-logout",
        "grok-auth-status", "xai-login", "xai-logout", "xai-auth-status",
        "openai-models", "kimi-models", "mcp", "doctor", "onboard", "security",
        "update", "gateway", "budget", "run", "providers", "config", "plugin",
        "plugins", "skills", "permissions", "state", "trajectories",
      ].map((command) => [command, "--command-owned-option"]),
    ];
    for (const argv of invocations) {
      const result = spawnSync(process.execPath, ["--import", capturePath, join(packageRoot, "bin", "agenc"), ...argv], {
        cwd: workspace,
        env: {
          HOME: home,
          USERPROFILE: home,
          AGENC_HOME: agencHome,
          AGENC_DAEMON_AUTOSTART: "0",
          PATH: dirname(process.execPath),
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "\nAGENC_STARTUP_EFFECTS=[]\n");
      assert.deepEqual(JSON.parse(result.stdout.trim().slice("AGENC_RUNTIME_ARGS=".length)), argv);
    }
    for (const directory of [home, agencHome, workspace]) assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
