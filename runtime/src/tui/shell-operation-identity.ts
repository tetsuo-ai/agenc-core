const SHELL_TOOLS = new Set(["Bash", "system.bash", "exec_command", "Run", "shell", "shell_command", "local_shell"]);

function stableValue(value: unknown, ancestors = new Set<object>()): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value !== "object" || value === undefined) return null;
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map(item => stableValue(item, ancestors));
      return items.some(item => item === null) ? null : `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = stableValue((value as Record<string, unknown>)[key], ancestors);
      if (item === null) return null;
      entries.push(`${JSON.stringify(key)}:${item}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function shellOperationIdentity(toolName: string, input: unknown): string | null {
  if (!SHELL_TOOLS.has(toolName) || input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const command = record.cmd ?? record.command ?? record.argv;
  const validCommand = typeof command === "string"
    ? command.trim().length > 0
    : Array.isArray(command) && command.length > 0 && command.every(argument => typeof argument === "string");
  if (!validCommand) return null;
  const operation = Object.fromEntries(Object.entries(record).filter(([key, value]) =>
    value !== undefined && !["description", "justification", "yield_time_ms", "max_output_tokens"].includes(key),
  ));
  if (typeof command === "string") {
    const commandKey = record.cmd !== undefined ? "cmd" : record.command !== undefined ? "command" : "argv";
    operation[commandKey] = command.trim();
  }
  const encoded = stableValue(operation);
  return encoded === null ? null : `${toolName}\u0000${encoded}`;
}
