export type MarketplaceInspectSurfaceName =
  | "marketplace"
  | "tasks"
  | "skills"
  | "governance"
  | "disputes"
  | "reputation";

export interface MarketplaceInspectFilters {
  statuses?: string[];
  query?: string;
  tags?: string[];
  limit?: number;
  activeOnly?: boolean;
}

export interface MarketplaceInspectSurface {
  surface: MarketplaceInspectSurfaceName;
  title: string;
  noun: string;
  status: string;
  count: number;
  countLabel: string;
  subject: string | null;
  message: string | null;
  filters: MarketplaceInspectFilters;
  items: Array<Record<string, unknown>>;
}

export interface MarketplaceInspectOverview {
  surface: "marketplace";
  title: string;
  noun: string;
  status: string;
  count: number;
  countLabel: string;
  subject: string | null;
  message: null;
  filters: Record<string, never>;
  items: Array<{
    surface: MarketplaceInspectSurfaceName;
    title: string;
    noun: string;
    status: string;
    count: number;
    countLabel: string;
    message: string | null;
    filters: MarketplaceInspectFilters;
  }>;
  overview: Record<
    string,
    {
      title: string;
      noun: string;
      status: string;
      count: number;
      countLabel: string;
      message: string | null;
      filters: MarketplaceInspectFilters;
    }
  >;
  surfaces: MarketplaceInspectSurface[];
}

export const REPUTATION_INSPECT_PLACEHOLDER_MESSAGE: string;

export function resolveMarketplaceInspectSurface(
  value: unknown,
  fallback?: MarketplaceInspectSurfaceName | null,
): MarketplaceInspectSurfaceName | null;

export function marketInspectSurfaceTitle(surface?: unknown): string;
export function marketInspectSurfaceNoun(surface?: unknown): string;
export function marketInspectSurfaceCountLabel(surface: unknown, count?: number): string;

export function marketBrowserKind(
  value?: unknown,
): Exclude<MarketplaceInspectSurfaceName, "marketplace">;

export function marketTaskBrowserDefaultTitle(kind?: unknown): string;
export function marketTaskBrowserNoun(kind?: unknown): string;
export function marketTaskBrowserCountLabel(kind: unknown, count?: number): string;
export function marketTaskBrowserLoadingLabel(kind?: unknown): string;
export function marketTaskBrowserEmptyLabel(kind?: unknown): string;
export function marketTaskBrowserItemLabel(
  item: Record<string, unknown> | null | undefined,
  kind?: unknown,
): string;
export function marketTaskBrowserUsesStatuses(kind?: unknown): boolean;
export function marketTaskBrowserItemKey(
  item: Record<string, unknown> | null | undefined,
  fallbackIndex?: number,
  kind?: unknown,
): string;
export function formatMarketTaskBrowserTimestamp(value: unknown): string | null;
export function normalizeMarketTaskBrowserItems(
  items?: unknown,
  kind?: unknown,
): Array<Record<string, unknown>>;

export function buildMarketplaceInspectSurface(options?: {
  surface?: unknown;
  title?: string | null;
  status?: string | null;
  subject?: string | null;
  message?: string | null;
  items?: unknown;
  filters?: MarketplaceInspectFilters | null;
  count?: number | null;
}): MarketplaceInspectSurface;

export function buildMarketplaceReputationInspectPlaceholder(
  subject?: string | null,
): MarketplaceInspectSurface;

export function buildMarketplaceInspectOverview(options?: {
  surfaces?: Array<MarketplaceInspectSurface | Record<string, unknown>>;
  subject?: string | null;
  title?: string | null;
}): MarketplaceInspectOverview;
