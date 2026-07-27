/**
 * Permission overlay deny scenario.
 *
 * Default mode. Triggers Bash, denies the overlay, then verifies the command
 * never created its marker file in an isolated cwd.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const marker = "agenc-permission-deny-marker-fe17";
const markerFile = "permission-deny-output.txt";

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const meta = {
  description: "Permission overlay (default mode): deny path closes overlay cleanly.",
  timeoutMs: 120_000,
  slimCwd: true,
  sandboxMode: "danger-full-access",
  args: ["--permission-mode", "default"],
};

export default async function (session) {
  const markerPath = path.join(session.cwd, markerFile);
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
