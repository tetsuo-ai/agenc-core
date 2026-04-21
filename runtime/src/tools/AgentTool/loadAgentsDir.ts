// @ts-nocheck
// Stub — feature-gated path; real implementation lives in openclaude upstream.
const __stubProxy: any = new Proxy(function __stub(..._args: any[]): any { return __stubProxy; }, {
  get(target, prop) {
    if (prop === 'then') return undefined;
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === Symbol.iterator) return function* () {};
    if (prop === Symbol.asyncIterator) return async function* () {};
    if (prop === 'length') return 0;
    if (prop === 'size') return 0;
    if (prop === 'cache') return new Map();
    return __stubProxy;
  },
  apply() { return __stubProxy; },
  construct() { return __stubProxy; },
  has() { return true; },
  set() { return true; },
});
export type AgentDefinition<_T = any> = any;
export const AgentDefinition: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type AgentDefinitionsResult<_T = any> = any;
export const AgentDefinitionsResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type AgentMcpServerSpec<_T = any> = any;
export const AgentMcpServerSpec: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type BaseAgentDefinition<_T = any> = any;
export const BaseAgentDefinition: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type BuiltInAgentDefinition<_T = any> = any;
export const BuiltInAgentDefinition: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type CustomAgentDefinition<_T = any> = any;
export const CustomAgentDefinition: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type PluginAgentDefinition<_T = any> = any;
export const PluginAgentDefinition: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearAgentDefinitionsCache<_T = any> = any;
export const clearAgentDefinitionsCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type filterAgentsByMcpRequirements<_T = any> = any;
export const filterAgentsByMcpRequirements: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getActiveAgentsFromList<_T = any> = any;
export const getActiveAgentsFromList: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getAgentDefinitionsWithOverrides<_T = any> = any;
export const getAgentDefinitionsWithOverrides: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasRequiredMcpServers<_T = any> = any;
export const hasRequiredMcpServers: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isBuiltInAgent<_T = any> = any;
export const isBuiltInAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isCustomAgent<_T = any> = any;
export const isCustomAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isPluginAgent<_T = any> = any;
export const isPluginAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type parseAgentFromJson<_T = any> = any;
export const parseAgentFromJson: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type parseAgentFromMarkdown<_T = any> = any;
export const parseAgentFromMarkdown: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type parseAgentsFromJson<_T = any> = any;
export const parseAgentsFromJson: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
