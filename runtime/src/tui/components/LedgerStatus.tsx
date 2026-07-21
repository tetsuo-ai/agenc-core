/**
 * LedgerStatus — bottom-bar indicator for a connected Ledger hardware wallet.
 *
 * Renders the on-demand snapshot from `services/Ledger/ledgerStatus` — no
 * background USB polling. The snapshot refreshes only when the user engages
 * Ledger (mentions "ledger" in a prompt or runs `/ledger`). The only timer
 * here is render-only (no subprocess): it ages a lost device from amber to
 * hidden after LEDGER_STALE_MS.
 *
 *   connected — last read found the device   → green icon + model
 *   recent    — lost, but seen within window → amber
 *   hidden    — never seen, or stale         → not rendered
 *
 * @module
 */

import React, { useEffect, useState, useSyncExternalStore } from "react";
import {
  getLedgerStatusSnapshot,
  LEDGER_STALE_MS,
  subscribeLedgerStatus,
} from "../../services/Ledger/ledgerStatus.js";
import ThemedText from "./design-system/ThemedText.js";

/** Render-only aging tick — no subprocess, just re-evaluates the stale window. */
const AGE_TICK_MS = 30_000;

export function LedgerStatus(): React.ReactElement | null {
  const snap = useSyncExternalStore(
    subscribeLedgerStatus,
    getLedgerStatusSnapshot,
  );
  // Force a periodic re-render so a lost device ages amber → hidden on time.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick((t) => t + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (snap.lastSeenAt === null) return null;
  const model = snap.model ?? "Ledger";
  if (snap.detected) {
    return (
      <ThemedText color="success" wrap="truncate-end">
        {`▣ ${model}`}
      </ThemedText>
    );
  }
  if (Date.now() - snap.lastSeenAt < LEDGER_STALE_MS) {
    return (
      <ThemedText color="warning" wrap="truncate-end">
        {`▣ ${model}`}
      </ThemedText>
    );
  }
  return null;
}
