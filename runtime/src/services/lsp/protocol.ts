/**
 * Minimal LSP protocol shapes used by AgenC's LSP service.
 *
 * The donor source imports these types from `vscode-languageserver-protocol`.
 * AgenC already has the JSON-RPC runtime dependency but not that type package,
 * so the service keeps the small structural subset it needs locally.
 */

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspDiagnostic {
  readonly message: string;
  readonly severity?: number;
  readonly range: LspRange;
  readonly source?: string;
  readonly code?: string | number;
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

export interface WorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

export interface InitializeParams {
  readonly processId: number | null;
  readonly initializationOptions?: unknown;
  readonly workspaceFolders?: readonly WorkspaceFolder[];
  readonly rootPath?: string | null;
  readonly rootUri?: string | null;
  readonly capabilities: Record<string, unknown>;
}

export type ServerCapabilities = Record<string, unknown>;

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
}
