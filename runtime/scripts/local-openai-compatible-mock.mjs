import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export const MOCK_MODEL = "local-pipeline-model";
export const MOCK_CODE_PREDICTION_TRIGGER = "PREDICTION_E2E_PREFIX";
export const MOCK_CODE_PREDICTION_TEXT = '"PREDICTION_E2E_ACCEPTED";';
export const MOCK_CODE_PREDICTION_LOG_FILENAME =
  "mock-code-prediction-requests.jsonl";

export function buildMockProviderEnv(baseUrl, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    AGENC_PROVIDER: "openai-compatible",
    AGENC_MODEL: MOCK_MODEL,
    OPENAI_COMPATIBLE_MODEL: MOCK_MODEL,
    OPENAI_COMPATIBLE_BASE_URL: `${baseUrl}/v1`,
    OPENAI_COMPATIBLE_API_KEY: "local-pipeline-key",
    API_TIMEOUT_MS: "600000",
    AGENC_AUTH_MANAGED_KEYS_ENABLED: "0",
  };
  for (const key of [
    "XAI_API_KEY",
    "GROK_API_KEY",
    "AGENC_XAI_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ]) {
    delete env[key];
  }
  return env;
}

async function readRequestBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
  }
  return raw.length > 0 ? JSON.parse(raw) : {};
}

const COMPACTED_MESSAGE_PATTERN =
  /<message role="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/message>/gu;
const TRANSCRIPT_CLOSE_PATTERN = /^<\/transcript>\s*$/u;

/**
 * Return the newest user request represented by the provider transcript.
 *
 * Auto-compaction can replace the ordinary message list with the compact
 * service's framed transcript. The gate model must interpret that transcript
 * like a model would: act on the newest user message, not on stale triggers or
 * the closing frame itself.
 */
export function userPromptFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return newestCompactedUserMessage(content);
    if (Array.isArray(content)) {
      return newestCompactedUserMessage(content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join(" "));
    }
  }
  return "";
}

function newestCompactedUserMessage(content) {
  let newest;
  let finalFrameEnd = -1;
  for (const match of content.matchAll(COMPACTED_MESSAGE_PATTERN)) {
    finalFrameEnd = (match.index ?? 0) + match[0].length;
    if (match[1] === "user") newest = match[2];
  }

  if (finalFrameEnd >= 0) {
    const trailing = content.slice(finalFrameEnd).trim();
    if (trailing.length > 0 && !TRANSCRIPT_CLOSE_PATTERN.test(trailing)) {
      return trailing;
    }
  }

  return newest ?? content;
}

function toolResultCount(messages) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return messages
    .slice(latestUserIndex + 1)
    .filter((message) => message?.role === "tool").length;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

export function isIsolatedCodePredictionRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemMessages = messages.filter(
    (message) => message?.role === "system",
  );
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return (
    messages.length === 2 &&
    systemMessages.length === 1 &&
    messageText(systemMessages[0]).includes(
      "You are a low-latency code completion engine.",
    ) &&
    messages.every(
      (message) => message?.role === "system" || message?.role === "user",
    ) &&
    tools.length === 0
  );
}

export function codePredictionTextForRequest(body) {
  if (!isIsolatedCodePredictionRequest(body)) return null;
  const prompt = userPromptFromMessages(body.messages);
  return prompt.includes(MOCK_CODE_PREDICTION_TRIGGER)
    ? MOCK_CODE_PREDICTION_TEXT
    : "OK";
}

async function recordCodePredictionRequest(body) {
  if (
    process.env.AGENC_TUI_E2E_RECORD_MOCK_PREDICTIONS !== "1" ||
    typeof process.env.AGENC_HOME !== "string" ||
    process.env.AGENC_HOME.length === 0
  ) {
    return;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const logPath = join(
    process.env.AGENC_HOME,
    MOCK_CODE_PREDICTION_LOG_FILENAME,
  );
  await mkdir(process.env.AGENC_HOME, { recursive: true, mode: 0o700 });
  await appendFile(
    logPath,
    `${JSON.stringify({
      kind: "code_prediction",
      model: body?.model ?? null,
      messageRoles: messages.map((message) => message?.role ?? null),
      toolCount: tools.length,
      hasTrigger: userPromptFromMessages(messages).includes(
        MOCK_CODE_PREDICTION_TRIGGER,
      ),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function editorInteractionIdentity(messages) {
  const marker = "The immutable editor revision identity is:";
  const policyMessage = [...messages].reverse().find((message) => {
    if (message?.role !== "system" && message?.role !== "developer") {
      return false;
    }
    const text = messageText(message);
    return (
      text.includes("<editor_interaction_policy>") && text.includes(marker)
    );
  });
  const policyText = messageText(policyMessage);
  const markerIndex = policyText.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const identityLine = policyText
    .slice(markerIndex + marker.length)
    .trimStart()
    .split(/\r?\n/, 1)[0];
  if (!identityLine) return null;
  try {
    const identity = JSON.parse(identityLine);
    return identity && typeof identity === "object" ? identity : null;
  } catch {
    return null;
  }
}

export function editorSnapshotLine(messages, needle, startLine) {
  const latestUser = [...messages]
    .reverse()
    .find((message) => message?.role === "user");
  const content = messageText(latestUser);
  const lines = content.split(/\r?\n/);
  const workspaceStart = lines.findIndex((line) =>
    /^<workspace_data\b[^>]*\borigin="embedded editor /u.test(line),
  );
  if (workspaceStart < 0) return null;
  const workspaceEnd = lines.findIndex(
    (line, index) => index > workspaceStart && line === "</workspace_data>",
  );
  if (workspaceEnd < 0) return null;
  const metadataIndex = lines.findIndex(
    (line, index) =>
      index > workspaceStart &&
      index < workspaceEnd &&
      (line.startsWith("Editor context metadata: ") ||
        /\bExact editor range:\s*\{/u.test(line)),
  );
  if (metadataIndex < 0) return null;
  const offset = lines
    .slice(metadataIndex + 1, workspaceEnd)
    .findIndex((line) => line === needle);
  return offset < 0 ? null : startLine + offset;
}

function completionForPrompt(prompt) {
  if (/\bWORKBENCH-TRANSCRIPT-SCROLL\b/i.test(prompt)) {
    const lines = Array.from(
      { length: 120 },
      (_, index) => `WBANCHOR-${String(index + 1).padStart(3, "0")}`,
    );
    return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
  }
  const singleWord =
    /\b(?:reply with|say only)\s+(?:the\s+)?(?:single\s+)?word\s+([A-Za-z0-9_-]+)/i.exec(
      prompt,
    )?.[1];
  if (singleWord) return singleWord;
  const literalText = /\breply with the literal text\s+([A-Za-z0-9_-]+)/i.exec(
    prompt,
  )?.[1];
  if (literalText) return literalText;
  if (/RECORDED/i.test(prompt)) return "RECORDED";
  if (/\bDONE\b/i.test(prompt)) return "DONE";
  if (/\bYES\b/i.test(prompt)) return "YES";
  return "OK";
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name ?? "";
}

function selectTool(tools, preferred, fallbackPattern) {
  const candidates = Array.isArray(tools) ? tools : [];
  for (const name of preferred) {
    const found = candidates.find((tool) => toolName(tool) === name);
    if (found) return found;
  }
  if (fallbackPattern) {
    const found = candidates.find((tool) =>
      fallbackPattern.test(toolName(tool)),
    );
    if (found) return found;
  }
  return candidates[0];
}

function toolArgumentsFor(tool, args) {
  const name = toolName(tool);
  if (name === "exec_command") {
    return {
      cmd: args.command,
      yield_time_ms: 1000,
      max_output_tokens: 2000,
    };
  }
  if (name === "system.bash") return { command: args.command };
  return args;
}

function shellCommandFromPrompt(prompt) {
  return /Use the Bash tool(?: exactly twice)?\.\s*First run/i.test(prompt)
    ? null
    : (/Use the Bash tool to run(?: exactly)?:\s*([\s\S]+)/i
        .exec(prompt)?.[1]
        ?.trim() ?? null);
}

function pipelineCommandsFromPrompt(prompt) {
  const match =
    /First run only:\s*(echo\s+\S+)\.\s*Then run only:\s*(echo\s+\S+)\./i.exec(
      prompt,
    );
  return match ? [match[1], match[2]] : null;
}

function fileReadArgsFromPrompt(prompt) {
  const path =
    /Use the Read tool to read\s+(.+?)(?:,?\s+then\b|\s+and\s+report\b|$)/i
      .exec(prompt)?.[1]
      ?.trim()
      .replace(/\s*\.$/, "");
  return path ? { file_path: path } : null;
}

function grepArgsFromPrompt(prompt) {
  const match =
    /Use the Grep tool[\s\S]*?search\s+(.+?)\s+for the pattern\s+'([^']+)'/i.exec(
      prompt,
    );
  return match
    ? { path: match[1].trim(), pattern: match[2], output_mode: "content" }
    : null;
}

function globArgsFromPrompt(prompt) {
  const match =
    /Use the Glob tool[\s\S]*?in\s+(.+?)\s+matching the pattern\s+'([^']+)'/i.exec(
      prompt,
    );
  return match ? { path: match[1].trim(), pattern: match[2] } : null;
}

function writeArgsFromPrompt(prompt) {
  const match =
    /Use the Write tool to write the exact text\s+"([^"]+)"\s+to the file\s+(.+)/i.exec(
      prompt,
    );
  return match ? { content: match[1], file_path: match[2].trim() } : null;
}

function editArgsFromPrompt(prompt) {
  const path = /Use the Read tool to read\s+(.+?),\s+then use the Edit tool/i
    .exec(prompt)?.[1]
    ?.trim();
  const replacement = /replace\s+"([^"]+)"\s+with\s+"([^"]+)"/i.exec(prompt);
  return path && replacement
    ? {
        file_path: path,
        old_string: replacement[1],
        new_string: replacement[2],
      }
    : null;
}

const SHELL_TOOL_NAMES = ["exec_command", "system.bash", "Bash"];

function selectShellTool(tools) {
  return selectTool(tools, SHELL_TOOL_NAMES, /bash|shell|command/i);
}

function shellToolCall(tools, command) {
  return {
    tool: selectShellTool(tools),
    args: { command },
  };
}

function nextPipelineToolCall(tools, prompt, completedTools) {
  const pipelineCommands = pipelineCommandsFromPrompt(prompt);
  if (pipelineCommands && completedTools < pipelineCommands.length) {
    return shellToolCall(tools, pipelineCommands[completedTools]);
  }

  if (!completedTools && /PIPELINE-TOOL-CHECK/i.test(prompt)) {
    return shellToolCall(tools, "echo PIPELINE-TOOL-CHECK");
  }
  if (!completedTools && /TOKEN-CHECK/i.test(prompt)) {
    return shellToolCall(tools, "echo TOKEN-CHECK");
  }

  return null;
}

function nextEditorPolicyProbeToolCall(prompt, completedTools) {
  if (
    completedTools !== 0 ||
    !/\bEDITOR-POLICY-WRITE-ATTEMPT\b/i.test(prompt)
  ) {
    return null;
  }
  // Deliberately request a mutating tool even when the model-facing tool list
  // omits it. The unified-workspace E2E uses this to prove the daemon enforces
  // a cold Editor Ask as read-only, rather than relying on model compliance.
  return {
    tool: { function: { name: "FileWrite" } },
    args: {
      file_path: ".agenc-editor-policy-forbidden",
      content: "EDITOR_POLICY_WRITE_BYPASS\n",
    },
  };
}

function nextEditorProposalToolCall(tools, messages, prompt, completedTools) {
  if (completedTools !== 0 || !/\bEDITOR-PROPOSAL-E2E\b/i.test(prompt)) {
    return null;
  }
  const tool = (Array.isArray(tools) ? tools : []).find(
    (candidate) => toolName(candidate) === "EditorProposal",
  );
  const identity = editorInteractionIdentity(messages);
  const rangeStartLine = identity?.range?.start?.line;
  const markerLine = Number.isSafeInteger(rangeStartLine)
    ? editorSnapshotLine(messages, "SHARED_WORKSPACE_MARK", rangeStartLine)
    : null;
  if (
    !tool ||
    !identity ||
    typeof identity.interaction_id !== "string" ||
    typeof identity.path !== "string" ||
    !Number.isSafeInteger(identity.buffer_handle) ||
    !Number.isSafeInteger(identity.base_changedtick) ||
    typeof identity.base_content_sha256 !== "string" ||
    !Number.isSafeInteger(markerLine)
  ) {
    return null;
  }
  return {
    tool,
    args: {
      version: 1,
      interaction_id: identity.interaction_id,
      path: identity.path,
      buffer_handle: identity.buffer_handle,
      base_changedtick: identity.base_changedtick,
      base_content_sha256: identity.base_content_sha256,
      summary: "Accept the unified workspace proposal",
      edits: [
        {
          id: "e2e-shared-workspace-marker",
          start_line: markerLine,
          start_column: 0,
          end_line: markerLine,
          end_column: Buffer.byteLength("SHARED_WORKSPACE_MARK", "utf8"),
          old_text: "SHARED_WORKSPACE_MARK",
          new_text: "SHARED_WORKSPACE_ACCEPTED",
        },
      ],
    },
  };
}

function nextEditToolCall(tools, prompt, completedTools) {
  const editArgs = editArgsFromPrompt(prompt);
  if (editArgs && completedTools === 0) {
    return {
      tool: selectTool(tools, ["FileRead", "Read"], /read/i),
      args: fileReadArgsFromPrompt(prompt),
    };
  }
  if (editArgs && completedTools === 1) {
    return {
      tool: selectTool(tools, ["Edit", "FileEdit"], /edit/i),
      args: editArgs,
    };
  }

  return null;
}

function nextSingleToolCall(tools, prompt, completedTools) {
  if (completedTools) return null;

  const command = shellCommandFromPrompt(prompt);
  if (command) {
    return shellToolCall(tools, command);
  }

  const readArgs = fileReadArgsFromPrompt(prompt);
  if (readArgs) {
    return {
      tool: selectTool(tools, ["FileRead", "Read"], /read/i),
      args: readArgs,
    };
  }

  const grepArgs = grepArgsFromPrompt(prompt);
  if (grepArgs) {
    return {
      tool: selectTool(tools, ["Grep"], /grep|search/i),
      args: grepArgs,
    };
  }

  const globArgs = globArgsFromPrompt(prompt);
  if (globArgs) {
    return { tool: selectTool(tools, ["Glob"], /glob/i), args: globArgs };
  }

  const writeArgs = writeArgsFromPrompt(prompt);
  if (writeArgs) {
    return {
      tool: selectTool(tools, ["Write", "FileWrite"], /write/i),
      args: writeArgs,
    };
  }

  return null;
}

function nextToolCall(body, messages, prompt, completedTools) {
  const tools = body.tools;
  return (
    nextEditorPolicyProbeToolCall(prompt, completedTools) ??
    nextEditorProposalToolCall(tools, messages, prompt, completedTools) ??
    nextPipelineToolCall(tools, prompt, completedTools) ??
    nextEditToolCall(tools, prompt, completedTools) ??
    nextSingleToolCall(tools, prompt, completedTools)
  );
}

function writeSse(response, chunks) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function makeChunk(body, choice) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? MOCK_MODEL,
    choices: [choice],
  };
}

function usage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function respondWithText(response, body, text) {
  const tokenCount = Math.max(1, text.split(/\s+/).length);
  writeSse(response, [
    makeChunk(body, {
      index: 0,
      delta: { role: "assistant" },
      finish_reason: null,
    }),
    makeChunk(body, {
      index: 0,
      delta: { content: text },
      finish_reason: null,
    }),
    {
      ...makeChunk(body, {
        index: 0,
        delta: {},
        finish_reason: "stop",
      }),
      usage: usage(64, tokenCount),
    },
  ]);
}

function respondWithJsonText(response, body, text) {
  const tokenCount = Math.max(1, text.split(/\s+/).length);
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(
    JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? MOCK_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: usage(64, tokenCount),
    }),
  );
}

function respondWithToolCall(response, body, call) {
  const selected = call.tool;
  const name = toolName(selected) || "exec_command";
  const args = JSON.stringify(toolArgumentsFor(selected, call.args));
  writeSse(response, [
    makeChunk(body, {
      index: 0,
      delta: { role: "assistant" },
      finish_reason: null,
    }),
    makeChunk(body, {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now()}`,
            type: "function",
            function: { name, arguments: args },
          },
        ],
      },
      finish_reason: null,
    }),
    {
      ...makeChunk(body, {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      }),
      usage: usage(96, 12),
    },
  ]);
}

async function handleChatCompletions(request, response) {
  const body = await readRequestBody(request);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const predictionText = codePredictionTextForRequest(body);
  if (predictionText !== null) {
    await recordCodePredictionRequest(body);
    if (body.stream === true) {
      respondWithText(response, body, predictionText);
    } else {
      respondWithJsonText(response, body, predictionText);
    }
    return;
  }
  const prompt = userPromptFromMessages(messages);
  const completedTools = toolResultCount(messages);
  const call = nextToolCall(body, messages, prompt, completedTools);
  if (call) {
    respondWithToolCall(response, body, call);
    return;
  }
  respondWithText(
    response,
    body,
    completedTools > 0 && !/\bWORKBENCH-TRANSCRIPT-SCROLL\b/i.test(prompt)
      ? "tool complete"
      : completionForPrompt(prompt),
  );
}

export async function startMockModelServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: MOCK_MODEL, object: "model", owned_by: "local" }],
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      handleChatCompletions(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: String(error?.message ?? error) },
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: `not found: ${url.pathname}` },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
