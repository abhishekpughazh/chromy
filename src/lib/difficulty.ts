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

export const SPREAD_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export type SpreadLevel = (typeof SPREAD_LEVELS)[number];

export function parseSpreadLevel(value: unknown): SpreadLevel {
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 10) {
    return num as SpreadLevel;
  }
  return 1;
}
