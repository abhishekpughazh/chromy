export const DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;

export type SpreadDifficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<SpreadDifficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
};

export function parseSpreadDifficulty(value: unknown): SpreadDifficulty | null {
  if (value === 'easy' || value === 'moderate' || value === 'hard') return value;
  return null;
}
