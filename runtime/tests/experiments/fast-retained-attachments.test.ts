import { expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { createAttachmentRetentionLedger, recordRetainedAttachments, projectRetainedAttachments } from "../../src/session/attachment-retention.js";

test.each(["same", "moved", "duplicate", "changed", "dropped", "permission"])("fast attachment anchor lookup preserves %s history", kind => {
  const anchor: LLMMessage = { role: "user", content: "anchored prompt" };
  const initial: LLMMessage[] = [{ role: "system", content: "instructions" }, anchor];
  const ledger = createAttachmentRetentionLedger();
  recordRetainedAttachments(ledger, initial, 1, "before", [{ role: "user", content: "retained context",
    runtimeOnly: { mergeBoundary: "user_context", permissionModeReminder: "auto" } }]);
  const base = structuredClone(initial);
  if (kind === "moved") base.unshift({ role: "user", content: "inserted context" });
  if (kind === "duplicate") base.push({ role: "assistant", content: "answer" }, { ...anchor });
  if (kind === "changed") base[1]!.content = "changed prompt";
  if (kind === "dropped") base.pop();
  const normalLedger = structuredClone(ledger), fastLedger = structuredClone(ledger);
  const mode = kind === "permission" ? "plan" : "bypassPermissions";
  const normal = projectRetainedAttachments(base, normalLedger, mode);
  const fast = withOneShotFastMode(() => projectRetainedAttachments(base, fastLedger, mode));
  expect(fast).toEqual(normal);
  expect(fastLedger).toEqual(normalLedger);
});
