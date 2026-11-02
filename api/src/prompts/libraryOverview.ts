export interface LibraryOverview {
  readonly lists: readonly {
    readonly name: string;
    readonly optionCount: number;
    readonly samples: readonly string[];
  }[];
}
