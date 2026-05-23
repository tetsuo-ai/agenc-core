export function approvalInputText(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "input", "query", "path", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
