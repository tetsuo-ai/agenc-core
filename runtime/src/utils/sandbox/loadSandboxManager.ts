import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Node 26 can require this ESM package synchronously. Keep its singleton and
// checks intact, but avoid loading its proxy/CA graph until a manager is used.
export function loadSandboxManager(): typeof import('@anthropic-ai/sandbox-runtime').SandboxManager {
  return (require('@anthropic-ai/sandbox-runtime') as typeof import('@anthropic-ai/sandbox-runtime')).SandboxManager
}
