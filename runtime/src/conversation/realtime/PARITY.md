# Realtime Conversation Parity

Upstream reference root: the neutral local source root declared in `parity/RT-10-parity.json` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:

- `core/src/realtime_conversation.rs`
- `core/src/realtime_context.rs`
- `core/src/context/realtime_start_instructions.rs`
- `core/src/context/realtime_end_instructions.rs`
- `core/src/context/realtime_start_with_instructions.rs`
- `core/src/context_manager/updates.rs`
- `core/src/event_mapping.rs`
- `core/src/context_manager/history.rs`
- `protocol/src/protocol.rs`

This directory owns the TypeScript port of the realtime conversation spine:

- `conversation.ts` owns the phase machine, bounded queues, handoff state, event handling, injected transport request shape, and session config helpers.
- `context.ts` owns startup context formatting for current thread history, recent work, workspace tree data, and bounded token rendering.
- `instructions/` owns realtime turn-boundary markers, developer-role instruction rendering, and the message builders used when text turns enter or leave realtime mode.

RT-11 keeps the turn-boundary prompt text inline only to preserve wrapper behavior. RT-12 owns moving those prompt bodies behind the realtime prompt module and markdown asset files so there is one long-term prompt source.

Concrete daemon JSON-RPC handlers, backend prompt precedence, prompt assets, and WebRTC implementation live in later RT items.
