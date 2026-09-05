import { describe, expect, it, vi } from "vitest";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { finalizeCompactionTransaction } from "../../../src/services/compact/finalize-transaction.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { REDACTED_SECRET } from "../../../src/secrets/sanitizer.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

const TOKEN = "xai-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7R8";

/**
 * The soak session died when its history held an npm auth token: the rollout
 * line encoder redacted the compaction payload chunk after its digest was
 * taken, the commit failed on re-validation, and every later strict read of
 * the session rejected the chunk. The payload is redacted before it is hashed
 * now; this drives a real automatic compaction through the durable commit and
 * reads the rollout back strictly.
 */
describe("automatic compaction with a secret in the source history", () => {
  it("commits, keeps the secret out of the rollout, and the rollout reads back strictly", async () => {
    const source: readonly RuntimeMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 3
          ? `npmrc:\n//npm.pkg.github.com/:_authToken = ${TOKEN}\n${"x".repeat(4_000)}`
          : `source-${index}:${"x".repeat(4_000)}`,
    }));
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: "automatic-secret-redaction",
    });
    try {
      const result = await compactConversation(source, harness.context);
      const transaction = result.transaction;
      expect(transaction).toBeDefined();
      const cleanup = vi.fn();
      await finalizeCompactionTransaction({
        store: harness.store,
        attemptId: transaction!.attempt_id,
        applyProjection: () => {},
        cleanup,
      });
      expect(cleanup).toHaveBeenCalledOnce();

      // Strict re-read from disk: this is the read that used to throw
      // "payload chunk count does not match its manifest".
      const items = harness.store.readAll();
      const types = items.map((item) => item.type);
      expect(types).toContain("compaction_committed");
      expect(types).not.toContain("compaction_failed");
      const chunks = items.filter((item) => item.type === "compaction_payload_chunk");
      expect(chunks.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(items);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain(REDACTED_SECRET);
      const history = reconstructFromRollout(items).history;
      expect(JSON.stringify(history)).not.toContain(TOKEN);
    } finally {
      harness.close();
    }
  });
});
