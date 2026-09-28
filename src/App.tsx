/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { Session } from '@supabase/supabase-js';
import { 
  DndContext, 
  DragOverlay, 
  useDraggable, 
  useDroppable,
  DragStartEvent,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  TouchSensor,
  MouseSensor,
  pointerWithin,
  closestCenter,
  type CollisionDetection
} from '@dnd-kit/core';
import { cn } from './lib/utils';
import { NonInteractivePointerSensor, NonInteractiveTouchSensor } from './lib/dndSensors';
import { storageObjectPathFromPublicUrl } from './lib/imageUrl';
import { CLINICAL_KARYOTYPE_ROWS, normalizePairId, comparePairIds, MAX_CHROMOSOMES_PER_PAIR, STANDARD_PAIR_IDS } from './lib/chromosomePairs';
import { normalizeRotation, rotationsMatch, chromosomeTransform } from './lib/orientation';
import { cropBoundsFromPoints, uniformDisplayScale } from './lib/chromosomeCrop';
import {
  type AnnotationStatus,
  countLabeledChromosomes,
  getAnnotationStatus,
} from './lib/annotationStatus';
import { motion, AnimatePresence } from 'motion/react';
import {
  Info, CheckCircle2, ChevronRight, Dna, Undo2, ArrowLeft, Lightbulb,
  ShieldCheck, Upload, Play, Beaker, X, Loader, ImageIcon, Zap, Pencil, Trash2, FlipHorizontal, FlipVertical, Expand, Download, FolderPlus, Folder
} from 'lucide-react';
import KaryotypeHintModal, { type KaryotypeHintChromosome } from './components/KaryotypeHintModal';

// --- Types ---

// A pair ID is either one of the 24 standard chromosome types (1-22, X, Y) or
// a custom name typed by a cytogeneticist for a particular sample. Order no
// longer has any meaning - any chromosome belonging to a pair is
// interchangeable with any other, as long as its own orientation matches.
type ChromosomeType = string;

/** Longest crop edge in the raw tray, board, and drag preview, in CSS pixels. */
const CHROMOSOME_DISPLAY_MAX_EDGE = 72;

interface ChromosomeData {
  id: string;
  type: ChromosomeType;
  ordinal: number; // display-only position within the pair; never used for matching
  size: number; // visual scale factor
  banding: number[]; // relative positions/widths of bands
  imageUrl?: string;
  width?: number;
  height?: number;
  expectedRotation?: number;
  expectedFlipX?: boolean;
  expectedFlipY?: boolean;
  userRotation?: number;
  userFlipX?: boolean;
  userFlipY?: boolean;
}

interface SavedChromosomeState {
  id: string;
  userRotation: number;
  userFlipX: boolean;
  userFlipY: boolean;
}

interface SavedKaryotypeState {
  jumbled: SavedChromosomeState[];
  placed: Record<string, SavedChromosomeState>;
}

interface KaryotypeProgressSummary {
  status: 'in_progress' | 'complete';
  correctCount: number;
  totalCount: number;
}

const CHROMOSOME_TYPES: ChromosomeType[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', 'X', 'Y'
];

// Mock sizes (Chromosomes are generally ordered from largest to smallest, 1 is biggest, 22 smallest)
const SIZE_MAP: Record<string, number> = {
  '1': 1.0, '2': 0.95, '3': 0.85, '4': 0.82, '5': 0.8, '6': 0.75, '7': 0.72, '8': 0.68,
  '9': 0.65, '10': 0.63, '11': 0.62, '12': 0.6, '13': 0.55, '14': 0.52, '15': 0.5,
  '16': 0.48, '17': 0.45, '18': 0.42, '19': 0.35, '20': 0.33, '21': 0.28, '22': 0.25,
  'X': 0.7, 'Y': 0.3
};
const DEFAULT_PAIR_SIZE = 0.6;
const getPairSize = (pairId: string) => SIZE_MAP[pairId] ?? DEFAULT_PAIR_SIZE;

// --- Helpers ---

const generateBanding = (seed: string) => {
  const bands = [];
  let current = 0;
  // Simple deterministic generation for consistent look
  for (let i = 0; i < 6; i++) {
    const width = 5 + (seed.charCodeAt(i % seed.length) % 15);
    bands.push(width);
  }
  return bands;
};

const createInitialChromosomes = (): ChromosomeData[] => {
  const chromosomes: ChromosomeData[] = [];
  CHROMOSOME_TYPES.forEach((type) => {
    // Add two of each (for simplicity we include 2 Ys even if not biological, 
    // or we could adjust for sex, but prompt says "24 pairs where player can drag")
    for (let i = 0; i < 2; i++) {
        chromosomes.push({
          id: `${type}-${i}`,
          type,
          ordinal: i,
          size: getPairSize(type),
          banding: generateBanding(type + i)
        });
    }
  });
  return chromosomes;
};

const annotationSignature = (xml?: string) => {
  let hash = 2166136261;
  const value = xml || '';
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const shuffleChromosomes = (chromosomes: ChromosomeData[], seed: string) => {
  const shuffled = [...chromosomes];
  let state = parseInt(annotationSignature(seed), 16) || 1;
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const serializeChromosome = (chromosome: ChromosomeData): SavedChromosomeState => ({
  id: chromosome.id,
  userRotation: normalizeRotation(chromosome.userRotation),
  userFlipX: !!chromosome.userFlipX,
  userFlipY: !!chromosome.userFlipY,
});

const serializeKaryotypeState = (
  jumbled: ChromosomeData[],
  placed: Record<string, ChromosomeData>,
): SavedKaryotypeState => ({
  jumbled: jumbled.map(serializeChromosome),
  placed: Object.fromEntries(
    Object.entries(placed).map(([slotId, chromosome]) => [slotId, serializeChromosome(chromosome)])
  ),
});

const hydrateKaryotypeState = (
  extracted: ChromosomeData[],
  saved: unknown,
): { jumbled: ChromosomeData[]; placed: Record<string, ChromosomeData> } | null => {
  if (!saved || typeof saved !== 'object') return null;
  const candidate = saved as Partial<SavedKaryotypeState>;
  if (!Array.isArray(candidate.jumbled) || !candidate.placed || typeof candidate.placed !== 'object') return null;

  const byId = new Map(extracted.map(chromosome => [chromosome.id, chromosome]));
  const used = new Set<string>();
  const restore = (value: SavedChromosomeState): ChromosomeData | null => {
    if (!value || typeof value.id !== 'string' || used.has(value.id)) return null;
    const original = byId.get(value.id);
    if (!original) return null;
    used.add(value.id);
    return {
      ...original,
      userRotation: normalizeRotation(Number(value.userRotation) || 0),
      userFlipX: !!value.userFlipX,
      userFlipY: !!value.userFlipY,
    };
  };

  const jumbled: ChromosomeData[] = [];
  for (const value of candidate.jumbled) {
    const restored = restore(value);
    if (!restored) return null;
    jumbled.push(restored);
  }

  const placed: Record<string, ChromosomeData> = {};
  for (const [slotId, value] of Object.entries(candidate.placed)) {
    const restored = restore(value);
    if (!restored) return null;
    placed[slotId] = restored;
  }

  return used.size === extracted.length ? { jumbled, placed } : null;
};

// --- Components ---

const ChromosomeVisual = ({ chromosome, className, isDragging = false, isReviewing = false, displayScale = 1 }: { chromosome: ChromosomeData, className?: string, isDragging?: boolean, isReviewing?: boolean, displayScale?: number }) => {
  if (chromosome.imageUrl) {
    const displayWidth = (chromosome.width ?? 0) * displayScale;
    const displayHeight = (chromosome.height ?? 0) * displayScale;
    const sized = displayWidth > 0 && displayHeight > 0;
    return (
      <div 
        className={cn(
          "relative flex flex-col items-center justify-end p-1 cursor-grab active:cursor-grabbing group",
          isDragging && "opacity-50",
          className
        )}
      >
        <img 
          src={chromosome.imageUrl} 
          className={cn(
            "block print:!drop-shadow-none print:!filter-none",
            !sized && "max-h-[72px] max-w-[36px] object-contain",
            !isReviewing && "drop-shadow-md filter group-hover:drop-shadow-lg transition-shadow"
          )}
          draggable={false}
          alt={chromosome.type}
          style={{
            width: sized ? displayWidth : undefined,
            height: sized ? displayHeight : undefined,
            transform: chromosomeTransform(chromosome.userRotation, chromosome.userFlipX, chromosome.userFlipY),
          }}
        />
        {!isDragging && !isReviewing && (
          <div className="absolute -bottom-5 text-[10px] font-mono text-slate-400 opacity-0 hover:opacity-100 transition-opacity print:hidden">
            {chromosome.type}#{chromosome.ordinal + 1}
          </div>
        )}
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "relative flex flex-col items-center justify-center p-1 cursor-grab active:cursor-grabbing",
        isDragging && "opacity-50",
        className
      )}
      style={{ height: `${chromosome.size * 100}px`, width: '24px' }}
    >
      {/* Centromere/Structure */}
      <div className={cn("absolute top-1/3 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-slate-900 z-10 print:!border-none", isReviewing && "hidden")} />
      
      <div className={cn(
        "flex flex-col w-4 h-full rounded-full bg-slate-100 overflow-hidden print:!border-none print:!shadow-none",
        !isReviewing ? "border-2 border-slate-800 shadow-sm" : "border-none shadow-none"
      )}>
        {chromosome.banding.map((width, i) => (
          <div 
            key={i} 
            className={cn("w-full opacity-70", i % 2 === 0 ? "bg-slate-900" : "bg-slate-300")} 
            style={{ height: `${width}%` }} 
          />
        ))}
      </div>
      
      {!isDragging && !isReviewing && (
        <div className="absolute -bottom-5 text-[10px] font-mono text-slate-400 opacity-0 hover:opacity-100 transition-opacity print:hidden">
          {chromosome.id}
        </div>
      )}
    </div>
  );
};

const DraggableChromosome = ({ id, chromosome, onUpdate, isReviewing, displayScale }: { id: string, chromosome: ChromosomeData, onUpdate?: (id: string, updates: Partial<ChromosomeData>) => void, isReviewing?: boolean, displayScale?: number }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id,
    data: chromosome,
  });

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  return (
    <div className="relative group/chrom">
      <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="z-10">
        <ChromosomeVisual chromosome={chromosome} isDragging={isDragging} isReviewing={isReviewing} displayScale={displayScale} />
      </div>
      {onUpdate && chromosome.imageUrl && !isDragging && !isReviewing && (
        <div
          className="absolute -top-11 left-1/2 -translate-x-1/2 bg-white border border-slate-200 shadow-lg rounded-lg px-2 py-1.5 flex items-center gap-1.5 z-50 opacity-0 group-hover/chrom:opacity-100 focus-within:opacity-100 hover:opacity-100 transition-opacity cursor-default print:hidden"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={normalizeRotation(chromosome.userRotation)}
            aria-label="Rotate chromosome"
            onChange={(e) => onUpdate(id, { userRotation: Number(e.target.value) })}
            className="w-20 h-1.5 accent-sky-500 cursor-pointer"
          />
          <span className="text-[9px] font-mono text-slate-500 w-7 tabular-nums">{normalizeRotation(chromosome.userRotation)}°</span>
          <button
            onClick={(e) => { e.stopPropagation(); onUpdate(id, { userFlipX: !chromosome.userFlipX }); }}
            aria-pressed={!!chromosome.userFlipX}
            title="Flip horizontally"
            className={cn(
              "p-1 rounded border transition-colors",
              chromosome.userFlipX
                ? "bg-sky-500 border-sky-500 text-white shadow-sm"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
            )}
          >
            <FlipHorizontal className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onUpdate(id, { userFlipY: !chromosome.userFlipY }); }}
            aria-pressed={!!chromosome.userFlipY}
            title="Flip vertically"
            className={cn(
              "p-1 rounded border transition-colors",
              chromosome.userFlipY
                ? "bg-sky-500 border-sky-500 text-white shadow-sm"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
            )}
          >
            <FlipVertical className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
};

const DroppableSlot = ({ id, acceptType, children, isOccupied, state, isReviewing }: { id: string, acceptType: ChromosomeType, children?: React.ReactNode, isOccupied?: boolean, state: 'empty' | 'wrong' | 'type-correct' | 'fully-correct', isReviewing?: boolean }) => {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { acceptType }
  });

  return (
    <motion.div 
      ref={setNodeRef}
      animate={!isReviewing && isOccupied && state === 'fully-correct' ? { scale: [1, 1.05, 1] } : { scale: 1 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "min-w-8 lg:min-w-10 min-h-16 flex items-end justify-center transition-all duration-200 relative group/slot print:!border-none print:!bg-transparent print:!shadow-none",
        isReviewing ? "bg-transparent" : "border-2 border-dashed rounded-lg",
        !isReviewing && (isOver ? "border-sky-500 bg-sky-50 scale-105" : "border-slate-200 bg-slate-50/50"),
        !isReviewing && isOccupied && state === 'wrong' ? "border-solid border-slate-300 bg-white" : "",
        !isReviewing && isOccupied && state === 'type-correct' ? "border-amber-400 bg-amber-50/30 shadow-[0_0_15px_rgba(251,191,36,0.1)] border-solid" : "",
        !isReviewing && isOccupied && state === 'fully-correct' ? "border-emerald-500 bg-emerald-50/30 shadow-[0_0_15px_rgba(16,185,129,0.1)] border-solid" : ""
      )}
    >
      {!isReviewing && isOccupied && state === 'fully-correct' && (
        <motion.div 
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full flex items-center justify-center z-20 shadow-sm border border-white print:hidden"
        >
          <CheckCircle2 className="w-2 h-2 text-white stroke-[4px]" />
        </motion.div>
      )}
      {children}
    </motion.div>
  );
};

const RawSampleDroppable = ({ id, children }: { id: string, children: React.ReactNode }) => {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef} className="h-full min-h-0">{children}</div>;
};

interface KaryotypePairProps {
  pairId: string;
  slotIds: string[];
  placedChromosomes: Record<string, ChromosomeData>;
  onUpdateChromosome: (slotId: string, updates: Partial<ChromosomeData>) => void;
  isReviewing?: boolean;
  displayScale?: number;
}

/**
 * Renders one pair's group of slots (1-4, dynamically sized to however many
 * chromosomes were annotated for this pair). Order within the group carries
 * no meaning - any chromosome belonging to this pair is valid in any of its
 * slots, as long as its own recorded orientation matches.
 */
const KaryotypePair: React.FC<KaryotypePairProps> = ({ pairId, slotIds, placedChromosomes, onUpdateChromosome, isReviewing, displayScale }) => {
  const getSlotState = (chrom: ChromosomeData | undefined): 'empty' | 'wrong' | 'type-correct' | 'fully-correct' => {
    if (!chrom) return 'empty';
    if (chrom.type !== pairId) return 'wrong';

    if (chrom.imageUrl) {
      if (rotationsMatch(chrom.userRotation, chrom.expectedRotation) && 
          chrom.userFlipX === chrom.expectedFlipX && 
          chrom.userFlipY === chrom.expectedFlipY) {
        return 'fully-correct';
      }
      return 'type-correct';
    }
    // Mock data is always fully correct if type matches
    return 'fully-correct';
  };

  const slots: { slotId: string; chrom: ChromosomeData | undefined; state: 'empty' | 'wrong' | 'type-correct' | 'fully-correct' }[] = slotIds.map(slotId => {
    const chrom = placedChromosomes[slotId];
    return { slotId, chrom, state: getSlotState(chrom) };
  });

  const allCorrect = slots.length > 0 && slots.every(s => !!s.chrom && s.state === 'fully-correct');

  return (
    <div className={cn("flex flex-col items-center gap-1 p-1 lg:p-2 rounded-xl transition-colors group", !isReviewing && "hover:bg-slate-100/50")}>
      <div className="flex items-end gap-1">
        {slots.map(({ slotId, chrom, state }) => (
          <div key={slotId}>
            <DroppableSlot id={slotId} acceptType={pairId} isOccupied={!!chrom} state={state} isReviewing={isReviewing}>
              {chrom && <DraggableChromosome id={chrom.id} chromosome={chrom} onUpdate={(id, updates) => onUpdateChromosome(slotId, updates)} isReviewing={isReviewing} displayScale={displayScale} />}
            </DroppableSlot>
          </div>
        ))}
      </div>
      <span className={cn(
        "text-xs font-bold font-mono transition-colors print:!text-slate-900",
        !isReviewing && allCorrect ? "text-emerald-600" : (!isReviewing ? "text-slate-500 group-hover:text-sky-600" : "text-slate-900")
      )}>
        {pairId}
      </span>
    </div>
  );
};

interface WelcomeScreenProps {
  onStart: () => void;
  onAdmin: () => void;
  onSignOut?: () => void;
  userRole: 'SUPER ADMIN' | 'ADMIN' | 'USER' | null;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onStart, onAdmin, onSignOut, userRole }) => (
  <motion.div 
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    className="fixed inset-0 z-[100] bg-white flex items-center justify-center p-6 overflow-hidden"
  >
    {onSignOut && (
      <button 
        onClick={onSignOut}
        className="absolute top-6 right-6 z-50 text-slate-400 hover:text-slate-900 transition-colors text-xs font-bold tracking-widest uppercase flex items-center gap-2 bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg"
      >
        Sign Out
      </button>
    )}
    <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[radial-gradient(#000_1px,transparent_1px)] [background-size:24px_24px]" />
    
    <div className="max-w-2xl w-full text-center relative z-10">
      <motion.div
         initial={{ scale: 0.8, y: 20 }}
         animate={{ scale: 1, y: 0 }}
         className="flex items-center justify-center mx-auto mb-8 relative"
      >
        <motion.img 
          src="/logo.png" 
          alt="Chromosome"
          className="w-32 h-32 object-contain drop-shadow-md"
          animate={{ 
            y: [-8, 8, -8],
            rotate: [-4, 4, -4]
          }}
          transition={{ 
            duration: 4,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </motion.div>
      
      <h1 className="text-6xl font-black text-slate-900 tracking-tighter mb-4">
        Chromy.
      </h1>
      <p className="text-slate-500 text-lg mb-12 font-medium tracking-tight">
        An interactive laboratory simulation designed for cytogeneticists to master the art of karyotyping and chromosomal identification.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12 text-left">
        {[
          { icon: <Info className="w-5 h-5" />, title: "Analyze", text: "Examine banding patterns and morphology." },
          { icon: <Beaker className="w-5 h-5" />, title: "Classify", text: "Pair chromosomes into the official karyogram." },
          { icon: <CheckCircle2 className="w-5 h-5" />, title: "Verify", text: "Achieve 100% accuracy in your diagnosis." }
        ].map((feature, i) => (
          <div key={i} className="bg-slate-50 border border-slate-100 p-4 rounded-2xl">
            <div className="text-slate-900 mb-2">{feature.icon}</div>
            <h3 className="text-slate-900 font-bold text-sm mb-1">{feature.title}</h3>
            <p className="text-xs text-slate-400 leading-relaxed">{feature.text}</p>
          </div>
        ))}
      </div>

      <button 
        onClick={onStart}
        className="group flex items-center gap-3 bg-slate-900 text-white px-8 py-4 rounded-xl font-black text-base hover:scale-105 transition-all shadow-xl shadow-slate-900/20 active:scale-95 mx-auto"
      >
        Start Karyotyping <Play className="w-4 h-4 fill-current" />
      </button>

      {(userRole === 'ADMIN' || userRole === 'SUPER ADMIN') && (
        <button 
          onClick={onAdmin}
          className="mt-8 text-slate-300 hover:text-slate-900 transition-colors text-xs font-mono tracking-widest uppercase flex items-center gap-2 mx-auto"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> ADMIN ACCESS
        </button>
      )}
    </div>
  </motion.div>
);

/** Cheap, synchronous check for whether a sample has at least one annotated (non-"Unassigned") stroke, without loading its image. */
export const hasAnnotations = (xml?: string): boolean => {
  if (!xml) return false;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const strokeEls = doc.querySelectorAll('stroke');
    for (const el of Array.from(strokeEls)) {
      const label = el.getAttribute('label');
      if (label && label !== 'Unassigned') return true;
    }
    return false;
  } catch {
    return false;
  }
};

export const extractChromosomes = async (imgObj: AdminImage): Promise<ChromosomeData[]> => {
  try {
    if (!imgObj.xml) return [];
    const xmlText = imgObj.xml;
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const strokeEls = doc.querySelectorAll('stroke');
    
    if (strokeEls.length === 0) return [];
    
    const imgUrl = imgObj.originalUrl;
    if (!imgUrl) return [];

    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imgUrl;
    });

    const extracted: ChromosomeData[] = [];
    const ordinalByPair = new Map<string, number>();
    
    strokeEls.forEach((el, idx) => {
      const label = el.getAttribute('label') || 'Unassigned';
      if (label === 'Unassigned') return;
      // Normalizes both new-style labels (the pair ID itself, e.g. "1", "X",
      // "Marker A") and legacy labels saved before this change (e.g. "1L",
      // "1R") to a single pair ID used for interchangeable matching.
      const pairId = normalizePairId(label);
      const ordinal = ordinalByPair.get(pairId) || 0;
      ordinalByPair.set(pairId, ordinal + 1);

      const rotation = normalizeRotation(parseFloat(el.getAttribute('rotation') || '0'));
      const flipX = el.getAttribute('flipX') === 'true';
      const flipY = el.getAttribute('flipY') === 'true';

      const pointEls = el.querySelectorAll('point');
      if (pointEls.length < 3) return;
      
      const points = Array.from(pointEls).map(p => ({
        x: parseFloat(p.getAttribute('x') || '0'),
        y: parseFloat(p.getAttribute('y') || '0')
      }));
      
      const bounds = cropBoundsFromPoints(points, img.naturalWidth, img.naturalHeight);
      if (!bounds) return;

      const { minX, minY, width: w, height: h } = bounds;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.beginPath();
      ctx.moveTo(points[0].x - minX, points[0].y - minY);
      for(let i=1; i<points.length; i++) {
        ctx.lineTo(points[i].x - minX, points[i].y - minY);
      }
      ctx.closePath();
      ctx.clip();
      
      ctx.drawImage(img, minX, minY, w, h, 0, 0, w, h);
      
      extracted.push({
        id: `chrom-${idx}`,
        type: pairId,
        ordinal,
        size: 1,
        banding: [],
        imageUrl: canvas.toDataURL('image/png'),
        width: w,
        height: h,
        expectedRotation: rotation,
        expectedFlipX: flipX,
        expectedFlipY: flipY,
        userRotation: 0,
        userFlipX: false,
        userFlipY: false
      });
    });

    // Defensively cap each pair at MAX_CHROMOSOMES_PER_PAIR in case older or
    // malformed annotations exceeded it.
    const seenCounts = new Map<string, number>();
    const capped: ChromosomeData[] = [];
    for (const chrom of extracted) {
      const count = seenCounts.get(chrom.type) || 0;
      if (count >= MAX_CHROMOSOMES_PER_PAIR) continue;
      seenCounts.set(chrom.type, count + 1);
      capped.push(chrom);
    }

    return capped;
  } catch (e) {
    console.error("Failed to extract chromosomes", e);
    return [];
  }
};

interface Bucket {
  id: string;
  bucketNumber: number;
  name: string;
  description: string;
}

interface AdminImage {
  id: string;
  originalUrl: string;
  xml?: string;
  userId?: string;
  uploaderEmail?: string;
  bucketId?: string | null;
  karyotype?: string;
  annotationComplete?: boolean;
}

const formatBucketLabel = (bucket: Bucket) =>
  `[${bucket.bucketNumber}] ${bucket.name}`;

const BucketHeader: React.FC<{
  bucketNumber?: number;
  name: string;
  description?: string;
  sampleCount: number;
  editable?: boolean;
  onSave?: (name: string, description: string) => Promise<void>;
}> = ({ bucketNumber, name, description, sampleCount, editable, onSave }) => {
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editDescription, setEditDescription] = useState(description ?? '');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const descRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!isEditing) {
      setEditName(name);
      setEditDescription(description ?? '');
    }
  }, [name, description, isEditing]);

  useEffect(() => {
    const el = descRef.current;
    if (el && !isEditing) {
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [description, isEditing]);

  const inputClassName =
    'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition-colors';

  const handleSave = async () => {
    const trimmedName = editName.trim();
    const trimmedDescription = editDescription.trim();
    if (!trimmedName || !trimmedDescription) {
      setEditError('Bucket name and description are required.');
      return;
    }
    if (!onSave) return;

    setSaving(true);
    setEditError(null);
    try {
      await onSave(trimmedName, trimmedDescription);
      setIsEditing(false);
    } catch (err: any) {
      setEditError(err.message || 'Failed to update bucket');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditName(name);
    setEditDescription(description ?? '');
    setEditError(null);
    setIsEditing(false);
  };

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-mono font-bold text-slate-400 tracking-widest uppercase">
          {bucketNumber !== undefined ? `Bucket ${bucketNumber}` : 'Unassigned'}
        </span>
        <div className="flex items-center gap-2">
          {editable && !isEditing && onSave && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-700 transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
          )}
          <span className="text-[10px] font-mono font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-md">
            {sampleCount} {sampleCount === 1 ? 'Sample' : 'Samples'}
          </span>
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase">Bucket Name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={inputClassName}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase">Description</label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={3}
              className={cn(inputClassName, 'resize-none')}
            />
          </div>
          {editError && (
            <p className="text-xs text-red-600 font-medium">{editError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 rounded-xl bg-slate-900 text-white py-2 text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="flex-1 rounded-xl border border-slate-300 text-slate-600 py-2 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <h4 className="font-black text-slate-800 text-base leading-snug tracking-tight">
            {name}
          </h4>
          {description && (
            <div className="mt-1">
              <p
                ref={descRef}
                className={cn(
                  "text-xs text-slate-500 leading-relaxed",
                  !expanded && "line-clamp-1"
                )}
              >
                {description}
              </p>
              {(isClamped || expanded) && (
                <button
                  type="button"
                  onClick={() => setExpanded(v => !v)}
                  className="mt-0.5 text-[10px] font-bold text-slate-400 hover:text-slate-700 transition-colors"
                >
                  {expanded ? 'Show less ↑' : 'Show more ↓'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

import ImageAnnotationModal from './components/ImageAnnotationModal';
import { LazyThumb } from './components/LazyThumb';
import { ConfirmDeleteSampleModal } from './components/ConfirmDeleteSampleModal';

interface AdminPanelProps {
  onClose: () => void;
  images: AdminImage[];
  imagesLoaded: boolean;
  setImages: React.Dispatch<React.SetStateAction<AdminImage[]>>;
  session: Session | null;
  userRole: 'SUPER ADMIN' | 'ADMIN' | 'USER' | null;
}

function useFirstSpreadLoaded(images: AdminImage[], metadataLoaded: boolean) {
  const firstImageUrl = images[0]?.originalUrl;
  const [firstSpreadLoaded, setFirstSpreadLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!metadataLoaded) {
      setFirstSpreadLoaded(false);
      return;
    }

    if (!firstImageUrl) {
      setFirstSpreadLoaded(true);
      return;
    }

    setFirstSpreadLoaded(false);
    const image = new Image();
    const finish = () => {
      if (!cancelled) setFirstSpreadLoaded(true);
    };
    image.onload = finish;
    // Do not leave the panel permanently blocked by an unavailable spread.
    image.onerror = finish;
    image.src = firstImageUrl;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [firstImageUrl, metadataLoaded]);

  return metadataLoaded && firstSpreadLoaded;
}

/** Prefer the bucket under the pointer; fall back to nearest list row only when needed. */
const bucketListCollisionDetection: CollisionDetection = (args) => {
  const listContainers = args.droppableContainers.filter(({ id }) =>
    String(id).startsWith('list-')
  );
  const scoped = { ...args, droppableContainers: listContainers };

  const pointerHits = pointerWithin(scoped);
  if (pointerHits.length > 0) return pointerHits;

  // Only use closest-center when the pointer is within a few px of a row (gaps),
  // so we never jump to a distant neighbor.
  const nearby = closestCenter(scoped).filter(({ id }) => {
    const rect = args.droppableRects.get(id);
    const pointer = args.pointerCoordinates;
    if (!rect || !pointer) return false;
    const pad = 6;
    return (
      pointer.x >= rect.left - pad &&
      pointer.x <= rect.right + pad &&
      pointer.y >= rect.top - pad &&
      pointer.y <= rect.bottom + pad
    );
  });
  return nearby;
};

const DraggableDatasetImage: React.FC<{
  img: AdminImage;
  children: React.ReactNode;
}> = ({
  img,
  children
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `dataset-${img.id}`,
    data: {
      imageId: img.id,
      currentBucketId: img.bucketId ?? null
    }
  });

  // Keep the source in place; DragOverlay follows the pointer so collision
  // detection isn't polluted by the sample card's large bounding box.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "touch-none",
        isDragging ? "opacity-30 cursor-grabbing" : "cursor-grab"
      )}
    >
      {children}
    </div>
  );
};

const BucketFolder = ({
  bucket,
  sampleCount,
  editable,
  onUpdate,
  children
}: {
  bucket: Bucket;
  sampleCount: number;
  editable?: boolean;
  onUpdate?: (name: string, description: string) => Promise<void>;
  children: React.ReactNode;
}) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <BucketHeader
      bucketNumber={bucket.bucketNumber}
      name={bucket.name}
      description={bucket.description}
      sampleCount={sampleCount}
      editable={editable}
      onSave={onUpdate}
    />
    {children}
  </div>
);

const UnassignedFolder = ({
  sampleCount,
  children
}: {
  sampleCount: number;
  children: React.ReactNode;
}) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <BucketHeader
      name="Unassigned"
      description="Samples not yet placed in a bucket. Drag them into a bucket on the left."
      sampleCount={sampleCount}
    />
    {children}
  </div>
);

const DroppableBucketListItem: React.FC<{
  droppableId: string;
  active: boolean;
  dragging?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({
  droppableId,
  active,
  dragging,
  onClick,
  children
}) => {
  // prefix with "list-" so these IDs never duplicate BucketFolder/UnassignedFolder IDs
  const { setNodeRef, isOver } = useDroppable({ id: `list-${droppableId}` });
  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        onClick={onClick}
        className={cn(
          "w-full text-left px-3 py-3 rounded-xl transition-all flex items-center justify-between gap-2 group",
          isOver
            ? "bg-sky-500 text-white shadow-md ring-2 ring-sky-300 ring-offset-2 scale-[1.02]"
            : active
              ? "bg-slate-900 text-white"
              : dragging
                ? "bg-white border-2 border-dashed border-sky-300 text-slate-700"
                : "hover:bg-slate-200 text-slate-700"
        )}
      >
        {children}
      </button>
    </li>
  );
};

const AdminPanel: React.FC<AdminPanelProps> = ({ onClose, images, imagesLoaded, setImages, session, userRole }) => {
  const canCreateBuckets = userRole === 'SUPER ADMIN';
  const firstSpreadLoaded = useFirstSpreadLoaded(images, imagesLoaded);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<AdminImage | null>(null);
  const [karyotypeInput, setKaryotypeInput] = useState('');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [selectedBucketId, setSelectedBucketId] = useState<string>('');
  const [activeBucketId, setActiveBucketId] = useState<string | null>(null);
  const [draggingSample, setDraggingSample] = useState<AdminImage | null>(null);
  const [showCreateBucket, setShowCreateBucket] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketDescription, setNewBucketDescription] = useState('');
  const [creatingBucket, setCreatingBucket] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [annotateImageUrl, setAnnotateImageUrl] = useState<string | null>(null);
  const [annotateImageId, setAnnotateImageId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | AnnotationStatus>('all');
  const [pendingDelete, setPendingDelete] = useState<AdminImage | null>(null);
  const [deletingSample, setDeletingSample] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingLockRef = useRef(false);

  const canDeleteSample = (img: AdminImage) => {
    if (!session?.user) return false;
    if (img.userId && img.userId === session.user.id) return true;
    return userRole === 'ADMIN' || userRole === 'SUPER ADMIN';
  };

  const stopCardDrag = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  const loadBuckets = async () => {
    if (!session?.user) return;
    try {
      const { data, error } = await supabase
        .from('buckets')
        .select('*')
        .order('bucket_number', { ascending: true });

      if (error) throw error;

      const loaded = (data ?? []).map(row => ({
        id: row.id,
        bucketNumber: row.bucket_number,
        name: row.name,
        description: row.description
      }));

      setBuckets(loaded);
      if (loaded.length > 0 && !selectedBucketId) {
        setSelectedBucketId(loaded[0].id);
      }
      if (loaded.length > 0 && activeBucketId === null) {
        setActiveBucketId(loaded[0].id);
      }
    } catch (err) {
      console.error('Failed to load buckets:', err);
    }
  };

  useEffect(() => {
    loadBuckets();
  }, [session?.user?.id]);

  const imagesByBucket = buckets.reduce((acc, bucket) => {
    acc[bucket.id] = images.filter(img => img.bucketId === bucket.id);
    return acc;
  }, {} as Record<string, AdminImage[]>);

  const unassignedImages = images.filter(img => !img.bucketId);

  const handleCreateBucket = async () => {
    if (!session?.user) return;
    if (!canCreateBuckets) {
      setUploadError('Only super admins can create buckets.');
      return;
    }
    const name = newBucketName.trim();
    const description = newBucketDescription.trim();
    if (!name || !description) {
      setUploadError('Bucket name and description are required.');
      return;
    }

    setCreatingBucket(true);
    setUploadError(null);

    try {
      const { data: existing } = await supabase
        .from('buckets')
        .select('bucket_number')
        .eq('user_id', session.user.id)
        .order('bucket_number', { ascending: false })
        .limit(1);

      const nextNumber = (existing?.[0]?.bucket_number ?? 0) + 1;

      const { data, error } = await supabase
        .from('buckets')
        .insert({
          user_id: session.user.id,
          bucket_number: nextNumber,
          name,
          description
        })
        .select()
        .single();

      if (error) throw error;

      const newBucket: Bucket = {
        id: data.id,
        bucketNumber: data.bucket_number,
        name: data.name,
        description: data.description
      };

      setBuckets(prev => [...prev, newBucket].sort((a, b) => a.bucketNumber - b.bucketNumber));
      setSelectedBucketId(newBucket.id);
      setActiveBucketId(newBucket.id);
      setNewBucketName('');
      setNewBucketDescription('');
      setShowCreateBucket(false);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to create bucket');
    } finally {
      setCreatingBucket(false);
    }
  };

  const handleUpdateBucket = async (bucketId: string, name: string, description: string) => {
    const { data, error } = await supabase
      .from('buckets')
      .update({ name, description })
      .eq('id', bucketId)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new Error('Could not update bucket. You may not have permission.');

    setBuckets(prev =>
      prev.map(bucket =>
        bucket.id === bucketId
          ? { ...bucket, name: data.name, description: data.description }
          : bucket
      )
    );
  };

  const folderDragSensors = useSensors(
    useSensor(NonInteractivePointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(NonInteractiveTouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  const resolveTargetBucketId = (overId: string): string | null | undefined => {
    // Only left-side bucket list items are valid drop targets.
    if (overId === 'list-bucket-unassigned') return null;
    if (overId.startsWith('list-bucket-')) {
      return overId.replace('list-bucket-', '');
    }
    return undefined;
  };

  const handleFolderDragStart = (event: DragStartEvent) => {
    const imageId = String(event.active.id).replace('dataset-', '');
    setDraggingSample(images.find(img => img.id === imageId) ?? null);
    setMoveError(null);
  };

  const handleFolderDragCancel = () => {
    setDraggingSample(null);
  };

  const handleFolderDrop = async (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggingSample(null);

    if (!over) return; // drop outside a bucket: leave the sample where it is

    const imageId = String(active.id).replace('dataset-', '');
    const currentBucketId =
      (active.data.current as { currentBucketId?: string | null } | undefined)?.currentBucketId ?? null;

    const targetBucketId = resolveTargetBucketId(String(over.id));
    if (targetBucketId === undefined) return;
    if (currentBucketId === targetBucketId) return;

    try {
      setMoveError(null);

      const { data, error } = await supabase
        .from('samples')
        .update({ bucket_id: targetBucketId })
        .eq('id', imageId)
        .select('id, bucket_id');

      if (error) throw error;
      if (!data?.length) {
        throw new Error('Could not save bucket change. Check that the bucket_id column exists and you have permission to move this sample.');
      }

      setImages(prev =>
        prev.map(img =>
          img.id === imageId
            ? { ...img, bucketId: data[0].bucket_id ?? null }
            : img
        )
      );

      // Open the destination so the move is obvious
      setActiveBucketId(targetBucketId ?? 'unassigned');
    } catch (err: any) {
      console.error('Failed to move sample:', err);
      setMoveError(err.message || 'Failed to move sample between buckets.');
    }
  };

  const persistAnnotationComplete = async (imageId: string, complete: boolean) => {
    const { error } = await supabase
      .from('samples')
      .update({ annotation_complete: complete })
      .eq('id', imageId);
    if (error) throw error;
    setImages(prev => prev.map(img => img.id === imageId ? { ...img, annotationComplete: complete } : img));
  };

  const filterByStatus = (list: AdminImage[]) =>
    statusFilter === 'all'
      ? list
      : list.filter(img => getAnnotationStatus(img.xml, img.annotationComplete) === statusFilter);

  const renderStatusFilters = (list: AdminImage[]) => {
    const counts: Record<AnnotationStatus, number> = { never_started: 0, in_progress: 0, complete: 0 };
    list.forEach(img => {
      counts[getAnnotationStatus(img.xml, img.annotationComplete)]++;
    });
    const chips: { id: 'all' | AnnotationStatus; label: string; count: number }[] = [
      { id: 'all', label: 'All', count: list.length },
      { id: 'never_started', label: 'Not started', count: counts.never_started },
      { id: 'in_progress', label: 'In progress', count: counts.in_progress },
      { id: 'complete', label: 'Complete', count: counts.complete },
    ];
    return (
      <div className="flex flex-nowrap items-center gap-1.5 mb-4 overflow-x-auto scrollbar-hide">
        {chips.map(chip => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setStatusFilter(chip.id)}
            className={cn(
              "px-2 py-1 rounded-full text-[10px] font-bold transition-colors whitespace-nowrap shrink-0",
              statusFilter === chip.id
                ? chip.id === 'complete'
                  ? "bg-emerald-500 text-white"
                  : chip.id === 'in_progress'
                    ? "bg-amber-500 text-white"
                    : "bg-slate-900 text-white"
                : "bg-white border border-slate-200 text-slate-500 hover:bg-slate-100"
            )}
          >
            {chip.label} {chip.count}
          </button>
        ))}
      </div>
    );
  };

  const renderSampleCard = (img: AdminImage) => {
    const status = getAnnotationStatus(img.xml, img.annotationComplete);
    const labeled = countLabeledChromosomes(img.xml);
    const showDelete = canDeleteSample(img);

    return (
    <DraggableDatasetImage key={img.id} img={img}>
      <div
        className={cn(
          "bg-white rounded-xl shadow-sm overflow-hidden group relative aspect-square flex flex-col border-2",
          status === 'complete' ? "border-emerald-500" : status === 'in_progress' ? "border-amber-400" : "border-slate-200"
        )}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, [data-no-dnd]')) return;
          const url = img.originalUrl;
          if (!url) return;
          setAnnotateImageUrl(url);
          setAnnotateImageId(img.id);
        }}
      >
        <div className="relative flex-1 bg-slate-100 overflow-hidden">
          <LazyThumb
            src={img.originalUrl}
            alt="Sample"
            draggable={false}
            width={400}
            height={400}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          />

          <div
            className="absolute top-1.5 right-1.5 z-10 h-4 min-w-4 px-1 rounded-full bg-black/70 text-white text-[8px] leading-none font-mono font-bold flex items-center justify-center tabular-nums pointer-events-none"
            title={`${labeled} chromosome${labeled === 1 ? '' : 's'} annotated`}
          >
            {labeled}
          </div>

          <div className="absolute inset-0 pointer-events-none bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity transform translate-y-2 group-hover:translate-y-0 w-9 h-9 flex items-center justify-center bg-white/95 backdrop-blur-sm rounded-full shadow-xl">
              <Pencil className="w-4 h-4 text-slate-900" />
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-2 py-1.5 flex flex-col items-center gap-1">
          <p className="text-[10px] font-mono font-bold text-slate-600 text-center w-full leading-tight break-words">
            {img.karyotype || 'No karyotype set'}
          </p>
          <div className="flex items-center justify-center gap-0.5">
            <button
              type="button"
              data-no-dnd
              onPointerDown={stopCardDrag}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleEditKaryotype(img, e);
              }}
              title="Edit ISCN karyotype designation"
              className="p-1 rounded-md text-slate-400 hover:text-sky-600 hover:bg-sky-50 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            {showDelete && (
              <button
                type="button"
                data-no-dnd
                onPointerDown={stopCardDrag}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDeleteError(null);
                  setPendingDelete(img);
                }}
                title="Delete this metaphase spread"
                className="p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </DraggableDatasetImage>
    );
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleUpload(file);
    e.target.value = '';
  };

  const handleUpload = async (file: File) => {
    if (!session?.user) return;
    if (!selectedBucketId) {
      setUploadError('Please select or create a bucket before uploading.');
      return;
    }
    const karyotype = karyotypeInput.trim();
    if (!karyotype) {
      setUploadError('Please enter the ISCN karyotype designation before uploading.');
      return;
    }
    setUploading(true);
    setUploadError(null);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${session.user.id}/${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
      
      const { error: uploadError, data: uploadData } = await supabase.storage
        .from('images')
        .upload(fileName, file);

      if (uploadError) {
        console.error('Supabase Storage Upload Error:', uploadError);
        throw new Error(`Storage Error: ${uploadError.message}`);
      }

      const { data: { publicUrl } } = supabase.storage
        .from('images')
        .getPublicUrl(fileName);

      const { data: dbData, error: dbError } = await supabase
        .from('samples')
        .insert({
          user_id: session.user.id,
          uploader_email: session.user.email,
          original_url: publicUrl,
          xml: '',
          bucket_id: selectedBucketId,
          karyotype
        })
        .select()
        .single();

      if (dbError) {
        console.error('Supabase Database Insert Error:', dbError);
        throw new Error(`Database Error: ${dbError.message}`);
      }

      const newImage: AdminImage = {
        id: dbData.id,
        originalUrl: publicUrl,
        xml: '',
        userId: session.user.id,
        uploaderEmail: session.user.email,
        bucketId: selectedBucketId,
        karyotype,
        annotationComplete: false
      };
      
      setImages(prev => [newImage, ...prev]);
      setLastUpload(newImage);
      setKaryotypeInput('');
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const confirmDeleteSample = async () => {
    const img = pendingDelete;
    if (!img?.id || deletingLockRef.current) return;
    if (!canDeleteSample(img)) {
      setDeleteError('You do not have permission to delete this spread.');
      return;
    }

    deletingLockRef.current = true;
    setDeletingSample(true);
    setDeleteError(null);

    try {
      const { data, error } = await supabase
        .from('samples')
        .delete()
        .eq('id', img.id)
        .select('id');

      if (error) throw error;
      if (!data?.length) {
        throw new Error('This spread was not deleted. You may not have permission, or it was already removed.');
      }

      const filePath = storageObjectPathFromPublicUrl(img.originalUrl);
      if (filePath) {
        const { error: storageError } = await supabase.storage.from('images').remove([filePath]);
        if (storageError) {
          console.warn('Sample row deleted but storage file could not be removed:', storageError);
        }
      }

      setImages(prev => prev.filter(i => i.id !== img.id));
      if (lastUpload?.id === img.id) setLastUpload(null);
      if (annotateImageId === img.id) {
        setAnnotateImageUrl(null);
        setAnnotateImageId(null);
      }
      setPendingDelete(null);
    } catch (err: any) {
      console.error('Failed to delete sample:', err);
      setDeleteError(err.message || 'Failed to delete this metaphase spread.');
    } finally {
      deletingLockRef.current = false;
      setDeletingSample(false);
    }
  };

  const handleEditKaryotype = async (img: AdminImage, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = window.prompt('ISCN karyotype designation', img.karyotype || '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      window.alert('Karyotype designation cannot be empty.');
      return;
    }
    try {
      const { error } = await supabase
        .from('samples')
        .update({ karyotype: trimmed })
        .eq('id', img.id);
      if (error) throw error;
      setImages(prev => prev.map(i => i.id === img.id ? { ...i, karyotype: trimmed } : i));
    } catch (err) {
      console.error('Failed to update karyotype:', err);
      window.alert('Failed to update karyotype designation.');
    }
  };

  const displayedImages =
    activeBucketId === null
      ? []
      : activeBucketId === 'unassigned'
        ? filterByStatus(unassignedImages)
        : filterByStatus(imagesByBucket[activeBucketId] ?? []);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="fixed inset-0 z-[100] bg-white flex flex-col p-8 overflow-y-auto"
    >
      <header className="flex items-center justify-between mb-6 shrink-0">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-slate-900" />
          <h2 className="text-2xl font-black">Admin Console</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
          <X className="w-6 h-6" />
        </button>
      </header>

      <div className="mb-8 shrink-0 max-w-4xl mx-auto w-full rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 to-sky-50/60 px-5 py-4">
        <div className="flex items-stretch gap-0">
          <div className="flex-1 min-w-0 flex items-start gap-3 pr-4">
            <div className="w-9 h-9 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center justify-center shrink-0">
              {canCreateBuckets ? (
                <FolderPlus className="w-4 h-4 text-sky-600" />
              ) : (
                <Folder className="w-4 h-4 text-sky-600" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide text-sky-700/80 mb-0.5">
                {canCreateBuckets ? 'Set up' : 'Choose'}
              </p>
              <p className="text-sm text-slate-600 leading-snug">
                {canCreateBuckets
                  ? 'Create a bucket, then upload a metaphase spread into it.'
                  : 'Select a bucket, then upload a metaphase spread into it.'}
              </p>
            </div>
          </div>

          <div className="flex items-center shrink-0 px-1">
            <ChevronRight className="w-4 h-4 text-slate-300" />
          </div>

          <div className="flex-1 min-w-0 flex items-start gap-3 px-4">
            <div className="w-9 h-9 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center justify-center shrink-0">
              <Upload className="w-4 h-4 text-sky-600" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide text-sky-700/80 mb-0.5">Organize</p>
              <p className="text-sm text-slate-600 leading-snug">
                Drag samples onto buckets to reorganize them.
              </p>
            </div>
          </div>

          <div className="flex items-center shrink-0 px-1">
            <ChevronRight className="w-4 h-4 text-slate-300" />
          </div>

          <div className="flex-1 min-w-0 flex items-start gap-3 pl-4">
            <div className="w-9 h-9 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center justify-center shrink-0">
              <Pencil className="w-4 h-4 text-sky-600" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide text-sky-700/80 mb-0.5">Annotate</p>
              <p className="text-sm text-slate-600 leading-snug">
                Click a sample to outline individual chromosomes.
              </p>
            </div>
          </div>
        </div>
      </div>

        <DndContext
          sensors={folderDragSensors}
          collisionDetection={bucketListCollisionDetection}
          onDragStart={handleFolderDragStart}
          onDragEnd={handleFolderDrop}
          onDragCancel={handleFolderDragCancel}
        >
        <div className="flex-1 max-w-4xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-12 pb-8">
          <div className="space-y-6">
            <h3 className="text-xl font-black">Upload Metaphase Spread</h3>

            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase">
                Target Bucket
              </label>
              {buckets.length === 0 ? (
                <p className="text-sm text-amber-600 font-medium">
                  {canCreateBuckets
                    ? 'Create a bucket below before uploading samples.'
                    : 'No buckets available. Ask a super admin to create one before uploading.'}
                </p>
              ) : (
                <select
                  value={selectedBucketId}
                  onChange={(e) => setSelectedBucketId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white"
                >
                  {buckets.map(bucket => (
                    <option key={bucket.id} value={bucket.id}>
                      {formatBucketLabel(bucket)}
                    </option>
                  ))}
                </select>
              )}
              {selectedBucketId && (
                <p className="text-xs text-slate-500">
                  {buckets.find(b => b.id === selectedBucketId)?.description}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase">
                ISCN Karyotype Designation
              </label>
              <input
                type="text"
                value={karyotypeInput}
                onChange={(e) => setKaryotypeInput(e.target.value)}
                placeholder="e.g. 46,XY or 47,XX,+21"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white text-sm font-mono"
              />
              <p className="text-xs text-slate-400">
                Required. Entered by the annotator; shown to the player during gameplay.
              </p>
            </div>

            {(() => {
              const canUpload = !!selectedBucketId && !!karyotypeInput.trim();
              return (
                <>
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    disabled={!canUpload}
                  />

                  <div
                    onClick={() => canUpload && fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!selectedBucketId) {
                        setUploadError('Please select or create a bucket before uploading.');
                        return;
                      }
                      if (!karyotypeInput.trim()) {
                        setUploadError('Please enter the ISCN karyotype designation before uploading.');
                        return;
                      }
                      const file = e.dataTransfer.files[0];
                      if (file) handleUpload(file);
                    }}
                    className={cn(
                      "p-12 border-4 border-dashed rounded-3xl flex flex-col items-center justify-center text-center group transition-colors bg-slate-50/50",
                      !canUpload
                        ? "border-slate-100 opacity-60 cursor-not-allowed"
                        : uploading
                          ? "border-sky-300 bg-sky-50/50 cursor-pointer"
                          : "border-slate-100 hover:border-slate-300 cursor-pointer"
                    )}
                  >
                    {uploading ? (
                      <Loader className="w-12 h-12 text-sky-500 animate-spin mb-4" />
                    ) : (
                      <Upload className="w-12 h-12 text-slate-300 group-hover:text-slate-900 transition-colors mb-4" />
                    )}
                    <p className="font-bold text-slate-400 group-hover:text-slate-900">
                      {!selectedBucketId
                        ? (canCreateBuckets
                            ? 'Create a bucket to enable uploads'
                            : 'Select an existing bucket to enable uploads')
                        : !karyotypeInput.trim()
                          ? 'Enter the ISCN karyotype designation to enable uploads'
                          : uploading
                            ? 'Processing...'
                            : 'Upload JPG, JPEG or PNG'}
                    </p>
                    <p className="text-sm text-slate-300">Click or drag & drop</p>
                    {uploadError && (
                      <p className="mt-2 text-sm text-red-500 font-medium">{uploadError}</p>
                    )}
                  </div>
                </>
              );
            })()}

            {lastUpload && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
                <p className="text-xs font-mono text-slate-400">
                  IMAGE PREVIEW
                </p>
                <LazyThumb
                  src={lastUpload.originalUrl}
                  alt="Uploaded"
                  width={800}
                  resize="contain"
                  fallbackToOriginal
                  className="w-full rounded-xl border border-slate-100"
                />
                {lastUpload.karyotype && (
                  <p className="text-xs font-mono font-bold text-slate-600">
                    {lastUpload.karyotype}
                  </p>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-slate-700">Buckets</h4>
                {canCreateBuckets && (
                  <button
                    type="button"
                    onClick={() => setShowCreateBucket(prev => !prev)}
                    className="flex items-center gap-1.5 text-xs font-bold text-sky-600 hover:text-sky-700"
                  >
                    <FolderPlus className="w-4 h-4" />
                    {showCreateBucket ? 'Cancel' : 'New Bucket'}
                  </button>
                )}
              </div>

              {canCreateBuckets && showCreateBucket && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase">
                      Bucket Name
                    </label>
                    <input
                      type="text"
                      value={newBucketName}
                      onChange={(e) => setNewBucketName(e.target.value)}
                      placeholder="e.g. Normal Karyotypes"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase">
                      Description
                    </label>
                    <textarea
                      value={newBucketDescription}
                      onChange={(e) => setNewBucketDescription(e.target.value)}
                      placeholder="What do the spreads in this bucket have in common?"
                      rows={3}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 bg-white text-sm resize-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleCreateBucket}
                    disabled={creatingBucket}
                    className="w-full rounded-xl bg-slate-900 text-white py-2.5 text-sm font-bold hover:bg-slate-800 disabled:opacity-50"
                  >
                    {creatingBucket ? 'Creating...' : 'Create Bucket'}
                  </button>
                </div>
              )}

              {!showCreateBucket && (
                buckets.length === 0 ? (
                  <p className="text-xs text-slate-400">No buckets yet.</p>
                ) : (
                  <ul className={cn("space-y-2", draggingSample && "rounded-xl bg-sky-50/80 p-2 -mx-1")}>
                    {draggingSample && (
                      <li className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-sky-600">
                        Drop onto a bucket
                      </li>
                    )}
                    {buckets.map(bucket => {
                      const count = (imagesByBucket[bucket.id] ?? []).length;
                      const active = activeBucketId === bucket.id;
                      return (
                        <DroppableBucketListItem
                          key={bucket.id}
                          droppableId={`bucket-${bucket.id}`}
                          active={active}
                          dragging={!!draggingSample}
                          onClick={() => setActiveBucketId(bucket.id)}
                        >
                          <span className="text-sm font-bold truncate">
                            [{bucket.bucketNumber}] {bucket.name}
                          </span>
                          <span className={cn(
                            "text-[10px] font-mono font-bold shrink-0 px-1.5 py-0.5 rounded",
                            active
                              ? "bg-white/20 text-white"
                              : draggingSample
                                ? "bg-sky-100 text-sky-700"
                                : "bg-slate-200 text-slate-500 group-hover:bg-slate-300"
                          )}>
                            {count}
                          </span>
                        </DroppableBucketListItem>
                      );
                    })}
                    {(unassignedImages.length > 0 || draggingSample) && (
                      <DroppableBucketListItem
                        droppableId="bucket-unassigned"
                        active={activeBucketId === 'unassigned'}
                        dragging={!!draggingSample}
                        onClick={() => setActiveBucketId('unassigned')}
                      >
                        <span className="text-sm font-bold">Unassigned</span>
                        <span className={cn(
                          "text-[10px] font-mono font-bold shrink-0 px-1.5 py-0.5 rounded",
                          activeBucketId === 'unassigned'
                            ? "bg-white/20 text-white"
                            : draggingSample
                              ? "bg-sky-100 text-sky-700"
                              : "bg-slate-200 text-slate-500 group-hover:bg-slate-300"
                        )}>
                          {unassignedImages.length}
                        </span>
                      </DroppableBucketListItem>
                    )}
                  </ul>
                )
              )}
            </div>
          </div>

          <div className="relative bg-slate-50 rounded-3xl p-8 border border-slate-100 flex flex-col h-full max-h-[800px] overflow-hidden">
            {!firstSpreadLoaded && (
              <div className="absolute inset-0 z-20 bg-slate-50 flex flex-col items-center justify-center">
                <Loader className="w-12 h-12 text-sky-500 animate-spin" />
                <p className="mt-4 text-sm font-bold text-slate-600">Loading metaphase spreads...</p>
              </div>
            )}
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h3 className="text-xl font-black">Available Dataset</h3>
              <span className="text-xs font-mono font-bold text-slate-400 bg-slate-200 px-2 py-1 rounded-md">{images.length} SAMPLES</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 mb-6 shrink-0 text-[10px] font-bold text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-sm border-2 border-amber-400 bg-white" />
                In progress
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-sm border-2 border-emerald-500 bg-white" />
                Complete
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-4 min-w-4 px-1 rounded-full bg-slate-800 text-white text-[8px] font-mono flex items-center justify-center">n</span>
                Chromosomes annotated
              </span>
            </div>

            {moveError && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 font-medium shrink-0">
                {moveError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto pr-2 pb-4 scrollbar-hide">
              {activeBucketId === null ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-slate-300">
                  <Folder className="w-8 h-8 mb-3 opacity-40" />
                  <p className="text-sm font-medium">Select a bucket on the left to view its samples</p>
                </div>
              ) : (
                  activeBucketId === 'unassigned' ? (
                    <UnassignedFolder sampleCount={unassignedImages.length}>
                      {renderStatusFilters(unassignedImages)}
                      {filterByStatus(unassignedImages).length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-slate-300 text-center">
                          <p className="text-xs font-medium">No samples match this filter</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 min-h-[4rem]">
                          {filterByStatus(unassignedImages).map(img => renderSampleCard(img))}
                        </div>
                      )}
                    </UnassignedFolder>
                  ) : (() => {
                    const bucket = buckets.find(b => b.id === activeBucketId);
                    if (!bucket) return null;
                    const bucketImages = imagesByBucket[bucket.id] ?? [];
                    const visibleImages = filterByStatus(bucketImages);
                    return (
                      <BucketFolder
                        bucket={bucket}
                        sampleCount={bucketImages.length}
                        editable={canCreateBuckets}
                        onUpdate={(name, description) => handleUpdateBucket(bucket.id, name, description)}
                      >
                        {bucketImages.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 text-slate-300 text-center">
                            <p className="text-xs font-medium">No samples in this bucket yet</p>
                            <p className="text-xs mt-1">Upload a spread or drag one here from another bucket</p>
                          </div>
                        ) : (
                          <>
                            {renderStatusFilters(bucketImages)}
                            {visibleImages.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-12 text-slate-300 text-center">
                                <p className="text-xs font-medium">No samples match this filter</p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 min-h-[4rem]">
                                {visibleImages.map(img => renderSampleCard(img))}
                              </div>
                            )}
                          </>
                        )}
                      </BucketFolder>
                    );
                  })()
              )}
            </div>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {draggingSample ? (
            <div className="w-28 aspect-square rounded-xl overflow-hidden border-2 border-sky-400 shadow-2xl bg-white rotate-2 cursor-grabbing">
              <LazyThumb
                src={draggingSample.originalUrl}
                alt="Moving sample"
                width={200}
                height={200}
                draggable={false}
                className="w-full h-full object-cover"
              />
            </div>
          ) : null}
        </DragOverlay>
        </DndContext>
      {annotateImageUrl && annotateImageId && (
        <ImageAnnotationModal
          imageUrl={annotateImageUrl}
          imageId={annotateImageId}
          initialXml={images.find(img => img.id === annotateImageId)?.xml}
          karyotype={images.find(img => img.id === annotateImageId)?.karyotype}
          annotationComplete={images.find(img => img.id === annotateImageId)?.annotationComplete}
          onSave={async (xml) => {
            try {
              const labeled = countLabeledChromosomes(xml);
              const payload: { xml: string; annotation_complete?: boolean } = { xml };
              if (labeled === 0) payload.annotation_complete = false;

              const { error } = await supabase
                .from('samples')
                .update(payload)
                .eq('id', annotateImageId);
              
              if (error) throw error;
              setImages(prev => prev.map(img => img.id === annotateImageId
                ? { ...img, xml, ...(labeled === 0 ? { annotationComplete: false } : {}) }
                : img));
            } catch (err) {
              console.error('Failed to save annotations to DB:', err);
              alert('Failed to save annotations to database.');
              throw err;
            }
          }}
          onSetComplete={async (complete) => {
            try {
              await persistAnnotationComplete(annotateImageId, complete);
            } catch (err) {
              console.error('Failed to update annotation status:', err);
              alert('Failed to update annotation status.');
              throw err;
            }
          }}
          onClose={() => {
            setAnnotateImageUrl(null);
            setAnnotateImageId(null);
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteSampleModal
          key={pendingDelete.id}
          originalUrl={pendingDelete.originalUrl}
          karyotype={pendingDelete.karyotype}
          labeledCount={countLabeledChromosomes(pendingDelete.xml)}
          deleting={deletingSample}
          error={deleteError}
          onCancel={() => {
            if (deletingSample) return;
            setPendingDelete(null);
            setDeleteError(null);
          }}
          onConfirm={confirmDeleteSample}
        />
      )}
    </motion.div>
  );
};

interface SpreadSelectionScreenProps {
  images: AdminImage[];
  imagesLoaded: boolean;
  progressBySample: Record<string, KaryotypeProgressSummary>;
  onSelect: (img: AdminImage, extracted: ChromosomeData[]) => Promise<void>;
  onBack: () => void;
}

const SpreadSelectionScreen: React.FC<SpreadSelectionScreenProps> = ({ images, imagesLoaded, progressBySample, onSelect, onBack }) => {
  const firstSpreadLoaded = useFirstSpreadLoaded(images, imagesLoaded);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  const handleSelect = async (img: AdminImage) => {
    if (extractingId) return;
    setExtractingId(img.id);
    const extracted = await extractChromosomes(img);
    await onSelect(img, extracted);
    setExtractingId(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="fixed inset-0 z-[100] bg-slate-50 flex flex-col p-8 overflow-y-auto"
    >
      <div className="max-w-6xl mx-auto w-full">
        <header className="flex items-center justify-between mb-12">
          <div>
            <h2 className="text-4xl font-black text-slate-900 tracking-tighter">Select Sample</h2>
            <p className="text-slate-500 font-medium mt-2">Choose a metaphase spread for karyotyping</p>
          </div>
          <button onClick={onBack} className="p-3 hover:bg-slate-200 rounded-full transition-colors text-slate-500">
            <X className="w-6 h-6" />
          </button>
        </header>

        <div className="relative min-h-64 rounded-3xl overflow-hidden">
          {!firstSpreadLoaded && (
            <div className="absolute inset-0 z-20 bg-slate-50 flex flex-col items-center justify-center">
              <Loader className="w-12 h-12 text-sky-500 animate-spin" />
              <p className="mt-4 text-sm font-bold text-slate-600">Loading metaphase spreads...</p>
            </div>
          )}
          {images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white rounded-3xl border border-slate-200 shadow-sm p-8 text-center">
              <ImageIcon className="w-12 h-12 mb-4 opacity-50 mx-auto" />
              <p className="text-lg font-bold text-slate-700">No metaphase spreads available</p>
              <p className="text-sm mt-1">Please ask the administrator to upload and annotate samples.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {images.map(img => {
                const savedProgress = progressBySample[img.id];
                return (
                <div
                  key={img.id}
                  onClick={() => handleSelect(img)}
                  className={cn(
                    "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden cursor-pointer group hover:shadow-xl hover:border-sky-300 hover:-translate-y-1 transition-all flex flex-col aspect-square relative",
                    extractingId === img.id && "pointer-events-none opacity-80"
                  )}
                >
                  {extractingId === img.id && (
                    <div className="absolute inset-0 z-10 bg-white/50 backdrop-blur-[2px] flex flex-col items-center justify-center">
                      <Loader className="w-8 h-8 text-sky-500 animate-spin mb-2" />
                      <span className="text-xs font-bold text-slate-700 bg-white px-2 py-1 rounded shadow-sm">Extracting...</span>
                    </div>
                  )}
                  <div className="relative flex-1 bg-slate-100 overflow-hidden">
                    <LazyThumb
                      src={img.originalUrl}
                      alt="Spread"
                      width={400}
                      height={400}
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                    />
                    <div className="absolute inset-0 bg-sky-900/0 group-hover:bg-sky-900/10 transition-colors" />
                  </div>
                  <div className="p-4 border-t border-slate-100 flex items-center justify-between bg-white shrink-0">
                    <div>
                      <p className="text-[10px] font-mono text-slate-400 font-bold">SAMPLE ID</p>
                      <p className="font-bold text-sm text-slate-700 truncate w-32">{img.id.slice(0, 12)}</p>
                      {savedProgress && (
                        <p className={cn(
                          "mt-1 text-[10px] font-bold",
                          savedProgress.status === 'complete' ? "text-emerald-600" : "text-sky-600"
                        )}>
                          {savedProgress.status === 'complete'
                            ? 'Completed'
                            : `Resume ${savedProgress.correctCount}/${savedProgress.totalCount}`}
                        </p>
                      )}
                    </div>
                    <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-sky-50 transition-colors">
                      <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-sky-500" />
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

// --- Main App ---

const SUCCESS_PHRASES = [
  "BRILLIANT WORK!",
  "KARYOTYPE MASTERED!",
  "PERFECT ALIGNMENT!",
  "OUTSTANDING ANALYSIS!",
  "FLAWLESS EXECUTION!",
  "EXPERTLY SORTED!",
  "SPOT ON!",
  "GENETICS EXPERT!"
];

const AuthForm = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputClassName =
    'w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400 transition-colors';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const normalizedEmail = email.trim().toLowerCase();

      if (isLogin) {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (signInError) throw signInError;
      } else {
        if (!/^[^@\s]+@roswellpark\.org$/.test(normalizedEmail)) {
          throw new Error('Please use your roswellpark.org email address.');
        }

        const { error: signUpError } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: {
              username,
            }
          }
        });
        if (signUpError) throw signUpError;
        alert('Check your email for the confirmation link!');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during authentication');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[100] bg-white flex items-center justify-center p-6 overflow-hidden"
    >
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[radial-gradient(#000_1px,transparent_1px)] [background-size:24px_24px]" />

      <div className="w-full max-w-md relative z-10">
        <motion.div
          initial={{ scale: 0.95, y: 16 }}
          animate={{ scale: 1, y: 0 }}
          className="bg-white border border-slate-100 rounded-3xl shadow-xl shadow-slate-900/5 p-8 md:p-10"
        >
          <div className="text-center mb-8">
            <motion.img
              src="/logo.png"
              alt="Chromy"
              className="w-20 h-20 object-contain mx-auto mb-5 drop-shadow-md"
              animate={{
                y: [-4, 4, -4],
                rotate: [-2, 2, -2]
              }}
              transition={{
                duration: 4,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            />
            <h1 className="text-4xl font-black text-slate-900 tracking-tighter mb-2">
              Chromy.
            </h1>
            <p className="text-slate-500 text-sm font-medium">
              {isLogin
                ? 'Sign in to access the karyotyping laboratory.'
                : 'Create an account to start practicing karyotyping.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {!isLogin && (
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputClassName}
                  placeholder="Cytogeneticist"
                  required={!isLogin}
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClassName}
                placeholder={isLogin ? 'you@example.com' : 'you@roswellpark.org'}
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 font-medium">
                <p>{error}</p>
                <p className="mt-1.5 text-xs font-normal text-red-500">
                  Friendly reminder: access is currently limited to Roswell Park users with an @roswellpark.org email address.
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-slate-900 text-white px-6 py-3.5 rounded-xl font-black text-sm hover:scale-[1.02] transition-all shadow-xl shadow-slate-900/20 active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  Processing...
                </>
              ) : isLogin ? (
                'Sign In'
              ) : (
                'Sign Up'
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-100 text-center">
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError(null);
              }}
              className="text-xs font-mono tracking-widest uppercase text-slate-400 hover:text-slate-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 rounded-md px-2 py-1"
            >
              {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default function Chromy() {
  const [session, setSession] = useState<Session | null>(null);
  const [userRole, setUserRole] = useState<'SUPER ADMIN' | 'ADMIN' | 'USER' | null>(null);
  const [images, setImages] = useState<AdminImage[]>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [gameState, setGameState] = useState<'welcome' | 'select' | 'playing' | 'admin'>('welcome');
  const [selectedImage, setSelectedImage] = useState<AdminImage | null>(null);
  const [sourceImageLoaded, setSourceImageLoaded] = useState(false);
  const [originalExtracted, setOriginalExtracted] = useState<ChromosomeData[]>([]);
  const [jumbled, setJumbled] = useState<ChromosomeData[]>([]);
  const [placed, setPlaced] = useState<Record<string, ChromosomeData>>({});
  const [history, setHistory] = useState<{ jumbled: ChromosomeData[], placed: Record<string, ChromosomeData> }[]>([]);
  const [isReviewingCertificate, setIsReviewingCertificate] = useState(false);
  const [certificateName, setCertificateName] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [progressBySample, setProgressBySample] = useState<Record<string, KaryotypeProgressSummary>>({});
  const [progressReady, setProgressReady] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [showHints, setShowHints] = useState(false);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(MouseSensor),
    useSensor(TouchSensor)
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        supabase.from('user_roles').select('role').eq('user_id', session.user.id).single()
          .then(({ data }) => setUserRole(data?.role || 'USER'));
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        supabase.from('user_roles').select('role').eq('user_id', session.user.id).single()
          .then(({ data }) => setUserRole(data?.role || 'USER'));
      } else {
        setUserRole(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    
    const loadFromDb = async () => {
      try {
        const { data, error } = await supabase
          .from('samples')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) throw error;
        
        if (data) {
          setImages(data.map(row => ({
            id: row.id,
            originalUrl: row.original_url,
            xml: row.xml,
            userId: row.user_id,
            uploaderEmail: row.uploader_email,
            bucketId: row.bucket_id ?? null,
            karyotype: row.karyotype ?? undefined,
            annotationComplete: row.annotation_complete === true
          })));
        }
      } catch (e: any) {
        console.error('Failed to load images from Supabase', e);
        // setUploadError is not defined here, so we just log or alert if needed
      } finally {
        setImagesLoaded(true);
      }
    };
    loadFromDb();
  }, [session]);

  useEffect(() => {
    if (!session?.user || !imagesLoaded) return;
    let cancelled = false;

    const loadProgressSummaries = async () => {
      const { data, error } = await supabase
        .from('karyotype_progress')
        .select('sample_id, annotation_signature, status, correct_count, total_count')
        .eq('user_id', session.user.id);

      if (cancelled) return;
      if (error) {
        console.error('Failed to load karyotyping progress summaries', error);
        return;
      }

      const imageById = new Map<string, AdminImage>(
        images.map(image => [image.id, image] as const)
      );
      const summaries: Record<string, KaryotypeProgressSummary> = {};
      for (const row of data ?? []) {
        const image = imageById.get(row.sample_id);
        if (!image || row.annotation_signature !== annotationSignature(image.xml)) continue;
        summaries[row.sample_id] = {
          status: row.status === 'complete' ? 'complete' : 'in_progress',
          correctCount: row.correct_count ?? 0,
          totalCount: row.total_count ?? 0,
        };
      }
      setProgressBySample(summaries);
    };

    loadProgressSummaries();
    return () => {
      cancelled = true;
    };
  }, [images, imagesLoaded, session?.user?.id]);

  useEffect(() => {
    const initial = createInitialChromosomes();
    setOriginalExtracted(initial);
    setJumbled(shuffleChromosomes(initial, 'default'));
    setScore({ correct: 0, total: initial.length });
  }, []);

  useEffect(() => {
    setSourceImageLoaded(false);
  }, [selectedImage?.id]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over, active } = event;
    setActiveId(null);
    setProgressReady(true);

    const chromosome = active.data.current as ChromosomeData;

    // Handle dropping back to "Raw Sample" panel
    if (!over || over.id === 'raw-sample-panel') {
      setHistory(prev => [...prev.slice(-19), { jumbled: [...jumbled], placed: { ...placed } }]);
      
      // If it was in a slot, remove it from the slot
      setPlaced(prev => {
        const newPlaced = { ...prev };
        let wasPlaced = false;
        Object.keys(newPlaced).forEach(key => {
          if (newPlaced[key].id === chromosome.id) {
            delete newPlaced[key];
            wasPlaced = true;
          }
        });
        
        // If it was placed, we need to add it back to jumbled
        if (wasPlaced) {
          setJumbled(currentJumbled => {
            if (!currentJumbled.find(c => c.id === chromosome.id)) {
              return [...currentJumbled, chromosome];
            }
            return currentJumbled;
          });
        }
        return newPlaced;
      });
      return;
    }

    const slotId = over.id as string;

    // Save history before change
    setHistory(prev => [...prev.slice(-19), { jumbled: [...jumbled], placed: { ...placed } }]);

    setPlaced(prev => {
      const newPlaced = { ...prev };
      
      // If it was already placed somewhere, remove it from old position
      Object.keys(newPlaced).forEach(key => {
        if (newPlaced[key].id === chromosome.id) {
          delete newPlaced[key];
        }
      });

      // Add to new position
      newPlaced[slotId] = chromosome;
      
      return newPlaced;
    });

    // Remove from jumbled if it was there
    setJumbled(prev => prev.filter(c => c.id !== chromosome.id));
  };

  const updatePlaced = (slotId: string, updates: Partial<ChromosomeData>) => {
    setProgressReady(true);
    setPlaced(prev => {
      const existing = prev[slotId];
      if (!existing) return prev;
      return {
        ...prev,
        [slotId]: { ...existing, ...updates }
      };
    });
  };

  const undo = () => {
    if (history.length === 0) return;
    setProgressReady(true);
    const lastState = history[history.length - 1];
    setJumbled(lastState.jumbled);
    setPlaced(lastState.placed);
    setHistory(prev => prev.slice(0, -1));
  };

  const resetGame = () => {
    setProgressReady(false);
    if (originalExtracted.length > 0) {
      setJumbled(shuffleChromosomes(originalExtracted, selectedImage?.id ?? 'default'));
    } else {
      const initial = createInitialChromosomes();
      setOriginalExtracted(initial);
      setJumbled(shuffleChromosomes(initial, selectedImage?.id ?? 'default'));
    }
    setPlaced({});
    setHistory([]);
    setGameState('playing');

    if (session?.user && selectedImage) {
      const sampleId = selectedImage.id;
      const userId = session.user.id;
      setProgressBySample(prev => {
        const next = { ...prev };
        delete next[sampleId];
        return next;
      });
      progressSaveQueueRef.current = progressSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const { error } = await supabase
            .from('karyotype_progress')
            .delete()
            .eq('user_id', userId)
            .eq('sample_id', sampleId);
          if (error) {
            console.error('Failed to clear karyotyping progress', error);
            setProgressError('Your saved progress could not be cleared. Please try resetting again.');
            throw error;
          }
          setProgressError(null);
        });
    }
  };

  const confirmResetGame = () => {
    if (window.confirm('Reset this karyotype? Your current progress will be cleared.')) {
      resetGame();
    }
  };


  const currentActiveChromosome = useMemo(() => {
    if (!activeId) return null;
    return (jumbled.find(c => c.id === activeId) || Object.values(placed).find((c: ChromosomeData) => c.id === activeId)) as ChromosomeData | undefined;
  }, [activeId, jumbled, placed]);

  const chromosomeDisplayScale = useMemo(
    () => uniformDisplayScale(
      [...jumbled, ...Object.values(placed)],
      CHROMOSOME_DISPLAY_MAX_EDGE
    ),
    [jumbled, placed]
  );

  // Derive the board's pair groups (and their slot IDs) from the full set of
  // chromosomes for this sample. Slot IDs are opaque (`slot-${pairIndex}-${slotIndex}`)
  // so a pair ID containing arbitrary characters (custom names) can never
  // corrupt lookup logic - the pair ID is looked up via slotPairMap instead
  // of being parsed back out of the slot ID string.
  const pairGroups = useMemo(() => {
    const membersByPair = new Map<string, ChromosomeData[]>();
    const firstAppearanceOrder: string[] = [];
    originalExtracted.forEach(chrom => {
      if (!membersByPair.has(chrom.type)) {
        membersByPair.set(chrom.type, []);
        firstAppearanceOrder.push(chrom.type);
      }
      membersByPair.get(chrom.type)!.push(chrom);
    });

    const orderedPairIds = [...firstAppearanceOrder].sort((a, b) => comparePairIds(a, b, firstAppearanceOrder));

    return orderedPairIds.map((pairId, pairIndex) => {
      const members = membersByPair.get(pairId)!;
      return {
        pairId,
        slotIds: members.map((_, slotIndex) => `slot-${pairIndex}-${slotIndex}`),
      };
    });
  }, [originalExtracted]);

  const pairGroupsById = useMemo(
    () => new Map(pairGroups.map(group => [group.pairId, group] as const)),
    [pairGroups]
  );

  const customPairGroups = useMemo(
    () => pairGroups.filter(group => !STANDARD_PAIR_IDS.includes(group.pairId)),
    [pairGroups]
  );

  const slotPairMap = useMemo(() => {
    const map = new Map<string, string>();
    pairGroups.forEach(group => {
      group.slotIds.forEach(slotId => map.set(slotId, group.pairId));
    });
    return map;
  }, [pairGroups]);

  const hintChromosomes = useMemo<KaryotypeHintChromosome[]>(() => {
    const currentById = new Map<string, ChromosomeData>();
    jumbled.forEach(chromosome => currentById.set(chromosome.id, chromosome));
    (Object.values(placed) as ChromosomeData[]).forEach(chromosome => currentById.set(chromosome.id, chromosome));

    const placedSlotByChromosomeId = new Map<string, string>();
    (Object.entries(placed) as [string, ChromosomeData][]).forEach(([slotId, chromosome]) => {
      placedSlotByChromosomeId.set(chromosome.id, slotId);
    });

    const originalById = new Map(originalExtracted.map(chromosome => [chromosome.id, chromosome] as const));
    const jumbledIds = new Set(jumbled.map(chromosome => chromosome.id));
    const orderedCurrent = [
      ...jumbled,
      ...originalExtracted
        .filter(chromosome => !jumbledIds.has(chromosome.id))
        .map(chromosome => currentById.get(chromosome.id) ?? chromosome),
    ];

    return orderedCurrent
      .map(current => {
        const original = originalById.get(current.id) ?? current;
        const slotId = placedSlotByChromosomeId.get(current.id);
        return {
          id: current.id,
          imageUrl: original.imageUrl,
          width: original.width,
          height: original.height,
          targetPair: original.type,
          currentPair: slotId ? (slotPairMap.get(slotId) ?? null) : null,
          currentRotation: normalizeRotation(current.userRotation),
          currentFlipX: !!current.userFlipX,
          currentFlipY: !!current.userFlipY,
          expectedRotation: normalizeRotation(original.expectedRotation),
          expectedFlipX: !!original.expectedFlipX,
          expectedFlipY: !!original.expectedFlipY,
        };
      })
      .filter(chromosome => !(
        chromosome.currentPair === chromosome.targetPair &&
        chromosome.currentFlipX === chromosome.expectedFlipX &&
        chromosome.currentFlipY === chromosome.expectedFlipY &&
        rotationsMatch(chromosome.currentRotation, chromosome.expectedRotation)
      ));
  }, [jumbled, originalExtracted, placed, slotPairMap]);

  const fullHintKaryotype = useMemo<KaryotypeHintChromosome[]>(
    () => originalExtracted.map(chromosome => ({
      id: chromosome.id,
      imageUrl: chromosome.imageUrl,
      width: chromosome.width,
      height: chromosome.height,
      targetPair: chromosome.type,
      currentPair: chromosome.type,
      currentRotation: normalizeRotation(chromosome.expectedRotation),
      currentFlipX: !!chromosome.expectedFlipX,
      currentFlipY: !!chromosome.expectedFlipY,
      expectedRotation: normalizeRotation(chromosome.expectedRotation),
      expectedFlipX: !!chromosome.expectedFlipX,
      expectedFlipY: !!chromosome.expectedFlipY,
    })),
    [originalExtracted]
  );

  // Calculate score: a chromosome is correct if it's placed in a slot
  // belonging to its own pair (position within the pair no longer matters)
  // and, for real annotated images, its orientation matches the orientation
  // recorded for that specific chromosome during annotation.
  useEffect(() => {
    let correctCount = 0;
    Object.entries(placed).forEach(([slotId, chrom]: [string, ChromosomeData]) => {
      const expectedPairId = slotPairMap.get(slotId);
      if (expectedPairId === undefined || chrom.type !== expectedPairId) return;

      if (chrom.imageUrl) {
        if (rotationsMatch(chrom.userRotation, chrom.expectedRotation) && 
            chrom.userFlipX === chrom.expectedFlipX && 
            chrom.userFlipY === chrom.expectedFlipY) {
          correctCount++;
        }
      } else {
        correctCount++;
      }
    });
    setScore(prev => ({ ...prev, correct: correctCount }));
  }, [placed, slotPairMap]);

  const progress = (score.correct / score.total) * 100;
  const isComplete = progress === 100 && score.total > 0;

  useEffect(() => {
    if (
      gameState !== 'playing' ||
      !progressReady ||
      !session?.user ||
      !selectedImage ||
      score.total === 0
    ) return;

    const status: KaryotypeProgressSummary['status'] = isComplete ? 'complete' : 'in_progress';
    const savedState = serializeKaryotypeState(jumbled, placed);
    const now = new Date().toISOString();
    const userId = session.user.id;
    const sampleId = selectedImage.id;

    setProgressBySample(prev => ({
      ...prev,
      [sampleId]: {
        status,
        correctCount: score.correct,
        totalCount: score.total,
      },
    }));

    progressSaveQueueRef.current = progressSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const { error } = await supabase
          .from('karyotype_progress')
          .upsert({
            user_id: userId,
            sample_id: sampleId,
            state: savedState,
            annotation_signature: annotationSignature(selectedImage.xml),
            status,
            correct_count: score.correct,
            total_count: score.total,
            completed_at: isComplete ? now : null,
            updated_at: now,
          }, { onConflict: 'user_id,sample_id' });

        if (error) {
          console.error('Failed to save karyotyping progress', error);
          setProgressError('Your progress could not be saved. Your current board is still available in this session.');
          throw error;
        }
        setProgressError(null);
      });
  }, [
    gameState,
    isComplete,
    jumbled,
    placed,
    progressReady,
    score.correct,
    score.total,
    selectedImage,
    session?.user,
  ]);

  const successPhrase = useMemo(() => {
    if (isComplete) {
      return SUCCESS_PHRASES[Math.floor(Math.random() * SUCCESS_PHRASES.length)];
    }
    return "DIAGNOSIS COMPLETE";
  }, [isComplete]);

  return (
    <>
      {!session ? (
        <AuthForm />
      ) : (
        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-sky-100 overflow-hidden">
          <AnimatePresence mode="wait">
        {gameState === 'welcome' && (
          <WelcomeScreen 
            key="welcome" 
            onStart={() => setGameState('select')} 
            onAdmin={() => setGameState('admin')} 
            onSignOut={async () => {
              await supabase.auth.signOut();
            }}
            userRole={userRole}
          />
        )}
        {gameState === 'select' && (
          <SpreadSelectionScreen
            key="select"
            images={images.filter(img => hasAnnotations(img.xml))}
            imagesLoaded={imagesLoaded}
            progressBySample={progressBySample}
            onBack={() => setGameState('welcome')}
            onSelect={async (img, extracted) => {
              setProgressReady(false);
              setProgressError(null);

              const playableChromosomes = extracted.length > 0
                ? extracted
                : createInitialChromosomes();
              let restored: { jumbled: ChromosomeData[]; placed: Record<string, ChromosomeData> } | null = null;
              let restoredCorrectCount = 0;

              if (session?.user) {
                const { data, error } = await supabase
                  .from('karyotype_progress')
                  .select('state, annotation_signature, correct_count')
                  .eq('user_id', session.user.id)
                  .eq('sample_id', img.id)
                  .maybeSingle();

                if (error) {
                  console.error('Failed to load karyotyping progress', error);
                  setProgressError('Saved progress could not be loaded. A new board was started instead.');
                } else if (data?.annotation_signature === annotationSignature(img.xml)) {
                  restored = hydrateKaryotypeState(playableChromosomes, data.state);
                  if (restored) {
                    restoredCorrectCount = Math.max(
                      0,
                      Math.min(Number(data.correct_count) || 0, playableChromosomes.length)
                    );
                  }
                }
              }

              setSelectedImage(img);
              setOriginalExtracted(playableChromosomes);
              setJumbled(restored?.jumbled ?? shuffleChromosomes(playableChromosomes, img.id));
              setPlaced(restored?.placed ?? {});
              setScore({
                correct: restored ? restoredCorrectCount : 0,
                total: playableChromosomes.length,
              });
              setHistory([]);
              setCertificateName('');
              setIsReviewingCertificate(false);
              // A fresh or restored board is not written until the user changes it.
              setProgressReady(false);
              setGameState('playing');
            }}
          />
        )}
        {gameState === 'admin' && (
          <AdminPanel 
            key="admin" 
            images={images}
            imagesLoaded={imagesLoaded}
            setImages={setImages}
            session={session}
            userRole={userRole}
            onClose={() => setGameState('welcome')} 
          />
        )}
      </AnimatePresence>

      <div className={cn(
        "transition-opacity duration-300",
        gameState === 'playing' ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none absolute inset-0 -z-10"
      )}>
        <DndContext 
          sensors={sensors} 
          onDragStart={handleDragStart} 
          onDragEnd={handleDragEnd}
        >
          {/* Header */}
        <header className={cn("fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-200 z-50 px-6 flex items-center justify-between print:hidden", isReviewingCertificate && "hidden")}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGameState('select')}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500 hover:text-slate-900"
              title="Back to sample selection"
              aria-label="Back to sample selection"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => setGameState('welcome')}>
              <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white">
                <Dna className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-black tracking-tight flex items-center gap-1.5">
                  CHROMY <span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded uppercase font-bold text-slate-500">v1.0</span>
                </h1>
                <p className="text-[10px] text-slate-400 font-mono tracking-widest uppercase">Karyotype Diagnostic Tool</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
             <div className="flex flex-col items-end">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-400">COMPLETION</span>
                  <span className={cn(
                    "text-lg font-black font-mono",
                    progress > 90 ? "text-emerald-600" : progress > 50 ? "text-amber-600" : "text-slate-900"
                  )}>
                    {Math.round(progress)}%
                  </span>
                </div>
                <div className="w-32 h-1 bg-slate-100 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-slate-900"
                  />
                </div>
             </div>

             <div className="flex items-center gap-2">
               <button
                  onClick={() => setShowHints(true)}
                  className="px-3 py-2 hover:bg-amber-50 rounded-lg transition-colors text-xs font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1.5"
                  title="Get a chromosome hint"
                >
                  <Lightbulb className="w-4 h-4" />
                  HINT
               </button>

               <button 
                  onClick={undo}
                  disabled={history.length === 0}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-900 disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Undo last placement"
                >
                  <Undo2 className="w-5 h-5" />
               </button>

               <button 
                  onClick={confirmResetGame}
                  className="px-3 py-2 hover:bg-slate-100 rounded-lg transition-colors text-xs font-bold text-slate-400 hover:text-slate-900"
                  title="Reset Karyogram"
                >
                  RESET
               </button>
             </div>
          </div>
        </header>

        {gameState === 'playing' && progressError && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-700 shadow-lg print:hidden">
            {progressError}
          </div>
        )}

        {!isReviewingCertificate && selectedImage?.karyotype && (
          <footer className="fixed bottom-0 left-0 right-0 h-10 bg-white border-t border-slate-200 z-50 px-6 flex items-center justify-center gap-2 print:hidden">
            <span className="text-[10px] font-mono tracking-widest uppercase text-slate-400">
              ISCN Karyotype Designation
            </span>
            <span className="text-sm font-mono font-bold text-slate-900">
              {selectedImage.karyotype}
            </span>
          </footer>
        )}

        <main className={cn(
          "px-6 pb-6 grid gap-6 overflow-y-auto overflow-x-hidden lg:overflow-hidden print:h-auto print:overflow-visible print:block",
          isReviewingCertificate
            ? "pt-6 h-screen grid-cols-1"
            : cn(
                "pt-20 grid-cols-1 lg:grid-cols-[1fr_3fr]",
                selectedImage?.karyotype ? "h-[calc(100vh-120px)]" : "h-[calc(100vh-80px)]"
              )
        )}>
          
          {/* Left Panel: Jumbled Source */}
          {!isReviewingCertificate && (
            <RawSampleDroppable id="raw-sample-panel">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col shadow-sm overflow-hidden bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] h-full min-h-0">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                    <Info className="w-4 h-4" />
                    Raw Sample
                  </h2>
                  <span className="text-xs font-mono text-slate-400">
                    {jumbled.length} REMAINING
                  </span>
                </div>

              {selectedImage && (
                <div className="w-full h-48 mb-6 rounded-xl overflow-hidden border border-slate-200 relative shrink-0 shadow-sm bg-black group/source">
                  {!sourceImageLoaded && (
                    <div className="absolute inset-0 z-10 bg-slate-100 flex flex-col items-center justify-center">
                      <Loader className="w-8 h-8 text-sky-500 animate-spin" />
                      <span className="mt-2 text-xs font-bold text-slate-600">Loading spread...</span>
                    </div>
                  )}
                  <img 
                    src={selectedImage.originalUrl} 
                    alt="Selected Metaphase Spread"
                    onLoad={() => setSourceImageLoaded(true)}
                    onError={() => setSourceImageLoaded(true)}
                    className={cn(
                      "w-full h-full object-cover transition-all duration-500 group-hover/source:scale-105",
                      sourceImageLoaded ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover/source:opacity-100 transition-opacity" />
                  
                  <div className="absolute top-2 left-2 bg-slate-900/80 backdrop-blur text-white text-[10px] font-bold px-2 py-1 rounded shadow-sm">
                    SOURCE IMAGE
                  </div>

                  <div className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover/source:opacity-100 transition-all translate-y-2 group-hover/source:translate-y-0">
                    <a
                      href={selectedImage.originalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20 flex items-center justify-center text-white transition-colors"
                      title="Open Full Size"
                    >
                      <Expand className="w-4 h-4" />
                    </a>
                    <a
                      href={selectedImage.originalUrl}
                      download={`chromy-sample-${selectedImage.id}.png`}
                      className="w-8 h-8 rounded-lg bg-white text-slate-900 hover:bg-sky-50 flex items-center justify-center transition-colors shadow-lg"
                      title="Download Source Image"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              )}
                
                <div className="flex-1 overflow-y-auto scrollbar-hide">
                  <div className="flex flex-wrap gap-4 items-end justify-center">
                    <AnimatePresence>
                      {jumbled.length > 0 ? (
                        jumbled.map((chrom) => (
                          <motion.div
                            key={chrom.id}
                            layoutId={chrom.id}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                          >
                            <DraggableChromosome id={chrom.id} chromosome={chrom} displayScale={chromosomeDisplayScale} />
                          </motion.div>
                        ))
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-300">
                          <CheckCircle2 className="w-12 h-12 mb-4 opacity-20" />
                          <p className="text-sm font-medium">Sample fully processed</p>
                        </div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                   <p className="text-[11px] text-slate-500 leading-relaxed italic">
                     "Drag chromosomes to the diagnostic board. Use the banding patterns and size ratio to identify correct pairings."
                   </p>
                </div>
              </div>
            </RawSampleDroppable>
          )}

          {/* Right Panel: Diagnostic Board */}
          <div className={cn(
            "bg-white rounded-2xl border border-slate-200 p-4 lg:p-6 shadow-sm overflow-y-auto print:border-none print:shadow-none print:p-0 flex flex-col print:overflow-visible print:h-auto min-h-0",
            isReviewingCertificate && "col-span-full border-none shadow-none h-full pb-20"
          )}>
             {isReviewingCertificate && (
               <div className="text-center mb-4 hidden print:block !block shrink-0">
                <h1 className="text-4xl font-black text-slate-900 tracking-tighter mb-2">KARYOTYPE DIAGNOSTIC CERTIFICATE</h1>
                <p className="text-lg text-slate-500 font-medium">Assembled and verified by <span className="font-black text-slate-800">{certificateName}</span></p>
                {selectedImage?.karyotype && (
                  <p className="text-sm font-mono font-bold text-slate-700 mt-2">
                    ISCN: {selectedImage.karyotype}
                  </p>
                )}
                <div className="w-24 h-1 bg-slate-200 mx-auto mt-4 rounded-full" />
               </div>
             )}

             <div className="flex flex-1 w-full max-w-6xl mx-auto h-full min-h-0 overflow-auto">
               <div className="flex flex-col gap-2 items-center justify-evenly min-w-min h-full py-2 mx-auto">
                 {CLINICAL_KARYOTYPE_ROWS.map((row, rowIndex) => (
                   <div key={rowIndex} className="flex items-end justify-center gap-8 lg:gap-12">
                     {row.map(group => {
                       const visibleGroups = group.pairIds
                         .map(pairId => pairGroupsById.get(pairId))
                         .filter((entry): entry is NonNullable<typeof entry> => !!entry);
                       if (visibleGroups.length === 0) return null;
                       return (
                         <div key={group.id} className="flex items-end gap-2">
                           <span className="text-[10px] font-black text-slate-300 w-4 mb-5 select-none">
                             {group.id}
                           </span>
                           {visibleGroups.map(pairGroup => (
                             <div key={pairGroup.pairId} className="flex-shrink-0">
                               <KaryotypePair
                                 pairId={pairGroup.pairId}
                                 slotIds={pairGroup.slotIds}
                                 placedChromosomes={placed}
                                 onUpdateChromosome={updatePlaced}
                                 isReviewing={isReviewingCertificate}
                                 displayScale={chromosomeDisplayScale}
                               />
                             </div>
                           ))}
                         </div>
                       );
                     })}
                   </div>
                 ))}
                 {customPairGroups.length > 0 && (
                   <div className="flex items-end justify-center gap-2 pt-2 border-t border-dashed border-slate-100">
                     <span className="text-[10px] font-black text-slate-300 w-4 mb-5 select-none">+</span>
                     {customPairGroups.map(pairGroup => (
                       <div key={pairGroup.pairId} className="flex-shrink-0">
                         <KaryotypePair
                           pairId={pairGroup.pairId}
                           slotIds={pairGroup.slotIds}
                           placedChromosomes={placed}
                           onUpdateChromosome={updatePlaced}
                           isReviewing={isReviewingCertificate}
                           displayScale={chromosomeDisplayScale}
                         />
                       </div>
                     ))}
                   </div>
                 )}
               </div>
             </div>

          </div>
        </main>

        {showHints && (
          <KaryotypeHintModal
            chromosomes={hintChromosomes}
            fullKaryotype={fullHintKaryotype}
            onClose={() => setShowHints(false)}
          />
        )}

        <AnimatePresence>
          {isReviewingCertificate && (
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[500] bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 flex gap-4 print:hidden"
            >
              <button
                onClick={() => setIsReviewingCertificate(false)}
                className="px-6 py-3 rounded-xl font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                BACK
              </button>
              <button
                onClick={() => window.print()}
                className="px-8 py-3 rounded-xl font-bold text-white bg-emerald-500 hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/20"
              >
                PRINT PDF
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isComplete && !isReviewingCertificate && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 print:hidden"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className="bg-white rounded-3xl p-10 max-w-lg w-full flex flex-col items-center text-center shadow-2xl relative"
              >
                <div className="absolute -top-12 w-24 h-24 bg-emerald-500 rounded-full flex items-center justify-center text-white border-4 border-white shadow-xl">
                  <CheckCircle2 className="w-12 h-12" />
                </div>
                
                <h3 className="text-3xl font-black text-emerald-900 mt-10 mb-3">{successPhrase}</h3>
                <p className="text-slate-500 text-lg mb-6 leading-relaxed font-medium">
                  The karyotype has been successfully assembled. All chromosomal pairs are correctly aligned.
                </p>

                <div className="w-full mb-8 flex flex-col items-center">
                  <label htmlFor="cert-name" className="text-sm font-bold text-slate-700 mb-2">Print Karyogram Certificate</label>
                  <input
                    id="cert-name"
                    type="text"
                    placeholder="Enter your name"
                    value={certificateName}
                    onChange={(e) => setCertificateName(e.target.value)}
                    className="w-full max-w-xs px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 text-center font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                  />
                </div>
                
                <div className="flex gap-4 w-full">
                  <button 
                    onClick={() => setGameState('select')}
                    className="flex-1 flex items-center justify-center gap-2 bg-slate-100 text-slate-600 px-4 py-4 rounded-xl font-bold hover:bg-slate-200 transition-colors text-sm"
                  >
                    NEW SAMPLE
                  </button>
                  <button 
                    onClick={resetGame}
                    className="flex-1 flex items-center justify-center gap-2 bg-emerald-50 text-emerald-600 px-4 py-4 rounded-xl font-bold hover:bg-emerald-100 transition-colors text-sm"
                  >
                    RESTART
                  </button>
                  <button 
                    onClick={() => setIsReviewingCertificate(true)}
                    disabled={!certificateName.trim()}
                    className="flex-[1.5] flex items-center justify-center gap-2 bg-emerald-500 text-white px-4 py-4 rounded-xl font-bold hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/30 text-sm disabled:opacity-50 disabled:hover:bg-emerald-500 disabled:shadow-none"
                  >
                    REVIEW & PRINT
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

          <DragOverlay dropAnimation={null}>
            {activeId && currentActiveChromosome ? (
              <div className="z-50 pointer-events-none drop-shadow-2xl">
                <ChromosomeVisual chromosome={currentActiveChromosome} displayScale={chromosomeDisplayScale} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
      )}
    </>
  );
}

