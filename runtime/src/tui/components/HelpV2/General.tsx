import { c as _c } from "react-compiler-runtime";
import type { ProviderAuthReadContext } from '../../../utils/auth.js';
import { Box, Text } from '../../ink.js';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';
export function General({ remoteAuthSessionContext }: { remoteAuthSessionContext: ProviderAuthReadContext }) {
  const $ = _c(2);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <Box><Text>AgenC understands your codebase, makes edits with your permission, and executes commands — right from your terminal.</Text></Box>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const t1 = <Box flexDirection="column" paddingY={1} gap={1}>{t0}<Box flexDirection="column"><Box><Text bold={true}>Shortcuts</Text></Box><PromptInputHelpMenu gap={2} fixedWidth={true} remoteAuthSessionContext={remoteAuthSessionContext} /></Box></Box>;
  return t1;
}
