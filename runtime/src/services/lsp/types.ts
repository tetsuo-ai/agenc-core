/**
 * Shared LSP service types.
 *
 * Ports the donor LSP configuration shape onto AgenC-owned names. The donor
 * plugin loader is not carried here; `config.ts` resolves already-supplied
 * AgenC config records into these types.
 */

import type { LspRange } from "./protocol.js";

export type LspServerState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface LspServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workspaceFolder?: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  readonly initializationOptions?: unknown;
  readonly startupTimeout?: number;
  readonly maxRestarts?: number;
  readonly restartOnCrash?: boolean;
  readonly shutdownTimeout?: number;
}

export interface ScopedLspServerConfig extends LspServerConfig {
  readonly scope?: string;
  readonly displayName?: string;
}

export interface DiagnosticEntry {
  readonly message: string;
  readonly severity?: "Error" | "Warning" | "Info" | "Hint";
  readonly range?: LspRange;
  readonly source?: string;
  readonly code?: string;
}

export interface DiagnosticFile {
  uri: string;
  diagnostics: DiagnosticEntry[];
}

export type LspServerConfigSource = () =>
  | Promise<Record<string, ScopedLspServerConfig>>
  | Record<string, ScopedLspServerConfig>;
