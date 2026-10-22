import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Loader, RotateCcw, X } from 'lucide-react';
import { hitChromosome, type LabelChromosome } from './LabelSpreadLevel';

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
/** Clear space kept around the chromosome cluster, in screen pixels. */
const FRAME_MARGIN = 20;
/** White veil over a lifted chromosome so the original stays visible, barely. */
const FADED_FILL = 'rgba(255,255,255,0.9)';
/** Pointer travel, in screen pixels, below which a press counts as a click. */
const CLICK_SLOP = 4;
/** Extra hit tolerance around a polygon in source-image pixels. */
const HIT_PADDING = 10;
/** Minimum overlap ratio (intersectionArea / min(areaA, areaB)) to count as overlapping. */
const MIN_OVERLAP_RATIO = 0.2;
/** Drop target for putting a lifted chromosome back on the metaphase. */
export const PLUCK_SPREAD_DROP_ID = 'pluck-spread';

interface Point {
  x: number;
  y: number;
}

interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface OverlapCluster {
  id: string;
  members: LabelChromosome[];
  bounds: BoundingBox;
  center: Point;
}

interface PluckSpreadLevelProps {
  imageUrl: string;
  /** Every chromosome on the spread, plucked or not. */
  chromosomes: LabelChromosome[];
  /** Chromosomes already lifted off the spread. */
  pluckedIds: ReadonlySet<string>;
  onPluck: (chromosomeId: string) => void;
  /** Real chromosomes already lifted, and how many real chromosomes the spread has. */
  progress: { plucked: number; total: number };
}

const toPoints = (points: Point[]) => points.map(point => `${point.x},${point.y}`).join(' ');

function polygonBounds(points: Point[]): BoundingBox {
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
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses =
      current.y > point.y !== previous.y > point.y &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const lengthSquared = (start.x - end.x) ** 2 + (start.y - end.y) ** 2;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared)
  );
  return Math.hypot(point.x - (start.x + t * (end.x - start.x)), point.y - (start.y + t * (end.y - start.y)));
}

function distanceToPolygon(point: Point, polygon: Point[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    best = Math.min(best, distanceToSegment(point, polygon[j], polygon[i]));
  }
  return best;
}

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return Math.abs(area) / 2;
}

function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

/**
 * Checks whether two chromosome polygons have at least a 20% area overlap
 * relative to the smaller polygon: intersectionArea / min(areaA, areaB) >= 0.20.
 */
function polygonsOverlapAtLeast20Pct(
  polyA: Point[],
  polyB: Point[],
  boundsA: BoundingBox,
  boundsB: BoundingBox,
  areaA: number,
  areaB: number
): boolean {
  if (!boxesOverlap(boundsA, boundsB)) return false;
  const minPolyArea = Math.min(areaA, areaB);
  if (minPolyArea <= 0) return false;

  const interMinX = Math.max(boundsA.minX, boundsB.minX);
  const interMinY = Math.max(boundsA.minY, boundsB.minY);
  const interMaxX = Math.min(boundsA.maxX, boundsB.maxX);
  const interMaxY = Math.min(boundsA.maxY, boundsB.maxY);
  const interW = interMaxX - interMinX;
  const interH = interMaxY - interMinY;
  if (interW <= 1 || interH <= 1) return false;

  const boxInterArea = interW * interH;
  if (boxInterArea / minPolyArea < MIN_OVERLAP_RATIO) return false;

  // Sample a 16x16 grid over the intersection bounding box to estimate the intersection area.
  const grid = 16;
  const cellArea = (interW / grid) * (interH / grid);
  let sharedCells = 0;
  for (let ix = 0; ix < grid; ix++) {
    const x = interMinX + ((ix + 0.5) * interW) / grid;
    for (let iy = 0; iy < grid; iy++) {
      const y = interMinY + ((iy + 0.5) * interH) / grid;
      const sample = { x, y };
      if (pointInPolygon(sample, polyA) && pointInPolygon(sample, polyB)) {
        sharedCells++;
      }
    }
  }

  const estimatedIntersectionArea = sharedCells * cellArea;
  return estimatedIntersectionArea / minPolyArea >= MIN_OVERLAP_RATIO;
}

/**
 * Returns all available chromosomes whose polygon contains `point` (ordered
 * smallest area first), or the closest chromosome within HIT_PADDING if none
 * directly contain `point`.
 */
function hitsAtPoint(point: Point, chromosomes: LabelChromosome[]): LabelChromosome[] {
  const inside: { chromosome: LabelChromosome; area: number }[] = [];
  let near: { chromosome: LabelChromosome; distance: number } | null = null;

  for (const chromosome of chromosomes) {
    const polygon = chromosome.points;
    if (!polygon || polygon.length < 3) continue;
    if (pointInPolygon(point, polygon)) {
      inside.push({ chromosome, area: polygonArea(polygon) });
      continue;
    }
    const distance = distanceToPolygon(point, polygon);
    if (distance <= HIT_PADDING && (!near || distance < near.distance)) {
      near = { chromosome, distance };
    }
  }

  if (inside.length > 0) {
    inside.sort((a, b) => a.area - b.area);
    return inside.map(entry => entry.chromosome);
  }
  return near ? [near.chromosome] : [];
}

/**
 * Groups available chromosomes that have >= 20% overlap into connected components,
 * keeping ONLY clusters where at least one valid chromosome overlaps with at
 * least one invalid chromosome.
 */
function buildValidInvalidOverlapClusters(available: LabelChromosome[]): OverlapCluster[] {
  const valid = available.filter(c => c.points && c.points.length >= 3);
  const n = valid.length;
  if (n < 2) return [];
  if (!valid.some(c => c.invalid)) return [];

  const bounds = valid.map(c => polygonBounds(c.points!));
  const areas = valid.map(c => polygonArea(c.points!));
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (polygonsOverlapAtLeast20Pct(valid[i].points!, valid[j].points!, bounds[i], bounds[j], areas[i], areas[j])) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  const visited = new Uint8Array(n);
  const clusters: OverlapCluster[] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i] || adj[i].length === 0) continue;
    const queue = [i];
    visited[i] = 1;
    const componentIndices: number[] = [];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      componentIndices.push(curr);
      for (const next of adj[curr]) {
        if (!visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    if (componentIndices.length < 2) continue;

    const hasValid = componentIndices.some(idx => !valid[idx].invalid);
    const hasInvalid = componentIndices.some(idx => !!valid[idx].invalid);
    if (!hasValid || !hasInvalid) continue;

    const members = componentIndices
      .map(idx => ({
        chromosome: valid[idx],
        box: bounds[idx],
        centroid: polygonCentroid(valid[idx].points!),
      }))
      .sort((a, b) => {
        const dy = a.centroid.y - b.centroid.y;
        if (Math.abs(dy) > 6) return dy;
        const dx = a.centroid.x - b.centroid.x;
        if (Math.abs(dx) > 6) return dx;
        return a.chromosome.id.localeCompare(b.chromosome.id);
      });

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of members) {
      if (item.box.minX < minX) minX = item.box.minX;
      if (item.box.minY < minY) minY = item.box.minY;
      if (item.box.maxX > maxX) maxX = item.box.maxX;
      if (item.box.maxY > maxY) maxY = item.box.maxY;
    }

    const orderedMembers = members.map(item => item.chromosome);
    const clusterId = orderedMembers
      .map(c => c.id)
      .slice()
      .sort()
      .join('|');

    clusters.push({
      id: clusterId,
      members: orderedMembers,
      bounds: { minX, minY, maxX, maxY },
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    });
  }

  return clusters;
}

/** Image-space box around every chromosome, or the whole photo when none are drawn. */
function clusterBounds(chromosomes: LabelChromosome[], natural: { w: number; h: number }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chromosome of chromosomes) {
    const points = chromosome.points;
    if (!points) continue;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!Number.isFinite(minX) || natural.w <= 0 || natural.h <= 0) {
    return { minX: 0, minY: 0, maxX: natural.w, maxY: natural.h };
  }
  return {
    minX: Math.max(0, minX),
    minY: Math.max(0, minY),
    maxX: Math.min(natural.w, maxX),
    maxY: Math.min(natural.h, maxY),
  };
}

/**
 * Hit target for one non-radial chromosome on the spread. A drag starts a
 * karyotype drag of this chromosome; a click lifts it into the tray.
 * For chromosomes belonging to a valid+invalid overlap cluster, clicking opens
 * the radial wheel instead of immediately plucking.
 */
function PluckChromosomeHit({
  chromosome,
  inOverlapCluster,
  isHighlighted,
  isSiblingInActiveCluster,
  onHover,
  onOpenRadial,
  onPluck,
}: {
  chromosome: LabelChromosome;
  inOverlapCluster: boolean;
  isHighlighted: boolean;
  isSiblingInActiveCluster: boolean;
  onHover: (chromosomeId: string) => void;
  onOpenRadial: (chromosomeId: string) => void;
  onPluck: (chromosomeId: string) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: chromosome.id,
    data: chromosome,
    disabled: inOverlapCluster,
  });
  const press = useRef<{ x: number; y: number } | null>(null);
  const points = chromosome.points;
  if (!points || points.length < 3) return null;

  const onPointerDown = (event: React.PointerEvent<SVGPolygonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    press.current = { x: event.clientX, y: event.clientY };
    if (!inOverlapCluster) {
      listeners?.onPointerDown?.(event);
    }
  };

  const fill = isDragging
    ? FADED_FILL
    : isHighlighted
      ? 'rgba(14,165,233,0.35)'
      : isSiblingInActiveCluster
        ? 'rgba(14,165,233,0.16)'
        : 'transparent';

  const stroke = isDragging
    ? 'rgba(255,255,255,0.45)'
    : isHighlighted
      ? 'rgb(56,189,248)'
      : isSiblingInActiveCluster
        ? 'rgba(56,189,248,0.65)'
        : 'transparent';

  return (
    <polygon
      ref={node => setNodeRef(node as unknown as HTMLElement | null)}
      data-pluck-chromosome=""
      points={toPoints(points)}
      fill={fill}
      stroke={stroke}
      strokeWidth={isDragging ? 1 : isHighlighted ? 2 : isSiblingInActiveCluster ? 1.5 : 2}
      strokeDasharray={isSiblingInActiveCluster && !isHighlighted ? '4 3' : undefined}
      vectorEffect="non-scaling-stroke"
      className="pointer-events-auto"
      style={{ cursor: inOverlapCluster ? 'pointer' : isDragging ? 'grabbing' : 'grab' }}
      {...(inOverlapCluster ? {} : attributes)}
      {...(inOverlapCluster ? {} : listeners)}
      onPointerDown={onPointerDown}
      onPointerEnter={() => onHover(chromosome.id)}
      onPointerUp={event => {
        const origin = press.current;
        press.current = null;
        if (!origin || event.button !== 0) return;
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= CLICK_SLOP) {
          if (inOverlapCluster) {
            onOpenRadial(chromosome.id);
          } else {
            onPluck(chromosome.id);
          }
        }
      }}
    />
  );
}

/**
 * One wedge/card in the game-style radial selector wheel for overlapping outlines.
 * Supports both clicking to pluck into the tray and dragging directly to a karyotype slot.
 */
function RadialOptionItem({
  chromosome,
  angleRad,
  radiusPx,
  isHovered,
  onHover,
  onLeave,
  onPluck,
}: {
  chromosome: LabelChromosome;
  angleRad: number;
  radiusPx: number;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  onPluck: () => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: chromosome.id,
    data: chromosome,
  });
  const press = useRef<{ x: number; y: number } | null>(null);
  const x = Math.cos(angleRad) * radiusPx;
  const y = Math.sin(angleRad) * radiusPx;

  const points = chromosome.points ?? [];
  const bounds = useMemo(
    () => (points.length >= 3 ? polygonBounds(points) : { minX: 0, minY: 0, maxX: 40, maxY: 40 }),
    [points]
  );
  const polyW = Math.max(1, bounds.maxX - bounds.minX);
  const polyH = Math.max(1, bounds.maxY - bounds.minY);
  const pad = 6;

  return (
    <div
      ref={setNodeRef}
      data-overlap-ui=""
      {...attributes}
      {...listeners}
      onPointerEnter={onHover}
      onPointerLeave={onLeave}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        press.current = { x: event.clientX, y: event.clientY };
        listeners?.onPointerDown?.(event);
      }}
      onPointerUp={event => {
        const origin = press.current;
        press.current = null;
        if (!origin || event.button !== 0) return;
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <= CLICK_SLOP) {
          onPluck();
        }
      }}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        transform: `translate(-50%, -50%) scale(${isHovered ? 1.12 : 1})`,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      className={`pointer-events-auto absolute z-40 h-16 w-16 rounded-2xl border-2 p-1.5 flex items-center justify-center transition-all shadow-xl backdrop-blur-md ${
        isDragging
          ? 'opacity-40 border-sky-400 bg-slate-900/90'
          : isHovered
            ? 'border-sky-400 bg-slate-900/95 ring-4 ring-sky-400/30'
            : 'border-slate-600/80 bg-slate-900/85 hover:border-sky-400'
      }`}
    >
      {chromosome.imageUrl ? (
        <img
          src={chromosome.imageUrl}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain pointer-events-none select-none drop-shadow"
        />
      ) : (
        <svg
          viewBox={`${bounds.minX - pad} ${bounds.minY - pad} ${polyW + pad * 2} ${polyH + pad * 2}`}
          className="h-full w-full pointer-events-none"
        >
          <polygon
            points={toPoints(points)}
            fill="rgba(56,189,248,0.35)"
            stroke="rgb(56,189,248)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </div>
  );
}

/**
 * The whole metaphase spread. Drag a chromosome to move that chromosome; click
 * it to drop it in the tray. Scroll to zoom, and drag empty space to pan.
 */
export default function PluckSpreadLevel({ imageUrl, chromosomes, pluckedIds, onPluck, progress }: PluckSpreadLevelProps) {
  const veilMaskId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: PLUCK_SPREAD_DROP_ID });
  const setContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    setDropRef(node);
  };
  const innerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const press = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean; id: number } | null>(null);

  const [hoveredChromosomeId, setHoveredChromosomeId] = useState<string | null>(null);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const [radialClusterId, setRadialClusterId] = useState<string | null>(null);
  const [radialHoveredMemberId, setRadialHoveredMemberId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setNatural({ w: 0, h: 0 });
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoveredChromosomeId(null);
    setHoveredClusterId(null);
    setRadialClusterId(null);
    setRadialHoveredMemberId(null);

    if (!imageUrl) {
      setLoaded(true);
      return;
    }

    const img = new Image();
    const finish = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      }
      setLoaded(true);
    };
    img.onload = finish;
    img.onerror = () => {
      if (!cancelled) setLoaded(true);
    };
    img.src = imageUrl;
    if (img.complete) finish();
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setBox({ w: node.clientWidth, h: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const available = useMemo(
    () => chromosomes.filter(chromosome => !pluckedIds.has(chromosome.id)),
    [chromosomes, pluckedIds]
  );

  const overlapClusters = useMemo(() => buildValidInvalidOverlapClusters(available), [available]);

  const clusterByChromosomeId = useMemo(() => {
    const map = new Map<string, OverlapCluster>();
    for (const cluster of overlapClusters) {
      for (const member of cluster.members) {
        map.set(member.id, cluster);
      }
    }
    return map;
  }, [overlapClusters]);

  const openRadialCluster = useMemo(() => {
    if (!radialClusterId) return null;
    return overlapClusters.find(c => c.id === radialClusterId) ?? null;
  }, [radialClusterId, overlapClusters]);

  const activeOutlineCluster = useMemo(() => {
    if (openRadialCluster) return openRadialCluster;
    if (!hoveredClusterId) return null;
    return overlapClusters.find(c => c.id === hoveredClusterId) ?? null;
  }, [openRadialCluster, hoveredClusterId, overlapClusters]);

  useEffect(() => {
    if (radialClusterId && !overlapClusters.some(c => c.id === radialClusterId)) {
      setRadialClusterId(null);
      setRadialHoveredMemberId(null);
    }
    if (hoveredClusterId && !overlapClusters.some(c => c.id === hoveredClusterId)) {
      setHoveredClusterId(null);
    }
    if (hoveredChromosomeId && !available.some(c => c.id === hoveredChromosomeId)) {
      setHoveredChromosomeId(null);
    }
  }, [radialClusterId, hoveredClusterId, hoveredChromosomeId, overlapClusters, available]);

  useEffect(() => {
    if (!openRadialCluster) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRadialClusterId(null);
        setRadialHoveredMemberId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openRadialCluster]);

  const highlightedChromosomeId = radialHoveredMemberId ?? hoveredChromosomeId;

  const cluster = clusterBounds(chromosomes, natural);
  const clusterW = Math.max(1, cluster.maxX - cluster.minX);
  const clusterH = Math.max(1, cluster.maxY - cluster.minY);
  const availW = Math.max(1, box.w - FRAME_MARGIN * 2);
  const availH = Math.max(1, box.h - FRAME_MARGIN * 2);
  const fit = natural.w > 0 && box.w > 0 && box.h > 0 ? Math.min(availW / clusterW, availH / clusterH) : 0;
  const width = natural.w * fit;
  const height = natural.h * fit;
  const originX = box.w / 2 - ((cluster.minX + cluster.maxX) / 2) * fit;
  const originY = box.h / 2 - ((cluster.minY + cluster.maxY) / 2) * fit;

  const clampPan = (x: number, y: number, z: number) => ({
    x: Math.min(box.w - originX - 60, Math.max(-(originX + width * z) + 60, x)),
    y: Math.min(box.h - originY - 60, Math.max(-(originY + height * z) + 60, y)),
  });

  const zoomRef = useRef({ zoom, pan, originX, originY, box, width, height });
  zoomRef.current = { zoom, pan, originX, originY, box, width, height };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = zoomRef.current;
      const rect = node.getBoundingClientRect();
      const qx = event.clientX - rect.left - state.originX;
      const qy = event.clientY - rect.top - state.originY;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * Math.exp(-event.deltaY * 0.0015)));
      if (nextZoom === state.zoom) return;
      const ratio = nextZoom / state.zoom;
      if (nextZoom === MIN_ZOOM) {
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
        return;
      }
      const x = qx - (qx - state.pan.x) * ratio;
      const y = qy - (qy - state.pan.y) * ratio;
      setZoom(nextZoom);
      setPan({
        x: Math.min(state.box.w - state.originX - 60, Math.max(-(state.originX + state.width * nextZoom) + 60, x)),
        y: Math.min(state.box.h - state.originY - 60, Math.max(-(state.originY + state.height * nextZoom) + 60, y)),
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const imagePoint = (clientX: number, clientY: number) => {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * natural.w,
      y: ((clientY - rect.top) / rect.height) * natural.h,
    };
  };

  /** Convert an image-space point to container-relative screen pixels. */
  const toScreenPoint = (pt: Point) => {
    const scale = fit * zoom;
    return {
      x: originX + pan.x + pt.x * scale,
      y: originY + pan.y + pt.y * scale,
    };
  };

  const updateHoverFromPointer = (clientX: number, clientY: number) => {
    if (openRadialCluster) return;
    const pt = imagePoint(clientX, clientY);
    if (!pt) return;
    const hits = hitsAtPoint(pt, available);
    if (hits.length === 0) {
      setHoveredChromosomeId(null);
      setHoveredClusterId(null);
      return;
    }

    const hitCluster = hits.map(h => clusterByChromosomeId.get(h.id)).find((c): c is OverlapCluster => !!c);
    setHoveredClusterId(hitCluster ? hitCluster.id : null);
    setHoveredChromosomeId(hits[0].id);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (
      event.target instanceof Element &&
      (event.target.closest('[data-pluck-chromosome]') || event.target.closest('[data-overlap-ui]'))
    ) {
      return;
    }
    press.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (current && current.id === event.pointerId) {
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
        current.moved = true;
        if (zoom > MIN_ZOOM) setPanning(true);
      }
      if (current.moved && zoom > MIN_ZOOM) {
        setPan(clampPan(current.panX + dx, current.panY + dy, zoom));
      }
      return;
    }
    if (event.target instanceof Element && event.target.closest('[data-overlap-ui]')) return;
    updateHoverFromPointer(event.clientX, event.clientY);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (!current || current.id !== event.pointerId) return;
    press.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.moved) return;

    if (openRadialCluster) {
      setRadialClusterId(null);
      setRadialHoveredMemberId(null);
      return;
    }

    const point = imagePoint(event.clientX, event.clientY);
    if (!point) return;
    const hits = hitsAtPoint(point, available);
    if (hits.length > 0) {
      const hitCluster = hits.map(h => clusterByChromosomeId.get(h.id)).find((c): c is OverlapCluster => !!c);
      if (hitCluster) {
        setRadialClusterId(hitCluster.id);
        setRadialHoveredMemberId(null);
        return;
      }
      onPluck(hits[0].id);
      return;
    }
    const fallbackHit = hitChromosome(point, available);
    if (fallbackHit) {
      const hitCluster = clusterByChromosomeId.get(fallbackHit.id);
      if (hitCluster) {
        setRadialClusterId(hitCluster.id);
        setRadialHoveredMemberId(null);
      } else {
        onPluck(fallbackHit.id);
      }
    }
  };

  const orderedAvailable = useMemo(() => {
    const list = available
      .filter(chromosome => chromosome.points && chromosome.points.length >= 3)
      .slice();

    list.sort((a, b) => {
      if (a.id === highlightedChromosomeId) return 1;
      if (b.id === highlightedChromosomeId) return -1;
      return polygonArea(b.points!) - polygonArea(a.points!);
    });
    return list;
  }, [available, highlightedChromosomeId]);

  const activeClusterMembersSet = useMemo(() => {
    if (!activeOutlineCluster) return new Set<string>();
    return new Set(activeOutlineCluster.members.map(m => m.id));
  }, [activeOutlineCluster]);

  const radialCenterScreen = useMemo(() => {
    if (!openRadialCluster || box.w === 0 || box.h === 0) return null;
    const pt = toScreenPoint(openRadialCluster.center);
    const maxAllowedRadius = Math.max(54, Math.min(box.w, box.h) / 2 - 48);
    const desiredRadius = openRadialCluster.members.length > 5 ? 92 : 78;
    const radius = Math.min(desiredRadius, maxAllowedRadius);
    const itemHalf = 36; // 64px card / 2 + 4px breathing room
    const padX = Math.min(box.w / 2, radius + itemHalf + 12);
    const padYTop = Math.min(box.h / 2, radius + itemHalf + 40);
    const padYBottom = Math.min(box.h / 2, radius + itemHalf + 36);
    return {
      left: Math.max(padX, Math.min(box.w - padX, pt.x)),
      top: Math.max(padYTop, Math.min(box.h - padYBottom, pt.y)),
      radius,
    };
  }, [openRadialCluster, box.w, box.h, fit, zoom, originX, originY, pan.x, pan.y]);

  return (
    <div
      ref={setContainerRef}
      data-pluck-spread=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (!openRadialCluster) {
          setHoveredChromosomeId(null);
          setHoveredClusterId(null);
        }
      }}
      className={`relative h-full w-full min-h-[220px] overflow-hidden rounded-2xl bg-slate-900 touch-none select-none${isOver ? ' ring-2 ring-inset ring-sky-400' : ''}`}
      style={{ cursor: panning ? 'grabbing' : zoom > MIN_ZOOM ? 'grab' : 'default' }}
    >
      {!loaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Loader className="h-8 w-8 animate-spin text-sky-400" />
        </div>
      )}
      <div
        ref={innerRef}
        className="absolute"
        style={{
          left: originX,
          top: originY,
          width,
          height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <img
          src={imageUrl}
          alt="Metaphase spread"
          draggable={false}
          onLoad={event => {
            setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight });
            setLoaded(true);
          }}
          className="absolute inset-0 h-full w-full pointer-events-none"
        />
        {loaded && natural.w > 0 && (
          <svg
            className="absolute inset-0 h-full w-full pointer-events-none"
            viewBox={`0 0 ${natural.w} ${natural.h}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              <mask id={veilMaskId} maskUnits="userSpaceOnUse" x={0} y={0} width={natural.w} height={natural.h}>
                <rect x={0} y={0} width={natural.w} height={natural.h} fill="black" />
                {chromosomes.map(chromosome => {
                  if (!chromosome.points || chromosome.points.length < 3) return null;
                  if (!pluckedIds.has(chromosome.id)) return null;
                  return (
                    <polygon
                      key={`mask-plucked-${chromosome.id}`}
                      points={toPoints(chromosome.points)}
                      fill="white"
                    />
                  );
                })}
                {available.map(chromosome => {
                  if (!chromosome.points || chromosome.points.length < 3) return null;
                  return (
                    <polygon
                      key={`mask-avail-${chromosome.id}`}
                      points={toPoints(chromosome.points)}
                      fill="black"
                    />
                  );
                })}
              </mask>
            </defs>

            {/* Masked white veil over plucked regions that does not obscure unplucked crossing chromosomes */}
            <rect
              x={0}
              y={0}
              width={natural.w}
              height={natural.h}
              fill={FADED_FILL}
              mask={`url(#${veilMaskId})`}
            />

            {/* Subtle dashed contour on plucked outlines */}
            {chromosomes.map(chromosome => {
              if (!chromosome.points || chromosome.points.length < 3) return null;
              if (!pluckedIds.has(chromosome.id)) return null;
              return (
                <polygon
                  key={`plucked-stroke-${chromosome.id}`}
                  points={toPoints(chromosome.points)}
                  fill="none"
                  stroke="rgba(255,255,255,0.55)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {orderedAvailable.map(chromosome => {
              const cl = clusterByChromosomeId.get(chromosome.id);
              const inActiveCluster = activeClusterMembersSet.has(chromosome.id);
              const isHighlighted = openRadialCluster
                ? radialHoveredMemberId
                  ? chromosome.id === radialHoveredMemberId
                  : inActiveCluster
                : cl
                  ? inActiveCluster
                  : chromosome.id === hoveredChromosomeId;
              return (
                <PluckChromosomeHit
                  key={chromosome.id}
                  chromosome={chromosome}
                  inOverlapCluster={!!cl}
                  isHighlighted={isHighlighted}
                  isSiblingInActiveCluster={inActiveCluster && !isHighlighted}
                  onHover={chromId => {
                    if (openRadialCluster) return;
                    const hitCl = clusterByChromosomeId.get(chromId);
                    setHoveredClusterId(hitCl ? hitCl.id : null);
                    setHoveredChromosomeId(chromId);
                  }}
                  onOpenRadial={chromId => {
                    const hitCl = clusterByChromosomeId.get(chromId);
                    if (hitCl) {
                      setRadialClusterId(hitCl.id);
                      setRadialHoveredMemberId(null);
                    }
                  }}
                  onPluck={onPluck}
                />
              );
            })}
          </svg>
        )}
      </div>

      {/* Game-style Radial Selector Wheel when an overlapping cluster (>=20% valid+invalid overlap) is clicked */}
      {loaded && openRadialCluster && radialCenterScreen && (
        <div
          data-overlap-ui=""
          style={{
            left: radialCenterScreen.left,
            top: radialCenterScreen.top,
            width: 0,
            height: 0,
          }}
          className="absolute z-30 pointer-events-none"
        >
          {/* Radial wheel ring and spokes */}
          <svg
            width={(radialCenterScreen.radius + 44) * 2}
            height={(radialCenterScreen.radius + 44) * 2}
            viewBox={`${-(radialCenterScreen.radius + 44)} ${-(radialCenterScreen.radius + 44)} ${(radialCenterScreen.radius + 44) * 2} ${(radialCenterScreen.radius + 44) * 2}`}
            style={{
              left: -(radialCenterScreen.radius + 44),
              top: -(radialCenterScreen.radius + 44),
            }}
            className="absolute pointer-events-none overflow-visible"
          >
            <circle
              cx={0}
              cy={0}
              r={radialCenterScreen.radius}
              fill="rgba(15, 23, 42, 0.45)"
              stroke="rgba(56, 189, 248, 0.55)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            {openRadialCluster.members.map((member, index) => {
              const angle = -Math.PI / 2 + (index * 2 * Math.PI) / openRadialCluster.members.length;
              const x = Math.cos(angle) * radialCenterScreen.radius;
              const y = Math.sin(angle) * radialCenterScreen.radius;
              const isSelected = radialHoveredMemberId === member.id;
              return (
                <line
                  key={`spoke-${member.id}`}
                  x1={0}
                  y1={0}
                  x2={x}
                  y2={y}
                  stroke={isSelected ? 'rgb(56, 189, 248)' : 'rgba(148, 163, 184, 0.35)'}
                  strokeWidth={isSelected ? 2 : 1}
                />
              );
            })}
          </svg>

          {/* Center close hub */}
          <button
            type="button"
            data-overlap-ui=""
            onPointerDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              setRadialClusterId(null);
              setRadialHoveredMemberId(null);
            }}
            title="Close selector"
            className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 bg-slate-900/95 text-slate-300 shadow-lg hover:border-sky-400 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Radial draggable/clickable chromosome slots */}
          {openRadialCluster.members.map((member, index) => {
            const angle = -Math.PI / 2 + (index * 2 * Math.PI) / openRadialCluster.members.length;
            return (
              <RadialOptionItem
                key={member.id}
                chromosome={member}
                angleRad={angle}
                radiusPx={radialCenterScreen.radius}
                isHovered={radialHoveredMemberId === member.id}
                onHover={() => setRadialHoveredMemberId(member.id)}
                onLeave={() =>
                  setRadialHoveredMemberId(current => (current === member.id ? null : current))
                }
                onPluck={() => {
                  onPluck(member.id);
                }}
              />
            );
          })}
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-slate-900/80 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
        {progress.plucked} / {progress.total} plucked
      </div>
      {zoom > MIN_ZOOM && (
        <button
          type="button"
          data-overlap-ui=""
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation();
            setZoom(MIN_ZOOM);
            setPan({ x: 0, y: 0 });
          }}
          className="absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/85 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-md backdrop-blur hover:border-sky-400 hover:bg-slate-900 transition-colors"
          title="Reset zoom to starting view"
        >
          <RotateCcw className="h-3 w-3 text-sky-400" />
          Reset Zoom
        </button>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-slate-900/70 px-2 py-1 text-[10px] font-medium text-slate-200">
        Drag a chromosome to move it, or click overlapping chromosomes to open the radial selector.
      </div>
    </div>
  );
}
