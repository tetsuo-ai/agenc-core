export const BRIDGE_SAFE_COMMAND_NAMES: readonly string[] = Object.freeze([
  "clear",
  "diff",
  "help",
  "hello",
  "model",
  "provider",
  "status",
]);

type BridgeCommand = {
  readonly name: string;
  readonly type: "local" | "local-jsx" | "prompt";
};

export function isBridgeSafeCommand(command: string | BridgeCommand): boolean {
  if (typeof command === "string") {
    return BRIDGE_SAFE_COMMAND_NAMES.includes(command);
  }
  return command.type === "local" && BRIDGE_SAFE_COMMAND_NAMES.includes(command.name);
}

export function isBridgeForwardablePromptCommand(command: BridgeCommand): boolean {
  return command.type === "prompt";
}
