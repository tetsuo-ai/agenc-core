export type PickerCommandIntent =
  | { readonly kind: "model" }
  | { readonly kind: "model-provider" }
  | { readonly kind: "permissions"; readonly stage: "root" | "mode" }
  | { readonly kind: "config"; readonly stage: "root" | "profile" }
  | { readonly kind: "exit-worktree" };

export function readPickerCommandIntent(
  input: string,
): PickerCommandIntent | null {
  const trimmed = input.trim();
  switch (trimmed) {
    case "/model":
      return { kind: "model" };
    case "/model-provider":
    case "/provider":
      return { kind: "model-provider" };
    case "/permissions":
      return { kind: "permissions", stage: "root" };
    case "/permissions mode":
      return { kind: "permissions", stage: "mode" };
    case "/config":
      return { kind: "config", stage: "root" };
    case "/config profile":
      return { kind: "config", stage: "profile" };
    case "/exit-worktree":
      return { kind: "exit-worktree" };
    default:
      return null;
  }
}

export function slashCommandOpensPicker(value: string): boolean {
  return readPickerCommandIntent(value) !== null;
}
