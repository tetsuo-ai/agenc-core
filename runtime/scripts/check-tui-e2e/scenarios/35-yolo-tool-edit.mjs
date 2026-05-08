/**
 * Yolo + Edit tool round-trip.
 *
 * Pre-creates a /tmp file with a known string, asks the model to Edit it
 * by replacing one substring with another, then reads the file back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-edit-"));
const targetFile = path.join(dir, "edit-target.txt");
const oldStr = "agenc-edit-old-" + Math.random().toString(36).slice(2, 10);
const newStr = "agenc-edit-new-" + Math.random().toString(36).slice(2, 10);
writeFileSync(targetFile, `start ${oldStr} end\n`, "utf8");

export const meta = {
  description: "--yolo: model uses Edit, file content updated on disk.",
  args: ["--yolo"],
  timeoutMs: 240_000,
  slimCwd: true,
};

export default async function (session) {
  try {
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    await session.type(
      `Use the Edit tool to edit ${targetFile}, replacing "${oldStr}" with "${newStr}"`,
    );
    await session.submit();
    await session.waitForIdle({ timeout: 200_000 });
    const content = readFileSync(targetFile, "utf8");
    if (content.includes(oldStr) || !content.includes(newStr)) {
      throw new Error(
        `Edit did not apply: expected "${newStr}", got: "${content.slice(0, 200)}"`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
