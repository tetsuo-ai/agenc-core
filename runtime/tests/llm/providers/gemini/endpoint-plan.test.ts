import { describe, expect, test } from "vitest";

import {
  canonicalGeminiModelName,
  createGeminiEndpointPlan,
  geminiEndpointFor,
  parseGeminiEndpointPlan,
} from "./endpoint-plan.js";
import { GEMINI_DEVELOPER_NATIVE_BASE_URL } from "../../registry/provider-info.js";

describe("Gemini endpoint plan", () => {
  test("creates the exact immutable Developer API endpoint", () => {
    const plan = createGeminiEndpointPlan();

    expect(plan).toEqual({
      kind: "developer",
      nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(plan.nativeBaseURL).toBe(GEMINI_DEVELOPER_NATIVE_BASE_URL);
    expect(geminiEndpointFor(plan)).toBe(plan.nativeBaseURL);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  test.each([
    GEMINI_DEVELOPER_NATIVE_BASE_URL,
    `${GEMINI_DEVELOPER_NATIVE_BASE_URL}/`,
  ])("canonicalizes native Developer API ingress %s", (baseURL) => {
    expect(createGeminiEndpointPlan({ baseURL })).toEqual(
      createGeminiEndpointPlan(),
    );
  });

  test.each([
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/endpoints/openapi",
    "https://gateway.example/gemini/openai",
  ])("rejects OpenAI-compatible Gemini endpoint %s", (baseURL) => {
    expect(() => createGeminiEndpointPlan({ baseURL })).toThrow(
      /native|OpenAI-compatible/u,
    );
  });

  test.each([
    "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
    "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
  ])("creates the exact regional Vertex endpoint from %s", (baseURL) => {
    expect(createGeminiEndpointPlan({ baseURL })).toEqual({
      kind: "vertex",
      project: "project-1",
      location: "us-central1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    });
  });

  test.each([
    "https://aiplatform.googleapis.com/v1/projects/global-project/locations/global",
    "https://aiplatform.googleapis.com/v1/projects/global-project/locations/global/publishers/google",
  ])("creates the exact global Vertex endpoint from %s", (baseURL) => {
    expect(createGeminiEndpointPlan({ baseURL })).toEqual({
      kind: "vertex",
      project: "global-project",
      location: "global",
      nativeBaseURL:
        "https://aiplatform.googleapis.com/v1/projects/global-project/locations/global/publishers/google",
    });
  });

  test("constructs a Vertex endpoint from explicit target authority", () => {
    expect(
      createGeminiEndpointPlan({
        vertex: { project: "project with spaces", location: "GLOBAL" },
      }),
    ).toEqual({
      kind: "vertex",
      project: "project with spaces",
      location: "global",
      nativeBaseURL:
        "https://aiplatform.googleapis.com/v1/projects/project%20with%20spaces/locations/global/publishers/google",
    });
  });

  test.each(["bad location", "../global", "us-central1@evil.example", "-bad"])(
    "rejects unsafe Vertex location %s",
    (location) => {
      expect(() =>
        createGeminiEndpointPlan({
          vertex: { project: "project-1", location },
        })
      ).toThrow(/valid region identifier/u);
    },
  );

  test.each([
    [
      "https://us-east1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
      undefined,
    ],
    [
      "https://aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
      undefined,
    ],
    [
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/global",
      undefined,
    ],
    [
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
      { project: "other-project", location: "us-central1" },
    ],
  ] as const)("rejects mismatched Vertex authority in %s", (baseURL, vertex) => {
    expect(() => createGeminiEndpointPlan({ baseURL, vertex })).toThrow(
      /Vertex|conflicts/u,
    );
  });

  test.each([
    "https://generativelanguage.googleapis.com.attacker.example/v1beta",
    "https://us-central1-aiplatform.googleapis.com.attacker.example/v1/projects/project-1/locations/us-central1",
    "https://attacker-googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com:8443/v1beta",
    "https://us-central1-aiplatform.googleapis.com:8443/v1/projects/project-1/locations/us-central1",
  ])("rejects Google API lookalike or noncanonical authority %s", (baseURL) => {
    expect(() => createGeminiEndpointPlan({ baseURL })).toThrow();
  });

  test.each([
    "https://proxy.example/gemini?key=value",
    "https://proxy.example/gemini#fragment",
  ])("rejects query or fragment state in %s", (baseURL) => {
    expect(() => createGeminiEndpointPlan({ baseURL })).toThrow(
      /query or fragment/u,
    );
  });

  test.each([
    "https://user@proxy.example/gemini",
    "https://user:password@proxy.example/gemini",
  ])("rejects URL credentials in %s", (baseURL) => {
    expect(() => createGeminiEndpointPlan({ baseURL })).toThrow(/credentials/u);
  });

  test.each(["http://proxy.example/gemini", "ftp://localhost/gemini"])(
    "rejects insecure non-loopback endpoint %s",
    (baseURL) => {
      expect(() => createGeminiEndpointPlan({ baseURL })).toThrow(
        /HTTPS unless it targets loopback/u,
      );
    },
  );

  test.each([
    "https://proxy.example/v1/chat/completions",
    "https://proxy.example/v1/responses",
    "https://proxy.example/v1/models",
    "https://proxy.example/v1/models/gemini-2.5-pro:generateContent",
    "https://proxy.example/v1/models/gemini-2.5-pro:streamGenerateContent",
    "https://proxy.example/v1/models/gemini-2.5-pro:countTokens",
  ])("rejects operation URL %s", (baseURL) => {
    expect(() => createGeminiEndpointPlan({ baseURL })).toThrow(/API root/u);
  });

  test("rejects a serialized undefined base URL", () => {
    expect(() => createGeminiEndpointPlan({ baseURL: " undefined " })).toThrow(
      /literal "undefined"/u,
    );
  });

  test.each([
    "http://127.0.0.1:8080/v1beta",
    "http://localhost:8080/v1beta",
    "http://[::1]:8080/v1beta/",
  ])("accepts loopback native endpoint %s", (baseURL) => {
    const plan = createGeminiEndpointPlan({ baseURL });
    expect(plan).toEqual({
      kind: "custom",
      nativeBaseURL: baseURL.replace(/\/$/u, ""),
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  test("keeps a custom HTTPS native endpoint exact", () => {
    expect(
      createGeminiEndpointPlan({
        baseURL: "https://gateway.example/gemini-native/",
      }),
    ).toEqual({
      kind: "custom",
      nativeBaseURL: "https://gateway.example/gemini-native",
    });
  });

  test("rejects a custom endpoint combined with Vertex authority", () => {
    expect(() =>
      createGeminiEndpointPlan({
        baseURL: "https://gateway.example/gemini",
        vertex: { project: "project-1", location: "us-central1" },
      })
    ).toThrow(/custom Gemini baseURL cannot also declare a Vertex target/u);
  });

  test("strictly parses and freezes a canonical serialized plan", () => {
    const serialized = {
      kind: "vertex",
      project: "project-1",
      location: "us-central1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    };
    const parsed = parseGeminiEndpointPlan(serialized);

    expect(parsed).toEqual(serialized);
    expect(parsed).not.toBe(serialized);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test.each([
    undefined,
    null,
    [],
    {},
    {
      kind: "developer",
      nativeBaseURL: GEMINI_DEVELOPER_NATIVE_BASE_URL,
      project: "not-allowed",
    },
    {
      kind: "custom",
      nativeBaseURL: GEMINI_DEVELOPER_NATIVE_BASE_URL,
    },
    {
      kind: "vertex",
      project: "project-1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    },
    { kind: "custom", nativeBaseURL: "undefined" },
  ])("rejects noncanonical serialized endpoint plan %#", (value) => {
    expect(() => parseGeminiEndpointPlan(value)).toThrow();
  });

  test.each([
    "gemini:models/gemini-2.5-pro",
    "publishers/google/models/gemini-2.5-pro",
    "google/gemini-2.5-pro",
  ])("projects canonical native model name from %s", (model) => {
    expect(canonicalGeminiModelName(model)).toBe("gemini-2.5-pro");
  });
});
