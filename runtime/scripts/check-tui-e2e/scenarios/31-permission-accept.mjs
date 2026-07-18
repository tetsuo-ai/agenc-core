/**
 * Permission overlay accept scenario.
 *
 * Default mode (no --yolo). Submits a prompt that triggers Bash, accepts the
 * approval, then verifies the command actually ran by checking the rollout's
 * completed Bash stdout marker. This keeps the scenario scoped to tool
 * approval rather than sandbox file-write policy or assistant echo behavior.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-permission-"));
writeFileSync(path.join(slimCwd, "README.md"), "permission accept cwd\n", "utf8");
writeFileSync(path.join(slimCwd, "package.json"), '{"private":true}\n', "utf8");

const marker = "agenc-permission-accept-marker-3a9c";
const prompt = [
  "Use the Bash tool to run exactly:",
  `printf '%s\\n' ${shellQuote(marker)}`,
].join(" ");

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const meta = {
  description: "Permission overlay (default mode): accept path runs the tool.",
  timeoutMs: 120_000,
  useTempHome: true,
  sandboxMode: "danger-full-access",
  args: ["--permission-mode", "default"],
  cwd: slimCwd,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(prompt);
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.acceptPermissionOverlay();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(marker, { label: "approved Bash output" });
}
