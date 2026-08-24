/**
 * Rewrites a Supabase public object URL to the image-transform endpoint so
 * grids can fetch a small JPEG instead of the original microscope scan.
 * Non-Supabase URLs are returned unchanged.
 *
 * Image Transformations are a paid add-on. If the render endpoint is not
 * enabled for this project, we stop rewriting and use the original file.
 */
let imageTransformsEnabled = true;

export function disableImageTransforms() {
  imageTransformsEnabled = false;
}

/** Object key inside the Storage bucket, or null if the URL is not a public/render path. */
export function storageObjectPathFromPublicUrl(
  originalUrl: string,
  bucket = 'images'
): string | null {
  try {
    const url = new URL(originalUrl);
    const markers = [
      `/storage/v1/object/public/${bucket}/`,
      `/storage/v1/render/image/public/${bucket}/`,
    ];
    for (const marker of markers) {
      const idx = url.pathname.indexOf(marker);
      if (idx === -1) continue;
      const path = decodeURIComponent(url.pathname.slice(idx + marker.length));
      if (!path || path.includes('..')) return null;
      return path;
    }
    return null;
  } catch {
    return null;
  }
}

export function thumbnailUrl(
  originalUrl: string,
  options: {
    width: number;
    height?: number;
    quality?: number;
    resize?: 'cover' | 'contain' | 'fill';
  }
): string {
  if (!imageTransformsEnabled) return originalUrl;

  try {
    const url = new URL(originalUrl);
    const objectMarker = '/storage/v1/object/public/';
    if (!url.pathname.includes(objectMarker)) return originalUrl;

    url.pathname = url.pathname.replace(objectMarker, '/storage/v1/render/image/public/');
    url.search = '';
    url.searchParams.set('width', String(options.width));
    if (options.height != null) url.searchParams.set('height', String(options.height));
    url.searchParams.set('resize', options.resize ?? 'cover');
    url.searchParams.set('quality', String(options.quality ?? 70));
    return url.toString();
  } catch {
    return originalUrl;
  }
}
