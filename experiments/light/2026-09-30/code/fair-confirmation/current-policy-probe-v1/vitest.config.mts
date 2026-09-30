import { createAgenCVitestConfig } from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/vitest.config.ts";
const config = createAgenCVitestConfig();
export default { ...config, root: "/private/tmp/light-clean-recovery-CDlDMw/source/runtime",
  test: { ...config.test, setupFiles: ["/private/tmp/light-clean-recovery-CDlDMw/source/runtime/vitest.setup.ts"],
    include: ["/private/tmp/light-takeover/fair-confirmation/current-policy-probe-v1/probe.test.ts"] } };
