# `/goal`: keep working until it is actually done

`/goal` gives a session an end condition. The agent keeps working, turn after
turn, until the runtime confirms the condition holds. The agent's own "done"
decides nothing.

```text
/goal every test in test/auth passes and no other test file changes --verify "tests=npm test"
```

## What a goal is

A goal is a structured object, not a sentence:

| Part | Meaning |
|---|---|
| **Objective** | The end state, stated so that something can prove it. |
| **Verification** | Commands the *runtime* runs. Exit code 0 is the only pass. |
| **Constraints** | What must not happen on the way. Every goal carries: "Do not modify, skip, weaken, or delete tests or checks to make them pass." |
| **Budget** | Rounds (default 20), and optionally cost. |
| **Stops that are not completion** | `budget_exhausted`, `stalled`, `blocked`, `impossible`. |

This follows the shape OpenAI documents for Codex goals (objective, verification
surface, constraints, completion condition, a blocked stop) and the guidance in
Claude Code's `/goal` (one measurable end state, a stated check, the
constraints that matter).

## Writing a good goal

- **Name an end state a command can prove.** "All tests in `test/auth` pass" is a goal. "Improve the auth code" is not.
- **Say how it is checked.** Pass `--verify "label=command"`, repeatable. Without it, AgenC looks for the project's own test entry point (`npm|pnpm|yarn|bun test`, `cargo test`, `go test ./...`, `python -m pytest`, `make test`).
- **State what must not change.** Put it in the objective: "…and no public API changes".
- **Bound it.** `--max-rounds N`, `--max-cost USD`.

If nothing can check the goal, `/goal` refuses and shows the flag to add. Use
`--no-verify` to accept a review-only goal, judged from the diff.

## How a round works

When the agent gives a final answer while a goal is active, the runtime:

1. **Checks the budget and for a stall.** Out of rounds or cost, or three rounds in a row without one successful tool call: the goal stops and control returns to you. Neither is "met".
2. **Runs the verification commands itself**, through the session's shell tool, so the sandbox, permission mode and audit trail apply as for any command. A non-zero exit or a timeout sends the *real output* back to the agent.
3. **Lists verification files that changed** since the goal was set: tests, runner config, files your verify commands name.
4. **Asks an independent reviewer.** It runs in a fresh context on `goal.judge_model`, with no tools. It sees the goal, the executed results, the diff and the changed-check list, and is told the ways checks get gamed without editing a test (input special-casing, state kept across calls, overridden comparisons). It never sees the agent's conversation. It answers `met`, `not_met`, `impossible` or `blocked`. A reply that is not the required JSON gets one repair turn and then counts as `not_met`.
   When a command failed, the goal cannot be met, but the reviewer is still asked, this time with the failing output and the agent's final message marked as a claim. It can only answer `not_met`, `impossible` or `blocked`, so the agent can argue its way out of a goal that cannot be done honestly and never into `met`.
5. **Continues or ends.** `not_met` re-enters the loop with what is unmet and the objective quoted verbatim. `met` ends the goal.

The goal is session state, journaled as `goal_changed` events. It is not part
of the conversation, so compaction cannot drop or paraphrase it, and it is
restated at the top of every later turn. A reopened session gets an open goal
back **paused**; `/goal resume` continues it.

`/goal` does not change the permission mode. In `default` mode the agent's
edits, and the runtime's verification command, still ask for approval. Use
`acceptEdits` or approve the command for the session to let a goal run alone.

## Commands

| Command | Effect |
|---|---|
| `/goal <objective> [flags]` | Set the goal and start working. Replaces an active goal. |
| `/goal` | Show the objective, status, rounds, last verdict and reason, and check results. |
| `/goal pause` / `/goal resume` | Pause, or continue a paused, stalled, blocked or budget-exhausted goal. |
| `/goal clear` | Drop the goal. Aliases: `stop`, `off`, `cancel`, `reset`, `none`. |

Configuration lives under `[goal]`; see [config.md](config.md).

## Why it works this way

Each rule answers a documented failure of long-running agents.

| Rule | Evidence |
|---|---|
| A goal needs an objective, a verification surface, constraints, and a completion condition. | OpenAI, [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex). |
| Completion is decided by a fresh model, not the one doing the work. | Anthropic, [Claude Code `/goal`](https://code.claude.com/docs/en/goal). |
| Verification is a structural step, not a request in the prompt. | Premature termination, missing verification and incorrect verification are 23.5% of failures across 1,600+ traces: Cemri et al., *Why Do Multi-Agent LLM Systems Fail?*, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657). |
| The agent gets real command output back, never "please double-check". | Models do not reliably self-correct without external feedback: Huang et al., ICLR 2024, [arXiv:2310.01798](https://arxiv.org/abs/2310.01798). |
| The reviewer never sees the worker's conversation and can run on a different model. | LLM judges favour their own generations: Panickssery et al., NeurIPS 2024, [arXiv:2404.13076](https://arxiv.org/abs/2404.13076). |
| Changed checks are reported, the reviewer judges the diff against the objective and is told the non-test gaming patterns, the integrity constraint is always present, and the agent is told that reporting an impossible goal is a correct result. ImpossibleBench measured both levers: strict wording and an explicit flag option cut GPT-5's cheating from 54% to 9% on Conflicting-SWEbench. | Agents pass checks by weakening them: METR, [Recent Frontier Models Are Reward Hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking/); ImpossibleBench, [arXiv:2510.20270](https://arxiv.org/abs/2510.20270); SpecBench, [arXiv:2605.21384](https://arxiv.org/abs/2605.21384). |
| A goal nothing can check is refused, with the fix. | Agents rarely notice underspecification, and resolving it recovers up to 74%: Ambig-SWE, ICLR 2026, [arXiv:2502.13069](https://arxiv.org/abs/2502.13069). |
| The goal lives outside the conversation and is quoted verbatim every round. | Goal drift grows with context length: Arike et al., AIES 2025, [arXiv:2505.02709](https://arxiv.org/abs/2505.02709). |
| One unmet item at a time; leave a clean state. | Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). |
| Budget exhaustion and a stall are not completion. | Codex and Claude Code both separate them from "met". |

Where AgenC differs from the others: Claude Code's evaluator reads the
transcript and does not run commands. AgenC runs the checks itself, so an agent
that merely *says* the tests pass gains nothing.

## Related

`agenc run start --goal` is a different tool: a one-shot verified-change
pipeline in an isolated worktree that delivers a reviewed commit to
`refs/agenc/runs/<id>` and never touches your checkout. `/goal` works in your
session and your checkout. See [cli.md](cli.md#run).
