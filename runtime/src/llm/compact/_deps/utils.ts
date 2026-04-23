/**
 * Minimal utility replacements for what `runtime/src/llm/compact/**`
 * actually uses out of the openclaude-port utils tree. Each function
 * implements only the surface the compact subsystem reaches for, not
 * the full upstream API.
 */

export function sleep(
  ms: number,
  signal?: AbortSignal,
  _opts?: unknown,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function logForDebugging(message: string, _opts?: unknown): void {
  if (process.env.AGENC_COMPACT_DEBUG === "1") {
    process.stderr.write(`[compact] ${message}\n`);
  }
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[compact:error] ${message}\n`);
}

export function hasExactErrorMessage(
  error: unknown,
  expected: string,
): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message === expected;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function expandPath(p: string, baseDir?: string): string {
  if (!p) return p;
  let out = p;
  if (out.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    out = home + out.slice(1);
  } else if (out === "~") {
    out = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  }
  if (!out.startsWith("/") && baseDir) {
    out = `${baseDir.replace(/\/$/, "")}/${out}`;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asSystemPrompt(text: string | readonly string[]): any {
  if (typeof text === "string") return [text];
  return text;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cacheToObject(cache: Map<unknown, unknown> | undefined): any {
  if (!cache) return {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = {};
  for (const [k, v] of cache.entries()) out[String(k)] = v;
  return out;
}
