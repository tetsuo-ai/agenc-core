/**
 * Yolo + Glob tool round-trip.
 *
 * Asks the model to glob a file created inside the scenario workspace and
 * verifies the completed rollout contains the filename. This keeps the
 * scenario inside the tool allowlist instead of relying on repo paths
 * outside the spawned cwd.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const meta = {
  description: "--yolo: model uses Glob, matched filename is recorded.",
  args: ["--yolo"],
  timeoutMs: 90_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const fileName = `agenc-e2e-glob-${Date.now()}.ts`;
  await writeFile(path.join(session.cwd, fileName), "export const marker = true;\n", "utf8");
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Glob tool to list files in ${session.cwd} matching the pattern 'agenc-e2e-glob-*.ts'.`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(fileName, {
    label: "Glob output",
    toolName: "Glob",
  });
}
