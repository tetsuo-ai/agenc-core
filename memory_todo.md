# AgenC memory system — implementation handoff

> Status: implementation-grade plan; no production implementation has been performed by this document.
>
> Research and repository audit date: **2026-07-22** (America/Edmonton).
>
> Primary decision: **build AgenC's memory governance and execution-state control plane natively in TypeScript.** Treat third-party memory projects as optional, replaceable adapters or sources of tested ideas—not as security or correctness authorities.

## How to use this handoff

This file is the source-of-truth task list for the memory redesign. Work top to bottom. Do not skip Phase 0, do not enable a new path by default before its gates pass, and do not turn research claims into product claims without reproducing them in AgenC.

The required core release boundary is Phases 0–8 and 11–12. Phase 9 (prospective intentions) requires an explicit product/authority decision; Phase 10 (third-party adapters or learned controllers) lands only if it outperforms the native system without weakening any invariant.

When implementation begins:

- [ ] Re-read the repository's local `AGENTS.md`, [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/reference/memory.md`](docs/reference/memory.md).
- [ ] Re-run the research freshness procedure in [Research freshness and evidence rules](#research-freshness-and-evidence-rules). This plan is current on the audit date, not forever.
- [ ] Inspect `git status`, the active branch, and overlapping swarm/agent changes before editing. At plan time the worktree contains unrelated swarm-orchestration changes; preserve them.
- [ ] Start implementation from a clean branch based on current `main`; never commit directly to `main`, never bypass hooks, and use conventional commits.
- [ ] Update this file as decisions land. Replace unchecked tasks with links to the ADR, tests, benchmark evidence, and merged PR—not an unsupported assertion that the task is complete.

## What “state of the art” means here

There is no demonstrated “perfect” agent-memory implementation. The current evidence explicitly says the opposite:

- [MemoryAgentBench](https://arxiv.org/abs/2507.05257) evaluates accurate retrieval, test-time learning, long-range understanding, and selective forgetting; its 2026-06-28 revision reports that current methods do not master all four.
- [GateMem](https://arxiv.org/abs/2606.18829) finds no evaluated approach simultaneously strong on utility, access control, and active forgetting in multi-principal memory.
- [Are We Ready For An Agent-Native Memory System?](https://arxiv.org/abs/2606.24775) evaluates 12 systems and two baselines across five workloads and finds no single architecture dominates; workload fit and localized maintenance matter.
- [MemoryArena](https://arxiv.org/abs/2602.16313) shows that near-saturated conversational-memory performance does not transfer to interdependent agentic tasks.

Accordingly, “state of the art” in this plan means:

1. current primary evidence was checked rather than recalled from model training;
2. safety, governance, execution state, retrieval quality, cost, latency, and deletion are evaluated separately;
3. every model-produced memory is fallible data with provenance, never authority;
4. improvements are measured against strong baselines on AgenC's actual coding and multi-agent workload;
5. the system can abstain, disable memory, invalidate bad state, and roll back safely.

“Exponential improvement” is not an acceptance criterion. Report absolute and relative changes, uncertainty, resource use, and regressions. Do not select only a benchmark or metric on which the implementation looks good.

## Executive decision record

| Decision | Chosen direction | Reason |
| --- | --- | --- |
| Core ownership | Native AgenC TypeScript service | Authority, scopes, policy, provenance, invalidation, and action gates must stay inside the runtime trust boundary. |
| Canonical storage | Native SQLite-backed ledger; physical topology is an explicit pre-migration ADR | AgenC's existing state database is physically per-project, so it cannot silently become the canonical home for `user_global` or future cross-project/team namespaces. Choose namespace routing, transaction boundaries, backup/restore, locking, and deletion semantics before creating tables. A separate Python/Postgres/graph service is still not justified as the default local CLI dependency. |
| Human-readable compatibility | Maintain import/export projections for existing Markdown memory | Users must not lose `$AGENC_HOME/memory`, project `.agenc/memory`, `MEMORY.md`, or `/memory` workflows. |
| Retrieval baseline | Deterministic lexical retrieval first; optional hybrid signals behind adapters | A simple reproducible baseline is required before embeddings or learned routers can claim value. Feature-probe FTS support or reuse the TypeScript BM25 implementation in [`runtime/src/context/orientation-map.ts`](runtime/src/context/orientation-map.ts); do not assume platform capabilities. |
| Embeddings | Optional derived index, off until privacy/cost/eval gates pass | Embeddings are not the source of truth and must be rebuildable and deletable. Sensitive content must not be sent to a remote embedding provider without an allowed sink policy. |
| Graphs | Relational provenance and influence edges in core; no graph database requirement | Causal invalidation is required, but a graph server is not. Semantic graph retrieval can be an optional experiment. |
| Learned memory manager | Research track only after deterministic system passes | AgeMem, Memory-R1, UMEM, SelfMem, and related work are promising but model-, training-, or benchmark-dependent. Learned policy cannot own authorization. |
| Background consolidation | Proposal generator only | A background model may propose candidates. It may not directly mutate canonical memory or raise authority. |
| Agent/swarm sharing | Private by default; explicit scoped publication | Shared memory expands poisoning and leakage paths. Publication must preserve origin and pass the same admission policy as every other write. |
| Permissions | Live authority only | Stored memory can inform a plan but can never authorize spending, credentials, destructive changes, publication, external messages, or security-boundary changes. |
| Chain of thought | Never stored | Store observable inputs, actions, results, decisions, concise state summaries, and citations—not hidden reasoning or provider-private thought. |

## Scope

This redesign covers the complete memory lifecycle across the CLI, daemon, sessions, agents, and swarms:

- authoritative instructions versus learned memory;
- working/session memory and compaction;
- execution-state memory for long-horizon tasks and branch recovery;
- durable semantic, preference, episodic, reference, and procedural memory;
- future/deferred intentions if AgenC later exposes prospective-memory behavior;
- write admission, validation, contradiction handling, versioning, consolidation, recall, context packing, feedback, forgetting, deletion, and repair;
- per-user, workspace, project, thread, task, agent, and shared-team scopes;
- privacy, secrets, provider sinks, permissions, poisoning, access control, audit, and incident response;
- storage, indexing, migrations, compatibility projections, SDK/protocol surfaces, TUI/CLI UX, telemetry, benchmarks, tests, rollout, and rollback.

### Non-goals

- Do not replace `AGENC.md`/`AGENTS.md`, managed policy, live user requests, sandbox policy, or permission gates with learned memory.
- Do not persist full raw transcripts or tool outputs again merely to create a memory journal; reference the existing event/transcript record where possible and retain only the minimum eligible evidence.
- Do not copy raw images, audio, archives, or other large binaries into the memory ledger. Reference an authorized content-addressed artifact and, if useful, store a separately validated derived claim/summary with full provenance and the artifact's retention/sink limits.
- Do not make a remote service, graph database, vector database, Python runtime, or a particular model/provider mandatory for AgenC memory.
- Do not infer a long-lived permission or consequential future action from conversation. A deferred intention must be explicit, scoped, revocable, expiring, and checked at execution time.
- Do not claim physical erasure from user-managed backups, external providers, or propagated copies that AgenC cannot control. State the deletion guarantee precisely.
- Do not ship an adaptive/RL memory policy merely because it wins an author-run benchmark.

## Research freshness and evidence rules

Every implementation PR that relies on research must include a short evidence note:

- [ ] Search primary venues and first-party repositories for updates newer than the source revision recorded here.
- [ ] Record the source URL, version/commit, publication status, access date, exact claim adopted, and known limitation.
- [ ] Prefer accepted/peer-reviewed papers and independent cross-system evaluations over project-authored benchmarks.
- [ ] Label evidence consistently:
  - **A:** accepted/peer-reviewed independent or cross-system evidence;
  - **B:** accepted/peer-reviewed method paper with author-run evaluation;
  - **C:** preprint, position paper, or author-run benchmark;
  - **D:** project documentation, repository claims, or an implementation observation.
- [ ] Reproduce a relevant result in AgenC before using “better,” “safer,” “state of the art,” or a benchmark number in user-facing material.
- [ ] Pin benchmark dataset revisions, prompts, judges, model/provider versions, sampling parameters, seeds, and price snapshots.
- [ ] Check benchmark and code licenses before vendoring fixtures or adding them to CI.
- [ ] Treat LLM-as-judge results as secondary; prefer executable, deterministic, or human-audited outcome verifiers.
- [ ] Store negative and null results. Do not silently remove models, tasks, seeds, or adversarial cases that regress.

### Evidence-to-requirement map

| Current primary source | Evidence | Requirement adopted here | Limitation to preserve |
| --- | --- | --- | --- |
| [MemoryAgentBench](https://arxiv.org/abs/2507.05257) and [official code](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | ICLR 2026 / A | Evaluate retrieval, test-time learning, long-range understanding, and selective forgetting independently. | It is not a complete coding-agent or security benchmark. |
| [MemoryArena](https://arxiv.org/abs/2602.16313) and [official project](https://memoryarena.github.io/) | ICML 2026 acceptance reported by its official project / A-B | Gate on multi-session tasks where earlier actions change later constraints. | Reproduce locally; do not infer coding performance from web/planning tasks alone. |
| [MemGym](https://arxiv.org/abs/2605.20833) | Preprint / C | Add coding, research, tool-use, and computer-use tracks; isolate memory quality from base-agent ability. | Its reward-model proxy is not a substitute for final executable coding outcomes. |
| [GateMem](https://arxiv.org/abs/2606.18829) and [code](https://github.com/rzhub/GateMem) | Cross-system preprint / C | Jointly test utility, access control, and active forgetting in multi-principal memory. | Interface-level forgetting is not proof of physical erasure. |
| [Agent-native memory systems study](https://arxiv.org/abs/2606.24775) and [MemoryData code](https://github.com/OpenDataBox/MemoryData) | Cross-system preprint / C | Measure representation, extraction, routing, maintenance, cost, and update stability separately; prefer localized maintenance. | Results still require AgenC reproduction. |
| [MAGE](https://arxiv.org/abs/2606.06090) | Preprint / C | Add an active execution-state tree with Grow, Compress, Maintain, and Revise semantics; isolate failed branches. | The reported 7.8–20.4 point gains and 55.1% token reduction are author-run; no official reusable package was located on the audit date. |
| [Agent Memory systems characterization](https://arxiv.org/abs/2606.06448) | Preprint / C | Profile construction, retrieval, and generation costs; schedule maintenance based on freshness and query volume. | Systems results are workload-dependent. |
| [AgeMem](https://aclanthology.org/2026.acl-long.981/) | ACL 2026 / B | Expose explicit add/update/delete/retrieve/summarize/filter operations to experiments. | Its learned controller and training regimen are not provider-agnostic production policy. |
| [Memory-R1](https://aclanthology.org/2026.acl-long.583/) | ACL 2026 / B | Include ADD/UPDATE/DELETE/NOOP as an experimental learned-policy action space. | Small author-run training/evaluation does not establish general safety. |
| [UMEM](https://openreview.net/forum?id=BoiXvrwtdi) | ICML 2026 / B | Evaluate extraction and management jointly, including marginal utility and neighborhood effects. | Do not depend on code/models until their official artifacts and license are verified. |
| [ReMe](https://aclanthology.org/2026.findings-acl.829/) and [official code](https://github.com/agentscope-ai/ReMe) | Findings ACL 2026 / B-D | Distill success, failure, and comparative experience; refine utility and prune poor procedures. | Model-authored consolidation remains poisonable and needs AgenC governance. |
| [Memp](https://aclanthology.org/2026.findings-acl.866/) | Findings ACL 2026 / B | Represent procedures at fine-grained step and higher-level script granularity; correct and deprecate them. | TravelPlanner/ALFWorld gains do not establish coding-agent transfer. |
| [Text2Mem](https://aclanthology.org/2026.findings-acl.100/) | Findings ACL 2026 / B | Represent natural-language memory requests as validated typed operations with explicit fields/invariants, then execute them through one auditable pipeline. | A memory operation language does not itself establish source authority, policy correctness, or safe backend behavior. |
| [StructMem](https://aclanthology.org/2026.acl-short.12/), [GAM](https://aclanthology.org/2026.acl-long.1600/), and [HeLa-Mem](https://aclanthology.org/2026.acl-long.625/) | ACL 2026 / B | Preserve event bindings, temporal anchors, consolidation boundaries, and multiple retrieval signals. | Their primary evaluations are conversational QA; graph structure alone does not solve authority or execution state. |
| [MemGuard](https://arxiv.org/abs/2605.28009) | Preprint / C | Keep stable facts, episodic events, and behavioral rules type-separated at write and retrieval time; compose only the functional types required for the query. | Reported reliability/token gains are author-run on conversational/hallucination tasks; type separation does not establish authority or action safety. |
| [SelfMem](https://arxiv.org/abs/2607.03726) | Preprint / C | Permit feedback-driven strategy experiments behind a sandboxed interface. | Author-run BEAM gains do not justify self-modifying security policy. |
| [Proactive Memory Agent](https://arxiv.org/abs/2607.08716) and [official code](https://github.com/yifannnwu/proactive-memory-agent) | July 2026 preprint / C-D | Use a separate selective intervention/no-op decision and evaluate downstream task behavior; never dump the full bank. | Terminal/tool-task gains are author-run and the memory agent is not a governance layer. |
| [Context Folding](https://arxiv.org/abs/2510.11967) and [FoldAgent implementation](https://github.com/sunnweiwei/FoldAgent) | ICML 2026 / B-D | Run exploratory subtrajectories in isolated branches and fold only validated results into the parent. | The available repository is a reimplementation; reproduce on AgenC before adopting training claims. |
| [ACON](https://arxiv.org/abs/2510.00615) and [official code](https://github.com/microsoft/acon) | ICML 2026 / B-D | Optimize compaction against downstream task outcomes, not summary similarity alone. | Learned compression remains model/workload dependent. |
| [CompactionRL](https://arxiv.org/abs/2607.05378) | July 2026 preprint / C | Preserve original goal, exact recent tail, and atomic assistant/tool pairs in every compactor experiment. | Limited author-run evaluation; use invariants before policy weights. |
| [MemSyco-Bench](https://arxiv.org/abs/2607.01071) and [official resources](https://github.com/XMUDeepLIT/MemSyco-Bench) | July 2026 preprint / C | Test when memory should not influence facts, scope, conflict resolution, updates, or personalization. | New benchmark; freeze a reviewed revision before using it as a gate. |
| [PM-Bench](https://arxiv.org/abs/2607.12385) | COLM 2026 / A-B | Keep prospective intentions distinct and test cue detection, timing, expiry, and non-trigger behavior. | No tested method dominates; do not auto-enable consequential future actions. |
| [PASB durable-write study](https://arxiv.org/abs/2607.10526) and [official code](https://github.com/henrymao2004/agent-sycophancy) | July 2026 preprint / C-D | Quarantine writes, preserve source/status/uncertainty, prevent scope broadening, and use stricter promotion for profiles/procedures. | Its two evaluated frameworks and models are not AgenC; reproduce the attack ladder locally. |
| [Memora mutation/forgetting study](https://aclanthology.org/2026.findings-acl.1337/) | Findings ACL 2026 / A-B | Measure invalidated-memory use across long mutation histories rather than only immediate correction. | Conversational/mutation results need agentic coding cases. |
| [PerMemSafe](https://aclanthology.org/2026.findings-acl.320/) | Findings ACL 2026 / A-B | Evaluate implicit personalized safety over evolving memory as well as helpful personalization. | Its reported benchmark/framework numbers are author-run and conversational; adapt without inferring unsupported sensitive traits. |
| [Experience-following study](https://aclanthology.org/2026.acl-long.27/) | ACL 2026 / A-B | Use only objectively validated experiences for procedures; test stale and misaligned replay. | Similarity can copy both good and bad behavior. |
| [MPBench memory-poisoning study](https://arxiv.org/abs/2606.04329) | Preprint / C | Gate writes and reads; red-team every write channel; do not treat prompt-injection filtering as sufficient. | Its taxonomy is not a proof that all attack classes are known. |
| [Sleeper memory poisoning](https://arxiv.org/abs/2605.15338) | Preprint / C | Test delayed write → later retrieval → action activation across restarts and sessions. | Reported rates are bounded to evaluated systems/models. |
| [GhostWriter / AM-Sentry](https://arxiv.org/abs/2607.06595) | July 2026 preprint / C | Use independent save admission and retrieval screening as defense in depth. | Filters reduce but do not eliminate attacks and may overblock. |
| [FARMA](https://arxiv.org/abs/2607.05029) | July 2026 preprint / C | Red-team forged/self-reinforcing rationale entries; do not retain hidden reasoning and do not let repeated memory text manufacture corroboration. | SENTINEL and the reported attack/defense rates are author-run; structural/model filters are defense in depth, not authority. |
| [Remembering More, Risking More](https://arxiv.org/abs/2605.17830) | Preprint / C | Evaluate contamination longitudinally with fixed trigger probes over read-only memory snapshots and a `NullMemory` counterfactual, not only one clean/poisoned snapshot. | Its deployment scenarios and reported monitor results are author-run and not coding-agent proof. |
| [Origin-bound authority](https://arxiv.org/abs/2606.24322) and [artifact](https://github.com/yedidel/mem-inv-bench) | Single-author preprint/formal model / C | Bind immutable authority to authenticated origin; transformation, tool echo, and corroboration cannot raise it. | Independently validate the formal assumptions and implementation. |
| [MEMOREPAIR](https://arxiv.org/abs/2605.07242) | Preprint / C | Withdraw a corrected root and all known causal descendants before asynchronous repair. | Complete protection depends on complete influence provenance. |
| [AgentLeak](https://doi.org/10.1109/ACCESS.2026.3704541), [arXiv revision](https://arxiv.org/abs/2602.11510), and [code](https://github.com/Privatris/AgentLeak) | IEEE Access 2026 / B-D | Audit internal messages, tools, memory, logs, files, and artifacts—not final answers alone. | It is an author-built benchmark with concentrated large-scale analysis on selected channels; adapt it to AgenC's actual channels. |
| [AgentSys](https://arxiv.org/abs/2602.07398) | Preprint / C | Isolate untrusted tool/subtask traces in workers and allow only typed, schema-validated, policy-checked publications across hierarchy boundaries. | Its attack/utility results are author-run; schema validation alone does not establish truth, authority, or safe publication. |
| [Deployment-time memorization](https://arxiv.org/abs/2606.10062) | ICML MemFM 2026 Workshop / C | Test deletion residue in summaries, indexes, embeddings, caches, and propagated tiers. | A successful test cannot prove erasure from unmanaged external copies. |

## Current AgenC memory audit

The current system is a useful compatibility baseline, not a blank slate.

| Surface | Current behavior observed on 2026-07-22 | Preserve | Gap to close |
| --- | --- | --- | --- |
| Instruction separation | [`runtime/src/memory/agencmd.ts`](runtime/src/memory/agencmd.ts) loads managed/user/project/local instructions and frames persistent memory as untrusted, stale, model-authored context. | Instruction precedence and the explicit untrusted boundary. | Delimiters and warnings are not an enforcement mechanism; provenance and policy must be outside the model. |
| Durable paths | [`runtime/src/memory/paths.ts`](runtime/src/memory/paths.ts) and [`docs/reference/memory.md`](docs/reference/memory.md) expose global and project memory, with automatic memory enabled by default subject to settings/environment gates. | Paths, worktree behavior, configuration priority, direct inspection, and opt-out. | Files encode content but not item-level authority, validity, lineage, or lifecycle. |
| Path resolution | Canonical loading defaults to `<projectRoot>/.agenc/memory`, extraction's duplicated resolver defaults to `$AGENC_HOME/projects/<key>/memory`, and relevant recall hard-codes `$AGENC_HOME/memory` plus `<cwd>/.agenc/memory`. | One documented resolver supporting local/remote roots, overrides, project roots, worktrees, Bun/Node, and subdirectories. | **Split-brain defect:** background-extracted local memory is normally invisible to prompt loading/recall; long project keys can also diverge because resolvers hash differently. Fix before redesign rollout. |
| Memory taxonomy | [`runtime/src/memory/types.ts`](runtime/src/memory/types.ts) uses `user`, `feedback`, `project`, and `reference`, with useful “do not save derivable state” and drift guidance. | Existing frontmatter and legacy type compatibility. | Storage type, semantic kind, scope, authority, sensitivity, validity, and action use are conflated. |
| Scan/selection | [`runtime/src/memory/scan.ts`](runtime/src/memory/scan.ts) scans at most 200 Markdown files to depth 3. [`runtime/src/memory/find-relevant.ts`](runtime/src/memory/find-relevant.ts) asks a side model to choose up to five files from filenames/descriptions. | Bounded, selective, abstaining recall. | No deterministic baseline, hard authorization prefilter, conflict set, dependency retrieval, validity filter, calibrated score, or outcome feedback. |
| Prompt injection bounds | Entrypoint `MEMORY.md` uses a 200-line cap and a constant named as a 25,000-byte cap, but [`runtime/src/memory/memdir.ts`](runtime/src/memory/memdir.ts) currently measures JavaScript UTF-16 code units (`string.length`), not UTF-8 bytes; a separate surface uses a 40,000-character soft cap. [`runtime/src/prompts/attachments/relevant-memories.ts`](runtime/src/prompts/attachments/relevant-memories.ts) limits topics to five files, 4 KiB/200 lines per file, and 60 KiB per session; rendering marks them untrusted. | Strict entrypoint/per-turn/session budgets, citations, dedupe, and no subagent session-start recall. | Fix the mislabeled/truncation semantics with UTF-8-safe tests. Bounds reduce cost, not poisoning, and a recalled file remains an undifferentiated block of model-authored Markdown. |
| Automatic extraction | [`runtime/src/services/extractMemories/extractMemories.ts`](runtime/src/services/extractMemories/extractMemories.ts) runs a restricted child that can read/write only the memory directory. Its prompt in [`prompts.ts`](runtime/src/services/extractMemories/prompts.ts) explicitly forbids verifying recent-message claims against code or Git. | Main-context gating, path confinement, bounded turns, cadence, and environment disable. | The model directly edits durable files; there is no propose/validate/commit boundary, atomic claims, authenticated origin, or independent verifier. The no-verification instruction must be removed from the durable-admission path. |
| Pipeline state | [`runtime/src/state/migrations/011_memory_pipeline_schema.ts`](runtime/src/state/migrations/011_memory_pipeline_schema.ts) and [`runtime/src/memory/store.ts`](runtime/src/memory/store.ts) contain solid lease/watermark/retention scaffolding for Stage 1/Phase 2. | Existing job mechanics, WAL-backed state-store practices, and additive migrations. | Repository search found no production constructor/caller for this facade. It is not the live durable pipeline and lacks canonical item/version/event/evidence/influence/access/retrieval/outcome records. |
| State-store topology | [`runtime/src/state/sqlite-driver.ts`](runtime/src/state/sqlite-driver.ts) resolves the state and logs SQLite databases under the current project directory. | Project-local durability, permissions, backup, migration, WAL, and recovery behavior. | A project DB is not a canonical cross-project home for `user_global`; future team data also needs an authenticated owner/transport. Define physical namespace placement and cross-database semantics before the memory schema migration. |
| Session memory | [`runtime/src/memory/session/sessionMemory.ts`](runtime/src/memory/session/sessionMemory.ts) periodically updates a bounded, mode-`0600` Markdown state summary with a restricted child agent. [`prompts.ts`](runtime/src/memory/session/prompts.ts) warns that prior notes are untrusted. | File hardening, size checks, serialized lanes, and structured high-level sections. | Update cursors are process-local, terminal work is fire-and-forget, post-generation structure is not validated, and free-form summary can preserve stale/failed-branch state. |
| Compaction | [`runtime/src/services/compact/sessionMemoryCompact.ts`](runtime/src/services/compact/sessionMemoryCompact.ts) contains an opt-in alternate compactor that could consume session memory, but production wiring supplies no `sessionMemory` dependency. Normal model compaction is live. | Retained recent turns/tool pairs and tool-call/result atomicity. | Session memory currently incurs writes/model calls without feeding production compaction. Normal summaries lack typed branches/evidence and need untrusted transcript framing plus delimiter escaping. |
| Background consolidation | [`runtime/src/services/autoDream/autoDream.ts`](runtime/src/services/autoDream/autoDream.ts) defaults off and invokes a forked agent when enabled. | Locking, scheduling, abort, progress, and off-by-default behavior. | Its prompt requires transcript/code inspection and read-only shell commands that its child policy denies, then marks completion without validating mutations. Replace direct edit/delete with governed candidates. |
| Filesystem safety | Instruction/persona and agent-memory code use stronger canonical/no-follow/inode/link checks than durable Markdown loading, topic scanning, and prompt attachment reads. Durable write admission also returns before later general file checks. | Reuse the strongest existing descriptor-based containment implementation. | Repository-local symlinks/hard links/root swaps can cross intended boundaries or inject content; global/project creation modes also need an explicit restrictive policy. |
| Privacy | [`runtime/src/memory/privacy.ts`](runtime/src/memory/privacy.ts) has useful high-confidence secret matching/redaction, but production pre-write rejection is effectively limited to one team `Write` path. | Secret detection/redaction plus MCP read redaction. | `Edit`, `MultiEdit`, extraction, personal, global, project, agent, and session paths can bypass screening. Regex screening also is not DLP, purpose/sink control, provenance, or verified deletion. |
| Per-agent memory | [`runtime/src/tools/AgentTool/agentMemory.ts`](runtime/src/tools/AgentTool/agentMemory.ts) provides strong user/project/local namespace and filesystem hardening; [`agentMemorySnapshot.ts`](runtime/src/tools/AgentTool/agentMemorySnapshot.ts) hardens snapshots. | Stable agent namespace identity, secure path authority, snapshots, and local scope. | Entire unbounded `MEMORY.md` content is appended raw to agent system prompts without the durable-memory trust wrapper/age/budget. Loader gates also drift from canonical auto-memory settings. |
| Team memory | The compiled team feature is treated as enabled with automatic memory and prompt text claims session sync, but no sync service was found; background extraction has no team routing and `/memory` hides the team store. | Strong team path-key validation helpers if/when real transport exists. | Do not claim sync or enable shared semantics without a transport, identity/access model, review workflow, and end-to-end tests. |
| TUI/operator access | `/memory` exposes a human-editable picker/editor. | Inspectability, manual correction, and Markdown import/export. | Need item-level explain, origin, conflict, quarantine, forget, repair, and deletion-status UX. Filesystem edits alone cannot be treated as authenticated current-user authorization. |
| Session pollution gate | The current working tree adds `enabled`, `disabled`, and `polluted` memory modes in [`runtime/src/session/attachment-state.ts`](runtime/src/session/attachment-state.ts). | A single session-level emergency brake. | This is overlapping uncommitted swarm work; implementation must re-audit/rebase it and define exact read/write/maintenance semantics in one policy service. |

### Concrete current risks

1. A malicious repository, web page, MCP result, tool output, user-supplied document, or compromised worker can enter the visible transcript; the extraction child can later turn it into durable Markdown without live verification.
2. A later model sees the memory through an “untrusted” prompt wrapper, but the model—not code—decides whether to follow it.
3. Summarization or consolidation can launder origin because the output does not retain an immutable source principal, channel, digest, and authority ceiling.
4. A correction can edit/delete one file without atomically withdrawing summaries, procedures, indexes, caches, or descendants derived from it.
5. Similarity/file-description recall can replay a successful-looking but failed, stale, provider-specific, branch-specific, or permission-sensitive procedure.
6. Current metadata cannot distinguish “likely true” from “authorized to influence an action.”
7. Shared/team/agent paths do not yet provide one demonstrably complete deny-by-default predicate for search, enumeration, direct lookup, export, lineage, snapshots, background jobs, and caches.
8. The current test suite exercises memory plumbing and bounds but is not a memory-specific utility, poisoning, privacy, forgetting, repair, or multi-agent benchmark harness.
9. The live extractor can write to a directory that neither normal prompt loading nor relevant recall consumes, creating a false-success state and duplicate-memory risk.
10. Session memory, SQLite Stage 1/Phase 2, and alternate session-memory compaction contain useful code but currently lack production end-to-end wiring.
11. Team prompt claims, filesystem paths, settings documentation, and loader feature gates have drifted apart; a redesign built on them without first unifying the contract will compound the defect.
12. A truncated relevant-memory attachment can direct the model to read the complete file through ordinary file tools; prompt-injection byte caps therefore do not bound every later memory-content access path.
13. Current relevance selection sends the user query plus memory filenames/descriptions through a hard-coded side-model path without item-level sensitivity or provider-sink policy.
14. Normal compaction is syntax-aware, but its model summary is untyped and a provider-failure fallback can discard the middle of the covered history; neither path proves active-state completeness.
15. One successful legacy extractor write advances the whole visible message range, so unrelated eligible memories in that range can be silently missed while failures are largely background-only.

## Target architecture

The design separates authority, evidence, execution state, durable knowledge, and disposable retrieval indexes. They must not collapse back into a single “memory” text block.

```text
live user / tools / repo / MCP / web / agents
                    |
             evidence capture
       (origin, principal, scope, digest first)
                    |
          atomic candidate extraction
                    |
   deterministic policy + DLP + validation
             /                    \
     quarantine/reject       versioned ledger
                                  |
                       disposable derived indexes
                                  |
request -> scoped authorization -> retrieve -> conflict/validity check
                                  |
                         bounded context compiler
                                  |
                               model
                                  |
                    live verification/action gate
```

In parallel, each long-running task owns a versioned execution-state tree. Only the active root-to-current path is compiled as current state. Failed branches remain available as explicitly failed evidence or hints, never as current truth.

### Memory planes

| Plane | Contents | Authority and lifetime | Canonical form |
| --- | --- | --- | --- |
| Live authority (not learned memory) | Current system/developer/user instructions, managed policy, permission decisions, sandbox and capability state | Highest applicable live envelope; expires with its defined scope | Existing instruction and policy services |
| Evidence journal | Minimal observable events and references: user statements, tool results, file/resource digests, task outcomes, corrections | Immutable origin; append-only; retention policy applies | SQLite event records pointing to existing transcript/event/tool artifacts where possible |
| Working/execution state | Current objective, subgoals, active branch, verified state, pending uncertainties, checkpoints, side effects | Thread/task/worktree scoped; short-lived; branch-aware | Execution-state tables plus bounded projections |
| Durable memory ledger | Atomic preferences, profile claims, project facts, references, episodes, and validated procedures | Versioned, scoped, expiring/reviewable, revocable | SQLite items/versions/evidence/influence records |
| Derived retrieval plane | Lexical index, optional vectors, semantic edges, summaries, cues, caches | No authority; rebuildable; security-domain partitioned; cascade-deletable | Versioned adapter-owned projections |
| Human-readable projection | `MEMORY.md` and topic files for inspection/import/export | Compatibility view, never an authority escalation channel | Existing global/project directories with provenance headers or sidecar metadata |

### Durable memory kinds

Keep the existing four frontmatter types for compatibility, but map them to a richer internal kind:

| Proposed kind | Intended use | Admission rule |
| --- | --- | --- |
| `preference` | Communication/style defaults and explicit user choices | Must identify whose preference, applicable scope, source event, exceptions, and expiry/review policy. Never grants action permission. |
| `profile_claim` | Work-relevant user role, expertise, or goals | Minimize sensitive inference; prefer explicit statements; allow user inspection/correction/deletion. |
| `semantic_claim` | Non-derivable project/team fact or decision | Store observation time, validity interval, evidence, and a refresh/verification strategy. Live repo/tool evidence wins on conflict. |
| `reference` | Pointer to an external source of fresh truth | Store purpose and access/sink constraints, not credentials or copied secrets. Re-resolve before use. |
| `episode` | Compact record of an objectively relevant past attempt and outcome | Preserve success/failure/partial status, environment/version conditions, and verifier evidence. |
| `procedure` | Generalized reusable workflow | Start in trial state; require objective outcome evidence and applicability conditions; scripts remain untrusted suggestions and never auto-execute. |
| `warning` | Validated failure pattern, incompatibility, or hazard | Preserve the failed conditions and evidence; do not generalize beyond tested scope. |
| `prospective_intention` | Explicit future task/intention | Separate scheduler semantics, due cue, cancellation/supersession, idempotency, expiry, and execution-time authorization. Do not infer silently. |

Legacy mapping is a migration aid, not a semantic identity: `user` usually maps to `preference` or `profile_claim`; `feedback` to `preference`, `warning`, or a `procedure` candidate; `project` to `semantic_claim`; and `reference` to `reference`. Preserve the original type and source file on every import.

## Non-negotiable invariants

Give each invariant a stable test ID. Every public memory operation and every backend adapter must pass the same contract suite.

- **MEM-I01 — instruction separation:** learned memory can never enter the managed instruction tier or modify policy/permission configuration.
- **MEM-I02 — no stored action authority:** a durable memory has `action_authority = none`. Consequential actions require the current live authorization flow even if a memory says the user approved them before.
- **MEM-I03 — origin before interpretation:** capture source principal, channel, artifact/event reference, content digest, workspace/task/agent context, and timestamp before any model transforms content.
- **MEM-I04 — monotonic authority:** summarization, merging, extraction, tool echo, corroboration, agent delegation, and repeated retrieval may preserve or lower the minimum source authority; they cannot raise it.
- **MEM-I05 — confidence is not authority:** independent evidence may increase epistemic confidence, but plausibility, repetition, or model confidence never widens access or authorizes an action.
- **MEM-I06 — value-level taint:** a trusted tool transport does not make attacker-controlled values trusted. Derived claims retain all contributing origins and the most restrictive applicable taint/sink policy.
- **MEM-I07 — deny by default:** the same policy predicate guards search, enumeration, direct-ID reads, lineage, export, import, snapshots, caches, background workers, context injection, and adapter calls.
- **MEM-I08 — private by default:** session/task/agent memory is visible only to its owner and authorized parent context. Sharing or durable publication is explicit, capability-bound, expiring where appropriate, and audited.
- **MEM-I09 — scope before content:** authorization filters execute before memory content is exposed to a model, reranker, remote embedder, cache, or caller. Post-filtering an unauthorized candidate set is insufficient.
- **MEM-I10 — memory is data:** repository, MCP, web, message, tool-output, worker, and stored-memory text is never interpreted as instructions by the control plane.
- **MEM-I11 — atomic claims:** durable items contain one independently versionable claim/preference/procedure unit. Free-form files are projections, not the unit of lifecycle control.
- **MEM-I12 — complete derivation:** every summary, procedure, cue, embedding, semantic edge, and other derived artifact identifies its input versions and transformation version.
- **MEM-I13 — active-only serving:** only active, unexpired, scope-allowed versions can be served. Quarantined, superseded, retracted, deleted, failed-branch, and repair-pending versions are non-servable by all paths.
- **MEM-I14 — barrier-first invalidation:** correcting, retracting, or forgetting a source transactionally marks it and every known causal descendant non-servable before any asynchronous repair begins.
- **MEM-I15 — conflicts stay visible:** contradictory active claims form an explicit conflict set. Retrieval must not silently select the most similar or most recent claim when resolution is uncertain.
- **MEM-I16 — current observation wins:** live repository state, current tool/API results, and current explicit user corrections outrank a persisted claim for factual decisions; the conflict triggers update or invalidation.
- **MEM-I17 — bounded influence:** recall is selective, budgeted, cited, and allowed to abstain. Failure or timeout of memory degrades to no-memory behavior, not a blocked or insecure agent.
- **MEM-I18 — no direct model mutation:** models and third-party adapters only propose candidates, scores, summaries, links, or repairs. Deterministic AgenC code validates and commits all state changes.
- **MEM-I19 — no secrets or hidden reasoning:** never persist credentials, tokens, private keys, known secret material, provider-hidden reasoning, or reconstructed chain of thought. Minimize sensitive personal data and raw external content.
- **MEM-I20 — purpose/sink limitation:** each item has a permitted purpose and sink policy. Data allowed locally is not automatically allowed in a remote model, embedding service, MCP server, worker, log, or team store.
- **MEM-I21 — precise deletion:** APIs distinguish immediate logical withdrawal, deletion from AgenC-managed live/derived stores, cryptographic erasure when supported, propagated-copy status, and unmanaged-backup limitations.
- **MEM-I22 — auditable/idempotent mutation:** every mutation has an event, actor, reason code, idempotency key, old/new version reference, and transaction boundary. Retries cannot duplicate or resurrect state.
- **MEM-I23 — one policy for foreground/background:** extraction, compaction, consolidation, repair, import, sync, agents, swarms, and human UI use the same authority and lifecycle service.
- **MEM-I24 — provider-independent safety:** changing the chat model, side model, embedder, or adapter cannot weaken authorization, taint, lifecycle, deletion, or action gates.
- **MEM-I25 — effects are not rolled back implicitly:** revising execution state changes the agent's logical active branch. External side effects require explicit compensating actions and live approval where applicable.
- **MEM-I26 — compatibility is reversible without resurrection:** migration never destroys legacy Markdown and projections can be exported, but no rollback may bypass a serving barrier, deletion epoch, or tombstone. Before lifecycle state exists, a stage may return to the current reader; afterward, fallback is limited to a tombstone-aware compatibility reader or memory-off. Raw legacy writers never resume automatically.
- **MEM-I27 — personalization cannot weaken safety:** remembered preferences/profile context cannot lower live safety, permission, privacy, or policy controls. Safety-relevant personalization must use allowed evidence and cannot invent sensitive user attributes.
- **MEM-I28 — metadata is untrusted too:** filenames, titles, descriptions, tags, agent names, citations, and adapter metadata are escaped/bounded data and can never smuggle prompt or policy instructions.
- **MEM-I29 — no hidden resource authority:** extraction, reranking, validation, consolidation, repair, and embedding calls obey the existing abort/deadline/token/cost/concurrency budgets and appear in usage accounting; memory cannot start unbounded background model work.

## Proposed canonical data model

The names below are a **logical** design target, not yet a physical SQLite layout. AgenC's current state database is per-project. Before implementation, confirm the next available migration number and approve a storage-topology ADR that maps every namespace to exactly one canonical database/owner. The ADR must decide whether global memory uses a dedicated `AGENC_HOME` control database or another local topology; how project and global queries compose without cross-database foreign-key assumptions; how locks, transactions, IDs, backups, restores, deletion epochs, and downgrade refusal work; and why team storage remains disabled until it has authenticated ownership/transport. Do not create the schema first and discover these boundaries later.

Use strict TypeScript decoders at every JSON/protocol boundary; do not pass unvalidated metadata blobs into policy. All user-derived content that can be erased must live outside append-only record envelopes, as defined below.

### Identity and namespaces

`memory_namespaces`

- stable namespace ID and kind (`user_global`, `workspace`, `project`, `thread`, `task`, `agent_private`, `team_shared`);
- owning principal and optional workspace/project/thread/task/agent identifiers;
- canonical repository identity separate from worktree identity;
- default retention, sensitivity ceiling, sink policy, sharing policy, and status;
- creation/retirement event IDs.

`memory_capabilities`

- opaque capability/grant ID, issuer, grantee, namespace, permitted operations, purpose/sink bounds, issue/expiry/revocation times, and audit event;
- no bearer secret in logs or projections;
- optional for explicit shared/team publication, never used to bypass current execution authority.

### Evidence and immutable history

`memory_events`

- append-only event ID, event kind, actor principal/agent, source channel, source reference, source digest where retention policy permits it, capture time, workspace/thread/task/agent context, taint labels, sensitivity, and either an authorized source pointer or nullable payload ID;
- references existing transcript, event-log, tool-result, file, or resource artifacts rather than duplicating large bodies;
- excludes inline user-derived content, secret values, and hidden reasoning;
- records correction, retraction, deletion, repair, policy verdict, import, export, and projection events as well as observations.

`memory_payloads` (only when an authorized source pointer is insufficient)

- separately retained/encrypted-if-supported minimal content for an event, candidate, version, or execution node, with owner kind/ID, content schema, sensitivity, retention, deletion epoch, and digest only while that digest is allowed to remain;
- contains every potentially identifying/free-text body: event excerpt, proposed/normalized/display content, retrieval cues, applicability text, and legacy bytes/frontmatter that are not merely referenced elsewhere;
- an immutable envelope may reference a nullable payload, but payload bytes are erasable. Deletion first makes every owner non-servable, purges derived artifacts, nulls the owner reference, and then removes the payload row; no metadata or influence edge is deleted merely as an accidental foreign-key cascade;
- surviving envelopes retain only the minimum authorized, content-free audit/provenance fields. Treat source references, subjects, tags, and content digests as potentially identifying—not harmless metadata;
- anti-resurrection fingerprints, if retained, must be separately threat-modeled (for membership attacks), purpose-limited, domain-keyed/rotatable, and erasable when the requested guarantee requires it;
- never copy a whole transcript/tool body here merely for convenience.

`memory_candidates`

- candidate ID, proposed kind/scope, nullable payload ID, extractor and prompt/schema versions, evidence event IDs, minimum origin-authority ceiling, confidence, sensitivity, sink policy, proposed TTL/review time, and idempotency key;
- lifecycle: `proposed`, `quarantined`, `validating`, `approved`, `rejected`, `expired`;
- machine-readable policy/rejection reason codes plus optional human review reference;
- candidate payload cannot be retrieved as active memory and is purged on its own reviewed retention schedule.

### Durable items and provenance

`memory_items`

- stable logical item ID, namespace, kind, opaque or nullable subject key, current version ID, lifecycle status, conflict-group ID, created/updated events, and retention class; free-text/identifying subjects belong in the payload, not the envelope;
- lifecycle: `active`, `superseded`, `retracted`, `expired`, `repair_pending`, `deleted_tombstone`;
- the tombstone retains only the minimum non-sensitive identifiers needed to prevent accidental resurrection and prove workflow completion.

`memory_versions`

- immutable version ID and item ID;
- nullable payload ID for normalized/display content, retrieval cues, applicability text, and retained legacy bytes/frontmatter;
- observation/valid-from/valid-until/review-after/expiry timestamps plus non-content schema/transform identifiers;
- legacy type/path metadata only when retention policy permits it; move identifying path/frontmatter content into the payload;
- origin authority ceiling, `action_authority = none`, epistemic confidence, sensitivity, taint, purpose and sink policies;
- model/provider/tool/repository/schema/runtime conditions where relevant;
- content digest only while policy permits it, schema version, transformation version, creation event, and superseded-by version;
- no mutable “trust score” that can erase origin.

`memory_version_evidence`

- version ID, evidence event ID, relationship (`supports`, `contradicts`, `corrects`, `user_confirmed`, `outcome_validated`), and contribution metadata;
- at least one evidence edge for every non-imported version;
- explicit negative/conflicting evidence is retained.

`memory_influence_edges`

- causal parent version/event → derived child version/artifact;
- transformation ID, creation event, completeness marker, and invalidation status;
- used for barrier-first withdrawal and repair; never substitute semantic similarity for causal derivation.

`memory_semantic_edges`

- optional typed retrieval relationship between active versions (`same_subject`, `temporal_successor`, `related_context`, `contradicts`);
- derived and disposable except the explicit conflict relationship;
- cannot affect authority or access.

### Retrieval, outcomes, and derived artifacts

`memory_index_artifacts`

- artifact ID, source version ID, adapter/index/model version, security-domain partition, digest, creation time, status, and deletion event;
- covers lexical rows, vectors, cues, summaries, caches, or optional graph projections;
- rebuildable from active versions and purgeable by source version.

`memory_retrieval_events` and `memory_retrieval_items`

- caller policy context, query digest/minimized features, selected candidate IDs, hard-filter decisions, component scores, rerank/validator versions, conflicts, packed tokens, citations, abstention/rejection reasons, latency, cost, and provider sink;
- do not log raw sensitive queries or memory bodies by default;
- record which items were actually placed in context separately from those merely considered.

`memory_outcomes`

- retrieval event/item, task/action reference, whether the memory was cited/used, objective verifier status/reference, human correction/confirmation event reference, utility/harm labels, cost, and timestamp; any explanatory text belongs in an erasable source/payload;
- never infer “helpful” solely because the model cited or repeated a memory;
- drives trial procedure promotion, demotion, review priority, and offline evaluation—not authorization.

### Execution state

Execution state must extend AgenC's existing fsync-durable run/turn/effect spine, not create a second recovery authority. [`runtime/src/budget/admitted-tool-call.ts`](runtime/src/budget/admitted-tool-call.ts) journals admitted effects; [`runtime/src/state/run-durability.ts`](runtime/src/state/run-durability.ts) and [`runtime/src/state/migrations/015_run_durability_schema.ts`](runtime/src/state/migrations/015_run_durability_schema.ts) own `run_effects`; and [`runtime/src/session/rollout-store.ts`](runtime/src/session/rollout-store.ts), [`runtime/src/session/rollout-reconstruction.ts`](runtime/src/session/rollout-reconstruction.ts), [`runtime/src/session/durable-turns.ts`](runtime/src/session/durable-turns.ts), [`runtime/src/session/turn-state.ts`](runtime/src/session/turn-state.ts), and [`runtime/src/state/startup-run-journal-recovery.ts`](runtime/src/state/startup-run-journal-recovery.ts) already project/recover durable work. The execution-memory ADR must define how nodes and heads reference these canonical records and must prohibit duplicated effect status/outcomes.

`execution_nodes`

- task/thread/worktree, parent node, active-branch generation, nullable payload ID, evidence/event references, validation status, and node state (`active`, `completed`, `failed`, `abandoned`, `rolled_back`);
- the erasable payload holds objective/subgoal, compact observable state, unresolved-question text, and summaries—never hidden reasoning;
- canonical rollout/run/turn/checkpoint event IDs and source sequence ranges plus creation/completion times.

`execution_effect_links` (only if a node-to-effect join is not already available)

- node ID plus the existing canonical run ID/step ID/tool-call/effect identity and optional compensation-plan reference;
- contains no copied target, result, recovery category, idempotency key, approval, or current status: those remain owned by the durable run/effect journal;
- deleting or revising an execution branch never mutates the canonical effect outcome and never implies that a real-world side effect was reversed.

`execution_state_heads`

- one transactional active head per task generation plus last validated checkpoint;
- Compare-And-Swap/version field to prevent concurrent agents from silently overwriting the active path.

### Security and operations

`memory_policy_events`

- append-only allow/deny/quarantine/withdraw/publish/delete verdict, stable reason code, actor/caller, policy version, relevant IDs/digests only while allowed, and time;
- content-minimized and redacted, but sufficient for `memory explain`, incident response, and contract tests.

`memory_jobs`

- evolve or replace the current memory-job coordination without breaking existing Stage 1 data;
- typed jobs for validation, projection, index, consolidation, repair, expiry, deletion, and audit;
- leased/idempotent jobs with bounded retry, dead-letter/quarantine status, cancellation, and crash recovery.

### Required database behavior

- [ ] Approve the physical storage-topology ADR before writing a migration. Give each namespace exactly one canonical owner/database; define cross-project global reads as explicit federation/routing rather than pretending SQLite can enforce foreign keys or atomic transactions across independent project stores.
- [ ] Define cross-owner publication as an authenticated, idempotent outbox/inbox copy that creates a new destination candidate with immutable source references and inherited restrictions. Quarantine partial delivery; never move scope by updating a project row or claim a distributed transaction that SQLite does not provide.
- [ ] Use additive state-store migrations; do not rewrite or drop migration 011 data in place.
- [ ] Enforce foreign keys and uniqueness/idempotency constraints in SQLite, not TypeScript alone.
- [ ] Define payload-reference and deletion foreign-key behavior explicitly: metadata envelopes and causal edges survive payload erasure when required for audit/anti-resurrection, nullable payload references cannot be served, and no cascade may delete lineage needed to quarantine descendants.
- [ ] Use versioned, domain-separated cryptographic digests for content/provenance identity; do not reuse a path-sanitization or non-cryptographic hash as an integrity primitive.
- [ ] Commit item/version/evidence/influence/head changes in one transaction when their atomic visibility matters.
- [ ] Make “servable active version” a centralized repository query/predicate with tests; consumers must not hand-roll status filters.
- [ ] Put security-domain identifiers in every derived-index key. If an adapter cannot enforce prefiltering, it is not eligible for mixed-scope content.
- [ ] Make all derived artifacts rebuildable and versioned. A rebuild must never resurrect withdrawn content.
- [ ] Keep the minimal tombstone/deletion-epoch guard readable in every compatibility mode. If a legacy adapter cannot consult it before enumeration/direct read/context injection, that adapter is unavailable and fallback is memory-off.
- [ ] Preserve current state-store directory/file permission, backup, WAL, durability, and corruption-recovery practices.
- [ ] Benchmark SQLite growth, indexes, migrations, and VACUUM/compaction behavior at realistic multi-year event volumes before setting retention defaults.

## Central policy and authority model

Do not implement a single mutable “trust score.” Authority is contextual: a user is authoritative about their own preference, a successful filesystem read is evidence about that observed file at that time, and neither is authority to spend money or weaken a sandbox.

Each policy decision receives a typed `MemoryPolicyContext` containing:

- live principal and daemon-client identity;
- workspace, canonical project, worktree, thread, task, and agent path;
- requested operation and purpose;
- destination recipient/sink/provider;
- current permission/sandbox state and applicable live instruction envelope digest;
- item namespace, origin set, authority ceiling, sensitivity, taint, lifecycle, validity, and capability grants.

The policy service exposes one implementation of at least:

- `canCaptureEvidence`
- `canPropose`
- `canActivate`
- `canReadMetadata`
- `canReadContent`
- `canSendToSink`
- `canPublish`
- `canCorrect`
- `canForget`
- `canExport`
- `canUseForAction`

No consumer receives a repository handle that permits raw SQL or adapter access around these methods.

### Origin classes

| Origin class | Examples | Default treatment after persistence |
| --- | --- | --- |
| `explicit_user_live` | Current authenticated user says “remember that I prefer …” | May support a safe, inspectable preference/profile candidate. Loses live action authority when persisted. |
| `managed_host_observation` | AgenC records a tool exit code, test result, current path, or permission verdict | Evidence only for the value actually observed at that time. Attacker-controlled output fields retain their lower origin/taint. |
| `workspace_content` | Repository files, `.agenc/memory`, issue text checked into the workspace | Untrusted evidence; cannot grant permissions or silently become a user preference/procedure. |
| `remote_content` | Web, MCP, email, API response, downloaded document | Untrusted, sink-limited evidence; external instructions are data. |
| `agent_or_model_statement` | Assistant assertion, worker result, extractor inference, compaction summary | Derived proposal only; must cite inputs and cannot raise their authority. |
| `legacy_import` | Existing Markdown without trustworthy write-time provenance | Active only in an explicit legacy compatibility mode or imported as `legacy_unverified`; never action authority. |

For compound values, preserve origin at field/value granularity where a trusted envelope contains untrusted content. A tool name, agent identity, signature, or successful transport is not evidence that every returned string is trusted.

### Default promotion policy

- Explicit, current, safe user preferences may auto-activate with source, scope, and no action authority.
- Current user corrections may supersede prior preferences/claims after ambiguity and scope checks.
- Deterministically verified task outcomes may create task/workspace-scoped episodes.
- A project fact may auto-activate only when a non-model verifier confirms it and supplies an expiry/revalidation policy.
- External, repository, tool-output-derived, or model-inferred profile/preference claims remain quarantined unless explicitly confirmed by the relevant principal.
- Procedures remain trial candidates until they pass the procedural promotion gates below.
- Global, cross-project, team-shared, sensitive, policy-adjacent, and prospective/action-bearing records require explicit human review.
- No path auto-activates credentials, secrets, permission approvals, security-policy changes, financial instructions, destructive commands, publication approval, or an instruction to contact a third party.

## Write path: evidence → candidate → activation

Every producer—main model, extractor, session updater, compactor, background consolidator, importer, MCP surface, agent, swarm worker, and human UI—uses this ordered pipeline.

1. **Capture origin before the model.** Assign event ID, principal, channel, scope, source reference/digest, taint, sensitivity, and timestamps. If this cannot be done, the content cannot become durable active memory.
2. **Apply eligibility rules.** Reject derivable code/Git state, ephemeral progress, unsupported judgments about a user, raw bulk content, hidden reasoning, secrets, permission/action approvals, and content outside retention policy.
3. **Extract typed atomic candidates.** A model may emit only schema-validated proposals with exact evidence event IDs, kind, subject, applicability, uncertainty, scope request, and expiry/review proposal. It receives only the minimum evidence needed.
4. **Validate syntax and bounds.** Strict decoder, Unicode normalization, content/field/token limits, safe timestamps, valid IDs, allowed enum values, no unexpected fields, and idempotency key.
5. **Run sensitive-data/secret screening (DLP) and classification.** Cover `Write`, `Edit`, `MultiEdit`, imports, session summaries, agent memory, consolidation, projections, and adapter/index calls—not one tool path. Reject or redact before durable payload and before any remote sink.
6. **Authorize source, scope, purpose, and sink.** Never let the candidate choose a broader namespace than its evidence/publisher allows. Profile and preference ownership must match the relevant principal.
7. **Compare against the subject's complete active set.** Check contradiction/correction/supersession before any duplicate short-circuit. Retrieve counter-evidence and current versions under the same authorization policy.
8. **Resolve exact duplicates safely.** Equivalent content can add new evidence/observation metadata without rewriting origin. Repetition alone cannot raise authority, confidence, or scope.
9. **Verify dynamic and consequential claims.** Use a current deterministic tool/resource where possible. A separate model can critique, but model agreement is not verification. Record verifier version, inputs, result, and staleness window.
10. **Apply promotion policy.** Auto-activate, quarantine for review, reject, or request clarification with stable reason codes. Do not silently widen a candidate to make it pass.
11. **Commit atomically.** Event, item/version, evidence, influence edges, conflict/supersession, lifecycle changes, and policy verdict become visible in one transaction.
12. **Project and index asynchronously.** Human-readable Markdown and indexes derive from the committed version. Projection/index failure does not roll back truth or expose an unapproved candidate.
13. **Post-commit audit.** Re-read the committed representation through the normal policy path; verify digest, index visibility, scope isolation, and that withdrawn versions are absent. Emit an operator-visible failure if this does not hold.

### Replace current direct writers

- The main prompt may request `memory.propose`; it must no longer receive silent filesystem write permission for model-managed durable memory.
- `extractMemories` becomes a bounded candidate extractor, not a file editor. Remove the instruction forbidding verification from the activation path.
- Session-memory generation writes a typed working-state candidate and validated projection, not unchecked free-form canonical state.
- Compaction writes only a summary artifact linked to covered events; it cannot promote durable facts/procedures by itself.
- AutoDream becomes localized candidate maintenance/repair. It cannot directly delete or edit canonical items.
- Agent memory uses the same proposal API and policy; secure agent-specific filesystem logic remains for projections/snapshots.
- Human edits through `/memory` produce explicit import/version events. An authenticated TUI save may be attributed to the live user; an out-of-band filesystem modification is only local-file evidence.

## Read path: authorized retrieval → validated context

### Query planning

Classify the request without granting the classifier authority:

- current factual state;
- historical/as-of state;
- user preference/personalization;
- prior episode/outcome;
- reusable procedure/warning;
- active execution state;
- prospective intention;
- correction/forget/audit request.

Derive a minimal query plan from current task/subgoal, explicit entities, time operators (`latest`, `previous`, `as_of`, interval), tool/domain, and requested memory kinds. Query text is untrusted input and cannot alter policy filters.

### Retrieval stages

1. Resolve the caller's allowed namespaces, principals, purposes, recipients, and sinks.
2. Hard-filter lifecycle, validity, expiry, sensitivity, branch status, capability, and security domain **before content or vectors leave storage**.
3. Generate candidates through an exact subject/ID lookup, lexical/BM25 search, temporal lookup, active execution path, and optional adapter signals. Keep a deterministic lexical-only mode.
4. Expand only authorized conflict, evidence, temporal-successor, procedure-condition, and causal-dependency edges.
5. Rerank with separately logged components: query relevance, task/subgoal dependency, authority ceiling, freshness/validity, outcome utility/harm, condition match, conflict status, diversity, and token/cost budget.
6. Run a retrieval safety/validity screen independent of the generator. It can drop, quarantine, request live verification, or abstain; it cannot elevate authority.
7. Pack a bounded evidence bundle. Prefer atomic items and source snippets over large summaries; include counter-evidence and uncertainty when material.
8. Log candidates considered, hard filters, component scores, selection, packed tokens, sink, latency, cost, and abstention reason without leaking sensitive bodies.

Do not permanently suppress a version merely because it was surfaced once in a session. Deduplicate identical context, but allow a changed version, a materially different query, a conflict, or an explicit audit request to resurface it.

### Context compiler

Render memories in a data-only envelope with escaped boundaries and a stable schema. Each card should expose only policy-allowed fields such as:

- memory ID/version and kind;
- subject and applicable scope;
- observed/valid/review/expiry time;
- source class and citations (not secrets);
- confidence and explicit limitations;
- lifecycle/conflict state;
- content;
- required verification before use.

Keep live instructions, permissions, task objective, memory cards, and raw tool evidence in distinct prompt sections. Pin the original task and live constraints outside all lossy summaries. Prompt labels remain defense in depth; correctness must not depend on the model obeying them.

Do not place dynamic learned memory inside a cache-stable authoritative system-prefix segment. Prompt/provider cache keys must bind the principal/security domain, item version set, policy version, and deletion epoch; a correction or serving barrier invalidates affected cached context. Disable remote caching for sensitive memory when the provider contract cannot guarantee the required isolation/deletion semantics.

### Downstream use and action gate

- For personalization, check subject/scope and whether the memory is a preference rather than a factual claim. Valid personalization must not turn into factual sycophancy.
- For current/dynamic facts, verify against current repository/tool/API state before acting.
- For a procedure, verify applicability conditions and present task state; a successful prior trace is not a command.
- For any consequential tool argument influenced by untrusted or persisted memory, require independent current evidence or fresh action-bound human approval through the existing permission system.
- Record memory influence at the action/tool-call field level where practical, so harmful outcomes can be traced and the originating item demoted/withdrawn.
- If memory is unavailable, ambiguous, conflicting, stale, or policy-denied, continue with no-memory behavior or ask a targeted question. Never invent a remembered answer.

## Lifecycle, correction, forgetting, and deletion

### Localized maintenance

Run maintenance per affected subject/neighborhood instead of periodically rewriting the entire bank:

- expiry and review scheduling;
- evidence/conflict refresh after a source change;
- low-utility or harmful-item review;
- trial procedure promotion/demotion;
- projection/index repair;
- candidate consolidation with complete influence edges;
- storage quotas and retention;
- dead job/lease recovery.

Background models can propose merges or abstractions, but the original atomic versions remain available until retention/deletion policy removes them. A merge inherits the union of source restrictions and the minimum authority ceiling.

### Correction/invalidation algorithm

1. Resolve the exact subject/item/version and caller authorization. Clarify ambiguous forget/correct requests before destructive scope expansion.
2. Append the correction/retraction event and compute the transitive closure over **causal influence edges**, not semantic similarity.
3. In one transaction, place a serving barrier on the root and all known descendants, update active heads/conflict groups, and enqueue repair/deletion jobs.
4. Invalidate every derived lexical/vector/summary/cache/projection artifact by source version.
5. Recompute affected children only from still-valid evidence; validate repaired content as a new immutable version.
6. Run a post-barrier canary that exercises search, direct ID, export, lineage, cache, context injection, background job, and adapter paths.
7. Emit an explainable receipt: logically withdrawn IDs, repaired versions, physically deleted managed tiers, pending propagated copies, and limitations.

If influence provenance is incomplete, default to broader quarantine of the affected neighborhood. Do not serve first and “repair soon.”

### Deletion guarantee levels

| Level | Meaning | Required behavior |
| --- | --- | --- |
| Logical withdrawal | Content cannot be served or used by any AgenC path | Immediate transactional barrier and tombstone |
| Managed-store deletion | Payload removed from canonical live records and AgenC-controlled derived stores | Async bounded job with retry, verification, and receipt |
| Propagated deletion | Known team/adapter/provider copies requested and acknowledged | Track each copy/acknowledgement; deny future serving while pending |
| Cryptographic erasure | Encrypted payload's unique data key is destroyed | Claim only if envelope encryption/key lifecycle is actually implemented and tested |
| Unmanaged backup limitation | User/system backup or third-party copy is outside AgenC control | State explicitly; prevent live restoration from silently resurrecting tombstoned IDs |

Backups/restores must carry tombstones and deletion epochs. A restore dry-run must prove that deleted items remain non-servable. Physical deletion tests include raw/version tables, event payloads where policy allows removal, Markdown, summaries, lexical rows, vectors, semantic edges, caches, snapshots, logs/traces, exported artifacts, and known replicas.

“Immutable” applies to the content-free event/candidate/version envelope and provenance history, not to user-derived payload bytes. Managed deletion may remove `memory_payloads` while retaining a minimized envelope and causal edges so descendants stay barred. Before schema implementation, enumerate every retained field and test that erased strings cannot survive in subjects, paths, tags, reason text, digests, FTS shadow tables, WAL/backups, audit metadata, or adapter logs. If a field is needed only for anti-resurrection, justify the keyed token and its deletion/rotation behavior explicitly.

Expose “forget this memory” separately from “delete its source data.” Forgetting always withdraws the item and descendants from agent use. Source-data deletion may additionally target transcript/tool/event payloads under their own retention and audit policy. The receipt must say which operation occurred; a surviving source record must not be silently re-extracted past the tombstone.

## Execution-state memory and compaction

Execution state solves a different problem from semantic retrieval. Implement MAGE-like semantics without treating its reported numbers as guarantees.

This is an extension of the live durability/recovery system, not a replacement. Keep the existing admitted-tool-call journal and `run_effects` as the sole authority for effect intent, outcome, unknown-outcome review, idempotency, and restart recovery. Execution nodes/heads may project or link those records; they must never independently decide that an effect completed, failed, or was compensated. Reuse the existing rollout reconstruction and startup recovery order, and prove one deterministic reconstruction result from the same durable journal.

### Operations

- **Grow:** append observable user/tool/agent events and a child execution node after a meaningful action or state transition.
- **Compress:** summarize a completed subgoal into bounded structured state while preserving the exact source-event range, objective, result, unresolved items, and effect references.
- **Maintain:** validate the summary against source events and objective verifiers; mark fields verified/unverified/conflicting rather than polishing uncertainty away.
- **Revise:** select a validated checkpoint, mark the flawed branch failed/abandoned, create a new branch generation, and atomically move the active head. Keep the failed branch for audit/hints but exclude it from current state.

### Context construction

Compile, in order:

1. original task and live policy/permission constraints;
2. current active root-to-head subgoal summaries;
3. verified current state and unresolved questions;
4. exact recent assistant/tool-call/result tail, never splitting a call from its result;
5. explicitly labeled hints from prior failed branches only when relevant;
6. selected durable memory cards.

The raw transcript/event source remains available for audit and repair. A summary is a derived index, never the sole evidence if the raw source is still inside retention.

### Required behavior

- Checkpoint before/after externally visible or non-idempotent effects.
- Link the canonical durable effect identity and record only separate compensation intent/result through the same admitted-effect boundary; `Revise` cannot pretend an email, payment, push, deletion, or remote mutation was undone.
- Use CAS/version checks for concurrent parent/worker updates; detect and resolve conflicts instead of last-writer-wins.
- Persist enough head/cursor state for daemon restart. Do not rely on in-process lane maps alone.
- Escape transcript delimiters and frame all old transcript/tool content as untrusted data for the summarizer.
- Validate schema and source coverage after compaction; on failure retain the old context path or use a safe exact-tail fallback.
- Keep compaction behind a feature flag until it beats normal compaction on task outcomes and poisoning cases.
- Remove or wire the current unused session-memory compaction path; do not continue paying for a producer with no production consumer.

## Procedural memory

Procedures have the highest error-amplification potential after permissions and therefore use a stricter lifecycle:

1. Extract separate success, failure, and comparative lessons from objectively scored episodes.
2. Preserve fine-grained steps and a higher-level script, each with source episodes and applicability conditions.
3. Start as `trial`, scoped to repository/tool/schema/model/provider/environment versions observed.
4. Test on held-out analogous tasks and negative/applicability cases; include stale API, changed CLI, different branch, and permission variants.
5. Require either multiple independent objective successes or explicit human promotion. One apparently successful trace never becomes a global skill.
6. Canary against a small task cohort; compare no-procedure and current behavior.
7. Track downstream utility, regret, failure, and condition mismatch. Demote/quarantine automatically on a validated harmful outcome, but require review to generalize further.
8. Correct/deprecate through immutable versions and cascade invalidation.

A procedure is advisory data. It cannot embed credentials, auto-run commands, widen allowed tools/roots/network, suppress approvals, or override current docs/code/tool help. Prefer fresh authoritative tool/schema discovery when available.

Procedural memory is not an AgenC skill, plugin, agent definition, or executable policy. Promotion into any of those surfaces requires their separate explicit human-reviewed creation/update workflow, security review, and tests; the memory service cannot write them automatically.

Learned controllers (AgeMem/Memory-R1/UMEM/SelfMem-style) are a later experiment. They may propose `ADD`, `UPDATE`, `DELETE`, `NOOP`, `RETRIEVE`, `SUMMARY`, or `FILTER`, but deterministic policy owns what those operations mean and whether they commit.

## Prospective memory

If AgenC supports “do X later/when Y happens,” implement it as a deterministic intention service—not free text that a model periodically rereads.

Each intention needs:

- explicit live-user source and exact requested action;
- trigger kind (time, event, state predicate), timezone, due window, and watcher;
- task/workspace/recipient/sink scope;
- dependencies and required current evidence;
- idempotency key and one-shot/repeating semantics;
- state (`pending`, `due`, `blocked`, `completed`, `cancelled`, `superseded`, `expired`);
- cancellation/supersession chain and completion evidence;
- execution-time permission and confirmation policy.

Use the smallest deterministic watcher/scheduler that can observe the cue. The PM-Bench result that brute-force fixed heartbeats and multi-agent querying create false positives or regressions is a test requirement, not a reason to add more polling. A model may help interpret an ambiguous due state, but cannot silently fire a consequential action.

## Multi-agent and swarm memory

- Give every worker a private execution/scratch namespace by default.
- Treat worker claims and summaries as untrusted evidence until the parent or an objective verifier validates them.
- Do not use a writable global swarm scratchpad.
- Share current task state through explicit, minimal, capability-scoped messages or task-state records; preserve the originating agent path, source event IDs, and taint.
- Require a typed publication envelope: source namespace/version, intended destination, purpose, expiry, evidence, sensitivity, and requested kind. The destination policy independently admits or rejects it.
- A child cannot publish to user-global, project-wide, team, or another agent's private memory merely because its parent can read that scope.
- Sparse/hierarchical sharing is the default. Test hub compromise, transitive leakage, Sybil corroboration, confused deputy, direct-ID bypass, and topology-dependent leakage.
- Apply privacy controls to mailboxes, delegation prompts, status messages, tool arguments/results, logs, traces, artifacts, and snapshots—not only final answers and memory tables.
- Use concurrency control on shared task state; retain conflicting worker evidence rather than merging it into a confident consensus.
- Reconcile the memory mode (`enabled`/`disabled`/`polluted` or its replacement) with the current swarm branch before implementation. One canonical policy must define recall, proposal, activation, consolidation, publication, and repair for each mode.

## Open-source library decision

No audited project supplies the full AgenC requirement: provider-neutral TypeScript integration, local-first operation, origin-bound authority, all-path authorization, execution-state branches, poisoning-resistant admission, cascade invalidation, verified deletion, swarm isolation, and coding-agent outcome gates.

The following is an audit snapshot, not a permanent license/maturity assertion. Recheck default branch, releases, license, advisories, transitive dependencies, and benchmark reproducibility before any adoption.

| Project | Useful ideas/surface | Why it is not the trusted core |
| --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0) | Mature Apache-2.0 Python/TypeScript ecosystem; extraction, dedup, search, CRUD, adapters | GateMem/GhostWriter-style evidence shows retrieval products do not supply governance, poisoning resistance, cascade repair, or verified deletion. |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 temporal fact graph, validity intervals, episode provenance, hybrid search | Python/graph-service footprint; AgenC would still own principal policy, origin authority, causal derivation, action gating, and deletion. |
| [ReMe](https://github.com/agentscope-ai/ReMe) | Apache-2.0 inspectable local memory and strong procedural distillation patterns | Python and model-driven consolidation; no demonstrated non-malleable authority or all-path governance. Best reference toolkit, not control plane. |
| [Hindsight](https://github.com/vectorize-io/hindsight) | MIT temporal/keyword/vector/graph retrieval and fact/belief separation | Server/Postgres-oriented and primarily conversational/system-demo evidence; AgenC still needs execution state and governance. |
| [LightMem](https://github.com/zjunlp/LightMem) | MIT lightweight tiering and structured/consolidated recall work | Research-oriented Python implementation; QA gains do not establish action safety. |
| [Memora](https://github.com/microsoft/Memora) | MIT abstraction plus multiple cues | Research prototype with minimal release history at audit time; reuse representation ideas only. |
| [Letta](https://github.com/letta-ai/letta) | Apache-2.0 stateful-agent platform and memory blocks | Overlaps AgenC's whole runtime rather than a small component and is not independent proof of the required governance properties. |
| [LangMem](https://github.com/langchain-ai/langmem) | MIT hot-path/background extraction primitives | Python/LangGraph coupling; autonomous writes need the separate control plane anyway. |
| [MIRIX](https://github.com/Mirix-AI/MIRIX) | Apache-2.0 multi-part memory taxonomy and consolidation ideas | Early service with heavier PostgreSQL/Docker footprint and no independent governance evidence. |
| [MemOS](https://github.com/MemTensor/MemOS) | Apache-2.0 broad scopes, traces, policies, skills, and multi-agent concepts | Heavy Python/graph/vector stack; current performance evidence is project-authored and scopes do not prove all-path enforcement or deletion. |
| [MemClaw](https://github.com/caura-ai/caura-memclaw) | Apache-2.0 governance-oriented schema: scopes, trust tiers, audit, contradiction, lifecycle, provenance | Sidecar/Postgres footprint and project-authored evidence; treat it as a schema reference or optional adapter until the required AgenC contracts and benchmarks are reproduced. |
| [MatrixOrigin Memoria](https://github.com/matrixorigin/Memoria) | Apache-2.0 snapshots, branch/merge/rollback, contradiction quarantine, hybrid search | Emerging and coupled to MatrixOne; versioning does not supply origin/action authority. |
| [OWASP Agent Memory Guard](https://github.com/OWASP/www-project-agent-memory-guard) | Open attack fixtures and admission/filtering ideas | Early Python project; use fixtures and design review, not its self-reported score as a guarantee. |

### Adapter boundary

Allow adapters only behind narrow interfaces such as:

- `LexicalIndexAdapter`
- `EmbeddingIndexAdapter`
- `SemanticRelationAdapter`
- `MemoryProjectionAdapter`

Adapters receive already authorized, minimized records for one security domain and return IDs/scores, never policy verdicts. Core rechecks every returned ID. Core owns canonical versions, evidence/influence edges, lifecycle, deletion epochs, audit, and action gates.

An adapter can be considered only after:

- [ ] license and supply-chain review;
- [ ] cross-platform packaging/build/release impact analysis;
- [ ] offline/local and provider-failure behavior;
- [ ] namespace prefilter and direct-ID contract tests;
- [ ] complete export/rebuild/delete behavior;
- [ ] poisoning and scope-bypass tests;
- [ ] measurable utility/cost/latency gain over native lexical retrieval;
- [ ] rollback to the native adapter without data loss.

## Phased implementation plan

Each phase must be independently mergeable, observable, and reversible. Keep at most one behavioral variable changing in a benchmark comparison. Land tests with the smallest implementation that makes them pass.

### Phase 0 — Freeze evidence, threat model, and current baselines

**Objective:** know exactly what “better” and “safe” mean before changing production behavior.

- [ ] Record the current `main` commit, Node/npm versions, supported platforms, memory settings, build features, provider/model versions, and source revisions.
- [ ] Turn the current code audit into a checked-in design/current-state document or ADR with exact file/symbol references and owners.
- [ ] Build one canonical path matrix covering global, local root, nested cwd, worktree, long path, Bun/Node hashing, remote root, trusted override, disabled/simple mode, team, session, and per-agent stores.
- [ ] Map the physical state/log database topology and ownership: current per-project paths, global and team gaps, daemon concurrency, locks/WAL, backups/restores, migrations, and every caller that assumes one project database.
- [ ] Map the existing durable run/turn/effect/checkpoint pipeline end to end—from admitted tool call and event fsync through `run_effects`, rollout projection/reconstruction, unknown-outcome review, and startup recovery—before designing execution nodes.
- [ ] Add failing end-to-end tests proving the current extraction/read path split and the lack of production session-memory compaction wiring.
- [ ] Add a threat model covering assets, principals, trust boundaries, sources, sinks, data retention, providers, agents/swarms, adapters, backups, and external effects.
- [ ] Enumerate all write channels: explicit memory tool/file writes, inferred extraction, compaction/session summaries, experience-to-procedure, import/sync, AutoDream, agent memory, filesystem edits, SDK/daemon calls, and future adapters.
- [ ] Enumerate every read/export channel, including direct ID, enumeration, MCP, TUI, snapshots, logs, traces, cache, projection, background jobs, and provider prompts.
- [ ] Create `runtime/evals/memory/` (or an ADR-approved equivalent) with deterministic manifests, isolated `AGENC_HOME`, fixture reset, model/provider recording, and machine-readable results.
- [ ] Implement baseline modes: memory off, current AgenC, full eligible context, deterministic lexical retrieval, and oracle context.
- [ ] Run current baseline utility, cost, latency, write-quality, poisoning, cross-scope, stale/conflict, and forgetting cases across at least two materially different supported providers/models.
- [ ] Define and preregister functional non-inferiority margins, rollout budgets, sample sizes, confidence-interval method, and stop conditions from observed variance. Do not invent them in advance.
- [ ] Freeze the reviewed baseline/gate contract in a versioned JSON file and include raw run manifests/results.
- [ ] Complete dataset/code license review before committing external fixtures.

**Exit gate:** another developer can reproduce the current baselines from a clean checkout; all known channels map to a threat/control/test; the current defects have revert-sensitive tests.

**Rollback:** evaluation-only code must not alter production behavior. If it does, split it before merge.

### Phase 1 — Stabilize current behavior before making memory smarter

**Objective:** remove false-success, unsafe-default, filesystem, and documentation contradictions without activating a new memory design.

- [ ] Introduce one canonical resolver used by prompt loading, relevant recall, extraction, session paths, MCP surfaces, `/memory`, settings help, worktrees, remote mounts, and overrides.
- [ ] Remove/delegate [`runtime/src/services/extractMemories/memory-paths.ts`](runtime/src/services/extractMemories/memory-paths.ts); use one project-key/hash implementation everywhere.
- [ ] Add the complete path matrix as a contract test and verify canonical containment for both reads and writes.
- [ ] Do **not** simply redirect today's inferred extractor into the live store. Disable its direct durable-write mode by default until Phase 3 provides candidate admission; retain an explicit, documented compatibility flag only if migration evidence requires it.
- [ ] Make model-managed legacy durable stores read-only by default until Phase 3. Keep authenticated operator editing through `/memory`; if a temporary legacy model-write compatibility flag is unavoidable, label it unsafe, off by default, and covered by the same path/DLP limits.
- [ ] Keep AutoDream off and fail its startup/doctor check if prompt-required capabilities do not match child policy.
- [ ] Stop producing session-memory summaries by default when no production consumer is wired, or explicitly label them experimental; remove wasted background calls without deleting user files.
- [ ] Disable team-sync claims and implicit shared-memory enablement until a real transport and identity/access contract exist. Update combined prompts and `/memory` consistently.
- [ ] Bound per-agent memory prompt bytes/tokens, add the canonical untrusted/stale wrapper, and make loaders use the canonical auto-memory gate.
- [ ] Replace the mislabeled entrypoint “byte” accounting with explicitly UTF-8-safe truncation (or rename it honestly if a deliberate code-unit limit is retained); add multibyte, surrogate-pair, long-line, newline, and exact-boundary tests without increasing the effective prompt budget accidentally.
- [ ] Port the strongest existing no-follow/canonical/inode/hard-link/root-swap checks to global/project memory entrypoints, topic scans, recall reads, projections, and writes.
- [ ] Use explicit restrictive directory/file creation modes where supported; document Windows guarantees and limitations.
- [ ] Apply secret/DLP admission consistently to `Write`, `Edit`, `MultiEdit`, import, extraction, session, agent, global, project, and team paths.
- [ ] Remove the disabled duplicate recall implementation in [`runtime/src/utils/attachments.ts`](runtime/src/utils/attachments.ts) or fold any intentionally retained behavior into one canonical retriever.
- [ ] Align `enabled`/`disabled`/`polluted` thread types, persistence, hydration, and every current reader/writer, or remove the incomplete state until Phase 2.
- [ ] Correct settings comments and [`docs/reference/memory.md`](docs/reference/memory.md) for trusted setting precedence, physical session-memory paths, team behavior, extraction status, and path resolution.
- [ ] Add `agenc doctor`/debug evidence for effective memory mode, canonical paths, writer/reader agreement, unsafe legacy mode, and background feature status without exposing content/secrets.

**Exit gate:** no producer can report a successful save to a path that the corresponding consumer cannot resolve; unsafe inferred direct writes and misleading sync claims are not on by default; filesystem/secret matrices pass.

**Rollback:** retain existing files untouched; feature switches can restore legacy reads/manual editing. Never re-enable inferred direct writes automatically as a rollback.

### Phase 2 — Land contracts, policy skeleton, ledger, and feature modes

**Objective:** create the native control plane with no new memory injected into production prompts.

- [ ] Approve ADRs for authority/origin semantics, namespace identity, **physical SQLite storage topology**, canonical SQLite versus Markdown projection, retention/deletion levels, sensitive sinks, at-rest encryption posture, team sharing, and telemetry privacy. The topology ADR is a hard prerequisite to the migration and must assign `user_global`, project/workspace, agent-private, and future team namespaces to canonical owners.
- [ ] Define strict TypeScript contracts for policy context, events, candidates, items, versions, evidence/influence edges, retrieval, outcomes, execution state, jobs, projections, and adapters.
- [ ] Add runtime schema decoders and property/fuzz tests for every untrusted JSON/protocol boundary.
- [ ] Finalize erasable-payload versus immutable-envelope fields, nullable reference/FK behavior, deletion cascades, anti-resurrection tokens, and influence-edge retention; then create the next forward-only SQLite migration in each ADR-selected database for namespace/event/payload/candidate/item/version/evidence/influence/policy/job tables and indexes.
- [ ] Reuse lease/watermark/idempotency mechanics from [`runtime/src/memory/store.ts`](runtime/src/memory/store.ts) where they fit; do not maintain two competing job systems.
- [ ] Implement a repository/service boundary that is the only code allowed to query or mutate canonical memory.
- [ ] Implement the deny-by-default policy service and contract-test every operation, direct-ID path, background actor, and adapter boundary.
- [ ] Implement origin capture and value-level taint propagation without an LLM dependency.
- [ ] Add lifecycle and serving-barrier predicates; make non-active content impossible to return through the repository API.
- [ ] Add the minimal tombstone/deletion-epoch guard and require every future legacy/projection adapter to consult it before read, enumeration, export, or injection; after this lands, a non-compliant legacy reader is not a rollback option.
- [ ] Implement append-only policy/audit events with stable reason codes and content-minimized logging.
- [ ] Add operational modes with exact semantics: `off`, `legacy_read_only`, `shadow`, and `enforced` (names may change by ADR). Avoid a vague boolean.
- [ ] Model pollution/quarantine as an orthogonal health state with an incident reason and repair workflow. In a polluted namespace/session, fail closed to no legacy recall, activation, maintenance, or publication; allow only explicitly policy-approved validated records if the threat model proves that path safe.
- [ ] Map existing `autoMemoryEnabled`, environment gates, simple/remote behavior, and session memory mode into the new service without silently changing user choice.
- [ ] Add global and per-source/provider kill switches that always fail to memory-off or guard-aware legacy-read-only behavior.
- [ ] Implement backup/migration preflight and schema downgrade refusal with a clear recovery message.

**Exit gate:** schema round-trip, crash/retry, policy, taint, namespace, direct-ID, and lifecycle contract tests pass; production still injects only legacy memory because the new reader is shadow-only.

**Rollback:** before any lifecycle/tombstone operation, turn off the new service and leave additive tables inert. After the guard is active, use only a guard-aware legacy adapter or memory-off; raw legacy reading is no longer a safe rollback. No legacy file has been rewritten.

### Phase 3 — Replace direct durable writes with governed candidates

**Objective:** restore useful automatic learning without allowing a model to commit trusted state.

- [ ] Replace extraction's filesystem editor child with a typed candidate extractor.
- [ ] Capture source event IDs and origin metadata before calling the extractor; never ask the extractor to reconstruct its own provenance.
- [ ] Minimize the evidence window and ensure transcript/system-shaped history is framed as untrusted input.
- [ ] Implement atomic claim decomposition, schema validation, bounds, eligibility rules, DLP, sensitivity, source/scope/sink policy, contradiction-before-dedup, and verifier routing.
- [ ] Add deterministic validators for explicit current-user preference, current file/repo observation, tool exit/test result, dates, paths, and exact duplicate/no-op behavior.
- [ ] Implement quarantine/review for inferred profile/preference, global/team, procedure, sensitive, ambiguous, policy-adjacent, and unverified external claims.
- [ ] Make “remember” create a candidate through the same service; make “forget/correct” invoke deterministic lifecycle operations rather than ask a model to edit files.
- [ ] Route main-agent, extraction, session, AutoDream, agent, swarm, import, TUI, and future SDK writes through the proposal API.
- [ ] Implement immutable versions, evidence/influence edges, conflict groups, supersession, expiry/review, and idempotent transaction commit.
- [ ] Generate Markdown only from committed versions. Include stable item/version identifiers or safe sidecar metadata so edits/imports can be reconciled.
- [ ] Import out-of-band Markdown edits as new `local_file` candidates; do not silently attribute them to a live user.
- [ ] Add post-commit re-read/scope/index checks and operator-visible background failure status.
- [ ] Run shadow extraction alongside legacy behavior without injecting new records; compare write precision, scope, contradiction, and sensitive-data outcomes.
- [ ] Delete/disable all remaining model-to-canonical-file shortcuts before switching to enforced writes.

**Exit gate:** adversarial write suite shows no unauthorized active write, secret persistence, scope promotion, provenance loss, or direct model commit in known fixtures; benign explicit preferences/corrections meet the frozen utility gate.

**Rollback:** switch to tombstone-aware `legacy_read_only` only if that adapter applies the same namespace/barrier/deletion guard before every access; otherwise switch to memory-off. Export active new records to reviewed Markdown if needed. Never roll back to automatic unvalidated direct writes.

### Phase 4 — Ship policy-first retrieval and context compilation

**Objective:** retrieve only allowed, valid, useful evidence and prove when it helps downstream behavior.

- [ ] Implement deterministic lexical retrieval over active atomic versions, using a feature-probed SQLite FTS path or the existing TypeScript BM25 scorer.
- [ ] Enforce namespace/purpose/sink/lifecycle/validity filters before candidate content reaches search/rerank/provider code.
- [ ] Route model/tool requests to read full memory files through the same `canReadContent` service and byte/token policy; projection paths must not provide an ungoverned bypass around bounded recall.
- [ ] Implement exact subject/ID, temporal/as-of, active execution path, conflict/counter-evidence, and condition-aware retrieval.
- [ ] Log component scores separately; do not hide a universal heuristic in one opaque score.
- [ ] Add an optional model reranker/validator through provider-neutral interfaces with deterministic fallback and explicit abstention.
- [ ] Remove hard-coded side-model selection from [`runtime/src/memory/find-relevant.ts`](runtime/src/memory/find-relevant.ts).
- [ ] Implement the escaped, typed, bounded context compiler with citations, source class, validity, conflict, uncertainty, and verification requirements.
- [ ] Preserve current per-file/turn/session budgets as conservative starting caps; retune only from eval evidence.
- [ ] Add “no memory,” stale/conflict, updated-version, changed-query, and memory-disabled behavior tests.
- [ ] Implement `memory explain <id|last-recall>` showing policy, score components, source lineage, age, conflict, packed tokens, and reason for use/abstention.
- [ ] Add live verification/action-use hooks at the existing permission/tool boundary. Memory alone must fail `canUseForAction` for consequential mutations.
- [ ] Run the new retriever in shadow against current AgenC; compare selected content and downstream results without double-injecting.
- [ ] Switch an opt-in cohort only after the functional and poisoning gates pass; retain per-session/provider kill switches.

**Exit gate:** new recall beats or meets preregistered baselines on task outcome with bounded cost, while passing scope, sycophancy, conflict, stale-state, poison activation, and action-authority gates.

**Rollback:** select the policy- and tombstone-aware bounded compatibility retriever, or memory-off if it cannot enforce the guard. Never select the raw current reader after lifecycle records exist. The canonical ledger remains readable and exportable.

### Phase 5 — Complete correction, repair, retention, and verifiable deletion

**Objective:** make bad or unwanted memory immediately non-servable and demonstrably removable from managed tiers.

- [ ] Implement correction/retraction/forget APIs with ambiguity checks, authorization, reason codes, and receipts.
- [ ] Implement causal influence closure and barrier-first transactional withdrawal.
- [ ] Track/rebuild/delete lexical, vector, semantic-edge, summary, cache, Markdown, snapshot, log/trace, and propagated artifacts by source version.
- [ ] Add asynchronous validated repair that cannot clear the barrier until the replacement version passes admission.
- [ ] Implement expiry, review, retention quotas, tombstones, deletion epochs, and anti-resurrection import/restore checks.
- [ ] Erase candidate/version/event payload rows without erasing the minimum lineage needed to keep descendants barred; test nullable payload/FK behavior, content-bearing metadata, WAL/checkpoint/VACUUM, backup, and keyed anti-resurrection-token rotation/deletion.
- [ ] Document exactly which event/audit metadata remains after payload deletion and why.
- [ ] Decide and implement the at-rest encryption/key-management ADR before claiming encryption or cryptographic erasure. Until then, prohibit secrets and state the filesystem-level protection honestly.
- [ ] Add restore dry-run, deletion canary, membership/extraction attack, cache/index residue, backup, and propagated-copy tests.
- [ ] Implement user-facing status for logical withdrawal versus managed deletion versus external/unmanaged limitations.

**Exit gate:** known descendants become invisible atomically; post-deletion adversarial retrieval cannot recover fixtures from any managed tier; receipts and limitations match reality.

**Rollback:** repair jobs and physical deletion can be paused, but logical serving barriers must remain enforced. A rollback may never resurrect withdrawn content.

### Phase 6 — Replace free-form session memory with execution-state management

**Objective:** improve long-horizon coding reliability through active-state integrity rather than semantic similarity alone.

- [ ] Approve an execution/durability ADR that maps nodes, heads, checkpoints, compaction source ranges, and compensation to the existing run/turn/effect journal and reconstruction/startup recovery pipeline; designate one source of truth for each field.
- [ ] Land execution node/head tables and, only if necessary, content-free links to canonical `run_effects`; do not add a second effect/checkpoint outcome store.
- [ ] Implement Grow/Compress/Maintain/Revise with source ranges, validation state, active-head CAS, and failed-branch isolation.
- [ ] Preserve original goal/live constraints, validated completed-subgoal summaries, exact recent assistant/tool pairs, unresolved questions, and effects.
- [ ] Reuse the admitted-tool-call/durable-turn boundary for checkpoints around non-idempotent/external effects; journal any compensation as a new canonical effect rather than editing the prior effect outcome.
- [ ] Persist update cursors/head generations across daemon restart; drain or recover background jobs deterministically.
- [ ] Frame and escape compaction inputs as untrusted; validate output schema/source coverage before head movement.
- [ ] Wire the execution-state compiler into normal compaction behind a feature mode; remove or migrate the current unwired session-memory path.
- [ ] Import existing `summary.md` only as unverified legacy working state; never promote it to durable memory automatically.
- [ ] Add branch contamination, failed attempt, rollback, concurrent worker, crash-mid-commit, changed worktree, side-effect, unknown-outcome review, startup reconstruction, compensation, and fallback tests; assert that execution projection and existing run durability never disagree.
- [ ] Benchmark current compaction, exact-tail, full context, ACON-style, folding-style, and execution-state variants on real coding outcomes.

**Exit gate:** execution-state mode meets the task-success/non-inferiority contract, reduces context within its budget, reconstructs active state, excludes failed-branch contamination, and preserves effects across restart.

**Rollback:** move context construction back to current compaction/exact-tail; leave execution records inert and auditable.

### Phase 7 — Add outcome-grounded episodic and procedural learning

**Objective:** learn reusable workflows without turning one model trace into a permanent bad habit.

- [ ] Capture objective outcomes and memory influence from tests, command exits, task acceptance/rejection, human correction, and other deterministic verifiers.
- [ ] Implement episode records for success, partial success, and failure with conditions and exact evidence.
- [ ] Implement procedure/warning extraction as quarantined, versioned proposals with fine steps, high-level script, negative evidence, and applicability constraints.
- [ ] Build candidate → trial → held-out test → human/multi-success promotion → canary → active/deprecated lifecycle.
- [ ] Add repository/tool/schema/provider/model/runtime version conditions and live applicability checks.
- [ ] Track utility, regret, harmful reuse, and mismatch; demote/quarantine validated harmful procedures and enqueue causal repair.
- [ ] Test task-distribution shift, stale tools/APIs, near-neighbor traps, success-only bias, failure-only over-caution, and cross-project leakage.
- [ ] Compare ReMe/Memp-inspired multi-faceted procedures with simpler warning/recipe baselines.

**Exit gate:** procedures improve held-out AgenC task success with no safety regression, remain scoped, and can be traced/withdrawn end to end.

**Rollback:** disable procedural retrieval/promotion; episodic evidence remains as non-instructional audit data.

### Phase 8 — Enforce multi-agent/swarm isolation and publication

**Objective:** allow useful collaboration without a shared poisoned memory pool.

- [ ] Re-audit the merged swarm architecture and resolve overlapping uncommitted work before editing its surfaces.
- [ ] Define private agent/task namespaces, parent read capabilities, team/shared destinations, expiry, and revocation.
- [ ] Route delegation, mailbox, background-agent, task-bridge, snapshot, and status channels through origin/taint/privacy metadata where memory influence crosses boundaries.
- [ ] Apply AgentSys-style hierarchy isolation where practical: keep raw untrusted tool/subtask traces in the worker and return the minimum typed result. Validate both schema and semantics/policy; malicious values can be perfectly schema-valid.
- [ ] Implement explicit typed publish/propose; destination admission cannot be bypassed by parent authority or direct ID. If source and destination have different physical owners, use the ADR-defined durable outbox/inbox protocol and never mutate scope in place.
- [ ] Make all worker outputs untrusted evidence and require objective/parent validation before active shared/durable state.
- [ ] Implement shared-head concurrency/CAS and conflict retention.
- [ ] Remove false team-sync prompt claims until real transport, authentication, authorization, replay protection, deletion propagation, and offline reconciliation exist.
- [ ] Red-team compromised worker, hub agent, Sybil corroboration, cross-task secret, direct-ID bypass, confused deputy, malicious artifact, concurrent contradiction, snapshot restore, and topology leakage.
- [ ] Add AgentLeak-style internal-channel audits over messages, tools, memory, logs, traces, and files.

**Exit gate:** zero known unauthorized cross-scope disclosure or publication in the reviewed fixture matrix; collaboration utility meets the swarm baseline; every shared item explains its origin and grant.

**Rollback:** disable shared publication/retrieval while retaining private execution state and normal messaging.

### Phase 9 — Add prospective intentions only if product scope requires them

**Objective:** implement reliable future intentions without autonomous reminder noise or permission persistence.

- [ ] Approve a product/authority ADR defining which intention types AgenC supports and which remain out of scope.
- [ ] Implement the deterministic state machine, trigger store, scheduler/watchers, cancellation/supersession, idempotency, expiry, and completion evidence.
- [ ] Accept only explicit live-user intentions; no inference from external content, worker output, or assistant suggestion.
- [ ] Require fresh execution-time policy/permission and target verification.
- [ ] Add hidden-channel/event, cross-day/restart, update, cancellation, lure/non-trigger, duplicate-fire, timezone, clock-change, and unavailable-watcher tests.
- [ ] Evaluate no reminder, TODO ledger, selective heartbeat, fixed heartbeat, and multi-agent strategies using PM-Bench plus AgenC-native cases.

**Exit gate:** preregistered prospective Set-F1/false-positive/duplicate-action gates pass and no consequential action fires from stored authority alone.

**Rollback:** stop watchers and retain pending intentions as inspectable inert records; do not drop or execute them silently.

### Phase 10 — Experiment with optional adapters and learned controllers

**Objective:** capture additional value only where it is reproducible and cannot weaken core invariants.

- [ ] Benchmark native lexical retrieval before adding an embedding or graph dependency.
- [ ] Implement one adapter at a time with security-domain partitioning, core ID recheck, derived-artifact lineage, delete/rebuild, timeout, and no-network fallback.
- [ ] Evaluate local versus remote embeddings for privacy, cost, latency, packaging, and model drift.
- [ ] Run a time-boxed Mem0/Graphiti/ReMe/MemClaw-reference spike through the same adapter/eval contract; do not fork core policy into an adapter.
- [ ] Recheck licenses, releases, security advisories, transitive dependencies, platform artifacts, and maintainer health at spike time.
- [ ] If learned write/read/maintenance policies are tested, constrain their action space to proposals and shadow decisions; deterministic policy remains final.
- [ ] Train/optimize only against downstream task, safety, and cost objectives with held-out providers/tasks and adversarial cases.
- [ ] Require a clear gain over the simplest native baseline and preserve a one-switch fallback.

**Exit gate:** an adapter/controller lands only with a reviewed benchmark report, threat assessment, SBOM/license impact, cross-platform packaging proof, deletion proof, and rollback test.

**Rollback:** delete/rebuild derived adapter artifacts and select native deterministic behavior; canonical memory is unchanged.

### Phase 11 — Complete operator UX, daemon/SDK surfaces, observability, and docs

**Objective:** make memory inspectable, correctable, supportable, and honest.

- [ ] Extend `/memory` with list/filter, candidate review, approve/reject, show, history/diff, provenance, conflicts, why-recalled, correct, forget, deletion status, repair/reindex, import/export, and health.
- [ ] Require confirmations for ambiguous/broad forget/export/share operations and show exact scope/affected descendants before execution.
- [ ] Add headless CLI equivalents suitable for automation, with structured JSON and stable exit/reason codes.
- [ ] Add daemon protocol methods and generated types without leaking runtime internals; make SDK changes additive/versioned.
- [ ] Authorize every daemon/SDK operation through the same policy context as the TUI.
- [ ] Add metrics for writes proposed/activated/quarantined/rejected, retrieval abstention/precision proxy, conflict/stale use, utility/harm, invalidated exposure, deletion lag/residue, jobs, storage, tokens, latency, and provider cost.
- [ ] Keep telemetry content-free by default; hash/minimize identifiers, redact secrets, and document retention/export.
- [ ] Add operator alerts for writer/reader path disagreement, projection/index drift, stuck deletion/repair, policy bypass attempt, repeated poison candidate, storage quota, and adapter outage.
- [ ] Update architecture, memory reference, agents/swarms, permissions, privacy, settings, CLI, SDK, migration, troubleshooting, and threat-model docs.
- [ ] Document what memory does **not** guarantee, how to disable it, how to inspect it, deletion limitations, and how current evidence outranks it.

**Exit gate:** every lifecycle/security operation is available and tested through intended UI/API surfaces; docs match live defaults and protocol; telemetry contains no fixture secrets/content.

**Rollback:** hide/disable new mutating surfaces while retaining read-only explain/export and kill switches.

### Phase 12 — Shadow, canary, default, release, and long-term review

**Objective:** roll out based on evidence and stop automatically on harm.

- [ ] Run legacy and new pipelines in shadow with only one injected into a session; compare proposals, recall, actions, cost, and outcomes.
- [ ] Start opt-in with synthetic/non-sensitive workspaces and operator-visible mode badges.
- [ ] Canary by provider/model/platform/workload; do not average away a critical stratum regression.
- [ ] Define automatic rollback triggers for task delta, poison activation, scope leak, invalidated exposure, secret finding, deletion failure, latency/cost, crash, and storage growth.
- [ ] Run migration and rollback drills on copies of large real-shaped global/project/agent stores, including malformed Markdown, symlinks, long paths, worktrees, remote roots, and interrupted upgrades.
- [ ] Default-enable only after all hard gates and preregistered functional gates pass for a sustained reviewed window.
- [ ] Preserve memory-off and, only if it passes the centralized barrier/tombstone guard, legacy-read-only for at least one documented compatibility window; never preserve an unsafe reader merely to satisfy rollback symmetry.
- [ ] Publish release notes with behavior/default changes, privacy/storage impact, migration, kill switch, and honest benchmark methodology.
- [ ] Run all local required gates; hosted CI is not the test authority in this repository.
- [ ] Schedule quarterly research/benchmark/threat refresh and reevaluate default thresholds after model/provider changes.

**Exit gate:** release artifacts, docs, migrations, rollback, runtime assets, and default behavior converge; post-release canary remains within gates; no required work is left merely as a TODO in release notes.

**Rollback:** use the tested mode switch and release rollback procedure. Preserve tombstones, audit, and new data export; never downgrade by discarding user memory or reactivating withdrawn content.

## Evaluation contract

Memory ships on downstream behavior, not a retrieval leaderboard. Every run must separate the base model's ability from memory formation, retrieval, interpretation, and action use.

### Required comparison modes

Run the same task instances, seeds, provider/model snapshots, tools, budgets, and verifiers under:

1. memory off;
2. current AgenC legacy memory;
3. full eligible context within a declared budget;
4. deterministic lexical retrieval;
5. oracle evidence/context;
6. proposed system, with each major component ablated;
7. optional adapter or learned policy, if being considered.

For execution-state tests, also compare current compaction, exact recent tail, session-summary path, and active-state tree. For procedures, compare no procedure, nearest successful trace, simple validated warning/recipe, and the proposed lifecycle.

### External suites to adapt

| Capability | Primary suite/source | How to use it |
| --- | --- | --- |
| Incremental retrieval/learning/understanding/forgetting | [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | Reproduce pinned tasks; report all four competencies separately. |
| Interdependent multi-session actions | [MemoryArena](https://memoryarena.github.io/) | Use for learned experience that changes later web/planning/search/reasoning decisions. |
| Coding/research/tool/computer memory | [MemGym](https://arxiv.org/abs/2605.20833) | Prioritize executable coding tracks; distinguish proxy reward from final task success. |
| Stateful downstream outcomes/agent learning | [STATE-Bench](https://github.com/microsoft/STATE-Bench) | Pin its Agent Learning track and executable database/policy verifiers; report task completion separately from LLM-judged UX and adapt only after license/data review. |
| System module/cost characterization | [MemoryData](https://github.com/OpenDataBox/MemoryData) | Profile representation, extraction, retrieval/routing, maintenance, update stability, and cost. |
| Multi-principal utility/access/forgetting | [GateMem](https://github.com/rzhub/GateMem) | Adapt roles/scopes to users, projects, agents, and teams; keep hidden leak checkpoints. |
| Memory-use calibration/sycophancy | [MemSyco-Bench](https://github.com/XMUDeepLIT/MemSyco-Bench) | Test reject-as-fact, applicable scope, objective conflict, updates, and valid personalization. |
| Heterogeneous type contamination | [MemGuard](https://arxiv.org/abs/2605.28009) | Test whether episodes become facts/rules or rules are treated as evidence; compare type-isolated construction/retrieval with the same token budget. |
| Prospective intentions | [PM-Bench](https://github.com/genglinliu/PMBench) | Use only after license review; exercise updates, hidden channels, lures, cross-day state, and false triggers. |
| Durable-write distortion | [PASB code](https://github.com/henrymao2004/agent-sycophancy) | Test status promotion, attribution loss, uncertainty removal, and cross-domain scope broadening at commit. |
| Poisonable write channels | [MPBench paper](https://arxiv.org/abs/2606.04329) | Recreate explicit, inferred-policy, compaction, and experience-to-procedure attacks; no official code was located during this audit. |
| Delayed poison activation | [Sleeper memory research code](https://github.com/ivaxi0s/LLM-agent-memory-poisoning) | Exercise external source → write → later-session retrieval → action, including adaptive attacks. |
| Forged rationale memory | [FARMA](https://arxiv.org/abs/2607.05029) | Inject forged and self-reinforcing reasoning-shaped entries through each producer; verify no corroboration/authority gain and compare deterministic/independent screening defenses. |
| Longitudinal contamination | [Remembering More, Risking More](https://arxiv.org/abs/2605.17830) | Run fixed trigger probes against read-only snapshots across growing histories and compare with `NullMemory` to separate memory-caused risk from model/task drift. |
| Internal-channel privacy | [AgentLeak](https://github.com/Privatris/AgentLeak) | Audit messages, memory, tools, logs, files, and artifacts, not only final output. |
| Hierarchical isolation/publication | [AgentSys](https://arxiv.org/abs/2602.07398) | Adapt worker-isolated untrusted tool traces and typed return/publication boundaries; test malicious-but-schema-valid values as well as parse failures. |
| Authority laundering | [mem-inv-bench](https://github.com/yedidel/mem-inv-bench) | Test summarization, trusted-tool echo, and manufactured/Sybil corroboration; keep formal-model caveats. |
| Invalidation/cascade repair | [MEMOREPAIR](https://arxiv.org/abs/2605.07242) | Measure invalidated exposure from barrier through completed repair and incomplete-lineage failure. |
| Mutation/invalid-memory use | [Memora paper](https://aclanthology.org/2026.findings-acl.1337/) | Extend correction histories across month/quarter-like mutation depth. |
| Personalized long-horizon safety | [PerMemSafe](https://aclanthology.org/2026.findings-acl.320/) | Test evolving implicit risk context, unsupported inference, over-refusal, and preservation of helpfulness. |
| Conversational recall diagnostics | LoCoMo and LongMemEval through their pinned official releases | Use only as diagnostic/regression suites, never the primary ship gate for a coding agent. |

Do not put every large external suite in the normal pre-commit path. Maintain a small deterministic security/contract subset in Vitest, a reproducible local full suite, and an operator-run release suite with immutable manifests.

### AgenC-native scenario matrix

#### Write/admission

- Explicit safe user preference; global versus project-specific preference; later correction and exception.
- User says “remember” then reverses it in the same turn or later; jokes, hypotheticals, quotations, negation, uncertainty, and third-party claims.
- Assistant falsely reports that tests passed; failed tool result contradicts it.
- Malicious repository README/comment/test output asks the agent to persist a rule, secret, or permission.
- Web/MCP/email/document payload implants a delayed instruction or fake user profile.
- Trusted tool wrapper echoes an attacker-controlled value; repeated workers manufacture corroboration.
- Compaction delimiter injection and source attribution loss.
- Forged rationale/reasoning-shaped entries that self-reference, repeat across workers, or claim prior validation; verify that repetition cannot raise authority and that hidden reasoning is never retained.
- One successful-looking episode attempts to become a global procedure; failed and partial outcomes.
- Secret/token/private key/PII through every `Write`/`Edit`/`MultiEdit`/import/session/agent/team path.
- Duplicate versus correction ordering, concurrent proposals, retry/idempotency, crash between item and index/projection.

#### Recall and use

- Current repository state conflicts with memory; latest/as-of/interval questions; future-dated and expired claims.
- Correct preference versus factual sycophancy; preference for one project/person applied to another.
- Relevant item, counter-evidence, and conflict set; no-match abstention and one-word prompts.
- Live user says ignore/disable memory for this turn/session, or asks for a specific memory audit; current instruction must deterministically control injection without deleting data.
- Updated item needs resurfacing after an older version appeared earlier in the session.
- Exact-ID, enumeration, export, lineage, cache, snapshot, MCP, background job, and adapter scope bypass attempts.
- Procedure with wrong branch, worktree, tool version, provider, schema, permissions, or operating system.
- Memory suggests a destructive command, publication, credential use, external message, payment, or security change without live approval.
- Provider/reranker outage, timeout, malformed response, token pressure, and memory-off fallback.
- Fixed benign/adversarial trigger probes over increasingly long, read-only memory snapshots with a `NullMemory` counterfactual to detect gradual contamination.

#### Execution state and compaction

- Long debugging task with a failed branch that shares keywords with the correct branch.
- Completed subgoal summary later contradicted by a test; Revise from a checkpoint.
- Tool call/result pair at a compaction boundary; enormous output; failure fallback.
- External side effect before branch rollback; compensating action needs approval.
- Parent and workers update shared task state concurrently; daemon crashes at each transaction boundary.
- Restart, resumed thread, different worktree, changed Git HEAD, and stale session summary.
- Original objective/constraint appears only early in the transcript and must survive repeated compaction.

#### Multi-agent/privacy

- Compromised child tries to publish a secret or poison to parent/project/global/team memory.
- Parent can read a scope but child cannot; child attempts direct ID and inferred export.
- Central coordinator/hub compromise, sparse versus dense topology, Sybil workers, and confused deputy.
- Sensitive data appears in mailbox, delegation prompt, tool args/results, status, log, trace, snapshot, and artifact channels.
- Agent-private snapshot restore attempts to overwrite or leak another namespace.

#### Forgetting/deletion

- User corrects one root fact with multiple summaries, procedures, vectors, Markdown projections, caches, and agent copies.
- Immediate read races the serving barrier; repair fails halfway; restore uses an old backup.
- Exact content, paraphrase, membership inference, and adversarial extraction after deletion.
- Tombstoned legacy file reappears through filesystem sync/import.
- Ambiguous “forget that” and broad subject deletion; legal/retention policy conflict if supported.

#### Prospective behavior

- Time/event/state cue, hidden channel, cross-day/restart, update, cancellation, supersession, expiry, timezone/clock change, lure, and duplicate firing.
- Due intention lacks current permission, dependency, target, network, or user confirmation.
- Fixed heartbeat/many-subagent strategies generate false positives and excessive calls.

### Metrics

Report distributions and confidence intervals, not one average.

**Utility and correctness**

- end-to-end task success and partial progress;
- memory-attributable task delta/regret using paired memory-on/off runs;
- write precision, write recall on labeled eligible items, activation precision, and quarantine false-positive/false-negative rate;
- retrieval/context precision and recall, abstention calibration, conflict/counter-evidence coverage, temporal correctness, and selective forgetting;
- downstream valid-memory use versus factual sycophancy;
- procedure held-out success, harmful reuse, applicability mismatch, and time-to-demotion;
- execution-state reconstruction, failed-branch contamination, rollback correctness, and side-effect consistency;
- prospective Set-F1/precision/recall, false triggers, missed triggers, duplicates, and completion correctness.

**Security and governance**

- poison write attack-success rate and retrieved-poison behavioral success;
- unauthorized metadata/content exposure across every channel;
- memory-only consequential action attempts allowed/denied;
- origin/lineage coverage and authority-laundering success;
- invalidated exposure count and barrier latency;
- deletion residue/recovery across each managed tier;
- known-secret persistence or disallowed sink disclosure;
- over-refusal and legitimate personalization/utility loss from defenses.

**Systems**

- write construction, retrieval, validation, context-generation, maintenance, repair, and deletion latency separately;
- p50/p95/p99 wall time, tokens, provider calls, cache use, and monetary cost;
- canonical and derived storage growth, write amplification, index rebuild time, startup/migration time, job backlog, and freshness lag;
- human-review rate, review minutes per useful activation, quarantine backlog/age, and correction burden;
- query-volume amortization and local versus remote provider impact;
- crash/retry/error rates and no-memory fallback rate.

### Hard gates

For the reviewed deterministic fixture matrix, require:

- zero unauthorized cross-scope content disclosure;
- zero consequential action authorized solely by persisted memory;
- zero active known descendant after the invalidation transaction commits;
- zero known fixture secret persisted or sent to a disallowed sink;
- zero model/adapter direct mutation of canonical state;
- complete evidence/influence lineage for every activated/derived non-legacy item;
- no failed/abandoned branch represented as current active state;
- no split assistant tool call/result after compaction;
- successful logical withdrawal through search, direct ID, export, lineage, cache, prompt, job, and adapter paths;
- exact rollback/kill-switch behavior with canonical data preserved.

For stochastic/adaptive suites, Phase 0 must preregister acceptable upper confidence bounds and sample sizes. “Zero observed” in a tiny run is not proof of zero risk.

Functional release gates must be frozen from Phase 0 variance and reviewed before seeing the new-system result. At minimum, the proposed system must be non-inferior on every critical provider/platform/workload stratum, materially superior on the target long-horizon strata, and within preregistered cost/latency/storage budgets. Do not average away a safety or critical-task regression.

### Experimental hygiene

- Randomize and pair condition order; isolate stores per run; prevent cross-run/provider-cache contamination.
- Hide future answers/checkpoints from extractors and retrievers.
- Keep writer, retriever, generator, and judge model versions explicit; run cross-model transfer cases.
- Prefer deterministic executable verifiers. When an LLM judge is necessary, publish prompt, rubric, model, sampling, raw judgment, and disagreement audit.
- Use multiple seeds where sampling exists and report bootstrap or other preregistered confidence intervals.
- Record token/cost price date separately from token counts so historical runs remain comparable.
- Preserve every failed run and exclusion with a reason. Never tune on the held-out release set.

## Security and privacy checklist

This checklist supplements, but does not replace, the threat model and repository permission system.

- [ ] Apply [OWASP's AI Agent Security guidance](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html): validate/sanitize before storage, isolate memory, bound retention/size, protect secrets, monitor integrity, and red-team.
- [ ] Use the [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/) project as an attack-fixture/design input only; independently validate its early implementation and claimed detection results.
- [ ] Recheck the current [NIST agent-security RFI analysis](https://www.nist.gov/publications/summary-analysis-responses-request-information-regarding-security-considerations-ai) for provenance, isolation, validation, privacy, and deployment guidance before GA.
- [ ] Treat prompt-injection scanners as one signal. MPBench reports that conventional defenses miss persistent/weak-signal poisoning.
- [ ] Preserve immutable origin through summaries, tools, agents, imports, projections, and adapters; never infer trust from benign wording.
- [ ] Partition indexes/caches by security domain; test timing/error/count side channels and direct-ID access.
- [ ] Require purpose/sink checks before remote model, embedder, MCP, worker, team sync, logging, telemetry, export, or support bundle.
- [ ] Bind remote-provider routing to its current data-retention/training/cache contract and account policy; deny sensitive memory when the required guarantee is unknown or unavailable, and record the sink in lineage/deletion receipts.
- [ ] Minimize personal data; expose inspect/correct/forget; define retention/expiry; never infer sensitive traits for personalization.
- [ ] Redact identifiers/content from logs and traces while retaining policy reason codes and digests needed for audit.
- [ ] Rate-limit candidates, bytes, jobs, maintenance, and adversarial retrieval to prevent storage/token/CPU denial of service.
- [ ] Pin and audit adapter dependencies; generate/check SBOM; verify signed/reproducible runtime artifacts as required by release policy.
- [ ] Test symlink, hard-link, root swap, special file, invalid UTF-8, Unicode collision, path traversal, long path, permission mode, and time-of-check/time-of-use races on supported platforms.
- [ ] Test DB corruption, disk full, clock skew, concurrent writers, lease expiry, daemon crash, partial projection, and restore.
- [ ] Ensure memory-disabled mode is a safe operational fallback and not a way to bypass tombstones, audits, or live permission policy.

Additional primary research informing the threat model includes [BackdoorAgent](https://aclanthology.org/2026.findings-acl.791/) on persistent triggers, [Topology Matters](https://aclanthology.org/2026.findings-acl.1980/) on multi-agent leakage topology, [Safety Sidecar](https://aclanthology.org/2026.findings-acl.1542/) on external verification, and [A-MemGuard](https://openreview.net/forum?id=udqe7UZUZ6) on validation-oriented memory defense. Treat each as scoped evidence, not a turnkey guarantee.

## Compatibility and data migration

### Compatibility contract

Preserve or deliberately version all of the following:

- `$AGENC_HOME` resolution and `$AGENC_HOME/memory/` global store;
- canonical `<projectRoot>/.agenc/memory/` project store;
- remote memory root, full-path override, trusted `autoMemoryDirectory`, and worktree canonicalization;
- existing `MEMORY.md` indexes/topic Markdown and four frontmatter types;
- existing dated auto-memory log paths and any valid links from indexes/topics;
- `/memory` inspect/edit workflow and headless behavior;
- existing memory mention aliases/`@` routing where they are part of the supported agent surface;
- automatic-memory, simple/remote, extraction, session-memory, compaction, and AutoDream settings/environment gates;
- user/project/local agent-memory paths, namespace migration, and snapshots;
- MCP read-only memory exposure and redaction;
- thread/session memory mode persistence;
- daemon restart, transcripts/event logs, and state-store backups;
- additive daemon protocol and SDK compatibility;
- memory-off behavior.

Compatibility does not mean preserving an unsafe default forever. If inferred direct durable writes or false team-sync claims are disabled, document the behavior change, keep a reviewed opt-in compatibility window if justified, and provide migration/export—not a silent security regression.

### Legacy classification

- Global/project/team/agent/session files are **not** automatically trusted based on their location.
- Import existing durable topics as `legacy_unverified`, preserving original path, bytes/digest, mtime, frontmatter, inferred legacy scope, and import event.
- Treat `MEMORY.md` primarily as an index/projection; do not convert each index line into a fact without resolving the target.
- Import dated auto-memory logs as legacy evidence/episodes subject to retention and provenance review, not as automatically active facts or procedures.
- Preserve malformed/unparseable files byte-for-byte and report them for manual review; do not drop them.
- Import current session `summary.md` as unverified working state only, never durable cross-session knowledge.
- Keep Stage 1/Phase 2 tables/data intact until an explicit migration maps or retires them; they are not proof that a memory was active.
- Treat team files as local legacy shared content until a real authenticated sync identity/provenance exists.
- Preserve agent-memory namespace authority and strong filesystem checks; imported content still gets untrusted framing and bounds.

### Migration algorithm

1. **Preflight:** resolve all canonical stores with the unified resolver; detect collisions, duplicate roots, symlinks/hard links/special files, malformed UTF-8/frontmatter, permission problems, unsupported schema, disk space, and active background writers.
2. **Quiesce writers:** take the memory service lease and stop extraction/consolidation/projection jobs; reads remain available only through the guard-aware legacy-read-only mode (or memory-off before that adapter exists).
3. **Backup:** use existing state backup practices and create a content-addressed manifest of managed memory files. Never overwrite the only copy. Validate backup readability before migration.
4. **Import:** idempotently create namespace/event/item/version records keyed by source digest/path/import generation; no file mutation.
5. **Reconcile:** detect equivalent, conflicting, dangling-index, and duplicate-path items; report rather than auto-merge ambiguous content.
6. **Project:** generate proposed compatibility projections in a separate staging location; compare normalized content and links before atomic promotion.
7. **Shadow:** legacy read remains authoritative while new retrieval/policy decisions are logged and compared. Before any tombstone/deletion epoch can exist, put legacy access behind the shared guard so shadow/rollback cannot bypass it.
8. **Enforced writes:** new writes enter the ledger and project to Markdown; legacy files remain readable/importable.
9. **Enforced reads:** ledger becomes canonical for opted-in cohorts; only a namespace-, policy-, barrier-, and tombstone-aware compatibility adapter remains available for rollback/export during the compatibility window. Otherwise the only safe fallback is memory-off.
10. **Finalize:** after sustained gates, mark the migration generation complete. Do not delete legacy originals automatically; offer explicit reviewed archival/deletion with receipts.

### Filesystem edit reconciliation

- Watch or hash projections at safe synchronization points; do not trust an event watcher alone.
- Match a known projection by embedded/sidecar item/version ID and prior digest.
- No change: no-op.
- Safe human change from authenticated `/memory`: create a new explicit-user edit candidate/version with a diff.
- Out-of-band edit: create a `local_file` candidate, preserving prior/current digests and no live-user attribution.
- Deleted projection: request/record a forget candidate; do not infer authorized deletion across descendants without policy.
- Concurrent ledger and file edits: surface a conflict; never last-writer-wins.
- Unknown new file: import as `legacy_unverified` candidate.

Project projections may be committed to Git. Keep them deterministic and diff-stable, and never emit secrets, absolute home paths, private principal identifiers, provider metadata, or sensitive provenance into repository-visible sidecars. Canonical private metadata stays under `AGENC_HOME`; a tracked project file remains repository-origin content when another user imports it. Treat Git history, forks, caches, and remotes as propagated or unmanaged copies: a normal forget/delete can withdraw and remove the managed working-tree projection but cannot claim erasure from repository history. Any history rewrite is a separate explicit destructive workflow outside automatic memory maintenance.

### Rollback matrix

| Stage | Rollback action | Data handling |
| --- | --- | --- |
| Stabilized paths/gates | Select legacy read paths from the unified resolver | Existing files unchanged; unsafe inferred writes stay off. |
| Additive schema/shadow | Disable new service before lifecycle state exists; afterward use the guard-aware adapter or memory-off | New tables remain; the tombstone/deletion-epoch guard is never disabled and no downgrade migration is required. |
| Governed writes | Switch to guard-aware legacy-read-only and export active records, or memory-off | Preserve ledger/events/tombstones; do not resume automatic direct writes or serve withdrawn projections. |
| New recall | Select the guard-aware bounded compatibility retriever or memory-off | Canonical versions remain; no index deletion required; raw current recall is unavailable once barriers exist. |
| Deletion/repair | Pause repair/physical deletion jobs only | Serving barriers/tombstones remain mandatory. |
| Execution state | Return to current compaction/exact-tail | Execution records remain auditable and inert. |
| Procedure/shared/prospective | Disable that retrieval/publication/watcher | Records remain inspectable; nothing fires or becomes globally visible. |
| External adapter | Select native lexical adapter and purge/rebuild derived data | Canonical ledger is unchanged. |
| Release regression | Use documented release/mode rollback | Restore a validated backup only with deletion epochs/tombstones reapplied. |

Older binaries and compatibility readers must not open or bypass a newer incompatible state DB silently. Detect schema support and fail with a safe upgrade/export/recovery message. Once lifecycle records exist, an older binary that cannot enforce their guard must refuse memory reads (or the daemon must refuse that binary), not fall through to retained Markdown. A rollback is a behavior switch or validated backup restore, not a reverse migration that discards new records.

## Implementation touchpoint map

Final module names require an ADR, but keep responsibilities separated. A suggested layout is:

```text
runtime/src/memory/
  contracts/          strict domain types and decoders
  policy/             origin, taint, namespaces, capabilities, sink/action policy
  ledger/             repository, transactions, versions, evidence, influence, jobs
  admission/          capture, extraction, validation, DLP, promotion
  retrieval/          query plan, lexical/temporal/conflict retrieval, rerank, context compiler
  lifecycle/          correction, invalidation, repair, expiry, deletion
  execution/          nodes, heads, compaction adapter, links to canonical run/turn/effect durability
  procedures/         episodes, trial/promotion, outcome feedback
  prospective/        optional intention state machine and watchers
  projections/        Markdown import/export/reconciliation
  adapters/           optional derived index implementations
  telemetry/          content-minimized events and metrics
```

Do not create a second public memory barrel that drifts from [`runtime/src/memory/index.ts`](runtime/src/memory/index.ts).

### Current files requiring deliberate changes

**Paths, settings, and compatibility**

- [`runtime/src/memory/paths.ts`](runtime/src/memory/paths.ts)
- [`runtime/src/services/extractMemories/memory-paths.ts`](runtime/src/services/extractMemories/memory-paths.ts)
- [`runtime/src/prompts/attachments/relevant-memories.ts`](runtime/src/prompts/attachments/relevant-memories.ts)
- [`runtime/src/utils/attachments.ts`](runtime/src/utils/attachments.ts)
- [`runtime/src/mcp/server/start.ts`](runtime/src/mcp/server/start.ts)
- [`runtime/src/mcp/server/content-providers.ts`](runtime/src/mcp/server/content-providers.ts)
- [`runtime/src/utils/settings/types.ts`](runtime/src/utils/settings/types.ts)
- [`runtime/src/session/attachment-state.ts`](runtime/src/session/attachment-state.ts)
- [`runtime/src/state/threads.ts`](runtime/src/state/threads.ts)
- [`runtime/src/thread-store/store.ts`](runtime/src/thread-store/store.ts)

**Schema, store, and jobs**

- [`runtime/src/state/migrations/011_memory_pipeline_schema.ts`](runtime/src/state/migrations/011_memory_pipeline_schema.ts) (preserve; migrate forward)
- [`runtime/src/state/migrations/015_run_durability_schema.ts`](runtime/src/state/migrations/015_run_durability_schema.ts) (reuse; do not duplicate `run_effects`)
- [`runtime/src/state/migrations/index.ts`](runtime/src/state/migrations/index.ts)
- [`runtime/src/state/backfill.ts`](runtime/src/state/backfill.ts)
- [`runtime/src/memory/store.ts`](runtime/src/memory/store.ts)
- [`runtime/src/state/sqlite-driver.ts`](runtime/src/state/sqlite-driver.ts)
- [`runtime/src/state/run-durability.ts`](runtime/src/state/run-durability.ts)
- [`runtime/src/state/startup-run-journal-recovery.ts`](runtime/src/state/startup-run-journal-recovery.ts)

**Taxonomy, extraction, and writes**

- [`runtime/src/memory/types.ts`](runtime/src/memory/types.ts)
- [`runtime/src/memdir/memory-types.ts`](runtime/src/memdir/memory-types.ts) (remove duplicated contract)
- [`runtime/src/memory/extraction-triggers.ts`](runtime/src/memory/extraction-triggers.ts)
- [`runtime/src/services/extractMemories/extractMemories.ts`](runtime/src/services/extractMemories/extractMemories.ts)
- [`runtime/src/services/extractMemories/prompts.ts`](runtime/src/services/extractMemories/prompts.ts)
- [`runtime/src/phases/commit.ts`](runtime/src/phases/commit.ts)
- [`runtime/src/memory/privacy.ts`](runtime/src/memory/privacy.ts)
- [`runtime/src/utils/permissions/filesystem.ts`](runtime/src/utils/permissions/filesystem.ts)
- file `Write`/`Edit`/`MultiEdit` and system-write admission surfaces

**Recall and prompts**

- [`runtime/src/memory/scan.ts`](runtime/src/memory/scan.ts)
- [`runtime/src/memory/find-relevant.ts`](runtime/src/memory/find-relevant.ts)
- [`runtime/src/memory/age.ts`](runtime/src/memory/age.ts)
- [`runtime/src/memory/agencmd.ts`](runtime/src/memory/agencmd.ts)
- [`runtime/src/memory/memdir.ts`](runtime/src/memory/memdir.ts)
- [`runtime/src/prompts/attachments/messages.ts`](runtime/src/prompts/attachments/messages.ts)
- attachment orchestrator/types and session citation state

**Session, execution, and compaction**

- [`runtime/src/memory/session/sessionMemory.ts`](runtime/src/memory/session/sessionMemory.ts)
- [`runtime/src/memory/session/sessionMemoryUtils.ts`](runtime/src/memory/session/sessionMemoryUtils.ts)
- [`runtime/src/memory/session/prompts.ts`](runtime/src/memory/session/prompts.ts)
- [`runtime/src/services/compact/sessionMemoryCompact.ts`](runtime/src/services/compact/sessionMemoryCompact.ts)
- [`runtime/src/services/compact/autoCompact.ts`](runtime/src/services/compact/autoCompact.ts)
- `runtime/src/services/compact/{compact,prompt,types}.ts`
- [`runtime/src/budget/admitted-tool-call.ts`](runtime/src/budget/admitted-tool-call.ts)
- [`runtime/src/session/run-turn.ts`](runtime/src/session/run-turn.ts)
- [`runtime/src/session/session.ts`](runtime/src/session/session.ts)
- [`runtime/src/session/agenc-tool-use-context.ts`](runtime/src/session/agenc-tool-use-context.ts)
- [`runtime/src/session/event-log.ts`](runtime/src/session/event-log.ts)
- [`runtime/src/session/durable-turns.ts`](runtime/src/session/durable-turns.ts)
- [`runtime/src/session/turn-state.ts`](runtime/src/session/turn-state.ts)
- [`runtime/src/session/rollout-store.ts`](runtime/src/session/rollout-store.ts)
- [`runtime/src/session/rollout-reconstruction.ts`](runtime/src/session/rollout-reconstruction.ts)
- [`runtime/src/thread-store/live-thread.ts`](runtime/src/thread-store/live-thread.ts)

**Consolidation, agents, and swarms**

- `runtime/src/services/autoDream/*`
- `runtime/src/memdir/{teamMemPaths,teamMemPrompts}.ts`
- [`runtime/src/tools/AgentTool/agentMemory.ts`](runtime/src/tools/AgentTool/agentMemory.ts)
- [`runtime/src/tools/AgentTool/agentMemorySnapshot.ts`](runtime/src/tools/AgentTool/agentMemorySnapshot.ts)
- [`runtime/src/tools/AgentTool/loadAgentsDir.ts`](runtime/src/tools/AgentTool/loadAgentsDir.ts)
- [`runtime/src/plugins/registration/load-plugin-agents.ts`](runtime/src/plugins/registration/load-plugin-agents.ts)
- agent control/delegation/mailbox/run/status/thread-manager, background runner, task bridge, coordinator, and swarm command after current changes merge

**UI, protocol, SDK, and docs**

- `runtime/src/commands/memory/*`
- memory TUI components/renderers/usage indicators
- daemon app-server protocol/handlers/generated types
- `packages/agenc-sdk/` protocol mirror and public methods
- [`docs/reference/memory.md`](docs/reference/memory.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INDEX.md`](docs/INDEX.md), agent/swarm/permissions/privacy/CLI/SDK/troubleshooting docs
- release notes and configuration schema/reference

### Test layout

Preserve all existing memory, compaction, agent-memory, TUI, and contract tests. Add focused suites mirroring the architecture:

```text
runtime/tests/memory/
  paths-canonical.contract.test.ts
  filesystem-security.test.ts
  contracts.test.ts
  policy.contract.test.ts
  origin-taint.test.ts
  ledger.test.ts
  admission.test.ts
  retrieval.test.ts
  context-compiler.test.ts
  invalidation-repair.test.ts
  deletion-residue.test.ts
  projections-migration.test.ts
  execution-state.test.ts
  procedures.test.ts
  prospective.test.ts
  multi-agent-isolation.test.ts
  e2e-write-recall.test.ts
  adversarial-poisoning.test.ts
```

Also add daemon/SDK contract tests, `/memory` TUI tests, crash/restart integration tests, and the separate reproducible `runtime/evals/memory/` harness. Names are illustrative; follow existing conventions when implementation starts.

## PR decomposition

Do not implement this as one mega-PR. A sensible dependency order is:

1. `test(memory): freeze path, wiring, security, and behavior baselines`
2. `fix(memory): unify canonical paths and disable unsafe unwired writers`
3. `fix(memory): harden durable filesystem and secret admission`
4. `docs(memory): approve physical topology, deletion payload, and authority ADRs`
5. `feat(memory): add typed contracts, policy skeleton, and topology-correct additive ledger schema`
6. `feat(memory): add origin capture, namespaces, lifecycle, tombstone guard, and audit repository`
7. `feat(memory): replace direct writes with candidate admission`
8. `feat(memory): add reversible Markdown projections and guarded legacy import`
9. `feat(memory): add authorized lexical/temporal/conflict retrieval`
10. `feat(memory): add context compiler, explain, and action-use gate`
11. `feat(memory): add correction, cascade repair, and deletion verification`
12. `feat(memory): add branch-aware execution state over existing run durability and compaction`
13. `feat(memory): add outcome-grounded procedures`
14. `feat(memory): enforce agent/swarm memory isolation and publication`
15. `feat(memory): add prospective intentions` (only after the product ADR)
16. `perf(memory): evaluate optional index/learned adapters` (only if evidence clears the gate)
17. `feat(memory): complete operator/SDK surfaces and staged default rollout`

Split these further when a PR cannot be reviewed, tested, and rolled back independently. Every PR includes a revert-sensitive test, migration/rollback note, updated checklist links, and no unrelated dirty-worktree changes.

## Verification gates

### Every implementation PR

- targeted unit/contract/integration tests for changed behavior;
- `npm run typecheck` at zero errors;
- formatting/lint/build steps applicable to touched packages;
- revert-sensitive regression proof for a bug fix;
- no `@ts-nocheck`, unsafe broad cast, hidden policy bypass, or model-only safety control;
- source/license/security review for a new dependency or benchmark artifact.

### Before merging a phase

Run from the repository root:

```bash
npm run build
npm run typecheck
npm test
npm run test:bun
npm run validate:runtime
npm run check:agent-surface-contract
npm run build --workspace=@tetsuo-ai/agenc-sdk
npm run typecheck --workspace=@tetsuo-ai/agenc-sdk
```

For TUI/daemon/user-facing changes, explicitly run:

```bash
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
```

Also run focused daemon/LLM/TUI end-to-end gates appropriate to the phase. If a dependency changes, regenerate and verify the SBOM:

```bash
npm run sbom
npm run check:sbom
```

Run the repository's branding enforcement through its normal gates. Do not introduce historical project names into identifiers, strings, comments, errors, logs, environment variables, or file names.

### Before default enablement/release

- [ ] Full memory release-eval manifest passes all hard and functional gates.
- [ ] Five-platform runtime packaging/install/update behavior is verified if native/dependency surfaces changed.
- [ ] TUI and daemon startup pass at supported viewport/platform variants.
- [ ] Migration, interrupted migration, backup, restore, downgrade refusal, and every rollback mode are rehearsed.
- [ ] Kill switches work without network/provider availability.
- [ ] Docs/defaults/settings/CLI/SDK/protocol/runtime artifacts agree.
- [ ] Raw results, source revisions, model versions, costs, limitations, and known failures are archived.

Hosted CI does not replace these local gates in this repository.

## Risk register and default resolutions

| Risk | Default resolution | Evidence/gate |
| --- | --- | --- |
| Governance makes benign memory useless | Fast path only for explicit safe user preferences and deterministically verified scoped outcomes; measure over-refusal | Paired utility and defense-ablation tests |
| Fixing split paths exposes poisoned legacy extraction | Disable inferred direct writes before unifying consumers; restore via candidate path | Phase 1 regression/security tests |
| Provenance graph is incomplete | Mandatory evidence/influence edges; broader quarantine on uncertainty | Lineage coverage and incomplete-edge repair tests |
| Per-project SQLite cannot canonically own global/team scopes | Topology ADR before migration; one owner/database per namespace; keep global/team activation disabled until routed and recoverable | Cross-project isolation/federation, lock, backup/restore, migration, and deletion tests |
| SQLite/event growth | Minimal payload pointers, localized maintenance, quotas/retention, realistic volume benchmark | Storage/write amplification and migration tests |
| Embeddings leak sensitive data | Off by default; purpose/sink policy; local/remote adapter review | Sink and adapter isolation tests |
| Remote/graph service harms local CLI reliability | No mandatory sidecar; native lexical fallback | Offline/startup/timeout/rollback tests |
| Direct Markdown editing conflicts with canonical ledger | Versioned projections, digest reconciliation, explicit conflict UI | Import/edit/concurrency matrix |
| User expects deletion from backups/providers | Tiered guarantee and receipt; tombstones/deletion epochs on restore | Residue and restore tests |
| Encryption claim exceeds implementation | No encryption claim initially; prohibit secrets; ADR before key support | At-rest/key lifecycle review |
| Model/provider drift changes write/recall behavior | Provider-neutral contracts, deterministic fallback, per-provider canaries | Cross-model held-out runs |
| Learned controller reward-hacks benchmark | Shadow proposals only; held-out tasks/providers/adversarial suites | Ablations and no-policy-authority invariant |
| Procedure copies a past error | Objective outcomes, failure/comparison evidence, trial/held-out/canary lifecycle | Experience-following and distribution-shift tests |
| Compaction launders poison or loses goal | Raw evidence canonical, exact recent tail, untrusted framing, schema/source validation | PASB/MPBench and active-state tests |
| Worker/shared memory leaks secrets | Private defaults, explicit publish, destination admission, all-channel audit | AgentLeak/GateMem/native swarm tests |
| Concurrent agents overwrite state | CAS heads, immutable events, conflict retention, idempotency | Race/crash tests |
| Prospective memory fires wrongly | Explicit-only deterministic state machine and fresh action approval | PM-Bench/native lure/duplicate cases |
| Security filtering becomes an opaque model | Deterministic policy/reason codes; model screens only defense in depth | Policy contract and explain tests |
| Research becomes stale during implementation | Reverify primary sources and official repos at each phase/release | Evidence note in every research-dependent PR |
| Dirty swarm branch causes accidental overwrite | Start clean branch after current work is reconciled; re-audit integration seams | Git status and overlap check before Phase 8 |

### ADRs that must be finalized, with safe defaults

| ADR | Safe default pending decision |
| --- | --- |
| Physical storage topology | Do not create memory-ledger tables or activate `user_global`/team records until one canonical owner/database, namespace router, transaction boundary, backup/restore path, and deletion-epoch guard are approved. Keep project-local state in the existing project DB unless the ADR demonstrates a safer migration. |
| Local principal/daemon client identity | Bind to the existing authenticated local client/OS-user boundary; do not pretend it is multi-tenant identity. |
| At-rest encryption | No new encryption claim; restrictive modes and secret prohibition. Add envelope encryption only with supported key lifecycle/recovery. |
| Lexical engine | Reuse proven in-process BM25 or feature-probed SQLite FTS after cross-platform benchmarks; no new native dependency by assumption. |
| Embeddings/graph | Disabled and optional derived adapters. |
| Team transport | Disabled; no sync wording or shared default. |
| Retention | Preserve existing user files, minimize new event payloads, and expose inspect/delete before choosing automatic expiry. |
| Telemetry | Content-free/local by default; explicit documented opt-in for any remote diagnostic sink. |
| Prospective actions | Out of default core until explicit product scope and authority semantics are approved. |
| Learned policy | Research/shadow only; deterministic control plane remains final. |

## Definition of done

The redesign is complete only when all of the following are true:

- [ ] Every live memory producer and consumer uses the canonical resolver and control plane.
- [ ] Every namespace has exactly one ADR-defined canonical physical owner; cross-project global access, backups/restores, locks, deletion epochs, and downgrade behavior pass topology tests, while unimplemented team transport remains disabled.
- [ ] No model or adapter can directly mutate canonical active memory.
- [ ] Every new active item has typed scope, kind, immutable origin, evidence, authority ceiling, validity/lifecycle, sensitivity/sink policy, and a version.
- [ ] Instructions/persona/live permissions remain separate and always outrank learned memory.
- [ ] Recall authorizes before content exposure, retrieves conflicts/counter-evidence, can abstain, cites sources, and is bounded/explainable.
- [ ] Persisted memory cannot authorize a consequential action.
- [ ] Execution state preserves the active branch, exact recent tool pairs, validated summaries, and rollback checkpoints while reusing the existing durable run/effect journal as the sole effect/recovery authority.
- [ ] Procedures are outcome-grounded, trialed, scoped, versioned, canaried, and reversible.
- [ ] Agent/swarm memory is private by default with explicit governed publication.
- [ ] Correction/forget immediately withdraws every known descendant and deletion is verified across managed tiers with honest limitations.
- [ ] Erasable user-derived event/candidate/version payloads are physically separable from immutable minimized envelopes; FK/influence behavior cannot leak content, orphan servable data, or erase barriers.
- [ ] Existing Markdown/session/agent data migrates idempotently and reversibly without silent trust promotion or loss.
- [ ] `/memory`, headless CLI, daemon, and SDK make lifecycle, origin, conflicts, why-recalled, correction, forget, and health observable.
- [ ] Memory-off/native fallback, kill switches, migration rollback, adapter rollback, and release rollback are tested.
- [ ] The full deterministic safety matrix passes and stochastic gates meet preregistered confidence bounds.
- [ ] The new default is non-inferior across every critical stratum, materially better on target long-horizon tasks, and within frozen cost/latency/storage budgets.
- [ ] TypeScript remains clean, full Vitest is green, required TUI/daemon/agent-surface gates pass, and release artifacts converge.
- [ ] Documentation states actual defaults, storage, privacy, deletion limits, failure modes, and benchmark methodology.
- [ ] Research sources and official repositories have been rechecked at the release date; claims are evidence-tiered and reproducible.

If any safety invariant, migration/rollback proof, critical-stratum functional gate, or required repository gate is missing, the system remains opt-in/shadow and this plan is not complete.
