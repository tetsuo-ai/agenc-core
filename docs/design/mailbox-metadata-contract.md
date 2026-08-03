# Bounded mailbox metadata construction

Status: E3a foundation contract. The decoder, builder, authenticated handle,
serializer, and accessors are implemented. Mailbox caller cutover is deliberately
deferred to E3b.

## Boundary

`runtime/src/agents/mailbox-metadata.ts` is the only module allowed to create a
`ValidatedMailboxMetadata` handle. It authenticates handles through private
`WeakMap` identity, so checking an unknown value is O(1) and never enumerates
that value. A TypeScript assertion, copied property, symbol, prototype, getter,
or proxy cannot manufacture the runtime brand.

E3a does not change `Mailbox.send`, its public `SendResult`, or any caller. Until
E3b lands, existing raw-object ingress remains unchanged and does not implicitly
receive the protections described here.

## Fixed limits

| Limit                             |     Value | Accounting convention                                                            |
| --------------------------------- | --------: | -------------------------------------------------------------------------------- |
| `MAX_MAILBOX_METADATA_DEPTH`      |        64 | The metadata root object is depth 1; only containers increase depth              |
| `MAX_MAILBOX_METADATA_NODES`      |    10,000 | Root plus every array element or own object-property value                       |
| `MAX_MAILBOX_METADATA_UTF8_BYTES` | 1,048,576 | Exact retained serialized metadata bytes; decoder raw bytes use the same ceiling |

These limits are compatibility contracts. They may change only with committed
boundary tests and scaling evidence. Existing mailbox envelope limits can be
stricter and remain independently authoritative after E3b.

## Construction paths

There are exactly two paths:

1. `MailboxMetadataDecoder` consumes `Uint8Array` chunks with a fatal streaming
   UTF-8 decoder. It checks the raw-byte ceiling before parsing a chunk, retains
   lexical state across chunk boundaries, rejects duplicate keys, and accepts
   one JSON object with no trailing token. An optional `AbortSignal` is checked
   between deterministic operations.
2. `MailboxMetadataBuilder` accepts only `beginObject`, `beginArray`, `key`,
   `scalar`, `endObject`, and `endArray` operations. `scalar` accepts JSON null,
   strings, booleans, and finite numbers. It never accepts a prebuilt object or
   container.

Both paths feed the same iterative construction and serialization state
machine. It checks depth and node capacity before allocating the next owned
container. It accounts for punctuation, keys, escaping, canonical number text,
and UTF-8 bytes while applying each operation.

## Owned representation

Accepted objects have null prototypes. Accepted arrays keep their array exotic
identity but have their prototype explicitly set to null. Every object key,
including `__proto__`, `constructor`, and `prototype`, is installed with an own
data descriptor. Containers are frozen when they close.

The exported array type exposes only its readonly `length` and numeric indexes.
It intentionally does not promise inherited `Array` methods or iteration,
because those members do not exist on the null-prototype runtime value.

The state machine serializes metadata iteratively without consulting inherited
`toJSON` hooks. Canonical bytes use ECMA own-key order: canonical uint32 index
keys below `2^32 - 1` are emitted numerically, followed by all other strings in
accepted order. Array element order is unchanged. This makes retained bytes
agree with the exposed ordinary-object graph while normalizing JSON number and
escape spellings. Integer-index ordering uses bounded fixed-pass radix work, so
final serialization remains linear in nodes plus serialized bytes. The private
record retains those bytes and the immutable graph. `getMailboxMetadataBytes`
returns a defensive byte copy; `getMailboxMetadataValue` returns the frozen
graph.

## Diagnostics and aborts

Validation and capacity failures use this closed reason vocabulary:

`unbranded`, `syntax`, `utf8`, `duplicate_key`, `depth`, `nodes`, `bytes`, and
`non_json`.

Abort is control flow rather than malformed input. It throws
`MailboxMetadataAbortedError` with stable code `MAILBOX_METADATA_ABORTED`; an
untrusted `AbortSignal.reason` is not copied into the error.

## E3b cutover and rollback

E3b must migrate protocol decoders and trusted internal callers to one of the
two constructors, change mailbox metadata input types to the authenticated
handle, and map rejected/unbranded values to the existing public `"dropped"`
result plus an internal reason. It must not add a raw-object convenience adapter
or enumerate an unbranded value.

Rollback before E3b is deletion of this unused foundation module. Rollback after
cutover is to stop new metadata-producing paths while retaining the bounded
decoder for already versioned wire/storage inputs; it is never permission to
restore reflective raw-object validation.

## Verification

The dedicated test covers exact and plus-one byte limits for escaped controls,
CJK, emoji, and long keys; hostile reflection surfaces; incremental syntax and
UTF-8 cases; prototype poisoning; integer-index boundary ordering; deterministic
abort; and seeded differential construction. Run the scaling evidence with:

```bash
npx tsx runtime/benchmarks/mailbox-metadata-scaling.ts --check
```

The benchmark reports median and median absolute deviation for named-key and
reverse-integer-key builders, the decoder, and private-brand checks. `--check`
enforces each builder/decoder linear envelope and a small-versus-boundary O(1)
relative-cost envelope for private brand admission with fixed operation counts.
