import type { GatewayConfig } from "../gateway/types.js";
import type { WorkspaceFileName } from "../gateway/workspace-files.js";

type OnboardingVerbosity = "tight" | "balanced" | "detailed";
type OnboardingAutonomy = "conservative" | "balanced" | "aggressive";
type OnboardingToolPosture = "guarded" | "balanced" | "broad";

export interface OnboardingAnswers {
  readonly apiKey: string;
  readonly model: string;
  readonly agentName: string;
  readonly mission: string;
  readonly role: string;
  readonly alwaysDoRules: readonly string[];
  readonly soulTraits: readonly string[];
  readonly tone: string;
  readonly verbosity: OnboardingVerbosity;
  readonly autonomy: OnboardingAutonomy;
  readonly toolPosture: OnboardingToolPosture;
  readonly memorySeeds: readonly string[];
  readonly desktopAutomationEnabled: boolean;
  readonly walletPath: string | null;
  readonly rpcUrl: string;
  readonly marketplaceEnabled: boolean;
  readonly socialEnabled: boolean;
}

export interface GeneratedOnboardingProfile {
  readonly config: GatewayConfig;
  readonly workspaceFiles: Record<WorkspaceFileName, string>;
}

export interface XaiValidationResult {
  readonly ok: boolean;
  readonly message: string;
  readonly availableModels: readonly string[];
}

