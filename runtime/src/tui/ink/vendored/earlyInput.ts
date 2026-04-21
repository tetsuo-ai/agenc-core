/**
 * Vendored stub for early-input capture. The upstream reads keystrokes
 * buffered before Ink mounts; the AgenC runtime does not use that path yet,
 * so stopCapturingEarlyInput is a no-op. Kept as a distinct module so the
 * ported App.tsx import resolves.
 */

export function stopCapturingEarlyInput(): void {
  // No-op — AgenC does not pre-capture stdin before Ink mounts.
}
