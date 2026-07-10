/**
 * Interactive IO for onboarding acts (onboarding-plan-2026-07 §4).
 *
 * The acts (identity/channel/autonomy) are plain readline flows, NOT Ink —
 * they run after the first-run TUI wizard, are re-enterable from the shell
 * (`agenc onboard identity|channel|autonomy`), and must be deterministic
 * under test. Everything interactive goes through this seam; tests inject
 * a scripted implementation and never touch a real terminal.
 *
 * ONE readline interface lives for the whole act: creating an interface per
 * question loses buffered lines on piped (non-TTY) stdin — the first
 * interface swallows the entire pipe. (Found live; pinned by test.)
 */

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

export interface ActSelectChoice {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ActIO {
  /** Print a line to the user. */
  say(line: string): void;
  /** Free-text question; empty input returns `fallback` when provided. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Secret question (input not echoed on a TTY). */
  askSecret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** Numbered menu; returns the chosen key. */
  select(question: string, choices: readonly ActSelectChoice[]): Promise<string>;
  /** Release the underlying terminal. Idempotent. */
  close(): void;
}

export function createTerminalActIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): ActIO {
  // Mutable echo gate for secret prompts: readline echoes what the user
  // types through THIS stream, so muting it hides the secret while the
  // prompt itself is written directly to the real output.
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  const isTty = (input as { isTTY?: boolean }).isTTY === true;
  let rl: Interface | null = createInterface({
    input,
    output: echo,
    terminal: isTty,
  });
  // Buffer lines that arrive before a question is pending: piped stdin
  // delivers everything instantly, long before the prompts render.
  const bufferedLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else bufferedLines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });
  const nextLine = (): Promise<string> => {
    const buffered = bufferedLines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.resolve("");
    return new Promise((resolve) => waiters.push(resolve));
  };
  const write = (text: string) => output.write(text);
  const question = async (prompt: string, secret: boolean): Promise<string> => {
    write(prompt);
    if (secret) muted = true;
    const answer = await nextLine();
    if (secret) {
      muted = false;
      write("\n");
    }
    return answer.trim();
  };

  return {
    say: (line) => write(`${line}\n`),
    async ask(q, fallback) {
      const suffix = fallback !== undefined ? ` [${fallback}]` : "";
      const answer = await question(`${q}${suffix}: `, false);
      return answer.length > 0 ? answer : (fallback ?? "");
    },
    askSecret: (q) => question(`${q}: `, true),
    async confirm(q, fallback) {
      const suffix = fallback ? " [Y/n]" : " [y/N]";
      const answer = (await question(`${q}${suffix}: `, false)).toLowerCase();
      if (answer.length === 0) return fallback;
      return answer === "y" || answer === "yes";
    },
    async select(q, choices) {
      write(`${q}\n`);
      choices.forEach((choice, index) => {
        write(
          `  ${index + 1}) ${choice.label}${choice.hint !== undefined ? `  — ${choice.hint}` : ""}\n`,
        );
      });
      for (;;) {
        const answer = await question(`Choose [1-${choices.length}]: `, false);
        const index = Number.parseInt(answer, 10) - 1;
        const choice = choices[index];
        if (choice !== undefined) return choice.key;
        const byKey = choices.find((c) => c.key === answer);
        if (byKey !== undefined) return byKey.key;
        write("  Please pick one of the listed numbers.\n");
      }
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

/** Scripted IO for tests: queued answers, captured output. */
export function createScriptedActIO(answers: readonly string[]): {
  io: ActIO;
  output: string[];
} {
  const queue = [...answers];
  const output: string[] = [];
  const next = (): string => {
    const answer = queue.shift();
    if (answer === undefined) {
      throw new Error(
        `scripted ActIO ran out of answers; output so far:\n${output.join("\n")}`,
      );
    }
    return answer;
  };
  return {
    output,
    io: {
      say: (line) => {
        output.push(line);
      },
      async ask(q, fallback) {
        output.push(`ask: ${q}`);
        const answer = next();
        return answer.length > 0 ? answer : (fallback ?? "");
      },
      async askSecret(q) {
        output.push(`secret: ${q}`);
        return next();
      },
      async confirm(q, fallback) {
        output.push(`confirm: ${q}`);
        const answer = next().toLowerCase();
        if (answer.length === 0) return fallback;
        return answer === "y" || answer === "yes";
      },
      async select(q, choices) {
        output.push(`select: ${q} (${choices.map((c) => c.key).join("|")})`);
        return next();
      },
      close: () => {},
    },
  };
}
