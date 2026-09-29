import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Save the collected buffer, which may already include upstream omission markers. */
export async function retainCollectedOutput(root: string, stdout: string, stderr: string): Promise<string> {
  const directory = await mkdtemp(join(root, "agenc-output-"));
  const path = join(directory, "collected.txt");
  await writeFile(path, stdout + (stderr ? "\n[stderr]\n" + stderr : ""), { flag: "wx", mode: 0o600 });
  return path;
}
