import type { SandboxSpawnCommand } from "./execution-broker.js";

export interface SandboxPreparedSpawn {
  /**
   * Run a one-shot child under the broker-owned lifecycle lease. The callback
   * must not resolve until the complete process tree has stopped.
   */
  run<T>(
    operation: (
      command: SandboxSpawnCommand,
      lifecycleSignal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
  /**
   * Start an asynchronously-lived one-shot child synchronously. `completion`
   * must settle only after the complete process tree has stopped.
   */
  start<T>(
    operation: (
      command: SandboxSpawnCommand,
      lifecycleSignal: AbortSignal,
    ) => { readonly value: T; readonly completion: Promise<void> },
  ): T;
  /** Run a synchronous one-shot child. Lifecycle transitions cannot overlap it. */
  runSync<T>(operation: (command: SandboxSpawnCommand) => T): T;
  /**
   * Start a long-lived process synchronously and transfer it to the named,
   * already-registered lifecycle participant.
   */
  spawnLifecycleParticipant<T>(
    participantName: string,
    operation: (command: SandboxSpawnCommand) => T,
  ): T;
}

/** Distinguishes an unproven process-tree cleanup from an ordinary child error. */
export class SandboxExecutionLeaseCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxExecutionLeaseCleanupError";
  }
}

const preparedSpawns = new WeakSet<object>();

/** @internal Register the broker-owned implementation without exporting it. */
export function registerSandboxPreparedSpawn(value: SandboxPreparedSpawn): void {
  preparedSpawns.add(value);
}

export function isSandboxPreparedSpawn(
  value: unknown,
): value is SandboxPreparedSpawn {
  return typeof value === "object" && value !== null && preparedSpawns.has(value);
}
