export interface PlanModeInstructionInput {
  readonly planFilePath: string;
  readonly planExists: boolean;
  readonly sparse?: boolean;
}

export function buildPlanModeInstructions(
  input: PlanModeInstructionInput,
): string {
  if (input.sparse) {
    return `Plan mode still active (see full instructions earlier in conversation). Read-only except the AgenC plan file (${input.planFilePath}). Explore code, update the plan incrementally, and end by calling ExitPlanMode for plan approval. Never ask about plan approval in plain text.`;
  }

  const planFileInfo = input.planExists
    ? `A plan file already exists at ${input.planFilePath}. You can read it and make incremental edits using system.editFile.`
    : `No plan file exists yet. You should create your plan at ${input.planFilePath} using system.writeFile.`;

  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planFileInfo}

You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and write your findings into the plan file as you go. The plan file above is the ONLY file you may edit - it starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. Explore - Use system.readFile, system.glob, system.grep, and other read-only tools to inspect code. Look for existing functions, utilities, and patterns to reuse.
2. Update the plan file - After each discovery, immediately capture what you learned. Do not wait until the end.
3. Ask the user - When you hit an ambiguity or decision you cannot resolve from code alone, ask the user. Then go back to step 1.

### Plan File Structure

Your plan file should be divided into clear markdown sections based on the request:
- Begin with a Context section: explain what is changing, why, and the intended outcome
- Include only your recommended approach, not all alternatives
- List the paths of critical files to modify
- Reference existing functions and utilities to reuse, with file paths
- Include a Verification section describing how to test the change end-to-end

### Ending Your Turn

Your turn should only end by either asking the user a clarifying question or calling ExitPlanMode when the plan is ready for approval.

Important: Use ExitPlanMode to request plan approval. Do NOT ask about plan approval via plain text. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", or similar MUST use ExitPlanMode.`;
}
