# Claude API parity — zero live API calls

2026-09-22: **507 tests passed, 0 failed, 0 skipped**, across two separate selections.
Runtime/test-support typechecks and diff validation passed.

The new offline test runs the actual AnthropicProvider with an injected fetch
implementation that returns synthetic responses and never opens a connection.
Only a fake fixture key is used. The credential supplied in chat was not used
or copied to workspace files. No paid inference or balance lookup was performed.

The real 81-tool AgenC catalog plus one MCP fixture has matching schemas through
the subscription and API projections. The API adapter restores every tool name
and argument, then replays all tool results. The same test checks image and PDF
blocks and the API-key header, with no bearer header. Existing tests cover API
streaming, reasoning deltas, retries, usage, provider selection and credential
isolation. Fixtures simulate calls; they do not execute those 82 tool requests.

The API and subscription providers return the same LLMProvider tool-call format
to the AgenC dispatcher. This establishes local integration parity for the tested
paths. It does not verify the supplied key, available model permissions, account
balance, live API model behavior or guarantee identical decisions across routes.
The earlier live subscription browser completion failure is not cured by changing
authentication; see LIVE-VALIDATION.md.

The current experimental launcher remains on subscription authentication. API
mode requires the subscription flag off and API credentials resolved separately;
the integration intentionally rejects mixed subscription/API configuration.
No account configuration was changed during these tests.

Evidence: [api-offline-validation.json](api-offline-validation.json).
Test: `runtime/tests/llm/claude-api-offline-parity.test.ts`.
