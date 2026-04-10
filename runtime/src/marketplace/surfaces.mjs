const MARKETPLACE_SURFACE_ALIASES = new Map([
  ["market", "marketplace"],
  ["marketplace", "marketplace"],
  ["markets", "marketplace"],
  ["overview", "marketplace"],
  ["task", "tasks"],
  ["tasks", "tasks"],
  ["skill", "skills"],
  ["skills", "skills"],
  ["governance", "governance"],
  ["gov", "governance"],
  ["proposal", "governance"],
  ["proposals", "governance"],
  ["dispute", "disputes"],
  ["disputes", "disputes"],
  ["reputation", "reputation"],
  ["rep", "reputation"],
]);

const MARKETPLACE_SURFACE_META = {
  marketplace: {
    title: "Marketplace Overview",
    noun: "surface",
    countNoun: "surface",
    loadingLabel: "Loading marketplace overview…",
    emptyLabel: "No marketplace surfaces available.",
  },
  tasks: {
    title: "Marketplace Tasks",
    noun: "task",
    countNoun: "task",
    loadingLabel: "Loading marketplace tasks…",
    emptyLabel: "No marketplace tasks found.",
  },
  skills: {
    title: "Marketplace Skills",
    noun: "skill",
    countNoun: "skill",
    loadingLabel: "Loading marketplace skills…",
    emptyLabel: "No marketplace skills found.",
  },
  governance: {
    title: "Governance Proposals",
    noun: "proposal",
    countNoun: "proposal",
    loadingLabel: "Loading governance proposals…",
    emptyLabel: "No governance proposals found.",
  },
  disputes: {
    title: "Marketplace Disputes",
    noun: "dispute",
    countNoun: "dispute",
    loadingLabel: "Loading marketplace disputes…",
    emptyLabel: "No marketplace disputes found.",
  },
  reputation: {
    title: "Reputation Summary",
    noun: "reputation summary",
    countNoun: "record",
    loadingLabel: "Loading reputation summary…",
    emptyLabel: "No reputation summary available.",
  },
};

const MARKETPLACE_BROWSER_KINDS = new Set([
  "tasks",
  "skills",
  "governance",
  "disputes",
  "reputation",
]);

const REPUTATION_INSPECT_PLACEHOLDER_MESSAGE =
  "Provide <agentPda> to inspect a reputation summary deterministically.";

function readSurfaceToken(value) {
  if (value && typeof value === "object") {
    if (typeof value.surface === "string") {
      return value.surface;
    }
    if (typeof value.kind === "string") {
      return value.kind;
    }
    if (value.browser && typeof value.browser === "object" && typeof value.browser.kind === "string") {
      return value.browser.kind;
    }
  }
  return value;
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function inspectSurfaceKind(value = "marketplace") {
  return resolveMarketplaceInspectSurface(value, "marketplace");
}

function surfaceMeta(surface = "marketplace") {
  return MARKETPLACE_SURFACE_META[inspectSurfaceKind(surface)];
}

function normalizeInspectFilters(surface, filters = {}) {
  const canonicalSurface = inspectSurfaceKind(surface);
  const normalizedFilters =
    filters && typeof filters === "object" && !Array.isArray(filters)
      ? filters
      : {};
  const result = {};

  if (marketTaskBrowserUsesStatuses(canonicalSurface)) {
    const statuses = normalizeStringList(normalizedFilters.statuses);
    if (statuses.length > 0) {
      result.statuses = statuses;
    }
  }

  if (canonicalSurface === "skills") {
    const query = String(normalizedFilters.query ?? "").trim();
    const tags = normalizeStringList(normalizedFilters.tags);
    if (query) {
      result.query = query;
    }
    if (tags.length > 0) {
      result.tags = tags;
    }
    if (Number.isFinite(Number(normalizedFilters.limit))) {
      result.limit = Number(normalizedFilters.limit);
    }
    result.activeOnly = normalizedFilters.activeOnly !== false;
  }

  return result;
}

function normalizeInspectSubject(subject) {
  const normalized = String(subject ?? "").trim();
  return normalized || null;
}

function normalizeInspectMessage(message) {
  const normalized = String(message ?? "").trim();
  return normalized || null;
}

function summarizeInspectSurface(surface) {
  const canonicalSurface = inspectSurfaceKind(surface?.surface);
  const count = Number.isFinite(Number(surface?.count))
    ? Number(surface.count)
    : Array.isArray(surface?.items)
      ? surface.items.length
      : 0;
  return {
    surface: canonicalSurface,
    title: String(surface?.title ?? marketInspectSurfaceTitle(canonicalSurface)).trim() ||
      marketInspectSurfaceTitle(canonicalSurface),
    noun: marketInspectSurfaceNoun(canonicalSurface),
    status: String(surface?.status ?? "ok").trim() || "ok",
    count,
    countLabel: marketInspectSurfaceCountLabel(canonicalSurface, count),
    message: normalizeInspectMessage(surface?.message),
    filters: normalizeInspectFilters(canonicalSurface, surface?.filters),
  };
}

export function resolveMarketplaceInspectSurface(value, fallback = null) {
  const normalized = String(readSurfaceToken(value) ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return MARKETPLACE_SURFACE_ALIASES.get(normalized) ?? fallback;
}

export function marketInspectSurfaceTitle(surface = "marketplace") {
  return surfaceMeta(surface).title;
}

export function marketInspectSurfaceNoun(surface = "marketplace") {
  return surfaceMeta(surface).noun;
}

export function marketInspectSurfaceCountLabel(surface = "marketplace", count = 0) {
  const normalizedCount = Number.isFinite(Number(count))
    ? Math.max(0, Number(count))
    : 0;
  const noun = surfaceMeta(surface).countNoun;
  return `${normalizedCount} ${noun}${normalizedCount === 1 ? "" : "s"}`;
}

export function marketBrowserKind(value) {
  const surface = resolveMarketplaceInspectSurface(readSurfaceToken(value), null);
  return surface && MARKETPLACE_BROWSER_KINDS.has(surface) ? surface : "tasks";
}

export function marketTaskBrowserDefaultTitle(kind = "tasks") {
  return marketInspectSurfaceTitle(marketBrowserKind(kind));
}

export function marketTaskBrowserNoun(kind = "tasks") {
  return marketInspectSurfaceNoun(marketBrowserKind(kind));
}

export function marketTaskBrowserCountLabel(kind = "tasks", count = 0) {
  return marketInspectSurfaceCountLabel(marketBrowserKind(kind), count);
}

export function marketTaskBrowserLoadingLabel(kind = "tasks") {
  return surfaceMeta(marketBrowserKind(kind)).loadingLabel;
}

export function marketTaskBrowserEmptyLabel(kind = "tasks") {
  return surfaceMeta(marketBrowserKind(kind)).emptyLabel;
}

export function marketTaskBrowserItemLabel(item, kind = "tasks") {
  switch (marketBrowserKind(kind)) {
    case "skills":
      return item?.name ?? item?.skillId ?? item?.key ?? "selected skill";
    case "governance":
      return item?.payloadPreview ?? item?.proposalType ?? item?.proposalPda ?? item?.key ?? "selected proposal";
    case "disputes":
      return item?.disputePda ?? item?.resolutionType ?? item?.taskPda ?? item?.key ?? "selected dispute";
    case "reputation":
      return item?.authority ?? item?.agentPda ?? item?.agentId ?? item?.key ?? "selected reputation summary";
    default:
      return item?.description ?? item?.taskId ?? item?.key ?? "selected task";
  }
}

export function marketTaskBrowserUsesStatuses(kind = "tasks") {
  const browserKind = marketBrowserKind(kind);
  return browserKind === "tasks" || browserKind === "governance" || browserKind === "disputes";
}

export function marketTaskBrowserItemKey(item, fallbackIndex = 0, kind = "tasks") {
  switch (marketBrowserKind(kind)) {
    case "skills": {
      const skillPda = String(item?.skillPda ?? "").trim();
      if (skillPda) {
        return skillPda;
      }
      const skillId = String(item?.skillId ?? "").trim();
      if (skillId) {
        return skillId;
      }
      return `skill-${fallbackIndex + 1}`;
    }
    case "governance": {
      const proposalPda = String(item?.proposalPda ?? "").trim();
      if (proposalPda) {
        return proposalPda;
      }
      return `proposal-${fallbackIndex + 1}`;
    }
    case "disputes": {
      const disputePda = String(item?.disputePda ?? "").trim();
      if (disputePda) {
        return disputePda;
      }
      const disputeId = String(item?.disputeId ?? "").trim();
      if (disputeId) {
        return disputeId;
      }
      return `dispute-${fallbackIndex + 1}`;
    }
    case "reputation": {
      const agentPda = String(item?.agentPda ?? "").trim();
      if (agentPda) {
        return agentPda;
      }
      const authority = String(item?.authority ?? "").trim();
      if (authority) {
        return authority;
      }
      const agentId = String(item?.agentId ?? "").trim();
      if (agentId) {
        return agentId;
      }
      return `reputation-${fallbackIndex + 1}`;
    }
    default: {
      const taskPda = String(item?.taskPda ?? "").trim();
      if (taskPda) {
        return taskPda;
      }
      const taskId = String(item?.taskId ?? "").trim();
      if (taskId) {
        return taskId;
      }
      return `task-${fallbackIndex + 1}`;
    }
  }
}

export function formatMarketTaskBrowserTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const millis = numeric >= 1e12
    ? numeric
    : numeric >= 1e9
      ? numeric * 1000
      : null;
  if (!millis) {
    return String(value);
  }
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

function normalizeMarketSkillBrowserItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => {
      const priceSol = String(item?.priceSol ?? item?.price ?? "").trim();
      const priceLamports = String(item?.priceLamports ?? "").trim();
      return {
        key: marketTaskBrowserItemKey(item, index, "skills"),
        skillPda: String(item?.skillPda ?? "").trim(),
        skillId: String(item?.skillId ?? "").trim(),
        name: String(item?.name ?? "").trim() || "unknown skill",
        author: String(item?.author ?? item?.seller ?? "").trim(),
        tags: Array.isArray(item?.tags)
          ? item.tags.map((tag) => String(tag ?? "").trim()).filter(Boolean)
          : [],
        priceSol,
        priceLamports,
        priceMint: item?.priceMint ?? null,
        priceDisplay: priceSol
          ? `${priceSol} SOL`
          : priceLamports
            ? `${priceLamports} lamports`
            : "n/a",
        rating: Number.isFinite(Number(item?.rating ?? item?.averageRating))
          ? Number(item?.rating ?? item?.averageRating)
          : null,
        ratingCount: Number.isFinite(Number(item?.ratingCount))
          ? Number(item.ratingCount)
          : null,
        downloads: Number.isFinite(Number(item?.downloads))
          ? Number(item.downloads)
          : null,
        version: Number.isFinite(Number(item?.version))
          ? Number(item.version)
          : null,
        isActive: item?.isActive !== false,
        createdAt: item?.createdAt ?? null,
        createdAtLabel: formatMarketTaskBrowserTimestamp(item?.createdAt),
        updatedAt: item?.updatedAt ?? null,
        updatedAtLabel: formatMarketTaskBrowserTimestamp(item?.updatedAt),
        contentHash: String(item?.contentHash ?? "").trim(),
      };
    })
    .filter((item) => item.skillPda || item.skillId || item.name);
}

function normalizeMarketGovernanceBrowserItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => ({
      key: marketTaskBrowserItemKey(item, index, "governance"),
      proposalPda: String(item?.proposalPda ?? "").trim(),
      proposer: String(item?.proposer ?? "").trim(),
      proposalType: String(item?.proposalType ?? "").trim(),
      status: String(item?.status ?? "unknown").trim() || "unknown",
      titleHash: String(item?.titleHash ?? "").trim(),
      descriptionHash: String(item?.descriptionHash ?? "").trim(),
      payloadPreview: String(item?.payloadPreview ?? "").trim(),
      votesFor: String(item?.votesFor ?? "").trim(),
      votesAgainst: String(item?.votesAgainst ?? "").trim(),
      totalVoters: Number.isFinite(Number(item?.totalVoters))
        ? Number(item.totalVoters)
        : null,
      quorum: String(item?.quorum ?? "").trim(),
      createdAt: item?.createdAt ?? null,
      createdAtLabel: formatMarketTaskBrowserTimestamp(item?.createdAt),
      votingDeadline: item?.votingDeadline ?? null,
      votingDeadlineLabel: formatMarketTaskBrowserTimestamp(item?.votingDeadline),
      executionAfter: item?.executionAfter ?? null,
      executionAfterLabel: formatMarketTaskBrowserTimestamp(item?.executionAfter),
    }))
    .filter((item) => item.proposalPda || item.payloadPreview || item.proposalType);
}

function normalizeMarketDisputeBrowserItems(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => ({
      key: marketTaskBrowserItemKey(item, index, "disputes"),
      disputePda: String(item?.disputePda ?? "").trim(),
      disputeId: String(item?.disputeId ?? "").trim(),
      taskPda: String(item?.taskPda ?? "").trim(),
      initiator: String(item?.initiator ?? "").trim(),
      defendant: String(item?.defendant ?? "").trim(),
      claimant: String(item?.claimant ?? item?.initiator ?? "").trim(),
      respondent: String(item?.respondent ?? item?.defendant ?? "").trim(),
      status: String(item?.status ?? "unknown").trim() || "unknown",
      resolutionType: String(item?.resolutionType ?? "").trim(),
      evidenceHash: String(item?.evidenceHash ?? "").trim(),
      amountAtStake: String(item?.amountAtStake ?? "").trim(),
      amountAtStakeSol: String(item?.amountAtStakeSol ?? "").trim(),
      amountAtStakeMint: item?.amountAtStakeMint ?? item?.rewardMint ?? null,
      votesFor: String(item?.votesFor ?? "").trim(),
      votesAgainst: String(item?.votesAgainst ?? "").trim(),
      totalVoters: Number.isFinite(Number(item?.totalVoters))
        ? Number(item.totalVoters)
        : null,
      createdAt: item?.createdAt ?? null,
      createdAtLabel: formatMarketTaskBrowserTimestamp(item?.createdAt),
      votingDeadline: item?.votingDeadline ?? null,
      votingDeadlineLabel: formatMarketTaskBrowserTimestamp(item?.votingDeadline),
      expiresAt: item?.expiresAt ?? null,
      expiresAtLabel: formatMarketTaskBrowserTimestamp(item?.expiresAt),
      resolvedAt: item?.resolvedAt ?? null,
      resolvedAtLabel: formatMarketTaskBrowserTimestamp(item?.resolvedAt),
      slashApplied: item?.slashApplied === true,
      initiatorSlashApplied: item?.initiatorSlashApplied === true,
      workerStakeAtDispute: String(item?.workerStakeAtDispute ?? "").trim(),
      initiatedByCreator: item?.initiatedByCreator === true,
      rewardMint: item?.rewardMint ?? null,
    }))
    .filter((item) => item.disputePda || item.disputeId || item.taskPda);
}

function normalizeMarketReputationBrowserItems(items = []) {
  const list = Array.isArray(items)
    ? items
    : items && typeof items === "object"
      ? [items]
      : [];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      key: marketTaskBrowserItemKey(item, index, "reputation"),
      registered: item?.registered !== false,
      authority: String(item?.authority ?? "").trim(),
      agentPda: String(item?.agentPda ?? "").trim(),
      agentId: String(item?.agentId ?? "").trim(),
      baseReputation: Number.isFinite(Number(item?.baseReputation))
        ? Number(item.baseReputation)
        : null,
      effectiveReputation: Number.isFinite(Number(item?.effectiveReputation))
        ? Number(item.effectiveReputation)
        : null,
      tasksCompleted: String(item?.tasksCompleted ?? "").trim(),
      totalEarned: String(item?.totalEarned ?? "").trim(),
      totalEarnedSol: String(item?.totalEarnedSol ?? "").trim(),
      stakedAmount: String(item?.stakedAmount ?? "").trim(),
      stakedAmountSol: String(item?.stakedAmountSol ?? "").trim(),
      lockedUntil: item?.lockedUntil ?? null,
      lockedUntilLabel: formatMarketTaskBrowserTimestamp(item?.lockedUntil),
      inboundDelegations: Array.isArray(item?.inboundDelegations)
        ? item.inboundDelegations
        : [],
      outboundDelegations: Array.isArray(item?.outboundDelegations)
        ? item.outboundDelegations
        : [],
    }))
    .filter(
      (item) =>
        item.agentPda ||
        item.authority ||
        item.agentId ||
        item.baseReputation !== null ||
        item.effectiveReputation !== null ||
        item.tasksCompleted ||
        item.totalEarned ||
        item.stakedAmount ||
        item.registered === false,
    );
}

export function normalizeMarketTaskBrowserItems(items = [], kind = "tasks") {
  switch (marketBrowserKind(kind)) {
    case "skills":
      return normalizeMarketSkillBrowserItems(items);
    case "governance":
      return normalizeMarketGovernanceBrowserItems(items);
    case "disputes":
      return normalizeMarketDisputeBrowserItems(items);
    case "reputation":
      return normalizeMarketReputationBrowserItems(items);
    default:
      if (!Array.isArray(items)) {
        return [];
      }
      return items
        .map((item, index) => {
          const rewardSol = String(item?.rewardSol ?? item?.reward ?? "").trim();
          const rewardLamports = String(item?.rewardLamports ?? "").trim();
          return {
            key: marketTaskBrowserItemKey(item, index, "tasks"),
            taskPda: String(item?.taskPda ?? "").trim(),
            taskId: String(item?.taskId ?? "").trim(),
            status: String(item?.status ?? "unknown").trim() || "unknown",
            description: String(item?.description ?? "").trim() || "untitled task",
            creator: String(item?.creator ?? "").trim(),
            rewardSol,
            rewardLamports,
            rewardMint: item?.rewardMint ?? null,
            rewardDisplay: rewardSol
              ? `${rewardSol} SOL`
              : rewardLamports
                ? `${rewardLamports} lamports`
                : "n/a",
            currentWorkers: Number.isFinite(Number(item?.currentWorkers))
              ? Number(item.currentWorkers)
              : null,
            maxWorkers: Number.isFinite(Number(item?.maxWorkers))
              ? Number(item.maxWorkers)
              : null,
            deadline: item?.deadline ?? null,
            deadlineLabel: formatMarketTaskBrowserTimestamp(item?.deadline),
            createdAt: item?.createdAt ?? null,
            createdAtLabel: formatMarketTaskBrowserTimestamp(item?.createdAt),
          };
        })
        .filter((item) => item.taskPda || item.taskId || item.description);
  }
}

export function buildMarketplaceInspectSurface({
  surface = "marketplace",
  title,
  status = "ok",
  subject = null,
  message = null,
  items = [],
  filters = {},
  count,
} = {}) {
  const canonicalSurface = inspectSurfaceKind(surface);
  const normalizedItems = canonicalSurface === "marketplace"
    ? Array.isArray(items) ? items : []
    : normalizeMarketTaskBrowserItems(items, canonicalSurface);
  const normalizedCount = Number.isFinite(Number(count))
    ? Math.max(0, Number(count))
    : normalizedItems.length;
  return {
    surface: canonicalSurface,
    title: String(title ?? marketInspectSurfaceTitle(canonicalSurface)).trim() ||
      marketInspectSurfaceTitle(canonicalSurface),
    noun: marketInspectSurfaceNoun(canonicalSurface),
    status: String(status ?? "ok").trim() || "ok",
    count: normalizedCount,
    countLabel: marketInspectSurfaceCountLabel(canonicalSurface, normalizedCount),
    subject: normalizeInspectSubject(subject),
    message: normalizeInspectMessage(message),
    filters: normalizeInspectFilters(canonicalSurface, filters),
    items: normalizedItems,
  };
}

export function buildMarketplaceReputationInspectPlaceholder(subject = null) {
  return buildMarketplaceInspectSurface({
    surface: "reputation",
    status: "requires_input",
    subject,
    message: REPUTATION_INSPECT_PLACEHOLDER_MESSAGE,
    items: [],
  });
}

export function buildMarketplaceInspectOverview({
  surfaces = [],
  subject = null,
  title,
} = {}) {
  const normalizedSurfaces = Array.isArray(surfaces)
    ? surfaces
      .filter((surface) => surface && typeof surface === "object")
      .map((surface) => buildMarketplaceInspectSurface(surface))
    : [];
  const items = normalizedSurfaces.map((surface) => summarizeInspectSurface(surface));
  const overview = {};

  for (const item of items) {
    overview[item.surface] = {
      title: item.title,
      noun: item.noun,
      status: item.status,
      count: item.count,
      countLabel: item.countLabel,
      message: item.message,
      filters: item.filters,
    };
  }

  const status = items.some((item) => item.status === "requires_input")
    ? "requires_input"
    : items.some((item) => item.status === "error")
      ? "error"
      : "ok";

  return {
    surface: "marketplace",
    title: String(title ?? marketInspectSurfaceTitle("marketplace")).trim() ||
      marketInspectSurfaceTitle("marketplace"),
    noun: marketInspectSurfaceNoun("marketplace"),
    status,
    count: normalizedSurfaces.length,
    countLabel: marketInspectSurfaceCountLabel("marketplace", normalizedSurfaces.length),
    subject: normalizeInspectSubject(subject),
    message: null,
    filters: {},
    items,
    overview,
    surfaces: normalizedSurfaces,
  };
}

export { REPUTATION_INSPECT_PLACEHOLDER_MESSAGE };
