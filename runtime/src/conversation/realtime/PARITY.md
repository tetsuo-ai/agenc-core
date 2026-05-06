# Realtime Conversation Parity

Upstream reference root: the neutral local source root declared in `parity/RT-10-parity.json` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:

- `core/src/realtime_conversation.rs`
- `core/src/realtime_context.rs`

This directory owns the TypeScript port of the realtime conversation spine:

- `conversation.ts` owns the phase machine, bounded queues, handoff state, event handling, injected transport request shape, and session config helpers.
- `context.ts` owns startup context formatting for current thread history, recent work, workspace tree data, and bounded token rendering.

Concrete daemon JSON-RPC handlers, prompt assets, and WebRTC implementation live in later RT items.
