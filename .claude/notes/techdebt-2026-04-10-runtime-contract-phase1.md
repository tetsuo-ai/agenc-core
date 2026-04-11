## Tech Debt Report - 2026-04-10 Runtime Contract Phase 1

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found after the verifier fail-closed wiring fix. | n/a | n/a | n/a |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found in the touched runtime-contract slice. | n/a | n/a | n/a |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Validator snapshots over-report non-applicable checks as executed | `runtime/src/llm/completion-validators.ts`, `runtime/src/llm/chat-executor-tool-loop.ts` | `runtimeContractSnapshot.validators[]` can say filesystem or deterministic probe validation passed even when those checks never actually ran, which weakens auditability. | Thread explicit applicability metadata through validator results and map non-applicable cases to `skipped` instead of `pass`. |

### Low (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Validator registry metadata is duplicated across order, execution, and recovery labeling | `runtime/src/runtime-contract/types.ts`, `runtime/src/llm/completion-validators.ts`, `runtime/src/llm/chat-executor-tool-loop.ts` | Future validator additions can drift between trace order, runtime snapshots, and recovery messaging. | Centralize validator metadata in one registry and derive order plus recovery labels from that source. |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Validator order and labeling duplicated | `runtime/src/runtime-contract/types.ts`, `runtime/src/llm/completion-validators.ts`, `runtime/src/llm/chat-executor-tool-loop.ts` | Metadata only | A single validator registry that owns id, enablement, and recovery labels. |

### Summary
- Total issues: 2
- Estimated cleanup: 3 files
- Recommended priority: Make validator snapshots distinguish `pass` from `not applicable`.
