/**
 * Permission overlay deny scenario.
 *
 * Default mode. Triggers Bash, denies the overlay, then verifies the command
 * never created its marker file in an isolated cwd.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-deny-"));
writeFileSync(path.join(slimCwd, "README.md"), "permission deny cwd\n", "utf8");
writeFileSync(path.join(slimCwd, "package.json"), '{"private":true}\n', "utf8");

const marker = "agenc-permission-deny-marker-fe17";
const markerFile = "permission-deny-output.txt";
const markerPath = path.join(slimCwd, markerFile);

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const meta = {
  description: "Permission overlay (default mode): deny path closes overlay cleanly.",
  timeoutMs: 120_000,
  useTempHome: true,
  sandboxMode: "danger-full-access",
  args: ["--permission-mode", "default"],
  cwd: slimCwd,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Bash tool to run exactly: printf '%s\\n' ${shellQuote(marker)} > ${shellQuote(markerFile)}`,
  );
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.denyPermissionOverlay();
  await session.waitForIdle({ timeout: 60_000 });
  if (existsSync(markerPath)) {
    throw new Error(`denied Bash command wrote marker file: ${markerPath}`);
  }
}
