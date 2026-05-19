import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ONBOARDING_PASTE_STORE_DIR = "paste-cache" as const;

export interface StorePastedTextParams {
  readonly agencHome: string;
  readonly hash: string;
  readonly content: string;
}

export interface RetrievePastedTextParams {
  readonly agencHome: string;
  readonly hash: string;
}

export interface CleanupOldPastesParams {
  readonly agencHome: string;
  readonly maxAgeMs?: number;
  readonly now?: Date;
}

export function hashPastedText(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function pasteStoreDir(agencHome: string): string {
  return join(agencHome, ONBOARDING_PASTE_STORE_DIR);
}

export async function storePastedText(
  params: StorePastedTextParams,
): Promise<string> {
  const hash = sanitizePasteHash(params.hash);
  const dir = pasteStoreDir(params.agencHome);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${hash}.txt`);
  await writeFile(path, params.content, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function retrievePastedText(
  params: RetrievePastedTextParams,
): Promise<string | null> {
  try {
    return await readFile(
      join(pasteStoreDir(params.agencHome), `${sanitizePasteHash(params.hash)}.txt`),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deletePastedText(
  params: RetrievePastedTextParams,
): Promise<void> {
  await rm(
    join(pasteStoreDir(params.agencHome), `${sanitizePasteHash(params.hash)}.txt`),
    { force: true },
  );
}

export async function cleanupOldPastes(
  params: CleanupOldPastesParams,
): Promise<number> {
  const dir = pasteStoreDir(params.agencHome);
  const cutoff =
    (params.now ?? new Date()).getTime() - (params.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000);
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^[a-f0-9]{16}\.txt$/.test(entry)) return;
      const path = join(dir, entry);
      const fileStat = await stat(path);
      if (fileStat.mtimeMs >= cutoff) return;
      await rm(path, { force: true });
      removed += 1;
    }),
  );
  return removed;
}

function sanitizePasteHash(hash: string): string {
  if (!/^[a-f0-9]{16}$/.test(hash)) {
    throw new Error("invalid onboarding paste hash");
  }
  return hash;
}
