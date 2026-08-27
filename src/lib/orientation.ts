/** Default window (degrees) for treating a player's rotation as matching the annotated orientation. */
export const ROTATION_MATCH_TOLERANCE_DEG = 15;

/** Pointer angle in degrees, clockwise from +x — same sign as CSS rotate(). */
export function pointerAngleDeg(clientX: number, clientY: number, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI);
}

/** Snap any angle to an integer in [0, 359]. */
export function normalizeRotation(deg: number | undefined | null): number {
  if (deg == null || !Number.isFinite(deg)) return 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}

/** CSS transform used by annotation, karyotype preview, and gameplay. */
export function chromosomeTransform(
  rotation: number | undefined | null,
  flipX?: boolean,
  flipY?: boolean
): string {
  return `rotate(${normalizeRotation(rotation)}deg) scaleX(${flipX ? -1 : 1}) scaleY(${flipY ? -1 : 1})`;
}

export interface ChromosomeOrientation {
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * Mirror the currently displayed chromosome left-right (screen X).
 * Because CSS applies rotate() after the local flips, a raw flipX toggle is
 * a horizontal mirror only at 0° — once the chromosome is upright in the
 * karyotype, that same toggle looks like a vertical flip. Compensating
 * rotation keeps Flip X / Flip Y meaning the same as in the orient dialog.
 */
export function toggleDisplayedFlipX(orientation: ChromosomeOrientation): ChromosomeOrientation {
  return {
    rotation: normalizeRotation(-orientation.rotation),
    flipX: !orientation.flipX,
    flipY: orientation.flipY,
  };
}

/** Mirror the currently displayed chromosome up-down (screen Y). */
export function toggleDisplayedFlipY(orientation: ChromosomeOrientation): ChromosomeOrientation {
  return {
    rotation: normalizeRotation(-orientation.rotation),
    flipX: orientation.flipX,
    flipY: !orientation.flipY,
  };
}

/** Shortest distance in degrees around the circle, in [0, 180]. */
export function rotationDelta(a: number | undefined | null, b: number | undefined | null): number {
  const d = Math.abs(normalizeRotation(a) - normalizeRotation(b)) % 360;
  return Math.min(d, 360 - d);
}

export function rotationsMatch(
  user: number | undefined | null,
  expected: number | undefined | null,
  tolerance = ROTATION_MATCH_TOLERANCE_DEG
): boolean {
  return rotationDelta(user, expected) <= tolerance;
}
