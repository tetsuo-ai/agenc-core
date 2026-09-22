# Claude subscription provider experiment

Opt-in integration against AgenC `8ef6fa22`, on branch
`experiment/claude-subscription`. The provider factory, credential authority,
client/daemon environment protocol and runtime asset build now support this
transport. It runs through AgenC's real daemon, Session/runTurn and tool
dispatcher. It is not installed over your existing app or enabled by default.

Live qualification on 2026-09-22: nine completed scenarios and 132 successful
real calls cover attachments, agent lifecycle/concurrency, MCP, resume and workflows.
All 12 browser actions executed, but browser session completion failed. Full runtime
and desktop suites were run and are not all green. See [the qualification report](LIVE-VALIDATION.md)
for exact evidence, fixes and failure results; 81-tool catalog validation is separate
from live execution coverage.

## Use the connected AgenC build

After `claude auth login`, run this launcher from the workspace you want to use:

```sh
/home/paul/agenc-claude-subscription/runtime/experiments/claude-subscription/agenc-claude
```

It uses its own AgenC home (`~/.agenc-claude-subscription`) so the existing
installed daemon is not reused. Claude Code keeps its normal login. The
launcher defaults to `claude-sonnet-5`; `AGENC_CLAUDE_MODEL` overrides that.
`AGENC_CLAUDE_HOME` chooses another absolute AgenC state directory.
Normal project trust and permissions apply. No approval bypass is enabled.

The underlying switches are `AGENC_PROVIDER=anthropic` and
`AGENC_EXPERIMENTAL_CLAUDE_SUBSCRIPTION=1`. With the latter unset, Anthropic
continues to use its ordinary API adapter. Credential authority refuses mixed
API credentials/endpoints before consulting saved or managed keys. The
experimental transport inherits the user's official CLI identity, not AgenC's
account/key service. Python 3.10+ and `claude` must be installed on the daemon
host. The flag and CLI configuration path are forwarded by the CLI/SDK.

## Test the full daemon and tools

```sh
cd /home/paul/agenc-claude-subscription
/home/paul/.local/node26/bin/node runtime/experiments/claude-subscription/daemon-probe.mjs
```

This starts a private daemon/workspace and requests real `FileRead`,
`exec_command`, `Write`, then `FileRead` calls. It verifies the written file
against an unpredictable nonce, checks command stdout/exit status and checks
durable `tool_call_started`/`tool_call_completed` events. The final session
must exit 0. It saves `daemon-validation.json` and stops the private daemon.
The fixture grants its test tools through explicit permissions and a per-tool
exec approval policy, retaining the workspace-write sandbox. Failed tool
attempts must have durable results and at least one successful call to each
required tool is mandatory. A shell policy rejection is not counted as success.
The run allows at most 14 model-loop iterations and 2,048 output tokens per
request. The initial version of this fixture separately demonstrated that an
unapproved exec call stops a noninteractive session rather than bypassing approval.

## Run the subscription probe

Requirements: Node 26 (the repository's version), existing repository
dependencies, Python 3.10+, and the unmodified official `claude` executable.
The integration adds no npm or pip dependencies. This local checkout reuses
installed dependencies through hard links; workspace links resolve locally.

```sh
cd /home/paul/agenc-claude-subscription
claude auth login
node --import tsx runtime/experiments/claude-subscription/probe.ts --status
node --import tsx runtime/experiments/claude-subscription/probe.ts
```

If your default Node is older, substitute `/home/paul/.local/node26/bin/node`.
The CLI login is interactive and belongs to Anthropic; do not paste tokens
into AgenC. Auth status output omits email and organization. Inference refuses
API-key, manually supplied token, custom endpoint, and cloud-backend overrides
in the launching environment, naming only the conflicting variables.

Default model: `sonnet`; override with `AGENC_CLAUDE_MODEL`. The live probe
allows at most three requests, 512 output tokens each and 90 seconds per
request. It asks for a harmless host tool, runs it once to generate a secret
nonce, replays the tool result, and requires the final response to match that
nonce. A successful run ends with `{"type":"passed",...}`. This consumes the
account's allowance; model entitlements and extra-usage settings still apply.
No invoice/allowance reconciliation is claimed by the token usage output.

## What is implemented

- TypeScript adapter for AgenC messages, tools, streaming and usage.
- Official CLI owns login and refresh. No credential-file access in our code.
- Request-scoped native process and upstream admission relay from the pinned
  MIT-licensed Hermes transport. No external relay service.
- Exactly one upstream Messages request per provider call, even if Claude
  Code tries internal continuations. Native tools are inert; execution remains
  in the host. Tool calls are published only after a complete validated result
  and successful bridge exit.
- Stable hashed tool names support AgenC names containing dots or long names.
- Native signed reasoning is bound to the originating provider/model. Edited
  histories use their visible projection rather than restoring stale blocks.
- Abort, timeout, disposal and independently cancellable session forks.
- Refusals and tool-containing output cutoffs fail closed for tool execution.

The Python bridge vendors the transport to evaluate the same mechanism Hermes
tested, rather than creating a second protocol implementation prematurely.
See `runtime/src/llm/providers/claude-subscription/vendor/UPSTREAM.md` and both
MIT license files. The only transport modification adds native serial tool
selection (`disable_parallel_tool_use`) for AgenC's default tool policy.

## Offline verification

```sh
node --import tsx --test runtime/experiments/claude-subscription/provider.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s runtime/experiments/claude-subscription -p 'test_*.py' -v
node node_modules/typescript/bin/tsc \
  -p runtime/experiments/claude-subscription/tsconfig.json
PYTHONDONTWRITEBYTECODE=1 python3 \
  runtime/src/llm/providers/claude-subscription/vendor/evals/directsdk_admission.py \
  /home/paul/.local/bin/claude
```

The last test runs the real CLI against a **synthetic loopback HTTP peer**,
with a temporary empty home and dummy key. It exercises no subscription and
makes no inference requests to Anthropic. It verifies ten cases: final text,
tool use, output limit, tool/output limit, context limit, thinking, refusal,
HTTP error, truncated stream and cancellation. Every case admits exactly one
upstream request to the local fixture. It also checks the CLI binary is unchanged.

## Remaining qualification before general release

1. Live subscription/tool replay probe **passed on 2026-09-22** with a
   CLI-authenticated Max account: two model requests, one host tool execution,
   and exact nonce replay. See `LIVE-VALIDATION.md`. This establishes access
   for the tested account/model, not invoice or subscription-meter attribution.
2. Broader Session/runTurn budget, compaction, session resume and concurrency
   qualification beyond the real daemon tool smoke test.
3. Add dedicated account/model discovery and CLI-managed login presentation in
   desktop/TUI. The Python assets are included in this runtime build; packaging
   Python itself is not implemented.
4. Qualify supported CLI versions and platforms, full history transforms,
   malformed streaming output, concurrent sessions, and account usage metering.

Limitations: mid-history system/developer messages and remote image URLs are
rejected by the transport. Structured output, forced tool choice, native
max-turns, and some routing/sampling controls are not exposed by this experiment.
Tool allowlists, `toolChoice: none` and serial calls are supported. Sampling
temperature and the reasoning-summary hint have no native equivalent here;
they do not alter the CLI request. No automatic API fallback. The protocol uses
version-sensitive replay fields, so this is not a stable arbitrary-history
Agent SDK guarantee. Native prompt annotations may remain present.

## Sources checked 2026-09-22

- https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk
- https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://code.claude.com/docs/en/legal-and-compliance

Each user must sign in through Anthropic to the unmodified official CLI.
This experiment does not pool, proxy as a hosted service, or resell subscriptions.

Expanded live attachment, file-tool and six-tool agent lifecycle coverage is recorded in `LIVE-VALIDATION.md`, including reproduction commands and remaining gaps. PDF transport strips AgenC-only extraction metadata before sending native documents.
