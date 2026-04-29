import { describe, it, expect } from "vitest";

import {
  detectCorruptReasoningSummary,
  DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS,
  modelIsReasoningVariant,
  modelSupportsFunctionCalling,
  modelSupportsReasoningEffort,
  resolveDocumentedXaiModel,
  validateXaiRequestPreFlight,
  validateXaiResponsePostFlight,
  XaiUndocumentedFieldError,
  XaiUnknownModelError,
} from "./xai-strict-filter.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function plainTextRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "grok-4-1-fast-non-reasoning",
    input: [{ role: "user", content: "hello" }],
    store: false,
    ...overrides,
  };
}

function functionTool(name: string): Record<string, unknown> {
  return {
    type: "function",
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {}, required: [] },
  };
}

function toolFollowupRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "grok-4-1-fast-non-reasoning",
    input: [
      { role: "user", content: "do the thing" },
      {
        type: "function_call",
        call_id: "call-123",
        name: "system.bash",
        arguments: '{"command":"ls"}',
      },
      {
        type: "function_call_output",
        call_id: "call-123",
        output: "file1\nfile2\n",
      },
    ],
    tools: [functionTool("system.bash")],
    store: false,
    ...overrides,
  };
}

function responseWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "resp_test_123",
    object: "response",
    model: "grok-4-1-fast-non-reasoning",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };
}

function reasoningBlock(text: string): Record<string, unknown> {
  return {
    type: "reasoning",
    id: "rs_test",
    summary: [{ type: "summary_text", text }],
    status: "completed",
  };
}

function messageBlock(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function functionCallBlock(name: string, args: string): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: "call_xyz",
    name,
    arguments: args,
  };
}

// ---------------------------------------------------------------------------
// model catalog helpers
// ---------------------------------------------------------------------------

describe("resolveDocumentedXaiModel", () => {
  it("returns canonical ID for known catalog entries", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-0309-reasoning")).toBe(
      "grok-4.20-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4-1-fast-non-reasoning")).toBe(
      "grok-4-1-fast-non-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent-0309")).toBe(
      "grok-4.20-multi-agent-0309",
    );
  });

  it("resolves bare-name aliases to canonical", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-reasoning")).toBe(
      "grok-4.20-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent")).toBe(
      "grok-4.20-multi-agent-0309",
    );
  });

  it("resolves -latest aliases to canonical", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-reasoning-latest")).toBe(
      "grok-4.20-0309-reasoning",
    );
    expect(
      resolveDocumentedXaiModel("grok-4-1-fast-non-reasoning-latest"),
    ).toBe("grok-4-1-fast-non-reasoning");
  });

  it("resolves legacy beta-infixed 4.20 IDs to current non-beta canonical IDs", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-beta-0309-reasoning")).toBe(
      "grok-4.20-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-beta-0309-non-reasoning")).toBe(
      "grok-4.20-0309-non-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent-beta-0309")).toBe(
      "grok-4.20-multi-agent-0309",
    );
  });

  it("returns null for undocumented IDs", () => {
    expect(resolveDocumentedXaiModel("grok-9.99-flux-capacitor")).toBeNull();
    expect(resolveDocumentedXaiModel("gpt-4")).toBeNull();
    expect(resolveDocumentedXaiModel("claude-opus-4")).toBeNull();
    expect(resolveDocumentedXaiModel("")).toBeNull();
  });

  it("accepts legacy Grok variants that are still in the xAI catalog", () => {
    // Per release notes: grok-3 (April 2025), grok-3-mini (legacy
    // reasoning), grok-2-1212 (December 2024), grok-code-fast-1
    // (August 2025). The validator catalog must include these so
    // existing AgenC test fixtures and configurations don't break.
    expect(resolveDocumentedXaiModel("grok-3")).toBe("grok-3");
    expect(resolveDocumentedXaiModel("grok-3-mini")).toBe("grok-3-mini");
    expect(resolveDocumentedXaiModel("grok-code-fast-1")).toBe("grok-code-fast-1");
    expect(resolveDocumentedXaiModel("grok-2-1212")).toBe("grok-2-1212");
    expect(resolveDocumentedXaiModel("grok-2-vision-1212")).toBe(
      "grok-2-vision-1212",
    );
    expect(resolveDocumentedXaiModel("grok-4-0709")).toBe("grok-4-0709");
  });

  it("rejects non-string input gracefully", () => {
    expect(resolveDocumentedXaiModel(undefined as unknown as string)).toBeNull();
    expect(resolveDocumentedXaiModel(null as unknown as string)).toBeNull();
  });
});

describe("model capability flags", () => {
  it("modelSupportsFunctionCalling: text models yes, imagine-* no", () => {
    expect(modelSupportsFunctionCalling("grok-4.20-beta-0309-reasoning")).toBe(true);
    expect(modelSupportsFunctionCalling("grok-4-1-fast-non-reasoning")).toBe(
      true,
    );
    expect(modelSupportsFunctionCalling("grok-imagine-image")).toBe(false);
    expect(modelSupportsFunctionCalling("grok-imagine-video")).toBe(false);
  });

  it("modelSupportsReasoningEffort: only multi-agent", () => {
    expect(modelSupportsReasoningEffort("grok-4.20-multi-agent-0309")).toBe(
      true,
    );
    expect(modelSupportsReasoningEffort("grok-4.20-0309-reasoning")).toBe(false);
    expect(modelSupportsReasoningEffort("grok-4-1-fast-reasoning")).toBe(false);
    expect(modelSupportsReasoningEffort("grok-4-1-fast-non-reasoning")).toBe(
      false,
    );
  });

  it("modelIsReasoningVariant catches reasoning + multi-agent", () => {
    expect(modelIsReasoningVariant("grok-4.20-beta-0309-reasoning")).toBe(true);
    expect(modelIsReasoningVariant("grok-4-1-fast-reasoning")).toBe(true);
    expect(modelIsReasoningVariant("grok-4.20-multi-agent-beta-0309")).toBe(true);
    expect(modelIsReasoningVariant("grok-4.20-beta-0309-non-reasoning")).toBe(false);
    expect(modelIsReasoningVariant("grok-4-1-fast-non-reasoning")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pre-flight validator: pass cases
// ---------------------------------------------------------------------------

describe("validateXaiRequestPreFlight (pass cases)", () => {
  it("accepts a plain text request with no tools", () => {
    expect(() => validateXaiRequestPreFlight(plainTextRequest())).not.toThrow();
  });

  it("accepts a tool-followup request with non-empty tools", () => {
    expect(() => validateXaiRequestPreFlight(toolFollowupRequest())).not.toThrow();
  });

  it("accepts multi-agent with reasoning.effort: high", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-0309",
          reasoning: { effort: "high" },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts multi-agent with reasoning.effort: low/medium/xhigh", () => {
    for (const effort of ["low", "medium", "xhigh"]) {
      expect(() =>
        validateXaiRequestPreFlight(
          plainTextRequest({
            model: "grok-4.20-multi-agent-0309",
            reasoning: { effort },
          }),
        ),
      ).not.toThrow();
    }
  });

  it("accepts a request with all documented top-level fields populated", () => {
    expect(() =>
      validateXaiRequestPreFlight({
        model: "grok-4-1-fast-non-reasoning",
        input: [{ role: "user", content: "hi" }],
        tools: [functionTool("system.bash")],
        tool_choice: "auto",
        parallel_tool_calls: true,
        previous_response_id: "resp_prior",
        store: true,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 1024,
        max_turns: 5,
        temperature: 0.7,
        top_p: 0.9,
        text: { format: { type: "json_schema", name: "x", schema: {}, strict: true } },
        prompt_cache_key: "session_abc",
        stream: false,
        user: "tetsuo",
      }),
    ).not.toThrow();
  });

  it("accepts tool_choice in all four documented forms", () => {
    for (const tc of [
      "auto",
      "required",
      "none",
      { type: "function", function: { name: "system.bash" } },
    ]) {
      expect(() =>
        validateXaiRequestPreFlight(
          plainTextRequest({
            tools: [functionTool("system.bash")],
            tool_choice: tc,
          }),
        ),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// pre-flight validator: reject cases
// ---------------------------------------------------------------------------

describe("validateXaiRequestPreFlight (reject cases)", () => {
  it("throws XaiUnknownModelError for unknown Grok variants", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({ model: "grok-9.99-flux-capacitor" }),
      ),
    ).toThrow(XaiUnknownModelError);
  });

  it("throws XaiUnknownModelError for missing model", () => {
    const params = plainTextRequest();
    delete params.model;
    expect(() => validateXaiRequestPreFlight(params)).toThrow(
      XaiUnknownModelError,
    );
  });

  it("throws XaiUnknownModelError for empty model string", () => {
    expect(() =>
      validateXaiRequestPreFlight(plainTextRequest({ model: "" })),
    ).toThrow(XaiUnknownModelError);
  });

  it("throws XaiUnknownModelError for OpenAI / Anthropic / unknown IDs", () => {
    for (const bad of [
      "gpt-4",
      "gpt-5",
      "claude-opus-4",
      "claude-sonnet-3.5",
      "grok-9.99-flux-capacitor",
    ]) {
      expect(() =>
        validateXaiRequestPreFlight(plainTextRequest({ model: bad })),
      ).toThrow(XaiUnknownModelError);
    }
  });

  it("throws XaiUndocumentedFieldError when reasoning.effort sent on a non-multi-agent model", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-beta-0309-reasoning",
          reasoning: { effort: "high" },
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4-1-fast-reasoning",
          reasoning: { effort: "low" },
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError when presence_penalty sent on a reasoning model", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-beta-0309-reasoning",
          presence_penalty: 0.5,
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError when frequency_penalty sent on a reasoning model", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-0309",
          frequency_penalty: 1.0,
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError when stop sent on a reasoning model", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4-1-fast-reasoning",
          stop: ["\n"],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError on undocumented top-level fields (legacy chat-completions style)", () => {
    expect(() =>
      validateXaiRequestPreFlight({
        model: "grok-4-1-fast-non-reasoning",
        messages: [{ role: "user", content: "hi" }], // legacy field
      }),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError on response_format (legacy chat-completions field)", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          response_format: { type: "json_object" },
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError on legacy nested {function:{...}} tool shape", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          tools: [
            {
              type: "function",
              function: {
                name: "system.bash",
                description: "shell",
                parameters: {},
              },
            },
          ],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError when a function tool has no name", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          tools: [{ type: "function", description: "x", parameters: {} }],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("throws XaiUndocumentedFieldError on invalid tool_choice", () => {
    for (const bad of ["yes", "must", { type: "function" }, { type: "function", function: {} }, 42]) {
      expect(() =>
        validateXaiRequestPreFlight(
          plainTextRequest({
            tools: [functionTool("system.bash")],
            tool_choice: bad as unknown,
          }),
        ),
      ).toThrow(XaiUndocumentedFieldError);
    }
  });

});

// ---------------------------------------------------------------------------
// post-flight validator
// ---------------------------------------------------------------------------

describe("validateXaiResponsePostFlight (clean cases)", () => {
  it("returns no anomalies when no tools were sent", () => {
    expect(
      validateXaiResponsePostFlight({
        request: plainTextRequest(),
        response: responseWith({ output: [messageBlock("hello back")] }),
      }),
    ).toEqual([]);
  });

  it("returns no anomalies when tools were sent and a function_call came back", () => {
    expect(
      validateXaiResponsePostFlight({
        request: toolFollowupRequest(),
        response: responseWith({
          output: [
            reasoningBlock("Calling system.bash"),
            functionCallBlock("system.bash", '{"command":"ls"}'),
          ],
        }),
      }),
    ).toEqual([]);
  });

  it("returns no anomalies when tools were sent, no function_call, but message text has no promise language", () => {
    expect(
      validateXaiResponsePostFlight({
        request: toolFollowupRequest(),
        response: responseWith({
          output: [
            messageBlock(
              "The task is complete. The shell ran successfully and the output was as expected.",
            ),
          ],
        }),
      }),
    ).toEqual([]);
  });

  it("returns no anomaly when response.model is the documented alias of the requested model", () => {
    const result = validateXaiResponsePostFlight({
      request: { ...plainTextRequest(), model: "grok-4.20-reasoning" },
      response: responseWith({ model: "grok-4.20-beta-0309-reasoning" }),
    });
    expect(result).toEqual([]);
  });
});

describe("validateXaiResponsePostFlight (model aliasing)", () => {
  it("detects a true model mismatch after canonical normalization", () => {
    const result = validateXaiResponsePostFlight({
      request: { ...plainTextRequest(), model: "grok-4.20-beta-0309-reasoning" },
      response: responseWith({ model: "grok-code-fast-1" }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "model_silently_aliased",
      severity: "warn",
    });
    expect(result[0]?.evidence).toMatchObject({
      requestedModel: "grok-4.20-beta-0309-reasoning",
      responseModel: "grok-code-fast-1",
    });
  });

  it("does NOT flag canonical alias-equivalent model IDs as silent aliasing", () => {
    const result = validateXaiResponsePostFlight({
      request: { ...plainTextRequest(), model: "grok-4.20-beta-0309-reasoning" },
      response: responseWith({ model: "grok-4.20-0309-reasoning" }),
    });
    expect(
      result.find((a) => a.code === "model_silently_aliased"),
    ).toBeUndefined();
  });

  it("does NOT flag documented bare-name alias as silent aliasing", () => {
    const result = validateXaiResponsePostFlight({
      request: { ...plainTextRequest(), model: "grok-4.20-reasoning" },
      response: responseWith({ model: "grok-4.20-beta-0309-reasoning" }),
    });
    expect(
      result.find((a) => a.code === "model_silently_aliased"),
    ).toBeUndefined();
  });
});

describe("validateXaiResponsePostFlight (incomplete responses)", () => {
  it("detects status: incomplete with reason: max_output_tokens", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageBlock("Truncated content...")],
      }),
    });
    const anomaly = result.find((a) => a.code === "incomplete_response");
    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe("warn");
    expect(anomaly?.evidence).toMatchObject({ reason: "max_output_tokens" });
  });

  it("detects status: incomplete with reason: content_filter", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
      }),
    });
    expect(result[0]?.evidence.reason).toBe("content_filter");
  });

  it("does NOT flag status: completed", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({ status: "completed", output: [messageBlock("ok")] }),
    });
    expect(result.find((a) => a.code === "incomplete_response")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mid-sentence truncation detection (xAI /v1/responses decoder bug)
// ---------------------------------------------------------------------------

describe("validateXaiResponsePostFlight (mid-sentence truncation bug)", () => {
  // The live trigger reproduced end-to-end via curl (report.txt §4.4):
  //   - status: "completed", incomplete_details: null
  //   - sent tools non-empty, tool_choice: auto (default)
  //   - input has prior function_call_output items
  //   - response has zero function_call blocks
  //   - message text ends mid-list-item ("\n2")

  it("detects truncation matching the live xAI decoder bug", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash"), functionTool("system.writeFile")],
      // tool_choice omitted → effective "auto"
    });
    const truncated =
      "**Phase 0 bootstrap failed to build.**\n\n" +
      "**Failures:**\n" +
      "1. CMakeLists.txt: `find_package(Readline)` failed - no " +
      "ReadlineConfig.cmake (fixed by switching to pkg-config).\n2";
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [messageBlock(truncated)],
        usage: { input_tokens: 36091, output_tokens: 40, total_tokens: 36131 },
      }),
    });
    const anomaly = result.find(
      (a) => a.code === "truncated_response_mid_sentence",
    );
    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe("warn");
    expect(anomaly?.evidence).toMatchObject({
      outputTokens: 40,
      priorFunctionCallOutputCount: 1,
      toolChoice: "auto",
    });
    expect(anomaly?.evidence.messageTextTail).toContain("pkg-config).\n2");
  });

  it("detects reasoning-only completed responses with no visible assistant text", () => {
    const request = toolFollowupRequest({
      model: "grok-4.20-beta-0309-reasoning",
      tools: [functionTool("system.bash"), functionTool("system.editFile")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        model: "grok-4.20-beta-0309-reasoning",
        status: "completed",
        incomplete_details: null,
        output: [
          reasoningBlock(
            "The final recovery turn must be direct. The ledger shows repeated failed tool calls.",
          ),
        ],
        usage: {
          input_tokens: 34492,
          output_tokens: 280,
          total_tokens: 34772,
          output_tokens_details: { reasoning_tokens: 280 },
        },
      }),
    });
    const anomaly = result.find(
      (a) => a.code === "truncated_response_mid_sentence",
    );
    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe("warn");
    expect(anomaly?.evidence).toMatchObject({
      outputTokens: 280,
      priorFunctionCallOutputCount: 1,
      toolChoice: "auto",
      reasoningBlockCount: 1,
      variant: "reasoning_only",
    });
    expect(anomaly?.evidence.assistantMessageTextTail).toBe("");
  });

  it("does NOT flag when text ends with a period", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [
          messageBlock(
            "Phase 0 complete. All tests passed and the binary is ready.",
          ),
        ],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when text ends with a closing code fence", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [
          messageBlock("Here is the script:\n\n```bash\nls -la\n```"),
        ],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when tool_choice is 'none' (mitigation path output)", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
      tool_choice: "none",
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [messageBlock("Build failed because readline was missing")],
      }),
    });
    // Even though the text has no terminal punctuation, tool_choice=none
    // means we're already on the mitigation path — don't re-flag.
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when input has no prior function_call_output items", () => {
    // Fresh turn with no tool history — the bug does not trigger here.
    const request = {
      model: "grok-4-1-fast-non-reasoning",
      input: [{ role: "user", content: "hi" }],
      tools: [functionTool("system.bash")],
      store: false,
    };
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [messageBlock("hello there friend no period")],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when the response contains a function_call block", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [
          messageBlock("Running next tool"),
          functionCallBlock("system.bash", '{"command":"ls"}'),
        ],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when tools array is empty", () => {
    const request = toolFollowupRequest({ tools: [] });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [messageBlock("Build failed: missing library")],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("does NOT flag when status is not 'completed'", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageBlock("Build failed - truncated")],
      }),
    });
    // Should surface as "incomplete_response", NOT "truncated_response_mid_sentence".
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
    expect(
      result.find((a) => a.code === "incomplete_response"),
    ).toBeDefined();
  });

  it("does NOT flag when incomplete_details is populated", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        // defensive: status=completed + incomplete_details shouldn't happen
        // per xAI docs, but don't trip on it if it does
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageBlock("Build failed truncated")],
      }),
    });
    expect(
      result.find((a) => a.code === "truncated_response_mid_sentence"),
    ).toBeUndefined();
  });

  it("detects truncation at mid-word (no punctuation at all)", () => {
    const request = toolFollowupRequest({
      tools: [functionTool("system.bash")],
    });
    const result = validateXaiResponsePostFlight({
      request,
      response: responseWith({
        status: "completed",
        incomplete_details: null,
        output: [messageBlock("Compilation errors in src/utils.c and src/shell")],
        usage: { input_tokens: 100, output_tokens: 13, total_tokens: 113 },
      }),
    });
    const anomaly = result.find(
      (a) => a.code === "truncated_response_mid_sentence",
    );
    expect(anomaly).toBeDefined();
    expect(anomaly?.evidence.outputTokens).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// pre-flight 128-tool limit enforcement
// ---------------------------------------------------------------------------

describe("validateXaiRequestPreFlight (documented 128-tool limit)", () => {
  it("accepts exactly 128 tools", () => {
    const tools = Array.from({ length: 128 }, (_, i) =>
      functionTool(`tool.${i}`),
    );
    expect(() =>
      validateXaiRequestPreFlight(plainTextRequest({ tools })),
    ).not.toThrow();
  });

  it("rejects 129 tools (the count we were previously sending)", () => {
    const tools = Array.from({ length: 129 }, (_, i) =>
      functionTool(`tool.${i}`),
    );
    expect(() =>
      validateXaiRequestPreFlight(plainTextRequest({ tools })),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("rejects 200 tools with a clear error message", () => {
    const tools = Array.from({ length: 200 }, (_, i) =>
      functionTool(`tool.${i}`),
    );
    try {
      validateXaiRequestPreFlight(plainTextRequest({ tools }));
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XaiUndocumentedFieldError);
      expect((err as Error).message).toContain("200");
      expect((err as Error).message).toContain("128");
    }
  });
});

// ---------------------------------------------------------------------------
// schema constant exposure (so adapter can swap to the shared set)
// ---------------------------------------------------------------------------

describe("DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS", () => {
  it("exposes the canonical field allowlist", () => {
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("model")).toBe(true);
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("input")).toBe(true);
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("tools")).toBe(true);
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("tool_choice")).toBe(true);
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("previous_response_id")).toBe(
      true,
    );
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("store")).toBe(true);
    // legacy / undocumented
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("messages")).toBe(false);
    expect(DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has("response_format")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Audit-driven test cases (post code-review fixes)
// ---------------------------------------------------------------------------

describe("multi-agent specific restrictions", () => {
  it("rejects max_output_tokens on grok-4.20-multi-agent-beta-0309", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-0309",
          max_output_tokens: 1024,
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("allows max_output_tokens on non-multi-agent models", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4-1-fast-non-reasoning",
          max_output_tokens: 1024,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects client-side function tools on multi-agent", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-0309",
          tools: [functionTool("system.bash")],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("allows server-side built-in tools on multi-agent", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-0309",
          tools: [{ type: "web_search" }, { type: "x_search" }],
        }),
      ),
    ).not.toThrow();
  });
});

describe("built-in tool type allowlist", () => {
  it("accepts every documented built-in server-side tool type", () => {
    for (const t of [
      "function",
      "web_search",
      "x_search",
      "code_interpreter",
      "code_execution",
      "collections_search",
      "file_search",
      "attachment_search",
      "mcp",
    ]) {
      const tools =
        t === "function"
          ? [functionTool("system.bash")]
          : [{ type: t }];
      expect(() =>
        validateXaiRequestPreFlight(plainTextRequest({ tools })),
      ).not.toThrow();
    }
  });

  it("rejects unknown tool type strings (typo guard)", () => {
    for (const bad of ["webSearch", "web-search", "WebSearch", "code_runner", ""]) {
      expect(() =>
        validateXaiRequestPreFlight(
          plainTextRequest({ tools: [{ type: bad }] }),
        ),
      ).toThrow(XaiUndocumentedFieldError);
    }
  });

  it("rejects tool entries with no type field", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({ tools: [{ name: "no_type" }] }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });
});

describe("image/video models reject tools[]", () => {
  it("throws when tools are passed to grok-imagine-image", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-imagine-image",
          tools: [functionTool("system.bash")],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("allows grok-imagine-image with no tools", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({ model: "grok-imagine-image" }),
      ),
    ).not.toThrow();
  });
});

describe("post-flight: failed_response anomaly", () => {
  // HIGH fix: response.status === "failed" must be surfaced.
  it("emits failed_response severity=error when status is 'failed'", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({
        status: "failed",
        error: { message: "model overloaded", code: "rate_limit" },
        output: [],
      }),
    });
    const failed = result.find((a) => a.code === "failed_response");
    expect(failed).toBeDefined();
    expect(failed?.severity).toBe("error");
    expect(String(failed?.message)).toContain("model overloaded");
  });

  it("uses a sane default message when error.message is missing", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({
        status: "failed",
        error: null,
        output: [],
      }),
    });
    const failed = result.find((a) => a.code === "failed_response");
    expect(failed).toBeDefined();
    expect(String(failed?.message)).toContain("Provider returned status");
  });
});

// ---------------------------------------------------------------------------
// Corrupt reasoning summary detector (grok-code-fast-1 //TODO degeneracy)
// ---------------------------------------------------------------------------

describe("detectCorruptReasoningSummary", () => {
  // Pattern taken from a real grok-code-fast-1 trace payload captured
  // 2026-04-16:
  // ~/.agenc/trace-payloads/background_session_2ab885d9.../
  //   1776327393138-background_run.provider.response-1920efa8fd22.json
  // at .payload.payload.output[0].summary[0].text
  const CORRUPT_SUMMARY_SAMPLE =
    "//TODO: Fix typo in existing summary if needed, //TODO: Fix typo in existing summary if needed, //TODO: Fix typo in editFile function name typo in existing summary if needed\n\n" +
    "//TODO: Fix typo in existing summary if Ne\n\n" +
    "//TODO: editFile -> editFile\n\n" +
    "//TODO: fix typo in existing summary if needed\n\n" +
    "//TODO: fix typo \"make\" instead of \"make\"\n\n" +
    "//TODO: Fix ignored ignored ignored ignored ig\n\n" +
    "//TODO: ig\n\n" +
    "//TODO: ig\n\n" +
    "// junk ignored ignored ignored ig\n";

  it("flags the captured grok-code-fast-1 degenerate summary", () => {
    const corrupt = detectCorruptReasoningSummary([
      reasoningBlock(CORRUPT_SUMMARY_SAMPLE),
    ]);
    expect(corrupt.length).toBe(1);
    expect(corrupt[0]?.commentCount).toBeGreaterThanOrEqual(5);
    expect(corrupt[0]?.itemIndex).toBe(0);
    expect(corrupt[0]?.entryIndex).toBe(0);
    expect(corrupt[0]?.preview.startsWith("//TODO:")).toBe(true);
  });

  it("does NOT flag clean multi-paragraph reasoning summaries", () => {
    const cleanReasoning =
      "First, inspect the existing tests in the llm/ directory to understand how the current executor validates tool output.\n\n" +
      "Then, update chat-executor-tool-loop.ts to accept a new cache option.\n\n" +
      "Finally, run the targeted tests under runtime/src/llm/ to confirm the change.";
    const corrupt = detectCorruptReasoningSummary([
      reasoningBlock(cleanReasoning),
    ]);
    expect(corrupt).toEqual([]);
  });

  it("does NOT flag tool-call argument strings that contain '//' legitimately", () => {
    const corrupt = detectCorruptReasoningSummary([
      functionCallBlock(
        "system.editFile",
        '{"old_string":"// Simple parameter expansion for $VAR\\n","new_string":"// Updated comment\\n"}',
      ),
    ]);
    expect(corrupt).toEqual([]);
  });

  it("does NOT flag short summaries that mention '//TODO' legitimately", () => {
    const substantiveWithTodo =
      "The existing code has a //TODO comment about refactoring the parser entry point; I will evaluate whether this refactor is in scope for the current task before touching the lexer module.\n\n" +
      "There is also a //TODO near the shell_state destructor that mentions freeing arg-expansion buffers, but that's out of scope.";
    const corrupt = detectCorruptReasoningSummary([
      reasoningBlock(substantiveWithTodo),
    ]);
    expect(corrupt).toEqual([]);
  });

  it("surfaces the anomaly through validateXaiResponsePostFlight as warn severity", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest({ model: "grok-code-fast-1" }),
      response: responseWith({
        model: "grok-code-fast-1",
        output: [reasoningBlock(CORRUPT_SUMMARY_SAMPLE)],
      }),
    });
    const anomaly = result.find(
      (a) => a.code === "corrupt_reasoning_summary",
    );
    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe("warn");
    const evidence = anomaly?.evidence as {
      count?: number;
      blocks?: Array<Record<string, unknown>>;
    };
    expect(evidence?.count).toBe(1);
    expect(evidence?.blocks?.length).toBe(1);
  });

  it("does not fire on empty or non-array outputs", () => {
    expect(detectCorruptReasoningSummary([])).toEqual([]);
    expect(detectCorruptReasoningSummary(undefined)).toEqual([]);
    expect(detectCorruptReasoningSummary(null)).toEqual([]);
  });
});
