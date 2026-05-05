/**
 * Source-aligned with `src/services/preventSleep.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC registers cleanup through `lifecycle/cleanup-registry`.
 *   - The controller is instantiable for tests; the exported module-level
 *     functions retain the donor reference-counting behavior.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { registerAgenCCleanup } from "../lifecycle/cleanup-registry.js";
import { logForDebugging } from "../utils/debug.js";

export const CAFFEINATE_TIMEOUT_SECONDS = 300;
export const RESTART_INTERVAL_MS = 4 * 60 * 1000;

type IntervalHandle = ReturnType<typeof setInterval> & {
  readonly unref?: () => void;
};

type SpawnLike = typeof spawn;
type SetIntervalLike = (
  callback: () => void,
  delayMs: number,
) => IntervalHandle;
type ClearIntervalLike = (handle: IntervalHandle) => void;

export interface PreventSleepRuntime {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
  readonly setInterval?: SetIntervalLike;
  readonly clearInterval?: ClearIntervalLike;
  readonly registerCleanup?: (
    name: string,
    task: () => void | Promise<void>,
  ) => () => void;
  readonly logForDebugging?: (message: string) => void;
}

export class PreventSleepController {
  #caffeinateProcess: ChildProcess | null = null;
  #restartInterval: IntervalHandle | null = null;
  #refCount = 0;
  #cleanupRegistered = false;

  constructor(private readonly runtime: PreventSleepRuntime = {}) {}

  get refCount(): number {
    return this.#refCount;
  }

  get isCaffeinateRunning(): boolean {
    return this.#caffeinateProcess !== null;
  }

  startPreventSleep(): void {
    this.#refCount += 1;

    if (this.#refCount === 1) {
      this.#spawnCaffeinate();
      this.#startRestartInterval();
    }
  }

  stopPreventSleep(): void {
    if (this.#refCount > 0) {
      this.#refCount -= 1;
    }

    if (this.#refCount === 0) {
      this.#stopRestartInterval();
      this.#killCaffeinate();
    }
  }

  forceStopPreventSleep(): void {
    this.#refCount = 0;
    this.#stopRestartInterval();
    this.#killCaffeinate();
  }

  #startRestartInterval(): void {
    if (this.#platform() !== "darwin") {
      return;
    }
    if (this.#restartInterval !== null) {
      return;
    }

    this.#restartInterval = this.#setInterval()(() => {
      if (this.#refCount > 0) {
        this.#log("Restarting caffeinate to maintain sleep prevention");
        this.#killCaffeinate();
        this.#spawnCaffeinate();
      }
    }, RESTART_INTERVAL_MS);

    this.#restartInterval.unref?.();
  }

  #stopRestartInterval(): void {
    if (this.#restartInterval !== null) {
      this.#clearInterval()(this.#restartInterval);
      this.#restartInterval = null;
    }
  }

  #spawnCaffeinate(): void {
    if (this.#platform() !== "darwin") {
      return;
    }
    if (this.#caffeinateProcess !== null) {
      return;
    }

    if (!this.#cleanupRegistered) {
      try {
        this.#registerCleanup()("prevent-sleep", async () => {
          this.forceStopPreventSleep();
        });
        this.#cleanupRegistered = true;
      } catch (error) {
        this.#log(`prevent-sleep cleanup registration failed: ${String(error)}`);
      }
    }

    try {
      this.#caffeinateProcess = this.#spawn()(
        "caffeinate",
        ["-i", "-t", String(CAFFEINATE_TIMEOUT_SECONDS)],
        { stdio: "ignore" },
      );

      this.#caffeinateProcess.unref();

      const thisProc = this.#caffeinateProcess;
      this.#caffeinateProcess.on("error", (error) => {
        this.#log(`caffeinate spawn error: ${error.message}`);
        if (this.#caffeinateProcess === thisProc) {
          this.#caffeinateProcess = null;
        }
      });
      this.#caffeinateProcess.on("exit", () => {
        if (this.#caffeinateProcess === thisProc) {
          this.#caffeinateProcess = null;
        }
      });

      this.#log("Started caffeinate to prevent sleep");
    } catch {
      this.#caffeinateProcess = null;
    }
  }

  #killCaffeinate(): void {
    if (this.#caffeinateProcess !== null) {
      const proc = this.#caffeinateProcess;
      this.#caffeinateProcess = null;
      try {
        proc.kill("SIGKILL");
        this.#log("Stopped caffeinate, allowing sleep");
      } catch {
        // Process may have already exited.
      }
    }
  }

  #platform(): NodeJS.Platform {
    return this.runtime.platform ?? process.platform;
  }

  #spawn(): SpawnLike {
    return this.runtime.spawn ?? spawn;
  }

  #setInterval(): SetIntervalLike {
    return this.runtime.setInterval ?? setInterval;
  }

  #clearInterval(): ClearIntervalLike {
    return this.runtime.clearInterval ?? clearInterval;
  }

  #registerCleanup(): NonNullable<PreventSleepRuntime["registerCleanup"]> {
    return this.runtime.registerCleanup ?? registerAgenCCleanup;
  }

  #log(message: string): void {
    (this.runtime.logForDebugging ?? logForDebugging)(message);
  }
}

const globalPreventSleepController = new PreventSleepController();

export function startPreventSleep(): void {
  globalPreventSleepController.startPreventSleep();
}

export function stopPreventSleep(): void {
  globalPreventSleepController.stopPreventSleep();
}

export function forceStopPreventSleep(): void {
  globalPreventSleepController.forceStopPreventSleep();
}
