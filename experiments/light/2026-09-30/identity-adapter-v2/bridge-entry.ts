// Parent-only canonical control bridge for exact selected 403da runtime/src.
// Root must resolve agenc-selected in the reviewed companion build. This file
// neither launches a daemon nor approves importing its transitive dependencies.
import {
  requestAgenCDaemonInstanceIdentity, requestAgenCDaemonShutdown,
  resolveAgenCDaemonHome,
} from 'agenc-selected/app-server/daemon-control.js';
import {
  readDaemonRuntimeInfo, daemonInstanceIdentityFromRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
} from 'agenc-selected/app-server/daemon-runtime-info.js';
import {
  readAgenCDaemonProcessStart, isAgenCDaemonInstanceIdentity,
  sameAgenCDaemonInstanceIdentity,
} from 'agenc-selected/app-server/daemon-instance-identity.js';
import { resolveAgenCDaemonRequestTimeoutMs } from 'agenc-selected/app-server/daemon-request-policy.js';
export { SOURCE_REVISION, SOURCE_PINS } from './pins.mjs';

// API projection unchanged from the reviewed v1 bridge. Actual reads and
// authenticated requests occur only when the owned parent invokes these APIs.
export const api = Object.freeze({
  readDaemonRuntimeInfo, daemonInstanceIdentityFromRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath, readAgenCDaemonProcessStart,
  isAgenCDaemonInstanceIdentity, sameAgenCDaemonInstanceIdentity,
  requestAgenCDaemonInstanceIdentity, requestAgenCDaemonShutdown,
  resolveAgenCDaemonHome, resolveAgenCDaemonRequestTimeoutMs,
});
