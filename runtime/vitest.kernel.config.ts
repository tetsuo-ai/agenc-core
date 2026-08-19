import { createAgenCVitestConfig } from "./vitest.config.ts";

// Exact real-kernel sandbox allowlist for the disposable hosted Linux lane.
// Tests fail closed unless the runner exposes their required Landlock,
// seccomp, user/PID/mount/network namespace, and AppArmor capabilities.
export default createAgenCVitestConfig("kernel");
