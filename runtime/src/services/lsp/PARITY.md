# LSP Service Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/services/lsp/manager.ts`
- `src/services/lsp/LSPClient.ts`
- `src/services/lsp/LSPServerManager.ts`
- `src/services/lsp/LSPServerInstance.ts`
- `src/services/lsp/LSPDiagnosticRegistry.ts`
- `src/services/lsp/passiveFeedback.ts`
- `src/services/lsp/config.ts`

This directory owns AgenC's live LSP service port:
- `manager.ts` owns singleton initialization, reinitialization, shutdown, and status.
- `LSPClient.ts` owns JSON-RPC process transport.
- `LSPServerManager.ts` owns config loading, extension routing, and file lifecycle notifications.
- `LSPServerInstance.ts` owns per-server lifecycle, initialization, retry, and restart behavior.
- `LSPDiagnosticRegistry.ts` owns pending diagnostic storage, dedupe, volume caps, and reset hooks.
- `passiveFeedback.ts` owns publish-diagnostics notification registration and attachment formatting.
- `config.ts` owns AgenC LSP server config normalization and source injection.
