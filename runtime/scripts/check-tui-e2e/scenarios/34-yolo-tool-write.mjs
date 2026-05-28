/**
 * Yolo + Write tool round-trip.
 *
 * Asks the model to write a unique marker into a workspace-local file,
 * then reads the file back from disk to confirm Write ran.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const meta = {
  description: "--yolo: model uses Write, file content verifiable on disk.",
  args: ["--yolo"],
  timeoutMs: 90_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const marker = `agenc-write-marker-${Date.now()}`;
  const targetFile = path.join(session.cwd, "write-target.txt");
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Write tool to write the exact text "${marker}" to the file ${targetFile}`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolCompleted({
    label: "Write completion",
    toolName: "Write",
  });
  const content = await readFile(targetFile, "utf8");
  if (!content.includes(marker)) {
    throw new Error(
      `Write produced wrong content. expected to contain "${marker}", got: "${content.slice(0, 200)}"`,
    );
  }
}
