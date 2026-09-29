# Delegation handoffs and exact results

`spawn_agent` accepts either `message` (an inline task) or `message_ref` (a reference to the calling session's active human message). `task_name` remains required. A reference avoids generating the task text again in the parent's tool-call output.

```json
{
  "task_name": "extract_records",
  "message_ref": {
    "source": "current_user_message",
    "after": "<task>\n",
    "before": "\n</task>"
  }
}
```

Without delimiters, Core copies the whole current human message. Delimiters are literal, must each appear exactly once, and are excluded from the copy. The selected text, including whitespace and JSON escapes, is passed unchanged to the existing delegation path. Each delimiter is limited to 1,024 UTF-8 bytes; the expanded task is limited to 256 KiB. Empty, reversed, unavailable or oversized references return a validation error before any child starts. The source must belong to the calling session's active human turn. It cannot name another session, a file, a tool result or an old conversation turn. For file context, include permitted paths for the child to read.

References do not expand permissions or budgets. Routing, provider consent, child depth, sandbox, tools, context admission and cost controls apply to the resolved task just as they do to an inline message. The configured provider output cap remains in effect. A truncated argument stream closes with `tool_arguments_truncated`, `retryable: true`, `executed: false`; bounded recovery asks for a complete call using a reference, rather than continuing partial JSON. Invalid native argument JSON also uses the bounded tool-correction path.

When the user explicitly requires delegation, the parent should spawn before doing the child's assigned work and may wait for a single blocking task. Unambiguous imperative requests also select `spawn_agent` on the initial provider request, when that tool is available in execution mode. Ordinary requests retain the local-work preference. Goal and workflow delegation requirements take precedence over the default sidecar guidance; swarm routing retains its existing enforcement.

The non-interactive completion gate excludes requested exact output formats (such as JSON only or a verbatim child answer) before quoting or truncating the task. This fixes [#2798](https://github.com/tetsuo-ai/agenc-core/issues/2798): no Markdown checklist is injected and the original final answer remains unchanged. This exclusion is not a claim that the answer is correct. Ordinary artifact/prose verification retains the existing gate.

Child notification payloads serialize final text as JSON strings; decoding restores the original text, including quotes, Unicode and notification delimiters. `wait_agent` preserves mailbox text without trimming it. No wrapper or checklist is added to a requested verbatim final answer.

Notifications keep exact final text inline up to 8 KiB. Larger final answers are omitted from the bounded notification, rather than cut into invalid JSON. Completed notifications include `result_ref: {"agent_id": "…", "turn_id": "…"}`. Pass this reference to `wait_agent` to retrieve `text` in pages of at most 8,192 UTF-16 code units, then repeat with `offset: next_offset` until `complete` is true. Concatenate the decoded strings without a separator. `terminal.completedWork` remains a bounded diagnostic summary and is not the exact final answer. A reference is authorized only for the direct parent and the immutable completed child turn; durable retrieval uses the existing journal lineage validation and byte/time bounds. It cannot open caller-supplied paths or restart a child.

The tool schema addition is backward compatible with existing inline calls. There is no Desktop event/RPC schema change or required Desktop pin; clients discover the new tool field from a Core build containing this change.
