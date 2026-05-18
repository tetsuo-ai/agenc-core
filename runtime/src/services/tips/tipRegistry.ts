/**
 * Source-aligned with `src/services/tips/tipRegistry.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC expresses external signals through `TipContext` instead of
 *     importing TUI, marketplace, auth, model, and platform singletons.
 *   - Tips for optional desktop/web/mobile/plugin surfaces are present but
 *     disabled unless the caller opts into those feature flags.
 */

import { getSessionsSinceLastShown } from "./tipHistory.js";
import type {
  Tip,
  TipContentContext,
  TipContext,
  TipRuntimeState,
  TipSettings,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function accent(context: TipContentContext | undefined, text: string): string {
  return context?.accent ? context.accent(text) : text;
}

function state(context: TipContext | undefined): TipRuntimeState {
  return context?.state ?? {};
}

function settings(context: TipContext | undefined): TipSettings {
  return context?.settings ?? {};
}

function numStartups(context: TipContext | undefined): number {
  return state(context).numStartups ?? context?.history?.sessionCount ?? 1;
}

function daysSince(timestamp: number | undefined, nowMs: number): number {
  return timestamp ? (nowMs - timestamp) / DAY_MS : Number.POSITIVE_INFINITY;
}

function isMac(context: TipContext | undefined): boolean {
  const platform = context?.env?.platform ?? process.platform;
  return platform === "darwin" || platform === "macos";
}

function isWindows(context: TipContext | undefined): boolean {
  const platform = context?.env?.platform ?? process.platform;
  return platform === "win32" || platform === "windows";
}

function terminal(context: TipContext | undefined): string {
  return context?.env?.terminal ?? process.env.TERM_PROGRAM ?? "";
}

function hasCliSignal(
  context: TipContext | undefined,
  commands: readonly string[],
): boolean {
  const tools = context?.bashTools;
  return Boolean(tools && commands.some((command) => tools.has(command)));
}

function readFilePaths(context: TipContext | undefined): readonly string[] {
  const readState = context?.readFileState;
  if (!readState) return [];
  if (readState instanceof Map) return [...readState.keys()];
  return Object.keys(readState);
}

function hasReadFileSignal(
  context: TipContext | undefined,
  pattern: RegExp,
): boolean {
  return readFilePaths(context).some((filePath) => pattern.test(filePath));
}

function marketplaceTipRelevant(
  context: TipContext | undefined,
  signals: { readonly filePath?: RegExp; readonly cli?: readonly string[] },
): boolean {
  if (context?.features?.marketplace !== true) return false;
  return Boolean(
    (signals.filePath && hasReadFileSignal(context, signals.filePath)) ||
      (signals.cli && hasCliSignal(context, signals.cli)),
  );
}

function customTipsFromSettings(settings: TipSettings): Tip[] {
  const override = settings.spinnerTipsOverride;
  if (!override?.tips?.length) return [];
  return override.tips.map((content, index) => ({
    id: `custom-tip-${index}`,
    content: async () => content,
    cooldownSessions: 0,
    isRelevant: async () => true,
  }));
}

const builtInTips: readonly Tip[] = [
  {
    id: "new-user-warmup",
    content: async () =>
      "Start with small features or bug fixes, ask AgenC to propose a plan, and verify its edits",
    cooldownSessions: 3,
    isRelevant: async (context) => numStartups(context) < 10,
  },
  {
    id: "plan-mode-for-complex-tasks",
    content: async () =>
      "Use Plan Mode to prepare for a complex request before making changes. Press Shift+Tab twice to enable.",
    cooldownSessions: 5,
    isRelevant: async (context) =>
      daysSince(state(context).lastPlanModeUse, context?.nowMs ?? Date.now()) > 7,
  },
  {
    id: "default-permission-mode-config",
    content: async () =>
      "Use /config to change your default permission mode, including Plan Mode",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      Boolean(state(context).lastPlanModeUse) &&
      !settings(context).defaultPermissionMode &&
      !state(context).hasDefaultPermissionMode,
  },
  {
    id: "git-worktrees",
    content: async () =>
      "Use git worktrees to run multiple AgenC sessions in parallel.",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      (state(context).worktreeCount ?? 0) <= 1 && numStartups(context) > 50,
  },
  {
    id: "color-when-running-multiple-agenc",
    content: async () =>
      "Running multiple AgenC sessions? Keep each one in a distinct worktree or terminal tab.",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      (state(context).concurrentSessionCount ?? 0) >= 2,
  },
  {
    id: "terminal-setup",
    content: async (context) =>
      terminal(context) === "Apple_Terminal"
        ? "Run /terminal-setup to enable convenient terminal integration like Option+Enter for new lines"
        : "Run /terminal-setup to enable convenient terminal integration like Shift+Enter for new lines",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      context?.env?.supportsTerminalSetup === true &&
      (terminal(context) === "Apple_Terminal"
        ? !state(context).optionAsMetaKeyInstalled
        : !state(context).shiftEnterKeyBindingInstalled),
  },
  {
    id: "shift-enter",
    content: async (context) =>
      terminal(context) === "Apple_Terminal"
        ? "Press Option+Enter to send a multi-line message"
        : "Press Shift+Enter to send a multi-line message",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      Boolean(
        (terminal(context) === "Apple_Terminal"
          ? state(context).optionAsMetaKeyInstalled
          : state(context).shiftEnterKeyBindingInstalled) &&
          numStartups(context) > 3,
      ),
  },
  {
    id: "shift-enter-setup",
    content: async (context) =>
      terminal(context) === "Apple_Terminal"
        ? "Run /terminal-setup to enable Option+Enter for new lines"
        : "Run /terminal-setup to enable Shift+Enter for new lines",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      context?.env?.supportsTerminalSetup === true &&
      !(terminal(context) === "Apple_Terminal"
        ? state(context).optionAsMetaKeyInstalled
        : state(context).shiftEnterKeyBindingInstalled),
  },
  {
    id: "memory-command",
    content: async () => "Use /memory to view and manage AgenC memory",
    cooldownSessions: 15,
    isRelevant: async (context) => (state(context).memoryUsageCount ?? 0) <= 0,
  },
  {
    id: "theme-command",
    content: async () => "Use /config to change the color theme",
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: "colorterm-truecolor",
    content: async () =>
      "Try setting COLORTERM=truecolor for richer terminal colors",
    cooldownSessions: 30,
    isRelevant: async (context) =>
      !context?.env?.colorterm && (context?.env?.colorLevel ?? 0) < 3,
  },
  {
    id: "powershell-tool-env",
    content: async () =>
      "Set AGENC_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool preview",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      isWindows(context) && context?.env?.powershellToolEnabled !== true,
  },
  {
    id: "status-line",
    content: async () =>
      "Use /statusline to set up a custom status line beneath the input box",
    cooldownSessions: 25,
    isRelevant: async (context) =>
      settings(context).spinnerTipsEnabled !== false &&
      state(context).statusLineConfigured !== true,
  },
  {
    id: "prompt-queue",
    content: async () =>
      "Hit Enter to queue up additional messages while AgenC is working.",
    cooldownSessions: 5,
    isRelevant: async (context) => (state(context).promptQueueUseCount ?? 0) <= 3,
  },
  {
    id: "enter-to-steer-in-realtime",
    content: async () =>
      "Send messages to AgenC while it works to steer AgenC in real time",
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: "todo-list",
    content: async () =>
      "Ask AgenC to create a todo list for complex tasks so progress stays visible",
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: "vscode-command-install",
    content: async (context) =>
      `Open the Command Palette and run "Shell Command: Install '${terminal(
        context,
      ) || "code"}' command in PATH" to enable IDE integration`,
    cooldownSessions: 0,
    isRelevant: async (context) =>
      context?.env?.supportsVsCodeShellCommand === true && isMac(context),
  },
  {
    id: "ide-upsell-external-terminal",
    content: async () => "Connect AgenC to your IDE with /ide",
    cooldownSessions: 4,
    isRelevant: async (context) =>
      context?.env?.externalTerminalHasRunningIde === true,
  },
  {
    id: "install-github-app",
    content: async () =>
      "Run /install-github-app to enable GitHub issue and PR tagging from AgenC",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      !state(context).githubActionSetupCount && context?.features?.web === true,
  },
  {
    id: "install-slack-app",
    content: async () => "Run /install-slack-app to use AgenC in Slack",
    cooldownSessions: 10,
    isRelevant: async (context) =>
      !state(context).slackAppInstallCount && context?.features?.web === true,
  },
  {
    id: "permissions",
    content: async () =>
      "Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools",
    cooldownSessions: 10,
    isRelevant: async (context) => numStartups(context) > 10,
  },
  {
    id: "drag-and-drop-images",
    content: async () =>
      "Did you know you can drag and drop image files into your terminal?",
    cooldownSessions: 10,
    isRelevant: async (context) => context?.env?.isSsh !== true,
  },
  {
    id: "paste-images-mac",
    content: async () => "Paste images into AgenC using Control+V, not Cmd+V",
    cooldownSessions: 10,
    isRelevant: async (context) => isMac(context),
  },
  {
    id: "double-esc",
    content: async () =>
      "Double-tap Esc to rewind the conversation to a previous point in time",
    cooldownSessions: 10,
    isRelevant: async (context) => state(context).fileHistoryEnabled !== true,
  },
  {
    id: "double-esc-code-restore",
    content: async () =>
      "Double-tap Esc to rewind code and conversation to a previous point in time",
    cooldownSessions: 10,
    isRelevant: async (context) => state(context).fileHistoryEnabled === true,
  },
  {
    id: "continue",
    content: async () =>
      "Run agenc --continue or agenc --resume to resume a conversation",
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: "rename-conversation",
    content: async () =>
      "Name your conversations with /rename to find them easily in /resume later",
    cooldownSessions: 15,
    isRelevant: async (context) =>
      state(context).customTitleEnabled === true && numStartups(context) > 10,
  },
  {
    id: "custom-commands",
    content: async () =>
      "Create skills by adding markdown files to .agenc/skills in your project or home directory",
    cooldownSessions: 15,
    isRelevant: async (context) => numStartups(context) > 10,
  },
  {
    id: "shift-tab",
    content: async () =>
      "Hit Shift+Tab to cycle between default mode, auto-accept edit mode, and plan mode",
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: "image-paste",
    content: async () => "Use Ctrl+V to paste images from your clipboard",
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: "custom-agents",
    content: async () =>
      "Use /agents to optimize specific tasks, such as architecture, coding, or review",
    cooldownSessions: 15,
    isRelevant: async (context) => numStartups(context) > 5,
  },
  {
    id: "agent-flag",
    content: async () =>
      "Use --agent <agent_name> to start a conversation with a specific agent",
    cooldownSessions: 15,
    isRelevant: async (context) => numStartups(context) > 5,
  },
  {
    id: "desktop-app",
    content: async () => "Run AgenC locally or remotely with /desktop",
    cooldownSessions: 15,
    isRelevant: async (context) =>
      context?.features?.desktop === true && !isWindows(context),
  },
  {
    id: "desktop-shortcut",
    content: async (context) =>
      `Continue your session with ${accent(context, "/desktop")}`,
    cooldownSessions: 15,
    isRelevant: async (context) => context?.features?.desktop === true,
  },
  {
    id: "web-app",
    content: async () =>
      "Run tasks in the cloud while you keep coding locally with /web",
    cooldownSessions: 15,
    isRelevant: async (context) => context?.features?.web === true,
  },
  {
    id: "mobile-app",
    content: async () => "/mobile to continue from your phone",
    cooldownSessions: 15,
    isRelevant: async (context) => context?.features?.mobile === true,
  },
  {
    id: "opus-plan-mode-reminder",
    content: async () =>
      "Your default model setting is Opus Plan Mode. Press Shift+Tab twice to activate Plan Mode and plan with Opus.",
    cooldownSessions: 2,
    isRelevant: async (context) =>
      context?.model?.userSpecifiedSetting === "opusplan" &&
      daysSince(state(context).lastPlanModeUse, context?.nowMs ?? Date.now()) > 3,
  },
  {
    id: "frontend-design-plugin",
    content: async (context) =>
      `Working with HTML/CSS? Install the frontend-design plugin:\n${accent(
        context,
        "/plugin install frontend-design",
      )}`,
    cooldownSessions: 3,
    isRelevant: async (context) =>
      marketplaceTipRelevant(context, { filePath: /\.(html|css|htm)$/i }),
  },
  {
    id: "vercel-plugin",
    content: async (context) =>
      `Working with Vercel? Install the vercel plugin:\n${accent(
        context,
        "/plugin install vercel",
      )}`,
    cooldownSessions: 3,
    isRelevant: async (context) =>
      marketplaceTipRelevant(context, {
        filePath: /(?:^|[/\\])vercel\.json$/i,
        cli: ["vercel"],
      }),
  },
  {
    id: "effort-high-nudge",
    content: async (context) =>
      `Working on something tricky? ${accent(context, "/effort high")} gives better first answers`,
    cooldownSessions: 3,
    isRelevant: async (context) =>
      context?.features?.effortNudge === true &&
      context?.model?.supportsEffort === true &&
      settings(context).effortLevel === undefined,
  },
  {
    id: "subagent-fanout-nudge",
    content: async (context) =>
      `For big tasks, tell AgenC to ${accent(
        context,
        "use subagents",
      )}. They work in parallel and keep the main thread clean.`,
    cooldownSessions: 3,
    isRelevant: async (context) => context?.features?.subagentsNudge === true,
  },
  {
    id: "loop-command-nudge",
    content: async (context) =>
      `${accent(
        context,
        "/loop",
      )} runs any prompt on a recurring schedule. Great for monitoring deploys or polling status.`,
    cooldownSessions: 3,
    isRelevant: async (context) => context?.features?.scheduledPrompts === true,
  },
  {
    id: "guest-passes",
    content: async (context) =>
      `You have free guest passes to share · ${accent(context, "/passes")}`,
    cooldownSessions: 3,
    isRelevant: async (context) =>
      context?.features?.passes === true && !state(context).hasVisitedPasses,
  },
  {
    id: "overage-credit",
    content: async (context) =>
      `${accent(context, "Extra usage is available")} · ${accent(
        context,
        "/extra-usage",
      )}`,
    cooldownSessions: 3,
    isRelevant: async (context) => context?.features?.overageCredit === true,
  },
  {
    id: "feedback-command",
    content: async () => "Use /feedback to help us improve AgenC",
    cooldownSessions: 15,
    isRelevant: async (context) => numStartups(context) > 5,
  },
];

export function getBuiltInTips(): readonly Tip[] {
  return builtInTips;
}

export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const currentSettings = settings(context);
  const customTips = customTipsFromSettings(currentSettings);

  if (
    currentSettings.spinnerTipsOverride?.excludeDefault === true &&
    customTips.length > 0
  ) {
    return customTips;
  }

  const relevance = await Promise.all(
    builtInTips.map((tip) => tip.isRelevant(context)),
  );
  const filtered = builtInTips
    .filter((_, index) => relevance[index] === true)
    .filter(
      (tip) =>
        getSessionsSinceLastShown(tip.id, context?.history) >=
        tip.cooldownSessions,
    );

  return [...filtered, ...customTips];
}
