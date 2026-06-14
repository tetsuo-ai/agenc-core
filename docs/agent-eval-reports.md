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
