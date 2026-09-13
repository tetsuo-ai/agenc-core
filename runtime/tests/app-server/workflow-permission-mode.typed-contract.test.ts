import { expectTypeOf, it } from "vitest";
import type { RunEffectivePermissionMode } from "../../src/app-server/protocol/index.js";
import type { InternalPermissionMode } from "../../src/types/permissions.js";

// Included in tsconfig.test-support.json so the ordinary support typecheck enforces this.
it("keeps the pure SDK wire union equal to every runtime permission mode", () => {
  expectTypeOf<RunEffectivePermissionMode>().toEqualTypeOf<InternalPermissionMode>();
});
