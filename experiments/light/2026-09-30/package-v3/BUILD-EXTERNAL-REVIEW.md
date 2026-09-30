# Companion v1 external-resolution review

The v1 build compiled successfully but **must not be imported**. Source/metafile
review found an actual packaging defect: flattening the optional Chrome MCP
source into a single bundle hoisted its absent external package into a top-level
static import. This is a defect of this companion recipe, not evidence that the
canonical AgenC CLI has the same failure.

| External | Verified classification | Action |
| --- | --- | --- |
| `@alcalzone/ansi-tokenize` | Installed 0.3.0 exposes an ESM import condition without require | Verify ESM resolution; no install needed |
| `@ant/agenc-for-chrome-mcp` | Absent; emitted static import at v1 bundle line 225187, originating from `utils/agencInChrome/mcpServer.ts` despite dynamic source caller | Preserve lazy boundary through split ESM output; no stub or blind suppression |
| `@aws-sdk/client-bedrock` | Absent capability-specific dependency; all three emitted references stay dynamic, source non-Bedrock path returns before loading | Prove selected Luna startup avoids that path; don't expand provider scope |
| `source-map-support` | Missing optional TypeScript debug helper, require inside try/catch | Document optional absence; no install needed |

HIGH's review executed no import/install/network/build. Root assigned only a
split-ESM recipe correction with a single emitted canonical ALS/session module.
The v1 bundle, metadata, input manifest and original recipe snapshot remain
unchanged. New build inputs must be independently sealed after that correction;
any new build uses a separate output directory. Execution and Linux selections
remain disabled.
