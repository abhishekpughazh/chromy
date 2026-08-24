export interface CropPoint {
  x: number;
  y: number;
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
  if (!img.naturalWidth || !img.naturalHeight || points.length < 3) return null;

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
  maxX = Math.min(img.naturalWidth, maxX + padding);
  maxY = Math.min(img.naturalHeight, maxY + padding);

  const w = Math.ceil(maxX - minX);
  const h = Math.ceil(maxY - minY);
  if (w <= 0 || h <= 0) return null;

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
