export function occurrenceKeyOf(listName: string, subject: number | null, index: number): string {
  const base = subject === null ? listName : `${listName}@${subject}`;
  return `${base}#${index}`;
}
