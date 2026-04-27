/**
 * AgenC scoped instruction-rule exports.
 *
 * @module
 */

export {
  DEFAULT_MANAGED_RULES_DIR,
  MAX_RULE_BYTES,
  MAX_RULE_DEPTH,
  MAX_RULE_FILES,
  RULES_DIRNAME,
  RULES_SUBDIR,
  discoverInstructionRules,
  discoverManagedAndUserConditionalRules,
  formatRulesBlock,
  parseRuleFile,
  projectRulesDir,
  ruleMatchesTarget,
  userRulesDir,
  type DiscoverRulesOptions,
  type InstructionRule,
  type InstructionRuleFrontmatter,
  type InstructionRuleType,
} from "./discovery.js";

