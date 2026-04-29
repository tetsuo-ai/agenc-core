# Compiled Job Phase 1 Operator Host Drill

- Generated at (UTC): 2026-04-23T17:15:13.025Z
- Runtime version (git): ea51cd546d34ad59b62b5c1ea92036216d749a88
- Package version: 0.2.0
- Compiler version: agenc.web.bounded-task-template.v1
- Policy version: agenc.runtime.compiled-job-policy.v1
- Enabled job types: web_research_brief, product_comparison_report

## Drill Results

### global_pause
- Status: passed
- Summary: Global pause denied a known-good L0 run before execution and the same run succeeded after pause removal.
- Details:
```json
{
  "blockedMessage": "Compiled marketplace job execution is paused by runtime launch controls",
  "resumedContent": "Research brief with citations",
  "alerts": [
    "compiled_job.blocked_reason_spike",
    "compiled_job.blocked_runs_spike"
  ],
  "blockedWarns": [
    {
      "message": "Compiled job execution blocked",
      "payload": {
        "reason": "launch_paused",
        "message": "Compiled marketplace job execution is paused by runtime launch controls",
        "taskPda": "BU2g5kPVKx3wMXyK15rfEeRXMiu9SWxr4V6vUaZVmc8J",
        "jobType": "web_research_brief",
        "riskTier": "L0",
        "templateId": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_runs_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_reason_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected for launch_paused: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1,
        "reason": "launch_paused"
      }
    }
  ]
}
```

### per_job_type_disable
- Status: passed
- Summary: Disabling one L0 job type blocked only that type while a different enabled L0 type continued to run.
- Details:
```json
{
  "blockedMessage": "Compiled job type \"web_research_brief\" is disabled by runtime launch controls",
  "allowedContent": "Research brief with citations",
  "warns": [
    {
      "message": "Compiled job execution blocked",
      "payload": {
        "reason": "launch_job_type_disabled",
        "message": "Compiled job type \"web_research_brief\" is disabled by runtime launch controls",
        "taskPda": "7LV5aMmHpDrsupEGvo83VdbGPQUWKzFo5F5QbBcWX77q",
        "jobType": "web_research_brief",
        "riskTier": "L0",
        "templateId": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  ]
}
```

### quota_and_rate_limit
- Status: passed
- Summary: A lowered per-job rate limit denied excess traffic before execution and normal traffic resumed after restore.
- Details:
```json
{
  "blockedMessage": "Compiled job type \"web_research_brief\" rate limit exceeded (1/1 per 60000ms)",
  "alerts": [
    {
      "id": "compiled_job.blocked_reason_spike:execution_job_type_rate_limit:1776964513092",
      "severity": "warn",
      "code": "compiled_job.blocked_reason_spike",
      "message": "Compiled job blocked-run spike detected for execution_job_type_rate_limit: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776964513092,
      "delta": 1,
      "threshold": 1,
      "reason": "execution_job_type_rate_limit"
    },
    {
      "id": "compiled_job.blocked_runs_spike:1776964513092",
      "severity": "warn",
      "code": "compiled_job.blocked_runs_spike",
      "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776964513092,
      "delta": 1,
      "threshold": 1
    }
  ],
  "warns": [
    {
      "message": "Compiled job execution blocked",
      "payload": {
        "reason": "execution_job_type_rate_limit",
        "message": "Compiled job type \"web_research_brief\" rate limit exceeded (1/1 per 60000ms)",
        "taskPda": "ErPe3WntW3tMBmpyHokhbLiQZUqJADYNtDnBe7gNc4is",
        "jobType": "web_research_brief",
        "riskTier": "L0",
        "templateId": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_runs_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_reason_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected for execution_job_type_rate_limit: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1,
        "reason": "execution_job_type_rate_limit"
      }
    }
  ]
}
```

### version_rollback
- Status: passed
- Summary: Compiler version controls blocked a denied version and accepted the restored allowed version.
- Details:
```json
{
  "blockedMessage": "Compiled job compiler version \"agenc.web.bounded-task-template.v1\" is not enabled in runtime version controls",
  "restoredContent": "Research brief with citations",
  "warns": [
    {
      "message": "Compiled job execution blocked",
      "payload": {
        "reason": "compiler_version_not_enabled",
        "message": "Compiled job compiler version \"agenc.web.bounded-task-template.v1\" is not enabled in runtime version controls",
        "taskPda": "2SpQw45BjcWkb6wjkEWvcAKi5hWVFE1NiPkVT33aR5wb",
        "jobType": "web_research_brief",
        "riskTier": "L0",
        "templateId": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  ]
}
```

### dependency_fail_closed
- Status: passed
- Summary: A simulated dependency outage failed closed before model execution and normal execution resumed after restore.
- Details:
```json
{
  "blockedMessage": "Network broker unavailable for compiled job execution",
  "alerts": [
    {
      "id": "compiled_job.blocked_reason_spike:dependency_network_broker_unavailable:1776964513099",
      "severity": "warn",
      "code": "compiled_job.blocked_reason_spike",
      "message": "Compiled job blocked-run spike detected for dependency_network_broker_unavailable: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776964513099,
      "delta": 1,
      "threshold": 1,
      "reason": "dependency_network_broker_unavailable"
    },
    {
      "id": "compiled_job.blocked_runs_spike:1776964513099",
      "severity": "warn",
      "code": "compiled_job.blocked_runs_spike",
      "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776964513099,
      "delta": 1,
      "threshold": 1
    }
  ],
  "warns": [
    {
      "message": "Compiled job execution blocked",
      "payload": {
        "reason": "dependency_network_broker_unavailable",
        "message": "Network broker unavailable for compiled job execution",
        "taskPda": "6H7jjj6bMv7QAPCz3BqPYfzx56r9apwVomMhQpgYUDLM",
        "jobType": "web_research_brief",
        "riskTier": "L0",
        "templateId": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "dependency": "network-broker"
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_runs_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.blocked_reason_spike",
        "severity": "warn",
        "message": "Compiled job blocked-run spike detected for dependency_network_broker_unavailable: 1 blocked runs since the last telemetry flush",
        "delta": 1,
        "threshold": 1,
        "reason": "dependency_network_broker_unavailable"
      }
    }
  ]
}
```

### synthetic_alert_emission
- Status: passed
- Summary: Synthetic hostile-content traffic emitted policy-failure and domain-denial telemetry alerts with compiled-plan context.
- Details:
```json
{
  "alertCodes": [
    "compiled_job.domain_denied_spike",
    "compiled_job.policy_failure_spike"
  ],
  "warns": [
    {
      "message": "Tool \"system.httpGet\" blocked by policy (network_access_denied)"
    },
    {
      "message": "Compiled job policy failure observed",
      "payload": {
        "reason": "network_access_denied",
        "violationCode": "network_access_denied",
        "message": "Network access to host \"blocked.example.com\" is outside the allowed host set",
        "host": "blocked.example.com",
        "toolName": "system.httpGet",
        "taskPda": "67p5PcVrZqRMG9g99xCNCDi7Dutk5TfGWjLJGJk3Kp2i",
        "jobType": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Compiled job domain denied",
      "payload": {
        "reason": "network_access_denied",
        "message": "Network access to host \"blocked.example.com\" is outside the allowed host set",
        "host": "blocked.example.com",
        "toolName": "system.httpGet",
        "taskPda": "67p5PcVrZqRMG9g99xCNCDi7Dutk5TfGWjLJGJk3Kp2i",
        "jobType": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Tool \"system.httpGet\" blocked by policy (network_access_denied)"
    },
    {
      "message": "Compiled job policy failure observed",
      "payload": {
        "reason": "network_access_denied",
        "violationCode": "network_access_denied",
        "message": "Network access to host \"blocked.example.com\" is outside the allowed host set",
        "host": "blocked.example.com",
        "toolName": "system.httpGet",
        "taskPda": "67p5PcVrZqRMG9g99xCNCDi7Dutk5TfGWjLJGJk3Kp2i",
        "jobType": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Compiled job domain denied",
      "payload": {
        "reason": "network_access_denied",
        "message": "Network access to host \"blocked.example.com\" is outside the allowed host set",
        "host": "blocked.example.com",
        "toolName": "system.httpGet",
        "taskPda": "67p5PcVrZqRMG9g99xCNCDi7Dutk5TfGWjLJGJk3Kp2i",
        "jobType": "web_research_brief",
        "compilerVersion": "agenc.web.bounded-task-template.v1",
        "policyVersion": "agenc.runtime.compiled-job-policy.v1",
        "compiledPlanHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.policy_failure_spike",
        "severity": "error",
        "message": "Compiled job policy failures spike detected for network_access_denied: 2 events since the last telemetry flush",
        "delta": 2,
        "threshold": 1,
        "reason": "network_access_denied"
      }
    },
    {
      "message": "Compiled job telemetry alert emitted",
      "payload": {
        "code": "compiled_job.domain_denied_spike",
        "severity": "error",
        "message": "Compiled job domain denials spike detected for network_access_denied: 2 events since the last telemetry flush",
        "delta": 2,
        "threshold": 1,
        "reason": "network_access_denied"
      }
    }
  ]
}
```

## Production-only items

### alert_routing
- Status: blocked
- Summary: Synthetic alert emission is proven in-host, but no real pager/Slack/Alertmanager destination was discoverable on this host, so human delivery could not be verified.
```json
{
  "requirement": "Production-only drill requires alert delivery to a real destination and recorded receipt timestamps."
}
```

### on_call_response
- Status: blocked
- Summary: No configured human alert destination or acknowledged production incident path was available during this single-operator host drill.
```json
{
  "requirement": "Production-only drill requires a real alert receiver, acknowledgement timestamp, and explicit first-response action."
}
```
