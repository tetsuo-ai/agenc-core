export type ImplementationCompletionTaskClass =
  | "artifact_only"
  | "build_required"
  | "behavior_required"
  | "review_required"
  | "scaffold_allowed";

type PlaceholderTaxonomy =
  | "scaffold"
  | "implementation"
  | "documentation"
  | "repair";

export interface ImplementationCompletionContract {
  readonly taskClass: ImplementationCompletionTaskClass;
  readonly placeholdersAllowed: boolean;
  readonly partialCompletionAllowed: boolean;
  readonly placeholderTaxonomy?: PlaceholderTaxonomy;
}
