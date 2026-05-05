# Extract Memories Parity

Source commit: `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/extractMemories/extractMemories.ts`
- `src/services/extractMemories/prompts.ts`

Supporting anchors:
- `src/memdir/paths.ts`
- `src/memdir/memoryScan.ts`
- `src/memdir/memoryTypes.ts`
- `src/query/stopHooks.ts`
- `src/utils/backgroundHousekeeping.ts`

This directory owns automatic memory extraction after a natural terminal
turn. AgenC keeps the behavior in its live session, delegate, and file-tool
surfaces: terminal commit schedules extraction, the completed-tool ledger
lets successful absolute direct memory writes bypass the child run, the child
agent keeps the parent tool catalog while memory-directory access is enforced
by child policy, the extraction child runs silently without parent mailbox or
child-rollout side effects, extraction cursors are scoped by session and
memory directory, and the extractor drains any coalesced work before tests or
shutdown call `drainPendingExtraction()`.

Prompt divergence: S-03 intentionally keeps the auto-only prompt compact and
omits the source prompt's longer success/failure examples and date-handling
guidance. The local service only writes the single auto-memory directory and
does not route team memories or shell-assisted learning flows in this item.
