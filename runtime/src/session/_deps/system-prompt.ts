/**
 * Lean stubs for the system-prompt and user/system-context surface
 * that `compact-runtime-context.ts` builds for `buildCompactCacheSafeParams`.
 *
 * The openclaude `constants/prompts.js` and `context.js` resolvers are
 * extensive memoized loaders that pull project memory files, git status,
 * agent listings, output styles, and growthbook flags. The gut runtime
 * does not own those subsystems. These stubs return empty strings/arrays
 * so the call sites compile and the cache-safe-params builder produces
 * a well-formed shape with no extra context. Callers can layer real
 * prompts back in via `customSystemPrompt`/`appendSystemPrompt` if
 * needed.
 */

// Mirrors the upstream `SystemPrompt` brand from `utils/systemPromptType.ts`.
// CacheSafeParams (utils/forkedAgent.js, type-only crossing) and other
// openclaude consumers nominally require the brand, so we replicate it
// here rather than importing it (importing would re-introduce the
// crossing we are trying to break).
export type SystemPrompt = readonly string[] & {
  readonly __brand: "SystemPrompt";
};

export function asSystemPrompt(
  text: string | readonly string[],
): SystemPrompt {
  return (typeof text === "string" ? [text] : [...text]) as unknown as SystemPrompt;
}

export async function getSystemPrompt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ..._args: any[]
): Promise<string[]> {
  return [];
}

interface UserContextFn {
  (): Promise<Record<string, string>>;
  cache: { clear: () => void };
}

const makeContextFn = (): UserContextFn => {
  const fn = (async () => ({})) as UserContextFn;
  fn.cache = { clear: () => {} };
  return fn;
};

export const getUserContext: UserContextFn = makeContextFn();
export const getSystemContext: UserContextFn = makeContextFn();

export function buildEffectiveSystemPrompt(input: {
  mainThreadAgentDefinition?: unknown;
  toolUseContext?: unknown;
  customSystemPrompt?: string;
  defaultSystemPrompt: readonly string[];
  appendSystemPrompt?: string;
  overrideSystemPrompt?: string | null;
}): SystemPrompt {
  if (input.overrideSystemPrompt) {
    return asSystemPrompt([input.overrideSystemPrompt]);
  }
  return asSystemPrompt([
    ...(input.customSystemPrompt
      ? [input.customSystemPrompt]
      : input.defaultSystemPrompt),
    ...(input.appendSystemPrompt ? [input.appendSystemPrompt] : []),
  ]);
}
