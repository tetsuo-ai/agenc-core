import type { PermissionMode, ToolPermissionContext } from "../permissions/types.js";

export const AUTONOMOUS_TICK_TAG = "tick";
export const AUTONOMOUS_SUBMIT_SOURCE = "autonomous_tick";
export const DEFAULT_AUTONOMOUS_TICK_DELAY_MS = 0;

export type SessionSubmitSource = "user" | typeof AUTONOMOUS_SUBMIT_SOURCE;

export interface SessionSubmitOptions {
  readonly source?: SessionSubmitSource;
}

const AUTONOMOUS_PERMISSION_MODES: ReadonlySet<PermissionMode> =
  new Set<PermissionMode>(["auto", "bypassPermissions"]);

export function isAutonomousPermissionMode(
  input: PermissionMode | ToolPermissionContext | null | undefined,
): boolean {
  if (input === null || input === undefined) return false;
  const mode = typeof input === "string" ? input : input.mode;
  return AUTONOMOUS_PERMISSION_MODES.has(mode);
}

export function createAutonomousTickMessage(now: Date = new Date()): string {
  return `<${AUTONOMOUS_TICK_TAG}>${now.toLocaleTimeString()}</${AUTONOMOUS_TICK_TAG}>`;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AutonomousKeepaliveSchedulerOptions {
  readonly isActive: () => boolean;
  readonly submitTick: (message: string) => Promise<void>;
  readonly delayMs?: number;
  readonly now?: () => Date;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeoutFn?: (handle: TimerHandle) => void;
  readonly onError?: (error: unknown) => void;
}

export class AutonomousKeepaliveScheduler {
  private readonly isActiveFn: () => boolean;
  private readonly submitTick: (message: string) => Promise<void>;
  private readonly delayMs: number;
  private readonly now: () => Date;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;
  private readonly onError?: (error: unknown) => void;
  private timer: TimerHandle | null = null;
  private disposed = false;

  constructor(opts: AutonomousKeepaliveSchedulerOptions) {
    this.isActiveFn = opts.isActive;
    this.submitTick = opts.submitTick;
    this.delayMs = opts.delayMs ?? DEFAULT_AUTONOMOUS_TICK_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.onError = opts.onError;
  }

  isScheduled(): boolean {
    return this.timer !== null;
  }

  isActive(): boolean {
    if (this.disposed) return false;
    try {
      return this.isActiveFn();
    } catch {
      return false;
    }
  }

  scheduleNext(): void {
    if (this.timer !== null || !this.isActive()) return;
    const timer = this.setTimeoutFn(() => {
      this.timer = null;
      if (!this.isActive()) return;
      const tick = createAutonomousTickMessage(this.now());
      void this.submitTick(tick).catch((error) => {
        this.onError?.(error);
      });
    }, this.delayMs);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    this.timer = timer;
  }

  cancel(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
