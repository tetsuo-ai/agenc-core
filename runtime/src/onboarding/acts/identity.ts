/**
 * Onboarding Act 2a — "name your agent" (onboarding-plan-2026-07 O-2).
 *
 * Scaffolds the persona workspace (task 13's convention) and then runs the
 * BOOTSTRAP naming ritual LIVE so the user watches the agent choose its own
 * name and write IDENTITY.md. The act only writes files that do not exist —
 * an existing persona is shown, never clobbered — and the ritual's
 * exactly-once gate (IDENTITY.md existence) is surfaced, not bypassed.
 *
 * The ritual turn runs headless (`agenc -p --permission-mode acceptEdits`)
 * inside the freshly-created, freshly-TRUSTED workspace: acceptEdits is the
 * narrowest mode that lets the agent write IDENTITY.md, and the wizard says
 * so out loud before running it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { trustProjectSync } from "../../permissions/trust/project-trust.js";
import type { ActIO } from "./io.js";
import { markOnboardingActComplete } from "./state.js";

export interface IdentityActOptions {
  readonly agencHome: string;
  readonly io: ActIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: the ritual turn (default spawns `agenc -p` in the workspace). */
  readonly runRitualTurn?: (workspace: string) => Promise<RitualTurnResult>;
  /** Test seam: workspace default suggestion. */
  readonly defaultWorkspace?: string;
}

export interface RitualTurnResult {
  readonly ok: boolean;
  readonly output: string;
}

const SOUL_TONES: Readonly<Record<string, string>> = {
  direct:
    "Be direct and precise. Lead with the answer; skip filler and hedging.",
  warm:
    "Be warm and encouraging. Explain your thinking; celebrate progress without flattery.",
  terse:
    "Be terse. Short sentences. No preamble, no summaries unless asked.",
};

function soulTemplate(tone: string, verbosity: string): string {
  return [
    "# Soul",
    "",
    SOUL_TONES[tone] ?? SOUL_TONES.direct,
    verbosity === "detailed"
      ? "Prefer thorough answers with reasoning shown."
      : "Prefer concise answers; expand only when asked.",
    "",
    "Boundaries: never take irreversible actions without asking. When unsure,",
    "say so plainly instead of guessing.",
    "",
  ].join("\n");
}

function userTemplate(name: string, context: string): string {
  return [
    "# User",
    "",
    `The human you work for is ${name}.`,
    ...(context.length > 0 ? ["", context] : []),
    "",
  ].join("\n");
}

const BOOTSTRAP_TEMPLATE = [
  "# Bootstrap",
  "",
  "This is your first run in this workspace. Choose a name for yourself —",
  "one you like, fitting the soul described in SOUL.md. Introduce yourself",
  "to your human in two or three sentences: your name, how you see your",
  "role, and one thing you are looking forward to helping with.",
  "",
].join("\n");

function defaultRunRitualTurn(workspace: string): Promise<RitualTurnResult> {
  // The wizard IS the agenc CLI: re-invoke our own entrypoint for one
  // headless turn inside the workspace. acceptEdits lets the agent write
  // IDENTITY.md (and tidy BOOTSTRAP.md); the workspace was trusted above.
  const entry = process.argv[1];
  const result = spawnSync(
    process.execPath,
    [
      entry,
      "-p",
      "--permission-mode",
      "acceptEdits",
      "Complete the bootstrap ritual now: introduce yourself and record your identity as instructed.",
    ],
    { cwd: workspace, encoding: "utf8", timeout: 180_000 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return Promise.resolve({ ok: result.status === 0, output });
}

export async function runIdentityAct(
  options: IdentityActOptions,
): Promise<number> {
  const { io } = options;
  const env = options.env ?? process.env;
  const runRitual = options.runRitualTurn ?? defaultRunRitualTurn;

  io.say("");
  io.say("── Name your agent ──────────────────────────────────────────");
  io.say("Your agent gets a home directory. Files there define who it is:");
  io.say("  SOUL.md (personality) · USER.md (you) · IDENTITY.md (its name,");
  io.say("  written by the agent itself in a one-time naming ritual).");
  io.say("");

  const suggested =
    options.defaultWorkspace ?? join(env.HOME ?? homedir(), "agent");
  const answered = await io.ask("Where should your agent live?", suggested);
  const workspace = isAbsolute(answered)
    ? answered
    : resolve(env.HOME ?? homedir(), answered);
  mkdirSync(workspace, { recursive: true });

  // Trust the workspace so sessions there start without the trust prompt.
  trustProjectSync({ agencHome: options.agencHome, env, projectRoot: workspace });
  // Best-effort git init: history for persona edits, and a project-root marker.
  if (!existsSync(join(workspace, ".git"))) {
    spawnSync("git", ["init", "-q"], { cwd: workspace });
  }

  // SOUL.md — 3 quick choices, never clobbered.
  const soulPath = join(workspace, "SOUL.md");
  if (existsSync(soulPath)) {
    io.say(`SOUL.md already exists — keeping it (edit ${soulPath} any time).`);
  } else {
    const tone = await io.select("Pick a personality baseline:", [
      { key: "direct", label: "Direct", hint: "answer-first, no filler" },
      { key: "warm", label: "Warm", hint: "encouraging, shows reasoning" },
      { key: "terse", label: "Terse", hint: "short sentences, no preamble" },
    ]);
    const verbosity = await io.select("Default verbosity:", [
      { key: "concise", label: "Concise" },
      { key: "detailed", label: "Detailed" },
    ]);
    writeFileSync(soulPath, soulTemplate(tone, verbosity));
    io.say(`Wrote ${soulPath}`);
  }

  // USER.md — who the human is, never clobbered.
  const userPath = join(workspace, "USER.md");
  if (existsSync(userPath)) {
    io.say("USER.md already exists — keeping it.");
  } else {
    const name = await io.ask("What should the agent call you?", "friend");
    const context = await io.ask(
      "One line of context about you (optional)",
      "",
    );
    writeFileSync(userPath, userTemplate(name, context));
    io.say(`Wrote ${userPath}`);
  }

  // The naming ritual — mechanically once (IDENTITY.md existence gate).
  const identityPath = join(workspace, "IDENTITY.md");
  if (existsSync(identityPath)) {
    const identity = readFileSync(identityPath, "utf8").trim().split("\n")[0];
    io.say("");
    io.say(`This agent already has an identity: ${identity}`);
    io.say(`(Edit ${identityPath} to change it — the ritual never re-runs.)`);
  } else {
    const bootstrapPath = join(workspace, "BOOTSTRAP.md");
    if (!existsSync(bootstrapPath)) {
      writeFileSync(bootstrapPath, BOOTSTRAP_TEMPLATE);
    }
    io.say("");
    io.say("Ready for the naming ritual: one live turn in the new workspace.");
    io.say("(Runs with acceptEdits so the agent can write IDENTITY.md there.)");
    const go = await io.confirm("Run it now?", true);
    if (go) {
      io.say("… running (this is a real model turn) …");
      const result = await runRitual(workspace);
      if (result.output.length > 0) {
        io.say("");
        io.say(result.output);
        io.say("");
      }
      if (result.ok && existsSync(identityPath)) {
        io.say(
          `IDENTITY.md written by the agent itself. That name is now part of every conversation in ${workspace}.`,
        );
      } else if (result.ok) {
        io.say(
          "The turn ran but IDENTITY.md was not written — the ritual will re-offer on the agent's next session in this workspace.",
        );
      } else {
        io.say(
          "The ritual turn failed (see output above). BOOTSTRAP.md stays in place — the agent will pick it up on its next session here.",
        );
      }
    } else {
      io.say(
        "Skipped — the agent will run the ritual on its first real session in this workspace.",
      );
    }
  }

  markOnboardingActComplete(options.agencHome, "identity", { workspace });
  io.say("");
  io.say("Editing these files IS the API: change SOUL.md/USER.md any time;");
  io.say("changes apply from the next new conversation.");
  return 0;
}
