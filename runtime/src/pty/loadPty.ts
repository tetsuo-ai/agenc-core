import { createRequire } from "node:module";
import type {
  IPty,
  IPtyForkOptions,
  IWindowsPtyForkOptions,
} from "node-pty";

const require = createRequire(import.meta.url);

export type { IPty };

export interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
  ): IPty;
}

export function loadPtyFrom(requireFn: (id: string) => unknown): PtyModule {
  try {
    return requireFn("node-pty") as PtyModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PTY support is required but node-pty could not be loaded under ${process.version}. Run npm install in the runtime package and ensure native build tools are available. ${detail}`,
    );
  }
}

export function loadPty(): PtyModule {
  return loadPtyFrom(require);
}
