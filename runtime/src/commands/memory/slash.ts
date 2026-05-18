import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../types.js";

const MEMORY_CLI_SURFACE = "agenc memory";

/**
 * Headless dispatcher fallback for `/memory`.
 *
 * The interactive TUI command body lives in `memory.tsx`. The registry still
 * needs a plain SlashCommand so daemon/headless dispatch has a non-throwing
 * answer instead of trying to render Ink.
 */
export const memorySlashCommand: SlashCommand = {
  name: "memory",
  description: "Open AgenC memory editor",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const setToolJSX = ctx.appState?.setToolJSX;
      if (typeof setToolJSX === "function") {
        const { call } = await import("./memory.js");
        const close = () => {
          setToolJSX({
            jsx: null,
            shouldHidePromptInput: false,
            clearLocalJSX: true,
          });
        };
        const jsx = await call(
          () => {
            close();
          },
          {} as never,
          ctx.argsRaw,
        );
        setToolJSX({
          isLocalJSXCommand: true,
          shouldHidePromptInput: true,
          jsx,
        });
        return { kind: "skip" };
      }
      return {
        kind: "text",
        text:
          `The ${MEMORY_CLI_SURFACE} editor is available in the interactive TUI. ` +
          "Run /memory there to choose and edit memory files.",
      };
    }),
};

export default memorySlashCommand;
