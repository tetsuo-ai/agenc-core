import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "./protocol/index.js";
import { CompactionRecordDamagedError } from "../../src/session/compaction-event-reader.js";
import { CompactionTransactionError } from "../../src/services/compact/transaction-types.js";

// A chat whose stored compaction summary fails its digest check (Core before
// w21 digested summaries before the rollout's secret redaction rewrote them)
// is refused in one plain sentence with a stable code, not as an internal error
// that quotes RFC 8785.
describe("a chat whose stored compaction summary is damaged", () => {
  it("answers its transcript read with the plain sentence and COMPACTION_RECORD_DAMAGED", async () => {
    const cause = new CompactionTransactionError(
      "digest_invalid",
      "compaction summary digest does not match its RFC 8785 preimage",
    );
    const getSessionTranscriptV2 = vi.fn(async () => {
      throw new CompactionRecordDamagedError("compact-damaged", { cause });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const connection = new AgenCDaemonJsonRpcDispatcher({
        agentManager: { getSessionTranscriptV2 } as never,
      }).createConnection();
      await connection.dispatch({
        jsonrpc: "2.0", id: "init", method: "initialize",
        params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION } },
      });
      const answer = await connection.dispatch({
        jsonrpc: "2.0", id: "read", method: "session.transcript.v2",
        params: { sessionId: "damaged" },
      });
      expect(getSessionTranscriptV2).toHaveBeenCalledOnce();
      expect(answer).toMatchObject({
        error: {
          code: -32000,
          message: "This chat cannot be opened because the summary saved when it was compacted is damaged.",
          data: { code: "COMPACTION_RECORD_DAMAGED" },
        },
      });
      const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("compaction compact-damaged cannot be read: compaction summary digest does not match");
      expect(logged).not.toContain("unexpected RPC handler exception");
    } finally {
      errors.mockRestore();
    }
  });
});
