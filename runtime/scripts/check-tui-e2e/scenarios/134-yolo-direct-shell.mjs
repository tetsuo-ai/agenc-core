import { join } from "node:path";

import { waitForExactFileText } from "../helpers/workbench-buffer-neovim.mjs";

const markerFileName = "agenc-e2e-direct-shell-134.txt";
const markerText = "agenc-e2e-direct-shell-marker-134";
const secondMarkerFileName = "agenc-e2e-direct-shell-134-second.txt";
const secondMarkerText = "agenc-e2e-direct-shell-marker-134-second";
const admissionOrSessionErrors = [
  /tool_admission_session_unavailable/iu,
  /No active runtime session for/iu,
  /Ambiguous runtime session:/iu,
  /TUI has no canonical execution session/iu,
  /EDITOR_LEASE_CONFLICT/iu,
  /protected Editor authority/iu,
];

export const meta = {
  description:
    "YOLO direct composer shell commands execute in the scenario workspace with session-bound admission.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  slimCwd: true,
  timeoutMs: 45_000,
};

export default async function (session) {
  const markerPath = join(session.cwd, markerFileName);
  const secondMarkerPath = join(session.cwd, secondMarkerFileName);
  const command = `!node -e "require('node:fs').writeFileSync('${markerFileName}', '${markerText}')"`;
  const secondCommand = `!node -e "require('node:fs').writeFileSync('${secondMarkerFileName}', '${secondMarkerText}')"`;

  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(command, { perCharMs: 10 });
  await session.submit();

  await waitForExactFileText(
    markerPath,
    markerText,
    15_000,
    "direct composer shell marker",
  );
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });
  await session.type(secondCommand, { perCharMs: 10 });
  await session.submit();
  await waitForExactFileText(
    secondMarkerPath,
    secondMarkerText,
    15_000,
    "second direct composer shell marker",
  );
  await session.waitForIdle({ idleWindow: 500, timeout: 10_000 });

  const evidence = `${session.text}\n${JSON.stringify(
    await session.readRolloutItems(),
  )}`;
  for (const pattern of admissionOrSessionErrors) {
    const match = pattern.exec(evidence);
    if (match !== null) {
      throw new Error(
        `direct composer shell reported an admission or session error: ${match[0]}`,
      );
    }
  }
}
