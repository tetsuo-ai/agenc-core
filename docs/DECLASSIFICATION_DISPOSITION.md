# AgenC Core Declassification Disposition

This document is the public-scrub inventory for `agenc-core` before any
repository visibility change. It implements the disposition table required by
`agenc-core#9` and follows ADR-003: AgenC is moving toward a public framework
product, but genuine service-side or operational-advantage surfaces must stay
private or be replaced before the visibility flip.

## Disposition Table

| Surface | Current owner | Keep public | Move out | Replace | Delete | Blocking dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/agenc/` public wrapper | Runtime / Package owners | Yes | No | No | No | Keep release docs aligned to supported public platforms. |
| `runtime/` daemon, TUI, tools, and gateway | Runtime Architecture | Conditional | No | Yes, package identity/docs | No | Finish public product contract and security scope signoff for daemon, webchat, tools, and policy surfaces. |
| `web/` dashboard | Web / Runtime Architecture | Yes | No | No | No | Confirm all state/actions are daemon-backed and document auth/origin/session rules. |
| `mobile/` client work | Product / Mobile | Conditional | No | No | No | Classify release posture and remove local-only assumptions before public launch. |
| `mcp/` runtime MCP package | Runtime Architecture | Conditional | No | Yes, docs | No | Reclassify from private-kernel package to supported public operator package or keep transitional notice. |
| `docs-mcp/` package | Docs / Runtime Architecture | Conditional | No | Yes, docs | No | Decide whether it is public docs tooling or internal contributor tooling. |
| `contracts/desktop-tool-contracts/` | Desktop / Runtime Architecture | Yes | No | No | No | Keep as public ABI if desktop bridge remains public. |
| Desktop server package / desktop bridge docs | Desktop owners | Conditional | Maybe | Yes | No | Security review for REST/VNC/noVNC exposure and sandbox auth. |
| `examples/` | Developer Experience | Yes | No | No | No | Ensure examples do not require private registry or internal services. |
| `docs/PRIVATE_KERNEL_DISTRIBUTION.md` | Platform Architecture | No | Maybe | Yes | No | Replace with public package/release distribution policy; move Cloudsmith private-kernel mechanics to private ops if still needed. |
| `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md` | Platform Architecture | No | Maybe | Yes | No | Replace private-kernel posture with public-framework support policy. |
| `docs/PRIVATE_REGISTRY_SETUP.md` | Platform Architecture | No | Yes | No | No | Move Cloudsmith/Verdaccio private registry setup to private ops repo before visibility flip. |
| `config/private-kernel-distribution*.json` | Platform Architecture | No | Yes | No | No | Private registry topology must leave public repo or become inert examples without hosted endpoints. |
| `containers/private-registry/` | Platform Architecture | No | Yes | No | No | Move private registry reference backend and CI fixtures to private ops repo. |
| `.github/workflows/private-kernel-cloudsmith.yml` | Platform Architecture | No | Yes | No | No | Remove or move protected Cloudsmith validation workflow. |
| `.github/workflows/private-kernel-registry.yml` | Platform Architecture | No | Yes | No | No | Move Verdaccio private-registry validation to private ops repo. |
| `.github/workflows/package-pack-smoke.yml` | Runtime / Release | Conditional | No | Yes | No | Replace private-kernel checks with public wrapper/runtime package smoke checks. |
| `.github/workflows/release.yml` | Release Engineering | Yes | No | Yes | No | Ensure release builds publish only public artifacts and do not rely on private-kernel naming. |
| Private/proof harnesses under `tools/proof-harness` if present | Protocol / Runtime QA | Conditional | Maybe | Yes | No | Decide whether harness is public validation tooling or private operator harness; remove internal wallet paths. |
| Runtime credentials/policy/session credential code | Runtime Security | Yes | No | No | No | Keep code public, but verify examples/tests never expose real secrets and docs explain safe configuration. |
| `docs/security/*` and audit docs | Security owners | Yes | No | No | No | Scope claims must stay explicit; no on-chain audit artifact may imply whole-product signoff. |
| `.claude/notes/` | Internal agents / PM | No | Yes | No | Maybe | Move internal planning notes to private planning repo or convert durable public ADRs. |
| `.claude/notes/pr-log.md` | Internal agents / PM | No | Yes | No | Maybe | Scrub private run details before visibility flip. |
| `artifacts/` generated bundles | Surface owners | Conditional | Maybe | Maybe | Maybe | Inventory each artifact for paths, wallets, local operator names, benchmark hosts, or internal service references. |
| `docs/devnet-h200-benchmark-plan.md` | ML / Protocol validation | Conditional | Maybe | Yes | No | Remove private hardware/operator assumptions or move to private infra docs. |
| `docs/MAINNET_*`, deployment, and emergency docs | Protocol / Release | Conditional | Maybe | Yes | No | Scrub credentials, deploy-wallet assumptions, and private operator paths; keep public runbook only if safe. |

## Classification By Area

Runtime-side packages:
`@tetsuo-ai/agenc` is the intended public install identity. Runtime-side
packages previously described as private-kernel surfaces need a final
classification before public visibility: public product package, public
operator package, private ops package, or deprecated transitional package.

Private-boundary CI:
Cloudsmith and Verdaccio private-kernel workflows are not public-product gates.
They should be moved to private ops or replaced with public package smoke gates.
Release workflows may stay only if they build and publish public artifacts.

Private-kernel docs and policies:
Private-kernel docs currently explain an old transition state. Replace them
with public-framework support, release, and security-scope docs. If the private
registry remains operational, move its mechanics out of `agenc-core`.

Internal-only tools and services:
Proving backends, premium ranking/search/coordination services, anti-abuse
services, internal service credentials, private registry infrastructure, and
admin/ops tooling are not part of the public repo surface. Keep only public
contracts, local-safe examples, and sanitized runbooks.

## Public Doc Sweep Plan

1. Rewrite `docs/CODEBASE_MAP.md` so `runtime/` is no longer described as a
   private kernel package unless that is still the explicit product decision.
2. Replace private-kernel distribution/support docs with public-framework
   support and release-channel docs.
3. Move Cloudsmith/Verdaccio private registry setup and config to a private ops
   repository, or mark examples inert and remove hosted endpoints.
4. Update `docs/COMMANDS_AND_VALIDATION.md` to use public package/runtime smoke
   commands instead of private-kernel gates.
5. Re-run a secret/path sweep over docs, workflows, configs, artifacts, and
   `.claude/notes`.
6. Update `docs/SECURITY_SCOPE_MATRIX.md` for the exact release commit and
   require named owner signoff for any deferred public surface risk.
7. Add a final visibility-flip checklist PR that deletes/moves blocked surfaces
   and links this table row-by-row.
