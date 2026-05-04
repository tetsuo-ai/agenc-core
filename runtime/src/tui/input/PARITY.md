# TUI Input Pipeline Parity

Primary source anchors:

- `src/utils/processUserInput/processUserInput.ts`
- `src/utils/processUserInput/processBashCommand.tsx`
- `src/utils/processUserInput/processSlashCommand.tsx`
- `src/utils/processUserInput/processTextPrompt.ts`

This directory owns AgenC's TUI input routing pipeline. It routes raw
submitted input to bash command execution, slash command dispatch, or regular
prompt message creation.
