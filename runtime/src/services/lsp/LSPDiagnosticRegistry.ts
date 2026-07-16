/**
 * Ports the donor passive LSP diagnostic registry.
 *
 * Diagnostics arrive asynchronously from language servers and are delivered on
 * the next agent turn as diagnostic attachments. The registry deduplicates
 * within a batch and across recent deliveries while keeping strict volume caps.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LRUCache } from "lru-cache";

import type { DiagnosticEntry, DiagnosticFile } from "./types.js";

export interface PendingLSPDiagnostic {
  readonly serverName: string;
  readonly files: DiagnosticFile[];
  readonly timestamp: number;
  attachmentSent: boolean;
}

export type LSPDiagnosticScope = object;

const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_TOTAL_DIAGNOSTICS = 30;
const MAX_DELIVERED_FILES = 500;
export const MAX_DELIVERED_DIAGNOSTICS_PER_FILE = 100;

interface LSPDiagnosticState {
  readonly pendingDiagnostics: Map<string, PendingLSPDiagnostic>;
  readonly deliveredDiagnostics: LRUCache<string, Set<string>>;
}

function createDiagnosticState(): LSPDiagnosticState {
  return {
    pendingDiagnostics: new Map(),
    deliveredDiagnostics: new LRUCache({ max: MAX_DELIVERED_FILES }),
  };
}

let defaultDiagnosticState = createDiagnosticState();
let scopedDiagnosticStates = new WeakMap<LSPDiagnosticScope, LSPDiagnosticState>();
let activeDiagnosticStates = new Set<LSPDiagnosticState>([defaultDiagnosticState]);

function stateForScope(
  scope: LSPDiagnosticScope | undefined,
  create: boolean,
): LSPDiagnosticState | undefined {
  if (scope === undefined) return defaultDiagnosticState;
  const existing = scopedDiagnosticStates.get(scope);
  if (existing !== undefined || !create) return existing;
  const state = createDiagnosticState();
  scopedDiagnosticStates.set(scope, state);
  activeDiagnosticStates.add(state);
  return state;
}

function pendingKey(serverName: string, uri: string): string {
  return `${serverName}\u0000${uri}`;
}

function severityToNumber(severity: DiagnosticEntry["severity"]): number {
  switch (severity) {
    case "Error":
      return 1;
    case "Warning":
      return 2;
    case "Info":
      return 3;
    case "Hint":
      return 4;
    default:
      return 4;
  }
}

function diagnosticKey(diag: DiagnosticEntry): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity ?? null,
    range: diag.range ?? null,
    source: diag.source ?? null,
    code: diag.code ?? null,
  });
}

function fileKeys(file: string): string[] {
  const keys = new Set([file]);
  if (file.startsWith("file://")) {
    try {
      keys.add(fileURLToPath(file));
    } catch {
      // Keep the original malformed URI key only.
    }
  } else {
    try {
      keys.add(pathToFileURL(resolve(file)).href);
    } catch {
      // Keep the original path key only.
    }
  }
  return Array.from(keys);
}

function fileMatches(a: string, b: string): boolean {
  const aKeys = new Set(fileKeys(a));
  return fileKeys(b).some((key) => aKeys.has(key));
}

function deduplicateDiagnosticFiles(
  files: readonly DiagnosticFile[],
  state: LSPDiagnosticState,
): DiagnosticFile[] {
  const perFileSeen = new Map<string, Set<string>>();
  const out = new Map<string, DiagnosticFile>();

  for (const file of files) {
    const seen = perFileSeen.get(file.uri) ?? new Set<string>();
    perFileSeen.set(file.uri, seen);
    const delivered = state.deliveredDiagnostics.get(file.uri) ?? new Set<string>();
    const target = out.get(file.uri) ?? { uri: file.uri, diagnostics: [] };
    out.set(file.uri, target);

    for (const diagnostic of file.diagnostics) {
      const key = diagnosticKey(diagnostic);
      if (seen.has(key) || delivered.has(key)) continue;
      seen.add(key);
      target.diagnostics.push(diagnostic);
    }
  }

  return Array.from(out.values()).filter((file) => file.diagnostics.length > 0);
}

function sortAndCapDiagnosticFiles(files: DiagnosticFile[]): DiagnosticFile[] {
  let totalDiagnostics = 0;
  for (const file of files) {
    file.diagnostics.sort(
      (a, b) => severityToNumber(a.severity) - severityToNumber(b.severity),
    );
    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    }
    const remaining = MAX_TOTAL_DIAGNOSTICS - totalDiagnostics;
    if (file.diagnostics.length > remaining) {
      file.diagnostics = file.diagnostics.slice(0, Math.max(0, remaining));
    }
    totalDiagnostics += file.diagnostics.length;
  }
  return files.filter((file) => file.diagnostics.length > 0);
}

function rememberDeliveredDiagnostic(
  state: LSPDiagnosticState,
  fileUri: string,
  key: string,
): void {
  const delivered = state.deliveredDiagnostics.get(fileUri) ?? new Set<string>();
  if (delivered.has(key)) {
    delivered.delete(key);
  }
  delivered.add(key);
  while (delivered.size > MAX_DELIVERED_DIAGNOSTICS_PER_FILE) {
    const oldest = delivered.values().next().value;
    if (oldest === undefined) break;
    delivered.delete(oldest);
  }
  state.deliveredDiagnostics.set(fileUri, delivered);
}

function clearDeliveredInState(state: LSPDiagnosticState, fileUri: string): void {
  for (const key of fileKeys(fileUri)) state.deliveredDiagnostics.delete(key);
}

function reconcileDeliveredDiagnosticsForFile(
  state: LSPDiagnosticState,
  file: DiagnosticFile,
): void {
  if (file.diagnostics.length === 0) {
    clearDeliveredInState(state, file.uri);
    return;
  }
  const currentKeys = new Set(file.diagnostics.map(diagnosticKey));
  for (const key of fileKeys(file.uri)) {
    const delivered = state.deliveredDiagnostics.get(key);
    if (!delivered) continue;
    for (const deliveredKey of Array.from(delivered)) {
      if (!currentKeys.has(deliveredKey)) delivered.delete(deliveredKey);
    }
    if (delivered.size === 0) {
      state.deliveredDiagnostics.delete(key);
    }
  }
}

export function registerPendingLSPDiagnostic(input: {
  readonly serverName: string;
  readonly files: DiagnosticFile[];
}, scope?: LSPDiagnosticScope): void {
  const state = stateForScope(scope, true)!;
  for (const file of input.files) {
    reconcileDeliveredDiagnosticsForFile(state, file);
    const key = pendingKey(input.serverName, file.uri);
    if (file.diagnostics.length === 0) {
      state.pendingDiagnostics.delete(key);
      continue;
    }
    state.pendingDiagnostics.set(key, {
      serverName: input.serverName,
      files: [file],
      timestamp: Date.now(),
      attachmentSent: false,
    });
  }
}

export function checkForLSPDiagnostics(scope?: LSPDiagnosticScope): Array<{
  readonly serverName: string;
  readonly files: DiagnosticFile[];
}> {
  const state = stateForScope(scope, false);
  if (state === undefined) return [];
  const allFiles: DiagnosticFile[] = [];
  const serverNames = new Set<string>();
  const diagnosticsToMark: PendingLSPDiagnostic[] = [];

  for (const diagnostic of state.pendingDiagnostics.values()) {
    if (diagnostic.attachmentSent) continue;
    allFiles.push(...diagnostic.files);
    serverNames.add(diagnostic.serverName);
    diagnosticsToMark.push(diagnostic);
  }
  if (allFiles.length === 0) return [];

  const deduped = sortAndCapDiagnosticFiles(
    deduplicateDiagnosticFiles(allFiles, state),
  );
  for (const diagnostic of diagnosticsToMark) diagnostic.attachmentSent = true;
  for (const [id, diagnostic] of state.pendingDiagnostics.entries()) {
    if (diagnostic.attachmentSent) state.pendingDiagnostics.delete(id);
  }

  for (const file of deduped) {
    for (const diagnostic of file.diagnostics) {
      rememberDeliveredDiagnostic(state, file.uri, diagnosticKey(diagnostic));
    }
  }

  if (deduped.length === 0) return [];
  return [
    {
      serverName: Array.from(serverNames).join(", "),
      files: deduped,
    },
  ];
}

export function peekLSPDiagnosticsForFile(
  file: string,
  scope?: LSPDiagnosticScope,
): DiagnosticEntry[] {
  const state = stateForScope(scope, false);
  if (state === undefined) return [];
  const seen = new Set<string>();
  const diagnostics: DiagnosticEntry[] = [];

  for (const pending of state.pendingDiagnostics.values()) {
    if (pending.attachmentSent) continue;
    for (const diagnosticFile of pending.files) {
      if (!fileMatches(diagnosticFile.uri, file)) continue;
      // peek(), not get(): this is a read-only query, so it must not bump the
      // entry's LRU recency and risk evicting another file's delivered-dedup set
      // (which would re-deliver already-seen diagnostics as "new").
      const delivered =
        state.deliveredDiagnostics.peek(diagnosticFile.uri) ?? new Set();
      for (const diagnostic of diagnosticFile.diagnostics) {
        const key = diagnosticKey(diagnostic);
        if (seen.has(key) || delivered.has(key)) continue;
        seen.add(key);
        diagnostics.push(diagnostic);
      }
    }
  }

  return sortAndCapDiagnosticFiles([{ uri: file, diagnostics }])[0]?.diagnostics ?? [];
}

export function clearAllLSPDiagnostics(scope?: LSPDiagnosticScope): void {
  stateForScope(scope, false)?.pendingDiagnostics.clear();
}

export function resetAllLSPDiagnosticState(): void {
  for (const state of activeDiagnosticStates) {
    state.pendingDiagnostics.clear();
    state.deliveredDiagnostics.clear();
  }
  defaultDiagnosticState = createDiagnosticState();
  scopedDiagnosticStates = new WeakMap();
  activeDiagnosticStates = new Set([defaultDiagnosticState]);
}

export function clearDeliveredDiagnosticsForFile(
  fileUri: string,
  scope?: LSPDiagnosticScope,
): void {
  const state = stateForScope(scope, false);
  if (state !== undefined) clearDeliveredInState(state, fileUri);
}

export function clearLSPDiagnosticScope(scope: LSPDiagnosticScope): void {
  const state = stateForScope(scope, false);
  if (state === undefined) return;
  state.pendingDiagnostics.clear();
  state.deliveredDiagnostics.clear();
  scopedDiagnosticStates.delete(scope);
  activeDiagnosticStates.delete(state);
}

export function getPendingLSPDiagnosticCount(scope?: LSPDiagnosticScope): number {
  return stateForScope(scope, false)?.pendingDiagnostics.size ?? 0;
}
