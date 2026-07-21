/**
 * Ledger connection status — on-demand store (no continuous polling).
 *
 * The USB read (`lsusb`, Ledger vendor id 0x2c97) only runs when something
 * explicitly asks for it via `refreshLedgerStatus()` — wired to fire when the
 * user submits a prompt mentioning "ledger" or runs the `/ledger` command.
 * Nothing polls in the background; the indicator simply renders the last
 * on-demand result and ages it locally (connected → recent → hidden) without
 * touching the device again.
 *
 * Detection is passive (lsusb lists the USB bus; the model name trails the
 * id, e.g. "ID 2c97:5011 Ledger Nano S Plus" → "Nano S Plus"). It never
 * prompts the signer, unlike `wallet-cli genuine-check`.
 *
 * @module
 */

import { execFile } from "node:child_process";

const LSUSB_TIMEOUT_MS = 3_000;
/** How long a lost device keeps showing as "recent" before hiding. */
export const LEDGER_STALE_MS = 10 * 60_000;

export type LedgerSnapshot = {
  /** When the last read FOUND the device (null if never found). */
  readonly lastSeenAt: number | null;
  /** Last known model name (kept so "recent" can still show it). */
  readonly model: string | null;
  /** Whether the most recent read found the device connected. */
  readonly detected: boolean;
};

/** Ledger's USB vendor id is 0x2c97; the model name trails the id in lsusb. */
export function parseLedgerModel(lsusbOutput: string): string | null {
  const line = lsusbOutput.split("\n").find((l) => /2c97:/i.test(l));
  if (line === undefined) return null;
  const match = line.match(/2c97:[0-9a-f]+\s+(.+)$/i);
  const model = match?.[1]?.trim().replace(/^ledger\s+/i, "") ?? "";
  return model.length > 0 ? model : "Ledger";
}

function detectLedgerModel(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("lsusb", [], { timeout: LSUSB_TIMEOUT_MS }, (error, stdout) => {
      if (error || typeof stdout !== "string") {
        resolve(null);
        return;
      }
      resolve(parseLedgerModel(stdout));
    });
  });
}

let snapshot: LedgerSnapshot = {
  lastSeenAt: null,
  model: null,
  detected: false,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeLedgerStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLedgerStatusSnapshot(): LedgerSnapshot {
  return snapshot;
}

/**
 * Run a single on-demand USB read and update the store. Fire-and-forget from
 * triggers (prompt mention / /ledger) — never call on a timer.
 */
export async function refreshLedgerStatus(): Promise<void> {
  const model = await detectLedgerModel();
  snapshot = {
    model: model ?? snapshot.model,
    lastSeenAt: model !== null ? Date.now() : snapshot.lastSeenAt,
    detected: model !== null,
  };
  emit();
}
