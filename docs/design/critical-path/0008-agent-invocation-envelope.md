# CP-0008: Preserve trusted instructions and untrusted data end to end

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | CSV, workflow, and memory invocation producers plus session, fork, daemon-wire, and provider adapters (B1, B3, C3) |
| Compatibility | Versioned protocol; incapable adapters fail before spawn and mixed legacy prompts require authoritative reconstruction |

## Context

CSV row values, prior-agent output, artifacts, memory text, transcripts, and tool
results can contain delimiter-shaped or instruction-shaped data. Concatenating
them with runtime policy or approved task text lets data alter the syntax and
apparent authority of the request before it reaches a model. Escaping one prompt
template is not an end-to-end solution when delegation, persistence, fork,
daemon framing, or a provider adapter can flatten the content again.

## Decision

All affected agent starts use a provider-neutral, versioned
`AgentInvocationEnvelope`. Its logical shape is:

- `version: 1` and `kind: "agent_invocation"`;
- stable invocation identity and minimum reader version;
- an ordered `runtime_policy` block list;
- an ordered `task_instructions` block list;
- an ordered `untrusted_data` block list; and
- a domain-separated digest over the complete ordered envelope descriptors.

The three lists are separate typed fields, not a caller-supplied role string.
Each immutable block binds a stable block ID, content type and encoding, exact
byte length, SHA-256, source/provenance identity, and exactly one inline payload
or digest-bound artifact reference. Schema-generated types reject unknown roles,
fields, versions, content types, malformed encodings, duplicate block IDs, and
length/digest mismatch.

The envelope digest is SHA-256 over the ASCII domain separator
`agenc.agent-invocation.v1\0` followed by UTF-8 RFC 8785 canonical JSON of the
ordered envelope descriptors with the envelope digest itself omitted. Each
descriptor carries the exact payload or artifact digest and byte length, so the
envelope digest transitively binds content without flattening it.

### Authority and construction

- Runtime policy is generated only by the runtime policy owner.
- Task instructions are exact operator- or workflow-approved task text. A data
  producer cannot promote content into this list.
- Untrusted data includes CSV field substitutions, child/group results, artifact
  metadata/content, memory candidates, transcripts, and tool output. Producer
  metadata retains exact logical row/item/column, step/group, candidate, span,
  or artifact identity and digest.

Typed constructors, not arbitrary decoded objects, assign those authorities.
Every persistence and transport boundary revalidates the schema, block digests,
ordering, and provenance. Authorization to read a referenced artifact/root is
checked independently; possession of a reference does not grant access.

### End-to-end preservation

The envelope remains role-separated through job spawn, delegation, session and
thread persistence, fork/resume, daemon protocol, and every provider adapter.
An adapter may map the logical roles to provider-native channels or structured
content, but MUST preserve their privilege ordering and byte/digest identity. If
the provider or transport cannot do so, the invocation fails before child spawn
or model dispatch. It may not concatenate blocks and report equivalent safety.

Data serialization is length-delimited or serializer-generated; raw data never
constructs XML-like markers, JSON control members, template references, or
provider role messages. Resource ceilings apply to bytes, block count, per-block
size, referenced content, and the complete token-counted request before
dispatch. Diagnostics include safe IDs, roles, sizes, and digest prefixes, never
raw payloads.

This contract prevents syntactic authority escalation inside AgenC. It does not
claim that a model will never follow malicious instructions found in correctly
marked data. Adversarial outcome evaluation and least-authority tools remain
required.

### Producer-specific requirements

- CSV keeps approved job/template literals in `task_instructions`; every exact
  row substitution is an `untrusted_data` block with column, row/item identity,
  and digest.
- Workflow keeps approved step policy/message separate from child output,
  bounded extracts, and CP-0007 artifact references. Arbitrary logical IDs are
  structured metadata, not template syntax.
- Memory selection policy and candidate-ID allowlist remain privileged; memory
  headers and bodies are untrusted candidate blocks. A model may return only
  allowlisted IDs through a validated structured result.
- Compaction uses the same authority rule for immutable policy versus transcript,
  tool output, and prior summaries even when its request schema is specialized.

## Migration and rollout

Land strict envelope readers, schemas, generated protocol/SDK types, and
provider capability declarations before writers. Migrate invocation producers
and session/fork/wire/provider consumers as one observable compatibility program,
then remove the single `taskPrompt`/`workerPrompt` and fork-context concatenation
paths.

A legacy trusted-only task may be converted only when authoritative metadata
proves it contains no merged data. A persisted flattened prompt containing mixed
policy/task/data is resumable only when separate durable source records prove
every original role, order, byte range, and digest. Otherwise it becomes
non-resumable/unknown for operator review. Delimiter parsing or heuristic text
classification is never migration evidence.

## Rollback

Rollback disables affected spawn/resume paths and retains versioned envelope
records for the minimum compatible reader. It never hands a new envelope to an
older reader, silently drops untrusted blocks, or restores flattening. Existing
ambiguous legacy tasks remain non-executable until reviewed or authoritatively
reconstructed.

## Alternatives rejected

- Escaping only the final prompt template.
- Trusting a caller-provided `role` field on an otherwise unvalidated object.
- Flattening blocks for providers that lack a required channel.
- Recovering legacy trust boundaries by scanning delimiters or instruction text.
- Treating syntactic separation as proof of model-level injection immunity.

## Verification obligations

Round-trip every envelope through delegation, persistence, fork/resume, daemon
framing, and each provider adapter while preserving role, order, exact bytes,
length, digest, and provenance. Capability-disabled adapters MUST reject before
spawn. Bit flips, reordered/duplicated blocks, unknown roles/versions, forged
provenance, unauthorized references, and limit overflow fail closed.

Adversarial row, child, memory, transcript, and tool text closes delimiters,
imitates policy, embeds JSON, and names template tokens; none changes serialized
policy/task fields. Legacy mixed-prompt fixtures remain blocked unless their
authoritative source records reconstruct every boundary. Separate behavioral
evaluation measures semantic model susceptibility without weakening this
structural gate.

Primary references: [The Instruction Hierarchy](https://arxiv.org/abs/2404.13208)
and [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).
