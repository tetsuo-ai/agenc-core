import { c as _c } from "react-compiler-runtime";
import React, { useContext } from 'react';
import { ERROR_MESSAGE_USER_ABORT } from 'src/services/compact/compact.js';
import { isRateLimitErrorMessage } from '../../services/rateLimitMessages.js';
import { Box, Text } from '../ink.js';
import { API_ERROR_MESSAGE_PREFIX, API_TIMEOUT_ERROR_MESSAGE, CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE, CUSTOM_OFF_SWITCH_MESSAGE, INVALID_API_KEY_ERROR_MESSAGE, INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL, ORG_DISABLED_ERROR_MESSAGE_ENV_KEY, ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH, PROMPT_TOO_LONG_ERROR_MESSAGE, startsWithApiErrorPrefix, TOKEN_REVOKED_ERROR_MESSAGE } from '../../services/api/errors';
import { isEmptyMessageText, NO_RESPONSE_REQUESTED } from '../../utils/messages';
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck';
import { getDefaultMainLoopModel, renderModelName } from '../../utils/model/model';
import type { AgenCTextBlockParam } from '../../types/message.js';
import { isMacOsKeychainLocked } from '../../utils/secureStorage/macOsKeychainStorage';
import { CtrlOToExpand } from '../components/CtrlOToExpand';
import { InterruptedByUser } from '../components/InterruptedByUser';
import { RateLimitMessage } from '../components/dialogs/RateLimitMessage.js';
import { Markdown } from '../components/markdown/Markdown.js';
import { MessageResponse } from '../components/MessageResponse';
import { MessageActionsSelectedContext } from '../components/messageActions';
import { Msg } from '../components/v2/primitives.js';

const MAX_API_ERROR_CHARS = 1000;
type Props = {
  param: AgenCTextBlockParam;
  addMargin: boolean;
  shouldShowDot: boolean;
  verbose: boolean;
  width?: number | string;
  onOpenRateLimitOptions?: () => void;
};
function InvalidApiKeyMessage() {
  const $ = _c(2);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = isMacOsKeychainLocked();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const isKeychainLocked = t0;
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <MessageResponse><Box flexDirection="column"><Text color="error">{INVALID_API_KEY_ERROR_MESSAGE}</Text>{isKeychainLocked && <Text dimColor={true}>· Run in another terminal: security unlock-keychain</Text>}</Box></MessageResponse>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
export function AssistantTextMessage(t0) {
  const $ = _c(34);
  const {
    param: t1,
    addMargin,
    verbose,
    onOpenRateLimitOptions
  } = t0;
  const {
    text
  } = t1;
  const isSelected = useContext(MessageActionsSelectedContext);
  if (isEmptyMessageText(text)) {
    return null;
  }
  if (isRateLimitErrorMessage(text)) {
    let t2;
    if ($[0] !== onOpenRateLimitOptions || $[1] !== text) {
      t2 = <RateLimitMessage text={text} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
      $[0] = onOpenRateLimitOptions;
      $[1] = text;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    return t2;
  }
  switch (text) {
    case NO_RESPONSE_REQUESTED:
      {
        return null;
      }
    case PROMPT_TOO_LONG_ERROR_MESSAGE:
      {
        let t2;
        if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = getUpgradeMessage("warning");
          $[3] = t2;
        } else {
          t2 = $[3];
        }
        const upgradeHint = t2;
        let t3;
        if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <MessageResponse height={1}><Text color="error">Context limit reached · /compact or /clear to continue{upgradeHint ? ` · ${upgradeHint}` : ""}</Text></MessageResponse>;
          $[4] = t3;
        } else {
          t3 = $[4];
        }
        return t3;
      }
    case CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE:
      {
        let t2;
        if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">Credit balance too low · Add funds: https://agenc.tech/settings/billing</Text></MessageResponse>;
          $[5] = t2;
        } else {
          t2 = $[5];
        }
        return t2;
      }
    case INVALID_API_KEY_ERROR_MESSAGE:
      {
        let t2;
        if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <InvalidApiKeyMessage />;
          $[6] = t2;
        } else {
          t2 = $[6];
        }
        return t2;
      }
    case INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL:
      {
        let t2;
        if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL}</Text></MessageResponse>;
          $[7] = t2;
        } else {
          t2 = $[7];
        }
        return t2;
      }
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY:
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH:
      {
        let t2;
        if ($[8] !== text) {
          t2 = <MessageResponse><Text color="error">{text}</Text></MessageResponse>;
          $[8] = text;
          $[9] = t2;
        } else {
          t2 = $[9];
        }
        return t2;
      }
    case TOKEN_REVOKED_ERROR_MESSAGE:
      {
        let t2;
        if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{TOKEN_REVOKED_ERROR_MESSAGE}</Text></MessageResponse>;
          $[10] = t2;
        } else {
          t2 = $[10];
        }
        return t2;
      }
    case API_TIMEOUT_ERROR_MESSAGE:
      {
        let t2;
        if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{API_TIMEOUT_ERROR_MESSAGE}{process.env.API_TIMEOUT_MS && <>{" "}(API_TIMEOUT_MS={process.env.API_TIMEOUT_MS}ms, try increasing it)</>}</Text></MessageResponse>;
          $[11] = t2;
        } else {
          t2 = $[11];
        }
        return t2;
      }
    case CUSTOM_OFF_SWITCH_MESSAGE:
      {
        let t2;
        if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <Text color="error">We are experiencing high demand for the selected model.</Text>;
          $[12] = t2;
        } else {
          t2 = $[12];
        }
        let t3;
        if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <MessageResponse><Box flexDirection="column" gap={1}>{t2}<Text>To continue immediately, use /model to switch to{" "}{renderModelName(getDefaultMainLoopModel())}.</Text></Box></MessageResponse>;
          $[13] = t3;
        } else {
          t3 = $[13];
        }
        return t3;
      }
    case ERROR_MESSAGE_USER_ABORT:
      {
        let t2;
        if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
          $[14] = t2;
        } else {
          t2 = $[14];
        }
        return t2;
      }
    default:
      {
        if (startsWithApiErrorPrefix(text)) {
          const truncated = !verbose && text.length > MAX_API_ERROR_CHARS;
          const t2 = text === API_ERROR_MESSAGE_PREFIX ? `${API_ERROR_MESSAGE_PREFIX}: Please wait a moment and try again.` : truncated ? text.slice(0, MAX_API_ERROR_CHARS) + "\u2026" : text;
          let t3;
          if ($[15] !== t2) {
            t3 = <Text color="error">{t2}</Text>;
            $[15] = t2;
            $[16] = t3;
          } else {
            t3 = $[16];
          }
          let t4;
          if ($[17] !== truncated) {
            t4 = truncated && <CtrlOToExpand />;
            $[17] = truncated;
            $[18] = t4;
          } else {
            t4 = $[18];
          }
          let t5;
          if ($[19] !== t3 || $[20] !== t4) {
            t5 = <MessageResponse><Box flexDirection="column">{t3}{t4}</Box></MessageResponse>;
            $[19] = t3;
            $[20] = t4;
            $[21] = t5;
          } else {
            t5 = $[21];
          }
          return t5;
        }
        const t2 = addMargin ? 1 : 0;
        const t3 = isSelected ? "messageActionsBackground" : undefined;
        let t4;
        if ($[22] !== text) {
          t4 = <Markdown>{text}</Markdown>;
          $[22] = text;
          $[23] = t4;
        } else {
          t4 = $[23];
        }
        let t5;
        if ($[24] !== t4) {
          t5 = <Msg role="agenc" label="agenc">{t4}</Msg>;
          $[24] = t4;
          $[25] = t5;
        } else {
          t5 = $[25];
        }
        let t6;
        if ($[26] !== t2 || $[27] !== t3 || $[28] !== t5) {
          t6 = <Box flexDirection="column" marginTop={t2} width="100%" backgroundColor={t3}>{t5}</Box>;
          $[26] = t2;
          $[27] = t3;
          $[28] = t5;
          $[29] = t6;
        } else {
          t6 = $[29];
        }
        return t6;
      }
  }
}
