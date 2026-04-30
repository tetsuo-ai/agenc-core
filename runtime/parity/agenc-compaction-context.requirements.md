# AgenC Compaction And Context Requirements

This contract owns the AgenC runtime compaction and context layer. Completion
requires the old local compaction and context implementation to be removed, the
new AgenC implementation to be wired into the live turn loop, and every required
row in the matrix to have an executable assertion.

The compact/context dependency source tree must be copied into this repository
under `runtime/src/agenc/upstream`. Build and test config must resolve those
modules from the local copied tree and must not probe sibling source checkouts.
The live Node adapter path may route through an upstream-derived AgenC runtime
shim when direct imports from the copied prompt/config/UI graph would pull
unavailable package-manager or memory surfaces into compaction.

The implementation surface must use AgenC names in files, exported symbols,
comments, strings, tests, scripts, and contract metadata. External product or
source-project names are not allowed in this surface.

Required completion gates:

- Matrix shape validation passes.
- Every required target exists.
- Every row lists at least one executable assertion.
- Old compaction and context files remain absent.
- Old runtime references remain absent from non-vendored live code.
- Copied compact/context dependencies resolve from the local tree.
- The naming gate passes across all configured surface paths.
- Focused row tests pass through the contract test runner.
