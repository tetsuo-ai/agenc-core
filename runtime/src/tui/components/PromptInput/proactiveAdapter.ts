import { createRequire } from 'node:module'

type ProactiveModule = {
  subscribeToProactiveChanges?: (cb: () => void) => () => void
  getNextTickAt?: () => number | null
  isProactiveActive?: () => boolean
}

const requireFromHere = createRequire(import.meta.url)
let cachedModule: ProactiveModule | null | undefined

function loadProactiveModule(): ProactiveModule | null {
  if (cachedModule !== undefined) return cachedModule
  try {
    cachedModule = requireFromHere(
      '../../../agenc/upstream/' + 'proactive/index.js',
    ) as ProactiveModule
  } catch {
    cachedModule = null
  }
  return cachedModule
}

export function isPromptInputProactiveActive(): boolean {
  return loadProactiveModule()?.isProactiveActive?.() ?? false
}

export function subscribeToPromptInputProactiveChanges(
  cb: () => void,
): () => void {
  return loadProactiveModule()?.subscribeToProactiveChanges?.(cb) ?? (() => {})
}

export function getPromptInputProactiveNextTickAt(): number | null {
  return loadProactiveModule()?.getNextTickAt?.() ?? null
}
