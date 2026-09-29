import { join as outputPath } from "node:path";
import { writeFile, mkdtemp } from "node:fs/promises";

/** Save the collected buffer, which may already include upstream omission markers. */
export async function retainCollectedOutput(root: string, stdout: string, stderr: string): Promise<string> {
  const directory = await mkdtemp(outputPath(root, "agenc-output-"));
  const path = outputPath(directory, "collected.txt");
  await writeFile(path, stdout + (stderr ? "\n[stderr]\n" + stderr : ""), { flag: "wx", mode: 0o600 });
  return path;
}
