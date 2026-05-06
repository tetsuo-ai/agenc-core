export interface ByokPrecedenceApiKeyInput {
  readonly explicitApiKey?: string;
  readonly byokApiKey?: string;
  readonly managedKeysEnabled?: boolean;
  readonly managedApiKey?: string;
}

export function selectByokPrecedenceApiKey(
  input: ByokPrecedenceApiKeyInput,
): string | undefined {
  return (
    nonEmpty(input.explicitApiKey) ??
    nonEmpty(input.byokApiKey) ??
    (input.managedKeysEnabled ? nonEmpty(input.managedApiKey) : undefined)
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
