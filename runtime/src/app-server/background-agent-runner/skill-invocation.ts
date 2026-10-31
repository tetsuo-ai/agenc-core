/**
 * Admission of the settings a user-invoked skill brings to its turn.
 *
 * The TUI sends a skill's frontmatter `model`, `effort` and `allowed-tools`
 * with the turn the user starts by `$name` or `/name` (`message.stream`
 * `skillInvocation`). Each is checked here the way the matching session
 * command checks it: the model like `/model` (the session provider's catalog,
 * the managed model allowlist, history compatibility), the effort like
 * `/effort` (levels the turn's model accepts), the grants like
 * `/permissions add` (canonical rule syntax, managed-only policy). The result
 * shapes that one turn's context; the session's own settings never change.
 *
 * @module
 */

import { checkModelHistoryCompat } from "../../commands/model.js";
import type { ConfigStore } from "../../config/store.js";
import { resolveReasoningEffort } from "../../llm/reasoning-effort.js";
import { parseRuleString, serializeRuleValue } from "../../permissions/rules.js";
import { MAX_SESSION_PERMISSION_RULE_UTF8_BYTES } from "../../permissions/session-rule-buckets.js";
import { readPermissionRulesSnapshot } from "../../permissions/settings.js";
import {
  formatSessionSelectionError,
  readSessionSelection,
  resolveSessionProviderModelSelection,
} from "../../session/provider-model-selection.js";
import { reasoningEffortForModel } from "../../session/reasoning-effort-for-model.js";
import type { Session } from "../../session/session.js";
import {
  SKILL_TURN_MODEL_DEFAULT_EFFORT,
  type SkillInvocationSettings,
  type SkillTurnEffort,
  type TurnSkillInvocation,
} from "../../session/skill-invocation.js";
import type {
  ModelInfo,
  ReasoningEffort,
  SkillInvocationTurnOverrides,
} from "../../session/turn-context.js";
import { RUN_RUNTIME_REASONING_EFFORTS } from "../../contracts/run-contracts.js";

/** Providers whose effort levels come with the live model list. */
const LIVE_EFFORT_LEVEL_PROVIDERS: ReadonlySet<string> = new Set([
  "venice",
  "ollama-cloud",
]);

/** A skill setting the session cannot honor; the message is refused. */
export class SkillInvocationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInvocationRejectedError";
  }
}

export interface AdmittedSkillInvocation {
  readonly overrides: SkillInvocationTurnOverrides;
  /** Grants the managed-only permission policy left out of the turn. */
  readonly withheldGrants: readonly string[];
}

function canonicalGrant(skill: string, raw: string): string {
  const trimmed = raw.trim();
  const rule = trimmed.length === 0 ? null : parseRuleString(trimmed);
  if (
    rule === null ||
    Buffer.byteLength(trimmed, "utf8") > MAX_SESSION_PERMISSION_RULE_UTF8_BYTES ||
    rule.toolName.length === 0 ||
    /[()\s]/u.test(rule.toolName)
  ) {
    throw new SkillInvocationRejectedError(
      `Skill ${skill} has an allowed-tools entry that is not a permission rule: ${trimmed || "(empty)"}. Use the /permissions rule syntax, such as Write or Edit(./docs/**).`,
    );
  }
  return serializeRuleValue(rule);
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (RUN_RUNTIME_REASONING_EFFORTS as readonly string[]).includes(value);
}

async function acceptedEffortLevels(
  session: Session,
  selection: { readonly provider: string; readonly model: string },
  level: string,
): Promise<readonly string[]> {
  let effort = resolveReasoningEffort(selection);
  if (
    !effort.levels.includes(level) &&
    LIVE_EFFORT_LEVEL_PROVIDERS.has(selection.provider)
  ) {
    // Venice and Ollama Cloud publish a model's levels with their live lists.
    // When the session could not read the list yet, read it before refusing.
    await session.services.provider
      ?.getExecutionProfile?.({ model: selection.model })
      .catch(() => undefined);
    effort = resolveReasoningEffort(selection);
  }
  return effort.levels;
}

/**
 * The skill's model on the session's provider. A model id two providers share
 * is read as the session provider's; a model only another provider serves is
 * refused with that provider named, since one turn cannot change providers.
 */
function resolveSkillModel(
  session: Session,
  skill: string,
  model: string,
  provider: string,
): { readonly provider: string; readonly model: string } {
  let sessionProviderError: unknown;
  try {
    const selection = resolveSessionProviderModelSelection(session, {
      model_provider: provider,
      model,
    });
    if (selection.provider === provider) return selection;
  } catch (error) {
    sessionProviderError = error;
  }
  let elsewhere: { readonly provider: string; readonly model: string } | undefined;
  try {
    elsewhere = resolveSessionProviderModelSelection(session, { model });
  } catch {
    elsewhere = undefined;
  }
  if (elsewhere?.provider === provider) return elsewhere;
  if (elsewhere !== undefined) {
    throw new SkillInvocationRejectedError(
      `Skill ${skill} asks for model ${elsewhere.model} on ${elsewhere.provider}, but this session runs on ${provider}. A skill's model must be one the session's provider serves.`,
    );
  }
  throw new SkillInvocationRejectedError(
    `Skill ${skill} asks for model ${model}, which this session cannot use: ${formatSessionSelectionError(sessionProviderError)}`,
  );
}

/**
 * Check a skill's settings against the session and build the overrides of
 * its turn. Throws {@link SkillInvocationRejectedError} with a message for the
 * user when a setting cannot apply; nothing is changed in that case.
 */
export async function admitSkillInvocation(
  session: Session,
  configStore: ConfigStore,
  settings: SkillInvocationSettings,
): Promise<AdmittedSkillInvocation> {
  const name = settings.name.trim();
  const live = readSessionSelection(session);

  let model: string | undefined;
  let modelInfo: ModelInfo | undefined;
  const requestedModel = settings.model?.trim();
  if (requestedModel !== undefined && requestedModel.length > 0) {
    const selection = resolveSkillModel(session, name, requestedModel, live.provider);
    if (selection.model !== live.model) {
      const compat = checkModelHistoryCompat(
        session,
        selection.model,
        selection.provider,
      );
      if (!compat.compatible) {
        throw new SkillInvocationRejectedError(
          `Skill ${name} asks for model ${selection.model}, which cannot continue this conversation: ${compat.reason ?? "history incompatible with that model"}`,
        );
      }
      model = selection.model;
      modelInfo = await session.modelInfoForLiveProvider(model);
    }
  }
  const turnModel = model ?? live.model;

  let effort: SkillTurnEffort | undefined;
  const requestedEffort = settings.effort?.trim().toLowerCase();
  if (requestedEffort !== undefined && requestedEffort.length > 0) {
    if (!isReasoningEffort(requestedEffort)) {
      throw new SkillInvocationRejectedError(
        `Skill ${name} sets effort ${requestedEffort}; a skill's effort must be one of ${RUN_RUNTIME_REASONING_EFFORTS.join(", ")}`,
      );
    }
    const levels = await acceptedEffortLevels(
      session,
      { provider: live.provider, model: turnModel },
      requestedEffort,
    );
    if (!levels.includes(requestedEffort)) {
      throw new SkillInvocationRejectedError(
        levels.length === 0
          ? `Skill ${name} sets effort ${requestedEffort}, but ${turnModel} takes no reasoning effort.`
          : `Skill ${name} sets effort ${requestedEffort}, which ${turnModel} does not support (supported: ${levels.join(", ")}).`,
      );
    }
    effort = requestedEffort;
  } else if (model !== undefined) {
    // As on a model switch: the session's level moves with the model only
    // when the model accepts it, otherwise the model runs at its default.
    const kept = reasoningEffortForModel({
      provider: live.provider,
      model,
      reasoningEffort: session.sessionConfiguration.collaborationMode.reasoningEffort,
      config: configStore.current(),
    });
    if (kept.dropped !== undefined) {
      const fallback = resolveReasoningEffort({
        provider: live.provider,
        model,
      }).defaultLevel;
      effort = fallback ?? SKILL_TURN_MODEL_DEFAULT_EFFORT;
    }
  }

  const grants = [
    ...new Set((settings.allowedTools ?? []).map((raw) => canonicalGrant(name, raw))),
  ];
  // The user invoked this skill, so the model may load it again during the
  // turn without the approval the Skill tool asks for a skill with settings.
  const invokedSkill = serializeRuleValue({ toolName: "Skill", ruleContent: name });
  const managedOnly = readPermissionRulesSnapshot(configStore).managedOnly;
  const invocation: TurnSkillInvocation = Object.freeze({
    name,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    allowedTools: Object.freeze(
      managedOnly ? [] : [...new Set([...grants, invokedSkill])],
    ),
  });
  return Object.freeze({
    overrides: Object.freeze({
      invocation,
      ...(modelInfo !== undefined ? { modelInfo } : {}),
    }),
    withheldGrants: Object.freeze(managedOnly ? grants : []),
  });
}
