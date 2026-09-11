import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeUtf8(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}
