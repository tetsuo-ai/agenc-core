# Web Search Providers

AgenC supports multiple search backends through a provider adapter system in
`runtime/src/tools/WebSearchTool/providers/`.

## Selection model (read this first)

`WEB_SEARCH_PROVIDER` chooses **how** backends are selected:

| Mode | Behavior |
|---|---|
| `auto` (default) | Try **configured** first-party providers in priority order; fall through on failure |
| `firecrawl` / `tavily` / `exa` / `you` / `jina` / `bing` / `mojeek` / `linkup` / `ddg` | That provider only — throws on failure |
| `custom` | Custom HTTP / `WEB_PROVIDER` preset only — throws on failure. **Not in the auto chain** |
| `native` | Provider-native web search only (requires firstParty / Vertex / Foundry provider) |

**Auto chain (only):**

```text
firecrawl → tavily → exa → you → jina → bing → mojeek → linkup → ddg
```

DuckDuckGo is last (free, rate-limited). Each step runs only when that
provider `isConfigured()` (API key present for key-based providers; DDG is
always available).

> **Critical:** Brave, Google Custom Search, SearXNG, and SerpAPI are **custom
> presets**, not auto-chain members. They only run when
> `WEB_SEARCH_PROVIDER=custom` **and** `WEB_PROVIDER=<preset>` (or a fully
> hand-configured custom endpoint). Setting `WEB_PROVIDER=brave` alone under
> `auto` does nothing for those presets.

## Supported providers

| Provider | Mode / env | Auth | Method | In auto chain? |
|---|---|---|---|---|
| Firecrawl | `FIRECRAWL_API_KEY` | Internal SDK | SDK | yes |
| Tavily | `TAVILY_API_KEY` | `Authorization: Bearer` | POST | yes |
| Exa | `EXA_API_KEY` | `x-api-key` | POST | yes |
| You.com | `YOU_API_KEY` | `X-API-Key` | GET | yes |
| Jina | `JINA_API_KEY` | `Authorization: Bearer` | GET | yes |
| Bing | `BING_API_KEY` | `Ocp-Apim-Subscription-Key` | GET | yes |
| Mojeek | `MOJEEK_API_KEY` | `Authorization: Bearer` (optional) | GET | yes |
| Linkup | `LINKUP_API_KEY` | `Authorization: Bearer` | POST | yes |
| DuckDuckGo | *(no key)* | — | SDK | yes (last) |
| Custom HTTP | `WEB_SEARCH_PROVIDER=custom` + `WEB_SEARCH_API` / `WEB_URL_TEMPLATE` | Configurable | GET/POST | **no** |
| SearXNG preset | `WEB_SEARCH_PROVIDER=custom` + `WEB_PROVIDER=searxng` | — | GET | **no** |
| Google CSE preset | `WEB_SEARCH_PROVIDER=custom` + `WEB_PROVIDER=google` | `Authorization: Bearer` | GET | **no** |
| Brave preset | `WEB_SEARCH_PROVIDER=custom` + `WEB_PROVIDER=brave` | `X-Subscription-Token` | GET | **no** |
| SerpAPI preset | `WEB_SEARCH_PROVIDER=custom` + `WEB_PROVIDER=serpapi` | `Authorization: Bearer` | GET | **no** |

## Quick start

### Auto-chain providers (recommended)

```bash
# Tavily (fast, RAG-ready) — participates in auto when the key is set
export TAVILY_API_KEY=tvly-your-key

# Exa (neural / semantic)
export EXA_API_KEY=your-exa-key

# Bing
export BING_API_KEY=your-bing-key

# Firecrawl / You.com / Jina / Mojeek / Linkup — same pattern: set their *_API_KEY
# DuckDuckGo needs no key and is the auto fallback when nothing else is configured

# Fail loudly if Tavily is down (don't fall through)
export WEB_SEARCH_PROVIDER=tavily

# Explicit auto (default)
export WEB_SEARCH_PROVIDER=auto
```

### Custom-mode presets (Brave / Google / SearXNG / SerpAPI)

These **require** `WEB_SEARCH_PROVIDER=custom`. Without it, `WEB_PROVIDER` is
ignored by the selection chain.

```bash
# Brave
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=brave
export WEB_KEY=your-brave-key

# Google Custom Search
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=google
export WEB_KEY=your-google-api-key
# Optional: override endpoint / cx via WEB_SEARCH_API / WEB_PARAMS if needed

# Self-hosted SearXNG (free, private)
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.example.com/search
# If SearXNG is on a private IP:
export WEB_CUSTOM_ALLOW_PRIVATE=true

# SerpAPI
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=serpapi
export WEB_KEY=your-serpapi-key
```

### Fully custom HTTP endpoint

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_SEARCH_API=https://api.example.com/search
export WEB_QUERY_PARAM=q
export WEB_KEY=your-key   # optional; Authorization: Bearer by default
```

## Provider request & response formats

### Tavily

```bash
export TAVILY_API_KEY=tvly-your-key
```

**Request:**
```
POST https://api.tavily.com/search
Authorization: Bearer tvly-your-key
Content-Type: application/json

{"query": "search terms", "max_results": 15, "include_answer": false}
```

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "content": "Full text snippet from the page...",
      "score": 0.95
    }
  ]
}
```

### Exa

```bash
export EXA_API_KEY=your-exa-key
```

**Request:**
```
POST https://api.exa.ai/search
x-api-key: your-exa-key
Content-Type: application/json

{"query": "search terms", "numResults": 15, "type": "auto"}
```

`allowed_domains` / `blocked_domains` are passed to Exa server-side as
`includeDomains` / `excludeDomains` (so Exa does the domain filtering, not the
shared post-filter).

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "snippet": "A short summary of the page content...",
      "score": 0.89
    }
  ]
}
```

### You.com

```bash
export YOU_API_KEY=your-you-key
```

**Request:**
```
GET https://api.ydc-index.io/v1/search?query=search+terms&num_web_results=10
X-API-Key: your-you-key
```

**Response:**
```json
{
  "results": {
    "web": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "snippets": ["First snippet from the page...", "Second snippet..."],
        "description": "Page description"
      }
    ]
  }
}
```

### Jina

```bash
export JINA_API_KEY=your-jina-key
```

**Request:**
```
GET https://s.jina.ai/?q=search+terms&count=10
Authorization: Bearer your-jina-key
Accept: application/json
```

**Response:**
```json
{
  "data": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "description": "Snippet from the page..."
    }
  ]
}
```

### Bing

```bash
export BING_API_KEY=your-bing-key
```

**Request:**
```
GET https://api.bing.microsoft.com/v7.0/search?q=search+terms&count=15
Ocp-Apim-Subscription-Key: your-bing-key
```

**Response:**
```json
{
  "webPages": {
    "value": [
      {
        "name": "Result Title",
        "url": "https://example.com/page",
        "snippet": "A short excerpt from the page...",
        "displayUrl": "example.com/page"
      }
    ]
  }
}
```

### Mojeek

```bash
export MOJEEK_API_KEY=your-mojeek-key
```

**Request:**
```
GET https://www.mojeek.com/search?q=search+terms&fmt=json&t=10
Accept: application/json
Authorization: Bearer your-mojeek-key   # only sent when MOJEEK_API_KEY is set
```

**Response:**
```json
{
  "response": {
    "results": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "snippet": "Excerpt from the page..."
      }
    ]
  }
}
```

### Linkup

```bash
export LINKUP_API_KEY=your-linkup-key
```

**Request:**
```
POST https://api.linkup.so/v1/search
Authorization: Bearer your-linkup-key
Content-Type: application/json

{"q": "search terms", "search_type": "standard", "depth": "standard"}
```

**Response:**
```json
{
  "results": [
    {
      "name": "Result Title",
      "url": "https://example.com/page",
      "snippet": "A short description of the result..."
    }
  ]
}
```

### SearXNG (custom preset)

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.example.com/search
```

**Request:**
```
GET https://search.example.com/search?q=search+terms
```

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "content": "Snippet from the page...",
      "engine": "google"
    }
  ]
}
```

### Google Custom Search (custom preset)

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=google
export WEB_KEY=your-google-api-key
```

**Request:**
```
GET https://www.googleapis.com/customsearch/v1?q=search+terms
Authorization: Bearer your-google-api-key
```

**Response:**
```json
{
  "items": [
    {
      "title": "Result Title",
      "link": "https://example.com/page",
      "snippet": "A short excerpt...",
      "displayLink": "example.com"
    }
  ]
}
```

### Brave (custom preset)

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=brave
export WEB_KEY=your-brave-key
```

**Request:**
```
GET https://api.search.brave.com/res/v1/web/search?q=search+terms
X-Subscription-Token: your-brave-key
```

**Response:**
```json
{
  "web": {
    "results": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "description": "Page description..."
      }
    ]
  }
}
```

### SerpAPI (custom preset)

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=serpapi
export WEB_KEY=your-serpapi-key
```

**Request:**
```
GET https://serpapi.com/search.json?q=search+terms
Authorization: Bearer your-serpapi-key
```

**Response:**
```json
{
  "organic_results": [
    {
      "title": "Result Title",
      "link": "https://example.com/page",
      "snippet": "A short excerpt...",
      "displayed_link": "example.com"
    }
  ]
}
```

### DuckDuckGo (default free fallback)

No configuration needed. Uses the `duck-duck-scrape` npm package. Always last
in the auto chain; also available as an explicit-only backend:

```bash
export WEB_SEARCH_PROVIDER=ddg
```

---

## Custom API configuration

Always set `WEB_SEARCH_PROVIDER=custom` for these paths.

### Standard GET

```
GET https://api.example.com/search?q=hello
```

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_SEARCH_API=https://api.example.com/search
export WEB_QUERY_PARAM=q
```

### Query in URL path

```
GET https://api.example.com/v2/search/hello
```

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_URL_TEMPLATE=https://api.example.com/v2/search/{query}
```

### POST with custom body

```
POST https://api.example.com/v1/query
Content-Type: application/json

{"input": {"text": "hello"}}
```

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_SEARCH_API=https://api.example.com/v1/query
export WEB_METHOD=POST
export WEB_BODY_TEMPLATE='{"input":{"text":"{query}"}}'
```

### Extra static params

```bash
export WEB_PARAMS='{"lang":"en","count":"10"}'
```

## Auth

API keys for the **custom** path are sent in HTTP headers, **never** in query
strings.

```bash
# Default: Authorization: Bearer <key>
export WEB_KEY=your-key

# Custom header
export WEB_AUTH_HEADER=X-Api-Key
export WEB_AUTH_SCHEME=""

# Extra headers
export WEB_HEADERS="X-Tenant: acme; Accept: application/json"
```

## Response parsing

The custom tool auto-detects many response formats:

```jsonc
{ "results": [{ "title": "...", "url": "..." }] }     // flat array
{ "items": [{ "title": "...", "link": "..." }] }       // Google-style
{ "results": { "engine": [{ "title": "...", "url": "..." }] } }  // nested map
[{ "title": "...", "url": "..." }]                      // bare array
```

It probes these array-bearing keys in order: `results`, `items`, `data`, `web`,
`organic_results`, `hits`, `entries`. A matching key may hold either an array of
hits or an object whose values are arrays of hits (the nested-map case).

Field name aliases (first non-empty string wins):
- title: `title` / `headline` / `name` / `heading`
- url: `url` / `link` / `href` / `uri` / `permalink`
- description: `description` / `snippet` / `content` / `preview` / `summary` / `text` / `body`
- source: `source` / `domain` / `displayLink` / `displayed_link` / `engine`

For deeply nested responses:

```bash
export WEB_JSON_PATH=response.payload.results
```

## Retry

For the **custom** provider, failed requests (network errors, 5xx) are retried
once after 500ms; client errors (4xx) are not retried, and the request has a
default 120s timeout (`WEB_CUSTOM_TIMEOUT_SEC`).

**DuckDuckGo** has its own retry path: up to 3 attempts with exponential
backoff (1s/2s/4s ±20% jitter) on transient errors (rate-limit, timeout,
connection reset). A hard "anomaly in the request" block surfaces an actionable
error listing the API-key env vars to configure instead.

The first-party direct providers (Tavily, Exa, You.com, Jina, Bing, Mojeek,
Linkup, Firecrawl) do a single request with no internal retry — in `auto` mode
the chain itself falls through to the next provider on failure.

## Custom provider security guardrails

The custom provider enforces the following guardrails by default:

| Guardrail | Default | Override |
|-----------|---------|----------|
| HTTPS-only | ✅ | `WEB_CUSTOM_ALLOW_HTTP=true` |
| Block private IPs / localhost | ✅ | `WEB_CUSTOM_ALLOW_PRIVATE=true` |
| Header allowlist | ✅ | `WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS=true` |
| Max POST body | 300 KB | `WEB_CUSTOM_MAX_BODY_KB=<kb>` |
| Request timeout | 120s | `WEB_CUSTOM_TIMEOUT_SEC=<seconds>` |
| Audit log (one-time warning) | ✅ | — |

### Self-hosted SearXNG example

```bash
export WEB_SEARCH_PROVIDER=custom
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.mydomain.com/search
export WEB_CUSTOM_ALLOW_PRIVATE=true   # needed if SearXNG is on a private IP
```

### Header allowlist

By default only these headers are permitted:
`accept`, `accept-encoding`, `accept-language`, `authorization`, `cache-control`,
`content-type`, `if-modified-since`, `if-none-match`, `ocp-apim-subscription-key`,
`user-agent`, `x-api-key`, `x-subscription-token`, `x-tenant-id`

## Adding a provider

1. Create `providers/myprovider.ts`:

```typescript
import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, type ProviderOutput } from './types.js'

export const myProvider: SearchProvider = {
  name: 'myprovider',
  isConfigured() { return Boolean(process.env.MYPROVIDER_API_KEY) },
  async search(input: SearchInput): Promise<ProviderOutput> {
    const start = performance.now()
    // ... call API, map to SearchHit[] ...
    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'myprovider',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
```

2. Register in `providers/index.ts` — add the import, push onto `ALL_PROVIDERS`
   **only if** it should participate in the auto chain, and add a named entry
   to `PROVIDER_BY_NAME` for explicit `WEB_SEARCH_PROVIDER=<name>` mode.

Custom / preset adapters that must never become the silent default belong
behind `WEB_SEARCH_PROVIDER=custom` only (like Brave/Google/SearXNG/SerpAPI
today) — do not add them to `ALL_PROVIDERS`.
