import { createAgenCVitestConfig } from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/vitest.config.ts";
const config=createAgenCVitestConfig();
export default {...config,root:"/private/tmp/light-clean-prepared-mHtxlR/source/runtime",test:{...config.test,setupFiles:["/private/tmp/light-clean-prepared-mHtxlR/source/runtime/vitest.setup.ts"],include:["/private/tmp/light-takeover/fair-confirmation/current-initial-preflight-v2/probe.test.ts"]}};
