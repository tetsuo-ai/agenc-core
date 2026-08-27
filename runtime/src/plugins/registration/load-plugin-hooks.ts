import type { HookCommand, HookMatcher, HooksMap } from "../../config/schema.js";
import { validateHooksConfig } from "../../config/schema.js";
import {
  isRepositoryControlledPlugin,
  type LoadedPlugin,
  type PluginHookSource,
} from "../loader.js";
import {
  loadRuntimePlugins,
  substitutePluginTemplate,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginHookRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
}

function substituteHookCommand(
  plugin: LoadedPlugin,
  command: HookCommand,
  options: PluginHookRegistrationOptions,
): HookCommand {
  return {
    ...command,
    command: substitutePluginTemplate(command.command, plugin, {
      sessionId: options.sessionId,
      ...(options.pluginStorageRoot !== undefined
        ? { pluginStorageRoot: options.pluginStorageRoot }
        : {}),
    }),
    ...(command.statusMessage !== undefined
      ? {
          statusMessage: substitutePluginTemplate(
            command.statusMessage,
            plugin,
            {
              sessionId: options.sessionId,
              ...(options.pluginStorageRoot !== undefined
                ? { pluginStorageRoot: options.pluginStorageRoot }
                : {}),
            },
          ),
        }
      : {}),
  };
}

function hookSourceToMatchers(
  plugin: LoadedPlugin,
  source: PluginHookSource,
  options: PluginHookRegistrationOptions,
): HooksMap {
  const out: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(source.hooks)) {
    out[event] = [
      ...(out[event] ?? []),
      ...matchers.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map((hook) =>
          hook.type === "command"
            ? substituteHookCommand(plugin, hook, options)
            : hook,
        ),
      })),
    ];
  }
  return out;
}

function mergeHooks(a: HooksMap | undefined, b: HooksMap): HooksMap {
  const out: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(a ?? {})) {
    out[event] = [...matchers];
  }
  for (const [event, matchers] of Object.entries(b)) {
    out[event] = [...(out[event] ?? []), ...matchers];
  }
  return out;
}

async function resolvePlugins(
  options: PluginHookRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function loadPluginHooks(
  options: PluginHookRegistrationOptions,
): Promise<HooksMap | undefined> {
  const plugins = await resolvePlugins(options);
  let merged: HooksMap | undefined;
  for (const plugin of plugins) {
    if (isRepositoryControlledPlugin(plugin)) continue;
    for (const source of plugin.hookSources) {
      merged = mergeHooks(merged, hookSourceToMatchers(plugin, source, options));
    }
  }
  return validateHooksConfig(merged);
}
