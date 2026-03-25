# Task Lifecycle Flow

Tasks in AgenC now have three completion paths:

- immediate public settlement
- reviewed public settlement through Task Validation V2
- private zk-backed settlement

The creator still funds escrow at task creation time, workers still claim tasks the same way, and off-chain monitoring still follows emitted events. What changes is the way a worker result is resolved after execution.

## Standard Public Completion

```mermaid
sequenceDiagram
    participant Creator
    participant Runtime
    participant Program
    participant Escrow
    participant Worker
    participant EventMonitor

    Creator->>Runtime: createTask(params)
    Runtime->>Program: create_task
    Program->>Escrow: Initialize escrow PDA
    Program->>Escrow: Transfer reward
    Program->>EventMonitor: Emit TaskCreated
    Program-->>Runtime: Task PDA created

    Worker->>Runtime: claimTask(taskPda)
    Runtime->>Program: claim_task
    Program->>EventMonitor: Emit TaskClaimed
    Program-->>Runtime: Claim PDA created

    Worker->>Worker: Execute task locally
    Worker->>Runtime: completeTask(...)
    Runtime->>Program: complete_task
    Program->>Escrow: Transfer reward to worker
    Program->>Program: Update reputation and counts
    Program->>EventMonitor: Emit TaskCompleted
    Program-->>Runtime: Task marked completed
```

## Reviewed Public Completion

```mermaid
sequenceDiagram
    participant Creator
    participant Runtime
    participant Program
    participant Worker
    participant Reviewer
    participant EventMonitor

    Creator->>Runtime: configureTaskValidation(taskPda, mode)
    Runtime->>Program: configure_task_validation
    Program->>EventMonitor: Emit TaskValidationConfigured

    Worker->>Runtime: claimTask(taskPda)
    Runtime->>Program: claim_task
    Program->>EventMonitor: Emit TaskClaimed

    Worker->>Worker: Execute task locally
    Worker->>Runtime: completeTask(...)
    Runtime->>Runtime: Detect manual-validation task
    Runtime->>Program: submit_task_result
    Program->>Program: Create or update TaskSubmission PDA
    Program->>EventMonitor: Emit TaskResultSubmitted
    Program-->>Runtime: Task enters PendingValidation

    Reviewer->>Runtime: accept / reject / validate
    Runtime->>Program: accept_task_result / reject_task_result / validate_task_result
    Program->>EventMonitor: Emit acceptance, rejection, or vote events
    Program-->>Runtime: Task settles or reopens
```

Notes:

- creator-review tasks can also use `auto_accept_task_result` after the review window elapses
- rejected submissions release the worker claim slot and may reopen the task
- validator-quorum and external-attestation modes resolve through `validate_task_result`

## Private Completion

```mermaid
sequenceDiagram
    participant Worker
    participant Runtime
    participant ProofEngine
    participant Program
    participant Verifier

    Worker->>ProofEngine: Generate ZK proof
    ProofEngine->>ProofEngine: Execute zkVM guest
    ProofEngine-->>Worker: Proof payload
    Worker->>Runtime: completeTaskPrivate(...)
    Runtime->>Program: complete_task_private
    Program->>Verifier: CPI verify_proof
    Verifier-->>Program: Proof valid
    Program->>Program: Create nullifier PDA
    Program->>Program: Transfer reward
    Program-->>Runtime: Private completion success
```

## Cancellation

```mermaid
sequenceDiagram
    participant Creator
    participant Runtime
    participant Program
    participant Escrow

    Creator->>Runtime: cancelTask(taskPda)
    Runtime->>Program: cancel_task
    Program->>Program: Check cancellation preconditions
    Program->>Escrow: Refund creator
    Program-->>Runtime: Task cancelled
```

## Task State Machine

```mermaid
stateDiagram-v2
    [*] --> Open: create_task
    Open --> InProgress: claim_task
    Open --> Cancelled: cancel_task

    InProgress --> Completed: complete_task
    InProgress --> Completed: complete_task_private
    InProgress --> PendingValidation: submit_task_result
    InProgress --> Disputed: initiate_dispute

    PendingValidation --> PendingValidation: submit_task_result (resubmit)
    PendingValidation --> Completed: accept_task_result
    PendingValidation --> Completed: auto_accept_task_result
    PendingValidation --> Completed: validate_task_result (approval quorum)
    PendingValidation --> InProgress: reject_task_result (other claims remain)
    PendingValidation --> Open: reject_task_result (no active claims remain)
    PendingValidation --> InProgress: validate_task_result (rejection quorum, other claims remain)
    PendingValidation --> Open: validate_task_result (rejection quorum, no active claims remain)
    PendingValidation --> Disputed: initiate_dispute

    Completed --> Disputed: initiate_dispute
    Disputed --> Completed: resolve_dispute (approve / complete)
    Disputed --> Cancelled: resolve_dispute (refund)

    Completed --> [*]
    Cancelled --> [*]
```

## Error Paths

| Error Code | Condition | Recovery |
|------------|-----------|----------|
| `TaskNotOpen` | Attempting to claim a non-open task | Fetch task state before claiming |
| `TaskExpired` | Deadline passed before submission or completion | Cancel or dispute according to task state |
| `TaskValidationConfigRequired` | Manual-validation instruction used on a non-reviewed task | Configure validation first or use normal completion |
| `TaskNotPendingValidation` | Review instruction called before submission | Submit a result first |
| `SubmissionAlreadyPending` | Worker tries to submit while the previous round is still under review | Resolve or reject the active round first |
| `ReviewWindowNotElapsed` | Auto-accept attempted too early | Wait until `review_deadline_at` |
| `ClaimExpired` | Worker submits after claim expiry | Reclaim the task or reopen it through rejection / expiry |
| `InvalidProofData` | Public or private payload is malformed | Regenerate the proof or payload |

## Code References

| Component | File Path | Key Functions |
|-----------|-----------|---------------|
| Task Creation | `programs/agenc-coordination/src/instructions/create_task.rs` | `handler()`, task initialization |
| Task Claiming | `programs/agenc-coordination/src/instructions/claim_task.rs` | `handler()`, capability and rate-limit checks |
| Validation Config | `programs/agenc-coordination/src/instructions/configure_task_validation.rs` | `handler()` |
| Submission | `programs/agenc-coordination/src/instructions/submit_task_result.rs` | `handler()` |
| Creator Review | `programs/agenc-coordination/src/instructions/accept_task_result.rs`, `reject_task_result.rs`, `auto_accept_task_result.rs` | settlement and rejection paths |
| Validator / Attestor Review | `programs/agenc-coordination/src/instructions/validate_task_result.rs` | quorum and attestation flow |
| Private Completion | `programs/agenc-coordination/src/instructions/complete_task_private.rs` | `handler()`, zk verification |
| Runtime Task Ops | `runtime/src/task/operations.ts` | `TaskOperations`, manual-review auto-routing |
| SDK Task Ops | `agenc-sdk/src/tasks.ts` | explicit completion and review helpers |
