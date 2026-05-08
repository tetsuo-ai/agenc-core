/**
 * /mcp scenario.
 *
 * Reports MCP server status. /mcp is currently read-only (per GAP-MCP-03);
 * we just verify it doesn't crash and returns to idle.
 */
export const meta = {
  description: "/mcp prints MCP status and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/mcp");
  await session.waitForIdle({ timeout: 15_000 });
}
