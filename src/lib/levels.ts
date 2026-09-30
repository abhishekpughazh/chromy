import { CLINICAL_KARYOTYPE_ROWS, comparePairIds } from './chromosomePairs';

export const LEARN_LEVEL = 1;
/** Shown as 2.1. Stored as 2 so existing Match progress stays with this level. */
export const MATCH_LEVEL = 2;
/** Shown as 2.3. Stored as 3 so existing Arrange progress stays with this level. */
export const ARRANGE_LEVEL = 3;
/** Shown as 2.2. Stored as 4 so it does not collide with Match (2) or Arrange (3). */
export const PAIR_LEVEL = 4;
/** Shown as 3.1. Stored as 5. One chromosome of each pair starts numbered. */
export const LABEL_MATE_LEVEL = 5;
/** Shown as 3.2. Stored as 6. Every chromosome starts unnumbered. */
export const LABEL_ALL_LEVEL = 6;

export const LOREM_IPSUM_SENTENCE =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';

export const LEVELS = [
  {
    id: LEARN_LEVEL,
    label: '1',
    title: 'Learn',
    description: 'Walk through every chromosome pair in order. Nothing to solve.',
    pointers: [
      'Click a pair to flip its card.',
      'Press space to switch between the picture and the note.',
      'Use the arrow keys to move between pairs.',
    ],
  },
  {
    id: MATCH_LEVEL,
    label: '2.1',
    title: 'Match',
    description: 'One chromosome of each pair is already in place.',
    pointers: [
      'One chromosome of each pair is already placed.',
      'Drag each remaining chromosome into an open slot of its pair.',
      'Orientation is already set.',
    ],
  },
  {
    id: PAIR_LEVEL,
    label: '2.2',
    title: 'Pair',
    description: 'Every slot starts empty.',
    pointers: [
      'Every slot starts empty.',
      'Drag each chromosome into the correct pair.',
      'Orientation is already set.',
    ],
  },
  {
    id: ARRANGE_LEVEL,
    label: '2.3',
    title: 'Arrange',
    description: 'Place each chromosome in the correct pair and match its orientation.',
    pointers: [
      'Drag each chromosome into the correct pair.',
      'Rotate and flip it until the orientation matches.',
      'The hint button walks you through one chromosome.',
    ],
  },
  {
    id: LABEL_MATE_LEVEL,
    label: '3.1',
    title: 'Mate',
    description: 'One chromosome of each pair is already numbered. Place the number on the other.',
    pointers: [
      'One chromosome of each pair is already numbered.',
      'Drag the matching number into the dashed slot beside the other.',
      'A wrong number stays there until you move it.',
    ],
  },
  {
    id: LABEL_ALL_LEVEL,
    label: '3.2',
    title: 'Label',
    description: 'Place a number beside every chromosome.',
    pointers: [
      'Every chromosome starts without a number.',
      'Drop each number into the dashed slot beside its chromosome.',
      'Scroll to zoom. Drag the image to pan once you are zoomed in.',
    ],
  },
] as const;

export const GAMEPLAY_LEVELS = [MATCH_LEVEL, PAIR_LEVEL, ARRANGE_LEVEL, LABEL_MATE_LEVEL, LABEL_ALL_LEVEL] as const;

/** Match and Pair show chromosomes already flipped and rotated. Arrange does not. */
export function isPresetOrientationLevel(levelId: number): boolean {
  return levelId === MATCH_LEVEL || levelId === PAIR_LEVEL;
}

/** Mate and Label number chromosomes on the metaphase spread. */
export function isLabelLevel(levelId: number): boolean {
  return levelId === LABEL_MATE_LEVEL || levelId === LABEL_ALL_LEVEL;
}

export function isGameplayLevel(levelId: number): boolean {
  return (GAMEPLAY_LEVELS as readonly number[]).includes(levelId);
}

export function levelProgressLabel(summary?: {
  status: 'in_progress' | 'complete';
  correctCount: number;
  totalCount: number;
} | null): string {
  if (!summary) return 'Not started';
  if (summary.status === 'complete') return 'Completed';
  return `Resume ${summary.correctCount}/${summary.totalCount}`;
}

/** Clinical karyotype order: groups A–G, then X and Y, then any custom pairs. */
export function orderChromosomesForLesson<T extends { type: string; ordinal: number }>(chromosomes: T[]): T[] {
  const byPair = new Map<string, T[]>();
  const firstAppearance: string[] = [];
  for (const chromosome of chromosomes) {
    const list = byPair.get(chromosome.type);
    if (list) {
      list.push(chromosome);
    } else {
      byPair.set(chromosome.type, [chromosome]);
      firstAppearance.push(chromosome.type);
    }
  }
  for (const list of byPair.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal);
  }

  const ordered: T[] = [];
  const used = new Set<string>();
  for (const row of CLINICAL_KARYOTYPE_ROWS) {
    for (const group of row) {
      for (const pairId of group.pairIds) {
        const members = byPair.get(pairId);
        if (!members) continue;
        used.add(pairId);
        ordered.push(...members);
      }
    }
  }

  const customIds = firstAppearance
    .filter(id => !used.has(id))
    .sort((a, b) => comparePairIds(a, b, firstAppearance));
  for (const pairId of customIds) {
    ordered.push(...(byPair.get(pairId) ?? []));
  }
  return ordered;
}

/** Pair ids in the same clinical order used by the lesson, one entry per pair. */
export function orderPairIdsForLesson<T extends { type: string; ordinal: number }>(chromosomes: T[]): string[] {
  const ids: string[] = [];
  for (const chromosome of orderChromosomesForLesson(chromosomes)) {
    if (ids[ids.length - 1] !== chromosome.type) ids.push(chromosome.type);
  }
  return ids;
}
