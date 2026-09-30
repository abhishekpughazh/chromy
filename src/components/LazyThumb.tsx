import React, { useEffect, useRef, useState } from 'react';
import { disableImageTransforms, thumbnailUrl } from '../lib/imageUrl';

/**
 * Grid thumbnail. Prefers a resized Storage transform URL. If transforms are
 * not enabled on the project, falls back to the original public object URL.
 */
export function LazyThumb({
  src,
  alt,
  className,
  width = 400,
  height,
  resize = 'cover',
  draggable = false,
  loading = 'lazy',
  fallbackToOriginal = true,
}: {
  src: string;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
  resize?: 'cover' | 'contain' | 'fill';
  draggable?: boolean;
  loading?: 'lazy' | 'eager';
  fallbackToOriginal?: boolean;
}) {
  const thumb = thumbnailUrl(src, { width, height, resize });
  const [displaySrc, setDisplaySrc] = useState(thumb);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    if (displaySrc === src) return;
    const timer = window.setTimeout(() => {
      if (loadedRef.current) return;
      disableImageTransforms();
      setDisplaySrc(src);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [displaySrc, src]);

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      draggable={draggable}
      onLoad={() => {
        loadedRef.current = true;
      }}
      onError={() => {
        if (fallbackToOriginal && displaySrc !== src) {
          disableImageTransforms();
          setDisplaySrc(src);
        }
      }}
    />
  );
}
