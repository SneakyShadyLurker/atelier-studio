import type { Database } from 'bun:sqlite';
import type { LibraryOverview } from '../../prompts/libraryOverview';

interface ListRow {
  id: string;
  name: string;
}

interface SampleRow {
  list_id: string;
  value: string;
  option_count: number;
}

export function libraryOverviewForUser(
  db: Database,
  userId: string,
  samplesPerList = 5,
): LibraryOverview {
  const lists = db
    .query<ListRow, [string]>(
      `SELECT id, name
         FROM variable_lists
        WHERE user_id = ?
        ORDER BY sort_order ASC, name ASC`,
    )
    .all(userId);

  if (lists.length === 0) return { lists: [] };

  const rows = db
    .query<SampleRow, [string, number]>(
      `WITH normalized AS (
         SELECT list_id,
                TRIM(value) AS value,
                LOWER(TRIM(value)) AS dedupe_key,
                sort_order,
                ROW_NUMBER() OVER (
                  PARTITION BY list_id, LOWER(TRIM(value))
                  ORDER BY sort_order ASC, value ASC
                ) AS duplicate_rn
           FROM variable_options
          WHERE user_id = ?
            AND TRIM(value) <> ''
       ),
       cleaned AS (
         SELECT list_id, value, sort_order AS first_sort
           FROM normalized
          WHERE duplicate_rn = 1
       ),
       ranked AS (
         SELECT list_id,
                value,
                COUNT(*) OVER (PARTITION BY list_id) AS option_count,
                ROW_NUMBER() OVER (PARTITION BY list_id ORDER BY first_sort ASC, value ASC) AS rn
           FROM cleaned
       )
       SELECT list_id, value, option_count
         FROM ranked
        WHERE rn <= ?
        ORDER BY list_id ASC, rn ASC`,
    )
    .all(userId, samplesPerList);

  const rowsByList = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const current = rowsByList.get(row.list_id);
    if (current) current.push(row);
    else rowsByList.set(row.list_id, [row]);
  }

  return {
    lists: lists.map((list) => {
      const samples = rowsByList.get(list.id) ?? [];
      return {
        name: list.name,
        optionCount: samples[0]?.option_count ?? 0,
        samples: samples.map((sample) => sample.value),
      };
    }),
  };
}
