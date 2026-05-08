/**
 * Yolo + Write tool round-trip.
 *
 * Asks the model to write a unique marker into a /tmp file, then reads
 * the file back from disk to confirm Write ran. The file path is
 * randomized per run.
 *
 * Cleans up after itself: deletes the file even on test failure.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-write-"));
const targetFile = path.join(dir, "marker.txt");
const marker = "agenc-write-marker-" + Math.random().toString(36).slice(2, 10);

export const meta = {
  description: "--yolo: model uses Write, file content verifiable on disk.",
  args: ["--yolo"],
  timeoutMs: 240_000,
  slimCwd: true,
};

export default async function (session) {
  try {
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    await session.type(
      `Use the Write tool to write the exact text "${marker}" to the file ${targetFile}`,
    );
    await session.submit();
    await session.waitForIdle({ timeout: 200_000 });
    // Verify the file was actually written with the expected content.
    let content = "";
    try {
      content = readFileSync(targetFile, "utf8");
    } catch (error) {
      throw new Error(`Write did not produce ${targetFile}: ${error.message}`);
    }
    if (!content.includes(marker)) {
      throw new Error(
        `Write produced wrong content. expected to contain "${marker}", got: "${content.slice(0, 200)}"`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
