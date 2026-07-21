/**
 * LedgerStatus — bottom-bar indicator for a connected Ledger hardware wallet.
 *
 * Passively polls `lsusb` (no device interaction — safe to run on a timer,
 * unlike `wallet-cli genuine-check`, which would prompt the signer) and parses
 * the model from the device line (e.g. "ID 2c97:5011 Ledger Nano S Plus" →
 * "Nano S Plus"). Three states:
 *
 *   connected — detected right now       → green icon + model
 *   recent    — not detected, but seen within the stale window → amber
 *   hidden    — not seen for longer than the stale window      → not rendered
 *
 * @module
 */

import React, { useEffect, useRef, useState } from "react";
import { execFile } from "node:child_process";
import ThemedText from "./design-system/ThemedText.js";

const POLL_MS = 15_000;
/** How long a lost device keeps showing amber before the indicator hides. */
const STALE_MS = 10 * 60_000;
const LSUSB_TIMEOUT_MS = 3_000;

export type LedgerStatus =
  | { readonly state: "connected"; readonly model: string }
  | { readonly state: "recent"; readonly model: string }
  | { readonly state: "hidden" };

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

export function useLedgerStatus(): LedgerStatus {
  const [status, setStatus] = useState<LedgerStatus>({ state: "hidden" });
  const lastSeenRef = useRef<{ model: string; at: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const model = await detectLedgerModel();
      if (cancelled) return;
      if (model !== null) {
        lastSeenRef.current = { model, at: Date.now() };
        setStatus({ state: "connected", model });
        return;
      }
      const last = lastSeenRef.current;
      if (last !== null && Date.now() - last.at < STALE_MS) {
        setStatus({ state: "recent", model: last.model });
      } else {
        setStatus({ state: "hidden" });
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}

export function LedgerStatus(): React.ReactElement | null {
  const status = useLedgerStatus();
  if (status.state === "hidden") return null;
  const color = status.state === "connected" ? "success" : "warning";
  return (
    <ThemedText color={color} wrap="truncate-end">
      {`▣ ${status.model}`}
    </ThemedText>
  );
}
