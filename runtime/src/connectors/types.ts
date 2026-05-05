export interface AppBranding {
  readonly category?: string;
  readonly developer?: string;
  readonly website?: string;
  readonly privacyPolicy?: string;
  readonly termsOfService?: string;
  readonly isDiscoverableApp?: boolean;
}

export interface AppReview {
  readonly status: string;
}

export interface AppScreenshot {
  readonly url?: string;
  readonly fileId?: string;
  readonly userPrompt: string;
}

export interface AppMetadata {
  readonly review?: AppReview;
  readonly categories?: readonly string[];
  readonly subCategories?: readonly string[];
  readonly seoDescription?: string;
  readonly screenshots?: readonly AppScreenshot[];
  readonly developer?: string;
  readonly version?: string;
  readonly versionId?: string;
  readonly versionNotes?: string;
  readonly firstPartyType?: string;
  readonly firstPartyRequiresInstall?: boolean;
  readonly showInComposerWhenUnlinked?: boolean;
}

export interface AppInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly logoUrl?: string;
  readonly logoUrlDark?: string;
  readonly distributionChannel?: string;
  readonly branding?: AppBranding;
  readonly appMetadata?: AppMetadata;
  readonly labels?: Readonly<Record<string, string>>;
  readonly installUrl?: string;
  readonly isAccessible: boolean;
  readonly isEnabled: boolean;
  readonly pluginDisplayNames: readonly string[];
}

export interface AccessibleConnectorTool {
  readonly connectorId: string;
  readonly connectorName?: string;
  readonly connectorDescription?: string;
  readonly pluginDisplayNames?: readonly string[];
}

export interface ConnectorToolInfo extends AccessibleConnectorTool {
  readonly serverName: string;
}

export type AppToolApproval = "auto" | "prompt" | "approve";

export interface AppToolPolicy {
  readonly enabled: boolean;
  readonly approval: AppToolApproval;
}

export interface ToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface AppToolConfig {
  readonly enabled?: boolean;
  readonly approvalMode?: AppToolApproval;
  readonly approval_mode?: AppToolApproval;
}

export interface AppToolsConfig {
  readonly tools?: Readonly<Record<string, AppToolConfig>>;
}

export interface AppConfig {
  readonly enabled?: boolean;
  readonly destructiveEnabled?: boolean;
  readonly destructive_enabled?: boolean;
  readonly openWorldEnabled?: boolean;
  readonly open_world_enabled?: boolean;
  readonly defaultToolsApprovalMode?: AppToolApproval;
  readonly default_tools_approval_mode?: AppToolApproval;
  readonly defaultToolsEnabled?: boolean;
  readonly default_tools_enabled?: boolean;
  readonly tools?: AppToolsConfig;
}

export interface AppsDefaultConfig {
  readonly enabled?: boolean;
  readonly destructiveEnabled?: boolean;
  readonly destructive_enabled?: boolean;
  readonly openWorldEnabled?: boolean;
  readonly open_world_enabled?: boolean;
}

export interface AppsConfig {
  readonly default?: AppsDefaultConfig;
  readonly apps?: Readonly<Record<string, AppConfig>>;
}

export interface AppRequirement {
  readonly enabled?: boolean;
}

export interface AppsRequirementsConfig {
  readonly apps?: Readonly<Record<string, AppRequirement>>;
}
