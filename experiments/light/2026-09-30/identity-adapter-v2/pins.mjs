export const SOURCE_REVISION = '403da04398b55e51d1f4e8814f9a70957b0db5ef';
export const SOURCE_PINS = Object.freeze({
  'runtime/src/app-server/daemon-control.ts': '78656e62de136277ca889243cc123df9b49f1b1f6f6f8c2d64a9822dcb646534',
  'runtime/src/app-server/daemon-runtime-info.ts': '805729ed01db043eb59b2f975fce4b0f31e52144021a6fb014b54d0f96a56b10',
  'runtime/src/app-server/daemon-instance-identity.ts': 'a0bbb94b2aad9d4bdb46f9fdb3620507d981629f1acaa9648d13a34f79a0652f',
  'runtime/src/app-server/daemon-request-policy.ts': '6b42a100bfd1867c0f100e524b6b9362d6143326e8c832a47c6c12d3983e1bca',
  'runtime/src/config/home.ts': '451624618b9bf31ea8a790d03796e1082fbbc6124e511969cc568a42054512c0',
});
export const API_NAMES = Object.freeze([
  'readDaemonRuntimeInfo', 'daemonInstanceIdentityFromRuntimeInfo',
  'resolveAgenCDaemonRuntimeInfoPath', 'readAgenCDaemonProcessStart',
  'isAgenCDaemonInstanceIdentity', 'sameAgenCDaemonInstanceIdentity',
  'requestAgenCDaemonInstanceIdentity', 'requestAgenCDaemonShutdown',
  'resolveAgenCDaemonHome', 'resolveAgenCDaemonRequestTimeoutMs',
]);
