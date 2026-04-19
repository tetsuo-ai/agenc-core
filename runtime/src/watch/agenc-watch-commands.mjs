function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`createWatchCommandController requires a ${name} function`);
  }
}

function assertObject(name, value) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`createWatchCommandController requires a ${name} object`);
  }
}

function formatCheckpointSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return "Checkpoint unavailable.";
  }
  const pieces = [
    `${summary.id}${summary.active ? " [active]" : ""}`,
    summary.label,
    `reason ${summary.reason ?? "manual"}`,
    `events ${Number.isFinite(Number(summary.eventCount)) ? Number(summary.eventCount) : 0}`,
    `run ${summary.runState ?? "idle"}`,
  ];
  if (summary.sessionId) {
    pieces.push(`session ${summary.sessionId}`);
  }
  if (summary.objective) {
    pieces.push(`objective ${summary.objective}`);
  }
  if (Number.isFinite(Number(summary.createdAtMs)) && Number(summary.createdAtMs) > 0) {
    pieces.push(new Date(Number(summary.createdAtMs)).toISOString());
  }
  return pieces.join("\n");
}

function formatCheckpointList(summaries = []) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return "No checkpoints saved.";
  }
  return summaries
    .map((summary) => formatCheckpointSummary(summary))
    .join("\n\n");
}

function buildApprovalsCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const rawToken = String(parsedSlash?.commandToken ?? "").trim().toLowerCase();
  if (rawToken === "/approve") {
    if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === "list")) {
      return {
        content: "/approve list",
        title: "Approvals",
        body: "Requested pending approvals for the active session.",
      };
    }
    const requestId = (args[0] ?? "").trim();
    const disposition = (args[1] ?? "").trim().toLowerCase();
    if (requestId && ["yes", "no", "always"].includes(disposition)) {
      return {
        content: `/approve ${requestId} ${disposition}`,
        title: "Approval Resolve",
        body: `Requested ${disposition} for approval ${requestId}.`,
      };
    }
    return {
      error:
        "Usage: /approve [list|<requestId> <yes|no|always>]",
    };
  }

  const subcommand = (args[0] ?? "list").trim().toLowerCase();
  if (!subcommand || subcommand === "list") {
    return {
      content: "/approve list",
      title: "Approvals",
      body: "Requested pending approvals for the active session.",
    };
  }
  const requestId = (args[1] ?? "").trim();
  if (!requestId) {
    return {
      error:
        "Usage: /approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
    };
  }
  const disposition =
    subcommand === "approve"
      ? "yes"
      : subcommand === "deny"
        ? "no"
        : subcommand === "always"
          ? "always"
          : null;
  if (!disposition) {
    return {
      error:
        "Usage: /approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
    };
  }
  return {
    content: `/approve ${requestId} ${disposition}`,
    title: "Approval Resolve",
    body: `Requested ${disposition} for approval ${requestId}.`,
  };
}

function buildCompactionCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "now").trim().toLowerCase();
  if (!subcommand || ["now", "force", "run"].includes(subcommand)) {
    return {
      content: "/compact",
      title: "Compaction",
      body: "Requested immediate conversation compaction for the active session.",
    };
  }
  if (["status", "context", "usage"].includes(subcommand)) {
    return {
      content: "/context",
      title: "Compaction Status",
      body: "Requested context usage and compaction pressure for the active session.",
    };
  }
  return {
    error: "Usage: /compact [now|status]",
  };
}

function buildRetryRunCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Retry Run",
    body: reason
      ? `Retrying durable run for ${sessionId} from its last checkpoint.\n\nReason: ${reason}`
      : `Retrying durable run for ${sessionId} from its last checkpoint.`,
    payload: {
      action: "retry_from_checkpoint",
      sessionId,
      ...(reason ? { reason } : { reason: "operator retry from checkpoint" }),
    },
    status: "retrying run",
  };
}

function buildVerificationOverrideCommand(parsedSlash, sessionId) {
  const args = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const mode = String(args.shift() ?? "")
    .trim()
    .toLowerCase();
  if (!["continue", "complete", "fail"].includes(mode)) {
    return {
      error:
        "Usage: /verify-override <continue|complete|fail> <reason> [--user-update <text>]",
    };
  }
  const userUpdateIndex = args.findIndex((token) =>
    ["--user-update", "--userupdate"].includes(String(token ?? "").trim().toLowerCase())
  );
  const reasonTokens = userUpdateIndex >= 0 ? args.slice(0, userUpdateIndex) : args;
  const userUpdateTokens = userUpdateIndex >= 0 ? args.slice(userUpdateIndex + 1) : [];
  const reason = reasonTokens.join(" ").trim();
  const userUpdate = userUpdateTokens.join(" ").trim();
  if (!reason) {
    return {
      error:
        "Usage: /verify-override <continue|complete|fail> <reason> [--user-update <text>]",
    };
  }
  return {
    title: "Verification Override",
    body: [
      `Applying ${mode} verification override for ${sessionId}.`,
      `Reason: ${reason}`,
      userUpdate ? `User update: ${userUpdate}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "verification_override",
      sessionId,
      override: {
        mode,
        reason,
        ...(userUpdate ? { userUpdate } : {}),
      },
    },
    status: `override ${mode}`,
  };
}

function parseInlineJsonObject(rawValue, usage) {
  const source = String(rawValue ?? "").trim();
  if (!source) {
    return { error: usage };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { error: usage };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: usage };
  }
  return { value: parsed };
}

function buildRunCancelCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Cancel Run",
    body: reason
      ? `Cancelling durable run for ${sessionId}.\n\nReason: ${reason}`
      : `Cancelling durable run for ${sessionId}.`,
    payload: {
      action: "cancel",
      sessionId,
      ...(reason ? { reason } : { reason: "operator cancel durable run" }),
    },
    status: "cancelling run",
  };
}

function buildRunObjectiveCommand(parsedSlash, sessionId) {
  const objective = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  if (!objective) {
    return {
      error: "Usage: /run-objective <objective>",
    };
  }
  return {
    title: "Run Objective",
    body: `Updating durable run objective for ${sessionId}.\n\nObjective: ${objective}`,
    payload: {
      action: "edit_objective",
      sessionId,
      objective,
      reason: "operator updated durable run objective",
    },
    status: "run objective updated",
  };
}

function buildRunConstraintsCommand(parsedSlash, sessionId) {
  const usage =
    "Usage: /run-constraints <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Constraints",
    body: `Amending durable run constraints for ${sessionId}.`,
    payload: {
      action: "amend_constraints",
      sessionId,
      constraints: parsed.value,
      reason: "operator amended durable run constraints",
    },
    status: "run constraints updated",
  };
}

function buildRunBudgetCommand(parsedSlash, sessionId) {
  const usage = "Usage: /run-budget <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Budget",
    body: `Adjusting durable run budget for ${sessionId}.`,
    payload: {
      action: "adjust_budget",
      sessionId,
      budget: parsed.value,
      reason: "operator adjusted durable run budget",
    },
    status: "run budget updated",
  };
}

function buildRunCompactCommand(parsedSlash, sessionId) {
  const reason = Array.isArray(parsedSlash?.args)
    ? parsedSlash.args.join(" ").trim()
    : "";
  return {
    title: "Run Compaction",
    body: reason
      ? `Forcing durable run compaction for ${sessionId}.\n\nReason: ${reason}`
      : `Forcing durable run compaction for ${sessionId}.`,
    payload: {
      action: "force_compact",
      sessionId,
      ...(reason ? { reason } : { reason: "operator requested durable run compaction" }),
    },
    status: "run compaction requested",
  };
}

function buildRunWorkerCommand(parsedSlash, sessionId) {
  const usage = "Usage: /run-worker <json>";
  const parsed = parseInlineJsonObject(
    Array.isArray(parsedSlash?.args) ? parsedSlash.args.join(" ") : "",
    usage,
  );
  if (parsed.error) {
    return parsed;
  }
  return {
    title: "Run Worker",
    body: `Updating durable run worker preference for ${sessionId}.`,
    payload: {
      action: "reassign_worker",
      sessionId,
      worker: parsed.value,
      reason: "operator reassigned durable run worker",
    },
    status: "run worker updated",
  };
}

function splitOptionTail(tokens = [], optionNames = []) {
  const normalizedNames = optionNames.map((value) => String(value).trim().toLowerCase());
  const index = tokens.findIndex((token) =>
    normalizedNames.includes(String(token ?? "").trim().toLowerCase())
  );
  if (index < 0) {
    return {
      head: tokens,
      tail: [],
    };
  }
  return {
    head: tokens.slice(0, index),
    tail: tokens.slice(index + 1),
  };
}

function buildRetryStepCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const traceIndex = rawArgs.findIndex((token) =>
    ["--trace"].includes(String(token ?? "").trim().toLowerCase())
  );
  let traceId = "";
  let withoutTrace = rawArgs;
  if (traceIndex >= 0) {
    traceId = String(rawArgs[traceIndex + 1] ?? "").trim();
    withoutTrace = [...rawArgs.slice(0, traceIndex), ...rawArgs.slice(traceIndex + 2)];
  }
  const { head, tail } = splitOptionTail(withoutTrace, ["--reason"]);
  const stepName = head.join(" ").trim();
  const reason = tail.join(" ").trim();
  if (!stepName) {
    return {
      error:
        "Usage: /retry-step <stepName> [--trace <traceId>] [--reason <text>]",
    };
  }
  return {
    title: "Retry Step",
    body: [
      `Retrying durable run step "${stepName}" for ${sessionId}.`,
      traceId ? `Trace: ${traceId}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "retry_from_step",
      sessionId,
      stepName,
      ...(traceId ? { traceId } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "retrying step",
  };
}

function buildRetryTraceCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const traceId = String(rawArgs.shift() ?? "").trim();
  const { head, tail } = splitOptionTail(rawArgs, ["--reason"]);
  const stepName = head.join(" ").trim();
  const reason = tail.join(" ").trim();
  if (!traceId) {
    return {
      error:
        "Usage: /retry-trace <traceId> [stepName] [--reason <text>]",
    };
  }
  return {
    title: "Retry Trace",
    body: [
      `Retrying durable run trace "${traceId}" for ${sessionId}.`,
      stepName ? `Step: ${stepName}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "retry_from_trace",
      sessionId,
      traceId,
      ...(stepName ? { stepName } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "retrying trace",
  };
}

function buildRunForkCommand(parsedSlash, sessionId) {
  const rawArgs = Array.isArray(parsedSlash?.args) ? [...parsedSlash.args] : [];
  const targetSessionId = String(rawArgs.shift() ?? "").trim();
  if (!targetSessionId) {
    return {
      error:
        "Usage: /run-fork <targetSessionId> [--objective <text>] [--reason <text>]",
    };
  }
  const objectiveIndex = rawArgs.findIndex((token) =>
    ["--objective"].includes(String(token ?? "").trim().toLowerCase())
  );
  const reasonIndex = rawArgs.findIndex((token) =>
    ["--reason"].includes(String(token ?? "").trim().toLowerCase())
  );
  let objective = "";
  let reason = "";
  if (objectiveIndex >= 0) {
    const end = reasonIndex > objectiveIndex ? reasonIndex : rawArgs.length;
    objective = rawArgs.slice(objectiveIndex + 1, end).join(" ").trim();
  }
  if (reasonIndex >= 0) {
    reason = rawArgs.slice(reasonIndex + 1).join(" ").trim();
  }
  return {
    title: "Fork Run",
    body: [
      `Forking durable run ${sessionId} into ${targetSessionId}.`,
      objective ? `Objective: ${objective}` : null,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    payload: {
      action: "fork_from_checkpoint",
      sessionId,
      targetSessionId,
      ...(objective ? { objective } : {}),
      ...(reason ? { reason } : {}),
    },
    status: "forking run",
  };
}

function buildDesktopCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "").trim().toLowerCase();
  if (!subcommand || !["start", "stop", "status", "vnc", "list", "attach"].includes(subcommand)) {
    return {
      error: "Usage: /desktop <start|stop|status|vnc|list|attach>",
    };
  }
  return {
    content: ["/desktop", ...args].join(" ").trim(),
    title: "Desktop Tools",
    body: `Requested desktop command: /desktop ${args.join(" ").trim()}`.trim(),
  };
}

function parseSlashFlagTokens(tokens = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < tokens.length;) {
    const token = String(tokens[index] ?? "").trim();
    if (token.startsWith("--")) {
      const values = [];
      index += 1;
      while (index < tokens.length) {
        const nextToken = String(tokens[index] ?? "").trim();
        if (nextToken.startsWith("--")) {
          break;
        }
        values.push(nextToken);
        index += 1;
      }
      flags[token.toLowerCase()] = values.join(" ").trim();
      continue;
    }
    positional.push(token);
    index += 1;
  }
  return { positional, flags };
}

function hasSlashFlag(flags, flagName) {
  return Object.prototype.hasOwnProperty.call(
    flags ?? {},
    `--${String(flagName ?? "").trim().toLowerCase()}`,
  );
}

function readSlashFlag(flags, flagName) {
  const key = `--${String(flagName ?? "").trim().toLowerCase()}`;
  const value = flags?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseDelimitedStrings(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePairListValue(value, leftKey, rightKey) {
  const entries = parseDelimitedStrings(value);
  if (entries.length === 0) {
    return {
      error: `Expected ${leftKey}:${rightKey}[,${leftKey}:${rightKey}...]`,
    };
  }
  const pairs = [];
  for (const entry of entries) {
    const parts = entry.split(":").map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return {
        error: `Invalid pair "${entry}". Expected ${leftKey}:${rightKey}.`,
      };
    }
    pairs.push({
      [leftKey]: parts[0],
      [rightKey]: parts[1],
    });
  }
  return { value: pairs };
}

function parseFiniteNumber(value, label) {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    return {
      error: `${label} must be a finite number.`,
    };
  }
  return { value: parsed };
}

function parseSafeInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isSafeInteger(parsed)) {
    return {
      error: `${label} must be a safe integer.`,
    };
  }
  return { value: parsed };
}

function buildMarketCommand(parsedSlash) {
  const usage =
    "Usage: /market <tasks|skills|governance|disputes|reputation> ...";
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const area = String(args[0] ?? "").trim().toLowerCase();
  const action = String(args[1] ?? "").trim().toLowerCase();
  const { positional, flags } = parseSlashFlagTokens(args.slice(2));

  if (!area || !["tasks", "skills", "governance", "disputes", "reputation"].includes(area)) {
    return { error: usage };
  }

  if (area === "tasks") {
    const taskAction = action || "list";
    if (taskAction === "list") {
      const statuses = parseDelimitedStrings(readSlashFlag(flags, "status"));
      return {
        messageType: "tasks.list",
        payload: statuses.length > 0 ? { statuses } : {},
        title: "Marketplace Tasks",
        body:
          statuses.length > 0
            ? `Requested marketplace tasks with status filter: ${statuses.join(", ")}.`
            : "Requested marketplace tasks.",
        status: "requesting marketplace tasks",
        openBrowser: {
          kind: "tasks",
          statuses,
        },
      };
    }
    if (taskAction === "create") {
      const description = readSlashFlag(flags, "description") || readSlashFlag(flags, "desc");
      if (!description) {
        return {
          error:
            "Usage: /market tasks create --description <text> (--reward <sol> | --reward-lamports <lamports>)",
        };
      }
      const rewardLamports = readSlashFlag(flags, "reward-lamports");
      const reward = readSlashFlag(flags, "reward");
      if (!rewardLamports && !reward) {
        return {
          error:
            "Usage: /market tasks create --description <text> (--reward <sol> | --reward-lamports <lamports>)",
        };
      }
      if (rewardLamports) {
        const parsedLamports = parseSafeInteger(rewardLamports, "reward-lamports");
        if (parsedLamports.error || parsedLamports.value <= 0) {
          return {
            error: parsedLamports.error ?? "reward-lamports must be greater than 0.",
          };
        }
        return {
          messageType: "tasks.create",
          payload: {
            params: {
              description,
              rewardLamports: String(parsedLamports.value),
            },
          },
          title: "Create Task",
          body: `Creating marketplace task.\n\ndescription: ${description}\nreward: ${parsedLamports.value} lamports`,
          status: "creating marketplace task",
        };
      }
      const parsedReward = parseFiniteNumber(reward, "reward");
      if (parsedReward.error || parsedReward.value <= 0) {
        return {
          error: parsedReward.error ?? "reward must be greater than 0.",
        };
      }
      return {
        messageType: "tasks.create",
        payload: {
          params: {
            description,
            reward: parsedReward.value,
          },
        },
        title: "Create Task",
        body: `Creating marketplace task.\n\ndescription: ${description}\nreward: ${parsedReward.value} SOL`,
        status: "creating marketplace task",
      };
    }
    if (taskAction === "detail") {
      const taskPda = String(positional[0] ?? "").trim();
      if (!taskPda) {
        return {
          error: "Usage: /market tasks detail <taskPda>",
        };
      }
      return {
        messageType: "tasks.detail",
        payload: { taskPda },
        title: "Task Detail",
        body: `Requested marketplace task ${taskPda}.`,
        status: "loading task detail",
      };
    }
    if (["cancel", "claim"].includes(taskAction)) {
      const taskId = String(positional[0] ?? "").trim();
      if (!taskId) {
        return {
          error: `Usage: /market tasks ${taskAction} <taskPda>`,
        };
      }
      return {
        messageType: `tasks.${taskAction}`,
        payload: { taskId },
        title: taskAction === "cancel" ? "Cancel Task" : "Claim Task",
        body:
          taskAction === "cancel"
            ? `Cancelling marketplace task ${taskId}.`
            : `Claiming marketplace task ${taskId}.`,
        status:
          taskAction === "cancel"
            ? "cancelling marketplace task"
            : "claiming marketplace task",
      };
    }
    if (taskAction === "complete") {
      const taskId = String(positional[0] ?? "").trim();
      if (!taskId) {
        return {
          error: "Usage: /market tasks complete <taskPda> [--result-data <text>]",
        };
      }
      const resultData = readSlashFlag(flags, "result-data");
      return {
        messageType: "tasks.complete",
        payload: {
          taskId,
          ...(resultData ? { resultData } : {}),
        },
        title: "Complete Task",
        body: resultData
          ? `Completing marketplace task ${taskId}.\n\nresult: ${resultData}`
          : `Completing marketplace task ${taskId}.`,
        status: "completing marketplace task",
      };
    }
    if (taskAction === "dispute") {
      const taskId = String(positional[0] ?? "").trim();
      const evidence = readSlashFlag(flags, "evidence");
      const resolutionType = readSlashFlag(flags, "resolution-type") || "refund";
      if (!taskId || !evidence) {
        return {
          error:
            "Usage: /market tasks dispute <taskPda> --evidence <text> [--resolution-type refund|complete|split]",
        };
      }
      if (!["refund", "complete", "split"].includes(resolutionType)) {
        return {
          error: "resolution-type must be one of refund, complete, or split.",
        };
      }
      return {
        messageType: "tasks.dispute",
        payload: { taskId, evidence, resolutionType },
        title: "Open Dispute",
        body: `Opening dispute for task ${taskId}.\n\nresolution: ${resolutionType}\nevidence: ${evidence}`,
        status: "opening marketplace dispute",
      };
    }
    return { error: `${usage}\n\nTasks: list, create, detail, cancel, claim, complete, dispute` };
  }

  if (area === "skills") {
    const skillAction = action || "list";
    if (skillAction === "list") {
      const query = readSlashFlag(flags, "query") || String(positional[0] ?? "").trim();
      const activeOnly = !hasSlashFlag(flags, "all");
      return {
        messageType: "market.skills.list",
        payload: {
          ...(query ? { query } : {}),
          activeOnly,
        },
        title: "Marketplace Skills",
        body: query
          ? `Searching marketplace skills for "${query}".`
          : activeOnly
            ? "Requested active marketplace skills."
            : "Requested all marketplace skills.",
        status: "requesting marketplace skills",
        openBrowser: {
          kind: "skills",
          query,
          activeOnly,
        },
      };
    }
    if (skillAction === "detail") {
      const skillPda = String(positional[0] ?? "").trim();
      if (!skillPda) {
        return { error: "Usage: /market skills detail <skillPda>" };
      }
      return {
        messageType: "market.skills.detail",
        payload: { skillPda },
        title: "Skill Detail",
        body: `Requested marketplace skill ${skillPda}.`,
        status: "loading skill detail",
      };
    }
    if (skillAction === "purchase") {
      const skillPda = String(positional[0] ?? "").trim();
      const skillId = String(positional[1] ?? "").trim();
      if (!skillPda) {
        return { error: "Usage: /market skills purchase <skillPda> [skillId]" };
      }
      return {
        messageType: "market.skills.purchase",
        payload: {
          skillPda,
          ...(skillId ? { skillId } : {}),
        },
        title: "Purchase Skill",
        body: skillId
          ? `Purchasing marketplace skill ${skillPda} (${skillId}).`
          : `Purchasing marketplace skill ${skillPda}.`,
        status: "purchasing marketplace skill",
      };
    }
    if (skillAction === "rate") {
      const skillPda = String(positional[0] ?? "").trim();
      const ratingToken = String(positional[1] ?? "").trim();
      const parsedRating = parseSafeInteger(ratingToken, "rating");
      if (!skillPda || parsedRating.error || parsedRating.value < 1 || parsedRating.value > 5) {
        return {
          error: "Usage: /market skills rate <skillPda> <1-5> [--review <text>]",
        };
      }
      const review = readSlashFlag(flags, "review");
      return {
        messageType: "market.skills.rate",
        payload: {
          skillPda,
          rating: parsedRating.value,
          ...(review ? { review } : {}),
        },
        title: "Rate Skill",
        body: review
          ? `Rating marketplace skill ${skillPda} with ${parsedRating.value}/5.\n\nreview: ${review}`
          : `Rating marketplace skill ${skillPda} with ${parsedRating.value}/5.`,
        status: "rating marketplace skill",
      };
    }
    return { error: `${usage}\n\nSkills: list, detail, purchase, rate` };
  }

  if (area === "governance") {
    const governanceAction = action || "list";
    if (governanceAction === "list") {
      const status = readSlashFlag(flags, "status");
      return {
        messageType: "market.governance.list",
        payload: status ? { status } : {},
        title: "Governance Proposals",
        body: status
          ? `Requested governance proposals with status ${status}.`
          : "Requested governance proposals.",
        status: "requesting governance proposals",
        openBrowser: {
          kind: "governance",
          statuses: status ? [status] : [],
        },
      };
    }
    if (governanceAction === "detail") {
      const proposalPda = String(positional[0] ?? "").trim();
      if (!proposalPda) {
        return { error: "Usage: /market governance detail <proposalPda>" };
      }
      return {
        messageType: "market.governance.detail",
        payload: { proposalPda },
        title: "Governance Detail",
        body: `Requested governance proposal ${proposalPda}.`,
        status: "loading governance detail",
      };
    }
    if (governanceAction === "vote") {
      const proposalPda = String(positional[0] ?? "").trim();
      const voteToken = String(positional[1] ?? "").trim().toLowerCase();
      if (!proposalPda || !["yes", "no"].includes(voteToken)) {
        return { error: "Usage: /market governance vote <proposalPda> <yes|no>" };
      }
      return {
        messageType: "market.governance.vote",
        payload: {
          proposalPda,
          approve: voteToken === "yes",
        },
        title: "Governance Vote",
        body: `Casting ${voteToken} vote for proposal ${proposalPda}.`,
        status: "submitting governance vote",
      };
    }
    return { error: `${usage}\n\nGovernance: list, detail, vote` };
  }

  if (area === "disputes") {
    const disputeAction = action || "list";
    if (disputeAction === "list") {
      const statuses = parseDelimitedStrings(readSlashFlag(flags, "status"));
      return {
        messageType: "market.disputes.list",
        payload: statuses.length > 0 ? { statuses } : {},
        title: "Marketplace Disputes",
        body:
          statuses.length > 0
            ? `Requested disputes with status filter: ${statuses.join(", ")}.`
            : "Requested marketplace disputes.",
        status: "requesting marketplace disputes",
        openBrowser: {
          kind: "disputes",
          statuses,
        },
      };
    }
    if (disputeAction === "detail") {
      const disputePda = String(positional[0] ?? "").trim();
      if (!disputePda) {
        return { error: "Usage: /market disputes detail <disputePda>" };
      }
      return {
        messageType: "market.disputes.detail",
        payload: { disputePda },
        title: "Dispute Detail",
        body: `Requested dispute ${disputePda}.`,
        status: "loading dispute detail",
      };
    }
    if (disputeAction === "resolve") {
      const disputePda = String(positional[0] ?? "").trim();
      const arbiterVotesText = readSlashFlag(flags, "arbiter-votes");
      const extraWorkersText = readSlashFlag(flags, "extra-workers");
      if (!disputePda || !arbiterVotesText) {
        return {
          error:
            "Usage: /market disputes resolve <disputePda> --arbiter-votes <votePda:arbiterPda[,..]> [--extra-workers <claimPda:workerPda[,..]>]",
        };
      }
      const arbiterVotes = parsePairListValue(
        arbiterVotesText,
        "votePda",
        "arbiterAgentPda",
      );
      if (arbiterVotes.error) {
        return { error: arbiterVotes.error };
      }
      const extraWorkers = extraWorkersText
        ? parsePairListValue(extraWorkersText, "claimPda", "workerPda")
        : { value: [] };
      if (extraWorkers.error) {
        return { error: extraWorkers.error };
      }
      return {
        messageType: "market.disputes.resolve",
        payload: {
          disputePda,
          arbiterVotes: arbiterVotes.value,
          ...(extraWorkers.value.length > 0 ? { extraWorkers: extraWorkers.value } : {}),
        },
        title: "Resolve Dispute",
        body: `Resolving dispute ${disputePda} with ${arbiterVotes.value.length} arbiter vote(s).`,
        status: "resolving marketplace dispute",
      };
    }
    return { error: `${usage}\n\nDisputes: list, detail, resolve` };
  }

  const reputationAction = action || "summary";
  if (reputationAction === "summary") {
    const agentPda = readSlashFlag(flags, "agent-pda") || String(positional[0] ?? "").trim();
    return {
      messageType: "market.reputation.summary",
      payload: agentPda ? { agentPda } : {},
      title: "Reputation Summary",
      body: agentPda
        ? `Requested reputation summary for ${agentPda}.`
        : "Requested signer reputation summary.",
      status: "loading reputation summary",
      openBrowser: {
        kind: "reputation",
      },
    };
  }
  if (reputationAction === "stake") {
    const amount = String(positional[0] ?? "").trim() || readSlashFlag(flags, "amount");
    if (!amount) {
      return { error: "Usage: /market reputation stake <lamports>" };
    }
    return {
      messageType: "market.reputation.stake",
      payload: { amount },
      title: "Stake Reputation",
      body: `Staking ${amount} lamports into reputation.`,
      status: "staking reputation",
    };
  }
  if (reputationAction === "delegate") {
    const amount = String(positional[0] ?? "").trim() || readSlashFlag(flags, "amount");
    const parsedAmount = parseFiniteNumber(amount, "amount");
    const delegateeAgentPda = readSlashFlag(flags, "delegatee-agent-pda");
    const delegateeAgentId = readSlashFlag(flags, "delegatee-agent-id");
    const expiresAtText = readSlashFlag(flags, "expires-at");
    if (!amount || parsedAmount.error || (!delegateeAgentPda && !delegateeAgentId)) {
      return {
        error:
          "Usage: /market reputation delegate <amount> (--delegatee-agent-pda <pda> | --delegatee-agent-id <id>) [--expires-at <unix>]",
      };
    }
    let expiresAt;
    if (expiresAtText) {
      const parsedExpiresAt = parseSafeInteger(expiresAtText, "expires-at");
      if (parsedExpiresAt.error) {
        return { error: parsedExpiresAt.error };
      }
      expiresAt = parsedExpiresAt.value;
    }
    return {
      messageType: "market.reputation.delegate",
      payload: {
        amount: parsedAmount.value,
        ...(delegateeAgentPda ? { delegateeAgentPda } : {}),
        ...(delegateeAgentId ? { delegateeAgentId } : {}),
        ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      },
      title: "Delegate Reputation",
      body: delegateeAgentPda
        ? `Delegating ${parsedAmount.value} reputation to ${delegateeAgentPda}.`
        : `Delegating ${parsedAmount.value} reputation to agent ${delegateeAgentId}.`,
      status: "delegating reputation",
    };
  }

  return { error: `${usage}\n\nReputation: summary, stake, delegate` };
}

function buildExtensibilityCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const section = (args[0] ?? "overview").trim().toLowerCase();
  if (!["overview", "skills", "plugins", "mcp", "hooks"].includes(section)) {
    return {
      error: "Usage: /extensibility [overview|skills|plugins|mcp|hooks]",
    };
  }
  return { section };
}

function buildXaiCommand(parsedSlash) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "set").trim().toLowerCase();
  if (!subcommand || subcommand === "set") {
    return { mode: "set" };
  }
  if (subcommand === "status") {
    return { mode: "status" };
  }
  if (subcommand === "validate") {
    return { mode: "validate" };
  }
  if (subcommand === "clear") {
    return { mode: "clear" };
  }
  return {
    error: "Usage: /xai [set|status|validate|clear]",
  };
}

function buildInputPreferenceCommand(parsedSlash, {
  commandName,
  usage,
  defaultValue,
  allowedValues,
} = {}) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const token = (args[0] ?? "show").trim().toLowerCase();
  if (!token || token === "show" || token === "status") {
    return { mode: "show" };
  }
  if (allowedValues.includes(token)) {
    return {
      mode: "set",
      value: token === "insert" || token === "normal" ? "vim" : token,
      composerMode: commandName === "/input-mode" && ["insert", "normal"].includes(token)
        ? token
        : null,
    };
  }
  return {
    error: `Usage: ${usage}`,
  };
}

function buildDiffViewCommand(
  parsedSlash,
  {
    openLatestDiffDetail,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    closeDetailView,
  },
) {
  const args = Array.isArray(parsedSlash?.args) ? parsedSlash.args : [];
  const subcommand = (args[0] ?? "open").trim().toLowerCase();
  if (!subcommand || ["open", "latest", "show"].includes(subcommand)) {
    const diffEvent = openLatestDiffDetail();
    if (!diffEvent) {
      return {
        errorTitle: "No Diff Available",
        errorBody: "No diff or mutation preview is available in the current transcript.",
        status: "no diff available",
      };
    }
    return {
      title: "Diff View",
      body: `Opened diff detail for ${diffEvent.title}.`,
      status: `detail open: ${diffEvent.title}`,
    };
  }
  if (["next", "prev", "previous"].includes(subcommand)) {
    let navigation = currentDiffNavigationState();
    if (!navigation?.enabled) {
      const diffEvent = openLatestDiffDetail();
      if (!diffEvent) {
        return {
          errorTitle: "No Diff Available",
          errorBody: "No diff or mutation preview is available in the current transcript.",
          status: "no diff available",
        };
      }
      navigation = currentDiffNavigationState();
    }
    if (!navigation?.enabled) {
      return {
        errorTitle: "No Diff Hunk Navigation",
        errorBody: "The active detail view does not expose diff hunks.",
        status: "diff hunk navigation unavailable",
      };
    }
    const direction = subcommand === "next" ? 1 : -1;
    const moved = jumpCurrentDiffHunk(direction);
    const nextNavigation = currentDiffNavigationState();
    const ordinal = nextNavigation?.currentHunkIndex + 1;
    const total = nextNavigation?.totalHunks ?? 0;
    if (moved) {
      return {
        title: "Diff View",
        body:
          total > 0
            ? `Focused hunk ${ordinal}/${total}${nextNavigation?.currentFilePath ? ` in ${nextNavigation.currentFilePath}.` : "."}`
            : "Focused the requested diff hunk.",
        status:
          total > 0
            ? `hunk ${ordinal}/${total}`
            : "diff hunk focused",
      };
    }
    return {
      title: "Diff View",
      body:
        total > 0
          ? `Already at the ${direction > 0 ? "last" : "first"} hunk (${ordinal}/${total}).`
          : "No diff hunks are available in the active detail view.",
      status:
        total > 0
          ? `${direction > 0 ? "last" : "first"} hunk ${ordinal}/${total}`
          : "no diff hunks available",
    };
  }
  if (["close", "hide"].includes(subcommand)) {
    const navigation = currentDiffNavigationState();
    if (!navigation?.enabled) {
      return {
        errorTitle: "No Diff Detail Open",
        errorBody: "No diff detail is currently open.",
        status: "diff detail not open",
      };
    }
    const closed = closeDetailView();
    if (!closed) {
      return {
        errorTitle: "No Diff Detail Open",
        errorBody: "No diff detail is currently open.",
        status: "diff detail not open",
      };
    }
    return {
      title: "Diff View",
      body: "Closed the active diff detail view.",
      status: "detail closed",
    };
  }
  return {
    errorTitle: "Usage Error",
    errorBody: "Usage: /diff-view [open|next|prev|close]",
  };
}

export function createWatchCommandController(dependencies = {}) {
  const {
    watchState,
    queuedOperatorInputs,
    WATCH_COMMANDS,
    getWatchCommands,
    parseWatchSlashCommand,
    authPayload,
    send,
    shutdownWatch,
    dismissIntro,
    clearLiveTranscriptView,
    exportCurrentView,
    exportBundle,
    showInsights,
    showMaintenance,
    showExtensibility,
    showInputModes,
    resetLiveRunSurface,
    resetDelegationState,
    persistSessionId,
    currentSessionLabel,
    setSessionLabel,
    clearSessionLabel,
    currentInputPreferences,
    setInputModeProfile,
    setKeybindingProfile,
    setThemeName,
    showXaiStatus,
    validateConfiguredXaiKey,
    clearXaiApiKey,
    promptForXaiApiKey,
    captureCheckpoint,
    listCheckpoints,
    listPendingAttachments,
    formatPendingAttachments,
    queuePendingAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    prepareChatMessagePayload,
    applyOptimisticModelSelection,
    openMarketTaskBrowser,
    dismissMarketTaskBrowser,
    openLatestDiffDetail,
    currentDiffNavigationState,
    jumpCurrentDiffHunk,
    closeDetailView,
    rewindToCheckpoint,
    clearBootstrapTimer,
    pushEvent,
    setTransientStatus,
    readWatchDaemonLogTail,
    formatLogPayload,
    currentClientKey,
    isOpen,
    bootstrapPending,
    voiceController,
    nowMs = Date.now,
  } = dependencies;

  assertObject("watchState", watchState);
  if (!Array.isArray(queuedOperatorInputs)) {
    throw new TypeError("createWatchCommandController requires a queuedOperatorInputs array");
  }
  if (
    !Array.isArray(WATCH_COMMANDS) &&
    typeof getWatchCommands !== "function"
  ) {
    throw new TypeError("createWatchCommandController requires WATCH_COMMANDS");
  }
  assertFunction("parseWatchSlashCommand", parseWatchSlashCommand);
  assertFunction("authPayload", authPayload);
  assertFunction("send", send);
  assertFunction("shutdownWatch", shutdownWatch);
  assertFunction("dismissIntro", dismissIntro);
  assertFunction("clearLiveTranscriptView", clearLiveTranscriptView);
  assertFunction("exportCurrentView", exportCurrentView);
  assertFunction("resetLiveRunSurface", resetLiveRunSurface);
  assertFunction("resetDelegationState", resetDelegationState);
  assertFunction("persistSessionId", persistSessionId);
  assertFunction("clearBootstrapTimer", clearBootstrapTimer);
  assertFunction("pushEvent", pushEvent);
  assertFunction("setTransientStatus", setTransientStatus);
  assertFunction("readWatchDaemonLogTail", readWatchDaemonLogTail);
  assertFunction("formatLogPayload", formatLogPayload);
  assertFunction("currentClientKey", currentClientKey);
  assertFunction("isOpen", isOpen);
  assertFunction("bootstrapPending", bootstrapPending);
  assertFunction("nowMs", nowMs);
  const currentWatchCommands =
    typeof getWatchCommands === "function" ? getWatchCommands : () => WATCH_COMMANDS;
  const commandNames = new Set(
    currentWatchCommands().map((command) => command?.name).filter(Boolean),
  );
  const attachmentCommandsEnabled =
    commandNames.has("/attach") ||
    commandNames.has("/attachments") ||
    commandNames.has("/unattach");
  if (
    commandNames.has("/checkpoint") ||
    commandNames.has("/checkpoints") ||
    commandNames.has("/rewind")
  ) {
    assertFunction("captureCheckpoint", captureCheckpoint);
    assertFunction("listCheckpoints", listCheckpoints);
    assertFunction("rewindToCheckpoint", rewindToCheckpoint);
  }
  if (commandNames.has("/market")) {
    assertFunction("openMarketTaskBrowser", openMarketTaskBrowser);
    assertFunction("dismissMarketTaskBrowser", dismissMarketTaskBrowser);
  }
  if (commandNames.has("/diff-view")) {
    assertFunction("openLatestDiffDetail", openLatestDiffDetail);
    assertFunction("currentDiffNavigationState", currentDiffNavigationState);
    assertFunction("jumpCurrentDiffHunk", jumpCurrentDiffHunk);
    assertFunction("closeDetailView", closeDetailView);
  }
  if (attachmentCommandsEnabled) {
    assertFunction("listPendingAttachments", listPendingAttachments);
    assertFunction("formatPendingAttachments", formatPendingAttachments);
    assertFunction("queuePendingAttachment", queuePendingAttachment);
    assertFunction("removePendingAttachment", removePendingAttachment);
    assertFunction("clearPendingAttachments", clearPendingAttachments);
    assertFunction("prepareChatMessagePayload", prepareChatMessagePayload);
  }
  if (commandNames.has("/bundle")) {
    assertFunction("exportBundle", exportBundle);
  }
  if (commandNames.has("/insights")) {
    assertFunction("showInsights", showInsights);
  }
  if (commandNames.has("/maintenance")) {
    assertFunction("showMaintenance", showMaintenance);
  }
  if (commandNames.has("/extensibility")) {
    assertFunction("showExtensibility", showExtensibility);
  }
  if (
    commandNames.has("/input-mode") ||
    commandNames.has("/keybindings") ||
    commandNames.has("/theme")
  ) {
    assertFunction("showInputModes", showInputModes);
    assertFunction("currentInputPreferences", currentInputPreferences);
    assertFunction("setInputModeProfile", setInputModeProfile);
    assertFunction("setKeybindingProfile", setKeybindingProfile);
    assertFunction("setThemeName", setThemeName);
  }
  if (commandNames.has("/xai")) {
    assertFunction("showXaiStatus", showXaiStatus);
    assertFunction("validateConfiguredXaiKey", validateConfiguredXaiKey);
    assertFunction("clearXaiApiKey", clearXaiApiKey);
    assertFunction("promptForXaiApiKey", promptForXaiApiKey);
  }
  if (commandNames.has("/session-label")) {
    assertFunction("currentSessionLabel", currentSessionLabel);
    assertFunction("setSessionLabel", setSessionLabel);
    assertFunction("clearSessionLabel", clearSessionLabel);
  }

  const listPendingAttachmentsImpl =
    typeof listPendingAttachments === "function" ? listPendingAttachments : () => [];
  const formatPendingAttachmentsImpl =
    typeof formatPendingAttachments === "function"
      ? formatPendingAttachments
      : () => "No attachments queued.";
  const prepareChatMessagePayloadImpl =
    typeof prepareChatMessagePayload === "function"
      ? prepareChatMessagePayload
      : (content) => ({
        payload: authPayload({ content }),
        attachmentSummaries: [],
      });

  function attachmentSummarySuffix() {
    const queued = listPendingAttachmentsImpl();
    if (!Array.isArray(queued) || queued.length === 0) {
      return "";
    }
    return `\n\nAttachments\n${formatPendingAttachmentsImpl()}`;
  }

  function sendPreparedChatMessage(content, {
    eventKind = "you",
    title = "Prompt",
    body = content,
    tone = "teal",
  } = {}) {
    const attachmentSuffix = attachmentSummarySuffix();
    let prepared;
    try {
      prepared = prepareChatMessagePayloadImpl(content, { consumeAttachments: true });
    } catch (error) {
      setTransientStatus("attachment error");
      pushEvent(
        "error",
        "Attachment Error",
        error instanceof Error ? error.message : String(error),
        "red",
      );
      return false;
    }
    pushEvent(eventKind, title, `${body}${attachmentSuffix}`, tone);
    send("chat.message", prepared.payload);
    if (Array.isArray(prepared?.attachmentSummaries) && prepared.attachmentSummaries.length > 0) {
      setTransientStatus(
        `sent with ${prepared.attachmentSummaries.length} attachment${prepared.attachmentSummaries.length === 1 ? "" : "s"}`,
      );
    }
    return true;
  }

  function dispatchSessionCommand(content, {
    title = "Command",
    body = content,
    tone = "teal",
    allowBootstrapQueue = true,
  } = {}) {
    if (allowBootstrapQueue && shouldQueueOperatorInput()) {
      return maybeQueue("session bootstrap not complete");
    }
    pushEvent("operator", title, body, tone);
    const trimmedContent = String(content ?? "").trim();
    const sessionResumeMatch = trimmedContent.match(/^\/session\s+resume\s+(\S+)\s*$/i);
    if (sessionResumeMatch?.[1]) {
      send(
        "chat.session.resume",
        authPayload({
          sessionId: sessionResumeMatch[1],
        }),
      );
      return true;
    }
    send(
      "session.command.execute",
      authPayload({
        ...(watchState.sessionId ? { sessionId: watchState.sessionId } : {}),
        client: "console",
        content: trimmedContent,
      }),
    );
    return true;
  }

  function printHelp() {
    const helpEvent = pushEvent(
      "help",
      "Command Help",
      [
        "Keyboard",
        "Ctrl+O opens the newest event in a full detail view.",
        "Ctrl+Y copies the current detail view or transcript to tmux/system clipboard.",
        "Ctrl+Q prints the current detail view or transcript into the normal terminal so you can native-select/copy it, then Ctrl+Q returns to watch.",
        "Ctrl+L clears the visible transcript without leaving the session.",
        "",
        ...currentWatchCommands().map((command) => {
          const aliasText =
            Array.isArray(command.aliases) && command.aliases.length > 0
              ? ` (${command.aliases.join(", ")})`
              : "";
          return `${command.usage}${aliasText}\n${command.description}`;
        }),
      ].join("\n\n"),
      "slate",
    );
    if (helpEvent?.id) {
      watchState.expandedEventId = helpEvent.id;
      watchState.detailScrollOffset = 0;
    }
  }

  function queueOperatorInput(value, reason = "bootstrap pending") {
    queuedOperatorInputs.push(value);
    pushEvent(
      "queued",
      "Queued Input",
      `${value}\n\n${reason}`,
      "amber",
    );
    setTransientStatus(`queued ${value} until session restore completes`);
  }

  function requireSession(command) {
    if (!watchState.sessionId) {
      pushEvent("error", "Session Error", `${command} requires an active session`, "red");
      return false;
    }
    return true;
  }

  function shouldQueueOperatorInput() {
    return !isOpen() || bootstrapPending();
  }

  function dispatchOperatorInput(value, { replayed = false } = {}) {
    dismissIntro();
    watchState.transcriptScrollOffset = 0;
    watchState.transcriptFollowMode = true;
    const maybeQueue = (reason) => {
      if (replayed) {
        pushEvent("error", "Queued Input Failed", `${value}\n\n${reason}`, "red");
        return true;
      }
      queueOperatorInput(value, reason);
      return true;
    };

    if (value.trim() === "/") {
      printHelp();
      return true;
    }

    const parsedSlash = parseWatchSlashCommand(value);
    if (parsedSlash) {
      const canonicalName = parsedSlash.command?.name ?? null;
      const firstArg = parsedSlash.args[0];

      if (canonicalName === "/quit") {
        shutdownWatch(0);
        return true;
      }

      if (canonicalName === "/help") {
        printHelp();
        return true;
      }

      if (canonicalName === "/clear") {
        clearLiveTranscriptView();
        return true;
      }

      if (canonicalName === "/events") {
        const nextFilter = String(firstArg ?? "all").trim().toLowerCase() || "all";
        const allowed = new Set(["all", "shell", "tool", "approval", "run", "agent", "system"]);
        if (!allowed.has(nextFilter)) {
          pushEvent(
            "error",
            "Usage Error",
            "Usage: /events [all|shell|tool|approval|run|agent|system]",
            "red",
          );
          return true;
        }
        watchState.eventCategoryFilter = nextFilter;
        setTransientStatus(`event filter: ${nextFilter}`);
        pushEvent(
          "operator",
          "Event Filter",
          `Visible transcript category set to ${nextFilter}.`,
          "teal",
        );
        return true;
      }

      if (canonicalName === "/export") {
        exportCurrentView({ announce: true });
        return true;
      }

      if (canonicalName === "/bundle") {
        exportBundle({ announce: true });
        return true;
      }

      if (canonicalName === "/insights") {
        showInsights();
        return true;
      }

      if (canonicalName === "/maintenance") {
        if (shouldQueueOperatorInput()) {
          return maybeQueue("session bootstrap not complete");
        }
        watchState.maintenanceRequestPending = true;
        pushEvent(
          "operator",
          "Maintenance",
          "Refreshing maintenance status.",
          "teal",
        );
        send("maintenance.status", authPayload({ limit: 8 }));
        setTransientStatus("refreshing maintenance");
        return true;
      }

      if (canonicalName === "/agents") {
        const query = parsedSlash.args.join(" ").trim();
        const normalizedQuery = query.toLowerCase();
        const content =
          query.length === 0
            ? "/agents list"
            : normalizedQuery === "all"
              ? "/agents list --all"
              : /^list(\s|$)/i.test(query)
                ? `/agents ${query}`
                : /^(spawn|assign|inspect|stop|roles)(\s|$)/i.test(query)
                  ? `/agents ${query}`
                  : `/agents list ${query}`;
        return dispatchSessionCommand(content, {
          title: "Agents",
          body:
            query.length > 0
              ? `Requested agent topology view: ${query}`
              : "Requested agent topology view.",
        });
      }

      if (canonicalName === "/extensibility") {
        const action = buildExtensibilityCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.section === "hooks") {
          send("hooks.list", {});
          setTransientStatus("requesting hooks");
        }
        showExtensibility({ section: action.section });
        return true;
      }

      if (canonicalName === "/hooks") {
        send("hooks.list", {});
        setTransientStatus("requesting hooks");
        showExtensibility({ section: "hooks" });
        return true;
      }

      if (canonicalName === "/plugin") {
        const subcommand = parsedSlash.args.join(" ").trim();
        return dispatchSessionCommand(
          subcommand.length > 0 ? `/plugin ${subcommand}` : "/plugin list",
          {
            title: "Plugins",
            body:
              subcommand.length > 0
                ? `Requested plugin catalog action: ${subcommand}`
                : "Requested plugin catalog list.",
          },
        );
      }

      if (canonicalName === "/mcp") {
        const subcommand = parsedSlash.args.join(" ").trim();
        return dispatchSessionCommand(
          subcommand.length > 0 ? `/mcp ${subcommand}` : "/mcp status",
          {
            title: "MCP",
            body:
              subcommand.length > 0
                ? `Requested MCP command: ${subcommand}`
                : "Requested MCP server status.",
          },
        );
      }

      if (canonicalName === "/xai") {
        const action = buildXaiCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.mode === "status") {
          showXaiStatus();
        } else if (action.mode === "validate") {
          validateConfiguredXaiKey();
        } else if (action.mode === "clear") {
          clearXaiApiKey();
        } else {
          promptForXaiApiKey();
        }
        return true;
      }

      if (
        canonicalName === "/input-mode" ||
        canonicalName === "/keybindings" ||
        canonicalName === "/theme"
      ) {
        const action =
          canonicalName === "/input-mode"
            ? buildInputPreferenceCommand(parsedSlash, {
              commandName: canonicalName,
              usage: "/input-mode [show|default|vim]",
              defaultValue: "default",
              allowedValues: ["default", "vim", "insert", "normal"],
            })
            : canonicalName === "/keybindings"
              ? buildInputPreferenceCommand(parsedSlash, {
                commandName: canonicalName,
                usage: "/keybindings [show|default|vim]",
                defaultValue: "default",
                allowedValues: ["default", "vim"],
              })
              : buildInputPreferenceCommand(parsedSlash, {
                commandName: canonicalName,
                usage: "/theme [show|default|aurora|ember]",
                defaultValue: "default",
                allowedValues: ["default", "aurora", "ember"],
              });
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        if (action.mode === "show") {
          showInputModes();
          return true;
        }
        if (canonicalName === "/input-mode") {
          setInputModeProfile(action.value);
          if (action.composerMode) {
            watchState.composerMode = action.composerMode;
          }
          setTransientStatus(`input mode: ${watchState.inputPreferences.inputModeProfile}`);
        } else if (canonicalName === "/keybindings") {
          setKeybindingProfile(action.value);
          setTransientStatus(`keybindings: ${watchState.inputPreferences.keybindingProfile}`);
        } else {
          setThemeName(action.value);
          setTransientStatus(`theme: ${watchState.inputPreferences.themeName}`);
        }
        showInputModes();
        return true;
      }

      if (canonicalName === "/attach") {
        const inputPath = parsedSlash.args.join(" ").trim();
        if (!inputPath) {
          pushEvent("error", "Usage Error", "Usage: /attach <path>", "red");
          return true;
        }
        try {
          const result = queuePendingAttachment(inputPath);
          setTransientStatus(
            result.duplicate === true
              ? `attachment already queued: ${result.attachment.filename}`
              : `attachment queued: ${result.attachment.filename}`,
          );
          pushEvent(
            "operator",
            result.duplicate === true ? "Attachment Already Queued" : "Attachment Queued",
            formatPendingAttachmentsImpl(),
            result.duplicate === true ? "amber" : "teal",
          );
        } catch (error) {
          setTransientStatus("attachment error");
          pushEvent(
            "error",
            "Attachment Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/attachments") {
        const queued = listPendingAttachmentsImpl();
        setTransientStatus(
          queued.length > 0
            ? `${queued.length} attachment${queued.length === 1 ? "" : "s"} queued`
            : "no attachments queued",
        );
        pushEvent(
          "operator",
          "Queued Attachments",
          formatPendingAttachmentsImpl(),
          "slate",
        );
        return true;
      }

      if (canonicalName === "/unattach") {
        const reference = parsedSlash.args.join(" ").trim() || null;
        const result = removePendingAttachment(reference);
        if (result?.error) {
          setTransientStatus("attachment missing");
          pushEvent("error", "Attachment Error", result.error, "red");
          return true;
        }
        const removed = Array.isArray(result?.removed) ? result.removed : [];
        const remaining = listPendingAttachmentsImpl();
        setTransientStatus(
          remaining.length > 0
            ? `${remaining.length} attachment${remaining.length === 1 ? "" : "s"} queued`
            : "attachments cleared",
        );
        pushEvent(
          "operator",
          "Attachment Removed",
          removed.length > 0
            ? `${removed.length} attachment${removed.length === 1 ? "" : "s"} removed.\n\n${removed.map((attachment, index) => `${index + 1}. ${attachment.filename ?? attachment.id ?? "attachment"}`).join("\n")}`
            : "No attachments removed.",
          "teal",
        );
        return true;
      }

      // `/plan <free text>` shortcut: user types `/plan come up with a
      // plan for M1` expecting that single input to both flip the
      // session into plan mode AND submit the free-text portion as a
      // chat message. Without this shortcut the daemon sees "come" as
      // a subcommand token and replies with a usage error. When the
      // args aren't one of the known workflow subcommands, split the
      // input: dispatch bare `/plan` first (stage flip), then submit
      // the free text as a chat message. WebSocket ordering guarantees
      // the daemon processes `/plan` before the chat message, so the
      // very next turn runs with the plan-mode catalog filter.
      //
      // Placed OUTSIDE the `if (!canonicalName)` branch because `/plan`
      // is now present in the merged command catalog from the daemon
      // and resolves to `canonicalName === "/plan"`.
      if (canonicalName === "/plan") {
        const workflowSubcommands = new Set([
          "status",
          "enter",
          "exit",
          "implement",
          "review",
          "verify",
          "open",
        ]);
        const first = parsedSlash.args[0]?.toLowerCase() ?? "";
        if (parsedSlash.args.length > 0 && !workflowSubcommands.has(first)) {
          const freeText = parsedSlash.args.join(" ").trim();
          dispatchSessionCommand("/plan", {
            title: "Plan Mode",
            body: "Entering plan mode before submitting prompt.",
            allowBootstrapQueue: false,
          });
          return sendPreparedChatMessage(freeText, {
            title: "Prompt (plan mode)",
            body: freeText,
          });
        }
        return dispatchSessionCommand(parsedSlash.raw, {
          title: "Plan",
          body: `Forwarding ${parsedSlash.raw} to the daemon command bus.`,
        });
      }

      if (!canonicalName) {
        return dispatchSessionCommand(parsedSlash.raw, {
          title: "Command",
          body: `Forwarding ${parsedSlash.commandToken} to the daemon command bus.`,
        });
      }

      if (shouldQueueOperatorInput()) {
        return maybeQueue("session bootstrap not complete");
      }

      if (canonicalName === "/skills") {
        const subcommand = parsedSlash.args.join(" ").trim();
        return dispatchSessionCommand(
          subcommand.length > 0 ? `/skills ${subcommand}` : "/skills list",
          {
            title: "Skills",
            body:
              subcommand.length > 0
                ? `Requested local skill command: ${subcommand}`
                : "Requested local skill catalog.",
          },
        );
      }

      if (canonicalName === "/model") {
        const modelArg = (firstArg ?? "").trim();
        if (
          modelArg &&
          !/^(current|list)$/i.test(modelArg) &&
          typeof applyOptimisticModelSelection === "function"
        ) {
          applyOptimisticModelSelection(modelArg);
        }
        pushEvent(
          "operator",
          modelArg ? "Model Switch" : "Model Query",
          modelArg
            ? `Requested model switch to: ${modelArg}`
            : "Requested current model routing info.",
          "teal",
        );
        return dispatchSessionCommand(value, {
          title: modelArg ? "Model Switch" : "Model Query",
          body:
            modelArg
              ? `Requested model switch to: ${modelArg}`
              : "Requested current model routing info.",
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/init") {
        return dispatchSessionCommand(value, {
          title: "Project Guide Init",
          body: "Requested AGENC.md generation for the active workspace.",
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/voice") {
        if (voiceController) {
          const voiceArg = (firstArg ?? "").trim().toLowerCase();
          if (voiceArg === "stop" || voiceArg === "off") {
            voiceController.stopVoice();
          } else if (!voiceArg || voiceArg === "start" || voiceArg === "on") {
            voiceController.startVoice();
          } else if (voiceArg === "status") {
            pushEvent(
              "voice",
              "Voice Companion",
              typeof voiceController.formatStatusReport === "function"
                ? voiceController.formatStatusReport()
                : "Voice companion status unavailable.",
              "slate",
            );
            setTransientStatus("voice status ready");
          } else {
            // Voice persona change or config query — forward to daemon
            return dispatchSessionCommand(value, {
              title: "Voice",
              body: "Requested daemon-backed voice command.",
              allowBootstrapQueue: false,
            });
          }
        } else {
          // No voice controller — just forward to daemon for config display
          return dispatchSessionCommand(value, {
            title: "Voice",
            body: "Requested daemon-backed voice command.",
            allowBootstrapQueue: false,
          });
        }
        return true;
      }

      if (canonicalName === "/context") {
        return dispatchSessionCommand("/context", {
          title: "Context",
          body: "Requested context window usage.",
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/compact") {
        const action = buildCompactionCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        return dispatchSessionCommand(action.content, {
          title: action.title,
          body: action.body,
          allowBootstrapQueue: false,
        });
      }

      if (
        canonicalName === "/run-cancel" ||
        canonicalName === "/run-objective" ||
        canonicalName === "/run-constraints" ||
        canonicalName === "/run-budget" ||
        canonicalName === "/run-compact" ||
        canonicalName === "/run-worker" ||
        canonicalName === "/retry-run" ||
        canonicalName === "/retry-step" ||
        canonicalName === "/retry-trace" ||
        canonicalName === "/run-fork" ||
        canonicalName === "/verify-override"
      ) {
        if (!requireSession(canonicalName)) return true;
        const runAvailability = watchState.runDetail?.availability;
        if (runAvailability?.controlAvailable === false) {
          setTransientStatus("run control unavailable");
          pushEvent(
            "error",
            "Run Control Unavailable",
            runAvailability.disabledReason ??
              "Durable background run controls are not available for this runtime.",
            "red",
          );
          return true;
        }
        if (
          (canonicalName === "/retry-run" ||
            canonicalName === "/retry-step" ||
            canonicalName === "/retry-trace" ||
            canonicalName === "/run-fork") &&
          watchState.runDetail &&
          watchState.runDetail.checkpointAvailable === false
        ) {
          setTransientStatus("checkpoint unavailable");
          pushEvent(
            "error",
            "Checkpoint Unavailable",
            "The active durable run does not currently expose a retryable checkpoint.",
            "red",
          );
          return true;
        }
        const action =
          canonicalName === "/run-cancel"
            ? buildRunCancelCommand(parsedSlash, watchState.sessionId)
            : canonicalName === "/run-objective"
              ? buildRunObjectiveCommand(parsedSlash, watchState.sessionId)
              : canonicalName === "/run-constraints"
                ? buildRunConstraintsCommand(parsedSlash, watchState.sessionId)
                : canonicalName === "/run-budget"
                  ? buildRunBudgetCommand(parsedSlash, watchState.sessionId)
                  : canonicalName === "/run-compact"
                    ? buildRunCompactCommand(parsedSlash, watchState.sessionId)
                    : canonicalName === "/run-worker"
                      ? buildRunWorkerCommand(parsedSlash, watchState.sessionId)
                      : canonicalName === "/retry-run"
                        ? buildRetryRunCommand(parsedSlash, watchState.sessionId)
                        : canonicalName === "/retry-step"
                          ? buildRetryStepCommand(parsedSlash, watchState.sessionId)
                          : canonicalName === "/retry-trace"
                            ? buildRetryTraceCommand(parsedSlash, watchState.sessionId)
                            : canonicalName === "/run-fork"
                              ? buildRunForkCommand(parsedSlash, watchState.sessionId)
                        : buildVerificationOverrideCommand(parsedSlash, watchState.sessionId);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        watchState.runInspectPending = true;
        setTransientStatus(action.status);
        pushEvent("operator", action.title, action.body, "teal");
        send("run.control", action.payload);
        return true;
      }

      if (canonicalName === "/desktop") {
        const action = buildDesktopCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        return dispatchSessionCommand(action.content, {
          title: action.title,
          body: action.body,
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/market") {
        const action = buildMarketCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        pushEvent("operator", action.title, action.body, "teal");
        if (action.openBrowser) {
          openMarketTaskBrowser({
            title: action.title,
            kind: action.openBrowser.kind,
            statuses: action.openBrowser.statuses,
            query: action.openBrowser.query,
            activeOnly: action.openBrowser.activeOnly,
          });
        } else {
          dismissMarketTaskBrowser();
        }
        if (action.status) {
          setTransientStatus(action.status);
        }
        send(action.messageType, action.payload);
        return true;
      }

      if (canonicalName === "/permissions") {
        return dispatchSessionCommand(
          parsedSlash.args.length > 0
            ? `/permissions ${parsedSlash.args.join(" ")}`
            : "/permissions",
          {
            title: "Permissions",
            body:
              parsedSlash.args.length > 0
                ? `Requested permissions command: ${parsedSlash.args.join(" ")}.`
                : "Requested policy and approval state for the active runtime.",
            allowBootstrapQueue: false,
          },
        );
      }

      if (canonicalName === "/session") {
        const args = parsedSlash.args.map((arg) => String(arg ?? "").trim()).filter(Boolean);
        if ((args[0] ?? "").toLowerCase() === "list") {
          const query = args.slice(1).join(" ").trim();
          watchState.manualSessionsRequestPending = true;
          watchState.manualSessionsQuery = query.length > 0 ? query : null;
        }
        return dispatchSessionCommand(
          args.length > 0 ? `/session ${args.join(" ")}` : "/session status",
          {
            title: "Session",
            body:
              args.length > 0
                ? `Requested session command: ${args.join(" ")}.`
                : "Requested current session status.",
          },
        );
      }

      if (canonicalName === "/history") {
        const limit = Number(firstArg);
        return dispatchSessionCommand(
          Number.isFinite(limit) && limit > 0
            ? `/session history --limit ${Math.floor(limit)}`
            : "/session history",
          {
            title: "Session History",
            body:
              Number.isFinite(limit) && limit > 0
                ? `Requested recent session history (limit ${Math.floor(limit)}).`
                : "Requested recent session history.",
          },
        );
      }

      if (canonicalName === "/diff") {
        const content =
          parsedSlash.args.length > 0 ? `/diff ${parsedSlash.args.join(" ")}` : "/diff";
        return dispatchSessionCommand(content, {
          title: "Diff",
          body: parsedSlash.args.length > 0
            ? `Requested diff command: ${parsedSlash.args.join(" ")}.`
            : "Requested the canonical diff surface.",
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/approvals") {
        const action = buildApprovalsCommand(parsedSlash);
        if (action.error) {
          pushEvent("error", "Usage Error", action.error, "red");
          return true;
        }
        return dispatchSessionCommand(action.content, {
          title: action.title,
          body: action.body,
          allowBootstrapQueue: false,
        });
      }

      if (canonicalName === "/diff-view") {
        const action = buildDiffViewCommand(parsedSlash, {
          openLatestDiffDetail,
          currentDiffNavigationState,
          jumpCurrentDiffHunk,
          closeDetailView,
        });
        if (action.errorBody) {
          pushEvent(
            "error",
            action.errorTitle ?? "No Diff Available",
            action.errorBody,
            "red",
          );
          if (action.status) {
            setTransientStatus(action.status);
          }
          return true;
        }
        if (action.status) {
          setTransientStatus(action.status);
        }
        pushEvent("operator", action.title, action.body, "teal");
        return true;
      }

      if (canonicalName === "/checkpoint") {
        const label = parsedSlash.args.join(" ").trim();
        const summary = captureCheckpoint(label || null, { reason: "manual" });
        setTransientStatus(`checkpoint saved: ${summary.id}`);
        pushEvent(
          "checkpoint",
          "Checkpoint Saved",
          formatCheckpointSummary(summary),
          "blue",
        );
        return true;
      }

      if (canonicalName === "/checkpoints") {
        const limitArg = parsedSlash.args[0];
        const parsedLimit = Number(limitArg);
        if (limitArg && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
          pushEvent(
            "error",
            "Usage Error",
            "Usage: /checkpoints [limit]",
            "red",
          );
          return true;
        }
        const limit = limitArg ? Math.floor(parsedLimit) : 8;
        const summaries = listCheckpoints({ limit });
        setTransientStatus(
          summaries.length > 0
            ? `${summaries.length} checkpoint${summaries.length === 1 ? "" : "s"} listed`
            : "no checkpoints",
        );
        pushEvent(
          "checkpoint",
          "Checkpoint History",
          formatCheckpointList(summaries),
          "slate",
        );
        return true;
      }

      if (canonicalName === "/rewind") {
        const reference = parsedSlash.args.join(" ").trim() || "latest";
        const summary = rewindToCheckpoint(reference);
        if (!summary) {
          pushEvent(
            "error",
            "Checkpoint Not Found",
            `No checkpoint matched ${reference}.`,
            "red",
          );
          setTransientStatus("checkpoint missing");
          return true;
        }
        setTransientStatus(`rewound to ${summary.id}`);
        pushEvent(
          "checkpoint",
          "Checkpoint Rewind",
          formatCheckpointSummary(summary),
          "amber",
        );
        return true;
      }

      if (canonicalName === "/review") {
        return dispatchSessionCommand(
          parsedSlash.args.length > 0 ? `/review ${parsedSlash.args.join(" ")}` : "/review",
          {
            title: "Code Review",
            body: "Requested a findings-first review of the current changes.",
          },
        );
      }

      if (canonicalName === "/memory") {
        const args = parsedSlash.args.join(" ").trim();
        const content =
          args.length > 0 && !/^(search|stats|health|recent|forget|pin|export)(\s|$)/i.test(args)
            ? `/memory search ${args}`
            : args.length > 0
              ? `/memory ${args}`
              : "/memory recent";
        return dispatchSessionCommand(content, {
          title: "Memory",
          body:
            args.length > 0
              ? `Requested memory command: ${content.slice("/memory ".length)}.`
              : "Requested recent memory entries.",
        });
      }

      if (canonicalName === "/new") {
        const preResetCheckpoint = commandNames.has("/checkpoint")
          ? captureCheckpoint("Before new session", { reason: "new-session" })
          : null;
        const clearedAttachments = attachmentCommandsEnabled
          ? clearPendingAttachments()
          : [];
        resetLiveRunSurface();
        resetDelegationState();
        watchState.currentObjective = null;
        watchState.runDetail = null;
        watchState.runState = "idle";
        watchState.runPhase = null;
        watchState.bootstrapAttempts = 0;
        clearBootstrapTimer();
        pushEvent(
          "operator",
          "New Session",
          preResetCheckpoint
            ? `Requested a fresh chat session.\n\nSaved ${preResetCheckpoint.id} before reset.${clearedAttachments.length > 0 ? `\n\nCleared ${clearedAttachments.length} queued attachment${clearedAttachments.length === 1 ? "" : "s"}.` : ""}`
            : clearedAttachments.length > 0
              ? `Requested a fresh chat session.\n\nCleared ${clearedAttachments.length} queued attachment${clearedAttachments.length === 1 ? "" : "s"}.`
              : "Requested a fresh chat session.",
          "teal",
        );
        send("chat.new", authPayload());
        return true;
      }

      if (canonicalName === "/session-label") {
        if (!requireSession("/session-label")) return true;
        const rawArgs = parsedSlash.args.map((arg) => String(arg ?? "").trim()).filter(Boolean);
        const subcommand = (rawArgs[0] ?? "").toLowerCase();
        if (rawArgs.length === 0 || subcommand === "show") {
          const label = currentSessionLabel();
          setTransientStatus(label ? `session label: ${label}` : "session label not set");
          pushEvent(
            "session",
            "Session Label",
            label
              ? `Session ${watchState.sessionId}\nlocal label: ${label}`
              : `Session ${watchState.sessionId}\nNo local label set.`,
            "teal",
          );
          return true;
        }
        if (subcommand === "clear") {
          const cleared = clearSessionLabel();
          setTransientStatus(cleared ? "session label cleared" : "session label not set");
          pushEvent(
            "session",
            "Session Label Cleared",
            cleared
              ? `Cleared local label for ${watchState.sessionId}.\n\nPrevious label: ${cleared}`
              : `No local label was set for ${watchState.sessionId}.`,
            cleared ? "amber" : "slate",
          );
          return true;
        }
        const label = subcommand === "set"
          ? rawArgs.slice(1).join(" ").trim()
          : rawArgs.join(" ").trim();
        if (!label) {
          pushEvent(
            "error",
            "Usage Error",
            "Usage: /session-label [show|clear|<label>]",
            "red",
          );
          return true;
        }
        const result = setSessionLabel(label);
        setTransientStatus(
          result.changed
            ? `session label set: ${result.label}`
            : `session label unchanged: ${result.label}`,
        );
        pushEvent(
          "session",
          "Session Label Updated",
          result.previous && result.previous !== result.label
            ? `Session ${result.sessionId}\nlocal label: ${result.label}\nprevious: ${result.previous}`
            : `Session ${result.sessionId}\nlocal label: ${result.label}`,
          result.changed ? "teal" : "slate",
        );
        return true;
      }

      if (canonicalName === "/runs") {
        pushEvent("operator", "Run List", "Requested active runs for this session.", "teal");
        send("runs.list", watchState.sessionId ? { sessionId: watchState.sessionId } : {});
        return true;
      }

      if (canonicalName === "/inspect") {
        if (!requireSession("/inspect")) return true;
        watchState.runInspectPending = true;
        pushEvent("operator", "Run Inspect", `Inspecting run for ${watchState.sessionId}.`, "teal");
        send("run.inspect", { sessionId: watchState.sessionId });
        return true;
      }

      if (canonicalName === "/trace") {
        if (firstArg) {
          pushEvent("operator", "Trace Detail", `Inspecting trace ${firstArg}.`, "teal");
          send("observability.trace", { traceId: firstArg });
        } else {
          pushEvent("operator", "Trace Query", "Requested recent traces.", "teal");
          send(
            "observability.traces",
            watchState.sessionId ? { sessionId: watchState.sessionId, limit: 5 } : { limit: 5 },
          );
        }
        return true;
      }

      if (canonicalName === "/logs") {
        const lines = Number(firstArg);
        const lineCount = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 80;
        pushEvent("operator", "Log Query", `Requested recent daemon logs (${lineCount} lines).`, "teal");
        try {
          const logs = readWatchDaemonLogTail({ lines: lineCount });
          setTransientStatus("log bundle loaded");
          pushEvent("logs", "Daemon Logs", formatLogPayload(logs), "slate");
        } catch (error) {
          setTransientStatus("runtime error");
          pushEvent(
            "error",
            "Runtime Error",
            error instanceof Error ? error.message : String(error),
            "red",
          );
        }
        return true;
      }

      if (canonicalName === "/status") {
        return dispatchSessionCommand("/status", {
          title: "Gateway Status",
          body: "Requested daemon status.",
        });
      }

      if (canonicalName === "/cancel") {
        pushEvent("operator", "Cancel Chat", `Cancelling chat for ${currentClientKey()}.`, "teal");
        send("chat.cancel", authPayload());
        return true;
      }

      if (canonicalName === "/pause" || canonicalName === "/resume" || canonicalName === "/stop") {
        if (!requireSession(canonicalName)) return true;
        watchState.runInspectPending = true;
        const action = canonicalName.slice(1);
        const title = action[0].toUpperCase() + action.slice(1);
        const progressiveVerb =
          action === "pause"
            ? "Pausing"
            : action === "resume"
              ? "Resuming"
              : "Stopping";
        pushEvent("operator", `${title} Run`, `${progressiveVerb} run for ${watchState.sessionId}.`, "teal");
        send("run.control", {
          action,
          sessionId: watchState.sessionId,
          reason: `operator ${action}`,
        });
        return true;
      }
    }

    if (shouldQueueOperatorInput()) {
      return maybeQueue("session bootstrap not complete");
    }
    persistSessionId(watchState.sessionId);
    const previousObjective = watchState.currentObjective;
    const previousRunState = watchState.runState;
    const previousRunPhase = watchState.runPhase;
    const previousRunStartedAtMs = watchState.activeRunStartedAtMs;
    watchState.currentObjective = value;
    watchState.runState = "starting";
    watchState.runPhase = "queued";
    watchState.activeRunStartedAtMs = nowMs();
    resetDelegationState();
    const sent = sendPreparedChatMessage(value, {
      eventKind: "you",
      title: "Prompt",
      body: value,
      tone: "teal",
    });
    if (!sent) {
      watchState.currentObjective = previousObjective;
      watchState.runState = previousRunState;
      watchState.runPhase = previousRunPhase;
      watchState.activeRunStartedAtMs = previousRunStartedAtMs;
    }
    return true;
  }

  function flushQueuedOperatorInputs() {
    if (!isOpen() || bootstrapPending() || queuedOperatorInputs.length === 0) {
      return;
    }
    while (queuedOperatorInputs.length > 0) {
      const value = queuedOperatorInputs.shift();
      if (!value) {
        continue;
      }
      dispatchOperatorInput(value, { replayed: true });
    }
  }

  return {
    printHelp,
    queueOperatorInput,
    flushQueuedOperatorInputs,
    shouldQueueOperatorInput,
    dispatchOperatorInput,
  };
}
