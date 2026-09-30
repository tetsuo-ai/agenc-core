export type Scope = 'crash' | 'recover' | 'daemon' | 'marker' | 'sdk';
export interface Emitter {
  mark(stage: string): boolean;
  status(): { emitted: number; disabled: boolean };
}
export interface Report {
  version: string;
  scope: Scope;
  evidence: 'observed_prefix_only' | 'unknown';
  cause: 'not_established';
  records: number;
  lastObserved: string | null;
  attempts: number | null;
  segmentCount: number;
  segments: { from: string; to: string; wallMs: number; cpuUserUs: number; cpuSystemUs: number }[];
}
export interface Options {
  write?: (bytes: Buffer) => number;
  clock?: () => bigint;
  cpu?: () => { user: number; system: number };
}
export const VERSION: string;
export const LIMITS: Readonly<{ bytes: number; records: number; line: number }>;
export function createEmitter(scope: Scope, options?: Options): Emitter;
export function createCollector(scope: Scope): {
  push(chunk: unknown): void;
  end(): void;
  report(): Report;
};
export function createLocalProbe(scope: Scope, options?: Options): { emitter: Emitter; finish(): Report };
export function observeSdkAttempt<T>(emitter: Emitter, operation: () => T | Promise<T>): Promise<T>;
export function observeMarkerWait<T>(emitter: Emitter, operation: () => T | Promise<T>): Promise<T>;
export function installPreload(scope: Scope, options?: Options): void;
export function mark(stage: string): boolean;
export function preparePreload(env: Record<string, string | undefined>, mainThread: boolean,
  install?: (scope: Scope) => void): boolean;
export function emitDiagnostic(producer: () => unknown,
  sink?: (label: string, json: string) => void): boolean;
