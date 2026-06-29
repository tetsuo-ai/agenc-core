import {
  DEFAULT_OUTPUT_STYLE_NAME,
  clearAllOutputStylesCache,
  getAllOutputStyles,
  type OutputStyleConfig,
} from "../constants/outputStyles.js";
import {
  getInitialSettings,
  updateSettingsForSource,
} from "../utils/settings/settings.js";
import {
  openOutputStyleMenu,
  type OutputStyleMenuRow,
  type OutputStyleMenuSnapshot,
} from "./output-style-menu.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type StyleMap = { readonly [styleName: string]: OutputStyleConfig | null };

function readAppStateOutputStyle(ctx: SlashCommandContext): string | undefined {
  const state = ctx.appState?.getAppState?.();
  if (typeof state !== "object" || state === null) return undefined;
  const settings = (state as { readonly settings?: unknown }).settings;
  if (typeof settings !== "object" || settings === null) return undefined;
  const outputStyle = (settings as { readonly outputStyle?: unknown }).outputStyle;
  return typeof outputStyle === "string" && outputStyle.trim().length > 0
    ? outputStyle.trim()
    : undefined;
}

function configuredOutputStyle(ctx: SlashCommandContext): string {
  return (
    readAppStateOutputStyle(ctx) ??
    getInitialSettings().outputStyle?.trim() ??
    DEFAULT_OUTPUT_STYLE_NAME
  );
}

function forcedPluginStyle(styles: StyleMap): OutputStyleConfig | undefined {
  return Object.values(styles).find(
    (style): style is OutputStyleConfig =>
      style !== null &&
      style.source === "plugin" &&
      style.forceForPlugin === true,
  );
}

function effectiveOutputStyle(
  styles: StyleMap,
  configured: string,
): { readonly name: string; readonly forcedByPlugin: boolean } {
  const forced = forcedPluginStyle(styles);
  if (forced !== undefined) {
    return { name: forced.name, forcedByPlugin: true };
  }
  if (styles[configured] !== undefined) {
    return { name: configured, forcedByPlugin: false };
  }
  return { name: DEFAULT_OUTPUT_STYLE_NAME, forcedByPlugin: false };
}

function styleDescription(name: string, style: OutputStyleConfig | null): string {
  if (style === null) return "Default AgenC response style";
  return style.description || `Custom ${name} output style`;
}

function styleSource(style: OutputStyleConfig | null): string {
  return style?.source ?? "built-in";
}

function buildRows(
  styles: StyleMap,
  configured: string,
  effective: string,
): OutputStyleMenuRow[] {
  return Object.entries(styles)
    .sort(([left], [right]) => {
      if (left === DEFAULT_OUTPUT_STYLE_NAME) return -1;
      if (right === DEFAULT_OUTPUT_STYLE_NAME) return 1;
      return left.localeCompare(right);
    })
    .map(([name, style]) => ({
      name,
      description: styleDescription(name, style),
      source: styleSource(style),
      status:
        name === effective
          ? "effective"
          : name === configured
            ? "configured"
            : "available",
    }));
}

export async function readOutputStyleMenuSnapshot(
  ctx: SlashCommandContext,
): Promise<OutputStyleMenuSnapshot> {
  const styles = await getAllOutputStyles(ctx.cwd);
  const configured = configuredOutputStyle(ctx);
  const effective = effectiveOutputStyle(styles, configured);
  const rows = buildRows(styles, configured, effective.name);
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.name === effective.name),
  );
  return {
    configuredStyle: configured,
    effectiveStyle: effective.name,
    forcedByPlugin: effective.forcedByPlugin,
    rows,
    activeIndex,
  };
}

export function formatOutputStyleSnapshot(
  snapshot: OutputStyleMenuSnapshot,
): string {
  const lines = [
    "Output styles:",
    `Current: ${snapshot.effectiveStyle}`,
  ];
  if (snapshot.configuredStyle !== snapshot.effectiveStyle) {
    lines.push(`Configured: ${snapshot.configuredStyle}`);
  }
  if (snapshot.forcedByPlugin) {
    lines.push("A plugin is forcing the effective style.");
  }
  lines.push("");
  for (const row of snapshot.rows) {
    const marker = row.status === "effective"
      ? "*"
      : row.status === "configured"
        ? "+"
        : "-";
    lines.push(
      `  ${marker} ${row.name} (${row.source}) - ${row.description}`,
    );
  }
  lines.push(
    "",
    "Run /output-style <name> to switch, or /output-style:new <name> to author a project style.",
  );
  return lines.join("\n");
}

function resolveStyleName(
  targetRaw: string,
  styles: StyleMap,
): { readonly name?: string; readonly error?: string } {
  const target = targetRaw.trim();
  if (target.length === 0) {
    return { error: "Usage: /output-style <name>" };
  }
  if (styles[target] !== undefined) return { name: target };
  const lower = target.toLowerCase();
  const matches = Object.keys(styles).filter(
    (name) => name.toLowerCase() === lower,
  );
  if (matches.length === 1) return { name: matches[0] };
  if (matches.length > 1) {
    return {
      error: `Output style "${target}" is ambiguous: ${matches.join(", ")}`,
    };
  }
  return {
    error: `Unknown output style "${target}". Run /output-style to list available styles.`,
  };
}

function updateOutputStyleChrome(
  ctx: SlashCommandContext,
  effectiveStyle: string,
): void {
  ctx.appState?.setAppState?.((prev: unknown): unknown => {
    if (typeof prev !== "object" || prev === null) return prev;
    const previousSettings = (prev as { readonly settings?: unknown }).settings;
    const settings =
      typeof previousSettings === "object" && previousSettings !== null
        ? previousSettings
        : {};
    return {
      ...prev,
      settings: {
        ...settings,
        outputStyle: effectiveStyle,
      },
    };
  });
}

export async function applyOutputStyleSwitch(
  ctx: SlashCommandContext,
  targetRaw: string,
): Promise<string> {
  const styles = await getAllOutputStyles(ctx.cwd);
  const resolved = resolveStyleName(targetRaw, styles);
  if (resolved.error !== undefined) return resolved.error;
  const target = resolved.name!;

  const result = updateSettingsForSource("localSettings", {
    outputStyle: target,
  });
  if (result.error !== null) {
    return `Output style switch failed: ${result.error.message}`;
  }

  clearAllOutputStylesCache();
  const nextStyles = await getAllOutputStyles(ctx.cwd);
  const effective = effectiveOutputStyle(nextStyles, target);
  updateOutputStyleChrome(ctx, effective.name);
  if (effective.name !== target) {
    return (
      `Output style configured as "${target}", but "${effective.name}" ` +
      "is still effective because a higher-priority setting or plugin overrides it."
    );
  }
  return `Output style switched to "${target}".`;
}

function parseOutputStyleNewArgs(argsRaw: string): {
  readonly fileName?: string;
  readonly styleName?: string;
  readonly description?: string;
  readonly error?: string;
} {
  const args = argsRaw.trim();
  if (args.length === 0 || args === "--help" || args === "-h") {
    return { error: "Usage: /output-style:new <name> [description]" };
  }
  const [name = "", ...descriptionParts] = args.split(/\s+/);
  const fileName = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/")
  ) {
    return { error: `Invalid output style name: ${name}` };
  }
  return {
    fileName,
    styleName: name,
    description: descriptionParts.join(" ").trim() || undefined,
  };
}

function outputStyleNewPrompt(params: {
  readonly fileName: string;
  readonly styleName: string;
  readonly description?: string;
}): string {
  const description =
    params.description ?? `${params.styleName} response style`;
  return [
    `Create a new project output style at .agenc/output-styles/${params.fileName}.md.`,
    "",
    "Use this exact frontmatter shape:",
    "---",
    `name: ${params.styleName}`,
    `description: ${description}`,
    "keep-coding-instructions: true",
    "---",
    "",
    "Then write the prompt body that defines how the assistant should respond when this output style is active. Keep the style project-specific, concise, and compatible with normal coding-agent behavior. Create parent directories if needed. Do not change the active output style unless asked.",
  ].join("\n");
}

export const outputStyleCommand: SlashCommand = {
  name: "output-style",
  aliases: ["style"],
  description: "Switch the active output style",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  userInvocable: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = ctx.argsRaw.trim();
      if (target.length === 0 || target === "list") {
        const snapshot = await readOutputStyleMenuSnapshot(ctx);
        if (
          openOutputStyleMenu(ctx, snapshot, async (name) => {
            const message = await applyOutputStyleSwitch(ctx, name);
            return {
              message,
              shouldClose: message.startsWith("Output style switched"),
            };
          })
        ) {
          return { kind: "skip" };
        }
        return { kind: "text", text: formatOutputStyleSnapshot(snapshot) };
      }
      if (target === "new" || target.startsWith("new ")) {
        const args = target === "new" ? "" : target.slice("new".length).trim();
        const parsed = parseOutputStyleNewArgs(args);
        if (parsed.error !== undefined) {
          return { kind: "text", text: parsed.error };
        }
        return {
          kind: "prompt",
          content: outputStyleNewPrompt({
            fileName: parsed.fileName!,
            styleName: parsed.styleName!,
            ...(parsed.description !== undefined
              ? { description: parsed.description }
              : {}),
          }),
        };
      }
      const message = await applyOutputStyleSwitch(ctx, target);
      return { kind: "text", text: message };
    }),
};

export const outputStyleNewCommand: SlashCommand = {
  name: "output-style:new",
  description: "Ask the agent to author a new project output style",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  userInvocable: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parsed = parseOutputStyleNewArgs(ctx.argsRaw);
      if (parsed.error !== undefined) {
        return { kind: "text", text: parsed.error };
      }
      return {
        kind: "prompt",
        content: outputStyleNewPrompt({
          fileName: parsed.fileName!,
          styleName: parsed.styleName!,
          ...(parsed.description !== undefined
            ? { description: parsed.description }
            : {}),
        }),
      };
    }),
};
