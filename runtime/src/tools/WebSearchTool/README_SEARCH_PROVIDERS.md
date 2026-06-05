# Web Search Providers

AgenC supports multiple search backends through a provider adapter system.

## Supported Providers

| Provider | Env Var | Auth Header | Method |
|---|---|---|---|
| Custom API | `WEB_SEARCH_API` | Configurable | GET/POST |
| SearXNG | `WEB_PROVIDER=searxng` | — | GET |
| Google | `WEB_PROVIDER=google` | `Authorization: Bearer` | GET |
| Brave | `WEB_PROVIDER=brave` | `X-Subscription-Token` | GET |
| SerpAPI | `WEB_PROVIDER=serpapi` | `Authorization: Bearer` | GET |
| Firecrawl | `FIRECRAWL_API_KEY` | Internal | SDK |
| Tavily | `TAVILY_API_KEY` | `Authorization: Bearer` | POST |
| Exa | `EXA_API_KEY` | `x-api-key` | POST |
| You.com | `YOU_API_KEY` | `X-API-Key` | GET |
| Jina | `JINA_API_KEY` | `Authorization: Bearer` | GET |
| Bing | `BING_API_KEY` | `Ocp-Apim-Subscription-Key` | GET |
| Mojeek | `MOJEEK_API_KEY` | `Authorization: Bearer` (optional) | GET |
| Linkup | `LINKUP_API_KEY` | `Authorization: Bearer` | POST |
| DuckDuckGo | *(default)* | — | SDK |

## Quick Start

```bash
# Tavily (recommended for AI — fast, RAG-ready)
export TAVILY_API_KEY=tvly-your-key

# Exa (neural search, semantic queries)
export EXA_API_KEY=your-exa-key

# Brave (traditional web search, good coverage)
export WEB_PROVIDER=brave
export WEB_KEY=your-brave-key

# Bing
export BING_API_KEY=your-bing-key

# Self-hosted SearXNG (free, private)
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.example.com/search
```

## Provider Selection Mode

`WEB_SEARCH_PROVIDER` controls fallback behavior:

| Mode | Behavior |
|---|---|
| `auto` (default) | Try all configured providers in order, fall through on failure |
| `firecrawl` | Firecrawl only — throws on failure |
| `tavily` | Tavily only — throws on failure |
| `exa` | Exa only — throws on failure |
| `you` | You.com only — throws on failure |
| `jina` | Jina only — throws on failure |
| `bing` | Bing only — throws on failure |
| `mojeek` | Mojeek only — throws on failure |
| `linkup` | Linkup only — throws on failure |
| `ddg` | DuckDuckGo only — throws on failure |
| `custom` | Custom API only — throws on failure. **Not in the auto chain** — must be explicitly selected |
| `native` | Provider-native web search only (requires firstParty/Vertex/Foundry provider) |

**Auto mode priority:** firecrawl → tavily → exa → you → jina → bing → mojeek → linkup → ddg

> **Note:** The `custom` provider is excluded from the `auto` chain. It is only used when `WEB_SEARCH_PROVIDER=custom` is explicitly set. This prevents the generic outbound provider from silently becoming the default backend.

```bash
# Fail loudly if Tavily is down (don't silently switch backends)
export WEB_SEARCH_PROVIDER=tavily

# Try everything, fall through gracefully
export WEB_SEARCH_PROVIDER=auto
```

## Provider Request & Response Formats

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

### SearXNG (Built-in Preset)

```bash
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

### Google Custom Search (Built-in Preset)

```bash
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

### Brave (Built-in Preset)

```bash
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

### SerpAPI (Built-in Preset)

```bash
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

### DuckDuckGo (Default Fallback)

No configuration needed. Uses the `duck-duck-scrape` npm package.

```bash
# Set as explicit-only backend
export WEB_SEARCH_PROVIDER=ddg
```

---

## Custom API Configuration

### Standard GET

```
GET https://api.example.com/search?q=hello
```

```bash
export WEB_SEARCH_API=https://api.example.com/search
export WEB_QUERY_PARAM=q
```

### Query in URL Path

```
GET https://api.example.com/v2/search/hello
```

```bash
export WEB_URL_TEMPLATE=https://api.example.com/v2/search/{query}
```

### POST with Custom Body

```
POST https://api.example.com/v1/query
Content-Type: application/json

{"input": {"text": "hello"}}
```

```bash
export WEB_SEARCH_API=https://api.example.com/v1/query
export WEB_METHOD=POST
export WEB_BODY_TEMPLATE='{"input":{"text":"{query}"}}'
```

### Extra Static Params

```bash
export WEB_PARAMS='{"lang":"en","count":"10"}'
```

## Auth

API keys are sent in HTTP headers, **never** in query strings.

```bash
# Default: Authorization: Bearer <key>
export WEB_KEY=your-key

# Custom header
export WEB_AUTH_HEADER=X-Api-Key
export WEB_AUTH_SCHEME=""

# Extra headers
export WEB_HEADERS="X-Tenant: acme; Accept: application/json"
```

## Response Parsing

The tool auto-detects many response formats:

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

For the **custom** provider, failed requests (network errors, 5xx) are retried once after 500ms; client errors (4xx) are not retried, and the request has a default 120s timeout (`WEB_CUSTOM_TIMEOUT_SEC`).

**DuckDuckGo** has its own retry path: up to 3 attempts with exponential backoff (1s/2s/4s ±20% jitter) on transient errors (rate-limit, timeout, connection reset). A hard "anomaly in the request" block surfaces an actionable error listing the API-key env vars to configure instead.

The first-party direct providers (Tavily, Exa, You.com, Jina, Bing, Mojeek, Linkup, Firecrawl) do a single request with no internal retry — in `auto` mode the chain itself falls through to the next provider on failure.

## Custom Provider Security Guardrails

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
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.mydomain.com/search
export WEB_CUSTOM_ALLOW_PRIVATE=true   # needed if SearXNG is on a private IP
```

### Header allowlist

By default only these headers are permitted:
`accept`, `accept-encoding`, `accept-language`, `authorization`, `cache-control`, `content-type`, `if-modified-since`, `if-none-match`, `ocp-apim-subscription-key`, `user-agent`, `x-api-key`, `x-subscription-token`, `x-tenant-id`

## Adding a Provider

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

2. Register in `providers/index.ts` — add import and push to `ALL_PROVIDERS`.
