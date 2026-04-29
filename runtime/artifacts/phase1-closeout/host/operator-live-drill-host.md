# Compiled Job Phase 1 Operator Host Drill

- Generated at (UTC): 2026-04-23T18:19:43.151Z
- Runtime version (git): 8389b0a772cdd5d9dd1c2fbecf60e39aed7dad0a
- Package version: 0.1.0
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
        "taskPda": "CM7XGkJB5o1pchQdK2niUK5yC7i22PDmF7wDf8wnE3ht",
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
        "taskPda": "FZQPBQTuNvPzLSnG1vxZFy5PTxM6qzw2dQN5ZsKidZQZ",
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
      "id": "compiled_job.blocked_reason_spike:execution_job_type_rate_limit:1776968383546",
      "severity": "warn",
      "code": "compiled_job.blocked_reason_spike",
      "message": "Compiled job blocked-run spike detected for execution_job_type_rate_limit: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776968383546,
      "delta": 1,
      "threshold": 1,
      "reason": "execution_job_type_rate_limit"
    },
    {
      "id": "compiled_job.blocked_runs_spike:1776968383546",
      "severity": "warn",
      "code": "compiled_job.blocked_runs_spike",
      "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776968383546,
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
        "taskPda": "CANs6Mnr9ha3ZCYD3iSdqG2cCPU8tAdv6vgqfG6kiJB6",
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
        "taskPda": "3Axb8BWUR8CHBDFr3VuDxrBsYiDHiqsCK2XS8S1ZDz2L",
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
      "id": "compiled_job.blocked_reason_spike:dependency_network_broker_unavailable:1776968383602",
      "severity": "warn",
      "code": "compiled_job.blocked_reason_spike",
      "message": "Compiled job blocked-run spike detected for dependency_network_broker_unavailable: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776968383602,
      "delta": 1,
      "threshold": 1,
      "reason": "dependency_network_broker_unavailable"
    },
    {
      "id": "compiled_job.blocked_runs_spike:1776968383602",
      "severity": "warn",
      "code": "compiled_job.blocked_runs_spike",
      "message": "Compiled job blocked-run spike detected: 1 blocked runs since the last telemetry flush",
      "createdAt": 1776968383602,
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
        "taskPda": "DdwSTpJhAM5Rhsro1g2zaHjMWnPrUSLCC2asKGAZmKrx",
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
  "jobType": "web_research_brief",
  "denyReason": "blocked.example.com",
  "alertCodes": [
    "compiled_job.domain_denied_spike",
    "compiled_job.policy_failure_spike"
  ],
  "alerts": [
    {
      "id": "compiled_job.domain_denied_spike:network_access_denied:1776968383676",
      "severity": "error",
      "code": "compiled_job.domain_denied_spike",
      "message": "Compiled job domain denials spike detected for network_access_denied: 2 events since the last telemetry flush",
      "createdAt": 1776968383676,
      "delta": 2,
      "threshold": 1,
      "reason": "network_access_denied"
    },
    {
      "id": "compiled_job.policy_failure_spike:network_access_denied:1776968383676",
      "severity": "error",
      "code": "compiled_job.policy_failure_spike",
      "message": "Compiled job policy failures spike detected for network_access_denied: 2 events since the last telemetry flush",
      "createdAt": 1776968383676,
      "delta": 2,
      "threshold": 1,
      "reason": "network_access_denied"
    }
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
        "taskPda": "7PUnQkRf8nPaXKzHTaPBWatmwfu7gNBov6e5PscCNNs2",
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
        "taskPda": "7PUnQkRf8nPaXKzHTaPBWatmwfu7gNBov6e5PscCNNs2",
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
        "taskPda": "7PUnQkRf8nPaXKzHTaPBWatmwfu7gNBov6e5PscCNNs2",
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
        "taskPda": "7PUnQkRf8nPaXKzHTaPBWatmwfu7gNBov6e5PscCNNs2",
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
- Status: passed
- Summary: Synthetic compiled-job alerts were routed to the configured real destinations with delivery evidence recorded.
```json
{
  "deliveries": [
    {
      "label": "ntfy primary",
      "url": "https://ntfy.sh/agenc-phase1-closeout-1776968345-7076",
      "emittedAt": "2026-04-23T18:19:16.545Z",
      "deliveredAt": "2026-04-23T18:19:16.798Z",
      "httpStatus": 200
    },
    {
      "label": "ntfy backup",
      "url": "https://ntfy.sh/agenc-phase1-closeout-1776968345-7076-backup",
      "emittedAt": "2026-04-23T18:19:16.798Z",
      "deliveredAt": "2026-04-23T18:19:16.834Z",
      "httpStatus": 200
    }
  ],
  "primaryDelivered": true,
  "backupDelivered": true
}
```

### on_call_response
- Status: passed
- Summary: A real alert was received and acknowledged, and the responder recorded the correct first containment step.
```json
{
  "receiverSeenAt": "2026-04-23T18:19:30.000Z",
  "acknowledgedAt": "2026-04-23T18:19:32.000Z",
  "firstResponseStep": "Pause the affected L0 job type and inspect compiled-job telemetry before restore.",
  "deliveries": [
    {
      "label": "ntfy primary",
      "url": "https://ntfy.sh/agenc-phase1-closeout-1776968345-7076",
      "emittedAt": "2026-04-23T18:19:16.545Z",
      "deliveredAt": "2026-04-23T18:19:16.798Z",
      "httpStatus": 200
    },
    {
      "label": "ntfy backup",
      "url": "https://ntfy.sh/agenc-phase1-closeout-1776968345-7076-backup",
      "emittedAt": "2026-04-23T18:19:16.798Z",
      "deliveredAt": "2026-04-23T18:19:16.834Z",
      "httpStatus": 200
    }
  ]
}
```
