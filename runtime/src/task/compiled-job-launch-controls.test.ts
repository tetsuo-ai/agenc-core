import { describe, expect, it } from "vitest";
import {
  evaluateCompiledJobLaunchAccess,
  resolveCompiledJobLaunchControls,
} from "./compiled-job-launch-controls.js";

describe("compiled job launch controls", () => {
  it("defaults to launch-enabled execution with no per-job overrides", () => {
    const controls = resolveCompiledJobLaunchControls();

    expect(controls).toEqual({
      executionEnabled: true,
      paused: false,
      enabledJobTypes: [],
      disabledJobTypes: [],
    });
  });

  it("reads global pause and job lists from env", () => {
    const controls = resolveCompiledJobLaunchControls({
      env: {
        AGENC_COMPILED_JOB_EXECUTION_ENABLED: "true",
        AGENC_COMPILED_JOB_EXECUTION_PAUSED: "yes",
        AGENC_COMPILED_JOB_ENABLED_TYPES:
          "web_research_brief, product_comparison_report",
        AGENC_COMPILED_JOB_DISABLED_TYPES: "lead_list_building",
      },
    });

    expect(controls).toEqual({
      executionEnabled: true,
      paused: true,
      enabledJobTypes: [
        "web_research_brief",
        "product_comparison_report",
      ],
      disabledJobTypes: ["lead_list_building"],
    });
  });

  it("rejects execution when the global kill switch is off", () => {
    const decision = evaluateCompiledJobLaunchAccess({
      jobType: "web_research_brief",
      supportedJobTypes: ["web_research_brief"],
      controls: resolveCompiledJobLaunchControls({
        base: { executionEnabled: false },
      }),
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "launch_execution_disabled",
      message:
        "Compiled marketplace job execution is disabled by runtime launch controls",
    });
  });

  it("rejects execution when a job type is not in the enabled launch set", () => {
    const decision = evaluateCompiledJobLaunchAccess({
      jobType: "web_research_brief",
      supportedJobTypes: ["web_research_brief", "product_comparison_report"],
      controls: resolveCompiledJobLaunchControls({
        base: {
          enabledJobTypes: ["product_comparison_report"],
        },
      }),
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "launch_job_type_not_enabled",
      message:
        'Compiled job type "web_research_brief" is not enabled in runtime launch controls',
    });
  });
});
