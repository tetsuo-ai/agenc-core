import { captureExecutionPermissionAuthority, taskPathWithin as within } from '../../execution/permission-authority.js'
import { posix } from 'node:path'
import { resolveExecutionPermissionPath } from '../../execution/permission-path.js'
import type { ExecutionWorkspace } from '../../execution/workspace.js'
import type { ToolPermissionContext } from '../../tools/Tool.js'
import { checkPathSafetyForAutoEdit, matchingRuleForInput, type PermissionPathRuleContext } from './filesystem.js'
import type { PermissionDecision } from './PermissionResult.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'
import type { PermissionUpdate } from './PermissionUpdateSchema.js'

/** Selected-task permissions never consult controller path metadata or internal-path exemptions. */
export async function checkExecutionFilePermission(
  path: string,
  input: { [key: string]: unknown },
  context: ToolPermissionContext,
  operation: 'read' | 'edit',
  workspace: ExecutionWorkspace,
): Promise<PermissionDecision> {
  const authority = captureExecutionPermissionAuthority(workspace)
  const cwd = authority.roleCwd
  const rules: PermissionPathRuleContext = { cwd, projectRoot: workspace.projectRoot, homePath: workspace.homePath }
  const evidence = await resolveExecutionPermissionPath(workspace.environment, path, rules)
  const match = (type: 'read' | 'edit', behavior: 'allow' | 'deny' | 'ask', selectedContext = context) => {
    for (const form of evidence.paths) {
      const rule = matchingRuleForInput(form, selectedContext, type, behavior, rules)
      if (rule) return rule
    }
    return null
  }
  const allow = (reason: PermissionDecision['decisionReason'] = { type: 'mode', mode: 'default' }): PermissionDecision => ({
    behavior: 'allow', updatedInput: input, decisionReason: reason,
  })
  const ruleDecision = (type: 'read' | 'edit', behavior: 'deny' | 'ask'): PermissionDecision | null => {
    const rule = match(type, behavior)
    return rule ? { behavior, message: `Permission to ${type} ${evidence.path} requires the configured ${behavior} rule.`,
      decisionReason: { type: 'rule', rule } } : null
  }
  const memoryDecision = (): PermissionDecision | null => {
    const access = authority.memoryAccess(evidence)
    if (access === 'unscoped') return null
    if (access === 'allow') return allow()
    const message = 'Agent memory access requires the exact authorized workspace role and a private regular task file.'
    return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, classifierApprovable: false } }
  }
  let working: Promise<boolean> | undefined
  const inWorkingDirectory = (): Promise<boolean> => working ??= (async () => {
    const directories = new Set([cwd, ...context.additionalWorkingDirectories.keys()])
    const roots = await Promise.all([...directories].map(root => resolveExecutionPermissionPath(workspace.environment, root, rules)))
    return evidence.paths.every(form => roots.some(root => root.paths.some(prefix => within(form, prefix))))
  })()
  const suggestions = async (type: 'read' | 'edit'): Promise<PermissionUpdate[]> => {
    const outside = !await inWorkingDirectory()
    const directories = [...new Set(evidence.paths.map(form => posix.dirname(form)))]
    if (type === 'read' && outside) {
      return directories.map(dir => createReadRuleSuggestion(dir, 'session')).filter((value): value is PermissionUpdate => value !== undefined)
    }
    const result: PermissionUpdate[] = context.mode === 'default' || context.mode === 'plan'
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] : []
    if (type === 'edit' && outside) result.push({ type: 'addDirectories', directories, destination: 'session' })
    return result
  }
  const write = async (): Promise<PermissionDecision> => {
    const deny = ruleDecision('edit', 'deny')
    if (deny) return deny
    const memory = memoryDecision()
    if (memory) return memory
    const sessionRule = match('edit', 'allow', { ...context, alwaysAllowRules: { session: context.alwaysAllowRules.session ?? [] } })
    const pattern = sessionRule?.ruleValue.ruleContent
    if (sessionRule && pattern && (pattern.startsWith('/.agenc/') || pattern.startsWith('~/.agenc/')) &&
        !pattern.includes('..') && pattern.endsWith('/**')) return allow({ type: 'rule', rule: sessionRule })
    const safety = checkPathSafetyForAutoEdit(evidence.path, evidence.paths)
    if (!safety.safe) return { behavior: 'ask', message: safety.message, suggestions: await suggestions('edit'),
      decisionReason: { type: 'safetyCheck', reason: safety.message, classifierApprovable: safety.classifierApprovable } }
    const ask = ruleDecision('edit', 'ask')
    if (ask) return ask
    const inWorking = await inWorkingDirectory()
    if (context.mode === 'acceptEdits' && inWorking) return allow({ type: 'mode', mode: 'acceptEdits' })
    const rule = match('edit', 'allow')
    if (rule) return allow({ type: 'rule', rule })
    return { behavior: 'ask', message: `Permission to edit ${evidence.path} has not been granted.`,
      suggestions: await suggestions('edit'),
      ...(!inWorking ? { decisionReason: { type: 'workingDir' as const, reason: 'Path is outside allowed working directories' } } : {}) }
  }
  const read = async (): Promise<PermissionDecision> => {
    const deny = ruleDecision('read', 'deny')
    if (deny) return deny
    const memory = memoryDecision()
    if (memory?.decisionReason?.type === 'safetyCheck') return memory
    const ask = ruleDecision('read', 'ask')
    if (ask) return ask
    if (memory) return memory
    const editable = await write()
    if (editable.behavior === 'allow') return editable
    if (await inWorkingDirectory()) return allow()
    const rule = match('read', 'allow')
    if (rule) return allow({ type: 'rule', rule })
    return { behavior: 'ask', message: `Permission to read ${evidence.path} has not been granted.`,
      suggestions: await suggestions('read'), decisionReason: { type: 'workingDir', reason: 'Path is outside allowed working directories' } }
  }
  const decision = await (operation === 'read' ? read() : write())
  authority.assertCurrent()
  return decision
}
