import { readFileSync } from "node:fs";
import { it } from "vitest";
import { readCompactionRolloutPayload } from "../../src/session/compaction-event-reader.js";
import { isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";

it("decodes both compaction payload chunks of the soak rollout", () => {
  const lines = readFileSync("/private/tmp/tt/repro-sess/conv-mtnmmso6/rollout-2026-09-05T00-10-35-093Z-conv-mtnmmso6.jsonl", "utf8").split("\n").filter((l) => l.includes('"type":"compaction_payload_chunk"'));
  for (const line of lines) {
    const record = JSON.parse(line) as { payload: Record<string, unknown> };
    const p = record.payload;
    const fragment = String(p.canonical_json_fragment);
    console.log("kind", p.payload_kind, "declared bytes", p.fragment_utf8_bytes, "actual bytes", Buffer.byteLength(fragment, "utf8"), "chars", fragment.length, "schemaOk", isCanonicalRolloutPayload("compaction_payload_chunk", p));
    try { readCompactionRolloutPayload("compaction_payload_chunk", p); console.log("  decode ok"); }
    catch (error) { console.log("  decode FAILED:", (error as Error).message, "\n  ", ((error as Error).stack ?? "").split("\n").slice(1, 5).join("\n  ")); }
  }
});
