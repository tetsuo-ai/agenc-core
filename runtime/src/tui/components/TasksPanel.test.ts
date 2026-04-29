import { describe, expect, it } from "vitest";

import { formatTaskOwnerLabel } from "./TasksPanel.js";
import type { LiveAgentStatus } from "../transcript/messages/CoordinatorAgentStatus.js";

describe("TasksPanel", () => {
  it("formats owners with cyberpunk role labels and agent nicknames", () => {
    expect(formatTaskOwnerLabel("scanner")).toBe("Scanner");

    const agent: LiveAgentStatus = {
      threadId: "thread-1",
      role: "worker",
      nickname: "Snowcrash",
      status: "running",
    };

    expect(formatTaskOwnerLabel("thread-1", agent)).toBe("Snowcrash");
  });
});
