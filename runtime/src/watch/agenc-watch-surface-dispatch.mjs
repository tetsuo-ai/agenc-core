export function dispatchOperatorSurfaceEvent(surfaceEvent, rawMessage, api) {
  const state = api.state;
  switch (surfaceEvent.family) {
    case "subscription":
      return handleSubscriptionSurfaceEvent(surfaceEvent, api);
    case "session":
      return handleSessionSurfaceEvent(surfaceEvent, state, api);
    case "chat":
      return handleChatSurfaceEvent(surfaceEvent, state, api);
    case "planner":
      return api.handlePlannerTraceEvent(surfaceEvent.type, surfaceEvent.payloadRecord);
    case "subagent":
      return api.handleSubagentLifecycleMessage(surfaceEvent.type, surfaceEvent.payloadRecord);
    case "tool":
      return handleToolSurfaceEvent(surfaceEvent, state, api);
    case "social":
      return handleSocialSurfaceEvent(surfaceEvent, api);
    case "market":
      return handleMarketSurfaceEvent(surfaceEvent, api);
    case "run":
      return handleRunSurfaceEvent(surfaceEvent, state, api);
    case "observability":
      return handleObservabilitySurfaceEvent(surfaceEvent, api);
    case "status":
      return handleStatusSurfaceEvent(surfaceEvent, state, api);
    case "agent":
      return handleAgentSurfaceEvent(surfaceEvent, state, api);
    case "approval":
      return handleApprovalSurfaceEvent(surfaceEvent, api);
    case "error":
      return handleErrorSurfaceEvent(surfaceEvent, rawMessage, state, api);
    default:
      return handleUnknownSurfaceEvent(surfaceEvent, rawMessage, api);
  }
}

function normalizeCompletionState(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "completed" ||
      normalized === "partial" ||
      normalized === "blocked" ||
      normalized === "needs_verification"
    ? normalized
    : "";
}

function normalizeRemainingRequirements(value) {
  return Array.isArray(value)
    ? value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
    : [];
}

function preferredRunSurfaceState(payload, priorState) {
  const completionState = normalizeCompletionState(payload?.completionState);
  return {
    completionState,
    remainingRequirements: normalizeRemainingRequirements(payload?.remainingRequirements),
    runState:
      completionState ||
      (typeof payload?.state === "string" && payload.state.trim()
        ? payload.state.trim()
        : priorState ?? null),
  };
}

function modelRoutesMatch(left, right) {
  const leftProvider = String(left?.provider ?? "").trim();
  const leftModel = String(left?.model ?? "").trim();
  const rightProvider = String(right?.provider ?? "").trim();
  const rightModel = String(right?.model ?? "").trim();
  return Boolean(
    leftProvider &&
    leftModel &&
    rightProvider &&
    rightModel &&
    leftProvider === rightProvider &&
    leftModel === rightModel
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function requestSharedCommandCatalog(api, sessionId = null) {
  api.send(
    "session.command.catalog.get",
    api.authPayload({
      client: "console",
      ...(typeof sessionId === "string" && sessionId.trim().length > 0
        ? { sessionId: sessionId.trim() }
        : {}),
    }),
  );
}

function handleSessionListResult(data, state, api) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  if (state.manualSessionsRequestPending) {
    state.manualSessionsRequestPending = false;
    const query = String(state.manualSessionsQuery ?? "").trim().toLowerCase();
    state.manualSessionsQuery = null;
    const filteredSessions =
      query.length > 0
        ? sessions.filter((session) => {
            const candidates = [
              session?.sessionId,
              session?.label,
              session?.workspaceRoot,
              session?.workspacePath,
              session?.cwd,
              session?.model,
              ...(typeof api.sessionQueryCandidates === "function"
                ? api.sessionQueryCandidates(session)
                : []),
            ]
              .map((value) => String(value ?? "").trim().toLowerCase())
              .filter(Boolean);
            return candidates.some((value) => value.includes(query));
          })
        : sessions;
    api.eventStore.pushEvent(
      "session",
      query.length > 0 ? "Filtered Sessions" : "Sessions",
      api.formatSessionSummaries(filteredSessions),
      "teal",
    );
    api.setTransientStatus(
      query.length > 0
        ? `session filter loaded: ${filteredSessions.length} match(es)`
        : "session list loaded",
    );
    return true;
  }
  const target = api.latestSessionSummary(sessions, state.sessionId);
  if (target?.sessionId) {
    state.sessionId = target.sessionId;
    api.persistSessionId(state.sessionId);
    api.setTransientStatus(`resuming session ${state.sessionId}`);
    api.send(
      "session.command.execute",
      api.authPayload({
        sessionId: target.sessionId,
        client: "console",
        content: `/session resume ${target.sessionId}`,
      }),
    );
  } else {
    api.setTransientStatus("no existing session; creating a new one");
    api.send("chat.new", api.authPayload());
  }
  return true;
}

function handleSessionResumeResult(payload, data, state, api) {
  const resumed = isRecord(data?.resumed) ? data.resumed : {};
  const nextSessionId =
    typeof resumed.sessionId === "string" && resumed.sessionId.trim().length > 0
      ? resumed.sessionId.trim()
      : typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : state.sessionId;
  state.sessionId = nextSessionId;
  api.persistSessionId(state.sessionId);
  state.sessionAttachedAtMs = api.now();
  state.runState = "idle";
  state.runPhase = null;
  state.pendingResumeHistoryRestore = true;
  api.resetLiveRunSurface();
  requestSharedCommandCatalog(api, state.sessionId);
  api.send("chat.history", api.authPayload({ limit: 50 }));
  api.requestRunInspect("resume", { force: true });
  api.requestCockpit("resume");
  api.markBootstrapReady(`session resumed: ${state.sessionId}; restoring history`);
  return true;
}

function handleSubscriptionSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "events.subscribed":
      api.setTransientStatus(
        `event stream ready: ${Array.isArray(payload.filters) && payload.filters.length > 0
          ? payload.filters.join(", ")
          : "all events"}`,
      );
      return true;
    case "events.unsubscribed":
      api.setTransientStatus("event stream detached");
      return true;
    default:
      return false;
  }
}

function handleSessionSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "chat.session":
      state.sessionId = payload.sessionId ?? state.sessionId;
      api.persistSessionId(state.sessionId);
      state.sessionAttachedAtMs = api.now();
      state.pendingResumeHistoryRestore = false;
      state.cockpit = null;
      state.cockpitUpdatedAt = 0;
      state.cockpitFingerprint = null;
      api.resetLiveRunSurface();
      state.runDetail = null;
      state.runState = "idle";
      state.runPhase = null;
      requestSharedCommandCatalog(api, state.sessionId);
      api.markBootstrapReady(`session ready: ${state.sessionId}`);
      api.requestCockpit("session ready");
      return true;
    case "chat.owner":
      if (typeof payload.ownerToken === "string" && payload.ownerToken.trim()) {
        state.ownerToken = payload.ownerToken.trim();
        api.persistOwnerToken(state.ownerToken);
      }
      return true;
    case "chat.resumed":
    case "chat.session.resumed":
      return handleSessionResumeResult(payload, { resumed: { sessionId: payload.sessionId } }, state, api);
    case "chat.sessions":
    case "chat.session.list": {
      return handleSessionListResult({ sessions: surfaceEvent.payloadList ?? [] }, state, api);
    }
    case "session.command.catalog":
      state.sharedCommandCatalog = Array.isArray(surfaceEvent.payloadList)
        ? surfaceEvent.payloadList
        : [];
      api.setTransientStatus("command catalog updated");
      return true;
    case "chat.history": {
      const history = surfaceEvent.payloadList ?? [];
      if (state.pendingResumeHistoryRestore && state.sessionId) {
        state.pendingResumeHistoryRestore = false;
        api.eventStore.restoreTranscriptFromHistory(history);
        api.setTransientStatus(`history restored: ${history.length} item(s)`);
      } else if (!state.bootstrapReady && state.sessionId) {
        api.eventStore.restoreTranscriptFromHistory(history);
        api.markBootstrapReady(`history restored: ${history.length} item(s)`);
        api.requestRunInspect("history restore", { force: true });
        api.requestCockpit("history restore");
      } else {
        api.setTransientStatus(`history restored: ${history.length} item(s)`);
      }
      return true;
    }
    default:
      return false;
  }
}

function handleChatSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "chat.message":
      state.latestAgentSummary = api.sanitizeInlineText(payload.content ?? "") || null;
      api.setTransientStatus("agent reply received");
      api.eventStore.commitAgentMessage(payload.content ?? "");
      api.requestCockpit("agent reply");
      if (state.currentObjective && api.shouldAutoInspectRun(state.runDetail, state.runState)) {
        api.requestRunInspect("agent reply");
      }
      return true;
    case "session.command.result": {
      const data = isRecord(payload.data) ? payload.data : {};
      if (data.kind === "session" && typeof data.subcommand === "string") {
        if (data.subcommand === "list") {
          return handleSessionListResult(data, state, api);
        }
        if (data.subcommand === "resume") {
          return handleSessionResumeResult(payload, data, state, api);
        }
      }
      const content =
        typeof payload.content === "string" && payload.content.trim().length > 0
          ? payload.content
          : "(empty)";
      const commandName =
        typeof payload.commandName === "string" && payload.commandName.trim().length > 0
          ? payload.commandName.trim()
          : "command";
      if (typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0) {
        state.sessionId = payload.sessionId.trim();
        api.persistSessionId(state.sessionId);
      }
      api.setTransientStatus(`/${commandName} ready`);
      api.eventStore.pushEvent("operator", `/${commandName}`, content, "teal");
      api.requestCockpit(`/${commandName}`);
      return true;
    }
    case "chat.stream":
      {
        const chunk =
          typeof payload.content === "string"
            ? payload.content
            : typeof payload.delta === "string"
              ? payload.delta
              : "";
        if (chunk || payload.done) {
          api.eventStore.appendAgentStreamChunk(chunk, { done: payload.done === true });
        }
        const statusPreview = api.sanitizeInlineText(chunk);
        if (statusPreview) {
          api.setTransientStatus(`streaming: ${api.truncate(statusPreview, 72)}`);
        } else if (payload.done === true) {
          api.setTransientStatus("agent stream complete");
        } else {
          api.setTransientStatus("agent streaming…");
        }
      }
      return true;
    case "chat.typing":
      api.setTransientStatus("agent is typing…");
      return true;
    case "chat.response":
      if (typeof payload.completionState === "string" && payload.completionState.trim()) {
        state.runState = payload.completionState.trim();
        state.runPhase = null;
        state.activeRunStartedAtMs = null;
        api.setTransientStatus(`run ${state.runState.replace(/_/g, " ")}`);
      }
      return true;
    case "chat.cancelled":
      if (payload.cancelled === false) {
        api.setTransientStatus("chat cancel failed");
        api.eventStore.pushEvent(
          "error",
          "Chat Cancel Failed",
          api.tryPrettyJson(payload),
          "red",
        );
        return true;
      }
      api.eventStore.cancelAgentStream("cancelled");
      api.setTransientStatus("chat cancelled");
      api.eventStore.pushEvent("cancelled", "Chat Cancelled", api.tryPrettyJson(payload), "amber");
      return true;
    case "chat.usage":
      state.lastUsageSummary = api.summarizeUsage(payload);
      state.liveSessionModelRoute =
        api.normalizeModelRoute({ ...(payload ?? {}), source: "live" }) ?? state.liveSessionModelRoute;
      return true;
    default:
      return false;
  }
}

function handleToolSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "tools.executing": {
      const toolName = payload.toolName ?? "unknown";
      const descriptor = api.describeToolStart(toolName, payload.args);
      const suppressTranscript = api.shouldSuppressToolTranscript(toolName, payload.args);
      const suppressActivity = api.shouldSuppressToolActivity(toolName, payload.args);
      if (!suppressActivity) {
        state.latestTool = toolName;
        state.latestToolState = "running";
        api.setTransientStatus(descriptor.title);
      }
      if (!suppressTranscript) {
        api.eventStore.pushEvent(
          "tool",
          descriptor.title,
          descriptor.body,
          descriptor.tone,
          api.descriptorEventMetadata
            ? api.descriptorEventMetadata(descriptor, {
              toolName,
              toolArgs: payload.args,
            })
            : {
            toolName,
            toolArgs: payload.args,
            previewMode: descriptor.previewMode,
          },
        );
      }
      api.requestRunInspect("tool start");
      return true;
    }
    case "tools.result":
      api.handleToolResult(
        payload.toolName ?? "unknown",
        Boolean(payload.isError),
        payload.result ?? "",
        payload.args,
      );
      api.requestRunInspect("tool result");
      return true;
    default:
      return false;
  }
}

function handleSocialSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "social.message") {
    return false;
  }
  api.setTransientStatus(
    `social message from ${api.truncate(payload.sender ?? "unknown", 32)}`,
  );
  api.eventStore.pushEvent(
    "social",
    "Social Message",
    [
      `from: ${payload.sender ?? "unknown"}`,
      `to: ${payload.recipient ?? "unknown"}`,
      `mode: ${payload.mode ?? "unknown"}`,
      `messageId: ${payload.messageId ?? "unknown"}`,
      `threadId: ${payload.threadId ?? "none"}`,
      "",
      payload.content ?? "",
    ].join("\n"),
    "blue",
  );
  return true;
}

function coerceMarketText(value, fallback = "unknown") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function joinMarketLines(lines) {
  return lines.filter(Boolean).join("\n");
}

function renderMarketList(items, buildLine, { limit = Infinity } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return "No records returned.";
  }
  const safeLimit =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.max(1, Math.floor(Number(limit)))
      : Infinity;
  const visible =
    safeLimit === Infinity ? items : items.slice(0, safeLimit);
  const lines = visible
    .map((item, index) => buildLine(item ?? {}, index))
    .filter(Boolean);
  if (items.length > visible.length) {
    lines.push(`... ${items.length - visible.length} more`);
  }
  return lines.join("\n");
}

function summarizeMarketList(items, buildLine) {
  return renderMarketList(items, buildLine, { limit: 5 });
}

function marketEventTitle(type) {
  switch (type) {
    case "tasks.list":
      return "Marketplace Tasks";
    case "tasks.detail":
      return "Task Detail";
    case "task.created":
      return "Task Created";
    case "task.claimed":
      return "Task Claimed";
    case "task.completed":
      return "Task Completed";
    case "task.cancelled":
      return "Task Cancelled";
    case "task.disputed":
      return "Task Disputed";
    case "market.skills.list":
      return "Marketplace Skills";
    case "market.skills.detail":
      return "Skill Detail";
    case "market.skills.purchased":
      return "Skill Purchased";
    case "market.skills.rated":
      return "Skill Rated";
    case "market.governance.list":
      return "Governance Proposals";
    case "market.governance.detail":
      return "Governance Proposal";
    case "market.governance.voted":
      return "Governance Vote";
    case "market.disputes.list":
      return "Marketplace Disputes";
    case "market.disputes.detail":
      return "Dispute Detail";
    case "market.disputes.resolved":
      return "Dispute Resolved";
    case "market.reputation.summary":
      return "Reputation Summary";
    case "market.reputation.staked":
      return "Reputation Staked";
    case "market.reputation.delegated":
      return "Reputation Delegated";
    default:
      return "Marketplace Event";
  }
}

function marketEventTone(type) {
  if (type.startsWith("market.disputes") || type === "task.disputed") {
    return "amber";
  }
  if (type === "task.completed" || type === "market.disputes.resolved") {
    return "green";
  }
  return "teal";
}

function formatMarketplaceSkillListLine(item, index) {
  const name = coerceMarketText(item?.name ?? item?.skillId ?? item?.skillPda, "unknown skill");
  const state = item?.isActive === false ? "inactive" : "active";
  const price = String(item?.priceDisplay ?? "").trim() || (
    item?.priceSol !== undefined ? `${coerceMarketText(item.priceSol)} SOL`
      : item?.priceLamports !== undefined ? `${coerceMarketText(item.priceLamports)} lamports`
        : item?.price !== undefined ? coerceMarketText(item.price)
          : ""
  );
  const ratingValue = Number(item?.rating ?? item?.averageRating);
  const downloadsValue = Number(item?.downloads);
  const author = String(item?.author ?? item?.seller ?? "").trim();
  const details = [];
  details.push(`[${state}]`);
  if (price) {
    details.push(price);
  }
  if (author) {
    details.push(`by ${author}`);
  }
  if (Number.isFinite(ratingValue)) {
    details.push(`rating ${ratingValue.toFixed(1)}`);
  }
  if (Number.isFinite(downloadsValue)) {
    details.push(`downloads ${downloadsValue}`);
  }
  return `${index + 1}. ${name}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function formatMarketplaceGovernanceListLine(item, index) {
  const preview = String(item?.payloadPreview ?? "").trim();
  const proposalType = String(item?.proposalType ?? "").trim();
  const subject = coerceMarketText(
    preview && proposalType
      ? `${proposalType}: ${preview}`
      : preview || proposalType || item?.proposalPda,
    "proposal",
  );
  const details = [];
  const proposer = String(item?.proposer ?? "").trim();
  const votesFor = String(item?.votesFor ?? "").trim();
  const votesAgainst = String(item?.votesAgainst ?? "").trim();
  const totalVoters = Number(item?.totalVoters);
  if (proposer) {
    details.push(`by ${proposer}`);
  }
  if (votesFor) {
    details.push(`for ${votesFor}`);
  }
  if (votesAgainst) {
    details.push(`against ${votesAgainst}`);
  }
  if (Number.isFinite(totalVoters)) {
    details.push(`${totalVoters} voter${totalVoters === 1 ? "" : "s"}`);
  }
  return `${index + 1}. [${coerceMarketText(item?.status)}] ${subject}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function formatMarketplaceDisputeListLine(item, index) {
  const subject = coerceMarketText(
    item?.resolutionType ?? item?.disputePda ?? item?.taskPda,
    "dispute",
  );
  const details = [];
  const disputeLabel = String(item?.disputePda ?? item?.taskPda ?? "").trim();
  const votesFor = String(item?.votesFor ?? "").trim();
  const votesAgainst = String(item?.votesAgainst ?? "").trim();
  const totalVoters = Number(item?.totalVoters);
  if (disputeLabel) {
    details.push(disputeLabel);
  }
  if (votesFor) {
    details.push(`for ${votesFor}`);
  }
  if (votesAgainst) {
    details.push(`against ${votesAgainst}`);
  }
  if (Number.isFinite(totalVoters)) {
    details.push(`${totalVoters} voter${totalVoters === 1 ? "" : "s"}`);
  }
  return `${index + 1}. [${coerceMarketText(item?.status)}] ${subject}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function formatMarketplaceReputationListLine(item, index) {
  const label = coerceMarketText(
    item?.authority ?? item?.agentPda ?? item?.agentId,
    "reputation summary",
  );
  const details = [];
  if (item?.effectiveReputation !== undefined) {
    details.push(`effective ${coerceMarketText(item.effectiveReputation)}`);
  }
  if (item?.tasksCompleted !== undefined) {
    details.push(`tasks ${coerceMarketText(item.tasksCompleted)}`);
  }
  if (item?.totalEarnedSol !== undefined) {
    details.push(`earned ${coerceMarketText(item.totalEarnedSol)} SOL`);
  }
  return `${index + 1}. [${item?.registered === false ? "unregistered" : "registered"}] ${label}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function marketEventStatus(type) {
  switch (type) {
    case "tasks.list":
      return "market tasks loaded";
    case "tasks.detail":
      return "task detail loaded";
    case "market.skills.list":
      return "market skills loaded";
    case "market.governance.list":
      return "governance proposals loaded";
    case "market.disputes.list":
      return "market disputes loaded";
    case "market.reputation.summary":
      return "reputation summary loaded";
    default:
      return `${marketEventTitle(type).toLowerCase()} received`;
  }
}

function summarizeMarketSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  const list = surfaceEvent.payloadList;
  switch (surfaceEvent.type) {
    case "tasks.list":
      return summarizeMarketList(list ?? [], (item, index) =>
        `${index + 1}. [${coerceMarketText(item.status)}] ${coerceMarketText(item.description, "untitled task")} (${coerceMarketText(item.reward, "n/a")} SOL)`,
      );
    case "tasks.detail":
      return joinMarketLines([
        `task: ${coerceMarketText(payload.taskPda ?? payload.id)}`,
        `status: ${coerceMarketText(payload.status)}`,
        payload.reward !== undefined ? `reward: ${coerceMarketText(payload.reward)} SOL` : null,
        payload.rewardLamports !== undefined ? `reward lamports: ${coerceMarketText(payload.rewardLamports)}` : null,
        payload.creator ? `creator: ${coerceMarketText(payload.creator)}` : null,
        payload.currentWorkers !== undefined ? `workers: ${coerceMarketText(payload.currentWorkers)}` : null,
        payload.description ? "" : null,
        payload.description ? coerceMarketText(payload.description, "") : null,
      ]);
    case "task.created":
      return joinMarketLines([
        `task: ${coerceMarketText(payload.taskPda)}`,
        payload.description ? "" : null,
        payload.description ? coerceMarketText(payload.description, "") : null,
      ]);
    case "task.claimed":
      return joinMarketLines([
        `task: ${coerceMarketText(payload.taskPda)}`,
        payload.worker ? `worker: ${coerceMarketText(payload.worker)}` : null,
      ]);
    case "task.completed":
      return joinMarketLines([
        `task: ${coerceMarketText(payload.taskPda)}`,
        payload.resultData ? `result: ${coerceMarketText(payload.resultData)}` : null,
      ]);
    case "task.cancelled":
      return `task: ${coerceMarketText(payload.taskPda)}`;
    case "task.disputed":
      return joinMarketLines([
        `task: ${coerceMarketText(payload.taskPda)}`,
        payload.evidence ? `evidence: ${coerceMarketText(payload.evidence)}` : null,
        payload.resolutionType ? `requested resolution: ${coerceMarketText(payload.resolutionType)}` : null,
      ]);
    case "market.skills.list":
      return summarizeMarketList(list ?? [], (item, index) =>
        formatMarketplaceSkillListLine(item, index),
      );
    case "market.skills.detail":
      return joinMarketLines([
        `skill: ${coerceMarketText(payload.skillId ?? payload.skillPda)}`,
        payload.seller ? `seller: ${coerceMarketText(payload.seller)}` : null,
        payload.price !== undefined ? `price: ${coerceMarketText(payload.price)}` : null,
        payload.averageRating !== undefined ? `rating: ${coerceMarketText(payload.averageRating)}` : null,
        payload.description ? "" : null,
        payload.description ? coerceMarketText(payload.description, "") : null,
      ]);
    case "market.skills.purchased":
      return joinMarketLines([
        `skill: ${coerceMarketText(payload.skillId ?? payload.skillPda)}`,
        payload.receiptPda ? `receipt: ${coerceMarketText(payload.receiptPda)}` : null,
      ]);
    case "market.skills.rated":
      return joinMarketLines([
        `skill: ${coerceMarketText(payload.skillPda)}`,
        `rating: ${coerceMarketText(payload.rating)}`,
      ]);
    case "market.governance.list":
      return summarizeMarketList(list ?? [], (item, index) =>
        formatMarketplaceGovernanceListLine(item, index),
      );
    case "market.governance.detail":
      return joinMarketLines([
        `proposal: ${coerceMarketText(payload.proposalPda)}`,
        payload.title ? `title: ${coerceMarketText(payload.title)}` : null,
        payload.status ? `status: ${coerceMarketText(payload.status)}` : null,
        payload.description ? "" : null,
        payload.description ? coerceMarketText(payload.description, "") : null,
      ]);
    case "market.governance.voted":
      return joinMarketLines([
        `proposal: ${coerceMarketText(payload.proposalPda)}`,
        `vote: ${payload.approve === true ? "yes" : "no"}`,
      ]);
    case "market.disputes.list":
      return summarizeMarketList(list ?? [], (item, index) =>
        formatMarketplaceDisputeListLine(item, index),
      );
    case "market.disputes.detail":
      return joinMarketLines([
        `dispute: ${coerceMarketText(payload.disputePda)}`,
        payload.status ? `status: ${coerceMarketText(payload.status)}` : null,
        payload.taskPda ? `task: ${coerceMarketText(payload.taskPda)}` : null,
        payload.reason ? `reason: ${coerceMarketText(payload.reason)}` : null,
      ]);
    case "market.disputes.resolved":
      return joinMarketLines([
        `dispute: ${coerceMarketText(payload.disputePda)}`,
        payload.result ? api.tryPrettyJson(payload.result) : null,
      ]);
    case "market.reputation.summary":
      return formatMarketplaceReputationListLine(payload ?? {}, 0);
    case "market.reputation.staked":
      return `amount: ${coerceMarketText(payload.amount)}`;
    case "market.reputation.delegated":
      return joinMarketLines([
        `amount: ${coerceMarketText(payload.amount)}`,
        payload.delegateeAgentPda ? `delegatee: ${coerceMarketText(payload.delegateeAgentPda)}` : null,
        payload.expiresAt ? `expires at: ${coerceMarketText(payload.expiresAt)}` : null,
      ]);
    default:
      return api.tryPrettyJson(surfaceEvent.payload ?? payload);
  }
}

function buildMarketDetailSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  const list = surfaceEvent.payloadList;
  switch (surfaceEvent.type) {
    case "tasks.list":
      return renderMarketList(list ?? [], (item, index) =>
        `${index + 1}. [${coerceMarketText(item.status)}] ${coerceMarketText(item.description, "untitled task")} (${coerceMarketText(item.reward, "n/a")} SOL)`,
      );
    case "market.skills.list":
      return renderMarketList(list ?? [], (item, index) =>
        formatMarketplaceSkillListLine(item, index),
      );
    case "market.governance.list":
      return renderMarketList(list ?? [], (item, index) =>
        formatMarketplaceGovernanceListLine(item, index),
      );
    case "market.disputes.list":
      return renderMarketList(list ?? [], (item, index) =>
        formatMarketplaceDisputeListLine(item, index),
      );
    case "market.reputation.summary":
      return joinMarketLines([
        payload.authority ? `authority: ${coerceMarketText(payload.authority)}` : null,
        payload.agentPda ? `agent: ${coerceMarketText(payload.agentPda)}` : null,
        payload.agentId ? `agent id: ${coerceMarketText(payload.agentId)}` : null,
        [
          payload.baseReputation !== undefined ? `base ${coerceMarketText(payload.baseReputation)}` : null,
          payload.effectiveReputation !== undefined ? `effective ${coerceMarketText(payload.effectiveReputation)}` : null,
          payload.tasksCompleted !== undefined ? `${coerceMarketText(payload.tasksCompleted)} tasks` : null,
        ].filter(Boolean).length > 0
          ? `scorecard: ${[
            payload.baseReputation !== undefined ? `base ${coerceMarketText(payload.baseReputation)}` : null,
            payload.effectiveReputation !== undefined ? `effective ${coerceMarketText(payload.effectiveReputation)}` : null,
            payload.tasksCompleted !== undefined ? `${coerceMarketText(payload.tasksCompleted)} tasks` : null,
          ].filter(Boolean).join(" · ")}`
          : null,
        [
          payload.totalEarnedSol !== undefined ? `${coerceMarketText(payload.totalEarnedSol)} SOL earned` : null,
          payload.stakedAmountSol !== undefined ? `${coerceMarketText(payload.stakedAmountSol)} SOL staked` : null,
        ].filter(Boolean).length > 0
          ? `activity: ${[
            payload.totalEarnedSol !== undefined ? `${coerceMarketText(payload.totalEarnedSol)} SOL earned` : null,
            payload.stakedAmountSol !== undefined ? `${coerceMarketText(payload.stakedAmountSol)} SOL staked` : null,
          ].filter(Boolean).join(" · ")}`
          : null,
      ]);
    default:
      return summarizeMarketSurfaceEvent(surfaceEvent, api);
  }
}

function handleMarketSurfaceEvent(surfaceEvent, api) {
  const title = marketEventTitle(surfaceEvent.type);
  const summaryBody = summarizeMarketSurfaceEvent(surfaceEvent, api);
  const detailBody = buildMarketDetailSurfaceEvent(surfaceEvent, api);
  const browserKinds = {
    "tasks.list": "tasks",
    "market.skills.list": "skills",
    "market.governance.list": "governance",
    "market.disputes.list": "disputes",
    "market.reputation.summary": "reputation",
  };
  const browserKind = browserKinds[surfaceEvent.type];
  if (browserKind && typeof api.hydrateMarketTaskBrowser === "function") {
    api.hydrateMarketTaskBrowser({
      title,
      items:
        surfaceEvent.type === "market.reputation.summary"
          ? (surfaceEvent.payloadRecord && Object.keys(surfaceEvent.payloadRecord).length > 0
            ? [surfaceEvent.payloadRecord]
            : [])
          : surfaceEvent.payloadList ?? [],
      kind: browserKind,
    });
  }
  api.setTransientStatus(marketEventStatus(surfaceEvent.type));
  api.eventStore.pushEvent(
    "market",
    title,
    summaryBody,
    marketEventTone(surfaceEvent.type),
    detailBody && detailBody !== summaryBody ? { detailBody } : {},
  );
  return true;
}

function handleRunSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "runs.list":
      api.eventStore.pushEvent("runs", "Run List", api.tryPrettyJson(surfaceEvent.payloadList ?? []), "blue");
      return true;
    case "run.inspect":
      {
        const runTruth = preferredRunSurfaceState(payload, state.runState);
        state.runInspectPending = false;
        state.runDetail = payload;
        state.currentObjective = payload.objective ?? state.currentObjective;
        state.runState = runTruth.runState ?? state.runState;
        state.runPhase = payload.currentPhase ?? state.runPhase;
        state.activeRunStartedAtMs = Number.isFinite(Number(payload.createdAt))
          ? Number(payload.createdAt)
          : state.activeRunStartedAtMs ?? api.now();
        api.hydratePlannerDagFromTraceArtifacts(payload.sessionId ?? state.sessionId);
        api.setTransientStatus(
          `run inspect loaded: ${String(state.runState ?? "unknown").replace(/_/g, " ")}`,
        );
        api.requestCockpit("run inspect");
      }
      return true;
    case "run.updated":
      {
        const runTruth = preferredRunSurfaceState(payload, state.runState);
        state.runDetail = state.runDetail && typeof state.runDetail === "object"
          ? { ...state.runDetail, ...payload }
          : payload;
        state.runState = runTruth.runState ?? state.runState;
        state.runPhase = payload.currentPhase ?? state.runPhase;
        const createdAt = Number(payload.createdAt);
        state.activeRunStartedAtMs = Number.isFinite(createdAt)
          ? createdAt
          : state.activeRunStartedAtMs ?? api.now();
        api.setTransientStatus(
          `run updated: ${String(state.runState ?? "unknown").replace(/_/g, " ")}`,
        );
        api.eventStore.pushEvent(
          "run",
          "Run Update",
          [
            runTruth.completionState ? `completion state: ${runTruth.completionState}` : null,
            runTruth.completionState &&
            typeof payload.state === "string" &&
            payload.state.trim() &&
            payload.state.trim() !== runTruth.completionState
              ? `run state: ${payload.state.trim()}`
              : `state: ${state.runState ?? "unknown"}`,
            `phase: ${state.runPhase ?? "unknown"}`,
            runTruth.remainingRequirements.length > 0
              ? `remaining requirements: ${runTruth.remainingRequirements.join(", ")}`
              : null,
            `session: ${payload.sessionId ?? state.sessionId ?? "unknown"}`,
            payload.explanation ? `explanation: ${payload.explanation}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "magenta",
        );
      }
      api.requestRunInspect("run update");
      api.requestCockpit("run update");
      return true;
    default:
      return false;
  }
}

function handleObservabilitySurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "observability.traces":
      api.setTransientStatus("trace list loaded");
      api.eventStore.pushEvent("trace", "Trace List", api.tryPrettyJson(surfaceEvent.payloadList ?? []), "slate");
      return true;
    case "observability.trace":
      api.setTransientStatus("trace detail loaded");
      api.eventStore.pushEvent(
        "trace",
        "Trace Detail",
        api.tryPrettyJson(payload.summary ?? payload),
        "slate",
      );
      return true;
    case "observability.logs":
      api.setTransientStatus("log bundle loaded");
      api.eventStore.pushEvent("logs", "Daemon Logs", api.formatLogPayload(payload), "slate");
      return true;
    default:
      return false;
  }
}

function handleStatusSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type === "watch.cockpit") {
    state.cockpit = payload;
    state.cockpitUpdatedAt = api.now();
    state.cockpitFingerprint = api.cockpitFeedFingerprint(payload);
    if (typeof payload?.session?.workflowStage === "string") {
      state.workflowStage = payload.session.workflowStage;
      state.workflowStageUpdatedAt = api.now();
    }
    const ownershipCount = Array.isArray(payload?.ownership) ? payload.ownership.length : 0;
    state.workflowOwnershipSummary =
      ownershipCount > 0 ? `${ownershipCount} ownership entr${ownershipCount === 1 ? "y" : "ies"}` : "";
    state.workflowOwnershipUpdatedAt = api.now();
    api.setTransientStatus("cockpit updated");
    return true;
  }
  if (surfaceEvent.type !== "status.update") {
    return false;
  }
  state.lastStatus = payload ?? state.lastStatus;
  const nextConfiguredRoute = api.normalizeModelRoute({
    ...(payload ?? {}),
    source: "status",
  });
  const currentConfiguredRoute = state.configuredModelRoute;
  if (
    nextConfiguredRoute &&
    (
      !currentConfiguredRoute ||
      currentConfiguredRoute.source === "status" ||
      modelRoutesMatch(currentConfiguredRoute, nextConfiguredRoute)
    )
  ) {
    state.configuredModelRoute = nextConfiguredRoute;
  }
  const backgroundRuns = payload?.backgroundRuns;
  if (backgroundRuns?.enabled === false) {
    api.setTransientStatus("durable runs disabled");
  } else if (
    backgroundRuns &&
    backgroundRuns.enabled === true &&
    backgroundRuns.operatorAvailable === false
  ) {
    api.setTransientStatus("durable run operator unavailable");
  } else {
    api.setTransientStatus("gateway status loaded");
  }
  const fingerprint = api.statusFeedFingerprint(payload);
  const shouldEmit =
    state.lastStatusFeedFingerprint === null ||
    fingerprint !== state.lastStatusFeedFingerprint;
  state.lastStatusFeedFingerprint = fingerprint;
  api.requestCockpit("status poll");
  if (shouldEmit) {
    api.eventStore.pushEvent("status", "Gateway Status", api.formatStatusPayload(payload), "blue");
  }
  return true;
}

function handleAgentSurfaceEvent(surfaceEvent, state, api) {
  const payload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "agent.status") {
    return false;
  }
  if (typeof payload.workflowStage === "string" && payload.workflowStage.trim().length > 0) {
    state.workflowStage = payload.workflowStage.trim();
    state.workflowStageUpdatedAt = Date.now();
  }
  if (typeof payload.workflowOwnershipSummary === "string") {
    state.workflowOwnershipSummary = payload.workflowOwnershipSummary.trim();
    state.workflowOwnershipUpdatedAt = Date.now();
  }
  state.runPhase = payload.phase ?? state.runPhase;
  if (payload.phase === "idle") {
    state.runState = "idle";
    state.activeRunStartedAtMs = null;
  }
  api.setTransientStatus(
    payload.phase
      ? `phase ${payload.phase}`
      : "agent status updated",
  );
  if (payload.phase !== "idle") {
    api.requestRunInspect("agent status");
  }
  api.requestCockpit("agent status");
  return true;
}

function handleApprovalSurfaceEvent(surfaceEvent, api) {
  const payload = surfaceEvent.payloadRecord;
  switch (surfaceEvent.type) {
    case "approval.request":
      api.eventStore.pushEvent("approval", "Approval Request", api.tryPrettyJson(payload), "red");
      api.requestCockpit("approval request");
      return true;
    case "approval.escalated":
      api.eventStore.pushEvent("approval", "Approval Escalated", api.tryPrettyJson(payload), "amber");
      api.requestCockpit("approval escalated");
      return true;
    default:
      return false;
  }
}

function handleErrorSurfaceEvent(surfaceEvent, rawMessage, state, api) {
  const errorMessage = surfaceEvent.message.error;
  const errorPayload = surfaceEvent.payloadRecord;
  if (surfaceEvent.type !== "error") {
    return false;
  }
  state.runInspectPending = false;
  state.manualSessionsRequestPending = false;
  state.manualSessionsQuery = null;
  state.pendingResumeHistoryRestore = false;
  if (api.isExpectedMissingRunInspect(errorMessage, errorPayload)) {
    state.runDetail = null;
    state.runState = "idle";
    state.runPhase = null;
    api.setTransientStatus("no active background run for this session");
    return true;
  }
  if (api.isUnavailableBackgroundRunInspect(errorPayload)) {
    state.runDetail = null;
    state.runState = "idle";
    state.runPhase = null;
    api.setTransientStatus(
      errorPayload?.backgroundRunAvailability?.disabledReason ??
        "durable run operator unavailable",
    );
    api.eventStore.pushEvent(
      "run",
      "Durable Run Unavailable",
      errorMessage ?? api.tryPrettyJson(errorPayload),
      "amber",
    );
    return true;
  }
  if (api.isRetryableBootstrapError(errorMessage)) {
    api.scheduleBootstrap("webchat handler still starting");
    return true;
  }
  api.eventStore.cancelAgentStream("error");
  api.setTransientStatus("runtime error");
  api.eventStore.pushEvent(
    "error",
    "Runtime Error",
    errorMessage ?? api.tryPrettyJson(surfaceEvent.payload ?? rawMessage),
    "red",
  );
  return true;
}

function handleUnknownSurfaceEvent(surfaceEvent, rawMessage, api) {
  api.eventStore.pushEvent(
    surfaceEvent.type,
    surfaceEvent.type,
    api.tryPrettyJson(surfaceEvent.payload ?? rawMessage),
    "slate",
  );
  return true;
}
