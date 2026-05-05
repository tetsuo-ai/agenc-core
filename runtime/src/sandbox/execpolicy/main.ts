import { runExecPolicyCheckCommand, type ExecPolicyCheckCommand } from "./execpolicycheck.js";

export function parseExecPolicyArgv(argv: readonly string[]): ExecPolicyCheckCommand {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "check") {
    throw new Error("usage: agenc-execpolicy check --rules PATH [--pretty] [--resolve-host-executables] -- COMMAND...");
  }
  const rules: string[] = [];
  let pretty = false;
  let resolveHostExecutables = false;
  const command: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (command.length > 0) {
      command.push(arg);
      continue;
    }
    switch (arg) {
      case "-r":
      case "--rules": {
        const value = rest[index + 1];
        if (value === undefined || value.length === 0) {
          throw new Error(`${arg} requires a policy path`);
        }
        rules.push(value);
        index += 1;
        break;
      }
      case "--pretty":
        pretty = true;
        break;
      case "--resolve-host-executables":
        resolveHostExecutables = true;
        break;
      case "--":
        command.push(...rest.slice(index + 1));
        index = rest.length;
        break;
      default:
        if (arg.startsWith("-") && rules.length === 0) {
          throw new Error(`unknown agenc-execpolicy check option: ${arg}`);
        }
        command.push(...rest.slice(index));
        index = rest.length;
        break;
    }
  }

  if (rules.length === 0) {
    throw new Error("agenc-execpolicy check requires at least one --rules PATH");
  }
  if (command.length === 0) {
    throw new Error("agenc-execpolicy check requires command tokens");
  }
  return { rules, pretty, resolveHostExecutables, command };
}

export function runExecPolicyCli(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    runExecPolicyCheckCommand(parseExecPolicyArgv(argv));
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
