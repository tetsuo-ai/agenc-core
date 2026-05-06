# Commands Parity

## OB-03 `/help` Slash Command

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow local donor citation in parity artifact -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/commands/help/index.ts`
- `src/commands/help/help.tsx`
- `src/components/HelpV2/HelpV2.tsx`
- `src/components/HelpV2/Commands.tsx`
- `src/components/HelpV2/General.tsx`
- `src/commands.ts::builtInCommandNames`
- `src/commands.ts::formatDescriptionWithSource`

OB-03 ports the grouped command-list behavior into AgenC's text-only slash
command surface. AgenC does not port the React/Ink HelpV2 tabs or the
donor-branded general help copy; runtime ownership is:

- `runtime/src/commands/help.ts` filters hidden and disabled commands,
  deduplicates by canonical command name, sorts commands within groups, renders
  built-in slash commands by category, and renders non-built-in entries from
  AgenC's full command surface in `Custom Commands`.
- `runtime/src/commands.ts` owns the full command surface loaded by `/help`:
  local skills, plugin/workflow commands, registered command providers, and
  projected built-in slash commands.
- `runtime/src/commands/help.test.ts` locks the grouped output, aliases,
  disabled/internal filtering, duplicate collapse, canonical
  `/model-provider, /provider` alias display, default-registry coverage, and
  custom command grouping.
