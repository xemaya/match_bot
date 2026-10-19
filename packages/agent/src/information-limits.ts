/** Shared by research, delivery and encrypted checkpoint validation. */
export const INFORMATION_LIMITS = {
  sources: 16,
  searchSourcesWithReader: 12,
  queries: 4,
  pageReads: 6,
} as const;
