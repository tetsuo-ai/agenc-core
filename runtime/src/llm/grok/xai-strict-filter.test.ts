import { describe, it, expect } from "vitest";

import {
  assertNoSilentToolDropOnFollowup,
  DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS,
  modelIsReasoningVariant,
  modelSupportsFunctionCalling,
  modelSupportsReasoningEffort,
  resolveDocumentedXaiModel,
  validateXaiRequestPreFlight,
  validateXaiResponsePostFlight,
  XaiSilentToolDropError,
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
    expect(resolveDocumentedXaiModel("grok-4.20-beta-0309-reasoning")).toBe(
      "grok-4.20-beta-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4-1-fast-non-reasoning")).toBe(
      "grok-4-1-fast-non-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent-beta-0309")).toBe(
      "grok-4.20-multi-agent-beta-0309",
    );
  });

  it("resolves bare-name aliases to canonical", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-reasoning")).toBe(
      "grok-4.20-beta-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent")).toBe(
      "grok-4.20-multi-agent-beta-0309",
    );
  });

  it("resolves -latest aliases to canonical", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-reasoning-latest")).toBe(
      "grok-4.20-beta-0309-reasoning",
    );
    expect(
      resolveDocumentedXaiModel("grok-4-1-fast-non-reasoning-latest"),
    ).toBe("grok-4-1-fast-non-reasoning");
  });

  it("resolves stale non-beta 4.20 IDs to current beta catalog IDs", () => {
    expect(resolveDocumentedXaiModel("grok-4.20-0309-reasoning")).toBe(
      "grok-4.20-beta-0309-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-0309-non-reasoning")).toBe(
      "grok-4.20-beta-0309-non-reasoning",
    );
    expect(resolveDocumentedXaiModel("grok-4.20-multi-agent-0309")).toBe(
      "grok-4.20-multi-agent-beta-0309",
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
    expect(modelSupportsReasoningEffort("grok-4.20-multi-agent-beta-0309")).toBe(
      true,
    );
    expect(modelSupportsReasoningEffort("grok-4.20-beta-0309-reasoning")).toBe(false);
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
          model: "grok-4.20-multi-agent-beta-0309",
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
            model: "grok-4.20-multi-agent-beta-0309",
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
          model: "grok-4.20-multi-agent-beta-0309",
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

  // Silent-tool-drop is now handled by assertNoSilentToolDropOnFollowup
  // (which has access to runtime tool-selection diagnostics) — see the
  // dedicated suite below.
});

describe("assertNoSilentToolDropOnFollowup", () => {
  // This is the bug from 2026-04-09. The runtime had tools registered
  // (selectedTools.tools.length > 0) but MAX_TOOL_SCHEMA_CHARS_FOLLOWUP
  // dropped them on follow-up turns, so params.tools was missing.
  it("throws XaiSilentToolDropError when runtime had tools but params.tools is missing on a followup", () => {
    const followupParams = toolFollowupRequest();
    delete followupParams.tools;
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        outgoingParams: followupParams,
      }),
    ).toThrow(XaiSilentToolDropError);
  });

  it("throws XaiSilentToolDropError when params.tools is present but empty after a followup", () => {
    const followupParams = toolFollowupRequest({ tools: [] });
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 3,
        outgoingParams: followupParams,
      }),
    ).toThrow(XaiSilentToolDropError);
  });

  it("does NOT throw when the runtime intentionally has zero tools registered", () => {
    const followupParams = toolFollowupRequest({ tools: [] });
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 0,
        outgoingParams: followupParams,
      }),
    ).not.toThrow();
  });

  it("does NOT throw when tools made it through to the final params", () => {
    const followupParams = toolFollowupRequest();
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 1,
        outgoingParams: followupParams,
      }),
    ).not.toThrow();
  });

  it("does NOT throw on a fresh non-followup turn even if tools are missing", () => {
    // Plain text request, no function_call_output items, runtime has no
    // tools registered → no anti-pattern.
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 0,
        outgoingParams: plainTextRequest(),
      }),
    ).not.toThrow();
  });

  it("throws XaiSilentToolDropError with the right discriminator and evidence", () => {
    const followupParams = toolFollowupRequest();
    delete followupParams.tools;
    try {
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 7,
        outgoingParams: followupParams,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(XaiSilentToolDropError);
      const err = e as XaiSilentToolDropError;
      expect(err.turnKind).toBe("outgoing_followup_tools_empty");
      expect(err.statusCode).toBe(200);
      expect(err.failureClass).toBe("provider_error");
      expect(err.evidence).toMatchObject({
        runtimeIntendedToolCount: 7,
        outgoingToolCount: 0,
        toolFollowupCount: 1,
      });
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

describe("validateXaiResponsePostFlight (silent-drop detection — the bug we hit)", () => {
  it("detects silent tool drop when response has 0 function_calls and message text contains 'I will call'", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [
          reasoningBlock("Need to call the build tool"),
          messageBlock(
            "I will call the build tool now and report the result.",
          ),
        ],
      }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "silent_tool_drop_promised_in_text",
      severity: "error",
    });
  });

  it("detects 'now executing'", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [messageBlock("Now executing the next step.")],
      }),
    });
    expect(result[0]?.code).toBe("silent_tool_drop_promised_in_text");
  });

  it("detects 'continuing with tool calls' (the exact phrase from the live trace)", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [
          messageBlock(
            "**Starting Phase 0 bootstrap and sequential phase implementation per PLAN.md.**\n\n(Continuing with tool calls to bootstrap.)",
          ),
        ],
      }),
    });
    expect(result[0]?.code).toBe("silent_tool_drop_promised_in_text");
  });

  it("detects 'next, I'll run'", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [messageBlock("Done with phase 1. Next, I'll run the test suite.")],
      }),
    });
    expect(result[0]?.code).toBe("silent_tool_drop_promised_in_text");
  });

  it("does NOT detect normal explanatory English ('I will write the explanation')", () => {
    // Regression test for the previous PROMISE_LANGUAGE_RE which matched
    // `create` and `write` and produced false positives on legitimate
    // assistant prose.
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [
          messageBlock(
            "I will write the explanation in the next paragraph. " +
              "Let me create a summary for you below.",
          ),
        ],
      }),
    });
    expect(result).toEqual([]);
  });

  it("detects 'let me run'", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [messageBlock("Let me run the test now.")],
      }),
    });
    expect(result[0]?.code).toBe("silent_tool_drop_promised_in_text");
  });

  it("evidence carries the message text preview", () => {
    const text = "I will call system.bash to do the thing";
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [messageBlock(text)],
      }),
    });
    expect(result[0]?.evidence).toMatchObject({
      sentToolCount: 1,
      toolCallBlockCount: 0,
    });
    expect(String(result[0]?.evidence.messageTextPreview)).toContain(
      "I will call",
    );
  });

  it("does NOT detect when zero tools were sent (no anti-pattern possible)", () => {
    const result = validateXaiResponsePostFlight({
      request: plainTextRequest(),
      response: responseWith({
        output: [messageBlock("I will call the tool now.")],
      }),
    });
    expect(result).toEqual([]);
  });
});

describe("validateXaiResponsePostFlight (model aliasing)", () => {
  it("detects silent server alias when requested ≠ response and not in alias map", () => {
    const result = validateXaiResponsePostFlight({
      request: { ...plainTextRequest(), model: "grok-4.20-beta-0309-reasoning" },
      response: responseWith({ model: "grok-4.20-0309-reasoning" }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "model_silently_aliased",
      severity: "warn",
    });
    expect(result[0]?.evidence).toMatchObject({
      requestedModel: "grok-4.20-beta-0309-reasoning",
      responseModel: "grok-4.20-0309-reasoning",
    });
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
          model: "grok-4.20-multi-agent-beta-0309",
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
          model: "grok-4.20-multi-agent-beta-0309",
          tools: [functionTool("system.bash")],
        }),
      ),
    ).toThrow(XaiUndocumentedFieldError);
  });

  it("allows server-side built-in tools on multi-agent", () => {
    expect(() =>
      validateXaiRequestPreFlight(
        plainTextRequest({
          model: "grok-4.20-multi-agent-beta-0309",
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

describe("assertNoSilentToolDropOnFollowup with toolSuppressionReason", () => {
  // BLOCKER fix: when the runtime intentionally suppressed tools (e.g.
  // vision_model_without_tool_support, empty_allowlist), the helper must
  // not throw — the empty `tools` field was on purpose, not a bug.
  it("does NOT throw when toolSuppressionReason is set (vision_model_without_tool_support)", () => {
    const params = toolFollowupRequest({});
    delete params.tools;
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        toolSuppressionReason: "vision_model_without_tool_support",
        outgoingParams: params,
      }),
    ).not.toThrow();
  });

  it("does NOT throw when toolSuppressionReason is set (empty_allowlist)", () => {
    const params = toolFollowupRequest({});
    delete params.tools;
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        toolSuppressionReason: "empty_allowlist",
        outgoingParams: params,
      }),
    ).not.toThrow();
  });

  it("DOES throw when toolSuppressionReason is undefined and the bug pattern matches", () => {
    const params = toolFollowupRequest({});
    delete params.tools;
    expect(() =>
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        outgoingParams: params,
      }),
    ).toThrow(XaiSilentToolDropError);
  });

  it("evidence carries isFollowupTurn discriminator on followup turns", () => {
    const params = toolFollowupRequest({});
    delete params.tools;
    try {
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        outgoingParams: params,
      });
    } catch (e) {
      expect((e as XaiSilentToolDropError).evidence).toMatchObject({
        isFollowupTurn: true,
        toolFollowupCount: 1,
      });
    }
  });

  it("evidence sets isFollowupTurn=false on non-followup turns", () => {
    // The runtime had tools but the params went out empty on a turn
    // with no function_call_output items. Still a bug, but the
    // discriminator should reflect it's not a followup.
    const params = plainTextRequest();
    delete params.tools;
    try {
      assertNoSilentToolDropOnFollowup({
        runtimeIntendedToolCount: 5,
        outgoingParams: params,
      });
    } catch (e) {
      expect((e as XaiSilentToolDropError).evidence).toMatchObject({
        isFollowupTurn: false,
        toolFollowupCount: 0,
      });
    }
  });
});

describe("post-flight: server-side tool call types count as tool calls", () => {
  // HIGH fix: web_search_call, x_search_call, code_interpreter_call,
  // file_search_call, mcp_call all satisfy "the model issued a tool call"
  // and must NOT trigger the silent_tool_drop_promised_in_text anomaly.
  for (const callType of [
    "web_search_call",
    "x_search_call",
    "code_interpreter_call",
    "file_search_call",
    "mcp_call",
  ]) {
    it(`does NOT flag silent tool drop when response contains ${callType}`, () => {
      const result = validateXaiResponsePostFlight({
        request: toolFollowupRequest(),
        response: responseWith({
          output: [
            { type: callType, id: "x", status: "completed" },
            messageBlock("I will call the tool again next."),
          ],
        }),
      });
      expect(
        result.find((a) => a.code === "silent_tool_drop_promised_in_text"),
      ).toBeUndefined();
    });
  }
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

describe("post-flight: extractMessageText walks reasoning blocks", () => {
  // MEDIUM fix: Grok puts promise language in reasoning.summary[].text too.
  it("detects promise language in reasoning block summaries", () => {
    const result = validateXaiResponsePostFlight({
      request: toolFollowupRequest(),
      response: responseWith({
        output: [
          {
            type: "reasoning",
            id: "rs_test",
            status: "completed",
            summary: [
              {
                type: "summary_text",
                text: "I will call system.bash to bootstrap the project.",
              },
            ],
          },
          messageBlock("One moment."),
        ],
      }),
    });
    expect(result[0]?.code).toBe("silent_tool_drop_promised_in_text");
  });
});

describe("post-flight: tightened PROMISE_LANGUAGE_RE", () => {
  // Coverage for the regex tightening: `create` and `write` were removed
  // because they false-positive on normal explanatory prose.
  for (const phrase of [
    "I will create a summary for you in this section.",
    "Let me write the explanation here.",
    "I'll write a brief overview of the steps.",
    "Going to create the table below to compare the options.",
  ]) {
    it(`does NOT match normal English: "${phrase.slice(0, 40)}…"`, () => {
      const result = validateXaiResponsePostFlight({
        request: toolFollowupRequest(),
        response: responseWith({ output: [messageBlock(phrase)] }),
      });
      expect(
        result.find((a) => a.code === "silent_tool_drop_promised_in_text"),
      ).toBeUndefined();
    });
  }
});
