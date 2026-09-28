export interface CropPoint {
  x: number;
  y: number;
}

export interface CropBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * Axis-aligned crop box for a polygon, including padding and clamped to the
 * source image. Width and height match the canvas produced by
 * cropPolygonFromImage.
 */
export function cropBoundsFromPoints(
  points: CropPoint[],
  imageWidth: number,
  imageHeight: number,
  padding = 10
): CropBounds | null {
  if (imageWidth <= 0 || imageHeight <= 0 || points.length < 3) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(imageWidth, maxX + padding);
  maxY = Math.min(imageHeight, maxY + padding);

  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);
  if (width <= 0 || height <= 0) return null;

  return { minX, minY, width, height };
}

/**
 * One CSS-pixel-per-source-pixel scale for a whole sample.
 * The longest crop edge maps to maxEdgePx; every other chromosome uses the
 * same factor so relative size matches the metaphase spread.
 * Returns 1 when no chromosome has a positive size.
 */
export function uniformDisplayScale(
  items: ReadonlyArray<{ width?: number; height?: number }>,
  maxEdgePx: number
): number {
  let longest = 0;
  for (const item of items) {
    const edge = Math.max(item.width ?? 0, item.height ?? 0);
    if (edge > longest) longest = edge;
  }
  if (longest <= 0) return 1;
  return maxEdgePx / longest;
}

/**
 * Clip a polygon out of a metaphase image and return a PNG data URL.
 * Matches the crop used by gameplay extraction so the annotation preview
 * looks like the assembled karyotype.
 */
export function cropPolygonFromImage(
  img: HTMLImageElement,
  points: CropPoint[],
  padding = 10
): string | null {
  const bounds = cropBoundsFromPoints(points, img.naturalWidth, img.naturalHeight, padding);
  if (!bounds) return null;

  const { minX, minY, width: w, height: h } = bounds;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.beginPath();
  ctx.moveTo(points[0].x - minX, points[0].y - minY);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x - minX, points[i].y - minY);
  }
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, minX, minY, w, h, 0, 0, w, h);

  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
