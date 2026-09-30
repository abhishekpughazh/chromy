import { isStandardPairId, normalizePairId, STANDARD_PAIR_IDS } from './chromosomePairs';

export const PAIR_DESCRIPTION_CSV_HEADERS = ['Chromosomal Pair Number', 'Description'] as const;

export type PairNoteMap = Record<string, string>;

export interface PairDescriptionRow {
  pairId: string;
  description: string;
  line: number;
}

export interface PairCsvParseResult {
  headerError: string | null;
  rows: PairDescriptionRow[];
  errors: { line: number; message: string }[];
  duplicatePairIds: string[];
}

interface CsvRecord {
  cells: string[];
  line: number;
}

/** "01" and "x" become "1" and "X". Blank input stays blank. */
export function normalizeCsvPairId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'Unassigned') return '';
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return '';
    return String(n);
  }
  if (trimmed.toLowerCase() === 'x') return 'X';
  if (trimmed.toLowerCase() === 'y') return 'Y';
  return normalizePairId(trimmed);
}

export function parsePairNoteOverrides(value: unknown): PairNoteMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const notes: PairNoteMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    const pairId = normalizeCsvPairId(key);
    const description = raw.trim();
    if (!pairId || !description) continue;
    notes[pairId] = description;
  }
  return notes;
}

/**
 * Sentence shown in Level 1.
 * A non-empty per-spread override wins, then the bucket description, then an
 * older sentence stored in that spread's annotation XML.
 */
export function resolvePairSentence(
  override: string | undefined,
  bucketDescription: string | undefined,
  legacyInfo: string | undefined,
): string | undefined {
  const local = override?.trim();
  if (local) return local;
  const shared = bucketDescription?.trim();
  if (shared) return shared;
  const legacy = legacyInfo?.trim();
  if (legacy) return legacy;
  return undefined;
}

export function withResolvedPairSentences<T extends { type: string; info?: string }>(
  chromosomes: T[],
  overrides: PairNoteMap | undefined,
  bucketNotes: PairNoteMap | undefined,
): T[] {
  return chromosomes.map(chromosome => {
    const info = resolvePairSentence(
      overrides?.[chromosome.type],
      bucketNotes?.[chromosome.type],
      chromosome.info,
    );
    if (info === chromosome.info) return chromosome;
    return { ...chromosome, info };
  });
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildPairDescriptionTemplate(customPairIds: string[] = []): string {
  const extras: string[] = [];
  const seen = new Set<string>(STANDARD_PAIR_IDS);
  for (const raw of customPairIds) {
    const pairId = normalizeCsvPairId(raw);
    if (!pairId || seen.has(pairId) || isStandardPairId(pairId)) continue;
    seen.add(pairId);
    extras.push(pairId);
  }
  const lines = [
    PAIR_DESCRIPTION_CSV_HEADERS.join(','),
    ...[...STANDARD_PAIR_IDS, ...extras].map(pairId => `${csvCell(pairId)},`),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Custom pair names already used as stroke labels in annotation XML. */
export function customPairIdsFromXml(xmlDocuments: string[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const xml of xmlDocuments) {
    for (const match of xml.matchAll(/label="([^"]*)"/g)) {
      const pairId = normalizeCsvPairId(match[1] ?? '');
      if (!pairId || pairId === 'Unassigned' || isStandardPairId(pairId) || known.has(pairId)) continue;
      known.add(pairId);
      seen.push(pairId);
    }
  }
  return seen;
}

function parseCsvRecords(text: string): CsvRecord[] {
  const source = text.replace(/^\uFEFF/, '');
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const pushRecord = () => {
    row.push(field);
    const cells = row;
    const isBlank = cells.every(cell => cell.trim() === '');
    if (!isBlank) records.push({ cells, line: recordLine });
    row = [];
    field = '';
    recordLine = line;
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (char === '\r') {
        if (source[i + 1] === '\n') continue;
        line += 1;
        field += '\n';
        continue;
      }
      if (char === '\n') {
        line += 1;
        field += '\n';
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      line += 1;
      pushRecord();
      recordLine = line;
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) pushRecord();
  return records;
}

function headersMatch(cells: string[]): boolean {
  if (cells.length !== 2) return false;
  return cells[0].trim().toLowerCase() === PAIR_DESCRIPTION_CSV_HEADERS[0].toLowerCase()
    && cells[1].trim().toLowerCase() === PAIR_DESCRIPTION_CSV_HEADERS[1].toLowerCase();
}

export function parsePairDescriptionCsv(text: string): PairCsvParseResult {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return {
      headerError: 'The CSV is empty. It needs a header row: Chromosomal Pair Number, Description.',
      rows: [],
      errors: [],
      duplicatePairIds: [],
    };
  }

  const [header, ...body] = records;
  if (!headersMatch(header.cells)) {
    return {
      headerError: 'Use these column names: Chromosomal Pair Number, Description.',
      rows: [],
      errors: [],
      duplicatePairIds: [],
    };
  }

  const errors: { line: number; message: string }[] = [];
  const byPair = new Map<string, PairDescriptionRow>();
  const duplicatePairIds: string[] = [];

  for (const record of body) {
    if (record.cells.length > 2) {
      errors.push({ line: record.line, message: 'This row has extra columns.' });
      continue;
    }
    if (record.cells.length < 2) {
      errors.push({ line: record.line, message: 'Description column is missing.' });
      continue;
    }
    const pairId = normalizeCsvPairId(record.cells[0] ?? '');
    if (!pairId) {
      errors.push({ line: record.line, message: 'Chromosomal pair number is empty.' });
      continue;
    }
    if (byPair.has(pairId) && !duplicatePairIds.includes(pairId)) duplicatePairIds.push(pairId);
    byPair.set(pairId, {
      pairId,
      description: (record.cells[1] ?? '').trim(),
      line: record.line,
    });
  }

  return {
    headerError: null,
    rows: Array.from(byPair.values()),
    errors,
    duplicatePairIds,
  };
}

export function downloadTextFile(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
