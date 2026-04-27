# AgenC Rebuild Plan — Documentation Index

This directory is the single source of truth for the AgenC rebuild.
Every file/feature being taken from `the prior TypeScript implementation` (TypeScript) or
`the prior runtime implementation` (Rust) is enumerated here. No surprises.

| Document | Purpose |
|---|---|
| [`invariants.md`](invariants.md) | **7 design invariants (I-1..I-7)** that close design holes exposed by the flowchart. Every tranche references these; violating one is a bug. |
| [`provider-matrix.md`](provider-matrix.md) | **9 providers × capability grid** + per-provider auth + wire-format clusters. Grok default; everything else in scope. |
| [`behavior-inventory.md`](behavior-inventory.md) | Every AgenC file we port 1:1, dependencies, LOC, destinations |
| [`runtime-inventory.md`](runtime-inventory.md) | Every AgenC runtime file we hand-port Rust→TS, per-file TS destination, `mod.rs` breakdown |
| [`architecture.md`](architecture.md) | Mermaid component diagram, module boundaries, provider abstraction layer |
| [`sequence-diagrams.md`](sequence-diagrams.md) | Turn swimlane, recovery ladder, compaction, subagent spawn, /plan mode, session resume |
| [`feature-matrix.md`](feature-matrix.md) | Every feature (slash commands, /plan, modes, memory, MCP, …) with source + status + destination |
| [`translation-conventions.md`](translation-conventions.md) | Rust→TS mapping rules (`Arc<Mutex>`, `mpsc`, `Result`, `match`, lifetimes) |
| [`agentic-loop.html`](agentic-loop.html) | Interactive mermaid flowchart — the whole architecture on one page |
| [`runtime-replacement.md`](runtime-replacement.md) | Replacement-first migration plan: AgenC ports the live runtime/session kernel from AgenC runtime; AgenC remains behavior source only |

## Summary

- **Language:** TypeScript. AgenC runtime hand-ported with LLM assist; AgenC ported 1:1.
- **Multi-provider:** 9 providers in scope (Grok default; + OpenAI, Anthropic, Ollama, LMStudio, OpenRouter, Groq, DeepSeek, Gemini). See `provider-matrix.md`.
- **Scope (corrected):** ~27,000 LOC to integrate — ~13,200 AgenC 1:1 copy + ~12,000 AgenC runtime Rust→TS port + ~1,800 multi-provider adapter work.
- **Runtime target:** the live runtime is not meant to remain hybrid. AgenC ports the runtime/session kernel from `AgenC runtime`, while `AgenC` remains the behavior source for selected loop/compaction subsystems. See `runtime-replacement.md`.
- **Out-of-scope:** AgenC runtime Rust OS sandbox primitives (Seatbelt/Landlock/seccomp), AgenC skills marketplace, realtime voice, AgenC runtime cloud-tasks daemon, WebSocket client-server transport (AgenC is in-process).
- **Verbatim / locked:** `AgenC/src/ink/` (TUI reconciler) and the four `runtime/src/watch/agenc-watch-{art,splash,ui-primitives,terminal-sequences}.mjs` aesthetic files. **Grok adapter is the default provider, not locked** — it ships inside the provider-abstraction layer like every other adapter.

## How to use this plan

1. Read `feature-matrix.md` first to understand scope.
2. Read `architecture.md` to understand the module shape.
3. For every tranche in `/TODO.MD`, find the exact files in
   `behavior-inventory.md` or `runtime-inventory.md`.
4. Check `translation-conventions.md` before porting any Rust file.
5. Cross-reference `sequence-diagrams.md` when wiring module boundaries.
