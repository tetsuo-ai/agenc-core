import { createInterface } from "node:readline/promises";
import type { CliRuntimeContext, CliStatusCode, BaseCliOptions } from "./types.js";
import type {
  MarketDisputeResolveOptions,
  MarketReputationDelegateOptions,
  MarketSkillRateOptions,
  MarketTaskCreateOptions,
  MarketTaskDisputeOptions,
} from "./marketplace-cli.js";
import {
  parseArbiterVotes,
  parseExtraWorkers,
  runMarketDisputeDetailCommand,
  runMarketDisputeResolveCommand,
  runMarketDisputesListCommand,
  runMarketGovernanceDetailCommand,
  runMarketGovernanceListCommand,
  runMarketGovernanceVoteCommand,
  runMarketReputationDelegateCommand,
  runMarketReputationStakeCommand,
  runMarketReputationSummaryCommand,
  runMarketSkillDetailCommand,
  runMarketSkillPurchaseCommand,
  runMarketSkillRateCommand,
  runMarketSkillsListCommand,
  runMarketTaskCancelCommand,
  runMarketTaskClaimCommand,
  runMarketTaskCompleteCommand,
  runMarketTaskCreateCommand,
  runMarketTaskDetailCommand,
  runMarketTaskDisputeCommand,
  runMarketTasksListCommand,
} from "./marketplace-cli.js";

interface MarketplaceTuiInput {
  readonly isTTY?: boolean;
}

interface MarketplaceTuiOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write: (chunk: string) => void;
}

interface MarketplaceTuiDeps {
  stdin: NodeJS.ReadableStream & MarketplaceTuiInput;
  stdout: NodeJS.WritableStream & MarketplaceTuiOutput;
}

type DomainChoice =
  | "tasks"
  | "skills"
  | "governance"
  | "disputes"
  | "reputation"
  | "quit";

type LoopState = "back" | "quit";

type CapturedPayload = Record<string, unknown>;

export interface MarketTuiOptions extends BaseCliOptions {}

const DEFAULT_DEPS: MarketplaceTuiDeps = {
  stdin: process.stdin,
  stdout: process.stdout,
};

function clearScreen(stdout: MarketplaceTuiOutput): void {
  stdout.write("\x1b[2J\x1b[H");
}

function divider(width?: number): string {
  return "-".repeat(Math.max(32, Math.min(width ?? 80, 88)));
}

function truncate(value: string, max = 92): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function readString(
  value: unknown,
  fallback = "--",
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function resolveListTarget(
  input: string | undefined,
  items: Record<string, unknown>[],
  fieldName: string,
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const asIndex = Number.parseInt(trimmed, 10);
  if (
    Number.isInteger(asIndex) &&
    asIndex >= 1 &&
    asIndex <= items.length
  ) {
    const value = items[asIndex - 1]?.[fieldName];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }
  return trimmed;
}

function extractErrorMessage(errorValue: unknown): string {
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue;
  }
  if (
    errorValue &&
    typeof errorValue === "object" &&
    typeof (errorValue as Record<string, unknown>).message === "string"
  ) {
    return (errorValue as Record<string, string>).message;
  }
  return "Command failed";
}

function parseCommandLine(input: string): { action: string; target?: string } {
  const [action = "", ...rest] = input.trim().split(/\s+/);
  return { action: action.toLowerCase(), target: rest[0] };
}

function renderHeader(
  stdout: MarketplaceTuiOutput,
  title: string,
  subtitle: string,
): void {
  clearScreen(stdout);
  const line = divider(stdout.columns);
  stdout.write(`${line}\n`);
  stdout.write(`MARKETPLACE TERMINAL > ${title}\n`);
  stdout.write(`${subtitle}\n`);
  stdout.write(`${line}\n\n`);
}

async function pause(
  rl: ReturnType<typeof createInterface>,
  label = "[enter] continue",
): Promise<void> {
  await rl.question(`${label}: `);
}

async function promptOptional(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string | undefined> {
  const value = (await rl.question(`${label}: `)).trim();
  return value.length > 0 ? value : undefined;
}

async function promptRequired(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
    const value = (await rl.question(prompt)).trim();
    if (value.length > 0) return value;
    if (defaultValue) return defaultValue;
  }
}

async function invokeRunner<TOptions extends BaseCliOptions>(
  context: CliRuntimeContext,
  runner: (
    context: CliRuntimeContext,
    options: TOptions,
  ) => Promise<CliStatusCode>,
  options: TOptions,
): Promise<{
  code: CliStatusCode;
  output?: CapturedPayload;
  error?: unknown;
}> {
  let output: CapturedPayload | undefined;
  let error: unknown;
  const captureContext: CliRuntimeContext = {
    logger: context.logger,
    outputFormat: "json",
    output(value) {
      output = (value as CapturedPayload) ?? undefined;
    },
    error(value) {
      error = value;
    },
  };
  const code = await runner(captureContext, options);
  return { code, output, error };
}

function pickDomainChoice(input: string): DomainChoice | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === "1" || normalized === "tasks") return "tasks";
  if (normalized === "2" || normalized === "skills") return "skills";
  if (normalized === "3" || normalized === "governance") return "governance";
  if (normalized === "4" || normalized === "disputes") return "disputes";
  if (normalized === "5" || normalized === "reputation") return "reputation";
  if (normalized === "q" || normalized === "quit" || normalized === "exit") {
    return "quit";
  }
  return null;
}

function renderMainMenu(stdout: MarketplaceTuiOutput): void {
  renderHeader(
    stdout,
    "workspace",
    "Interactive operator surface for tasks, skills, governance, disputes, and reputation.",
  );
  stdout.write("[1] tasks\n");
  stdout.write("[2] skills\n");
  stdout.write("[3] governance\n");
  stdout.write("[4] disputes\n");
  stdout.write("[5] reputation\n");
  stdout.write("[q] quit\n\n");
  stdout.write("Choose a domain: ");
}

function renderPayloadBlock(
  stdout: MarketplaceTuiOutput,
  title: string,
  payload: unknown,
): void {
  const line = divider(stdout.columns);
  stdout.write(`\n${line}\n`);
  stdout.write(`${title}\n`);
  stdout.write(`${line}\n`);
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function renderTasksList(stdout: MarketplaceTuiOutput, tasks: Record<string, unknown>[]): void {
  if (tasks.length === 0) {
    stdout.write("[no tasks returned]\n");
    return;
  }
  for (const [index, task] of tasks.slice(0, 12).entries()) {
    stdout.write(
      `${index + 1}. ${readString(task.status)} | ${readString(task.rewardSol, readString(task.rewardLamports))} | ${truncate(readString(task.description))}\n`,
    );
    stdout.write(`   ${readString(task.taskPda)}\n`);
  }
}

function renderSkillsList(stdout: MarketplaceTuiOutput, skills: Record<string, unknown>[]): void {
  if (skills.length === 0) {
    stdout.write("[no skills returned]\n");
    return;
  }
  for (const [index, skill] of skills.slice(0, 12).entries()) {
    stdout.write(
      `${index + 1}. ${truncate(readString(skill.name))} | rating ${readString(skill.rating, "0")} | downloads ${readString(skill.downloads, "0")}\n`,
    );
    stdout.write(`   ${readString(skill.skillPda)}\n`);
  }
}

function renderGovernanceList(
  stdout: MarketplaceTuiOutput,
  proposals: Record<string, unknown>[],
): void {
  if (proposals.length === 0) {
    stdout.write("[no proposals returned]\n");
    return;
  }
  for (const [index, proposal] of proposals.slice(0, 12).entries()) {
    stdout.write(
      `${index + 1}. ${readString(proposal.status)} | ${readString(proposal.proposalType)} | for ${readString(proposal.votesFor, "0")} / against ${readString(proposal.votesAgainst, "0")}\n`,
    );
    stdout.write(`   ${readString(proposal.proposalPda)}\n`);
  }
}

function renderDisputesList(stdout: MarketplaceTuiOutput, disputes: Record<string, unknown>[]): void {
  if (disputes.length === 0) {
    stdout.write("[no disputes returned]\n");
    return;
  }
  for (const [index, dispute] of disputes.slice(0, 12).entries()) {
    stdout.write(
      `${index + 1}. ${readString(dispute.status)} | ${readString(dispute.resolutionType)} | task ${truncate(readString(dispute.taskPda), 20)}\n`,
    );
    stdout.write(`   ${readString(dispute.disputePda)}\n`);
  }
}

function renderReputationSummary(stdout: MarketplaceTuiOutput, summary: Record<string, unknown> | null): void {
  if (!summary) {
    stdout.write("[no signer-backed agent registration found for this runtime wallet]\n");
    return;
  }
  stdout.write(`agent: ${readString(summary.agentPda)}\n`);
  stdout.write(`registered: ${readString(summary.registered)}\n`);
  stdout.write(`authority: ${readString(summary.authority)}\n`);
  stdout.write(`base reputation: ${readString(summary.baseReputation, "0")}\n`);
  stdout.write(`effective reputation: ${readString(summary.effectiveReputation, "0")}\n`);
  stdout.write(`staked SOL: ${readString(summary.stakedAmountSol, "0")}\n`);
  stdout.write(`tasks completed: ${readString(summary.tasksCompleted, "0")}\n`);
}

async function showRunnerResult<TOptions extends BaseCliOptions>(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  title: string,
  runner: (
    context: CliRuntimeContext,
    options: TOptions,
  ) => Promise<CliStatusCode>,
  options: TOptions,
): Promise<void> {
  const result = await invokeRunner(context, runner, options);
  if (result.code !== 0) {
    renderPayloadBlock(stdout, `${title} failed`, {
      message: extractErrorMessage(result.error),
    });
    await pause(rl);
    return;
  }
  renderPayloadBlock(stdout, title, result.output ?? { status: "ok" });
  await pause(rl);
}

async function runTasksLoop(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  base: MarketTuiOptions,
): Promise<LoopState> {
  while (true) {
    const listResult = await invokeRunner(context, runMarketTasksListCommand, {
      ...base,
    });
    renderHeader(
      stdout,
      "tasks",
      "Commands: detail <n|pda>, create, claim <n|pda>, complete <n|pda>, dispute <n|pda>, cancel <n|pda>, refresh, back, quit",
    );
    if (listResult.code !== 0) {
      stdout.write(`error: ${extractErrorMessage(listResult.error)}\n\n`);
    }
    const tasks = Array.isArray(listResult.output?.tasks)
      ? (listResult.output?.tasks as Record<string, unknown>[])
      : [];
    renderTasksList(stdout, tasks);
    stdout.write("\n");
    const input = (await rl.question("tasks> ")).trim();
    const { action, target } = parseCommandLine(input);
    if (!action || action === "refresh") continue;
    if (action === "back") return "back";
    if (action === "quit" || action === "exit") return "quit";
    if (action === "create") {
      const description = await promptRequired(rl, "description");
      const reward = await promptRequired(rl, "reward lamports");
      const requiredCapabilities = await promptRequired(
        rl,
        "required capabilities",
        "1",
      );
      const maxWorkersRaw = await promptOptional(rl, "max workers");
      const deadlineRaw = await promptOptional(rl, "deadline (unix seconds)");
      const taskTypeRaw = await promptOptional(rl, "task type (0 exclusive, 1 collaborative, 2 competitive)");
      await showRunnerResult(
        rl,
        stdout,
        context,
        "task creation",
        runMarketTaskCreateCommand,
        {
          ...base,
          description,
          reward,
          requiredCapabilities,
          maxWorkers: maxWorkersRaw ? Number.parseInt(maxWorkersRaw, 10) : undefined,
          deadline: deadlineRaw ? Number.parseInt(deadlineRaw, 10) : undefined,
          taskType: taskTypeRaw ? Number.parseInt(taskTypeRaw, 10) : undefined,
        } as MarketTaskCreateOptions,
      );
      continue;
    }

    const taskPda = resolveListTarget(target, tasks, "taskPda");
    if (!taskPda) {
      renderPayloadBlock(stdout, "invalid task target", {
        message: "Use a numbered row or a task PDA.",
      });
      await pause(rl);
      continue;
    }

    if (action === "detail") {
      await showRunnerResult(rl, stdout, context, "task detail", runMarketTaskDetailCommand, {
        ...base,
        taskPda,
      });
      continue;
    }
    if (action === "claim") {
      await showRunnerResult(rl, stdout, context, "task claim", runMarketTaskClaimCommand, {
        ...base,
        taskPda,
      });
      continue;
    }
    if (action === "complete") {
      const resultData = await promptOptional(rl, "completion note (optional)");
      await showRunnerResult(rl, stdout, context, "task completion", runMarketTaskCompleteCommand, {
        ...base,
        taskPda,
        resultData,
      });
      continue;
    }
    if (action === "dispute") {
      const evidence = await promptRequired(rl, "evidence");
      const resolutionType = await promptRequired(
        rl,
        "resolution type",
        "refund",
      );
      await showRunnerResult(
        rl,
        stdout,
        context,
        "task dispute",
        runMarketTaskDisputeCommand,
        {
          ...base,
          taskPda,
          evidence,
          resolutionType,
        } as MarketTaskDisputeOptions,
      );
      continue;
    }
    if (action === "cancel") {
      await showRunnerResult(rl, stdout, context, "task cancel", runMarketTaskCancelCommand, {
        ...base,
        taskPda,
      });
      continue;
    }

    renderPayloadBlock(stdout, "unknown task command", {
      message: `Unsupported command: ${input}`,
    });
    await pause(rl);
  }
}

async function runSkillsLoop(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  base: MarketTuiOptions,
): Promise<LoopState> {
  while (true) {
    const listResult = await invokeRunner(context, runMarketSkillsListCommand, {
      ...base,
    });
    renderHeader(
      stdout,
      "skills",
      "Commands: detail <n|pda>, purchase <n|pda>, rate <n|pda>, refresh, back, quit",
    );
    if (listResult.code !== 0) {
      stdout.write(`error: ${extractErrorMessage(listResult.error)}\n\n`);
    }
    const skills = Array.isArray(listResult.output?.skills)
      ? (listResult.output?.skills as Record<string, unknown>[])
      : [];
    renderSkillsList(stdout, skills);
    stdout.write("\n");
    const input = (await rl.question("skills> ")).trim();
    const { action, target } = parseCommandLine(input);
    if (!action || action === "refresh") continue;
    if (action === "back") return "back";
    if (action === "quit" || action === "exit") return "quit";

    const skillPda = resolveListTarget(target, skills, "skillPda");
    if (!skillPda) {
      renderPayloadBlock(stdout, "invalid skill target", {
        message: "Use a numbered row or a skill PDA.",
      });
      await pause(rl);
      continue;
    }

    if (action === "detail") {
      await showRunnerResult(rl, stdout, context, "skill detail", runMarketSkillDetailCommand, {
        ...base,
        skillPda,
      });
      continue;
    }
    if (action === "purchase") {
      await showRunnerResult(rl, stdout, context, "skill purchase", runMarketSkillPurchaseCommand, {
        ...base,
        skillPda,
      });
      continue;
    }
    if (action === "rate") {
      const ratingRaw = await promptRequired(rl, "rating 1-5");
      const rating = Number.parseInt(ratingRaw, 10);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        renderPayloadBlock(stdout, "invalid rating", {
          message: "Rating must be an integer from 1 to 5.",
        });
        await pause(rl);
        continue;
      }
      const review = await promptOptional(rl, "review (optional)");
      await showRunnerResult(
        rl,
        stdout,
        context,
        "skill rating",
        runMarketSkillRateCommand,
        {
          ...base,
          skillPda,
          rating,
          review,
        } as MarketSkillRateOptions,
      );
      continue;
    }

    renderPayloadBlock(stdout, "unknown skill command", {
      message: `Unsupported command: ${input}`,
    });
    await pause(rl);
  }
}

async function runGovernanceLoop(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  base: MarketTuiOptions,
): Promise<LoopState> {
  while (true) {
    const listResult = await invokeRunner(context, runMarketGovernanceListCommand, {
      ...base,
    });
    renderHeader(
      stdout,
      "governance",
      "Commands: detail <n|pda>, vote <n|pda>, refresh, back, quit",
    );
    if (listResult.code !== 0) {
      stdout.write(`error: ${extractErrorMessage(listResult.error)}\n\n`);
    }
    const proposals = Array.isArray(listResult.output?.proposals)
      ? (listResult.output?.proposals as Record<string, unknown>[])
      : [];
    renderGovernanceList(stdout, proposals);
    stdout.write("\n");
    const input = (await rl.question("governance> ")).trim();
    const { action, target } = parseCommandLine(input);
    if (!action || action === "refresh") continue;
    if (action === "back") return "back";
    if (action === "quit" || action === "exit") return "quit";

    const proposalPda = resolveListTarget(target, proposals, "proposalPda");
    if (!proposalPda) {
      renderPayloadBlock(stdout, "invalid proposal target", {
        message: "Use a numbered row or a proposal PDA.",
      });
      await pause(rl);
      continue;
    }

    if (action === "detail") {
      await showRunnerResult(
        rl,
        stdout,
        context,
        "governance proposal detail",
        runMarketGovernanceDetailCommand,
        {
          ...base,
          proposalPda,
        },
      );
      continue;
    }
    if (action === "vote") {
      const choice = await promptRequired(rl, "vote choice", "yes");
      const approve = choice.trim().toLowerCase() === "yes";
      await showRunnerResult(
        rl,
        stdout,
        context,
        "governance vote",
        runMarketGovernanceVoteCommand,
        {
          ...base,
          proposalPda,
          approve,
        },
      );
      continue;
    }

    renderPayloadBlock(stdout, "unknown governance command", {
      message: `Unsupported command: ${input}`,
    });
    await pause(rl);
  }
}

async function runDisputesLoop(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  base: MarketTuiOptions,
): Promise<LoopState> {
  while (true) {
    const listResult = await invokeRunner(context, runMarketDisputesListCommand, {
      ...base,
    });
    renderHeader(
      stdout,
      "disputes",
      "Commands: detail <n|pda>, resolve <n|pda>, refresh, back, quit",
    );
    if (listResult.code !== 0) {
      stdout.write(`error: ${extractErrorMessage(listResult.error)}\n\n`);
    }
    const disputes = Array.isArray(listResult.output?.disputes)
      ? (listResult.output?.disputes as Record<string, unknown>[])
      : [];
    renderDisputesList(stdout, disputes);
    stdout.write("\n");
    const input = (await rl.question("disputes> ")).trim();
    const { action, target } = parseCommandLine(input);
    if (!action || action === "refresh") continue;
    if (action === "back") return "back";
    if (action === "quit" || action === "exit") return "quit";

    const disputePda = resolveListTarget(target, disputes, "disputePda");
    if (!disputePda) {
      renderPayloadBlock(stdout, "invalid dispute target", {
        message: "Use a numbered row or a dispute PDA.",
      });
      await pause(rl);
      continue;
    }

    if (action === "detail") {
      await showRunnerResult(rl, stdout, context, "dispute detail", runMarketDisputeDetailCommand, {
        ...base,
        disputePda,
      });
      continue;
    }
    if (action === "resolve") {
      const arbiterVotesRaw = await promptRequired(
        rl,
        "arbiter votes votePda:arbiterPda[,..]",
      );
      const extraWorkersRaw = await promptOptional(
        rl,
        "extra workers claimPda:workerPda[,..] (optional)",
      );
      await showRunnerResult(
        rl,
        stdout,
        context,
        "dispute resolve",
        runMarketDisputeResolveCommand,
        {
          ...base,
          disputePda,
          arbiterVotes: parseArbiterVotes(arbiterVotesRaw),
          extraWorkers: extraWorkersRaw
            ? parseExtraWorkers(extraWorkersRaw)
            : undefined,
        } as MarketDisputeResolveOptions,
      );
      continue;
    }

    renderPayloadBlock(stdout, "unknown dispute command", {
      message: `Unsupported command: ${input}`,
    });
    await pause(rl);
  }
}

async function runReputationLoop(
  rl: ReturnType<typeof createInterface>,
  stdout: MarketplaceTuiOutput,
  context: CliRuntimeContext,
  base: MarketTuiOptions,
): Promise<LoopState> {
  while (true) {
    const summaryResult = await invokeRunner(
      context,
      runMarketReputationSummaryCommand,
      { ...base },
    );
    renderHeader(
      stdout,
      "reputation",
      "Commands: summary [agentPda], stake, delegate, refresh, back, quit",
    );
    if (summaryResult.code !== 0) {
      stdout.write(`error: ${extractErrorMessage(summaryResult.error)}\n\n`);
    }
    renderReputationSummary(
      stdout,
      (summaryResult.output?.summary as Record<string, unknown> | null) ?? null,
    );
    stdout.write("\n");
    const input = (await rl.question("reputation> ")).trim();
    const { action, target } = parseCommandLine(input);
    if (!action || action === "refresh") continue;
    if (action === "back") return "back";
    if (action === "quit" || action === "exit") return "quit";
    if (action === "summary") {
      await showRunnerResult(
        rl,
        stdout,
        context,
        "reputation summary",
        runMarketReputationSummaryCommand,
        {
          ...base,
          agentPda: target,
        },
      );
      continue;
    }
    if (action === "stake") {
      const amount = await promptRequired(rl, "stake lamports");
      await showRunnerResult(
        rl,
        stdout,
        context,
        "reputation stake",
        runMarketReputationStakeCommand,
        {
          ...base,
          amount,
        },
      );
      continue;
    }
    if (action === "delegate") {
      const amountRaw = await promptRequired(rl, "delegation amount");
      const amount = Number.parseInt(amountRaw, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        renderPayloadBlock(stdout, "invalid delegation amount", {
          message: "Delegation amount must be a positive integer.",
        });
        await pause(rl);
        continue;
      }
      const delegateeAgentPda = await promptOptional(rl, "delegatee agent PDA");
      const delegateeAgentId =
        delegateeAgentPda === undefined
          ? await promptOptional(rl, "delegatee agent id (hex)")
          : undefined;
      if (!delegateeAgentPda && !delegateeAgentId) {
        renderPayloadBlock(stdout, "missing delegatee", {
          message: "Provide a delegatee agent PDA or agent id.",
        });
        await pause(rl);
        continue;
      }
      const expiresAtRaw = await promptOptional(rl, "expires at (unix, optional)");
      await showRunnerResult(
        rl,
        stdout,
        context,
        "reputation delegate",
        runMarketReputationDelegateCommand,
        {
          ...base,
          amount,
          delegateeAgentPda,
          delegateeAgentId,
          expiresAt: expiresAtRaw ? Number.parseInt(expiresAtRaw, 10) : undefined,
        } as MarketReputationDelegateOptions,
      );
      continue;
    }

    renderPayloadBlock(stdout, "unknown reputation command", {
      message: `Unsupported command: ${input}`,
    });
    await pause(rl);
  }
}

export function shouldUseInteractiveMarketplace(
  flags: Record<string, string | number | boolean>,
  deps: Pick<MarketplaceTuiDeps, "stdin" | "stdout"> = DEFAULT_DEPS,
): boolean {
  if (flags.output === "json" || flags.output === "jsonl") return false;
  if (flags["output-format"] === "json" || flags["output-format"] === "jsonl") {
    return false;
  }
  return deps.stdin.isTTY === true && deps.stdout.isTTY === true;
}

export async function runMarketTuiCommand(
  context: CliRuntimeContext,
  options: MarketTuiOptions,
  deps: MarketplaceTuiDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  if (
    !shouldUseInteractiveMarketplace(
      { "output-format": options.outputFormat },
      deps,
    )
  ) {
    context.error({
      status: "error",
      code: "MARKET_TUI_REQUIRES_TTY",
      message:
        "market tui requires an interactive TTY with table output. Use agenc-runtime market <domain> <command> for non-interactive flows.",
    });
    return 1;
  }

  const rl = createInterface({
    input: deps.stdin,
    output: deps.stdout,
    terminal: deps.stdin.isTTY === true && deps.stdout.isTTY === true,
  });

  try {
    while (true) {
      renderMainMenu(deps.stdout);
      const choice = pickDomainChoice(await rl.question(""));
      if (!choice) {
        renderPayloadBlock(deps.stdout, "unknown selection", {
          message: "Use 1-5, a domain name, or q to quit.",
        });
        await pause(rl);
        continue;
      }
      if (choice === "quit") {
        clearScreen(deps.stdout);
        deps.stdout.write("Marketplace terminal closed.\n");
        return 0;
      }

      const result =
        choice === "tasks"
          ? await runTasksLoop(rl, deps.stdout, context, options)
          : choice === "skills"
            ? await runSkillsLoop(rl, deps.stdout, context, options)
            : choice === "governance"
              ? await runGovernanceLoop(rl, deps.stdout, context, options)
              : choice === "disputes"
                ? await runDisputesLoop(rl, deps.stdout, context, options)
                : await runReputationLoop(rl, deps.stdout, context, options);
      if (result === "quit") {
        clearScreen(deps.stdout);
        deps.stdout.write("Marketplace terminal closed.\n");
        return 0;
      }
    }
  } finally {
    rl.close();
  }
}
