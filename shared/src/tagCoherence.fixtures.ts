export interface TagCoherenceParityFixture {
  readonly name: string;
  readonly a: { readonly require: readonly string[]; readonly exclude: readonly string[] };
  readonly b: { readonly require: readonly string[]; readonly exclude: readonly string[] };
  readonly expectedConflict: boolean;
}

// Shared by the API and web resolver suites. Each side expands tag hierarchies
// its own way before the shared tagCoherence predicate, so both pipelines are
// pinned to the same polarity and hierarchy truth table.
export const TAG_COHERENCE_PARITY_FIXTURES: readonly TagCoherenceParityFixture[] = [
  {
    name: 'matching require tags are compatible',
    a: { require: ['witcher'], exclude: [] },
    b: { require: ['witcher'], exclude: [] },
    expectedConflict: false,
  },
  {
    name: 'disjoint require tags conflict',
    a: { require: ['witcher'], exclude: [] },
    b: { require: ['trek'], exclude: [] },
    expectedConflict: true,
  },
  {
    name: 'exclude blocks a matching require tag',
    a: { require: [], exclude: ['trek'] },
    b: { require: ['trek'], exclude: [] },
    expectedConflict: true,
  },
  {
    name: 'parent exclude blocks a required child through ancestor expansion',
    a: { require: [], exclude: ['witcher'] },
    b: { require: ['witcher-games'], exclude: [] },
    expectedConflict: true,
  },
  {
    name: 'child exclude blocks a required parent through exclude ancestor expansion',
    a: { require: [], exclude: ['witcher-games'] },
    b: { require: ['witcher'], exclude: [] },
    expectedConflict: true,
  },
  {
    name: 'required parent matches a required child through ancestor expansion',
    a: { require: ['witcher'], exclude: [] },
    b: { require: ['witcher-games'], exclude: [] },
    expectedConflict: false,
  },
  {
    name: 'exclude-only option abstains from the positive rule',
    a: { require: [], exclude: ['trek'] },
    b: { require: ['witcher-games'], exclude: [] },
    expectedConflict: false,
  },
  {
    name: 'two exclude-only options abstain from the positive rule',
    a: { require: [], exclude: ['trek'] },
    b: { require: [], exclude: ['witcher'] },
    expectedConflict: false,
  },
  {
    name: 'matching exclude tags do not conflict with each other',
    a: { require: [], exclude: ['trek'] },
    b: { require: [], exclude: ['trek'] },
    expectedConflict: false,
  },
  {
    name: 'multi-require sets with a partial overlap are compatible',
    a: { require: ['witcher', 'trek'], exclude: [] },
    b: { require: ['trek', 'dune'], exclude: [] },
    expectedConflict: false,
  },
  {
    name: 'multi-require sets with no overlap conflict',
    a: { require: ['witcher', 'witcher-games'], exclude: [] },
    b: { require: ['trek'], exclude: [] },
    expectedConflict: true,
  },
];
