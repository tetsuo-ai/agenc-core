import { describe, expect, it } from "vitest";
import {
  resolveProtocolTargetIdlPath,
  isProtocolWorkspaceAvailable,
} from "../../tests/protocol-workspace.ts";
import { readFileSync } from "node:fs";
import { createRuntimeTestContext } from "./litesvm-setup.js";

const describeIfProtocolWorkspace = isProtocolWorkspaceAvailable()
  ? describe
  : describe.skip;

describeIfProtocolWorkspace("runtime LiteSVM setup", () => {
  it("uses the local protocol target idl for the client program id", () => {
    const targetIdl = JSON.parse(
      readFileSync(resolveProtocolTargetIdlPath(), "utf8"),
    ) as { address: string };
    const ctx = createRuntimeTestContext();

    expect(ctx.program.programId.toBase58()).toBe(targetIdl.address);
    expect((ctx.program.idl as { address?: string }).address).toBe(
      targetIdl.address,
    );
  });
});
