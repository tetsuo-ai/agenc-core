import type { CliRouteDescriptor } from "./route-types.js";

const SHELL_ROOTS = new Set([
  "resume",
  "plan",
  "agents",
  "tasks",
  "files",
  "grep",
  "git",
  "branch",
  "worktree",
  "diff",
  "review",
  "permissions",
  "mcp",
  "skills",
  "model",
  "effort",
  "session",
]);

const routeShell: CliRouteDescriptor = {
  name: "shell",
  matches(parsed) {
    const root = parsed.positional[0];
    return root !== undefined && SHELL_ROOTS.has(root);
  },
  load: () =>
    import("./route-shell.impl.js").then((module) => module.routeModule),
};

export default routeShell;
