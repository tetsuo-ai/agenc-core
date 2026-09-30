// Root builds this separate companion only. The agenc-reviewed alias MUST
// resolve to the selected ec45a1e49 runtime/src; never to an installed package.
import {
  requestAgenCDaemonInstanceIdentity, requestAgenCDaemonShutdown,
  resolveAgenCDaemonHome,
} from 'agenc-reviewed/app-server/daemon-control';
import {
  readDaemonRuntimeInfo, daemonInstanceIdentityFromRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
} from 'agenc-reviewed/app-server/daemon-runtime-info';
import {
  readAgenCDaemonProcessStart, isAgenCDaemonInstanceIdentity,
  sameAgenCDaemonInstanceIdentity,
} from 'agenc-reviewed/app-server/daemon-instance-identity';
import { resolveAgenCDaemonRequestTimeoutMs } from 'agenc-reviewed/app-server/daemon-request-policy';
export { SOURCE_REVISION, SOURCE_PINS } from './pins.mjs';

// No host creation, network, identity read, or CLI entrypoint runs at this seam.
// Transitive initialization still belongs in root's reviewed bundle closure.
export const api = Object.freeze({
  readDaemonRuntimeInfo, daemonInstanceIdentityFromRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath, readAgenCDaemonProcessStart,
  isAgenCDaemonInstanceIdentity, sameAgenCDaemonInstanceIdentity,
  requestAgenCDaemonInstanceIdentity, requestAgenCDaemonShutdown,
  resolveAgenCDaemonHome, resolveAgenCDaemonRequestTimeoutMs,
});
