import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function readRepoFile(relativePath: string): Promise<string> {
  const absolutePath = path.join(repoRoot(), relativePath);
  return await readFile(absolutePath, "utf8");
}

describe("compiled job Phase 1 launch-readiness docs", () => {
  it("includes incident, abuse, retention, and checklist sections", async () => {
    const content = await readRepoFile(
      "runtime/docs/compiled-job-phase1-launch-readiness.md",
    );

    expect(content).toContain("## Trigger Conditions");
    expect(content).toContain("## Incident And Abuse Response Runbook");
    expect(content).toContain("## Abuse Escalation");
    expect(content).toContain("## Audit-Log Retention Policy");
    expect(content).toContain("## Phase 1 Release Checklist");
    expect(content).toContain("agenc.task.compiled_job.blocked.count");
    expect(content).toContain("compiled_job.policy_failure_spike");
    expect(content).toContain("compiled_job.domain_denied_spike");
    expect(content).toContain("archive");
    expect(content).toContain("compiledPlanHash");
    expect(content).toContain("`web_research_brief`");
    expect(content).toContain("`lead_list_building`");
    expect(content).toContain("`product_comparison_report`");
    expect(content).toContain("`spreadsheet_cleanup_classification`");
    expect(content).toContain("`transcript_to_deliverables`");
    expect(content).toContain("missing execution context for workspace-bound jobs must fail closed");
  });

  it("is linked from the repo and deployment indexes", async () => {
    const docsIndex = await readRepoFile("docs/DOCS_INDEX.md");
    const deploymentChecklist = await readRepoFile("docs/DEPLOYMENT_CHECKLIST.md");
    const moduleMap = await readRepoFile("runtime/docs/MODULE_MAP.md");

    expect(docsIndex).toContain(
      "runtime/docs/compiled-job-phase1-launch-readiness.md",
    );
    expect(deploymentChecklist).toContain(
      "runtime/docs/compiled-job-phase1-launch-readiness.md",
    );
    expect(moduleMap).toContain("compiled-job-phase1-launch-readiness.md");
  });
});
