import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempAgencHome {
  readonly path: string;
  cleanup(): void;
}

export function createTempAgencHome(prefix = "agenc-state-home-"): TempAgencHome {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
