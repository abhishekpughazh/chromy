/**
 * Shared pairing model used by both the annotation tool and gameplay.
 *
 * A "pair" is identified by a plain string ID: either one of the 24 standard
 * human chromosome types (1-22, X, Y) or a custom name typed by a
 * cytogeneticist for a particular sample. Each pair may have between 1 and 4
 * annotated chromosomes, all interchangeable - order/position no longer
 * carries any meaning.
 */

export const STANDARD_PAIR_IDS: string[] = Array.from({ length: 22 }, (_, i) => String(i + 1)).concat(['X', 'Y']);

/** Four-row clinical display order, with X and Y following chromosome 22. */
export const CLINICAL_KARYOTYPE_ROWS: { id: string; pairIds: string[] }[][] = [
  [
    { id: 'A', pairIds: ['1', '2', '3'] },
    { id: 'B', pairIds: ['4', '5'] },
  ],
  [{ id: 'C', pairIds: ['6', '7', '8', '9', '10', '11', '12'] }],
  [
    { id: 'D', pairIds: ['13', '14', '15'] },
    { id: 'E', pairIds: ['16', '17', '18'] },
  ],
  [
    { id: 'F', pairIds: ['19', '20'] },
    { id: 'G', pairIds: ['21', '22'] },
    { id: 'SEX', pairIds: ['X', 'Y'] },
  ],
];

/** Match-level row buttons. Clicking one highlights pending chromosomes from these groups. */
export const MATCH_ROW_HIGHLIGHTS: { id: string; label: string; groupIds: string[] }[] = [
  { id: 'AB', label: 'A–B', groupIds: ['A', 'B'] },
  { id: 'C', label: 'C', groupIds: ['C'] },
  { id: 'DE', label: 'D–E', groupIds: ['D', 'E'] },
  { id: 'FG', label: 'F–G', groupIds: ['F', 'G'] },
  { id: 'XY', label: 'X–Y', groupIds: ['SEX'] },
];

export function matchRowHighlightForGroup(groupId: string) {
  return MATCH_ROW_HIGHLIGHTS.find(row => row.groupIds.includes(groupId)) ?? null;
}

export function pairIdsForMatchRow(rowId: string): string[] {
  const row = MATCH_ROW_HIGHLIGHTS.find(item => item.id === rowId);
  if (!row) return [];
  const ids: string[] = [];
  for (const clinicalRow of CLINICAL_KARYOTYPE_ROWS) {
    for (const group of clinicalRow) {
      if (row.groupIds.includes(group.id)) ids.push(...group.pairIds);
    }
  }
  return ids;
}

export const MAX_CHROMOSOMES_PER_PAIR = 4;

const STANDARD_PAIR_ID_SET = new Set(STANDARD_PAIR_IDS);

export const isStandardPairId = (id: string) => STANDARD_PAIR_ID_SET.has(id);

/**
 * Recovers a pair ID from a stroke label.
 *
 * New-style labels are just the pair ID itself (e.g. "1", "X", "Marker A").
 * Legacy labels (saved before this change) used a trailing L/R suffix on the
 * 24 standard types only (e.g. "1L", "1R", "XL"). This strips that suffix so
 * old samples keep working without any data migration. Custom pair names
 * never existed under the old scheme, so there is no ambiguity: only labels
 * that are exactly `${standardId}L` or `${standardId}R` are treated as legacy.
 */
export function normalizePairId(label: string): string {
  if (!label) return label;
  if (label.length > 1 && (label.endsWith('L') || label.endsWith('R'))) {
    const base = label.slice(0, -1);
    if (isStandardPairId(base)) {
      return base;
    }
  }
  return label;
}

/** Sort order for the board/sidebar: standard pairs in canonical order, then custom pairs by first appearance. */
export function comparePairIds(a: string, b: string, customOrder: string[]): number {
  const aIdx = STANDARD_PAIR_IDS.indexOf(a);
  const bIdx = STANDARD_PAIR_IDS.indexOf(b);
  if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
  if (aIdx !== -1) return -1;
  if (bIdx !== -1) return 1;
  return customOrder.indexOf(a) - customOrder.indexOf(b);
}
