/** A loaded documentation entry */
export interface DocEntry {
  /** Repository-relative path (e.g. "docs/architecture/overview.md") */
  path: string;
  /** Document title (first # heading or filename) */
  title: string;
  /** Raw markdown content */
  content: string;
  /** Document category */
  category: 'architecture' | 'flow' | 'guide' | 'runbook' | 'baseline' | 'artifact' | 'repo-meta' | 'other';
}

/** A search result with relevance score */
export interface SearchResult {
  /** Document path */
  path: string;
  /** Document title */
  title: string;
  /** Relevance score (0-1) */
  score: number;
  /** Context snippet around the match */
  snippet: string;
}
