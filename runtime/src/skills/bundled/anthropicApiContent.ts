// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
// Content for the agenc-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpAgenCApi from './agenc-api/csharp/agenc-api.md'
import curlExamples from './agenc-api/curl/examples.md'
import goAgenCApi from './agenc-api/go/agenc-api.md'
import javaAgenCApi from './agenc-api/java/agenc-api.md'
import phpAgenCApi from './agenc-api/php/agenc-api.md'
import pythonAgentSdkPatterns from './agenc-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './agenc-api/python/agent-sdk/README.md'
import pythonAgenCApiBatches from './agenc-api/python/agenc-api/batches.md'
import pythonAgenCApiFilesApi from './agenc-api/python/agenc-api/files-api.md'
import pythonAgenCApiReadme from './agenc-api/python/agenc-api/README.md'
import pythonAgenCApiStreaming from './agenc-api/python/agenc-api/streaming.md'
import pythonAgenCApiToolUse from './agenc-api/python/agenc-api/tool-use.md'
import rubyAgenCApi from './agenc-api/ruby/agenc-api.md'
import skillPrompt from './agenc-api/SKILL.md'
import sharedErrorCodes from './agenc-api/shared/error-codes.md'
import sharedLiveSources from './agenc-api/shared/live-sources.md'
import sharedModels from './agenc-api/shared/models.md'
import sharedPromptCaching from './agenc-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './agenc-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './agenc-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './agenc-api/typescript/agent-sdk/README.md'
import typescriptAgenCApiBatches from './agenc-api/typescript/agenc-api/batches.md'
import typescriptAgenCApiFilesApi from './agenc-api/typescript/agenc-api/files-api.md'
import typescriptAgenCApiReadme from './agenc-api/typescript/agenc-api/README.md'
import typescriptAgenCApiStreaming from './agenc-api/typescript/agenc-api/streaming.md'
import typescriptAgenCApiToolUse from './agenc-api/typescript/agenc-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - agenc-api/SKILL.md (Current Models pricing table)
//   - agenc-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'claude-opus-4-6',
  OPUS_NAME: 'AgenC Opus 4.6',
  SONNET_ID: 'claude-sonnet-4-6',
  SONNET_NAME: 'AgenC Sonnet 4.6',
  HAIKU_ID: 'claude-haiku-4-5',
  HAIKU_NAME: 'AgenC Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'claude-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/agenc-api.md': csharpAgenCApi,
  'curl/examples.md': curlExamples,
  'go/agenc-api.md': goAgenCApi,
  'java/agenc-api.md': javaAgenCApi,
  'php/agenc-api.md': phpAgenCApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/agenc-api/README.md': pythonAgenCApiReadme,
  'python/agenc-api/batches.md': pythonAgenCApiBatches,
  'python/agenc-api/files-api.md': pythonAgenCApiFilesApi,
  'python/agenc-api/streaming.md': pythonAgenCApiStreaming,
  'python/agenc-api/tool-use.md': pythonAgenCApiToolUse,
  'ruby/agenc-api.md': rubyAgenCApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/agenc-api/README.md': typescriptAgenCApiReadme,
  'typescript/agenc-api/batches.md': typescriptAgenCApiBatches,
  'typescript/agenc-api/files-api.md': typescriptAgenCApiFilesApi,
  'typescript/agenc-api/streaming.md': typescriptAgenCApiStreaming,
  'typescript/agenc-api/tool-use.md': typescriptAgenCApiToolUse,
}
