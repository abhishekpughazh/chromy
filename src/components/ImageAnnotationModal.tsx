import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { X, Save, PenLine, Trash2, Undo2, Hand, ZoomIn, ZoomOut, Maximize, MousePointer2, Eye, EyeOff, RotateCw, FlipHorizontal, FlipVertical, Plus, Pencil, LayoutGrid, Loader } from 'lucide-react';
import { STANDARD_PAIR_IDS, MAX_CHROMOSOMES_PER_PAIR, normalizePairId, isStandardPairId } from '../lib/chromosomePairs';
import { normalizeRotation, pointerAngleDeg, chromosomeTransform, toggleDisplayedFlipX, toggleDisplayedFlipY } from '../lib/orientation';
import { countLabeledStrokes, parseExpectedChromosomeCount, markCompleteMismatchMessage } from '../lib/annotationStatus';
import { cropBoundsFromPoints, cropPolygonFromImage } from '../lib/chromosomeCrop';
import { cn } from '../lib/utils';
import KaryotypePreview, { type KaryotypePreviewChromosome } from './KaryotypePreview';

interface Point { x: number; y: number }
interface Stroke {
  points: Point[];
  color: string;
  width: number;
  id: string;
  label?: string;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

/**
 * Returns a pair ID that still has room for another chromosome (fewer than
 * MAX_CHROMOSOMES_PER_PAIR strokes assigned).
 *
 * If `preferId` still has room, it is returned as-is so finishing a stroke
 * does not snap the selector back to chromosome 1. Otherwise the first pair
 * in `allPairIds` with remaining capacity is used (standard pairs first,
 * then custom pairs in the order they were added).
 */
function nextAvailablePair(strokes: Stroke[], allPairIds: string[], preferId?: string): string | null {
  const counts = new Map<string, number>();
  strokes.forEach(s => {
    if (!s.label || s.label === 'Unassigned') return;
    const pid = normalizePairId(s.label);
    counts.set(pid, (counts.get(pid) || 0) + 1);
  });
  if (preferId && preferId !== 'Unassigned') {
    const preferred = normalizePairId(preferId);
    if ((counts.get(preferred) || 0) < MAX_CHROMOSOMES_PER_PAIR) return preferred;
  }
  for (const id of allPairIds) {
    if ((counts.get(id) || 0) < MAX_CHROMOSOMES_PER_PAIR) return id;
  }
  return null;
}

interface ImageAnnotationModalProps {
  imageUrl: string;
  imageId: string;
  initialXml?: string;
  karyotype?: string;
  annotationComplete?: boolean;
  onSave: (xml: string) => Promise<void>;
  onSetComplete: (complete: boolean) => Promise<void>;
  onClose: () => void;
}

function strokesToXml(strokes: Stroke[], imageId: string, imgWidth: number, imgHeight: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<annotations imageId="${imageId}" width="${imgWidth}" height="${imgHeight}">\n`;
  for (const s of strokes) {
    xml += `  <stroke color="${s.color}" width="${s.width}" label="${s.label || 'Unassigned'}" rotation="${normalizeRotation(s.rotation)}" flipX="${s.flipX || false}" flipY="${s.flipY || false}">\n`;
    for (const p of s.points) {
      xml += `    <point x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}"/>\n`;
    }
    xml += `  </stroke>\n`;
  }
  xml += `</annotations>\n`;
  return xml;
}

function xmlToStrokes(xmlText: string): Stroke[] | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const strokeEls = doc.querySelectorAll('stroke');
    const strokes: Stroke[] = [];
    strokeEls.forEach((el, idx) => {
      const color = el.getAttribute('color') || '#ff0000';
      const width = parseFloat(el.getAttribute('width') || '2');
      const label = el.getAttribute('label') || 'Unassigned';
      const rotation = normalizeRotation(parseFloat(el.getAttribute('rotation') || '0'));
      const flipX = el.getAttribute('flipX') === 'true';
      const flipY = el.getAttribute('flipY') === 'true';
      const pointEls = el.querySelectorAll('point');
      const points: Point[] = [];
      pointEls.forEach((p) => {
        points.push({
          x: parseFloat(p.getAttribute('x') || '0'),
          y: parseFloat(p.getAttribute('y') || '0'),
        });
      });
      strokes.push({ id: `loaded-${idx}`, color, width, points, label, rotation, flipX, flipY });
    });
    return strokes;
  } catch {
    return null;
  }
}

const OrientationDialog = ({ 
  stroke, 
  img, 
  onComplete,
  onEdit,
  onRedo,
  onClose
}: { 
  stroke: Stroke, 
  img: HTMLImageElement, 
  onComplete: (updates: Partial<Stroke>) => void,
  onEdit: () => void,
  onRedo: () => void,
  onClose: () => void
}) => {
  const [rotation, setRotation] = useState(() => normalizeRotation(stroke.rotation));
  const [flipX, setFlipX] = useState(stroke.flipX || false);
  const [flipY, setFlipY] = useState(stroke.flipY || false);
  const [dataUrl, setDataUrl] = useState<string>('');
  const [isDraggingRotation, setIsDraggingRotation] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startPointerAngle: number; startRotation: number } | null>(null);

  useEffect(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });

    const padding = 10;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(img.naturalWidth, maxX + padding);
    maxY = Math.min(img.naturalHeight, maxY + padding);

    const w = maxX - minX;
    const h = maxY - minY;

    if (w <= 0 || h <= 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create an anonymous image to draw onto the canvas to prevent tainting
    const safeImg = new Image();
    safeImg.crossOrigin = 'anonymous';
    safeImg.onload = () => {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x - minX, stroke.points[0].y - minY);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x - minX, stroke.points[i].y - minY);
      }
      ctx.closePath();
      ctx.clip();

      ctx.drawImage(safeImg, minX, minY, w, h, 0, 0, w, h);
      setDataUrl(canvas.toDataURL('image/png'));
    };
    safeImg.onerror = () => {
      console.error('Failed to load image for OrientationDialog');
      // If it fails, fallback to drawing the tainted image so the user can at least see something,
      // but we won't be able to use toDataURL.
      setDataUrl('');
    };
    safeImg.src = img.src;
  }, [stroke, img]);

  const handlePreviewPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = previewRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      startPointerAngle: pointerAngleDeg(e.clientX, e.clientY, el),
      startRotation: rotation,
    };
    setIsDraggingRotation(true);
  };

  const handlePreviewPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = previewRef.current;
    if (!drag || !el) return;
    const current = pointerAngleDeg(e.clientX, e.clientY, el);
    setRotation(normalizeRotation(drag.startRotation + (current - drag.startPointerAngle)));
  };

  const endPreviewDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDraggingRotation(false);
    setRotation((r) => normalizeRotation(r));
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already have been released
    }
  };

  const displayRotation = normalizeRotation(rotation);

  return (
    <div 
      className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div 
        className="relative bg-white rounded-3xl shadow-2xl p-8 w-full max-w-md flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-full text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          title="Close orientation dialog"
          aria-label="Close orientation dialog"
        >
          <X className="w-5 h-5" />
        </button>
        <h3 className="text-2xl font-black text-slate-900 mb-2">Orient Chromosome</h3>
        <p className="text-sm text-slate-500 mb-8 text-center font-medium">Drag the preview or use the slider to rotate. The p-arm should typically point upwards.</p>

        <div
          ref={previewRef}
          className="w-64 h-64 border-2 border-slate-100 bg-slate-50/50 rounded-2xl mb-4 flex items-center justify-center overflow-hidden shadow-inner touch-none select-none"
          style={{ cursor: isDraggingRotation ? 'grabbing' : 'grab' }}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={endPreviewDrag}
          onPointerCancel={endPreviewDrag}
        >
          {dataUrl ? (
            <img
              src={dataUrl}
              alt="Chromosome Preview"
              draggable={false}
              className="max-w-[80%] max-h-[80%] object-contain drop-shadow-lg pointer-events-none"
              style={{
                transform: chromosomeTransform(rotation, flipX, flipY)
              }}
            />
          ) : (
            <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        <div className="w-full mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Rotation</span>
            <label className="flex items-center gap-1 text-sm font-mono font-bold text-slate-700">
              <input
                type="number"
                min={0}
                max={359}
                value={displayRotation}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setRotation(normalizeRotation(n));
                }}
                className="w-16 text-right px-2 py-1 border border-slate-200 rounded-lg text-sm font-mono font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              °
            </label>
          </div>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={displayRotation}
            aria-label="Rotation in degrees"
            onChange={(e) => setRotation(Number(e.target.value))}
            className="w-full accent-sky-500 cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 w-full mb-8">
          <button
            aria-pressed={flipX}
            onClick={() => {
              const next = toggleDisplayedFlipX({ rotation, flipX, flipY });
              setRotation(next.rotation);
              setFlipX(next.flipX);
              setFlipY(next.flipY);
            }}
            className={cn(
              "py-3 border-2 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all",
              flipX
                ? "border-sky-500 bg-sky-500 text-white shadow-md shadow-sky-500/20"
                : "border-slate-200 text-slate-600 hover:border-sky-500 hover:bg-sky-50 hover:text-sky-600"
            )}
          >
            <FlipHorizontal className="w-4 h-4" /> Flip X
          </button>
          <button
            aria-pressed={flipY}
            onClick={() => {
              const next = toggleDisplayedFlipY({ rotation, flipX, flipY });
              setRotation(next.rotation);
              setFlipX(next.flipX);
              setFlipY(next.flipY);
            }}
            className={cn(
              "py-3 border-2 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all",
              flipY
                ? "border-sky-500 bg-sky-500 text-white shadow-md shadow-sky-500/20"
                : "border-slate-200 text-slate-600 hover:border-sky-500 hover:bg-sky-50 hover:text-sky-600"
            )}
          >
            <FlipVertical className="w-4 h-4" /> Flip Y
          </button>
        </div>

        <div className="flex flex-col gap-3 w-full">
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onComplete({ rotation: normalizeRotation(rotation), flipX, flipY });
            }}
            className="w-full py-4 bg-sky-500 text-white rounded-xl font-black text-lg hover:bg-sky-600 hover:-translate-y-0.5 active:translate-y-0 transition-all shadow-lg shadow-sky-500/30"
          >
            Save Orientation
          </button>
          
          <div className="flex gap-3 w-full">
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEdit();
              }}
              className="flex-1 py-3 bg-white border-2 border-slate-200 text-slate-700 rounded-xl font-bold hover:border-slate-300 transition-colors"
            >
              Edit Points
            </button>
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRedo();
              }}
              className="flex-1 py-3 bg-white border-2 border-red-200 text-red-600 rounded-xl font-bold hover:bg-red-50 transition-colors"
            >
              Redo Shape
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isPointInPolygon(p: Point, polygon: Point[]) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

function distToSegment(p: Point, v: Point, w: Point) {
  const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

type Mode = 'draw' | 'pan' | 'edit';

export default function ImageAnnotationModal({ imageUrl, imageId, initialXml, karyotype, annotationComplete, onSave, onSetComplete, onClose }: ImageAnnotationModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [strokes, _setStrokes] = useState<Stroke[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  const setStrokes = useCallback((val: React.SetStateAction<Stroke[]>) => {
    _setStrokes(val);
    setIsDirty(true);
  }, []);

  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [color, setColor] = useState('#ef4444');
  const [lineWidth, setLineWidth] = useState(1);
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [complete, setComplete] = useState(!!annotationComplete);
  const [loaded, setLoaded] = useState(false);
  const [previewPoint, setPreviewPoint] = useState<Point | null>(null);

  const [showLabels, setShowLabels] = useState(true);
  const [showKaryotypePreview, setShowKaryotypePreview] = useState(false);
  const [cropUrls, setCropUrls] = useState<Record<string, string>>({});
  const cropCacheRef = useRef<Map<string, { sig: string; dataUrl: string }>>(new Map());
  const [mode, setMode] = useState<Mode>('draw');
  const [drawStyle, setDrawStyle] = useState<'polygon' | 'freehand'>('freehand');
  const [activeLabel, setActiveLabel] = useState<string>(STANDARD_PAIR_IDS[0]);
  // The 24 standard pair slots, renameable in place (renaming replaces the
  // entry at that position rather than spawning a separate custom pair).
  const [pairOrder, setPairOrder] = useState<string[]>([...STANDARD_PAIR_IDS]);
  const [customPairs, setCustomPairs] = useState<string[]>([]);
  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  const [orientingStrokeId, setOrientingStrokeId] = useState<string | null>(null);
  const [draggedPoint, setDraggedPoint] = useState<{ strokeId: string, index: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{
    type: 'draw' | 'pan' | 'pinch' | null;
    startScale: number;
    startPanX: number;
    startPanY: number;
    startDist: number;
    startCenterX: number;
    startCenterY: number;
    drawStroke: Stroke | null;
  }>({ type: null, startScale: 1, startPanX: 0, startPanY: 0, startDist: 0, startCenterX: 0, startCenterY: 0, drawStroke: null });

  const toCanvasPoint = (clientX: number, clientY: number): Point | null => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const redrawAll = useCallback((allStrokes: Stroke[], activeStroke: Stroke | null, preview: Point | null, selectedId: string | null, displayLabels: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawStroke = (stroke: Stroke, isComplete: boolean, tempPoint: Point | null = null) => {
      if (stroke.points.length === 0) return;
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      if (tempPoint) {
        ctx.lineTo(tempPoint.x, tempPoint.y);
      }
      if (isComplete) {
        ctx.closePath();
        ctx.fillStyle = stroke.color + '40';
        ctx.fill();
      }
      ctx.stroke();

      const isSelected = stroke.id === selectedId;
      const showDots = !isComplete || isSelected;

      if (showDots) {
        ctx.fillStyle = stroke.color;
        for (const pt of stroke.points) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, stroke.width * 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (displayLabels && stroke.label && stroke.label !== 'Unassigned' && stroke.points.length > 0 && isComplete && !isSelected) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of stroke.points) {
           if (p.x < minX) minX = p.x;
           if (p.x > maxX) maxX = p.x;
           if (p.y < minY) minY = p.y;
           if (p.y > maxY) maxY = p.y;
        }

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const fontSize = Math.max(10, canvas.width * 0.008);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const text = stroke.label;
        const metrics = ctx.measureText(text);
        const tw = metrics.width;
        const padding = fontSize * 0.3;
        const th = fontSize;

        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cx - tw/2 - padding, cy - th/2 - padding, tw + padding*2, th + padding*2, padding);
        } else {
          ctx.rect(cx - tw/2 - padding, cy - th/2 - padding, tw + padding*2, th + padding*2);
        }
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, cy);
      }
    };

    for (const stroke of allStrokes) {
      drawStroke(stroke, true);
    }

    if (activeStroke) {
      drawStroke(activeStroke, false, preview);
      if (activeStroke.points.length > 0) {
        const first = activeStroke.points[0];
        ctx.beginPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.arc(first.x, first.y, activeStroke.width * 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, []);

  const loadAnnotations = useCallback((xml: string | undefined) => {
    if (!xml) return;
    const loaded = xmlToStrokes(xml);
    if (loaded) {
      _setStrokes(loaded);
      setIsDirty(false);
      // Recover any custom (non-standard) pairs from previously saved strokes,
      // so they reappear in the sidebar exactly as they were left.
      const discoveredCustom = Array.from(new Set(
        loaded
          .map(s => normalizePairId(s.label || 'Unassigned'))
          .filter(id => id !== 'Unassigned' && !isStandardPairId(id))
      ));
      setCustomPairs(discoveredCustom);
      const next = nextAvailablePair(loaded, [...STANDARD_PAIR_IDS, ...discoveredCustom]);
      if (next) setActiveLabel(next);
    }
  }, []); // Only runs when called

  useEffect(() => {
    setLoaded(false);
    setPairOrder([...STANDARD_PAIR_IDS]);
    setCustomPairs([]);
    if (initialXml) {
      loadAnnotations(initialXml);
    } else {
      _setStrokes([]);
      setIsDirty(false);
      setActiveLabel(STANDARD_PAIR_IDS[0]);
    }
    setScale(1);
    setPan({ x: 0, y: 0 });
    setMode('draw');
    setCurrentStroke(null);
    gestureRef.current.type = null;
    gestureRef.current.drawStroke = null;
    pointersRef.current.clear();
    setShowLabels(true);
    setShowKaryotypePreview(false);
    cropCacheRef.current.clear();
    setCropUrls({});
    setComplete(!!annotationComplete);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  useEffect(() => {
    if (!showKaryotypePreview || !loaded) return;
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next: Record<string, string> = {};
      const liveIds = new Set<string>();
      for (const s of strokes) {
        if (!s.label || s.label === 'Unassigned' || s.points.length < 3) continue;
        liveIds.add(s.id);
        const sig = s.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
        const cached = cropCacheRef.current.get(s.id);
        if (cached && cached.sig === sig) {
          next[s.id] = cached.dataUrl;
          continue;
        }
        const url = cropPolygonFromImage(img, s.points);
        if (url) {
          cropCacheRef.current.set(s.id, { sig, dataUrl: url });
          next[s.id] = url;
        }
      }
      for (const id of [...cropCacheRef.current.keys()]) {
        if (!liveIds.has(id)) cropCacheRef.current.delete(id);
      }
      if (!cancelled) setCropUrls(next);
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [strokes, loaded, showKaryotypePreview, imageId]);

  useEffect(() => {
    const preventPinch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener('touchmove', preventPinch, { passive: false });
    return () => document.removeEventListener('touchmove', preventPinch);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault(); // Prevents browser back navigation and native zooming

      if (e.ctrlKey) {
        const zoomSpeed = 0.01;
        const newScale = Math.max(0.1, Math.min(10, scale - e.deltaY * zoomSpeed));

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const imgX = (mouseX - pan.x) / scale;
        const imgY = (mouseY - pan.y) / scale;

        const newPanX = mouseX - imgX * newScale;
        const newPanY = mouseY - imgY * newScale;

        setScale(newScale);
        setPan({ x: newPanX, y: newPanY });
      } else {
        setPan({ x: pan.x - e.deltaX, y: pan.y - e.deltaY });
      }
    };
    container.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => container.removeEventListener('wheel', onNativeWheel);
  }, [scale, pan]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (orientingStrokeId) return; // Prevent interference when dialog is open
      if (showKaryotypePreview) {
        if (e.key === 'Escape') {
          if (selectedStrokeId) setSelectedStrokeId(null);
          else setShowKaryotypePreview(false);
          return;
        }
        if (e.key === 'Delete' && selectedStrokeId) {
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          setStrokes(prev => prev.filter(s => s.id !== selectedStrokeId));
          setSelectedStrokeId(null);
        }
        return;
      }

      if (e.key === 'Escape' && currentStroke) {
        setCurrentStroke(null);
        setPreviewPoint(null);
      } else if (e.key === 'Enter' && currentStroke && currentStroke.points.length >= 2) {
        const newStroke = currentStroke;
        setStrokes(prev => {
          const newStrokes = [...prev, newStroke];
          const next = nextAvailablePair(newStrokes, [...pairOrder, ...customPairs], newStroke.label);
          if (next) setActiveLabel(next);
          return newStrokes;
        });
        setOrientingStrokeId(newStroke.id);
        setCurrentStroke(null);
        setPreviewPoint(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStrokeId) {
        setStrokes(prev => prev.filter(s => s.id !== selectedStrokeId));
        setSelectedStrokeId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentStroke, selectedStrokeId, orientingStrokeId, pairOrder, customPairs, showKaryotypePreview]);

  useEffect(() => {
    redrawAll(strokes, currentStroke, previewPoint, selectedStrokeId, showLabels);
  }, [strokes, currentStroke, previewPoint, selectedStrokeId, showLabels, redrawAll]);

  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;

    if (e.button === 1 || mode === 'pan') {
      target.setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      gestureRef.current.type = 'pan';
      gestureRef.current.startPanX = pan.x;
      gestureRef.current.startPanY = pan.y;
      gestureRef.current.startCenterX = e.clientX;
      gestureRef.current.startCenterY = e.clientY;
      return;
    }

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    target.setPointerCapture(e.pointerId);

    if (pointersRef.current.size === 2) {
      gestureRef.current.type = 'pinch';
      const pts: { x: number; y: number }[] = [...pointersRef.current.values()];
      gestureRef.current.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      gestureRef.current.startScale = scale;
      gestureRef.current.startPanX = pan.x;
      gestureRef.current.startPanY = pan.y;
      gestureRef.current.startCenterX = (pts[0].x + pts[1].x) / 2;
      gestureRef.current.startCenterY = (pts[0].y + pts[1].y) / 2;
      return;
    }

    if (pointersRef.current.size === 1) {
      const p = toCanvasPoint(e.clientX, e.clientY);
      if (!p) return;

      if (mode === 'edit') {
        if (selectedStrokeId) {
          const sel = strokes.find(s => s.id === selectedStrokeId);
          if (sel) {
            const hitRadius = 10 / scale;
            const ptIdx = sel.points.findIndex(pt => Math.hypot(pt.x - p.x, pt.y - p.y) < hitRadius);
            if (ptIdx !== -1) {
              setDraggedPoint({ strokeId: sel.id, index: ptIdx });
              return;
            }
          }
        }

        for (let i = strokes.length - 1; i >= 0; i--) {
          const s = strokes[i];
          const hitRadius = 10 / scale;
          const ptIdx = s.points.findIndex(pt => Math.hypot(pt.x - p.x, pt.y - p.y) < hitRadius);
          if (ptIdx !== -1) {
            setSelectedStrokeId(s.id);
            setDraggedPoint({ strokeId: s.id, index: ptIdx });
            return;
          }

          if (isPointInPolygon(p, s.points)) {
            setSelectedStrokeId(s.id);
            return;
          }

          const edgeRadius = 5 / scale;
          let onEdge = false;
          for (let j = 0; j < s.points.length; j++) {
            const p1 = s.points[j];
            const p2 = s.points[(j + 1) % s.points.length];
            if (distToSegment(p, p1, p2) <= edgeRadius) {
              onEdge = true;
              break;
            }
          }
          if (onEdge) {
            setSelectedStrokeId(s.id);
            return;
          }
        }

        setSelectedStrokeId(null);
        return;
      }

      if (mode === 'draw') {
        setSelectedStrokeId(null); // Deselect if drawing
        
        if (!currentStroke) {
          for (let i = strokes.length - 1; i >= 0; i--) {
            const s = strokes[i];
            if (isPointInPolygon(p, s.points)) {
              setMode('edit');
              setSelectedStrokeId(s.id);
              return;
            }
            const edgeRadius = 5 / scale;
            let onEdge = false;
            for (let j = 0; j < s.points.length; j++) {
              const p1 = s.points[j];
              const p2 = s.points[(j + 1) % s.points.length];
              if (distToSegment(p, p1, p2) <= edgeRadius) {
                onEdge = true;
                break;
              }
            }
            if (onEdge) {
              setMode('edit');
              setSelectedStrokeId(s.id);
              return;
            }
          }
        }

        if (drawStyle === 'freehand') {
          if (gestureRef.current.type === 'draw' && currentStroke) {
            if (currentStroke.points.length > 2) {
              const newStroke = currentStroke;
              const newStrokes = [...strokes, newStroke];
              setStrokes(newStrokes);
              setCurrentStroke(null);
              setPreviewPoint(null);
              const next = nextAvailablePair(newStrokes, [...pairOrder, ...customPairs], newStroke.label);
              if (next) setActiveLabel(next);
              setOrientingStrokeId(newStroke.id);
            } else {
              setCurrentStroke(null);
              setPreviewPoint(null);
            }
            gestureRef.current.type = null;
          } else {
            const id = `stroke-${Date.now()}-${Math.random()}`;
            setCurrentStroke({ id, points: [p], color, width: lineWidth, label: activeLabel });
            gestureRef.current.type = 'draw';
          }
        } else {
          if (currentStroke) {
            const first = currentStroke.points[0];
            const dist = Math.hypot(p.x - first.x, p.y - first.y) * scale;
            if (dist < 20 && currentStroke.points.length >= 2) {
              const newStroke = currentStroke;
              const newStrokes = [...strokes, newStroke];
              setStrokes(newStrokes);
              setCurrentStroke(null);
              setPreviewPoint(null);
              const next = nextAvailablePair(newStrokes, [...pairOrder, ...customPairs], newStroke.label);
              if (next) setActiveLabel(next);
              setOrientingStrokeId(newStroke.id);
            } else {
              setCurrentStroke({ ...currentStroke, points: [...currentStroke.points, p] });
            }
          } else {
            const id = `stroke-${Date.now()}-${Math.random()}`;
            setCurrentStroke({ id, points: [p], color, width: lineWidth, label: activeLabel });
          }
        }
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (mode === 'draw') {
      if (drawStyle === 'freehand' && gestureRef.current.type === 'draw' && currentStroke) {
        const p = toCanvasPoint(e.clientX, e.clientY);
        if (p) {
          const newPoints = [...currentStroke.points, p];
          const first = newPoints[0];
          const dist = Math.hypot(p.x - first.x, p.y - first.y) * scale;
          
          let hasLeftOrigin = false;
          for (let i = 1; i < newPoints.length; i++) {
            if (Math.hypot(newPoints[i].x - first.x, newPoints[i].y - first.y) * scale > 30) {
              hasLeftOrigin = true;
              break;
            }
          }

          if (dist < 20 && newPoints.length > 10 && hasLeftOrigin) {
            const newStroke = { ...currentStroke, points: newPoints };
            const newStrokes = [...strokes, newStroke];
            setStrokes(newStrokes);
            setCurrentStroke(null);
            setPreviewPoint(null);
            gestureRef.current.type = null;
            const next = nextAvailablePair(newStrokes, [...pairOrder, ...customPairs], newStroke.label);
            if (next) setActiveLabel(next);
            setOrientingStrokeId(newStroke.id);
          } else {
            setCurrentStroke({ ...currentStroke, points: newPoints });
          }
        }
        return;
      }
      setPreviewPoint(toCanvasPoint(e.clientX, e.clientY));
    }

    if (mode === 'edit' && draggedPoint) {
      const p = toCanvasPoint(e.clientX, e.clientY);
      if (p) {
        setStrokes(prev => prev.map(s => {
          if (s.id === draggedPoint.strokeId) {
            const newPts = [...s.points];
            newPts[draggedPoint.index] = p;
            return { ...s, points: newPts };
          }
          return s;
        }));
      }
      return;
    }

    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gestureRef.current.type === 'pinch' && pointersRef.current.size === 2) {
      const pts: { x: number; y: number }[] = [...pointersRef.current.values()];
      const newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const newCenterX = (pts[0].x + pts[1].x) / 2;
      const newCenterY = (pts[0].y + pts[1].y) / 2;

      const ratio = gestureRef.current.startDist > 0 ? newDist / gestureRef.current.startDist : 1;
      const newScale = Math.max(0.1, Math.min(10, gestureRef.current.startScale * ratio));

      const imgCenterX = (gestureRef.current.startCenterX - gestureRef.current.startPanX) / gestureRef.current.startScale;
      const imgCenterY = (gestureRef.current.startCenterY - gestureRef.current.startPanY) / gestureRef.current.startScale;

      const newPanX = newCenterX - imgCenterX * newScale;
      const newPanY = newCenterY - imgCenterY * newScale;

      setScale(newScale);
      setPan({ x: newPanX, y: newPanY });
      return;
    }

    if (gestureRef.current.type === 'pan' && pointersRef.current.size === 1) {
      const dx = e.clientX - gestureRef.current.startCenterX;
      const dy = e.clientY - gestureRef.current.startCenterY;
      setPan({ x: gestureRef.current.startPanX + dx, y: gestureRef.current.startPanY + dy });
      return;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (draggedPoint) {
      setDraggedPoint(null);
    }
    if (pointersRef.current.size === 0) {
      if (!(mode === 'draw' && drawStyle === 'freehand')) {
        gestureRef.current.type = null;
      }
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (mode === 'draw' && currentStroke && currentStroke.points.length >= 2) {
      const newStroke = currentStroke;
      const newStrokes = [...strokes, newStroke];
      setStrokes(newStrokes);
      setCurrentStroke(null);
      setPreviewPoint(null);
      gestureRef.current.type = null;
      const next = nextAvailablePair(newStrokes, [...pairOrder, ...customPairs], newStroke.label);
      if (next) setActiveLabel(next);
      setOrientingStrokeId(newStroke.id);
    } else if (mode === 'edit' && selectedStrokeId) {
      setOrientingStrokeId(selectedStrokeId);
    }
  };

  const undoLast = () => {
    if (currentStroke && currentStroke.points.length > 0) {
      if (currentStroke.points.length === 1) {
        setCurrentStroke(null);
        setPreviewPoint(null);
        gestureRef.current.type = null;
      } else {
        setCurrentStroke({ ...currentStroke, points: currentStroke.points.slice(0, -1) });
      }
    } else {
      setStrokes(prev => prev.slice(0, -1));
    }
  };

  const clearAll = () => {
    setStrokes([]);
    setCurrentStroke(null);
    setPreviewPoint(null);
    setSelectedStrokeId(null);
    gestureRef.current.type = null;
  };

  const deleteSelected = () => {
    if (selectedStrokeId) {
      setStrokes(prev => prev.filter(s => s.id !== selectedStrokeId));
      setSelectedStrokeId(null);
    }
  };

  const saveAnnotations = async (e?: React.MouseEvent): Promise<boolean> => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const xml = strokesToXml(strokes, imageId, imgSize.width, imgSize.height);
      await onSave(xml);
      if (countLabeledStrokes(strokes) === 0) setComplete(false);
      setSaveMsg('Saved');
      setIsDirty(false);
      setTimeout(() => setSaveMsg(null), 2000);
      return true;
    } catch {
      setSaveMsg('Error saving');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleToggleComplete = async () => {
    const labeled = countLabeledStrokes(strokes);
    if (!complete) {
      if (labeled === 0) return;
      const mismatch = markCompleteMismatchMessage(labeled, karyotype);
      if (mismatch && !window.confirm(mismatch)) return;
    }
    if (isDirty) {
      const saved = await saveAnnotations();
      if (!saved) return;
    }
    const next = !complete;
    try {
      await onSetComplete(next);
      setComplete(next);
    } catch {
      setSaveMsg('Error updating status');
    }
  };

  const handleClose = useCallback((e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (isDirty) {
      if (!window.confirm('You have unsaved changes. Are you sure you want to discard them?')) {
        return;
      }
    }
    onClose();
  }, [isDirty, onClose]);

  const resetView = () => {
    const container = containerRef.current;
    if (container && imgSize.width > 0 && imgSize.height > 0) {
      const rect = container.getBoundingClientRect();
      const scaleX = (rect.width * 0.95) / imgSize.width;
      const scaleY = (rect.height * 0.95) / imgSize.height;
      const newScale = Math.min(scaleX, scaleY, 1);
      const panX = (rect.width - imgSize.width * newScale) / 2;
      const panY = (rect.height - imgSize.height * newScale) / 2;
      setScale(newScale);
      setPan({ x: panX, y: panY });
    } else {
      setScale(1);
      setPan({ x: 0, y: 0 });
    }
  };

  const zoomBy = (factor: number) => {
    const newScale = Math.max(0.1, Math.min(10, scale * factor));
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const imgX = (cx - pan.x) / scale;
    const imgY = (cy - pan.y) / scale;
    const newPanX = cx - imgX * newScale;
    const newPanY = cy - imgY * newScale;
    setScale(newScale);
    setPan({ x: newPanX, y: newPanY });
  };

  const selectedStroke = strokes.find(s => s.id === selectedStrokeId);
  const rawDisplayLabel = (mode === 'edit' && selectedStroke) ? (selectedStroke.label || 'Unassigned') : activeLabel;
  const currentDisplayLabel = rawDisplayLabel === 'Unassigned' ? 'Unassigned' : normalizePairId(rawDisplayLabel);
  const labeledCount = countLabeledStrokes(strokes);
  const expectedCount = parseExpectedChromosomeCount(karyotype);

  const previewChromosomes: KaryotypePreviewChromosome[] = useMemo(() => (
    strokes
      .filter(s => s.label && s.label !== 'Unassigned' && s.points.length >= 3)
      .map(s => {
        const bounds = cropBoundsFromPoints(s.points, imgSize.width, imgSize.height);
        return {
          strokeId: s.id,
          pairId: normalizePairId(s.label!),
          dataUrl: cropUrls[s.id] || null,
          rotation: normalizeRotation(s.rotation),
          flipX: !!s.flipX,
          flipY: !!s.flipY,
          width: bounds?.width,
          height: bounds?.height,
        };
      })
  ), [strokes, cropUrls, imgSize.width, imgSize.height]);

  const selectPreviewStroke = useCallback((strokeId: string) => {
    setSelectedStrokeId(strokeId);
  }, []);

  const updatePreviewStroke = useCallback((strokeId: string, updates: { rotation?: number; flipX?: boolean; flipY?: boolean; label?: string }) => {
    setStrokes(prev => {
      if (updates.label && updates.label !== 'Unassigned') {
        const pid = normalizePairId(updates.label);
        const count = prev.filter(s =>
          s.id !== strokeId && s.label && s.label !== 'Unassigned' && normalizePairId(s.label) === pid
        ).length;
        if (count >= MAX_CHROMOSOMES_PER_PAIR) return prev;
      }
      return prev.map(s => s.id !== strokeId ? s : {
        ...s,
        ...(updates.rotation != null ? { rotation: normalizeRotation(updates.rotation) } : {}),
        ...(updates.flipX != null ? { flipX: updates.flipX } : {}),
        ...(updates.flipY != null ? { flipY: updates.flipY } : {}),
        ...(updates.label != null ? { label: updates.label } : {}),
      });
    });
  }, []);

  const deletePreviewStroke = useCallback((strokeId: string) => {
    setStrokes(prev => prev.filter(s => s.id !== strokeId));
    setSelectedStrokeId(id => id === strokeId ? null : id);
  }, []);

  const handleLabelClick = (pairId: string) => {
    if (mode === 'edit' && selectedStrokeId) {
      setStrokes(prev => prev.map(s => s.id === selectedStrokeId ? { ...s, label: pairId } : s));
    } else {
      setActiveLabel(pairId);
      if (currentStroke) {
        setCurrentStroke({ ...currentStroke, label: pairId });
      }
    }
  };

  const handleAddPair = () => {
    const name = window.prompt('Enter a name for the new pair:');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const alreadyExists = [...pairOrder, ...customPairs].some(p => p.toLowerCase() === trimmed.toLowerCase());
    if (alreadyExists) {
      window.alert(`A pair named "${trimmed}" already exists.`);
      return;
    }
    setCustomPairs(prev => [...prev, trimmed]);
    handleLabelClick(trimmed);
  };

  const handleDeletePair = (pairId: string) => {
    const affected = strokes.filter(s => s.label && normalizePairId(s.label) === pairId);
    if (affected.length > 0) {
      const ok = window.confirm(
        `This will permanently delete ${affected.length} chromosome annotation${affected.length > 1 ? 's' : ''} labeled "${pairId}". Continue?`
      );
      if (!ok) return;
    }
    const affectedIds = new Set(affected.map(s => s.id));
    setStrokes(prev => prev.filter(s => !affectedIds.has(s.id)));
    setCustomPairs(prev => prev.filter(p => p !== pairId));
    if (selectedStrokeId && affectedIds.has(selectedStrokeId)) {
      setSelectedStrokeId(null);
    }
    if (orientingStrokeId && affectedIds.has(orientingStrokeId)) {
      setOrientingStrokeId(null);
    }
    if (activeLabel === pairId) {
      setActiveLabel(pairOrder[0] || STANDARD_PAIR_IDS[0]);
    }
  };

  const handleRenamePair = (pairId: string) => {
    const newName = window.prompt(`Rename pair "${pairId}" to:`, pairId);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === pairId) return;
    const alreadyExists = [...pairOrder, ...customPairs]
      .filter(id => id !== pairId)
      .some(id => id.toLowerCase() === trimmed.toLowerCase());
    if (alreadyExists) {
      window.alert(`A pair named "${trimmed}" already exists.`);
      return;
    }
    setStrokes(prev => prev.map(s => (s.label && normalizePairId(s.label) === pairId) ? { ...s, label: trimmed } : s));
    // Rename in place - whichever list (standard slot order or custom pairs)
    // currently holds this ID keeps its position/section, it just gets a
    // new name. This avoids leaving a stray empty entry behind.
    if (pairOrder.includes(pairId)) {
      setPairOrder(prev => prev.map(id => id === pairId ? trimmed : id));
    } else {
      setCustomPairs(prev => prev.map(id => id === pairId ? trimmed : id));
    }
    if (activeLabel === pairId) setActiveLabel(trimmed);
  };

  const pairCounts = new Map<string, number>();
  strokes.forEach(s => {
    if (!s.label || s.label === 'Unassigned' || s.id === selectedStrokeId) return;
    const pid = normalizePairId(s.label);
    pairCounts.set(pid, (pairCounts.get(pid) || 0) + 1);
  });

  return (
    <div className="fixed inset-0 z-[200] bg-black/80 flex flex-col items-center justify-center p-4" onPointerDown={(e) => {
      if (e.target === e.currentTarget) {
        handleClose();
      }
    }}>
      <div
        className="bg-white rounded-2xl shadow-2xl flex flex-col w-[95vw] h-[95vh] overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-4">
            <span className="text-xs font-mono text-slate-400 uppercase">Annotation Mode</span>
            <div className="flex items-center gap-2">
              {['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#000000'].map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-5 h-5 rounded-full border-2 ${color === c ? 'border-slate-900 scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 ml-2">
              <PenLine className="w-3 h-3 text-slate-400" />
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={lineWidth}
                onChange={(e) => setLineWidth(parseFloat(e.target.value))}
                className="w-20"
              />
            </div>

            <div className="h-6 w-px bg-slate-300 mx-1" />

            <button
              onClick={() => { setMode('draw'); setSelectedStrokeId(null); setCurrentStroke(null); setPreviewPoint(null); gestureRef.current.type = null; }}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors ${mode === 'draw' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}
            >
              <PenLine className="w-3.5 h-3.5" /> Draw
            </button>
            {mode === 'draw' && (
              <div className="flex bg-slate-200 p-0.5 rounded-lg ml-1">
                <button
                  onClick={() => { setDrawStyle('polygon'); setCurrentStroke(null); setPreviewPoint(null); gestureRef.current.type = null; }}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${drawStyle === 'polygon' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Polygon
                </button>
                <button
                  onClick={() => { setDrawStyle('freehand'); setCurrentStroke(null); setPreviewPoint(null); gestureRef.current.type = null; }}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${drawStyle === 'freehand' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Freehand
                </button>
              </div>
            )}
            <button
              onClick={() => { setMode('edit'); setCurrentStroke(null); setPreviewPoint(null); gestureRef.current.type = null; }}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors ${mode === 'edit' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}
            >
              <MousePointer2 className="w-3.5 h-3.5" /> Edit
            </button>
            <button
              onClick={() => { setMode('pan'); setCurrentStroke(null); setPreviewPoint(null); gestureRef.current.type = null; }}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors ${mode === 'pan' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}
            >
              <Hand className="w-3.5 h-3.5" /> Pan
            </button>

            <div className="h-6 w-px bg-slate-300 mx-1" />

            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors ${showLabels ? 'bg-slate-200 text-slate-600 hover:bg-slate-300' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
              title="Toggle Labels"
            >
              {showLabels ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} Labels
            </button>
            <button
              onClick={() => setShowKaryotypePreview(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors bg-slate-200 text-slate-600 hover:bg-slate-300"
              title="Preview karyotype"
            >
              <LayoutGrid className="w-3.5 h-3.5" /> Karyotype
            </button>

            <div className="h-6 w-px bg-slate-300 mx-1" />

            <button onClick={() => zoomBy(1.2)} className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-600" title="Zoom in">
              <ZoomIn className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-mono text-slate-500 w-12 text-center">{Math.round(scale * 100)}%</span>
            <button onClick={() => zoomBy(0.8)} className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-600" title="Zoom out">
              <ZoomOut className="w-4 h-4" />
            </button>
            <button onClick={resetView} className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-600" title="Reset view">
              <Maximize className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {selectedStrokeId && (
              <>
                <button onClick={() => setOrientingStrokeId(selectedStrokeId)} className="p-2 hover:bg-sky-100 rounded-full transition-colors text-sky-500" title="Adjust Orientation">
                  <RotateCw className="w-4 h-4" />
                </button>
                <button onClick={deleteSelected} className="p-2 hover:bg-red-100 rounded-full transition-colors text-red-500" title="Delete Selected">
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
            <button onClick={undoLast} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500" title="Undo last stroke">
              <Undo2 className="w-4 h-4" />
            </button>
            <button onClick={clearAll} className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500" title="Clear all">
              <Trash2 className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-mono font-bold text-slate-500 px-2 whitespace-nowrap">
              {expectedCount != null ? `${labeledCount} / ${expectedCount} labeled` : `${labeledCount} labeled`}
            </span>
            <button
              onClick={handleToggleComplete}
              disabled={saving || (!complete && labeledCount === 0)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 ${
                complete
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                  : 'bg-emerald-500 text-white hover:bg-emerald-600'
              }`}
            >
              {complete ? 'Unmark complete' : 'Mark as complete'}
            </button>
            <button
              onClick={saveAnnotations}
              disabled={saving}
              className="flex items-center gap-1.5 bg-slate-900 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <Save className="w-3 h-3" /> {saving ? 'Saving...' : 'Save'}
            </button>
            {saveMsg && <span className="text-[10px] font-bold text-emerald-600 ml-1">{saveMsg}</span>}
            <button onClick={handleClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors ml-2">
              <X className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Canvas + Sidebar Container */}
        <div className="flex flex-1 overflow-hidden">
          {/* Canvas + Image */}
          <div
            ref={containerRef}
            className="relative flex-1 overflow-hidden bg-slate-100"
            style={{ overscrollBehavior: 'none' }}
          >
            <div
              className="relative inline-block"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                crossOrigin="anonymous"
                alt="Annotate"
                className="block max-w-none select-none"
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setImgSize({ width: img.naturalWidth, height: img.naturalHeight });
                  const canvas = canvasRef.current;
                  if (canvas) {
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                  }
                  
                  const container = containerRef.current;
                  if (container) {
                    const rect = container.getBoundingClientRect();
                    const scaleX = (rect.width * 0.95) / img.naturalWidth;
                    const scaleY = (rect.height * 0.95) / img.naturalHeight;
                    const newScale = Math.min(scaleX, scaleY, 1);
                    setPan({
                      x: (rect.width - img.naturalWidth * newScale) / 2,
                      y: (rect.height - img.naturalHeight * newScale) / 2
                    });
                    setScale(newScale);
                  }
                  
                  setLoaded(true);
                }}
                onError={() => setLoaded(true)}
              />
              <canvas
                ref={canvasRef}
                className={`absolute top-0 left-0 w-full h-full touch-none ${mode === 'pan' ? 'cursor-grab active:cursor-grabbing' : mode === 'edit' ? 'cursor-pointer' : 'cursor-crosshair'}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={() => setPreviewPoint(null)}
                onDoubleClick={handleDoubleClick}
                style={{ touchAction: 'none' }}
              />
            </div>
            {!loaded && (
              <div className="absolute inset-0 z-20 bg-slate-100 flex flex-col items-center justify-center">
                <Loader className="w-12 h-12 text-sky-500 animate-spin" />
                <p className="mt-4 text-sm font-bold text-slate-600">Loading metaphase spread...</p>
              </div>
            )}
          </div>

          {/* Sidebar Panel for Labels */}
          <div className="w-80 bg-slate-50 border-l border-slate-200 flex flex-col shrink-0 z-10 shadow-[-4px_0_15px_rgba(0,0,0,0.05)]">
            <div className="p-4 border-b border-slate-200 bg-white">
              <h3 className="font-black text-slate-800">Chromosome Labels</h3>
              <p className="text-xs text-slate-500 mt-1">
                {mode === 'edit' && selectedStrokeId ? 'Editing selected shape' : 'Next shape label'}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
              <div className="flex flex-col gap-5">
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Standard Pairs</p>
                  <div className="grid grid-cols-4 gap-2">
                    {pairOrder.map(pairId => {
                      const count = pairCounts.get(pairId) || 0;
                      const isFull = count >= MAX_CHROMOSOMES_PER_PAIR;
                      const isSelected = currentDisplayLabel === pairId;
                      return (
                        <button
                          key={pairId}
                          onClick={() => !isFull && handleLabelClick(pairId)}
                          disabled={isFull && !isSelected}
                          className={`group/cell relative aspect-square rounded-lg border-2 transition-all flex flex-col items-center justify-center px-1 ${
                            isSelected ? "bg-sky-50 border-sky-500 shadow-inner" :
                            isFull ? "bg-slate-100 border-slate-200 cursor-not-allowed" :
                            "bg-white border-slate-200 hover:border-sky-300"
                          }`}
                        >
                          <span className={`font-black text-center leading-tight w-full truncate ${pairId.length > 2 ? 'text-[10px]' : 'text-base'} ${isSelected ? 'text-sky-700' : 'text-slate-700'}`} title={pairId}>
                            {pairId}
                          </span>
                          <span className={`absolute -top-1.5 -right-1.5 text-[9px] font-mono font-bold w-6 h-4 flex items-center justify-center rounded-full border ${
                            isSelected ? "bg-sky-500 text-white border-sky-500" :
                            count === 0 ? "bg-slate-50 text-slate-300 border-slate-200" :
                            isFull ? "bg-slate-300 text-white border-slate-300" :
                            "bg-white text-slate-500 border-slate-200"
                          }`}>
                            {count}/{MAX_CHROMOSOMES_PER_PAIR}
                          </span>
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); handleRenamePair(pairId); }}
                            className="absolute -bottom-1.5 -left-1.5 w-5 h-5 rounded-full bg-white border border-slate-200 text-slate-400 hover:text-sky-600 hover:border-sky-300 flex items-center justify-center opacity-0 group-hover/cell:opacity-100 transition-opacity shadow-sm"
                            title="Rename pair"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {customPairs.length > 0 && (
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Custom Pairs</p>
                    <div className="flex flex-col gap-2">
                      {customPairs.map(pairId => {
                        const count = pairCounts.get(pairId) || 0;
                        const isFull = count >= MAX_CHROMOSOMES_PER_PAIR;
                        const isSelected = currentDisplayLabel === pairId;
                        return (
                          <div
                            key={pairId}
                            className={`flex items-center gap-1 rounded-lg border-2 transition-all ${
                              isSelected ? "bg-sky-50 border-sky-500 shadow-inner" :
                              isFull ? "bg-slate-100 border-slate-200" :
                              "bg-white border-slate-200 hover:border-sky-300"
                            }`}
                          >
                            <button
                              onClick={() => !isFull && handleLabelClick(pairId)}
                              disabled={isFull && !isSelected}
                              className={`flex-1 flex items-center justify-between px-3 py-2 text-left min-w-0 ${isFull && !isSelected ? 'cursor-not-allowed' : ''}`}
                            >
                              <span className={`font-black text-sm truncate ${isSelected ? 'text-sky-700' : 'text-slate-700'}`}>
                                {pairId}
                              </span>
                              <span className={`shrink-0 ml-2 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                                isSelected ? "bg-sky-500 text-white" : isFull ? "bg-slate-300 text-white" : "bg-slate-100 text-slate-500"
                              }`}>
                                {count}/{MAX_CHROMOSOMES_PER_PAIR}
                              </span>
                            </button>
                            <button
                              onClick={() => handleRenamePair(pairId)}
                              className="shrink-0 p-2 text-slate-300 hover:text-sky-600 hover:bg-sky-50 rounded-md transition-colors"
                              title="Rename pair"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeletePair(pairId)}
                              className="shrink-0 p-2 mr-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                              title="Delete pair"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <button
                    onClick={handleAddPair}
                    className="py-3 rounded-lg font-bold text-sm border-2 border-dashed border-slate-200 bg-white text-slate-500 hover:border-sky-300 hover:text-sky-600 transition-all flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" /> Add Pair
                  </button>
                  <button
                    onClick={() => handleLabelClick('Unassigned')}
                    className={`py-3 rounded-lg font-bold text-sm border-2 transition-all ${
                      currentDisplayLabel === 'Unassigned' ? "border-sky-500 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    Unassigned
                  </button>
                </div>
              </div>
            </div>
            {mode === 'edit' && selectedStrokeId && (
              <div className="p-4 border-t border-slate-200 bg-white shadow-[0_-4px_10px_rgba(0,0,0,0.02)]">
                <button
                  onClick={() => setOrientingStrokeId(selectedStrokeId)}
                  className="w-full py-3 rounded-lg font-bold text-sm bg-sky-500 text-white hover:bg-sky-600 transition-colors shadow-lg shadow-sky-500/30 flex items-center justify-center gap-2"
                >
                  <RotateCw className="w-5 h-5" />
                  Adjust Orientation
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <span className="text-[10px] text-slate-400 font-mono">
            {mode === 'draw' ? 'Click points to draw polygon · Double-click to close' : mode === 'edit' ? 'Click shape to select/drag points · Delete key to remove' : 'Drag or Two-finger swipe to pan · Pinch or Scroll to zoom'}
          </span>
          <span className="text-[10px] text-slate-400 font-mono">
            {imgSize.width} x {imgSize.height} px · {strokes.length} strokes
          </span>
        </div>
      </div>

      {showKaryotypePreview && (
        <KaryotypePreview
          pairOrder={pairOrder}
          customPairs={customPairs}
          chromosomes={previewChromosomes}
          selectedStrokeId={selectedStrokeId}
          karyotype={karyotype}
          labeledCount={labeledCount}
          expectedCount={expectedCount}
          onSelect={selectPreviewStroke}
          onUpdate={updatePreviewStroke}
          onDelete={deletePreviewStroke}
          onClose={() => {
            setSelectedStrokeId(null);
            setShowKaryotypePreview(false);
          }}
        />
      )}
      {orientingStrokeId && strokes.find(s => s.id === orientingStrokeId) && imgRef.current && (
        <OrientationDialog
          stroke={strokes.find(s => s.id === orientingStrokeId)!}
          img={imgRef.current}
          onComplete={(updates) => {
            setStrokes(prev => prev.map(s => s.id === orientingStrokeId ? { ...s, ...updates } : s));
            setOrientingStrokeId(null);
          }}
          onEdit={() => {
            setMode('edit');
            setSelectedStrokeId(orientingStrokeId);
            setOrientingStrokeId(null);
          }}
          onRedo={() => {
            setStrokes(prev => prev.filter(s => s.id !== orientingStrokeId));
            setOrientingStrokeId(null);
          }}
          onClose={() => setOrientingStrokeId(null)}
        />
      )}
    </div>
  );
}
