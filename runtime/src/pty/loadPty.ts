import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface IPty {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string | Buffer) => void): { dispose(): void };
  onExit(
    listener: (event: {
      readonly exitCode: number;
      readonly signal?: number | string;
    }) => void,
  ): { dispose(): void };
}

export interface PtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name?: string;
      readonly cols?: number;
      readonly rows?: number;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly encoding?: string | null;
    },
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
