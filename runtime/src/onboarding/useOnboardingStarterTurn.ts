import { useEffect, useRef } from "react";

export function useOnboardingStarterTurn(options: {
  readonly active: boolean;
  readonly connectionReady: boolean;
  readonly hasInitialPrompt: boolean;
  readonly submit: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}): void {
  const wasActive = useRef(false);
  const { active, connectionReady, hasInitialPrompt, submit, onError } = options;
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    // Configure later completes the wizard without admitting a model turn.
    // A later login must not resurrect this automatic submission either.
    if (!connectionReady || hasInitialPrompt) return;
    void submit().catch(onError);
  }, [active, connectionReady, hasInitialPrompt, submit, onError]);
}
