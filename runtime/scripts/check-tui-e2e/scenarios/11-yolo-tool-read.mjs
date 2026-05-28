/**
 * Yolo + Read tool round-trip.
 *
 * Asks the model to read a known small file inside the scenario workspace
 * via the Read tool and verifies the completed rollout contains a unique
 * substring of the file content. The assertion is on rollout tool output,
 * not assistant echo behavior.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const meta = {
  description: "--yolo: model uses Read on workspace file, content is recorded.",
  args: ["--yolo"],
  timeoutMs: 90_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const marker = `agenc-read-e2e-${Date.now()}`;
  const filePath = path.join(session.cwd, "read-target.txt");
  await writeFile(filePath, `Read marker: ${marker}\n`, "utf8");
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Read tool to read ${filePath} and report the file contents.`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(marker, {
    label: "Read output",
    toolName: "FileRead",
  });
}
