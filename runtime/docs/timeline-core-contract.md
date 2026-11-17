# Timeline Core contract

Built on Core 0.19.37, commit e22b6bee82e9. This implements C5, C1, C2, C4, C6 and C3 from the timeline1 design, in that commit order. Marketplace code and `session_usage` are unchanged.

## Negotiation

The existing `initialize` response advertises these boolean capabilities:

| Capability | Request |
|---|---|
| `turn.failure.v1` | Set the same capability to `true` in `initialize.params.capabilities`. |
| `turn.usage.v1` | Set the same capability to `true` in `initialize.params.capabilities`. |
| `transcript.tools.v3` | Call `session.transcript.v2` with `{sessionId, schemaVersion: 3}`. |
| `transcript.plans.v3` | The same v3 request includes optional plan and to-do state. |
| `tool.progress.shell.v1` | Set the capability to `true`, then set `includeToolProgress: true` on `message.send` or `message.stream`. |
| `turn.changes.v1` | Set the capability to `true`, then set `turnChanges: {includeDiff?: boolean}` on the prompt request. |

Use capabilities, never runtime version strings. Set them on the session's turn connection. No new polling call is needed. The SDK accepts `session.transcriptV2({schemaVersion: 3})`, `prompt(..., {includeToolProgress: true})` and `prompt(..., {turnChanges: {includeDiff: true}})`. The SDK connection still needs the matching initialize capabilities.

## C5: failure advice

`event.session_event.params.event` keeps its existing identity and payload. A capable connection receives:

```ts
{ type: "turn_failed", payload: {
  turnId: string, code: string, message: string,
  // Existing optional fields remain.
  retryable: boolean,
  sessionUsable: boolean
} }
```

Explicit producer advice takes precedence. Transport/provider and empty-response failures can be retried. Budget and iteration limits do not suggest an immediate retry. Background-agent terminal failures and known closed/corrupt sessions are marked unusable. Advice never retries, changes limits, or changes session authority. Old connections receive neither new field.

## C1: turn usage

The canonical `turn_complete.payload` gains `usage`. The notification bridge carries it in `event.agent_status.params.turnEvent.payload.usage` for ordinary completed turns. Session-only completions carry it in the usual nested session event.

```ts
usage: {
  input?: number, output?: number, cached?: number, reasoning?: number,
  costUsd?: number, billedEstimateUsd?: number, planCalls?: number
}
```

Token counters sum this session turn's reported `token_count` events. A counter is omitted if a call did not report it. Cache and reasoning counters follow provider reporting. They can overlap input/output, so do not blindly add them to those totals. Costs and plan calls are differences of the direct admission summaries captured at turn entry and completion. They exclude descendants and unresolved holds. Known billed cost excludes conservative unknown-price estimates. `billedEstimateUsd` retains the admission ledger's off-peak display meaning. Plan calls can report zero cost and a positive `planCalls` count.

Missing values stay absent. Accounting read failures cannot fail a turn. Resumed turns return an empty usage object because this implementation has no persisted baseline from their original start. It does not mislabel the resumed segment as the entire turn. Earlier unresolved or estimated costs can conservatively suppress a later turn's cost. `session_usage` is neither rewritten nor repriced. Old connections have `usage` removed from completion notifications.

## C2 and C4: snapshot v3

The RPC name remains `session.transcript.v2`. Its default response stays schema version 2. An explicit `schemaVersion: 3` request returns the same base fields plus:

```ts
{
  schemaVersion: 3,
  turns: Array<{
    turnId: string,
    toolCalls: Array<{
      callId: string, toolName: string,
      inputDigest: Record<string, string>,
      isError?: boolean, durationMs?: number
    }>,
    plan?: {
      planItemId: string, title: string, text: string,
      state: "running" | "done", truncated?: boolean
    },
    todos?: Array<{text: string, state: "pending" | "running" | "done"}>,
    todosTruncated?: boolean
  }>,
  turnsTruncated?: boolean
}
```

`inputDigest` selects command, cmd, path, file_path, url, pattern, query and description. Each value is at most 512 characters. All values together are at most 1,024 characters. Inputs above 64 KiB or invalid JSON produce an empty digest. It never includes file contents, replacement text or tool outputs. Unfinished calls omit result status and duration.

The projection keeps at most 128 turns and 128 calls per turn. The entire `turns` JSON is capped at 128 KiB by dropping older turns. It reports `turnsTruncated`. It follows the visible transcript boundary. Ordinary v2 messages, results and notices keep their existing retention policy.

A plan is the latest streamed plan item in that turn. The legacy `TodoWrite-<turnId>` prose mirror is excluded from v3 and from live notifications on connections that negotiate `transcript.plans.v3`. It can contain an empty list even when the tool supplied items. The successful tool call already carries the real structured list, so suppressing the mirror avoids duplicate and misleading cards. Other plan prose and all legacy notifications remain unchanged. Final text replaces deltas. Text is capped at 16,384 characters. Prose is retained as prose, rather than inventing structured steps. To-do lists come from successful `TodoWrite` calls. Failed or denied calls do not replace the latest list. A list has at most 128 items, each with at most 512 characters. An empty successful list is meaningful. This is a concrete extension of the design's unspecified C4 snapshot field.

## C6: command progress

For a connection that negotiates `tool.progress.shell.v1`, progress is delivered only while its opted-in prompt is active. Session and client message identity must match.

```ts
{ type: "tool_progress", payload: {
  callId: string, toolName: string, chunk: string,
  // Existing stream/process/timestamp fields are retained.
  outputDropped?: true
} }
```

Shell names are Bash, PowerShell, exec_command, write_stdin and their system-prefixed forms. Each chunk is capped at 4,096 characters. A call has a 65,536-character total cap. A truncated chunk sets `outputDropped` and ends progress for that call. At most 256 calls are tracked per prompt. Cleanup runs on success and failure.

Opted-in turns publish command chunks during collection. The collector subscribes without draining the final tool output. It caps live delivery at 256 chunks and 65,536 characters per collection, with at most 4,096 characters per chunk. The one-shot loop also publishes tool lifecycle events immediately for opted-in turns. Without the flag, collection and one-shot event timing stay unchanged.

Compatibility detail: release 0.19.37 already broadcasts generic `tool_progress` session events. That legacy traffic remains unchanged for connections that do not negotiate the new capability. The new opt-in rules apply to the negotiated prompt stream. Removing the legacy broadcast would violate the task's old-client compatibility requirement.

## C3: filesystem changes

The event is delivered before the normal canonical turn terminal event:

```ts
{ type: "turn_changes", payload: {
  turnId: string,
  from: "checkpoint",
  files: Array<{
    path: string,
    op: "created" | "modified" | "deleted",
    added: number, removed: number,
    binary?: true
  }>,
  diff?: string,
  diffTruncated?: true,
  skipped?: true,
  note?: string
} }
```

Paths are workspace-relative. Renames appear as deletion plus creation. Binary changes use `binary: true` and zero line counts. Do not interpret those zeroes as an unchanged file. Diffs contain valid unified hunks, including missing-newline markers. The comparison strips common prefixes and suffixes. It does not claim to produce a minimal edit script.

The snapshot uses a read-only worker. It never invokes Git or writes a snapshot into the workspace. Git HEAD, branches and index are not changed. Non-Git folders work. Shell edits are visible because the comparison reads actual files before and after the turn.

Bounds per scan: 1 second of worker scan time, a 2-second parent deadline, 10,000 entries, 2,000 files, depth 32, 256 KiB per file and 8 MiB of file contents. Worker old-generation memory is capped at 48 MiB. At most 256 changed paths are returned. Paths above 512 characters cause a skip. Requested diff text is capped at 64 KiB at complete patch boundaries. Workers terminate after collection.

The scan excludes Git metadata, agent state, dependency/build directories, symlinks and common credential filenames. It refuses filesystem roots, the user's home, and protected agent/key directories as workspace roots. A limit, read error or unstable file causes `{files: [], skipped: true, note}`. This means unavailable, not no changes. The normal note explains exclusions and possible concurrent external edits. The comparison attributes a time interval, not sole authorship. Reconnect does not reconstruct a lost in-memory before snapshot.

## Verification

All tests run offline, one file at a time at nice 19. Runtime typechecking uses a HEAVY slot with at least 10 GiB MemAvailable. No build or full suite was run.

New tests: `timeline-failure`, `timeline-usage`, `timeline-transcript-v3`, `timeline-plans`, `timeline-progress`, `timeline-changes` and `timeline-wire-parity`, under `runtime/tests/app-server/`. They exercise both old and new protocol clients for every capability. The workspace tests cover shell writes, non-Git folders, applicable patches, Git HEAD/index preservation, exclusions and caps.

Existing checks passed: transcript-v2 contract, turn-terminal contract, run-turn usage propagation, workflow turn boundaries, SDK protocol drift, and generated SDK type parity.

The offline wire fixture was also run against a source archive of release `e22b6bee82e9`. All four DeepSeek request hashes match. Raw requests also match with timeline options off and on, including a tool result and a second user turn. No serialized request is normalized before comparison.

| Fixture | SHA-256 |
|---|---|
| Simple turn | `7ea6da6cd3c3af845327133d574617ef4cc6d59fae509a35dc8c1950bd97db64` |
| Tool request | `4888ac65a07dd83f3e7b84768bd3c45edfe34f4ebe2c67e216270888cf0f88c5` |
| Tool result follow-up | `9843ba1a022fd752d741f00ca659cf607cc1b69aba7ce5c943badaa89a8a4546` |
| Second user turn | `dbcde16a3a4b69cae3d0fd606ae5b00658996e1e5fc821d93fa554570e791434` |

## Desktop decisions

- Enable the live capabilities on the existing per-session connection. Request v3 only when advertised.
- Read completion usage from the nested turn event. Keep the current estimated fallback when fields are absent, including resumed turns. Keep billed estimates labelled as estimates.
- Treat plan prose and structured to-do lists as separate optional state. Decide whether to show both or prefer one card.
- Show truncation and skipped-checkpoint notes. Decide whether to request diffs for every turn or only when a diff surface is enabled before submission.
- Keep legacy progress mapping for old daemons. Negotiated progress requires both the connection capability and prompt flag.
