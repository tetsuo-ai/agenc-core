// Source compatibility, NOT deployment/build/containment approval.
// Exact 403da retains all 60 reviewed 44aed binding sources. The five Linux
// identity/control files also retain the reviewed ec45 implementations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedBytes } from './empty-resources.mjs';

// This module is explicitly ESM; keep the sibling pathname calculation here
// rather than depending on an external .ts fixture's package module kind.
export const observerSourcePath = fileURLToPath(new URL('../luna-observer-v6/direct.mjs', import.meta.url));

export const compatibility = Object.freeze({
  productRevision: '403da04398b55e51d1f4e8814f9a70957b0db5ef',
  layoutRevision: '44aed233a73dc8207ce66280b0ee374d1345e66e',
  bindingProfile: 'light-luna-44aed-source-base-v2',
  bindingInventorySha256: '3aae0ba39d020c40a2ade6980f1d2dc5426e50a081b552a9b048be2bfa735457',
  observerSha256: '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
  platform: 'linux',
});

// Extra CLI/ALS provenance is separate from the EXACT 60-key binding map.
// The parent must separately attest the entire companion/CLI dependency graph.
export const companionSources = Object.freeze({
  'src/bin/bootstrap.ts': '9747a3d07d434ded623d4737ec02adf98d51c669e4c2cf20aa1511f624a2eab8',
  'src/bin/bootstrap-services.ts': 'c029ce4928c13a169fc59e1cf791b2b7c6d76e77e5aa56ea8baf0fbf8634a82e',
  'src/app-server/background-agent-runner.ts': 'a86a1847884d375268d97712f8cf67b731d5a066218af1fdfd1526989c1d6b5d',
  'src/app-server/background-agent-runner/shared.ts': '1d9b652ea586e6762828a7c22a82cb4913e342e93c52a721e14d5595940a22c0',
  'src/app-server/daemon-cli.ts': 'ee7e1175e3d873011bf42b6f131c0b65090141b422d8726e35adcc4975de46a1',
  'src/bin/agenc-main.ts': '2c8c55e2b0664e54eea025a4bbb2af7f8666e29dfe3b168861283bf1e1d6493c',
  'src/session/current-session.ts': 'e5a32fc50ca4db0040eeca80584e7288b487661fd492dc2b828fa01b5adc412c',
  'src/app-server/daemon-control.ts': '78656e62de136277ca889243cc123df9b49f1b1f6f6f8c2d64a9822dcb646534',
  'src/app-server/daemon-runtime-info.ts': '805729ed01db043eb59b2f975fce4b0f31e52144021a6fb014b54d0f96a56b10',
  'src/app-server/daemon-instance-identity.ts': 'a0bbb94b2aad9d4bdb46f9fdb3620507d981629f1acaa9648d13a34f79a0652f',
  'src/app-server/daemon-request-policy.ts': '6b42a100bfd1867c0f100e524b6b9362d6143326e8c832a47c6c12d3983e1bca',
  'src/config/home.ts': '451624618b9bf31ea8a790d03796e1082fbbc6124e511969cc568a42054512c0',
});

export function verifyCompatibleSources(coreRuntimeRoot) {
  if (typeof coreRuntimeRoot !== 'string' || !path.isAbsolute(coreRuntimeRoot)) {
    throw new Error('cli_compatibility_root_missing');
  }
  const selected = JSON.parse(pinnedBytes(
    fileURLToPath(new URL('../current-base-binding-v2/source-pins.json', import.meta.url)),
    compatibility.bindingInventorySha256,
  ).toString('utf8'));
  if (Object.keys(selected).length !== 60) throw new Error('cli_binding_inventory_mismatch');
  for (const [relative, hash] of Object.entries({ ...selected, ...companionSources })) {
    pinnedBytes(path.join(coreRuntimeRoot, relative), hash);
  }
  return Object.freeze(Object.fromEntries(Object.entries(selected)
    .map(([relative, hash]) => ['runtime/' + relative, hash])));
}
