# ExecPolicy Parity

// branding-scan: allow local donor parity citation
Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `execpolicy/src/lib.rs`
- `execpolicy/src/parser.rs`
- `execpolicy/src/policy.rs`
- `execpolicy/src/rule.rs`
- `execpolicy/src/decision.rs`
- `execpolicy/src/amend.rs`
- `execpolicy/src/executable_name.rs`
- `execpolicy/src/error.rs`
- `execpolicy/src/execpolicycheck.rs`
- `execpolicy/src/main.rs`
// branding-scan: allow local donor parity citation
- `execpolicy/examples/example.codexpolicy`
- `execpolicy/tests/basic.rs`

This directory owns AgenC's TypeScript port of the execpolicy command-pattern engine:
- `decision.ts` models allow, prompt, and forbidden decisions with strictest-decision aggregation.
- `rule.ts` implements prefix rules, network rule host normalization, rule-match serialization, and example validation.
- `policy.ts` stores rules, network entries, host executable mappings, overlay merges, and command evaluation.
- `parser.ts` parses the declarative policy call surface (`prefix_rule`, `network_rule`, and `host_executable`) and validates examples after each parse.
- `amend.ts` appends deduplicated prefix and network rules with file locking.
- `execpolicycheck.ts` loads one or more policies and renders checker JSON.
- `main.ts` parses the checker command argv shape.
- `index.ts` exposes the AgenC-owned public surface with helper constructors; the source library root is folded here to avoid a forwarding-only module.
- `execpolicy.test.ts` ports the donor test corpus into focused Vitest coverage.
- `examples/example.agencpolicy` carries the donor example corpus with the AgenC policy filename.

Shape difference:
- AgenC uses a dedicated declarative parser for the policy builtins instead of embedding a general Starlark runtime. The accepted policy surface is the executable policy DSL in the source corpus: function calls, keyword arguments, strings, lists, comments, and trailing commas.
