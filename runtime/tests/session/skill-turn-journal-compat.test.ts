/**
 * A skill turn's journal record (`turn_context.skillInvocation`) keeps the
 * journal readable by AgenC Core 0.19.25: its turn-context schema ignores
 * fields it does not know. This runtime validates and reads the record back.
 * The 0.19.25 side is the frozen copy in helpers/journal-0.19.25.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { admitSkillInvocation } from "../../src/app-server/background-agent-runner/skill-invocation.js";
import { parseRolloutLine, type RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import {
  readSkillInvocationRecord,
  type SkillInvocationSettings,
} from "../../src/session/skill-invocation.js";
import { toTurnContextItem } from "../../src/session/turn-context.js";
import { validateCanonicalJournalText } from "../../src/state/recovery-journal-contract.js";
import { VERSION } from "../../src/version.js";
import {
  acceptsJournalLine01925,
  isTurnContext01925,
  TURN_CONTEXT_FIELDS_0_19_25,
} from "../helpers/journal-0.19.25.js";
import {
  deepSeekSkillTurnSession,
  removeSkillTurnHomes,
} from "../helpers/skill-turn-session.js";

const DEEP_REVIEW: SkillInvocationSettings = {
  name: "deep-review",
  source: "userSettings",
  model: "deepseek-v4-pro",
  effort: "low",
  allowedTools: ["Write"],
};

const roots: string[] = [];

afterEach(() => {
  removeSkillTurnHomes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill turn journal compatibility", () => {
  test("a journal holding a skill turn stays readable by 0.19.25 and keeps the skill for this runtime", async () => {
    const session = deepSeekSkillTurnSession();
    const admitted = await admitSkillInvocation(
      session,
      session.services.configStore!,
      DEEP_REVIEW,
    );
    const turn = session.newSkillInvocationTurn(admitted.overrides);
    const item = toTurnContextItem(turn);
    expect(item.skillInvocation).toEqual({
      name: "deep-review",
      source: "userSettings",
      requested: { model: "deepseek-v4-pro", effort: "low", allowedTools: ["Write"] },
      model: "deepseek-v4-pro",
      effort: "low",
      allowedTools: ["Write", "Skill(deep-review)"],
    });
    expect(toTurnContextItem(session.newDefaultTurn())).not.toHaveProperty("skillInvocation");

    const home = mkdtempSync(join(tmpdir(), "agenc-skill-journal-"));
    roots.push(home);
    const rollout = new RolloutStore({
      cwd: home,
      sessionId: "skill-journal",
      agencVersion: VERSION,
      agencHome: home,
      sessionTempRoot: tmpdir(),
      autoStartScheduler: false,
    });
    rollout.open({
      sessionId: "skill-journal",
      timestamp: new Date().toISOString(),
      cwd: home,
      originator: "agenc-cli",
      agencVersion: VERSION,
      model: "deepseek-flash",
      modelProvider: "deepseek",
    });
    // The turn's context goes to the journal twice, as the runtime writes it:
    // as the turn_context event and as the turn's rollout baseline.
    rollout.append({ id: "started", msg: { type: "turn_started", payload: { turnId: turn.subId } } });
    rollout.append({ id: "context", msg: { type: "turn_context", payload: item } });
    rollout.appendRollout({ type: "turn_context", payload: item });
    rollout.close();
    const text = readFileSync(rollout.rolloutPath, "utf8");

    // This runtime's strict reader accepts it.
    expect(validateCanonicalJournalText(text)).toBeDefined();

    // 0.19.25 accepts every line; the only turn-context field it does not
    // know is the skill record, which it ignores.
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => !acceptsJournalLine01925(line))).toEqual([]);
    const contexts = lines.flatMap((line) => {
      if (line.type === "turn_context") return [line.payload as Record<string, unknown>];
      const msg = (line.payload as { msg?: { type?: string; payload?: unknown } } | undefined)?.msg;
      return msg?.type === "turn_context" ? [msg.payload as Record<string, unknown>] : [];
    });
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(Object.keys(context).filter((field) => !TURN_CONTEXT_FIELDS_0_19_25.has(field)))
        .toEqual(["skillInvocation"]);
    }
    // The frozen validator is live: it still refuses a broken known field.
    expect(isTurnContext01925({ ...contexts[0], model: 7 })).toBe(false);

    // This runtime reads the record back for a durable resume.
    const items = text.trim().split("\n")
      .map((line) => parseRolloutLine(line))
      .filter((entry): entry is RolloutItem => entry !== null);
    const baseline = items.find((entry) => entry.type === "turn_context");
    expect(baseline?.type).toBe("turn_context");
    expect(readSkillInvocationRecord(
      (baseline as Extract<RolloutItem, { type: "turn_context" }>).payload.skillInvocation,
    )).toEqual(item.skillInvocation);
  });

  test("an unreadable skill record is refused by the resume reader, not by the journal reader", () => {
    expect(readSkillInvocationRecord({ name: "x", requested: {}, allowedTools: [], source: "elsewhere" }))
      .toBeNull();
    expect(readSkillInvocationRecord({ name: "x", requested: {}, allowedTools: ["Write"], effort: "turbo" }))
      .toBeNull();
    expect(readSkillInvocationRecord({ name: "x", allowedTools: [] })).toBeNull();
    expect(readSkillInvocationRecord("deep-review")).toBeNull();
    expect(readSkillInvocationRecord({
      name: "x", requested: { allowedTools: ["Write"] }, allowedTools: ["Write"], effort: "model_default",
    })).toEqual({
      name: "x", requested: { allowedTools: ["Write"] }, allowedTools: ["Write"], effort: "model_default",
    });
  });
});
