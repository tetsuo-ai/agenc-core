export function beginRuntimeUpdate(home: string, pid?: number): Promise<string>;
export function endRuntimeUpdate(lease: string): void;
export function recordRuntimeActivation(home: string, current: string, previous?: string): boolean;
export function runtimeProcessInventory(root: string): string;
export interface RuntimePruneResult { removed: string[]; freedBytes: number; skipped?: string }
export function pruneRuntimes(home: string, options?: { inventory?: typeof runtimeProcessInventory; checkpoint?: (step: string) => void }): Promise<RuntimePruneResult>;
