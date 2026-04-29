# Sequence Diagrams

Mermaid swimlane diagrams for every critical data path.

---

## 1. Turn lifecycle (happy path)

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant CLI as bin/agenc.ts
  participant TUI as tui/*
  participant Session as session/Session
  participant RunTurn as session/run-turn.ts
  participant Prep as phases/prepare-context
  participant Compact as llm/compact/*
  participant Stream as phases/stream-model
  participant Provider as llm/provider factory<br/>→ active Provider adapter<br/>(Provider default)
  participant Exec as phases/execute-tools
  participant Tools as tools/StreamingToolExecutor
  participant Permissions as permissions/evaluator
  participant Commit as phases/commit
  participant EventLog as session/event-log

  User->>CLI: argv prompt (or TUI input)
  CLI->>Session: new Session(config)
  CLI->>RunTurn: runTurn(session, prompt)
  RunTurn->>EventLog: emit TurnStarted

  loop while not complete
    RunTurn->>Prep: prepareContext(turnState)
    Prep->>Compact: autoCompactIfNeeded(history)
    Compact-->>Prep: compactedHistory (maybe)
    Prep-->>RunTurn: messagesForQuery

    RunTurn->>Stream: streamModel(turnState, provider)
    Stream->>Provider: chatStream(messages, onChunk)
    Provider-->>Stream: tokens + toolCalls
    Stream->>Tools: addTool(toolBlock) during stream
    Stream-->>RunTurn: assistantMessages + toolUseBlocks

    RunTurn->>Exec: executeTools(turnState, tools)
    Exec->>Permissions: evaluate(tool, args, ctx)
    Permissions-->>Exec: {allowed, requiresApproval}

    alt requiresApproval
      Exec->>TUI: ApprovalOverlay
      TUI->>User: prompt
      User->>TUI: allow|reject
      TUI-->>Exec: decision
    end

    Exec->>Tools: dispatch + await results
    Tools-->>Exec: toolResults (in order)
    Exec->>EventLog: emit ToolCallEnd per tool

    alt has toolResults
      RunTurn->>RunTurn: re-enter (continue site)
    else stop conditions met
      RunTurn->>Commit: finalize(turnState)
      Commit->>EventLog: emit TurnComplete
    end
  end

  RunTurn-->>CLI: final assistant text + usage
  CLI-->>User: render output
```

---

## 2. Post-sample recovery ladder

```mermaid
sequenceDiagram
  autonumber
  participant RunTurn as session/run-turn
  participant Recovery as phases/post-sample-recovery
  participant Withhold as recovery/withhold-cascading
  participant Tombstone as recovery/tombstone
  participant Collapse as recovery/collapse-drain
  participant Reactive as recovery/reactive-compact
  participant Tokens as (max output tokens policy)
  participant StopHook as phases/stop-hooks
  participant Fallback as recovery/fallback-ladder
  participant Tools as tools/streaming-executor.ts
  participant Provider as llm/provider factory<br/>→ active Provider adapter<br/>(Provider default)

  RunTurn->>Recovery: post-stream (assistantMessages, error?)
  Recovery->>Fallback: acquire session.recoveryInFlight lock (I-62)
  Fallback-->>Recovery: lock acquired (or queued)
  Recovery->>Fallback: recoveryReentryCount < MAX_RECOVERY_REENTRIES? (I-42)
  alt cap exhausted
    Recovery-->>RunTurn: error:'recovery_loop' + surface terminal
  end

  alt pendingBudgetDecision.kind === 'stop' (I-22 mid-stream)
    Recovery-->>RunTurn: transition=token_budget_continuation (reset hasAttemptedReactiveCompact)
  end

  alt FallbackTriggeredError (model fallback)
    Recovery->>Tombstone: yield missing tool_results
    Recovery->>Tools: discard + recreate StreamingToolExecutor
    Recovery->>Provider: swap to fallback model
    Recovery-->>RunTurn: transition=model_fallback → continue (981)
  end

  alt isWithheld413 (prompt too long)
    Recovery->>Withhold: check cascading gates
    Withhold-->>Recovery: proceed
    alt not yet collapse-drained
      Recovery->>Collapse: recoverFromOverflow()
      Collapse-->>Recovery: {committed, messages}
      Recovery-->>RunTurn: transition=collapse_drain_retry (1147)
    else already drained
      Recovery->>Reactive: tryReactiveCompact()
      Reactive-->>Recovery: compactedMessages OR noop
      alt compacted
        Recovery-->>RunTurn: transition=reactive_compact_retry (1198)
      else exhausted
        Recovery->>StopHook: executeStopFailureHooks()
        Recovery-->>RunTurn: surface error + return {reason:'prompt_too_long'}
      end
    end
  end

  alt isWithheldMedia (image/PDF too large)
    Recovery->>Reactive: tryReactiveCompact() (skips collapse)
    Reactive-->>Recovery: noop OR compactedMessages
    alt compacted
      Recovery-->>RunTurn: transition=reactive_compact_retry
    else exhausted
      Recovery-->>RunTurn: surface + return {reason:'image_error'}
    end
  end

  alt isWithheldMaxOutputTokens
    alt first attempt (8k default)
      Recovery->>Tokens: set maxOutputTokensOverride=64k
      Recovery-->>RunTurn: transition=max_output_tokens_escalate (1254)
    else 64k also exhausted
      Recovery->>Tokens: inject "Resume directly — no apology" meta message
      Recovery-->>RunTurn: transition=max_output_tokens_recovery (1286)
    else limit reached
      Recovery-->>RunTurn: surface + yield lastMessage
    end
  end

  alt stopHookBlocking (blockingErrors.length > 0)
    Recovery->>StopHook: inject blocking errors
    Note over Recovery: preserve hasAttemptedReactiveCompact<br/>("Resetting caused infinite loop")
    Recovery-->>RunTurn: transition=stop_hook_blocking (1341)
  end

  alt normal stream (no recovery)
    Recovery-->>RunTurn: proceed to execute-tools
  end
```

**Critical invariants encoded here:**

1. **Two-gate withhold**: `isWithheld413` AND `!transition.reason=collapse_drain_retry` both required before escalating to reactive compact.
2. **`hasAttemptedReactiveCompact` asymmetry**: reset on token-budget continuation (1369) but **preserved** on stop hook blocking (1332).
3. **API-error stop-hook guard**: `executeStopFailureHooks` only fires when `lastMessage?.isApiErrorMessage` — without this, tokens spiral.
4. **Executor ring flush**: both streaming fallback AND model fallback call `tools.discard()` + recreate. Missing either path leaks orphan `tool_use_id`s.

---

## 3. Compaction pipeline

```mermaid
sequenceDiagram
  autonumber
  participant Prep as phases/prepare-context
  participant Auto as llm/compact/autoCompact
  participant SessionMem as services/SessionMemory
  participant SMCompact as llm/compact/sessionMemoryCompact
  participant Compact as llm/compact/compact
  participant Strip as compact/stripImagesFromMessages
  participant Group as compact/grouping
  participant PromptT as compact/prompt
  participant Provider as llm/provider factory<br/>→ active Provider adapter<br/>(Provider default)
  participant Cleanup as compact/postCompactCleanup
  participant FileCache as tools/FileReadTool cache

  Prep->>Auto: autoCompactIfNeeded(messages, tracking)

  Auto->>Auto: shouldAutoCompact() threshold check
  Auto->>Auto: circuit-breaker: failures < 3?

  alt session memory available + not exhausted
    Auto->>SMCompact: trySessionMemoryCompaction()
    SMCompact->>SessionMem: extract recent context
    SessionMem-->>SMCompact: preserved context
    SMCompact-->>Auto: prunedMessages OR null
    alt pruned
      Auto-->>Prep: sessionMemoryCompactResult
    end
  end

  Auto->>Compact: compactConversation()
  Compact->>Strip: stripImagesFromMessages()
  Strip-->>Compact: text-only messages
  Compact->>PromptT: getCompactPrompt()
  PromptT-->>Compact: summarization prompt

  Compact->>Provider: queryModelWithStreaming()
  alt PROMPT_TOO_LONG on compaction itself
    Provider--xCompact: PTL error
    Compact->>Group: groupMessagesByApiRound()
    Group-->>Compact: grouped rounds
    Compact->>Compact: truncateHeadForPTLRetry() (drop oldest round)
    Compact->>Provider: retry (up to 3x)
    alt still failing
      Compact-->>Auto: error
    end
  end
  Provider-->>Compact: summary text

  Compact->>FileCache: clear readFileState
  Compact->>Compact: createPostCompactFileAttachments() (5 max, 50K budget)
  Compact->>Compact: createSkillAttachmentIfNeeded() (25K budget)
  Compact->>Compact: createPlanAttachmentIfNeeded()
  Compact->>Compact: async agent status + deferred schemas

  Compact->>Cleanup: runPostCompactCleanup()
  Cleanup->>Cleanup: clear microcompact state
  Cleanup->>Cleanup: clear memory-file cache
  Cleanup->>Cleanup: clear classifier approvals
  Cleanup->>Cleanup: clear system-prompt section cache

  Compact-->>Auto: compactionResult
  Auto-->>Prep: {messages: buildPostCompactMessages(), tracking}
```

---

## 4. Subagent spawn (worktree isolation)

```mermaid
sequenceDiagram
  autonumber
  participant Parent as Parent Session
  participant Delegate as agents/delegate.ts<br/>(legacy AgentTool adapter)
  participant Worktree as utils/worktree
  participant Git as git subprocess
  participant Control as agents/control.ts
  participant Registry as agents/registry
  participant Slots as spawn slots (Mutex)
  participant RunAgent as agents/run-agent.ts<br/>(behavior port)
  participant MCP as MCP servers
  participant Mailbox as agents/mailbox
  participant Status as watch::Sender<AgentStatus>
  participant ChildSession as Child Session

  Note over Delegate,Control: `delegate.ts` preserves the legacy AgentTool call surface only.<br/>Subagent lifecycle ownership lives in `agents/control.ts` + child `session/run-turn.ts`.

  Parent->>Delegate: invoke subagent tool (role, prompt, isolation=worktree)

  Delegate->>Slots: acquire slot (max_threads check)
  alt slots exhausted
    Slots-->>Delegate: reject
    Delegate-->>Parent: "too many concurrent agents"
  end

  Delegate->>Worktree: createAgentWorktree(slug)
  Worktree->>Worktree: validate slug [a-zA-Z0-9._-]+, max 64
  Worktree->>Git: findGitRoot()
  Git-->>Worktree: repo root

  alt worktree exists
    Worktree->>Git: read HEAD SHA (fast resume)
  else new worktree
    Worktree->>Git: git fetch <base>
    Worktree->>Git: git worktree add -B worktree-<slug> <path> <base>
    Worktree->>Git: sparse-checkout (if enabled)
  end
  Worktree-->>Delegate: {worktreePath, branch, gitRoot}

  Delegate->>Control: spawnAgentInternal(role, worktreePath)
  Control->>Registry: register agent (agentPath "/root/explorer/foo")
  Control->>Mailbox: create per-child mailbox
  Control->>Status: watch::Sender<AgentStatus>

  Delegate->>RunAgent: params {role, prompt, worktreePath, mailbox, tools, mcpConfig}

  RunAgent->>RunAgent: isAsync = run_in_background || agent.background || forceAsync
  RunAgent->>ChildSession: new Session(config, cwd=worktreePath)
  RunAgent->>MCP: init servers (30s wait)
  RunAgent->>RunAgent: run session-start hooks
  RunAgent->>ChildSession: runTurn(prompt)

  alt sync agent
    loop messages from child session
      ChildSession-->>RunAgent: yield (Assistant|User|Progress)
      RunAgent-->>Delegate: message
      Delegate-->>Parent: stream update
    end
  else async agent
    RunAgent->>Control: registerAsyncAgent + LocalAgentTask
    Control-->>Delegate: async_launched
    Delegate-->>Parent: returns immediately
  end

  ChildSession->>Mailbox: send progress/complete
  Mailbox->>Parent: (parent polls via Mailbox.drain())

  ChildSession-->>RunAgent: complete
  RunAgent->>MCP: shutdown servers
  RunAgent->>RunAgent: cleanup hooks, perfetto, caches, bash tasks

  Delegate->>Worktree: hasWorktreeChanges()
  Worktree->>Git: status + rev-list
  Git-->>Worktree: clean|dirty
  alt clean
    Delegate->>Worktree: removeAgentWorktree()
    Worktree->>Git: git worktree remove --force
    Worktree->>Git: git branch -D worktree-<slug>
  else has commits/dirty
    Delegate-->>Parent: present keep/remove choice (ExitWorktreeTool)
  end

  Delegate->>Slots: release slot
  Delegate->>Control: shutdownLiveAgent (cascade descendants, remove from registry)
  Status->>Status: set Completed|Errored|Shutdown|Interrupted
```

---

## 5. Transport ladder + reconnection

```mermaid
sequenceDiagram
  autonumber
  participant CLI as bin/agenc.ts
  participant Factory as transport/fallback-ladder
  participant Env as env vars
  participant WS as ws-duplex (WebSocketTransport)
  participant Hybrid as ws-post (HybridTransport)
  participant SSE as sse-post (SSETransport)
  participant Ingest as inputStream (PassThrough)
  participant Query as session/run-turn

  CLI->>Factory: getTransportForUrl(url)
  Factory->>Env: read AGENC_TRANSPORT + feature flags

  alt USE_CCR_V2=1
    Factory->>SSE: new SSETransport()
  else POST_FOR_SESSION_INGRESS=1
    Factory->>Hybrid: new HybridTransport()
  else default
    Factory->>WS: new WebSocketTransport()
  end

  Factory-->>CLI: transport
  CLI->>WS: setOnData(data => inputStream.write(data))
  CLI->>WS: setOnClose(() => inputStream.end())
  CLI->>WS: connect() (background, no await)

  loop normal operation
    Query->>WS: write(message)
    WS-->>Ingest: onData chunks
    Ingest-->>Query: inputStream reads
  end

  alt mid-stream connection drop
    WS->>WS: detect via 10s ping timeout OR 45s SSE frame liveness
    WS->>WS: backoff 1s → 30s ±25% jitter, 10min budget
    alt >60s gap (process sleeping)
      WS->>WS: reset budget
    end

    alt 4003 auth failure
      WS->>CLI: refreshHeaders() callback
      CLI-->>WS: new headers
    end

    WS->>WS: reconnect
  end

  alt connect fails after ladder
    Factory->>Factory: escalate: WS → Hybrid → SSE
    Factory-->>CLI: new transport (repeat setup)
  end
```

---

## 6. /plan mode + Shift+Tab cycle

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant TUI as tui/composer/PromptInput
  participant Keyb as tui/keybindings/defaultBindings
  participant State as AppState.toolPermissionContext
  participant Footer as tui/cockpit/PromptInputFooterLeftSide
  participant Evaluator as permissions/evaluator
  participant EPM as EnterPlanModeTool
  participant ExitTool as ExitPlanModeV2Tool
  participant Hook as background plan verification hook

  User->>TUI: Shift+Tab
  TUI->>Keyb: lookup binding "chat:cycleMode"
  Keyb->>State: cyclePermissionMode()
  Note right of State: default → acceptEdits → plan<br/>→ bypassPermissions → (auto) → default
  State-->>Footer: mode change
  Footer-->>User: indicator updated

  User->>TUI: submit prompt
  TUI->>Evaluator: hasPermissionsToUseTool(BashTool, args)
  Evaluator->>State: read mode
  State-->>Evaluator: mode='plan'
  Evaluator-->>TUI: deny (read-only exploration only)
  TUI-->>User: "blocked in plan mode — read-only"

  alt model calls EnterPlanModeTool
    TUI->>EPM: checkPermissions(mode !== 'plan')
    EPM->>State: transition
    State-->>Footer: mode=plan
  end

  alt model calls ExitPlanModeV2Tool
    TUI->>ExitTool: exit(planText, prePlanMode)
    ExitTool->>State: store prePlanMode
    ExitTool->>State: set mode = prePlanMode
    ExitTool->>State: hasExitedPlanModeInSession=true
    ExitTool->>Hook: background plan verification
  end
```

### 6a. Mid-execution permission mode change (T11 I-3)

This swimlane traces what happens when the user presses Shift+Tab
while a mutation tool is mid-flight. The I-3 guarantee is that a
stricter mode (e.g. transition into `plan`) must abort the in-flight
write before it commits, and the turn must propagate that abort as a
normal tool error rather than a silent success.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant TUI as tui/composer (Shift+Tab)
  participant Registry as permissions/mode.ts<br/>PermissionModeRegistry
  participant Exec as tools/execution.ts<br/>runToolUse
  participant Subs as mode-change subscribers<br/>(in-flight tool call)
  participant Evaluator as permissions/evaluator.ts<br/>checkModeGate (re-read getAppState)
  participant Abort as AbortController<br/>(per-invocation)
  participant Tool as mutation tool<br/>(e.g. Write, Bash)
  participant Turn as session/run-turn.ts

  Note over Exec,Abort: runToolUse() subscribes to mode changes<br/>for the lifetime of this tool call.
  Exec->>Registry: subscribeToModeChange(cb)
  Registry-->>Exec: unsubscribe handle

  User->>TUI: Shift+Tab
  TUI->>Registry: setMode(newMode)
  Registry->>Subs: fan out (newMode, oldMode)

  Subs->>Evaluator: checkModeStillAllowed(tool, newMode)
  Note right of Evaluator: step 2a re-reads context.getAppState()<br/>so the new mode is observed even if<br/>step 1c completed with the pre-change snapshot.
  Evaluator-->>Subs: stricter? (e.g. plan vs write-capable)

  alt stricter transition (e.g. → plan, tool mutates)
    Subs->>Abort: abortController.abort("mode_changed")
    Abort-->>Tool: signal fires
    Tool-->>Exec: rejects with AbortError
    Exec->>Exec: classify as aborted/mode_changed
    Exec->>Exec: release unsubscribe handle
    Exec-->>Turn: tool error {cause: "mode_changed"}
    Turn->>Turn: continue turn with aborted tool result
  else not stricter
    Subs-->>Exec: no-op (tool keeps running)
  end

  Note over Exec: On normal settle, the unsubscribe handle<br/>is always released so a later mode change<br/>does not reach a completed tool.
```

**Critical invariants encoded here:**

1. **Re-read at step 2a (I-3)**: the evaluator's `checkModeGate`
   calls `context.getAppState()` fresh at mode-check time rather
   than reusing the snapshot captured in step 1. This closes the
   Shift+Tab-after-rule-check race.
2. **Unsubscribe on settle**: `runToolUse` releases the mode-change
   subscription whether the tool completed, errored, timed out, or
   was aborted. A later mode change must never reach a finished
   tool call.
3. **Abort propagates as tool error**: the signal fires from the
   subscriber callback; the tool's own abort plumbing surfaces the
   rejection; `tools/execution.ts` classifies it and the turn
   continues with a proper tool error rather than a partial
   commit.

---

## 7. Tool execution with concurrency class

```mermaid
sequenceDiagram
  autonumber
  participant Stream as phases/stream-model (streaming model tokens)
  participant Exec as tools/StreamingToolExecutor
  participant Classifier as tools/concurrency.classify
  participant RwLock as tools/concurrency (AsyncRwLock)
  participant Execute as tools/execution.runToolUse
  participant Permissions as permissions/evaluator
  participant Hook as tools/hooks (pre + post)
  participant Bash as BashTool (sibling-abort trigger)
  participant Queue as pending progress queue

  Stream->>Exec: addTool(toolBlock, assistantMessage)
  Exec->>Classifier: classify(toolName, args)
  Classifier-->>Exec: ConcurrencyClass

  Exec->>Exec: processQueue()

  alt queue head is SharedRead
    Exec->>RwLock: acquire read lock
  else queue head is Exclusive
    Exec->>RwLock: acquire write lock (blocks all)
  end

  alt canExecuteTool (no executing OR all read + new is read)
    Exec->>Execute: executeTool(tool)
    Execute->>Permissions: evaluate(tool, args, ctx)
    Permissions-->>Execute: {allowed, requiresApproval}

    alt requiresApproval
      Execute->>Execute: await approval callback
    end

    Execute->>Hook: runPreToolUseHooks()
    Hook-->>Execute: updatedInput OR deny

    Execute->>Execute: tool.call(input)
    Execute->>Queue: push progress events

    alt tool.call throws (Bash only)
      Execute->>Bash: hasErrored=true
      Execute->>Exec: siblingAbortController.abort('sibling_error')
      Note over Exec: cascades to all siblings in batch
    end

    Execute->>Hook: runPostToolUseHooks()
    Execute-->>Exec: toolResult
  else blocked
    Exec->>Exec: wait for executing tool to yield
  end

  Stream->>Exec: getCompletedResults() (non-blocking)
  Exec->>Queue: yield pending progress (buffered)
  Exec->>Exec: scan tools[] in insertion order
  Exec-->>Stream: completed results in order (status → 'yielded')

  Stream->>Exec: getRemainingResults() (final drain async gen)
  Exec->>Exec: race executing promises + progressPromise
  Exec-->>Stream: all remaining results
```

---

## 8. Session resume (rollout reconstruction)

```mermaid
sequenceDiagram
  autonumber
  participant CLI as bin/agenc.ts
  participant Store as session/rollout-store
  participant Recon as session/rollout-reconstruction
  participant Session as session/Session
  participant EventLog as session/event-log
  participant TurnCtx as session/turn-context

  CLI->>Store: resolve session path (--resume <id> or latest)
  Store->>Store: read rollout-{ts}-{id}.jsonl

  Store->>Recon: reconstruct(rolloutItems)

  Note over Recon: Step 1: Reverse scan (newest → oldest)
  Recon->>Recon: find latest CompactedItem with replacement_history
  Recon->>Recon: capture previous_turn_settings from newest surviving user turn
  Recon->>Recon: capture reference_context_item (turn baseline)
  Recon->>Recon: count + skip rolled-back user turns

  Note over Recon: Step 2: Forward replay (oldest → newest suffix)
  loop each RolloutItem after compaction checkpoint
    alt ResponseItem
      Recon->>Recon: record into history
    else ThreadRolledBack
      Recon->>Recon: drop last N user turns
    else Compacted
      Recon->>Recon: use replacement_history OR fallback rebuild
    else EventMsg
      Recon->>Recon: skip (metadata only)
    end
  end

  Recon-->>Store: {history, previousTurnSettings, referenceContextItem}

  Store->>Session: initialize_with_history(ResumedHistory)
  Session->>EventLog: replay into reducer → SessionState
  Session->>TurnCtx: restore model, realtime_active, cwd
  Session-->>CLI: ready for user input

  Note over CLI: Session resumes at next user input.<br/>No auto-continue of incomplete turns.
```

### 8a. Session resume — orphan TurnStarted recovery (I-48)

```mermaid
sequenceDiagram
  autonumber
  participant Init as bin/agenc.ts init
  participant Store as session/rollout-store
  participant Recon as session/rollout-reconstruction
  participant Log as session/event-log

  Init->>Store: open(rollout) + readAll()
  Store-->>Init: rolloutItems[]

  Init->>Recon: reconstructFromRollout(items)
  Note over Recon: reverse scan + forward replay

  Note over Recon: Scan tracks seen TurnStarted ids<br/>and seen TurnComplete/TurnAborted ids
  alt turnId ∈ started but ∉ terminated (SIGKILL/OOM leftover)
    Recon->>Recon: synthesize turn_aborted{reason:'process_killed', turnId}
    Recon->>Recon: synthesize warning{cause:'orphaned_turn_recovered'}
  end

  Recon-->>Init: { history, orphanedTurnIds, synthesizedEvents }

  loop each synth event
    Init->>Log: session.emit(synth)
    Log->>Store: append (durable for turn_aborted ⇒ fsync)
  end

  Note over Init: Subsequent reads of the rollout file observe<br/>a consistent turn lifecycle.
```

---

## 9. Approval overlay lifecycle (T12 I-21 / I-44 / I-72 / I-90 + 200 ms grace)

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Evaluator as permissions/evaluator
  participant Queue as permissions/PermissionQueueOps
  participant Handler as tui/permissions/InteractiveHandler
  participant Classifier as permissions/classifier
  participant Modal as tui/permissions/ApprovalOverlay
  participant Keys as tui/keybindings/KeybindingContext
  participant Abort as session.abortController
  participant Session as session/Session

  Evaluator->>Evaluator: resolve behavior = 'ask' for tool call
  Evaluator->>Session: read activeTurn.turnId (I-44 stamp)
  Evaluator->>Queue: enqueue(PendingPermissionRequest{turnId, resolveOnce})
  Queue-->>Handler: App's Overlay consumer mounts InteractiveHandler

  Handler->>Session: activeTurn.unsafePeek().turnId
  alt request.turnId !== active turnId (I-44 / I-90)
    Handler->>Session: emit warning:stale_pending_dropped
    Handler->>Evaluator: resolveOnce.claim({behavior:'deny', source:'stale_pending_dropped'})
    Note over Handler: Unmount silently; modal never rendered
  else turn-ids match
    Handler->>Classifier: classifyYoloAction(request, signal)
    Note over Handler,Classifier: Race against 200 ms grace timer
    alt classifier returns {shouldBlock:false, unavailable:false} inside 200 ms
      Handler->>Session: emit warning:classifier_auto_approved
      Handler->>Evaluator: resolveOnce.claim({behavior:'allow', source:'classifier_auto_approved'})
      Note over Handler: Auto-approve; skip modal
    else timeout / unavailable / error / block
      Handler->>Modal: push(ApprovalOverlay)
      Modal->>Abort: subscribe to signal (I-21)
      Modal->>Keys: setActiveContext('modal') (I-72)
      Note over Modal,Keys: Composer bindings suspended
      alt user decision
        User->>Modal: Y / A / D / Esc
        Modal->>Handler: onResolve(decision)
        Handler->>Evaluator: resolveOnce.claim({behavior, source:'user'})
      else abort signal fires (Ctrl+C, shutdown) (I-21)
        Abort-->>Modal: abort event
        Modal->>Handler: onResolve({behavior:'abort'})
        Handler->>Evaluator: resolveOnce.claim({behavior:'abort'})
      end
      Modal->>Abort: unsubscribe
      Modal->>Keys: restore 'chat' context (I-72)
      Handler->>Modal: dispose overlay
    end
  end
```

Notes:

1. The I-44 stamp at step 2 and the I-90 stale-drop at step 4 are
   the same mechanism: the evaluator records `turnId` on the
   request; the handler compares it against `session.activeTurn`
   at mount. A turn switch (provider change via I-13, new prompt,
   recovery re-entry) between enqueue and mount trips the drop.
2. The 200 ms grace race runs **before** the modal mounts. T13 wires the
   live xAI-backed classifier path, so safe auto-approve decisions can now
   win the grace race before the modal appears.
3. Step 9's `setActiveContext('modal')` is the I-72 handoff: the
   underlying `Composer` stays mounted but stops consuming
   keystrokes until step 17 restores the `chat` context.
4. If the handler unmounts with an unresolved request (operator
   closes the UI abruptly), the unmount effect claims
   `{behavior:'abort', source:'component_unmounted'}` so the
   evaluator's awaiter cannot deadlock.
