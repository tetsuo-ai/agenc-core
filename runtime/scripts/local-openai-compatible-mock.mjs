import { createServer } from "node:http";

export const MOCK_MODEL = "local-pipeline-model";

export function buildMockProviderEnv(baseUrl, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    AGENC_PROVIDER: "openai-compatible",
    AGENC_MODEL: MOCK_MODEL,
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
    "OPENAI_COMPATIBLE_MODEL",
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
function userMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join(" ");
  }
  return null;
}

/**
 * A user-role message that only carries a system reminder, such as the notice
 * that tool search loaded a deferred tool. It is not the user's prompt and
 * does not start a new turn.
 */
function isSystemReminderMessage(message) {
  if (message?.role !== "user") return false;
  const text = userMessageText(message)?.trim() ?? "";
  return text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>");
}

export function userPromptFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || isSystemReminderMessage(message)) continue;
    const text = userMessageText(message);
    if (text !== null) return newestCompactedUserMessage(text);
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

function currentTurnMessages(messages) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user" && !isSystemReminderMessage(messages[index])) {
      latestUserIndex = index;
      break;
    }
  }
  return messages.slice(latestUserIndex + 1);
}

function toolResultCount(messages) {
  return currentTurnMessages(messages).filter(
    (message) => message?.role === "tool",
  ).length;
}

/** Names of the tools the assistant already called in the current turn. */
function calledToolNames(messages) {
  return currentTurnMessages(messages).flatMap((message) =>
    message?.role === "assistant" && Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => call?.function?.name ?? "")
      : [],
  );
}

function completionForPrompt(prompt) {
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

// The wire name escapes the dot, for example tool2__system_x2esearchTools.
const TOOL_SEARCH_NAME = /searchTools$/u;

/**
 * Call the tool a prompt names, as a model would. A Light session lists only
 * a few tools and loads the rest through system.searchTools, so when the named
 * tool is missing the mock first selects it there, then calls it on the next
 * request. Any other request keeps the old pick of the closest listed tool.
 */
function namedToolCall(tools, messages, names, fallbackPattern, args) {
  const candidates = Array.isArray(tools) ? tools : [];
  const called = calledToolNames(messages);
  const named = candidates.find((tool) => names.includes(toolName(tool)));
  if (named !== undefined) {
    return called.includes(toolName(named)) ? null : { tool: named, args };
  }
  const search = candidates.find((tool) => TOOL_SEARCH_NAME.test(toolName(tool)));
  if (search !== undefined) {
    return called.some((name) => TOOL_SEARCH_NAME.test(name))
      ? null
      : { tool: search, args: { select: names[0] } };
  }
  return called.length === 0
    ? { tool: selectTool(tools, names, fallbackPattern), args }
    : null;
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

function nextSingleToolCall(tools, messages, prompt, completedTools) {
  const grepArgs = grepArgsFromPrompt(prompt);
  if (grepArgs) {
    return namedToolCall(tools, messages, ["Grep"], /grep/i, grepArgs);
  }

  const globArgs = globArgsFromPrompt(prompt);
  if (globArgs) {
    return namedToolCall(tools, messages, ["Glob"], /glob/i, globArgs);
  }

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
    nextPipelineToolCall(tools, prompt, completedTools) ??
    nextEditToolCall(tools, prompt, completedTools) ??
    nextSingleToolCall(tools, messages, prompt, completedTools)
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
    completedTools > 0 ? "tool complete" : completionForPrompt(prompt),
  );
}

export async function startMockModelServer() {
  // Wall-clock time of each chat request, for gates that compare it with
  // what the agent did before its first model call.
  const chatRequestTimes = [];
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
      chatRequestTimes.push(Date.now());
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
    chatRequestTimes,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
