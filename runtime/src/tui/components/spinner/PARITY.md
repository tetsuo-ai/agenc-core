# Spinner / Shimmer Primitives Parity

Checklist item: T-17

Absorbed from the donor TUI spinner cluster into AgenC-owned TUI paths:

- `src/components/Spinner.tsx` -> `runtime/src/tui/components/spinner/Spinner.tsx`
- `src/components/Spinner/*` -> `runtime/src/tui/components/spinner/*`

The donor `Spinner/index.ts` re-export barrel is intentionally not preserved.
AgenC callers import the concrete spinner modules directly, and `types.ts`
defines the local type surface used by those modules.
