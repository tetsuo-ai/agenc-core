/**
 * Permission overlay accept scenario.
 *
 * Default mode (no --yolo). Submits a prompt that triggers Bash, accepts the
 * approval, then verifies the command actually ran by checking the Bash stdout
 * marker. This keeps the scenario scoped to tool approval rather than sandbox
 * file-write policy.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-permission-"));
writeFileSync(path.join(slimCwd, "README.md"), "permission accept cwd\n", "utf8");

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
  cwd: slimCwd,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(prompt);
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.acceptPermissionOverlay();
  await session.waitFor(new RegExp(marker), {
    timeout: 90_000,
    label: "approved Bash output",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
