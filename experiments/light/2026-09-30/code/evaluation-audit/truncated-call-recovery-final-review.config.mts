import { createAgenCVitestConfig } from "/private/tmp/light-takeover/startup-core/runtime/vitest.config.ts";
const config = createAgenCVitestConfig();
export default { ...config, root: "/private/tmp/light-takeover/startup-core/runtime",
  test: { ...config.test, setupFiles: ["/private/tmp/light-takeover/startup-core/runtime/vitest.setup.ts"],
    include: [
      "/private/tmp/light-takeover/evaluation-audit/truncated-call-recovery-review-v2.test.ts",
      "/private/tmp/light-takeover/evaluation-audit/truncated-call-identity-final-review.test.ts",
      "/private/tmp/light-takeover/evaluation-audit/responses-terminal-review.test.ts",
    ] } };
