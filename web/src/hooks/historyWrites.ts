// Native TanStack mutation identity shared by all writes that can change the
// paginated history projection. Streaming generation deliberately stays out.
export const HISTORY_WRITE_MUTATION_KEY = ['history-write'] as const;
