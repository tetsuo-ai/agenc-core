/**
 * Pins the SDK's shared 16 MiB frame ceiling to the daemon socket / MCP
 * stdio limits so socket and subprocess transports cannot drift apart
 * silently (#2092).
 */

import { describe, expect, it } from "vitest";
import { AGENC_SDK_MAX_FRAME_BYTES } from "../../../packages/agenc-sdk/src/index";
import { AGENC_STDIO_DEFAULT_MAX_LINE_BYTES } from "../../src/app-server/transport/stdio";
import { AGENC_MCP_STDIO_MAX_FRAME_BYTES } from "../../src/mcp-client/transports/stdio";
import { AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES } from "../../src/mcp-server/stdio";

describe("SDK and daemon frame ceilings", () => {
  it("keeps the SDK socket/subprocess ceiling aligned with daemon and MCP stdio", () => {
    expect(AGENC_SDK_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(AGENC_SDK_MAX_FRAME_BYTES).toBe(AGENC_MCP_STDIO_MAX_FRAME_BYTES);
    expect(AGENC_SDK_MAX_FRAME_BYTES).toBe(AGENC_STDIO_DEFAULT_MAX_LINE_BYTES);
    expect(AGENC_SDK_MAX_FRAME_BYTES).toBe(
      AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES,
    );
  });
});
