import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { resolve as resolvePath } from "node:path";
import {
  applyManagedGatewayPatch,
  buildManagedGatewayPatch,
  getCanonicalDefaultConfigPath,
  loadCliConfigContract,
} from "../cli/config-contract.js";
import { executeOnboardCommand, type PreparedOnboardRun } from "../cli/onboard.js";
import { generateDefaultConfig } from "../cli/wizard.js";
import type { OnboardOptions } from "../cli/types.js";
import type { GatewayConfig } from "../gateway/types.js";
import { createDefaultOnboardingAnswers, buildOnboardingProfile } from "./profile.js";
import type { OnboardingAnswers } from "./types.js";
import { validateXaiApiKey } from "./xai-validation.js";

const GO_BACK = Symbol("onboarding.go-back");
const CANCEL = Symbol("onboarding.cancel");

const COLOR = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  ink: "\x1b[38;5;225m",
  softInk: "\x1b[38;5;189m",
  fog: "\x1b[38;5;97m",
  teal: "\x1b[38;5;111m",
  green: "\x1b[38;5;50m",
  yellow: "\x1b[38;5;221m",
  magenta: "\x1b[38;5;177m",
  red: "\x1b[38;5;203m",
  border: "\x1b[38;5;99m",
});

type PromptResult<T> = T | typeof GO_BACK | typeof CANCEL;

interface KeypressKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

interface TerminalInput {
  readonly isTTY?: boolean;
  readonly on: (event: string, listener: (...args: any[]) => void) => any;
  readonly off: (event: string, listener: (...args: any[]) => void) => any;
  readonly resume: () => void;
  readonly setRawMode?: (enabled: boolean) => void;
}

interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly write: (chunk: string) => any;
  readonly on: (event: string, listener: (...args: any[]) => void) => any;
  readonly off: (event: string, listener: (...args: any[]) => void) => any;
}

interface OnboardingTuiDeps {
  readonly stdin: TerminalInput;
  readonly stdout: TerminalOutput;
  readonly validateXaiApiKey: typeof validateXaiApiKey;
}

type FrameTone = "teal" | "green" | "yellow" | "red";

interface FrameRenderParams {
  readonly columns?: number;
  readonly step: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly body: readonly string[];
  readonly footer?: string;
  readonly statusTone?: FrameTone;
}

const DEFAULT_TUI_DEPS: OnboardingTuiDeps = {
  stdin: process.stdin,
  stdout: process.stdout,
  validateXaiApiKey,
};

function canUseInteractiveOnboarding(
  flags: Record<string, string | number | boolean>,
  deps: Pick<OnboardingTuiDeps, "stdin" | "stdout">,
): boolean {
  if (flags["non-interactive"] === true) return false;
  if (flags.help === true || flags.h === true) return false;
  if (flags.output === "json" || flags.output === "jsonl") return false;
  if (flags["output-format"] === "json" || flags["output-format"] === "jsonl") {
    return false;
  }
  return deps.stdin.isTTY === true && deps.stdout.isTTY === true;
}

function wrapText(text: string, width: number): string[] {
  const normalized = text.trim();
  if (normalized.length === 0) return [""];
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
    }
    current = word;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function centerText(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  const left = Math.floor((width - value.length) / 2);
  return " ".repeat(left) + value + " ".repeat(width - value.length - left);
}

function buildProgressBar(current: number, total: number, width = 18): string {
  const safeTotal = Math.max(total, 1);
  const filled = Math.max(0, Math.min(width, Math.round((current / safeTotal) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${current}/${total}`;
}

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return "*".repeat(Math.max(trimmed.length, 4));
  }
  return `${"*".repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
}

function humanizeBoolean(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

function resolveFrameInnerWidth(columns?: number): number {
  const safeColumns = columns ?? 100;
  return Math.min(88, Math.max(24, safeColumns));
}

export function buildFrameText(params: FrameRenderParams): string {
  const lineWidth = resolveFrameInnerWidth(params.columns);
  const header = centerText("AgenC Onboard", lineWidth);
  const progress = centerText(
    buildProgressBar(params.step, params.totalSteps),
    lineWidth,
  );
  const subtitleLines = params.subtitle
    ? wrapText(params.subtitle, lineWidth)
    : [];
  const bodyLines = params.body.flatMap((line) => wrapText(line, lineWidth));
  const footerLine = params.footer
    ? padRight(params.footer, lineWidth)
    : padRight("Enter continue  Esc back  Ctrl+C cancel", lineWidth);
  const tone = params.statusTone ? COLOR[params.statusTone] : COLOR.ink;
  const lines = [
    `${COLOR.magenta}${COLOR.bold}${header}${COLOR.reset}`,
    `${COLOR.fog}${progress}${COLOR.reset}`,
    "",
    ...subtitleLines.map((line) => `${COLOR.softInk}${padRight(line, lineWidth)}${COLOR.reset}`),
    ...(subtitleLines.length > 0 ? [""] : []),
    `${COLOR.ink}${COLOR.bold}${padRight(params.title, lineWidth)}${COLOR.reset}`,
    "",
    ...bodyLines.map((line) => `${tone}${padRight(line, lineWidth)}${COLOR.reset}`),
    "",
    `${COLOR.fog}${footerLine}${COLOR.reset}`,
  ];

  return lines.join("\n");
}

function renderFrame(params: FrameRenderParams & { stdout: TerminalOutput }): void {
  params.stdout.write("\x1b[2J\x1b[H");
  params.stdout.write(
    buildFrameText({
      columns: params.stdout.columns,
      step: params.step,
      totalSteps: params.totalSteps,
      title: params.title,
      subtitle: params.subtitle,
      body: params.body,
      footer: params.footer,
      statusTone: params.statusTone,
    }),
  );
}

class OnboardingTerminalSession {
  private readonly stdin: TerminalInput;
  private readonly stdout: TerminalOutput;
  private keypressHandler: ((input: string, key: KeypressKey) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private renderCurrent: (() => void) | null = null;
  private entered = false;

  constructor(stdin: TerminalInput, stdout: TerminalOutput) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  enter(): void {
    if (this.entered) return;
    emitKeypressEvents(this.stdin as any);
    this.stdin.resume();
    let rawModeEnabled = false;
    let altScreenEnabled = false;
    try {
      this.stdin.setRawMode?.(true);
      rawModeEnabled = true;
      this.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
      altScreenEnabled = true;
      this.resizeHandler = () => {
        this.renderCurrent?.();
      };
      this.stdout.on("resize", this.resizeHandler);
      this.entered = true;
    } catch (error) {
      if (this.resizeHandler) {
        this.stdout.off("resize", this.resizeHandler);
        this.resizeHandler = null;
      }
      if (altScreenEnabled) {
        this.stdout.write("\x1b[?25h\x1b[?1049l");
      }
      if (rawModeEnabled) {
        this.stdin.setRawMode?.(false);
      }
      this.renderCurrent = null;
      throw error;
    }
  }

  dispose(): void {
    if (!this.entered) return;
    if (this.keypressHandler) {
      this.stdin.off("keypress", this.keypressHandler);
      this.keypressHandler = null;
    }
    if (this.resizeHandler) {
      this.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.stdin.setRawMode?.(false);
    this.stdout.write("\x1b[?25h\x1b[?1049l");
    this.entered = false;
    this.renderCurrent = null;
  }

  private bind(
    render: () => void,
    handler: (input: string, key: KeypressKey) => void,
  ): void {
    if (this.keypressHandler) {
      this.stdin.off("keypress", this.keypressHandler);
    }
    this.renderCurrent = render;
    this.keypressHandler = handler;
    this.stdin.on("keypress", this.keypressHandler);
    render();
  }

  renderStatic(params: {
    step: number;
    totalSteps: number;
    title: string;
    subtitle?: string;
    body: readonly string[];
    footer?: string;
    statusTone?: FrameTone;
  }): void {
    if (this.keypressHandler) {
      this.stdin.off("keypress", this.keypressHandler);
      this.keypressHandler = null;
    }
    this.renderCurrent = () =>
      renderFrame({
        stdout: this.stdout,
        step: params.step,
        totalSteps: params.totalSteps,
        title: params.title,
        subtitle: params.subtitle,
        body: params.body,
        footer: params.footer,
        statusTone: params.statusTone,
      });
    this.renderCurrent();
  }

  async showIntro(totalSteps: number): Promise<PromptResult<void>> {
    return new Promise((resolve) => {
      const render = () =>
        renderFrame({
          stdout: this.stdout,
          step: 1,
          totalSteps,
          title: "Welcome",
          subtitle:
            "This wizard sets up your local xAI-powered AgenC agent, generates the core workspace files, and gives you a clean first-run starting point.",
          body: [
            "You will add an xAI API key, tune the agent identity and soul, confirm wallet/RPC basics, and review everything before it is written.",
            "Get your xAI API key from: https://console.x.ai/",
          ],
          footer: "Enter begin  Ctrl+C cancel",
        });

      this.bind(render, (_input, key) => {
        if (key.ctrl && key.name === "c") {
          resolve(CANCEL);
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          resolve(undefined);
        }
      });
    });
  }

  async promptText(params: {
    step: number;
    totalSteps: number;
    title: string;
    subtitle?: string;
    hint?: string;
    value?: string;
    placeholder?: string;
    masked?: boolean;
    allowEmpty?: boolean;
    allowBack?: boolean;
    error?: string;
  }): Promise<PromptResult<string>> {
    return new Promise((resolve) => {
      let value = params.value ?? "";

      const render = () => {
        const shownValue =
          value.length > 0
            ? params.masked
              ? maskSecret(value)
              : value
            : params.placeholder ?? "";
        renderFrame({
          stdout: this.stdout,
          step: params.step,
          totalSteps: params.totalSteps,
          title: params.title,
          subtitle: params.subtitle,
          body: [
            ...(params.hint ? [params.hint] : []),
            "",
            `> ${shownValue}`,
            ...(params.error ? ["", `Warning: ${params.error}`] : []),
          ],
          footer: params.allowBack
            ? "Type and press Enter  Esc back  Ctrl+C cancel"
            : "Type and press Enter  Ctrl+C cancel",
          statusTone: params.error ? "yellow" : "teal",
        });
      };

      this.bind(render, (input, key) => {
        if (key.ctrl && key.name === "c") {
          resolve(CANCEL);
          return;
        }
        if (params.allowBack && key.name === "escape") {
          resolve(GO_BACK);
          return;
        }
        if (key.name === "backspace") {
          value = value.slice(0, -1);
          render();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          if (!params.allowEmpty && value.trim().length === 0) {
            renderFrame({
              stdout: this.stdout,
              step: params.step,
              totalSteps: params.totalSteps,
              title: params.title,
              subtitle: params.subtitle,
              body: [
                ...(params.hint ? [params.hint] : []),
                "",
                `> ${params.masked ? maskSecret(value) : value}`,
                "",
                "This field cannot be empty.",
              ],
              footer: params.allowBack
                ? "Type and press Enter  Esc back  Ctrl+C cancel"
                : "Type and press Enter  Ctrl+C cancel",
              statusTone: "red",
            });
            return;
          }
          resolve(value.trim());
          return;
        }
        if (typeof input === "string" && input >= " " && input !== "\u007f") {
          value += input;
          render();
        }
      });
    });
  }

  async promptSelect<T extends string>(params: {
    step: number;
    totalSteps: number;
    title: string;
    subtitle?: string;
    options: readonly { value: T; label: string; detail?: string }[];
    initialValue?: T;
    allowBack?: boolean;
  }): Promise<PromptResult<T>> {
    return new Promise((resolve) => {
      let index = Math.max(
        0,
        params.options.findIndex((option) => option.value === params.initialValue),
      );

      const render = () => {
        const body = params.options.flatMap((option, optionIndex) => {
          const selected = optionIndex === index;
          const prefix = selected ? ">" : " ";
          return [
            `${prefix} ${option.label}`,
            ...(option.detail ? [`  ${option.detail}`] : []),
            "",
          ];
        });
        renderFrame({
          stdout: this.stdout,
          step: params.step,
          totalSteps: params.totalSteps,
          title: params.title,
          subtitle: params.subtitle,
          body,
          footer: params.allowBack
            ? "Arrow keys move  Enter select  Esc back  Ctrl+C cancel"
            : "Arrow keys move  Enter select  Ctrl+C cancel",
        });
      };

      this.bind(render, (_input, key) => {
        if (key.ctrl && key.name === "c") {
          resolve(CANCEL);
          return;
        }
        if (params.allowBack && key.name === "escape") {
          resolve(GO_BACK);
          return;
        }
        if (key.name === "up" || key.name === "k") {
          index = (index - 1 + params.options.length) % params.options.length;
          render();
          return;
        }
        if (key.name === "down" || key.name === "j") {
          index = (index + 1) % params.options.length;
          render();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          resolve(params.options[index]!.value);
        }
      });
    });
  }

  async promptReview(
    step: number,
    totalSteps: number,
    lines: readonly string[],
  ): Promise<PromptResult<"confirm">> {
    return new Promise((resolve) => {
      const render = () =>
        renderFrame({
          stdout: this.stdout,
          step,
          totalSteps,
          title: "Review",
          subtitle: "Check the first-run profile before it is written to disk.",
          body: lines,
          footer: "Enter write setup  Esc back  Ctrl+C cancel",
        });

      this.bind(render, (_input, key) => {
        if (key.ctrl && key.name === "c") {
          resolve(CANCEL);
          return;
        }
        if (key.name === "escape") {
          resolve(GO_BACK);
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          resolve("confirm");
        }
      });
    });
  }

  async showMessage(params: {
    step: number;
    totalSteps: number;
    title: string;
    subtitle?: string;
    body: readonly string[];
    footer?: string;
    statusTone?: FrameTone;
  }): Promise<PromptResult<void>> {
    return new Promise((resolve) => {
      const render = () =>
        renderFrame({
          stdout: this.stdout,
          step: params.step,
          totalSteps: params.totalSteps,
          title: params.title,
          subtitle: params.subtitle,
          body: params.body,
          footer: params.footer ?? "Enter continue  Ctrl+C cancel",
          statusTone: params.statusTone,
        });
      this.bind(render, (_input, key) => {
        if (key.ctrl && key.name === "c") {
          resolve(CANCEL);
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          resolve(undefined);
        }
      });
    });
  }
}

function loadInteractiveBaseConfig(options: OnboardOptions): {
  baseConfig: GatewayConfig;
  importedLegacyConfigPath: string | null;
} {
  const configPath = resolvePath(
    options.configPath ?? getCanonicalDefaultConfigPath(),
  );
  if (existsSync(configPath)) {
    const contract = loadCliConfigContract(configPath, {
      configPathSource: options.configPathSource,
    });
    if (contract.shape === "canonical-gateway" && contract.gatewayConfig) {
      return {
        baseConfig: contract.gatewayConfig,
        importedLegacyConfigPath: null,
      };
    }
  }

  if (options.legacyImportConfigPath) {
    const imported = loadCliConfigContract(options.legacyImportConfigPath, {
      configPathSource: "env:AGENC_RUNTIME_CONFIG",
    });
    return {
      baseConfig: applyManagedGatewayPatch(
        generateDefaultConfig(),
        buildManagedGatewayPatch(imported.fileConfig),
      ),
      importedLegacyConfigPath: options.legacyImportConfigPath,
    };
  }

  return {
    baseConfig: generateDefaultConfig(),
    importedLegacyConfigPath: null,
  };
}

function buildReviewLines(answers: OnboardingAnswers): string[] {
  return [
    `xAI key: ${maskSecret(answers.apiKey)}`,
    `Model: ${answers.model}`,
    `Agent name: ${answers.agentName}`,
    `Mission: ${answers.mission}`,
    `Role: ${answers.role}`,
    `Soul traits: ${answers.soulTraits.join(", ")}`,
    `Tone: ${answers.tone}`,
    `Verbosity: ${answers.verbosity}`,
    `Autonomy: ${answers.autonomy}`,
    `Tool posture: ${answers.toolPosture}`,
    `Wallet path: ${answers.walletPath ?? "not configured"}`,
    `RPC URL: ${answers.rpcUrl}`,
    `Marketplace mode: ${humanizeBoolean(answers.marketplaceEnabled)}`,
  ];
}

function buildFinalSummaryLines(result: Awaited<ReturnType<typeof executeOnboardCommand>>): string[] {
  const checkLines = result.checks.map((check) => {
    const marker =
      check.status === "pass" ? "[ok]" : check.status === "warn" ? "[!]" : "[x]";
    return `${marker} ${check.message}`;
  });
  return [
    `Config: ${result.configPath}`,
    ...(result.workspacePath ? [`Workspace: ${result.workspacePath}`] : []),
    ...(result.backupPath ? [`Config backup: ${result.backupPath}`] : []),
    ...checkLines,
  ];
}

export async function runInteractiveOnboarding(
  options: OnboardOptions,
  deps: Partial<OnboardingTuiDeps> = {},
): Promise<0 | 1 | 2> {
  const resolvedDeps: OnboardingTuiDeps = {
    ...DEFAULT_TUI_DEPS,
    ...deps,
  };
  const session = new OnboardingTerminalSession(
    resolvedDeps.stdin,
    resolvedDeps.stdout,
  );

  const resolvedConfigPath = resolvePath(
    options.configPath ?? getCanonicalDefaultConfigPath(),
  );
  if (existsSync(resolvedConfigPath) && !options.force) {
    try {
      session.enter();
      const outcome = await session.showMessage({
        step: 1,
        totalSteps: 1,
        title: "Existing setup detected",
        subtitle:
          "AgenC already has a config at this path. The v1 onboarding flow is first-run plus explicit overwrite only.",
        body: [
          `Config path: ${resolvedConfigPath}`,
          "",
          "Rerun with --force if you want the onboarding wizard to rewrite the profile and curated workspace files.",
        ],
        statusTone: "yellow",
      });
      return outcome === CANCEL ? 1 : 1;
    } finally {
      session.dispose();
    }
  }

  const { baseConfig, importedLegacyConfigPath } = loadInteractiveBaseConfig(options);
  let answers = createDefaultOnboardingAnswers(baseConfig);
  let availableModels = [answers.model];
  const totalSteps = 17;
  let finalSummaryText: string | null = null;

  try {
    session.enter();
    let stepIndex = 0;
    while (stepIndex < totalSteps) {
      if (stepIndex === 0) {
        const result = await session.showIntro(totalSteps);
        if (result === CANCEL) return 1;
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 1) {
        const value = await session.promptText({
          step: 2,
          totalSteps,
          title: "xAI API Key",
          subtitle:
            "AgenC uses xAI as the default first-run provider. Paste the API key you generated from console.x.ai.",
          hint: "The key is stored in the AgenC config for v1 so the local runtime can use it immediately.",
          value: answers.apiKey,
          placeholder: "xai-...",
          masked: true,
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }

        session.renderStatic({
          step: 2,
          totalSteps,
          title: "Validating xAI",
          subtitle: "Checking the API key and fetching available chat models from xAI.",
          body: ["This should only take a moment."],
          footer: "Please wait...",
          statusTone: "teal",
        });

        const validation = await resolvedDeps.validateXaiApiKey({
          apiKey: value,
        });
        if (!validation.ok) {
          const retry = await session.promptText({
            step: 2,
            totalSteps,
            title: "xAI API Key",
            subtitle:
              "AgenC uses xAI as the default first-run provider. Paste the API key you generated from console.x.ai.",
            hint: "The last validation attempt failed. Fix the key and try again.",
            value,
            placeholder: "xai-...",
            masked: true,
            allowBack: true,
            error: validation.message,
          });
          if (retry === CANCEL) return 1;
          if (retry === GO_BACK) {
            stepIndex -= 1;
            continue;
          }
          answers = { ...answers, apiKey: retry };
          continue;
        }

        answers = {
          ...answers,
          apiKey: value,
          model: validation.availableModels[0] ?? answers.model,
        };
        availableModels = [...validation.availableModels];
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 2) {
        const selection = await session.promptSelect({
          step: 3,
          totalSteps,
          title: "Default Model",
          subtitle: "Pick the default xAI model for your local agent.",
          allowBack: true,
          initialValue: answers.model,
          options: availableModels.map((model) => ({
            value: model,
            label: model,
          })),
        });
        if (selection === CANCEL) return 1;
        if (selection === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, model: selection };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 3) {
        const value = await session.promptText({
          step: 4,
          totalSteps,
          title: "Agent Name",
          subtitle: "This becomes the runtime-facing agent identity and shows up in the generated workspace files.",
          value: answers.agentName,
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, agentName: value };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 4) {
        const value = await session.promptText({
          step: 5,
          totalSteps,
          title: "Mission",
          subtitle: "Describe what this agent is fundamentally supposed to do.",
          value: answers.mission,
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, mission: value };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 5) {
        const value = await session.promptText({
          step: 6,
          totalSteps,
          title: "Role",
          subtitle: "Give the agent a short operating role. Examples: General-purpose operator, Research scout, Marketplace builder.",
          value: answers.role,
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, role: value };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 6) {
        const value = await session.promptText({
          step: 7,
          totalSteps,
          title: "Always-Do Rules",
          subtitle: "Enter 2-4 non-negotiable rules as a comma-separated list.",
          value: answers.alwaysDoRules.join(", "),
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, alwaysDoRules: parseCsvList(value) };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 7) {
        const value = await session.promptText({
          step: 8,
          totalSteps,
          title: "Soul Traits",
          subtitle: "Enter personality traits as a comma-separated list. Keep it sharp and stable.",
          value: answers.soulTraits.join(", "),
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, soulTraits: parseCsvList(value) };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 8) {
        const selection = await session.promptSelect({
          step: 9,
          totalSteps,
          title: "Tone",
          subtitle: "Choose the communication tone for the generated SOUL and USER docs.",
          allowBack: true,
          initialValue: answers.tone,
          options: [
            { value: "Direct and calm", label: "Direct and calm" },
            { value: "Strategic and composed", label: "Strategic and composed" },
            { value: "Warm and clear", label: "Warm and clear" },
            { value: "High-agency operator", label: "High-agency operator" },
          ],
        });
        if (selection === CANCEL) return 1;
        if (selection === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, tone: selection };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 9) {
        const selection = await session.promptSelect({
          step: 10,
          totalSteps,
          title: "Verbosity",
          subtitle: "Set the default response density for this agent.",
          allowBack: true,
          initialValue: answers.verbosity,
          options: [
            { value: "tight", label: "Tight", detail: "Compact, high-signal responses." },
            { value: "balanced", label: "Balanced", detail: "Concise first, fuller when needed." },
            { value: "detailed", label: "Detailed", detail: "More context and reasoning by default." },
          ],
        });
        if (selection === CANCEL) return 1;
        if (selection === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, verbosity: selection };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 10) {
        const selection = await session.promptSelect({
          step: 11,
          totalSteps,
          title: "Autonomy",
          subtitle: "Choose how self-starting the agent should be before escalating for confirmation.",
          allowBack: true,
          initialValue: answers.autonomy,
          options: [
            { value: "conservative", label: "Conservative", detail: "Ask before risky or ambiguous actions." },
            { value: "balanced", label: "Balanced", detail: "Move on low-risk work, escalate when it matters." },
            { value: "aggressive", label: "Aggressive", detail: "Bias toward execution and only stop at hard boundaries." },
          ],
        });
        if (selection === CANCEL) return 1;
        if (selection === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, autonomy: selection };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 11) {
        const selection = await session.promptSelect({
          step: 12,
          totalSteps,
          title: "Tool Posture",
          subtitle: "Set the default appetite for tool use.",
          allowBack: true,
          initialValue: answers.toolPosture,
          options: [
            { value: "guarded", label: "Guarded", detail: "Use tools narrowly and explain intent first." },
            { value: "balanced", label: "Balanced", detail: "Use tools when they materially unlock progress." },
            { value: "broad", label: "Broad", detail: "Lean into tool execution when it speeds things up." },
          ],
        });
        if (selection === CANCEL) return 1;
        if (selection === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, toolPosture: selection };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 12) {
        const value = await session.promptText({
          step: 13,
          totalSteps,
          title: "Memory Seeds",
          subtitle: "Optional durable facts as a comma-separated list. Leave blank to keep the default operator memory note.",
          value: answers.memorySeeds.join(", "),
          allowBack: true,
          allowEmpty: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = {
          ...answers,
          memorySeeds: value.length > 0 ? parseCsvList(value) : [],
        };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 13) {
        const value = await session.promptText({
          step: 14,
          totalSteps,
          title: "Wallet Path",
          subtitle: "Confirm the Solana keypair path AgenC should use. Leave blank to skip local wallet setup for now.",
          value: answers.walletPath ?? "",
          allowBack: true,
          allowEmpty: true,
          placeholder: "~/.config/solana/id.json",
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, walletPath: value.length > 0 ? value : null };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 14) {
        const value = await session.promptText({
          step: 15,
          totalSteps,
          title: "RPC URL",
          subtitle: "Choose the Solana RPC endpoint for the generated config.",
          value: answers.rpcUrl,
          allowBack: true,
        });
        if (value === CANCEL) return 1;
        if (value === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = { ...answers, rpcUrl: value };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 15) {
        const marketplaceMode = await session.promptSelect({
          step: 16,
          totalSteps,
          title: "Marketplace Mode",
          subtitle: "Enable the marketplace/task posture in the generated workspace files.",
          allowBack: true,
          initialValue: answers.marketplaceEnabled ? "enabled" : "disabled",
          options: [
            { value: "enabled", label: "Enabled", detail: "Agent can adopt marketplace-aware defaults." },
            { value: "disabled", label: "Disabled", detail: "Keep marketplace behavior quiet until you enable it later." },
          ],
        });
        if (marketplaceMode === CANCEL) return 1;
        if (marketplaceMode === GO_BACK) {
          stepIndex -= 1;
          continue;
        }
        answers = {
          ...answers,
          marketplaceEnabled: marketplaceMode === "enabled",
        };
        stepIndex += 1;
        continue;
      }

      if (stepIndex === 16) {
        const review = await session.promptReview(
          17,
          totalSteps,
          buildReviewLines(answers),
        );
        if (review === CANCEL) return 1;
        if (review === GO_BACK) {
          stepIndex -= 1;
          continue;
        }

        const profile = buildOnboardingProfile(answers, baseConfig);
        const prepared: PreparedOnboardRun = {
          finalConfig: profile.config,
          importedLegacyConfigPath,
          workspace: {
            workspacePath: profile.config.workspace?.hostPath,
            files: profile.workspaceFiles,
            overwrite: options.force ?? false,
            backupExisting: options.force ?? false,
          },
        };

        session.renderStatic({
          step: 17,
          totalSteps,
          title: "Writing setup",
          subtitle: "Saving the canonical config and curated workspace files, then running health checks.",
          body: ["Please wait..."],
          footer: "Working...",
          statusTone: "teal",
        });

        const result = await executeOnboardCommand(options, prepared);

        const finished = await session.showMessage({
          step: 17,
          totalSteps,
          title: result.exitCode === 0 ? "Onboarding complete" : "Onboarding finished with warnings",
          subtitle:
            result.exitCode === 0
              ? "AgenC has a working first-run profile. Review the summary, then continue into the normal command flow."
              : "Setup wrote what it could, but one or more checks need attention before you rely on the runtime.",
          body: buildFinalSummaryLines(result),
          footer: "Enter continue",
          statusTone: result.exitCode === 0 ? "green" : "yellow",
        });
        if (result.exitCode === 0) {
          finalSummaryText =
            `${COLOR.bold}AgenC onboard${COLOR.reset}\n` +
            `Config: ${result.configPath}\n` +
            `${result.workspacePath ? `Workspace: ${result.workspacePath}\n` : ""}` +
            "Next steps:\n" +
            "  agenc start\n" +
            "  agenc\n" +
            "  agenc ui\n";
        } else {
          finalSummaryText =
            `${COLOR.bold}AgenC onboard${COLOR.reset}\n` +
            `Config: ${result.configPath}\n` +
            `${result.workspacePath ? `Workspace: ${result.workspacePath}\n` : ""}` +
            "Setup finished with warnings.\n" +
            "Review the health-check output before starting the runtime.\n";
        }
        if (finished === CANCEL) return result.exitCode;
        return result.exitCode;
      }
    }
    return 1;
  } finally {
    session.dispose();
    if (finalSummaryText) {
      resolvedDeps.stdout.write(finalSummaryText);
    }
  }
}

export function shouldUseInteractiveOnboarding(
  parsedFlags: Record<string, string | number | boolean>,
  deps: Pick<OnboardingTuiDeps, "stdin" | "stdout"> = DEFAULT_TUI_DEPS,
): boolean {
  return canUseInteractiveOnboarding(parsedFlags, deps);
}

export { maskSecret };
