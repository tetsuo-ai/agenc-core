/**
 * Yolo + Grep tool round-trip.
 *
 * Asks the model to grep a unique pattern from a file inside the scenario
 * workspace and verifies the completed rollout contains the matched line.
 * This avoids false positives from matching the typed prompt itself.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const meta = {
  description: "--yolo: model uses Grep, matched line is recorded.",
  args: ["--yolo"],
  timeoutMs: 90_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const marker = `AGENC_GREP_E2E_${Date.now()}`;
  const filePath = path.join(session.cwd, "grep-target.txt");
  await writeFile(filePath, `alpha\n${marker}=present\nomega\n`, "utf8");
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Grep tool with output_mode "content" to search ${filePath} for the pattern '${marker}'.`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(marker, {
    label: "Grep output",
    toolName: "Grep",
  });
}
