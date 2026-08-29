import { editCanonicalUserConfig, type ConfigEditorSpawner, spawnConfigEditor } from "../config/editor.js";
import { isPlainRecord } from "../config/json.js";
import type { ConfigStore } from "../config/store.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import { editorForEnv } from "./config.js";
import { configStoreFromCommandContext } from "./config-context.js";
import {
  safeExecute,
  type SlashCommand,
} from "./types.js";

const DEFAULT_KEYBINDING_SCAFFOLD = Object.freeze([
  Object.freeze({
    context: "Chat",
    bindings: Object.freeze({
      "ctrl+x ctrl+e": "chat:externalEditor",
    }),
  }),
]);

function scaffoldCanonicalKeybindings(store: ConfigStore): boolean {
  if (store.current().tui?.keybindings !== undefined) return false;
  let created = false;
  mutateCanonicalUserConfigSync(store.homeContext.configTomlPath, (raw) => {
    if (raw.tui !== undefined && !isPlainRecord(raw.tui)) {
      throw new Error("canonical tui config must be a table");
    }
    const tui = isPlainRecord(raw.tui) ? raw.tui : (raw.tui = {});
    if (tui.keybindings !== undefined) return;
    tui.keybindings = DEFAULT_KEYBINDING_SCAFFOLD;
    created = true;
  });
  return created;
}

export function createKeybindingsCommand(
  deps: {
    readonly env?: NodeJS.ProcessEnv;
    readonly spawner?: ConfigEditorSpawner;
  } = {},
): SlashCommand {
  const env = deps.env ?? process.env;
  const spawner = deps.spawner ?? spawnConfigEditor;
  return {
    name: "keybindings",
    description: "Customize canonical TUI keybindings",
    immediate: true,
    userInvocable: true,
    execute: (ctx) => safeExecute(async () => {
      if (ctx.argsRaw.trim().length > 0) {
        return { kind: "error", message: "Usage: /keybindings" };
      }
      const store = configStoreFromCommandContext(ctx);
      if (store === null) {
        return {
          kind: "error",
          message: "ConfigStore not initialised; keybindings were not changed",
        };
      }
      const scaffolded = scaffoldCanonicalKeybindings(store);
      const path = store.homeContext.configTomlPath;
      const result = await editCanonicalUserConfig({
        path,
        editor: editorForEnv(env),
        spawner,
      });
      if (result.exitCode !== 0) {
        return {
          kind: "error",
          message: `Editor "${result.editorCommand}" exited with code ${result.exitCode}. File path: ${path}`,
        };
      }
      await store.reload();
      return {
        kind: "text",
        text: scaffolded
          ? `Created the canonical keybinding scaffold and edited ${path}; keybindings reloaded`
          : `Edited ${path}; keybindings reloaded`,
      };
    }),
  };
}

export const keybindingsCommand = createKeybindingsCommand();
