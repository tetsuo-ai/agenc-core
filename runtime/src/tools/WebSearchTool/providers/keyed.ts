import { firecrawlProvider } from './firecrawl.js'
import { tavilyProvider } from './tavily.js'
import { exaProvider } from './exa.js'
import { youProvider } from './you.js'
import { jinaProvider } from './jina.js'
import { bingProvider } from './bing.js'
import { mojeekProvider } from './mojeek.js'
import { linkupProvider } from './linkup.js'
import { keenableProvider } from './keenable.js'
import type { SearchProvider } from './types.js'

/** Shared priority for both the live daemon and legacy TUI search tools. */
export const KEYED_SEARCH_PROVIDERS: readonly SearchProvider[] = [
  firecrawlProvider, tavilyProvider, exaProvider, youProvider,
  jinaProvider, bingProvider, mojeekProvider, linkupProvider,
  keenableProvider,
]
