import { describe, expect, it } from "vitest";
import {
  evaluateCompiledJobVersionAccess,
  resolveCompiledJobVersionControls,
} from "./compiled-job-version-controls.js";

describe("compiled job version controls", () => {
  it("defaults to no version restrictions", () => {
    const controls = resolveCompiledJobVersionControls();

    expect(controls).toEqual({
      enabledCompilerVersions: [],
      disabledCompilerVersions: [],
      enabledPolicyVersions: [],
      disabledPolicyVersions: [],
    });
  });

  it("reads compiler and policy version lists from env", () => {
    const controls = resolveCompiledJobVersionControls({
      env: {
        AGENC_COMPILED_JOB_ENABLED_COMPILER_VERSIONS:
          "agenc.web.bounded-task-template.v1, agenc.approved-task-template.v1",
        AGENC_COMPILED_JOB_DISABLED_COMPILER_VERSIONS:
          "agenc.legacy-template.v1",
        AGENC_COMPILED_JOB_ENABLED_POLICY_VERSIONS:
          "agenc.runtime.compiled-job-policy.v1",
        AGENC_COMPILED_JOB_DISABLED_POLICY_VERSIONS:
          "agenc.runtime.compiled-job-policy.v0",
      },
    });

    expect(controls).toEqual({
      enabledCompilerVersions: [
        "agenc.web.bounded-task-template.v1",
        "agenc.approved-task-template.v1",
      ],
      disabledCompilerVersions: ["agenc.legacy-template.v1"],
      enabledPolicyVersions: ["agenc.runtime.compiled-job-policy.v1"],
      disabledPolicyVersions: ["agenc.runtime.compiled-job-policy.v0"],
    });
  });

  it("rejects compiler versions outside the enabled allowlist", () => {
    const decision = evaluateCompiledJobVersionAccess({
      compilerVersion: "agenc.web.bounded-task-template.v1",
      policyVersion: "agenc.runtime.compiled-job-policy.v1",
      controls: resolveCompiledJobVersionControls({
        base: {
          enabledCompilerVersions: ["agenc.approved-task-template.v1"],
        },
      }),
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "compiler_version_not_enabled",
      message:
        'Compiled job compiler version "agenc.web.bounded-task-template.v1" is not enabled in runtime version controls',
    });
  });

  it("rejects disabled policy versions", () => {
    const decision = evaluateCompiledJobVersionAccess({
      compilerVersion: "agenc.web.bounded-task-template.v1",
      policyVersion: "agenc.runtime.compiled-job-policy.v1",
      controls: resolveCompiledJobVersionControls({
        base: {
          disabledPolicyVersions: ["agenc.runtime.compiled-job-policy.v1"],
        },
      }),
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "policy_version_disabled",
      message:
        'Compiled job policy version "agenc.runtime.compiled-job-policy.v1" is disabled by runtime version controls',
    });
  });
});
