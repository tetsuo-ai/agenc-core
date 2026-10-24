import { readFileSync, writeFileSync } from "node:fs";

/**
 * Commands AgenC launches start with a higher Linux OOM score than AgenC
 * itself. When a command exhausts the memory of its container or host, the
 * kernel then ends that command (or one of its children) and the daemon
 * survives to report the failure, instead of the kernel picking the daemon
 * once the command's largest process is gone and ending the whole run.
 *
 * Raising a process's score needs no privilege, lowering it does, so the
 * value only ever goes up from what the launched process inherited. Everything
 * the launched process starts inherits it. The adjustment is applied before
 * the launcher receives its command, so no descendant starts unadjusted.
 */
export const LAUNCHED_PROCESS_OOM_SCORE_RAISE = 300;
const OOM_SCORE_ADJ_MIN = -1000;
const OOM_SCORE_ADJ_MAX = 1000;

export interface OomScoreFiles {
  readonly read: (path: string) => string;
  readonly write: (path: string, value: string) => void;
}

const procFiles: OomScoreFiles = {
  read: path => readFileSync(path, "utf8"),
  write: (path, value) => writeFileSync(path, value),
};

/** Best effort; returns the score now in effect, or undefined when unchanged. */
export function preferLaunchedProcessAsOomVictim(
  pid: number | undefined,
  options: { readonly platform?: NodeJS.Platform; readonly files?: OomScoreFiles; readonly raise?: number } = {},
): number | undefined {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const files = options.files ?? procFiles;
  const path = `/proc/${pid}/oom_score_adj`;
  try {
    const current = Number(files.read(path).trim());
    if (!Number.isSafeInteger(current) || current < OOM_SCORE_ADJ_MIN || current > OOM_SCORE_ADJ_MAX) {
      return undefined;
    }
    const target = Math.min(OOM_SCORE_ADJ_MAX, current + (options.raise ?? LAUNCHED_PROCESS_OOM_SCORE_RAISE));
    if (target <= current) return undefined;
    files.write(path, `${target}\n`);
    return target;
  } catch {
    // A missing /proc, an exited process or a read-only proc mount keeps the
    // inherited score; containment and launch semantics are unchanged.
    return undefined;
  }
}
