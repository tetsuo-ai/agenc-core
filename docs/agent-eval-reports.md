# Agent Evaluation Reports

AgenC can record local SWE-style evaluation results in a checked JSON shape and
summarize them without remote CI, hosted model APIs, or benchmark-specific
infrastructure.

Schema:

```text
runtime/src/eval/agent-eval-report.schema.json
```

Validate and summarize a report:

```bash
npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- path/to/report.json
```

Print a machine-readable summary:

```bash
npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- path/to/report.json --json
```

Run a local task manifest and emit a report:

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
  --tasks path/to/tasks.json \
  --output path/to/report.json \
  --agent-command 'agenc --output-format json {prompt}'
```

Minimal manifest:

```json
{
  "benchmark": "local-smoke",
  "tasks": [
    {
      "id": "task-001",
      "prompt": "Fix the failing test.",
      "verifiers": [
        {
          "name": "unit-tests",
          "command": "npm test"
        }
      ]
    }
  ]
}
```

Task-level `agentCommand` overrides the manifest or CLI `--agent-command`.
Commands run locally with placeholders `{prompt}`, `{promptJson}`, `{taskId}`,
and `{cwd}` shell-quoted into the command string. The runner records command
exit codes, verifier status, token usage when structured agent stdout exposes
`tokenUsage` or `usage`, and validates the generated report against the schema.

Minimal report:

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "local-2026-06-14",
    "benchmark": "swe-style-local-smoke",
    "startedAt": "2026-06-14T12:00:00Z",
    "finishedAt": "2026-06-14T12:05:00Z",
    "agent": {
      "name": "agenc",
      "provider": "local",
      "model": "vllm-compatible"
    },
    "environment": {
      "repo": "tetsuo-ai/agenc-core",
      "commit": "abc123",
      "branch": "main",
      "runner": "local",
      "sandbox": "workspace",
      "localOnly": true
    }
  },
  "tasks": [
    {
      "id": "task-001",
      "status": "passed",
      "durationMs": 120000,
      "tokens": {
        "input": 12000,
        "output": 3000
      },
      "commands": [
        {
          "command": "npm test",
          "exitCode": 0,
          "durationMs": 60000
        }
      ],
      "verifiers": [
        {
          "name": "unit-tests",
          "status": "passed",
          "command": "npm test"
        }
      ],
      "patch": {
        "changedFiles": 2,
        "additions": 40,
        "deletions": 10
      }
    }
  ]
}
```

The script computes attempted-task fix rate from `passed / (passed + failed +
error)`, excluding skipped tasks. Verifier pass rate uses the same skipped-task
exclusion. `riskFlags` are free-form strings so local harnesses can record
benchmark-leakage, verifier-modification, deleted-test, network-use, or other
shortcut-detection signals as they become relevant.
