import { describe, expect, it } from "vitest";

import { classifyMcpToolForCollapse } from "../../src/tools/MCPTool/classifyForCollapse.js";

describe("classifyMcpToolForCollapse", () => {
  it("classifies search tools after normalizing camelCase and kebab-case", () => {
    expect(classifyMcpToolForCollapse("slack", "slack_search_public")).toEqual({
      isSearch: true,
      isRead: false,
    });
    expect(
      classifyMcpToolForCollapse("atlassian", "searchJiraIssuesUsingJql"),
    ).toEqual({ isSearch: true, isRead: false });
    expect(
      classifyMcpToolForCollapse("atlassian", "search-jira-issues-using-jql"),
    ).toEqual({ isSearch: true, isRead: false });
  });

  it("classifies read tools and ignores the server display name", () => {
    expect(
      classifyMcpToolForCollapse("agenc_ai_Slack", "slack_read_channel"),
    ).toEqual({ isSearch: false, isRead: true });
    expect(classifyMcpToolForCollapse("github", "get_file_contents")).toEqual({
      isSearch: false,
      isRead: true,
    });
    expect(classifyMcpToolForCollapse("github", "getFileContents")).toEqual({
      isSearch: false,
      isRead: true,
    });
  });

  it("leaves mutating or unknown tools uncollapsed", () => {
    expect(classifyMcpToolForCollapse("slack", "send_message")).toEqual({
      isSearch: false,
      isRead: false,
    });
    expect(classifyMcpToolForCollapse("github", "create_issue")).toEqual({
      isSearch: false,
      isRead: false,
    });
    expect(classifyMcpToolForCollapse("custom", "do_the_thing")).toEqual({
      isSearch: false,
      isRead: false,
    });
  });
});
