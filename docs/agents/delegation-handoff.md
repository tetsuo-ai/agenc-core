# Delegation handoffs and exact results

`spawn_agent` accepts either `message` (an inline task) or `message_ref` (a reference to the calling session's active human message). `task_name` remains required. A reference avoids generating the task text again in the parent's tool-call output.

```json
{
  "task_name": "extract_records",
  "exact_output": true,
  "message_ref": {
    "source": "current_user_message",
    "after": "<task>\n",
    "before": "\n</task>"
  }
}
```

Without delimiters, Core copies the whole current human message. Delimiters are literal, must each appear exactly once, and are excluded from the copy. The selected text, including whitespace and JSON escapes, is passed unchanged to the existing delegation path. Each delimiter is limited to 1,024 UTF-8 bytes; the expanded task is limited to 256 KiB. Empty, reversed, unavailable or oversized references return a validation error before any child starts. The source must belong to the calling session's active human turn. It cannot name another session, a file, a tool result or an old conversation turn. For file context, include permitted paths for the child to read.

References do not expand permissions or budgets. Routing, provider consent, child depth, sandbox, tools, context admission and cost controls apply to the resolved task just as they do to an inline message. The configured provider output cap remains in effect. A truncated argument stream closes with `tool_arguments_truncated`, `retryable: true`, `executed: false`; bounded recovery asks for a complete call using a reference, rather than continuing partial JSON. Invalid native argument JSON also uses the bounded tool-correction path.

Delegation intent is prompt guidance only: the model decides whether to call `spawn_agent`. Request wording never forces tool selection or automatically starts a child. The model must respect approval prerequisites and conditions, including those in another sentence; quoted examples and programming terms such as worker threads or React children props do not authorize delegation. When the user explicitly requires delegation and its prerequisites are satisfied, the parent should spawn before doing the child's assigned work and may wait for a single blocking task. Ordinary requests retain the local-work preference. Goal and workflow delegation requirements take precedence over the default sidecar guidance; swarm routing also provides prompt guidance without forcing tool selection.

The completion gate skips its checklist only for an explicit machine-readable output setting: headless CLI `--output-format json` or `stream-json`, a session caller's `runtimeOptions.exactOutput`, or a turn caller's `exactOutput`. It never infers this setting from natural-language text. Ordinary chat, including requests mentioning JSON, retains the gate behavior on main. Existing exclusions for child, plan, autonomous and interactive turns remain unchanged.

Parents needing verbatim JSON or another exact machine-readable child answer should set `exact_output: true` on `spawn_agent` or `assign_task`. The flag is scoped to that child task and does not exempt the parent's ordinary chat turn. Every child result is delivered verbatim regardless of the flag. These exemptions do not establish answer correctness.

Child notification payloads serialize final text as JSON strings; decoding restores the original text, including quotes, Unicode and notification delimiters. `wait_agent` preserves mailbox text without trimming it. No wrapper or checklist is added to a requested verbatim final answer.

Notifications keep exact final text inline up to 8 KiB. Larger final answers are omitted from the bounded notification, rather than cut into invalid JSON. Completed notifications include `result_ref: {"agent_id": "…", "turn_id": "…"}`. Pass this reference to `wait_agent` to retrieve `text` in pages of at most 8,192 UTF-16 code units, then repeat with `offset: next_offset` until `complete` is true. Concatenate the decoded strings without a separator. `terminal.completedWork` remains a bounded diagnostic summary and is not the exact final answer. A reference is authorized only for the direct parent and the immutable completed child turn; durable retrieval uses the existing journal lineage validation and byte/time bounds. It cannot open caller-supplied paths or restart a child.

A reusable worker caches at most 1 MiB of completed result storage, including keys and entry overhead. Least recently read results are evicted; oversized results stay journal-only. Result references retrieve evicted answers from the validated journal without collecting unrelated task answers.

The tool schema addition is backward compatible with existing inline calls. The optional runtime output setting and tool fields require no Desktop pin; clients discover the new tool field from a Core build containing this change.
