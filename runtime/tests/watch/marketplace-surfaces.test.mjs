import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMarketplaceInspectOverview,
  buildMarketplaceInspectSurface,
  buildMarketplaceReputationInspectPlaceholder,
  REPUTATION_INSPECT_PLACEHOLDER_MESSAGE,
  resolveMarketplaceInspectSurface,
} from "../../src/marketplace/surfaces.mjs";

test("resolveMarketplaceInspectSurface normalizes shared marketplace aliases", () => {
  assert.equal(resolveMarketplaceInspectSurface("market", null), "marketplace");
  assert.equal(resolveMarketplaceInspectSurface("gov", null), "governance");
  assert.equal(resolveMarketplaceInspectSurface("rep", null), "reputation");
});

test("buildMarketplaceReputationInspectPlaceholder requires agent input", () => {
  const surface = buildMarketplaceReputationInspectPlaceholder();

  assert.equal(surface.surface, "reputation");
  assert.equal(surface.status, "requires_input");
  assert.equal(surface.message, REPUTATION_INSPECT_PLACEHOLDER_MESSAGE);
});

test("buildMarketplaceInspectSurface preserves enriched dispute aliases and stake fields", () => {
  const surface = buildMarketplaceInspectSurface({
    surface: "disputes",
    items: [
      {
        disputePda: "dispute-1",
        taskPda: "task-1",
        initiator: "agent-initiator",
        defendant: "agent-defendant",
        claimant: "agent-initiator",
        respondent: "agent-defendant",
        status: "active",
        resolutionType: "refund",
        evidenceHash: "abc123",
        amountAtStake: "2500000000",
        amountAtStakeSol: "2.5",
        amountAtStakeMint: null,
        votesFor: "2",
        votesAgainst: "0",
        totalVoters: 2,
        createdAt: 1,
        votingDeadline: 2,
        expiresAt: 3,
        resolvedAt: 0,
        slashApplied: false,
        initiatorSlashApplied: false,
        workerStakeAtDispute: "0",
        initiatedByCreator: false,
        rewardMint: null,
      },
    ],
  });

  assert.equal(surface.surface, "disputes");
  assert.equal(surface.items[0].claimant, "agent-initiator");
  assert.equal(surface.items[0].respondent, "agent-defendant");
  assert.equal(surface.items[0].amountAtStake, "2500000000");
  assert.equal(surface.items[0].amountAtStakeSol, "2.5");
  assert.equal(surface.items[0].amountAtStakeMint, null);
});

test("buildMarketplaceInspectOverview aggregates marketplace child surfaces", () => {
  const tasks = buildMarketplaceInspectSurface({
    surface: "tasks",
    items: [{ taskPda: "task-1", status: "open" }],
  });
  const reputation = buildMarketplaceReputationInspectPlaceholder();
  const overview = buildMarketplaceInspectOverview({
    surfaces: [tasks, reputation],
  });

  assert.equal(overview.surface, "marketplace");
  assert.equal(overview.count, 2);
  assert.equal(overview.status, "requires_input");
  assert.equal(overview.overview.tasks.count, 1);
  assert.equal(overview.overview.reputation.status, "requires_input");
});
