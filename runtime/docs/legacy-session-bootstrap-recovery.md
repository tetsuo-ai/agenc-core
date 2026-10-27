# Legacy resume bootstrap envelopes

The 0.19 resume writer embedded every historical transcript event in a new
`session_configured.initialMessages` array. The array duplicates canonical
rollout records and is unnecessary for the independently restored TUI transcript.
Long sessions produced valid bootstrap records above the ordinary 4 MiB reader
ceiling. New root bootstrap events store an empty array; the original canonical
history and the TUI's restored transcript remain complete.

Historical files stay byte-identical. The reader recognizes the old serializer's
bootstrap envelope before buffering beyond 4 MiB, then allows at most 64 MiB
(the existing default recovery source budget). It accepts that larger record only
if its actual type is `session_configured`, every nested message and metadata
field passes schema validation, JSON keys and depth are valid, and metadata
without the history array fits the ordinary ceiling. Lower caller-specified line
limits still apply. Other event/record types retain the 4 MiB ceiling. Source,
read-byte, event, deadline, sequence, identity, terminal, hash and descriptor
checks are unchanged. Invalid bootstrap records are refused, never skipped.

This is a narrowly scoped legacy resource-policy exception. It needs the usual
security/durability review before integration. No canonical file, source digest,
compaction reference or recovery evidence is rewritten to enable recovery.

Only an existing `line_byte_limit` quarantine whose exact recorded source digest
and size still match may be resolved automatically. The incident must point to
an oversized valid session_configured record in that root session; descriptor-
pinned two-pass strict replay runs inside the repair transaction. Original
incident evidence stays immutable, and the confirmed digest and resolution
reason are recorded. Changed, corrupt, live, foreign and unavailable sources
remain quarantined. The compatibility repair scan is bounded to 32 candidates
and the existing 30-second startup deadline.

Recovery performance keeps the same source proof. Per-source sequence bounds
are computed once from the already checked projection rows; every binding's
run/session/epoch checks remain. Strict validation normalizes decoded JSON
without serializing and parsing it a second time. A digest-anchored second pass
may reuse JSON key/schema validation only with an in-process full-validation
proof issued by that same validator. A digest or a lookalike proof supplied by
a caller does not grant this reuse. The final source digest, source identity,
sequence/lifecycle/compaction checks and transaction boundary still apply.

Canonical SQLite projection upserts every replayed field in physical row order,
rejects a foreign thread binding and duplicate/out-of-order producer rows, and
removes any stale tail in the same transaction. Unchanged cache rows keep their
original import timestamp; the source's backfill receipt records this complete
revalidation. An fsynced exact-file/build marker permits admission recovery to
reuse that already committed projection. A changed source or build invalidates
the marker, as before.
