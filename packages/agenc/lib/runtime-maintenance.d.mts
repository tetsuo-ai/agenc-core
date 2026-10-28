export function beginRuntimeUpdate(home: string, pid?: number): Promise<string>;
export function endRuntimeUpdate(lease: string): void;
export function recordRuntimeActivation(home: string, current: string, previous?: string): boolean;
export function runtimeProcessInventory(root: string, options?: {
  runCommand?: typeof import("node:child_process").execFile;
  timeoutMs?: number;
  helperPath?: string;
}): Promise<string>;
export interface RuntimePruneResult { removed: string[]; freedBytes: number; skipped?: string }
export function pruneRuntimes(home: string, options?: { inventory?: (root: string) => string | Promise<string>; checkpoint?: (step: string) => void }): Promise<RuntimePruneResult>;
