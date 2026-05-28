/**
 * Yolo + Edit tool round-trip.
 *
 * Pre-creates a workspace-local file with a known string, asks the model
 * to Read and then Edit it, then reads the file back.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const meta = {
  description: "--yolo: model uses Edit, file content updated on disk.",
  args: ["--yolo"],
  timeoutMs: 120_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const oldStr = `agenc-edit-old-${Date.now()}`;
  const newStr = `agenc-edit-new-${Date.now()}`;
  const targetFile = path.join(session.cwd, "edit-target.txt");
  await writeFile(targetFile, `start ${oldStr} end\n`, "utf8");
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Read tool to read ${targetFile}, then use the Edit tool to replace "${oldStr}" with "${newStr}".`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 120_000 });
  await session.assertRolloutToolCompleted({
    label: "Edit preread completion",
    toolName: "FileRead",
  });
  await session.assertRolloutToolCompleted({
    label: "Edit completion",
    toolName: "Edit",
  });
  const content = await readFile(targetFile, "utf8");
  if (content.includes(oldStr) || !content.includes(newStr)) {
    throw new Error(
      `Edit did not apply: expected "${newStr}", got: "${content.slice(0, 200)}"`,
    );
  }
}
