import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Loader } from 'lucide-react';
import { isStandardPairId, MATCH_ROW_HIGHLIGHTS, pairIdsForMatchRow } from '../lib/chromosomePairs';
import { orderChromosomesForLesson } from '../lib/levels';
import { cn } from '../lib/utils';

/** How close a drop can be to a chromosome outline, in source-image pixels. */
const HIT_PADDING = 16;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

interface Point {
  x: number;
  y: number;
}

export interface LabelChromosome {
  id: string;
  type: string;
  ordinal: number;
  points?: Point[];
}

export interface NumberPlacement {
  chromosomeId: string;
  pairId: string;
}

interface LabelSpreadLevelProps {
  imageUrl: string;
  chromosomes: LabelChromosome[];
  placements: NumberPlacement[];
  scaffoldIds: ReadonlySet<string>;
  assisted: boolean;
  onPlacementsChange: (placements: NumberPlacement[]) => void;
}

interface DragState {
  kind: 'chip' | 'badge';
  pairId: string;
  chromosomeId?: string;
  pointerId: number;
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = (current.y > point.y) !== (previous.y > point.y)
      && point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const lengthSquared = (start.x - end.x) ** 2 + (start.y - end.y) ** 2;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared
  ));
  return Math.hypot(point.x - (start.x + t * (end.x - start.x)), point.y - (start.y + t * (end.y - start.y)));
}

function distanceToPolygon(point: Point, polygon: Point[]) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    best = Math.min(best, distanceToSegment(point, polygon[j], polygon[i]));
  }
  return best;
}

function polygonArea(polygon: Point[]) {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
  }
  return Math.abs(area) / 2;
}

function hitChromosome(point: Point, chromosomes: LabelChromosome[]): LabelChromosome | null {
  let inside: { chromosome: LabelChromosome; area: number } | null = null;
  let near: { chromosome: LabelChromosome; distance: number } | null = null;
  for (const chromosome of chromosomes) {
    const polygon = chromosome.points;
    if (!polygon || polygon.length < 3) continue;
    if (pointInPolygon(point, polygon)) {
      const area = polygonArea(polygon);
      if (!inside || area < inside.area) inside = { chromosome, area };
      continue;
    }
    const distance = distanceToPolygon(point, polygon);
    if (distance <= HIT_PADDING && (!near || distance < near.distance)) {
      near = { chromosome, distance };
    }
  }
  return inside?.chromosome ?? near?.chromosome ?? null;
}

/** Screen size of a number token, and the clear gap kept between it and the chromatin. */
const SLOT_PX = 28;
const SLOT_GAP_PX = 2;

function average(points: Point[], axis: 'x' | 'y') {
  return points.reduce((sum, point) => sum + point[axis], 0) / points.length;
}

/**
 * Center of the number, in image pixels. The token sits just outside the
 * chromosome, preferring the top tip, and moves to another side when that
 * spot would cover this chromosome or a neighbor.
 */
function labelAnchor(points: Point[], others: Point[][], scale: number): Point {
  const reach = (SLOT_PX / 2 + SLOT_GAP_PX) / Math.max(scale, 0.05);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const top = points.filter(point => point.y <= minY + 1);
  const right = points.filter(point => point.x >= maxX - 1);
  const left = points.filter(point => point.x <= minX + 1);
  const bottom = points.filter(point => point.y >= maxY - 1);
  const candidates = [
    { x: average(top, 'x'), y: minY - reach },
    { x: maxX + reach, y: average(right, 'y') },
    { x: minX - reach, y: average(left, 'y') },
    { x: average(bottom, 'x'), y: maxY + reach },
  ];
  const polygons = [points, ...others];
  let best = candidates[0];
  let bestScore = -Infinity;
  candidates.forEach((candidate, index) => {
    let clearance = Infinity;
    for (const polygon of polygons) {
      if (polygon.length < 3) continue;
      if (pointInPolygon(candidate, polygon)) {
        clearance = -1;
        break;
      }
      clearance = Math.min(clearance, distanceToPolygon(candidate, polygon));
    }
    const preference = candidates.length - index;
    const score = clearance + 0.01 >= reach ? 1000 + preference : clearance;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best;
}

function nearestOnPolygon(point: Point, polygon: Point[]): Point {
  let best = polygon[0];
  let bestDistance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const start = polygon[j];
    const end = polygon[i];
    const lengthSquared = (start.x - end.x) ** 2 + (start.y - end.y) ** 2;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
    }
    const candidate = {
      x: start.x + t * (end.x - start.x),
      y: start.y + t * (end.y - start.y),
    };
    const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Hairline from the edge of a number box to just inside the chromosome outline. */
function calloutGeometry(anchor: Point, polygon: Point[], scale: number): { start: Point; end: Point } {
  const edge = nearestOnPolygon(anchor, polygon);
  const center = { x: average(polygon, 'x'), y: average(polygon, 'y') };
  const inwardX = center.x - edge.x;
  const inwardY = center.y - edge.y;
  const inward = Math.hypot(inwardX, inwardY) || 1;
  const tuck = Math.min(5 / Math.max(scale, 0.05), inward * 0.35);
  const tucked = {
    x: edge.x + (inwardX / inward) * tuck,
    y: edge.y + (inwardY / inward) * tuck,
  };
  const end = pointInPolygon(tucked, polygon) ? tucked : edge;
  const dx = end.x - anchor.x;
  const dy = end.y - anchor.y;
  const span = Math.hypot(dx, dy) || 1;
  const boxReach = (SLOT_PX / 2 + 2) / Math.max(scale, 0.05);
  const startShift = Math.min(boxReach, span * 0.42);
  return {
    start: {
      x: anchor.x + (dx / span) * startShift,
      y: anchor.y + (dy / span) * startShift,
    },
    end,
  };
}

interface Callout {
  id: string;
  pairId: string;
  label: string;
  anchor: Point;
  start: Point;
  end: Point;
  points: Point[];
  role: 'slot' | 'badge';
  locked: boolean;
  wrong: boolean;
  lit: boolean;
  dimmed: boolean;
  hoverMatches: boolean | null;
}

function calloutInk(callout: Callout): { core: string; halo: string } {
  if (callout.hoverMatches === false || (callout.wrong && callout.hoverMatches == null)) {
    return { core: 'rgb(244,63,94)', halo: 'rgba(255,255,255,0.92)' };
  }
  if (callout.hoverMatches === true || callout.lit) {
    return { core: 'rgb(2,132,199)', halo: 'rgba(255,255,255,0.92)' };
  }
  return { core: 'rgb(15,23,42)', halo: 'rgba(255,255,255,0.92)' };
}

function slotUnderPointer(root: HTMLElement | null, x: number, y: number, padding = 14) {
  if (!root) return null;
  let best: { id: string; pairId: string; distance: number } | null = null;
  for (const node of root.querySelectorAll<HTMLElement>('[data-number-slot]')) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (x < rect.left - padding || x > rect.right + padding || y < rect.top - padding || y > rect.bottom + padding) continue;
    const id = node.dataset.chromosomeId;
    const pairId = node.dataset.pairId;
    if (!id || !pairId) continue;
    const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
    if (!best || distance < best.distance) best = { id, pairId, distance };
  }
  return best;
}

function contains(rect: DOMRect | undefined, x: number, y: number) {
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface SpreadView {
  fit: number;
  centerX: number;
  centerY: number;
}

/**
 * Scale that makes the chromosome cluster as large as possible inside the
 * frame, plus the image-space point that should sit at the frame center.
 */
function spreadView(
  chromosomes: LabelChromosome[],
  natural: { w: number; h: number },
  frame: { w: number; h: number },
): SpreadView {
  if (natural.w <= 0 || natural.h <= 0 || frame.w <= 0 || frame.h <= 0) {
    return { fit: 0, centerX: 0, centerY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chromosome of chromosomes) {
    const points = chromosome.points;
    if (!points || points.length < 3) continue;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = natural.w;
    maxY = natural.h;
  }

  const clusterW = Math.max(1, maxX - minX);
  const clusterH = Math.max(1, maxY - minY);
  const availW = Math.max(1, frame.w - 16);
  const availH = Math.max(1, frame.h - 16);
  const rawFit = Math.min(availW / clusterW, availH / clusterH);
  const pad = (SLOT_PX / 2 + SLOT_GAP_PX + 12) / Math.max(rawFit, 0.05);
  return {
    fit: Math.min(availW / (clusterW + pad * 2), availH / (clusterH + pad * 2)),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

function viewOrigin(
  pan: { x: number; y: number },
  zoom: number,
  spread: SpreadView,
  frame: { w: number; h: number },
) {
  const scale = spread.fit * zoom;
  return {
    scale,
    fit: spread.fit,
    x: frame.w / 2 + pan.x - spread.centerX * scale,
    y: frame.h / 2 + pan.y - spread.centerY * scale,
  };
}

function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  spread: SpreadView,
  natural: { w: number; h: number },
  frame: { w: number; h: number },
) {
  if (zoom <= MIN_ZOOM) return { x: 0, y: 0 };
  const scale = spread.fit * zoom;
  const clampAxis = (value: number, frameSize: number, naturalSize: number, center: number) => {
    if (naturalSize * scale <= frameSize) return 0;
    const min = frameSize / 2 - (naturalSize - center) * scale;
    const max = center * scale - frameSize / 2;
    return clamp(value, Math.min(min, max), Math.max(min, max));
  };
  return {
    x: clampAxis(pan.x, frame.w, natural.w, spread.centerX),
    y: clampAxis(pan.y, frame.h, natural.h, spread.centerY),
  };
}

function NumberToken({
  label,
  locked = false,
  className,
}: {
  label: string;
  locked?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center min-w-9 h-9 px-2.5 rounded-lg border text-sm font-black shadow-sm whitespace-nowrap',
        locked
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-900 border-slate-200',
        className
      )}
    >
      {label}
    </span>
  );
}

export default function LabelSpreadLevel({
  imageUrl,
  chromosomes,
  placements,
  scaffoldIds,
  assisted,
  onPlacementsChange,
}: LabelSpreadLevelProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const [hasUsedHighlight, setHasUsedHighlight] = useState(false);
  const [hoverSlot, setHoverSlot] = useState<{ id: string; matches: boolean } | null>(null);

  const viewRef = useRef({ originX: 0, originY: 0, scale: 1, fit: 1 });
  const spreadRef = useRef<SpreadView>({ fit: 1, centerX: 0, centerY: 0 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const naturalRef = useRef(natural);
  const frameSizeRef = useRef(frame);
  const placementsRef = useRef(placements);
  const scaffoldRef = useRef(scaffoldIds);
  const chromosomesRef = useRef(chromosomes);
  const onChangeRef = useRef(onPlacementsChange);
  const rejectTimer = useRef<number | null>(null);
  const stopDragListeners = useRef<(() => void) | null>(null);
  const panDrag = useRef<null | {
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  }>(null);

  placementsRef.current = placements;
  scaffoldRef.current = scaffoldIds;
  chromosomesRef.current = chromosomes;
  onChangeRef.current = onPlacementsChange;
  zoomRef.current = zoom;
  panRef.current = pan;
  naturalRef.current = natural;
  frameSizeRef.current = frame;

  const spread = useMemo(
    () => spreadView(chromosomes, natural, frame),
    [chromosomes, natural, frame]
  );
  spreadRef.current = spread;
  const view = viewOrigin(pan, zoom, spread, frame);
  const scale = view.scale;
  const displayW = natural.w * scale;
  const displayH = natural.h * scale;
  const originX = view.x;
  const originY = view.y;
  viewRef.current = { originX, originY, scale, fit: spread.fit };

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural({ w: 0, h: 0 });
    setImageLoaded(false);
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setImageLoaded(true);
    };
    img.onerror = () => {
      if (!cancelled) setImageLoaded(true);
    };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setFrame(prev => (
        Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5
          ? prev
          : { w: rect.width, h: rect.height }
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    setPan(current => {
      const next = clampPan(current, zoom, spread, natural, frame);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [zoom, spread, natural, frame]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (naturalRef.current.w <= 0) return;
      event.preventDefault();
      const currentZoom = zoomRef.current;
      const nextZoom = clamp(currentZoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === currentZoom) return;
      const rect = element.getBoundingClientRect();
      const frameSize = { w: rect.width, h: rect.height };
      const current = viewOrigin(panRef.current, currentZoom, spreadRef.current, frameSize);
      if (current.scale <= 0) return;
      const imageX = (event.clientX - rect.left - current.x) / current.scale;
      const imageY = (event.clientY - rect.top - current.y) / current.scale;
      const nextScale = spreadRef.current.fit * nextZoom;
      const nextOriginX = event.clientX - rect.left - imageX * nextScale;
      const nextOriginY = event.clientY - rect.top - imageY * nextScale;
      const nextPan = clampPan(
        {
          x: nextOriginX - frameSize.w / 2 + spreadRef.current.centerX * nextScale,
          y: nextOriginY - frameSize.h / 2 + spreadRef.current.centerY * nextScale,
        },
        nextZoom,
        spreadRef.current,
        naturalRef.current,
        frameSize,
      );
      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [imageUrl]);

  const flashReject = () => {
    setRejected(true);
    if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
    rejectTimer.current = window.setTimeout(() => setRejected(false), 450);
  };

  const releaseDragListeners = () => {
    stopDragListeners.current?.();
    stopDragListeners.current = null;
  };

  useEffect(() => () => {
    if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
    releaseDragListeners();
  }, []);

  const byId = useMemo(
    () => new Map(chromosomes.map(chromosome => [chromosome.id, chromosome])),
    [chromosomes]
  );

  const trayChromosomes = useMemo(() => {
    const remaining = new Map<string, number>();
    for (const placement of placements) {
      remaining.set(placement.pairId, (remaining.get(placement.pairId) ?? 0) + 1);
    }
    const chips: LabelChromosome[] = [];
    for (const chromosome of orderChromosomesForLesson(chromosomes)) {
      if (scaffoldIds.has(chromosome.id)) continue;
      const used = remaining.get(chromosome.type) ?? 0;
      if (used > 0) {
        remaining.set(chromosome.type, used - 1);
        continue;
      }
      chips.push(chromosome);
    }
    return chips;
  }, [chromosomes, placements, scaffoldIds]);

  const numberGroups = useMemo(() => {
    const remaining = new Set(trayChromosomes.map(chromosome => chromosome.id));
    const standard = MATCH_ROW_HIGHLIGHTS.map(row => {
      const pairIds = new Set(pairIdsForMatchRow(row.id));
      const members = chromosomes.filter(chromosome => pairIds.has(chromosome.type));
      const chips = orderChromosomesForLesson(members).filter(chromosome => remaining.has(chromosome.id));
      return { id: row.id, label: row.label, members, chips };
    }).filter(row => row.members.length > 0);

    const customMembers = chromosomes.filter(chromosome => !isStandardPairId(chromosome.type));
    if (customMembers.length === 0) return standard;
    return [
      ...standard,
      {
        id: 'custom',
        label: '+',
        members: customMembers,
        chips: orderChromosomesForLesson(customMembers).filter(chromosome => remaining.has(chromosome.id)),
      },
    ];
  }, [chromosomes, trayChromosomes]);

  const highlightedPairIds = useMemo(() => {
    if (!highlightedRowId) return null;
    const group = numberGroups.find(row => row.id === highlightedRowId);
    if (!group) return null;
    return new Set(group.members.map(chromosome => chromosome.type));
  }, [highlightedRowId, numberGroups]);

  useEffect(() => {
    if (!highlightedRowId) return;
    const timer = window.setTimeout(() => setHighlightedRowId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [highlightedRowId]);

  const toggleHighlight = (rowId: string) => {
    setHasUsedHighlight(true);
    setHighlightedRowId(current => current === rowId ? null : rowId);
  };

  const badges = useMemo(() => {
    const items: { id: string; label: string; locked: boolean; wrong: boolean }[] = [];
    for (const id of scaffoldIds) {
      const chromosome = byId.get(id);
      if (chromosome) items.push({ id, label: chromosome.type, locked: true, wrong: false });
    }
    for (const placement of placements) {
      if (scaffoldIds.has(placement.chromosomeId)) continue;
      const chromosome = byId.get(placement.chromosomeId);
      if (!chromosome) continue;
      items.push({
        id: placement.chromosomeId,
        label: placement.pairId,
        locked: false,
        wrong: placement.pairId !== chromosome.type,
      });
    }
    return items;
  }, [byId, placements, scaffoldIds]);

  const openSlots = useMemo(() => {
    const occupied = new Set(placements.map(placement => placement.chromosomeId));
    return chromosomes.filter(chromosome => {
      if (!chromosome.points || chromosome.points.length < 3) return false;
      if (scaffoldIds.has(chromosome.id)) return false;
      if (drag?.kind === 'badge' && drag.chromosomeId === chromosome.id) return true;
      return !occupied.has(chromosome.id);
    });
  }, [chromosomes, drag, placements, scaffoldIds]);

  const beginDrag = (event: React.PointerEvent, next: DragState) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    releaseDragListeners();
    const state = { ...next, pointerId: event.pointerId };
    setDragPoint({ x: event.clientX, y: event.clientY });
    setDrag(state);

    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== state.pointerId) return;
      setDragPoint({ x: pointerEvent.clientX, y: pointerEvent.clientY });
      const slot = slotUnderPointer(frameRef.current, pointerEvent.clientX, pointerEvent.clientY);
      const next = slot ? { id: slot.id, matches: slot.pairId === state.pairId } : null;
      setHoverSlot(current => (
        current?.id === next?.id && current?.matches === next?.matches ? current : next
      ));
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== state.pointerId) return;
      releaseDragListeners();
      setDrag(null);
      setHoverSlot(null);

      const onTray = contains(trayRef.current?.getBoundingClientRect(), pointerEvent.clientX, pointerEvent.clientY);
      if (onTray) {
        if (state.kind === 'badge' && state.chromosomeId) {
          onChangeRef.current(placementsRef.current.filter(placement => placement.chromosomeId !== state.chromosomeId));
        }
        return;
      }

      const frameRect = frameRef.current?.getBoundingClientRect();
      if (!contains(frameRect, pointerEvent.clientX, pointerEvent.clientY)) return;

      const placeOn = (chromosomeId: string) => {
        if (scaffoldRef.current.has(chromosomeId)) {
          flashReject();
          return;
        }
        const fromId = state.kind === 'badge' ? state.chromosomeId : undefined;
        if (fromId === chromosomeId) return;
        const current = placementsRef.current;
        const occupant = current.find(placement => placement.chromosomeId === chromosomeId);
        const next = current.filter(placement => (
          placement.chromosomeId !== fromId && placement.chromosomeId !== chromosomeId
        ));
        if (occupant && fromId) {
          next.push({ chromosomeId: fromId, pairId: occupant.pairId });
        }
        next.push({ chromosomeId, pairId: state.pairId });
        onChangeRef.current(next);
      };

      const slot = slotUnderPointer(frameRef.current, pointerEvent.clientX, pointerEvent.clientY);
      if (slot) {
        placeOn(slot.id);
        return;
      }

      const view = viewRef.current;
      if (view.scale <= 0 || !frameRect) {
        if (state.kind === 'chip') flashReject();
        return;
      }
      const imagePoint = {
        x: (pointerEvent.clientX - frameRect.left - view.originX) / view.scale,
        y: (pointerEvent.clientY - frameRect.top - view.originY) / view.scale,
      };
      const hit = hitChromosome(imagePoint, chromosomesRef.current);
      if (!hit) {
        if (state.kind === 'chip') flashReject();
        return;
      }
      placeOn(hit.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    stopDragListeners.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  };

  const onFramePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoomRef.current <= 1) return;
    if ((event.target as HTMLElement).closest('[data-number-badge="player"]')) return;
    panDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onFramePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = panDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = clampPan(
      {
        x: active.panX + event.clientX - active.startX,
        y: active.panY + event.clientY - active.startY,
      },
      zoomRef.current,
      spreadRef.current,
      naturalRef.current,
      frameSizeRef.current,
    );
    panRef.current = next;
    setPan(next);
  };

  const callouts = useMemo(() => {
    if (scale <= 0) return [] as Callout[];
    const neighbors = (id: string) => chromosomes
      .filter(chromosome => chromosome.id !== id && chromosome.points && chromosome.points.length >= 3)
      .map(chromosome => chromosome.points!);
    const items: Callout[] = [];
    const push = (
      id: string,
      pairId: string,
      label: string,
      points: Point[],
      role: Callout['role'],
      locked: boolean,
      wrong: boolean,
    ) => {
      const anchor = labelAnchor(points, neighbors(id), scale);
      const { start, end } = calloutGeometry(anchor, points, scale);
      const lit = highlightedPairIds?.has(pairId) ?? false;
      const hoverMatches = hoverSlot?.id === id ? hoverSlot.matches : null;
      items.push({
        id,
        pairId,
        label,
        anchor,
        start,
        end,
        points,
        role,
        locked,
        wrong,
        lit,
        dimmed: highlightedPairIds != null && !lit && hoverMatches == null,
        hoverMatches,
      });
    };
    for (const chromosome of openSlots) {
      if (!chromosome.points) continue;
      push(chromosome.id, chromosome.type, chromosome.type, chromosome.points, 'slot', false, false);
    }
    for (const badge of badges) {
      if (drag?.kind === 'badge' && drag.chromosomeId === badge.id) continue;
      const chromosome = byId.get(badge.id);
      if (!chromosome?.points || chromosome.points.length < 3) continue;
      push(chromosome.id, chromosome.type, badge.label, chromosome.points, 'badge', badge.locked, badge.wrong);
    }
    return items;
  }, [badges, byId, chromosomes, drag, highlightedPairIds, hoverSlot, openSlots, scale]);

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDrag.current?.pointerId !== event.pointerId) return;
    panDrag.current = null;
    setPanning(false);
  };

  return (
    <div className="h-full min-h-0 min-w-0 w-full flex flex-col gap-2 select-none">
      <div
        className={cn(
          'relative min-h-0 flex-1 rounded-2xl border bg-slate-950 shadow-sm overflow-hidden',
          rejected ? 'border-rose-400' : 'border-slate-200'
        )}
      >
        <div
          ref={frameRef}
          className={cn(
            'absolute inset-0 touch-none',
            zoom > 1 && (panning ? 'cursor-grabbing' : 'cursor-grab')
          )}
          onPointerDown={onFramePointerDown}
          onPointerMove={onFramePointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          {!imageLoaded && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <Loader className="w-8 h-8 text-sky-400 animate-spin" />
            </div>
          )}
          {scale > 0 && (
            <div
              className="absolute top-0 left-0"
              style={{ width: displayW, height: displayH, transform: `translate(${originX}px, ${originY}px)` }}
            >
              <img
                src={imageUrl}
                alt="Metaphase spread"
                draggable={false}
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                  setImageLoaded(true);
                }}
                className={cn('block h-full w-full max-w-none', imageLoaded ? 'opacity-100' : 'opacity-0')}
              />
              {imageLoaded && natural.w > 0 && highlightedPairIds && (
                <svg
                  className="absolute inset-0 z-[1] w-full h-full pointer-events-none"
                  viewBox={`0 0 ${natural.w} ${natural.h}`}
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  {chromosomes.map(chromosome => {
                    if (!highlightedPairIds.has(chromosome.type) || !chromosome.points || chromosome.points.length < 3) return null;
                    return (
                      <polygon
                        key={chromosome.id}
                        points={chromosome.points.map(point => `${point.x},${point.y}`).join(' ')}
                        fill="rgba(14,165,233,0.45)"
                        stroke="rgb(2,132,199)"
                        strokeWidth={3}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </svg>
              )}
              {imageLoaded && natural.w > 0 && callouts.length > 0 && (
                <svg
                  className="absolute inset-0 z-[1] w-full h-full pointer-events-none"
                  viewBox={`0 0 ${natural.w} ${natural.h}`}
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  {callouts.map(callout => {
                    const ink = calloutInk(callout);
                    const polygon = callout.points.map(point => `${point.x},${point.y}`).join(' ');
                    const dotted = callout.role === 'slot' && callout.hoverMatches == null;
                    const unit = 1 / Math.max(scale, 0.05);
                    const dash = dotted ? `${2.2 * unit} ${2.6 * unit}` : undefined;
                    return (
                      <g key={callout.id} opacity={callout.dimmed ? 0.28 : 1}>
                        {callout.hoverMatches != null && (
                          <polygon
                            points={polygon}
                            fill={callout.hoverMatches === false ? 'rgba(244,63,94,0.28)' : 'rgba(14,165,233,0.28)'}
                            stroke={ink.core}
                            strokeWidth={1.25 * unit}
                          />
                        )}
                        <line
                          x1={callout.start.x}
                          y1={callout.start.y}
                          x2={callout.end.x}
                          y2={callout.end.y}
                          stroke={ink.halo}
                          strokeWidth={2.4 * unit}
                          strokeLinecap="round"
                          strokeDasharray={dash}
                        />
                        <line
                          x1={callout.start.x}
                          y1={callout.start.y}
                          x2={callout.end.x}
                          y2={callout.end.y}
                          stroke={ink.core}
                          strokeWidth={1.15 * unit}
                          strokeLinecap="round"
                          strokeDasharray={dash}
                        />
                        <circle
                          cx={callout.end.x}
                          cy={callout.end.y}
                          r={(dotted ? 2.1 : 2.5) * unit}
                          fill={dotted ? 'white' : ink.core}
                          stroke={ink.core}
                          strokeWidth={1 * unit}
                        />
                      </g>
                    );
                  })}
                </svg>
              )}
              {imageLoaded && natural.w > 0 && callouts.map(callout => {
                const slot = callout.role === 'slot';
                return (
                  <div
                    key={callout.id}
                    data-number-slot={slot ? '' : undefined}
                    data-number-badge={slot ? undefined : callout.locked ? 'locked' : 'player'}
                    data-chromosome-id={slot ? callout.id : undefined}
                    data-pair-id={slot ? callout.pairId : undefined}
                    title={slot ? undefined : callout.locked ? 'Already numbered' : callout.wrong ? 'Wrong number. Drag it to another slot.' : 'Drag to move this number'}
                    onPointerDown={slot || callout.locked ? undefined : (event) => beginDrag(event, {
                      kind: 'badge',
                      pairId: callout.label,
                      chromosomeId: callout.id,
                      pointerId: event.pointerId,
                    })}
                    className={cn(
                      'absolute -translate-x-1/2 -translate-y-1/2',
                      slot ? 'z-[2] pointer-events-none' : 'z-10 touch-none'
                    )}
                    style={{
                      left: `${(callout.anchor.x / natural.w) * 100}%`,
                      top: `${(callout.anchor.y / natural.h) * 100}%`,
                    }}
                  >
                    {slot ? (
                      <div
                        className={cn(
                          'h-7 w-7 rounded-[5px] border-[1.5px] border-dotted bg-white/55 shadow-sm transition-transform',
                          callout.hoverMatches === true && 'scale-110 border-sky-600 bg-sky-50',
                          callout.hoverMatches === false && 'scale-110 border-rose-500 bg-rose-50',
                          callout.hoverMatches == null && callout.lit && 'border-sky-600 bg-sky-50/80',
                          callout.hoverMatches == null && !callout.lit && 'border-slate-900',
                          callout.dimmed && 'opacity-30'
                        )}
                      />
                    ) : (
                      <NumberToken
                        label={callout.label}
                        locked={callout.locked}
                        className={cn(
                          'h-6 min-w-6 px-1.5 text-[11px] shadow-md',
                          callout.locked ? 'cursor-default' : 'cursor-grab',
                          callout.wrong && 'border-rose-400 text-rose-700',
                          callout.lit && 'ring-2 ring-sky-400 ring-offset-1',
                          callout.dimmed && 'opacity-30'
                        )}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <p className="absolute bottom-2 left-3 text-[10px] font-bold tracking-wide text-white/70 pointer-events-none">
          Scroll to zoom{zoom > 1 ? ' · drag the image to pan' : ''}
        </p>
      </div>

      <div
        ref={trayRef}
        className="shrink-0 flex w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
        title={assisted
          ? 'One of each pair is numbered. Drop the matching number into the dashed slot beside the other. A wrong number stays on the slot until you move it.'
          : 'Drop each number into the dashed slot beside its chromosome. A wrong number stays there until you move it.'}
      >
        <span className="text-[10px] font-mono font-bold tracking-widest text-slate-400">
          {trayChromosomes.length}
        </span>
        {numberGroups.map(group => {
          const rowActive = highlightedRowId === group.id;
          return (
            <div key={group.id} className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1">
              <button
                type="button"
                onClick={() => toggleHighlight(group.id)}
                aria-pressed={rowActive}
                title={`Highlight ${group.label} chromosomes on the spread`}
                className={cn(
                  'shrink-0 px-1.5 py-1 rounded-md border text-[10px] font-black tracking-wide whitespace-nowrap transition-colors',
                  rowActive
                    ? 'bg-sky-500 border-sky-500 text-white'
                    : 'bg-white border-slate-200 text-slate-600 shadow-sm hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700',
                  !rowActive && !hasUsedHighlight && 'row-hint-pulse border-sky-300 text-sky-700'
                )}
              >
                {group.label}
              </button>
              {group.chips.map(chromosome => {
                const lit = highlightedPairIds?.has(chromosome.type) ?? false;
                const dimmed = highlightedPairIds != null && !lit;
                return (
                  <button
                    key={chromosome.id}
                    type="button"
                    aria-label={`Place ${chromosome.type}`}
                    onPointerDown={(event) => beginDrag(event, {
                      kind: 'chip',
                      pairId: chromosome.type,
                      chromosomeId: chromosome.id,
                      pointerId: event.pointerId,
                    })}
                    className={cn(
                      'touch-none cursor-grab active:cursor-grabbing rounded-lg transition-opacity duration-300',
                      lit && 'bg-sky-100/90',
                      dimmed && 'opacity-25',
                      drag?.kind === 'chip' && drag.chromosomeId === chromosome.id && 'opacity-30'
                    )}
                  >
                    <NumberToken label={chromosome.type} className="h-7 min-w-7 px-1.5 text-xs shadow-none" />
                  </button>
                );
              })}
            </div>
          );
        })}
        {trayChromosomes.length === 0 && (
          <span className="flex items-center gap-1 text-xs font-medium text-slate-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            All placed
          </span>
        )}
      </div>

      {drag && createPortal(
        <div
          className="fixed z-[70] pointer-events-none"
          style={{ left: dragPoint.x, top: dragPoint.y }}
        >
          <NumberToken label={drag.pairId} className="-translate-x-1/2 -translate-y-1/2 shadow-xl" />
        </div>,
        document.body
      )}
    </div>
  );
}
