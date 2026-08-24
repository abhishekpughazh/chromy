export type AnnotationStatus = 'never_started' | 'in_progress' | 'complete';

function isLabeledStroke(label: string | null | undefined, pointCount: number): boolean {
  return !!label && label !== 'Unassigned' && pointCount >= 3;
}

const labeledCountCache = new Map<string, number>();

/** Labeled (non-Unassigned) chromosomes in saved annotation XML. */
export function countLabeledChromosomes(xml?: string): number {
  if (!xml) return 0;
  const cached = labeledCountCache.get(xml);
  if (cached !== undefined) return cached;
  let n = 0;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    for (const el of Array.from(doc.querySelectorAll('stroke'))) {
      if (isLabeledStroke(el.getAttribute('label'), el.querySelectorAll('point').length)) n++;
    }
  } catch {
    n = 0;
  }
  if (labeledCountCache.size > 250) labeledCountCache.clear();
  labeledCountCache.set(xml, n);
  return n;
}

/** Live count from in-memory annotation strokes. */
export function countLabeledStrokes(strokes: { label?: string; points: unknown[] }[]): number {
  return strokes.filter(s => isLabeledStroke(s.label, s.points.length)).length;
}

/** Modal chromosome number from ISCN, e.g. 46 from "46,XY" or 47 from "47,XX,+21". */
export function parseExpectedChromosomeCount(karyotype?: string): number | null {
  if (!karyotype) return null;
  const match = karyotype.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getAnnotationStatus(xml: string | undefined, annotationComplete?: boolean): AnnotationStatus {
  if (countLabeledChromosomes(xml) === 0) return 'never_started';
  return annotationComplete ? 'complete' : 'in_progress';
}

/** Confirm copy when labeled count does not match the karyotype; null if no warning is needed. */
export function markCompleteMismatchMessage(labeledCount: number, karyotype?: string): string | null {
  const expected = parseExpectedChromosomeCount(karyotype);
  if (expected == null || labeledCount === expected) return null;
  const noun = labeledCount === 1 ? 'chromosome' : 'chromosomes';
  return `This spread has ${labeledCount} labeled ${noun} but the karyotype ${karyotype} expects ${expected}. Mark complete anyway?`;
}
