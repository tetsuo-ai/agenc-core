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

## OB-04 `/doctor` Health Check

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow local donor citation in parity artifact -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/commands/doctor/doctor.tsx`
- `src/screens/Doctor.tsx`
- `src/utils/doctorDiagnostic.ts`
- `src/utils/doctorContextWarnings.ts`
- `src/components/sandbox/SandboxDoctorSection.tsx`
- `src/services/mcp/doctor.ts`
- `src/commands/mcp/doctorCommand.ts`

OB-04 ports the grouped diagnostic-finding shape into AgenC's text-only
`/doctor` command and replaces donor-specific install/update checks with AgenC
runtime health checks:

- `runtime/src/commands/doctor/doctor.ts` owns the immediate slash command and
  delegates to the diagnostics engine.
- `runtime/src/diagnostics/doctor.ts` checks daemon pid/socket/cookie state,
  active provider credential readiness, platform sandbox command transforms,
  MCP effective/connected server state, and LP-22 runtime package artifacts.
- `runtime/src/diagnostics/doctor.test.ts` locks provider, sandbox, daemon,
  MCP, artifact, and text-rendering behavior.
- `parity/OB-04-parity.json` records the donor counterparts and intentional
  reductions, including the decision not to add a separate `agenc mcp doctor`
  command in this item.
