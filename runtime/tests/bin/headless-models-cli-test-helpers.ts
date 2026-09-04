export function captureHeadlessModelsCliIo<TIo>(fetchImpl: unknown): {
  readonly io: TIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: { write: (value: string) => (stdout += value) },
    stderr: { write: (value: string) => (stderr += value) },
    fetchImpl,
  } as unknown as TIo;
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function lastHeadlessJson(output: string): Record<string, unknown> {
  const lines = output.split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}
