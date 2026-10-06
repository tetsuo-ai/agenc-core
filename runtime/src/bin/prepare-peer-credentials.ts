/** Build/install preparation; the runtime loader remains the fallback. */
import path from "node:path";
import {
  buildAgenCBundledPeerCredentialBinding,
  loadAgenCNativePeerCredentialBinding,
} from "../app-server/transport/peer-credentials.js";

if (process.platform === "linux") {
  if (process.argv.includes("--build")) {
    const headersRoot = process.env.npm_config_nodedir;
    buildAgenCBundledPeerCredentialBinding({
      ...(process.env.CC === undefined ? {} : { compiler: process.env.CC }),
      ...(headersRoot === undefined
        ? {}
        : { nodeIncludeDir: path.join(headersRoot, "include", "node") }),
    });
  } else {
    const result = loadAgenCNativePeerCredentialBinding();
    if (result.binding === null) {
      throw new Error(result.error ?? "native peer credential preparation failed");
    }
  }
}
