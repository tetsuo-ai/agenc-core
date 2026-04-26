export type PlanModeReminderType = "full" | "sparse";
export type PlanModeWorkflow = "interview" | "phased";

/**
 * Inputs to `buildPlanModeInstructions`.
 *
 * Precedence (highest first):
 *   1. `isSubAgent === true`             → minimal sub-agent prompt
 *   2. `reminderType === "sparse"`       → one-paragraph reminder
 *   3. `workflow` ("phased"|"interview") → full workflow prompt
 *
 * `isSubAgent` is intentionally orthogonal to `workflow` so a sub-agent
 * can be spawned under either workflow (the prompt collapses to the
 * minimal sub-agent surface today; a future renderer may want to mix
 * the two dimensions). The flag is `true | undefined` — passing `false`
 * is forbidden so the precedence above is total.
 */
export interface PlanModeInstructionInput {
  readonly planFilePath: string;
  readonly planExists: boolean;
  readonly reminderType?: PlanModeReminderType;
  readonly workflow?: PlanModeWorkflow;
  readonly isSubAgent?: true;
  readonly includeReentryReminder?: boolean;
}

const READ_TOOL_NAME = "FileRead";
const GLOB_TOOL_NAME = "Glob";
const GREP_TOOL_NAME = "Grep";
const WRITE_TOOL_NAME = "Write";
const EDIT_TOOL_NAME = "Edit";

const READ_ONLY_TOOL_NAMES = `${READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}`;

const PLAN_AGENT_TOOL_NAME = "system.agent.delegate";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

function planFileInfo(input: PlanModeInstructionInput): string {
  return input.planExists
    ? `A plan file already exists at ${input.planFilePath}. You can read it and make incremental edits using ${EDIT_TOOL_NAME}.`
    : `No plan file exists yet. You should create your plan at ${input.planFilePath} using ${WRITE_TOOL_NAME}.`;
}

function planModeHeader(input: PlanModeInstructionInput): string {
  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## AgenC Context

- AgenC uses AGENC.MD as its project instruction file.
- AgenC plan files live under <AGENC_HOME>/plans and the active plan file for this session is listed below.
- The only writable target in plan mode is the active AgenC plan file.

## Plan File Info:
${planFileInfo(input)}

You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.`;
}

function planPhase4Section(): string {
  return `### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made - the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)`;
}

function buildPhasedInstructions(input: PlanModeInstructionInput): string {
  return `${planModeHeader(input)}

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused - avoid proposing new code when suitable implementations already exist.

2. Use read-only tools to efficiently explore the codebase. Prefer ${READ_ONLY_TOOL_NAMES}. If ${PLAN_AGENT_TOOL_NAME} or another AgenC delegate tool is available, you may use it for bounded read-only exploration, but keep each delegated question specific.

### Phase 2: Design
Goal: Design an implementation approach.

Use the context from Phase 1 to design the implementation. If a delegate/planning tool is available and the task is complex, use it to validate your understanding and consider alternatives. Skip delegation for truly trivial tasks such as typo fixes, single-line changes, or simple renames.

When designing:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Prefer existing AgenC runtime/TUI patterns over new abstractions
- Keep the scope aligned with the user's request

### Phase 3: Review
Goal: Review the plan and ensure alignment with the user's intentions.
1. Read the critical files identified during exploration to deepen your understanding
2. Ensure that the plan aligns with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

${planPhase4Section()}

### Phase 5: Call ${EXIT_PLAN_MODE_TOOL_NAME}
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it is for one of those two reasons.

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no ${ASK_USER_QUESTION_TOOL_NAME}. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Do not make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

function buildInterviewInstructions(input: PlanModeInstructionInput): string {
  return `${planModeHeader(input)}

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and write your findings into the plan file as you go. The plan file above is the ONLY file you may edit - it starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** - Use ${READ_ONLY_TOOL_NAMES} to read code. Look for existing functions, utilities, and patterns to reuse. If ${PLAN_AGENT_TOOL_NAME} or another AgenC delegate tool is available, you may use it to parallelize complex read-only searches without filling your context, though for straightforward queries direct tools are simpler.
2. **Update the plan file** - After each discovery, immediately capture what you learned. Do not wait until the end.
3. **Ask the user** - When you hit an ambiguity or decision you cannot resolve from code alone, use ${ASK_USER_QUESTION_TOOL_NAME}. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan with headers and rough notes and ask the user your first round of questions. Do not explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together in ${ASK_USER_QUESTION_TOOL_NAME} calls
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task - a vague feature request needs many rounds; a focused bug fix may need one or none

### Plan File Structure

Your plan file should be divided into clear sections using markdown headers, based on the request. Fill out these sections as you go.
- Begin with a **Context** section: explain why this change is being made - the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### When to Converge

Your plan is ready when you have addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. Call ${EXIT_PLAN_MODE_TOOL_NAME} when the plan is ready for approval.

### Ending Your Turn

Your turn should only end by either:
- Using ${ASK_USER_QUESTION_TOOL_NAME} to gather more information
- Calling ${EXIT_PLAN_MODE_TOOL_NAME} when the plan is ready for approval

**Important:** Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval via text or ${ASK_USER_QUESTION_TOOL_NAME}.`;
}

function buildSubAgentInstructions(input: PlanModeInstructionInput): string {
  return `${planModeHeader(input)}

Answer the user's query comprehensively, using ${ASK_USER_QUESTION_TOOL_NAME} if you need to ask the user clarifying questions. If you use ${ASK_USER_QUESTION_TOOL_NAME}, ask all clarifying questions you need to fully understand the user's intent before proceeding.`;
}

export function buildPlanModeReentryInstructions(planFilePath: string): string {
  return `## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task, even if it is similar or related, start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and, most importantly, always edit the plan file one way or the other before calling ${EXIT_PLAN_MODE_TOOL_NAME}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`;
}

export function buildPlanModeExitInstructions(input: {
  readonly planFilePath: string;
  readonly planExists: boolean;
}): string {
  const planReference = input.planExists
    ? ` The plan file is located at ${input.planFilePath} if you need to reference it.`
    : "";
  return `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`;
}

export function buildPlanModeInstructions(
  input: PlanModeInstructionInput,
): string {
  const reminderType = input.reminderType ?? "full";
  const workflow = input.workflow ?? "interview";

  let body: string;
  if (input.isSubAgent) {
    body = buildSubAgentInstructions(input);
  } else if (reminderType === "sparse") {
    const workflowDescription =
      workflow === "interview"
        ? "Follow iterative workflow: explore codebase, interview user, write to the AgenC plan file incrementally."
        : "Follow the 5-phase workflow.";
    body = `Plan mode still active (see full instructions earlier in conversation). Read-only except the AgenC plan file (${input.planFilePath}). ${workflowDescription} End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or ${ASK_USER_QUESTION_TOOL_NAME}.`;
  } else {
    body =
      workflow === "phased"
        ? buildPhasedInstructions(input)
        : buildInterviewInstructions(input);
  }

  if (input.includeReentryReminder === true && input.planExists) {
    return `${buildPlanModeReentryInstructions(input.planFilePath)}

${body}`;
  }

  return body;
}
