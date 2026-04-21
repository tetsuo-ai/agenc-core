# AgenC Rebuild Plan — Documentation Index

This directory is the single source of truth for the AgenC rebuild.
Every file/feature being taken from `../openclaude` (TypeScript) or
`../codex` (Rust) is enumerated here. No surprises.

| Document | Purpose |
|---|---|
| [`invariants.md`](invariants.md) | **7 design invariants (I-1..I-7)** that close design holes exposed by the flowchart. Every tranche references these; violating one is a bug. |
| [`provider-matrix.md`](provider-matrix.md) | **9 providers × capability grid** + per-provider auth + wire-format clusters. Grok default; everything else in scope. |
| [`openclaude-inventory.md`](openclaude-inventory.md) | Every openclaude file we port 1:1, dependencies, LOC, destinations |
| [`codex-inventory.md`](codex-inventory.md) | Every codex file we hand-port Rust→TS, per-file TS destination, `mod.rs` breakdown |
| [`architecture.md`](architecture.md) | Mermaid component diagram, module boundaries, provider abstraction layer |
| [`sequence-diagrams.md`](sequence-diagrams.md) | Turn swimlane, recovery ladder, compaction, subagent spawn, /plan mode, session resume |
| [`feature-matrix.md`](feature-matrix.md) | Every feature (slash commands, /plan, modes, memory, MCP, …) with source + status + destination |
| [`translation-conventions.md`](translation-conventions.md) | Rust→TS mapping rules (`Arc<Mutex>`, `mpsc`, `Result`, `match`, lifetimes) |
| [`agentic-loop.html`](agentic-loop.html) | Interactive mermaid flowchart — the whole architecture on one page |
| [`codex-runtime-replacement.md`](codex-runtime-replacement.md) | Replacement-first migration plan: AgenC ports the live runtime/session kernel from codex; openclaude remains behavior source only |

## Summary

- **Language:** TypeScript. Codex hand-ported with LLM assist; openclaude ported 1:1.
- **Multi-provider:** 9 providers in scope (Grok default; + OpenAI, Anthropic, Ollama, LMStudio, OpenRouter, Groq, DeepSeek, Gemini). See `provider-matrix.md`.
- **Scope (corrected):** ~27,000 LOC to integrate — ~13,200 openclaude 1:1 copy + ~12,000 codex Rust→TS port + ~1,800 multi-provider adapter work.
- **Runtime target:** the live runtime is not meant to remain hybrid. AgenC ports the runtime/session kernel from `codex`, while `openclaude` remains the behavior source for selected loop/compaction subsystems. See `codex-runtime-replacement.md`.
- **Out-of-scope:** codex Rust OS sandbox primitives (Seatbelt/Landlock/seccomp), openclaude skills marketplace, realtime voice, codex cloud-tasks daemon, WebSocket client-server transport (AgenC is in-process).
- **Verbatim / locked:** `openclaude/src/ink/` (TUI reconciler) and the four `runtime/src/watch/agenc-watch-{art,splash,ui-primitives,terminal-sequences}.mjs` aesthetic files. **Grok adapter is the default provider, not locked** — it ships inside the provider-abstraction layer like every other adapter.

## How to use this plan

1. Read `feature-matrix.md` first to understand scope.
2. Read `architecture.md` to understand the module shape.
3. For every tranche in `/TODO.MD`, find the exact files in
   `openclaude-inventory.md` or `codex-inventory.md`.
4. Check `translation-conventions.md` before porting any Rust file.
5. Cross-reference `sequence-diagrams.md` when wiring module boundaries.
