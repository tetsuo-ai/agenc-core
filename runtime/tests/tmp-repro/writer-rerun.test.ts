import { readFileSync } from "node:fs";
import { it } from "vitest";
import { createCompactionPayloadBundleV1, reconstructCompactionPayloadV1 } from "../../src/services/compact/payload-manifest.js";
import { readCompactionRolloutPayload } from "../../src/session/compaction-event-reader.js";

it("re-runs the writer on the payload rebuilt from the on-disk fragment", () => {
  const line = readFileSync("/private/tmp/tt/repro-sess/conv-mtnmmso6/rollout-2026-09-05T00-10-35-093Z-conv-mtnmmso6.jsonl", "utf8").split("\n").find((l) => l.includes('"type":"compaction_payload_chunk"') && l.includes('"source_history"'))!;
  const disk = (JSON.parse(line) as { payload: Record<string, unknown> }).payload;
  const fragment = String(disk.canonical_json_fragment);
  const payload = JSON.parse(fragment) as unknown;
  const bundle = createCompactionPayloadBundleV1({ attemptId: String(disk.attempt_id), recordedAtMs: Number(disk.recorded_at_ms), payloadKind: "source_history", itemCount: 256, value: payload });
  const chunk = bundle.chunks[0]!;
  console.log("rerun: chunks", bundle.chunks.length, "declared bytes", chunk.fragment_utf8_bytes, "fragment bytes", Buffer.byteLength(chunk.canonical_json_fragment, "utf8"), "chars", chunk.canonical_json_fragment.length, "sameFragmentAsDisk", chunk.canonical_json_fragment === fragment, "payload_sha256 same", chunk.payload_sha256 === disk.payload_sha256, "chunk_sha256 same", chunk.chunk_sha256 === disk.chunk_sha256, "manifest bytes", bundle.manifest.canonical_utf8_bytes);
  const roundTrip = JSON.parse(JSON.stringify(chunk)) as unknown;
  try { readCompactionRolloutPayload("compaction_payload_chunk", roundTrip); console.log("rerun chunk decodes after JSON round trip: ok"); }
  catch (error) { console.log("rerun chunk FAILS after round trip:", (error as Error).message); }
  try { reconstructCompactionPayloadV1(bundle.manifest, bundle.chunks); console.log("rerun reconstruct: ok"); } catch (error) { console.log("rerun reconstruct FAILS:", (error as Error).message); }
  // Where do 34 bytes hide? Compare per-character byte classes of the rerun fragment and the disk fragment.
  const classes = (s: string) => { const c = { one: 0, two: 0, three: 0, four: 0, lone: 0 }; for (const ch of s) { const cp = ch.codePointAt(0)!; if (cp < 0x80) c.one++; else if (cp < 0x800) c.two++; else if (cp >= 0xd800 && cp <= 0xdfff) c.lone++; else if (cp < 0x10000) c.three++; else c.four++; } return c; };
  console.log("classes rerun", JSON.stringify(classes(chunk.canonical_json_fragment)), "disk", JSON.stringify(classes(fragment)));
});
