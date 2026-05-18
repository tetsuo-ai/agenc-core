import * as React from 'react';
import { Text } from '../ink.js';
import type { PermissionRuleValue } from '../../utils/permissions/PermissionRule'; // upstream-import: keep target is owned by another Z-PURGE item
type RuleSubtitleProps = {
  ruleValue: PermissionRuleValue;
};

const BASH_TOOL_NAME = "Bash";
const SKILL_TOOL_NAME = "Skill";
const WEB_FETCH_TOOL_NAME = "WebFetch";
const WEB_FETCH_DOMAIN_PREFIX = "domain:";

export function PermissionRuleDescription(t0: RuleSubtitleProps): React.ReactNode {
  const {
    ruleValue
  } = t0;
  switch (ruleValue.toolName) {
    case BASH_TOOL_NAME:
      {
        if (ruleValue.ruleContent) {
          if (ruleValue.ruleContent.endsWith(":*")) {
            const prefix = ruleValue.ruleContent.slice(0, -2);
            return <Text dimColor={true}>Any Bash command starting with{" "}<Text bold={true}>{prefix}</Text></Text>;
          } else {
            return <Text dimColor={true}>The Bash command <Text bold={true}>{ruleValue.ruleContent}</Text></Text>;
          }
        } else {
          return <Text dimColor={true}>Any Bash command</Text>;
        }
      }
    default:
      {
        if (!ruleValue.ruleContent) {
          return <Text dimColor={true}>Any use of the <Text bold={true}>{ruleValue.toolName}</Text> tool</Text>;
        }
        if (ruleValue.toolName === WEB_FETCH_TOOL_NAME && ruleValue.ruleContent.startsWith(WEB_FETCH_DOMAIN_PREFIX)) {
          const domain = ruleValue.ruleContent.slice(WEB_FETCH_DOMAIN_PREFIX.length);
          return <Text dimColor={true}>Any WebFetch request to <Text bold={true}>{domain}</Text></Text>;
        }
        if (ruleValue.toolName === SKILL_TOOL_NAME) {
          if (ruleValue.ruleContent.endsWith(":*")) {
            const prefix = ruleValue.ruleContent.slice(0, -2);
            return <Text dimColor={true}>Any Skill command starting with{" "}<Text bold={true}>{prefix}</Text></Text>;
          }
          return <Text dimColor={true}>The Skill command <Text bold={true}>{ruleValue.ruleContent}</Text></Text>;
        }
        return <Text dimColor={true}>The <Text bold={true}>{ruleValue.toolName}</Text> rule <Text bold={true}>{ruleValue.ruleContent}</Text></Text>;
      }
  }
}
