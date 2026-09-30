/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
import { CLINICAL_KARYOTYPE_ROWS, normalizePairId, comparePairIds, MAX_CHROMOSOMES_PER_PAIR, STANDARD_PAIR_IDS, matchRowHighlightForGroup, pairIdsForMatchRow } from './lib/chromosomePairs';
import { normalizeRotation, rotationsMatch, chromosomeTransform } from './lib/orientation';
import { cropBoundsFromPoints, uniformDisplayScale } from './lib/chromosomeCrop';
import { ARRANGE_LEVEL, GAMEPLAY_LEVELS, isGameplayLevel, isLabelLevel, isPresetOrientationLevel, LABEL_ALL_LEVEL, LABEL_MATE_LEVEL, LEARN_LEVEL, LEVELS, MATCH_LEVEL, PAIR_LEVEL, levelProgressLabel } from './lib/levels';
import LabelSpreadLevel, { type NumberPlacement } from './components/LabelSpreadLevel';
import {
  buildPairDescriptionTemplate,
  customPairIdsFromXml,
  downloadTextFile,
  normalizeCsvPairId,
  parsePairDescriptionCsv,
  parsePairNoteOverrides,
  withResolvedPairSentences,
  type PairNoteMap,
} from './lib/pairDescriptions';
import {
  type AnnotationStatus,
  countLabeledChromosomes,
  getAnnotationStatus,
} from './lib/annotationStatus';
import {
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  parseSpreadDifficulty,
  type SpreadDifficulty,
} from './lib/difficulty';
import { motion, AnimatePresence } from 'motion/react';
import {
  Info, CheckCircle2, ChevronRight, Dna, Undo2, ArrowLeft, Lightbulb,
  ShieldCheck, Upload, Play, Beaker, X, Loader, ImageIcon, Zap, Pencil, Trash2, FlipHorizontal, FlipVertical, Expand, Download, FolderPlus, Folder, ZoomIn, ZoomOut, Maximize
} from 'lucide-react';
import KaryotypeHintModal, { type KaryotypeHintChromosome } from './components/KaryotypeHintModal';
import LearnLevel from './components/LearnLevel';

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
  info?: string;
  /** Annotation polygon in source-image pixels. Used to number the metaphase spread. */
  points?: { x: number; y: number }[];
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

type SampleLevelProgress = Partial<Record<number, KaryotypeProgressSummary>>;

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

const orientToExpected = (chromosome: ChromosomeData): ChromosomeData => ({
  ...chromosome,
  userRotation: normalizeRotation(chromosome.expectedRotation),
  userFlipX: !!chromosome.expectedFlipX,
  userFlipY: !!chromosome.expectedFlipY,
});

/** Slot ids match the board: `slot-${pairIndex}-${slotIndex}` in clinical pair order. */
const pairSlotGroups = (chromosomes: ChromosomeData[]) => {
  const membersByPair = new Map<string, ChromosomeData[]>();
  const firstAppearanceOrder: string[] = [];
  chromosomes.forEach(chrom => {
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
      members,
      slotIds: members.map((_, slotIndex) => `slot-${pairIndex}-${slotIndex}`),
    };
  });
};

/** Lowest-ordinal chromosome of every pair that has a partner. Locked on Match. */
const scaffoldChromosomeIds = (chromosomes: ChromosomeData[]) => {
  const ids = new Set<string>();
  for (const group of pairSlotGroups(chromosomes)) {
    if (group.members.length < 2) continue;
    const first = group.members.reduce((best, current) => current.ordinal < best.ordinal ? current : best);
    ids.add(first.id);
  }
  return ids;
};

const buildMatchBoard = (chromosomes: ChromosomeData[], seed: string) => {
  const oriented = chromosomes.map(orientToExpected);
  const placed: Record<string, ChromosomeData> = {};
  const placedIds = new Set<string>();
  for (const group of pairSlotGroups(oriented)) {
    if (group.members.length < 2) continue;
    const first = group.members.reduce((best, current) => current.ordinal < best.ordinal ? current : best);
    placed[group.slotIds[0]] = first;
    placedIds.add(first.id);
  }
  const remaining = oriented.filter(chromosome => !placedIds.has(chromosome.id));
  return {
    jumbled: shuffleChromosomes(remaining, seed),
    placed,
  };
};

/** Same preset orientation as Match, with every slot left empty. */
const buildPairBoard = (chromosomes: ChromosomeData[], seed: string) => ({
  jumbled: shuffleChromosomes(chromosomes.map(orientToExpected), seed),
  placed: {} as Record<string, ChromosomeData>,
});

const buildFreshBoard = (levelId: number, chromosomes: ChromosomeData[], seed: string) => {
  if (levelId === MATCH_LEVEL) return buildMatchBoard(chromosomes, seed);
  if (levelId === PAIR_LEVEL) return buildPairBoard(chromosomes, seed);
  return {
    jumbled: shuffleChromosomes(chromosomes, seed),
    placed: {} as Record<string, ChromosomeData>,
  };
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

/** Numbers the player has put on the spread, including ones on the wrong chromosome. */
const hydrateLabelState = (
  extracted: ChromosomeData[],
  saved: unknown,
  scaffoldIds: ReadonlySet<string>,
): NumberPlacement[] | null => {
  if (!saved || typeof saved !== 'object') return null;
  const record = saved as { placements?: unknown; labeledIds?: unknown };
  const byId = new Map(extracted.map(chromosome => [chromosome.id, chromosome]));
  const available = new Map<string, number>();
  for (const chromosome of extracted) {
    if (scaffoldIds.has(chromosome.id)) continue;
    available.set(chromosome.type, (available.get(chromosome.type) ?? 0) + 1);
  }

  const raw: NumberPlacement[] = [];
  if (Array.isArray(record.placements)) {
    for (const item of record.placements) {
      if (!item || typeof item !== 'object') continue;
      const chromosomeId = (item as { chromosomeId?: unknown }).chromosomeId;
      const pairId = (item as { pairId?: unknown }).pairId;
      if (typeof chromosomeId === 'string' && typeof pairId === 'string') {
        raw.push({ chromosomeId, pairId });
      }
    }
  } else if (Array.isArray(record.labeledIds)) {
    for (const id of record.labeledIds) {
      if (typeof id !== 'string') continue;
      const chromosome = byId.get(id);
      if (chromosome) raw.push({ chromosomeId: id, pairId: chromosome.type });
    }
  } else {
    return null;
  }

  const used = new Map<string, number>();
  const seen = new Set<string>();
  const placements: NumberPlacement[] = [];
  for (const item of raw) {
    if (seen.has(item.chromosomeId) || scaffoldIds.has(item.chromosomeId) || !byId.has(item.chromosomeId)) continue;
    const allowed = available.get(item.pairId) ?? 0;
    const taken = used.get(item.pairId) ?? 0;
    if (taken >= allowed) continue;
    seen.add(item.chromosomeId);
    used.set(item.pairId, taken + 1);
    placements.push(item);
  }
  return placements;
};

const countCorrectLabels = (
  chromosomes: ChromosomeData[],
  placements: NumberPlacement[],
  scaffoldIds: ReadonlySet<string>,
) => {
  const byId = new Map(chromosomes.map(chromosome => [chromosome.id, chromosome]));
  let correct = scaffoldIds.size;
  for (const placement of placements) {
    const chromosome = byId.get(placement.chromosomeId);
    if (chromosome && chromosome.type === placement.pairId && !scaffoldIds.has(chromosome.id)) correct++;
  }
  return correct;
};

// --- Components ---

const ChromosomeVisual = ({ chromosome, className, isDragging = false, isReviewing = false, displayScale = 1, locked = false, highlighted = false }: { chromosome: ChromosomeData, className?: string, isDragging?: boolean, isReviewing?: boolean, displayScale?: number, locked?: boolean, highlighted?: boolean }) => {
  if (chromosome.imageUrl) {
    const displayWidth = (chromosome.width ?? 0) * displayScale;
    const displayHeight = (chromosome.height ?? 0) * displayScale;
    const sized = displayWidth > 0 && displayHeight > 0;
    return (
      <div 
        className={cn(
          "relative flex flex-col items-center justify-end p-1 group",
          locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          isDragging && "opacity-50",
          className
        )}
      >
        <img 
          src={chromosome.imageUrl} 
          className={cn(
            "block print:!drop-shadow-none print:!filter-none",
            !sized && "max-h-[72px] max-w-[36px] object-contain",
            !isReviewing && !highlighted && "drop-shadow-md filter group-hover:drop-shadow-lg transition-shadow",
            highlighted && "drop-shadow-[0_0_10px_rgba(14,165,233,0.95)]"
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
        "relative flex flex-col items-center justify-center p-1",
        locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
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

const DraggableChromosome = ({ id, chromosome, onUpdate, isReviewing, displayScale, locked = false, allowOrientation = true, highlighted = false }: { id: string, chromosome: ChromosomeData, onUpdate?: (id: string, updates: Partial<ChromosomeData>) => void, isReviewing?: boolean, displayScale?: number, locked?: boolean, allowOrientation?: boolean, highlighted?: boolean }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: chromosome,
    disabled: locked,
  });

  return (
    <div className="relative group/chrom">
      <div ref={setNodeRef} {...listeners} {...attributes} className="z-10">
        <ChromosomeVisual chromosome={chromosome} isDragging={isDragging} isReviewing={isReviewing} displayScale={displayScale} locked={locked} highlighted={highlighted} />
      </div>
      {allowOrientation && onUpdate && chromosome.imageUrl && !isDragging && !isReviewing && !locked && (
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

const RawSampleDroppable = ({ id, children, className }: { id: string, children: React.ReactNode, className?: string }) => {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef} className={cn("h-full min-h-0", className)}>{children}</div>;
};

interface KaryotypePairProps {
  pairId: string;
  slotIds: string[];
  placedChromosomes: Record<string, ChromosomeData>;
  onUpdateChromosome: (slotId: string, updates: Partial<ChromosomeData>) => void;
  isReviewing?: boolean;
  displayScale?: number;
  lockedIds?: ReadonlySet<string>;
  allowOrientation?: boolean;
}

/**
 * Renders one pair's group of slots (1-4, dynamically sized to however many
 * chromosomes were annotated for this pair). Order within the group carries
 * no meaning - any chromosome belonging to this pair is valid in any of its
 * slots, as long as its own recorded orientation matches.
 */
const KaryotypePair: React.FC<KaryotypePairProps> = ({ pairId, slotIds, placedChromosomes, onUpdateChromosome, isReviewing, displayScale, lockedIds, allowOrientation = true }) => {
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
              {chrom && (
                <DraggableChromosome
                  id={chrom.id}
                  chromosome={chrom}
                  onUpdate={(id, updates) => onUpdateChromosome(slotId, updates)}
                  isReviewing={isReviewing}
                  displayScale={displayScale}
                  locked={lockedIds?.has(chrom.id)}
                  allowOrientation={allowOrientation}
                />
              )}
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

const SAMPLE_LIST_COLUMNS = 'id, original_url, user_id, uploader_email, bucket_id, karyotype, annotation_complete, pair_note_overrides, difficulty';

async function fetchSampleXml(id: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('samples')
    .select('xml')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data?.xml ?? undefined;
}

async function sampleWithXml(image: AdminImage): Promise<AdminImage> {
  if (image.xml !== undefined) return image;
  const xml = await fetchSampleXml(image.id);
  return { ...image, xml: xml ?? '' };
}

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
      const timer = window.setTimeout(() => reject(new Error('Metaphase image load timed out')), 20000);
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        if (ok) resolve(null);
        else reject(new Error('Metaphase image failed to load'));
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
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
      const info = el.querySelector('info')?.textContent?.trim() || undefined;

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
        info,
        points,
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
  pairNoteOverrides?: PairNoteMap;
  difficulty?: SpreadDifficulty | null;
}

function DifficultyBadge({
  difficulty,
  unsetLabel,
}: {
  difficulty: SpreadDifficulty | null | undefined;
  unsetLabel?: string;
}) {
  if (!difficulty) {
    if (!unsetLabel) return null;
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
        {unsetLabel}
      </span>
    );
  }
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
      difficulty === 'easy' && 'bg-emerald-100 text-emerald-700',
      difficulty === 'moderate' && 'bg-amber-100 text-amber-700',
      difficulty === 'hard' && 'bg-rose-100 text-rose-700',
    )}>
      {DIFFICULTY_LABELS[difficulty]}
    </span>
  );
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
  bucketPairDescriptions: Record<string, PairNoteMap>;
  onBucketPairDescriptionsChange: (bucketId: string, notes: PairNoteMap) => void;
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

const BucketPairCsvControls = ({
  bucket,
  samples,
  notes,
  onChange,
}: {
  bucket: Bucket;
  samples: AdminImage[];
  notes: PairNoteMap;
  onChange: (notes: PairNoteMap) => void;
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadTemplate = async () => {
    setBusy(true);
    setError(null);
    try {
      const xmls = await Promise.all(samples.map(async sample => {
        if (sample.xml !== undefined) return sample.xml;
        try {
          return await fetchSampleXml(sample.id);
        } catch {
          return undefined;
        }
      }));
      const customIds = customPairIdsFromXml(xmls.filter((xml): xml is string => !!xml));
      downloadTextFile(
        `bucket-${bucket.bucketNumber}-pair-descriptions.csv`,
        buildPairDescriptionTemplate(customIds),
      );
    } catch (err: any) {
      setError(err.message || 'Could not build the template.');
    } finally {
      setBusy(false);
    }
  };

  const uploadCsv = async (file: File) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const parsed = parsePairDescriptionCsv(await file.text());
      if (parsed.headerError) {
        setError(parsed.headerError);
        return;
      }
      if (parsed.rows.length === 0) {
        const first = parsed.errors[0];
        setError(first ? `Row ${first.line}: ${first.message}` : 'The CSV has no pair descriptions.');
        return;
      }

      const clearing = parsed.rows.filter(row => !row.description && notes[row.pairId]);
      if (clearing.length > 0) {
        const noun = clearing.length === 1 ? 'description' : 'descriptions';
        const ok = window.confirm(`This file clears ${clearing.length} ${noun} already saved on this bucket. Continue?`);
        if (!ok) return;
      }

      const toSet = parsed.rows.filter(row => row.description);
      const toClear = parsed.rows.filter(row => !row.description).map(row => row.pairId);
      let next = { ...notes };

      if (toClear.length > 0) {
        const { error: deleteError } = await supabase
          .from('bucket_pair_descriptions')
          .delete()
          .eq('bucket_id', bucket.id)
          .in('pair_id', toClear);
        if (deleteError) throw deleteError;
        for (const pairId of toClear) delete next[pairId];
        onChange({ ...next });
      }

      if (toSet.length > 0) {
        const { error: upsertError } = await supabase
          .from('bucket_pair_descriptions')
          .upsert(
            toSet.map(row => ({
              bucket_id: bucket.id,
              pair_id: row.pairId,
              description: row.description,
            })),
            { onConflict: 'bucket_id,pair_id' },
          );
        if (upsertError) throw upsertError;
        next = { ...next };
        for (const row of toSet) next[row.pairId] = row.description;
        onChange(next);
      }

      const touched = new Set(parsed.rows.map(row => row.pairId));
      const kept = samples.flatMap(sample => {
        const pairIds = Object.keys(sample.pairNoteOverrides ?? {}).filter(pairId => touched.has(pairId));
        if (pairIds.length === 0) return [];
        return [`${sample.id.slice(0, 8)} (${pairIds.join(', ')})`];
      });

      const lines = [
        `Saved ${toSet.length} description${toSet.length === 1 ? '' : 's'}. Cleared ${toClear.length}.`,
      ];
      if (parsed.duplicatePairIds.length > 0) {
        lines.push(`Repeated pair ${parsed.duplicatePairIds.join(', ')}; the last row was used.`);
      }
      for (const rowError of parsed.errors) {
        lines.push(`Row ${rowError.line}: ${rowError.message}`);
      }
      if (kept.length > 0) {
        lines.push(`These spreads keep a custom sentence the CSV did not change: ${kept.join('; ')}.`);
      }
      setMessage(lines);
    } catch (err: any) {
      setError(err.message || 'Could not save the CSV.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-bold text-slate-700 mr-auto">Pair descriptions</p>
        <button
          type="button"
          onClick={() => { void downloadTemplate(); }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:border-sky-300 hover:text-sky-700 disabled:opacity-50"
        >
          <Download className="w-3.5 h-3.5" />
          Download template
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <Upload className="w-3.5 h-3.5" />
          {busy ? 'Working...' : 'Upload CSV'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadCsv(file);
          }}
        />
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        Columns: Chromosomal Pair Number, Description. A sentence here is used by every spread in this bucket unless that spread has its own sentence.
      </p>
      {error && <p className="text-[11px] font-medium text-red-600">{error}</p>}
      {message && (
        <div className="space-y-1">
          {message.map(line => (
            <p key={line} className="text-[11px] text-slate-600">{line}</p>
          ))}
        </div>
      )}
    </div>
  );
};

const AdminPanel: React.FC<AdminPanelProps> = ({ onClose, images, imagesLoaded, setImages, session, userRole, bucketPairDescriptions, onBucketPairDescriptionsChange }) => {
  const canCreateBuckets = userRole === 'SUPER ADMIN';
  const canManagePairNotes = userRole === 'ADMIN' || userRole === 'SUPER ADMIN';
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
  const [statusFilter, setStatusFilter] = useState<'all' | AnnotationStatus | 'unrated'>('all');
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

  const persistSpreadDifficulty = async (imageId: string, difficulty: SpreadDifficulty | null) => {
    const { error } = await supabase
      .from('samples')
      .update({ difficulty })
      .eq('id', imageId);
    if (error) throw error;
    setImages(prev => prev.map(img => img.id === imageId ? { ...img, difficulty } : img));
  };

  const filterByStatus = (list: AdminImage[]) => {
    if (statusFilter === 'all') return list;
    if (statusFilter === 'unrated') return list.filter(img => !img.difficulty);
    return list.filter(img => getAnnotationStatus(img.xml, img.annotationComplete) === statusFilter);
  };

  const renderStatusFilters = (list: AdminImage[]) => {
    const counts: Record<AnnotationStatus, number> = { never_started: 0, in_progress: 0, complete: 0 };
    list.forEach(img => {
      counts[getAnnotationStatus(img.xml, img.annotationComplete)]++;
    });
    const unrated = list.filter(img => !img.difficulty).length;
    const chips: { id: 'all' | AnnotationStatus | 'unrated'; label: string; count: number }[] = [
      { id: 'all', label: 'All', count: list.length },
      { id: 'never_started', label: 'Not started', count: counts.never_started },
      { id: 'in_progress', label: 'In progress', count: counts.in_progress },
      { id: 'complete', label: 'Complete', count: counts.complete },
      { id: 'unrated', label: 'Unrated', count: unrated },
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
    const xmlKnown = img.xml !== undefined;
    const status = xmlKnown ? getAnnotationStatus(img.xml, img.annotationComplete) : 'never_started';
    const labeled = xmlKnown ? countLabeledChromosomes(img.xml) : null;
    const showDelete = canDeleteSample(img);

    return (
    <DraggableDatasetImage key={img.id} img={img}>
      <div
        className={cn(
          "bg-white rounded-xl shadow-sm overflow-hidden group relative aspect-square flex flex-col border-2",
          status === 'complete' ? "border-emerald-500" : status === 'in_progress' ? "border-amber-400" : "border-slate-200"
        )}
        onClick={async (e) => {
          if ((e.target as HTMLElement).closest('button, [data-no-dnd]')) return;
          const url = img.originalUrl;
          if (!url) return;
          const sample = await sampleWithXml(img);
          if (sample.xml !== img.xml) {
            setImages(prev => prev.map(item => item.id === sample.id ? sample : item));
          }
          setAnnotateImageUrl(url);
          setAnnotateImageId(sample.id);
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

          {labeled !== null && (
            <div
              className="absolute top-1.5 right-1.5 z-10 h-4 min-w-4 px-1 rounded-full bg-black/70 text-white text-[8px] leading-none font-mono font-bold flex items-center justify-center tabular-nums pointer-events-none"
              title={`${labeled} chromosome${labeled === 1 ? '' : 's'} annotated`}
            >
              {labeled}
            </div>
          )}

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
          <DifficultyBadge difficulty={img.difficulty} unsetLabel="Unrated" />
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
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDeleteError(null);
                  const sample = await sampleWithXml(img);
                  if (sample.xml !== img.xml) {
                    setImages(prev => prev.map(item => item.id === sample.id ? sample : item));
                  }
                  setPendingDelete(sample);
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
        annotationComplete: false,
        pairNoteOverrides: {},
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
            {!imagesLoaded && (
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
                        {canManagePairNotes && (
                          <BucketPairCsvControls
                            key={bucket.id}
                            bucket={bucket}
                            samples={bucketImages}
                            notes={bucketPairDescriptions[bucket.id] ?? {}}
                            onChange={(notes) => onBucketPairDescriptionsChange(bucket.id, notes)}
                          />
                        )}
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
          difficulty={images.find(img => img.id === annotateImageId)?.difficulty}
          bucketPairNotes={(() => {
            const bucketId = images.find(img => img.id === annotateImageId)?.bucketId;
            return bucketId ? bucketPairDescriptions[bucketId] : undefined;
          })()}
          initialPairNoteOverrides={images.find(img => img.id === annotateImageId)?.pairNoteOverrides}
          onSave={async (xml, pairNoteOverrides) => {
            try {
              const labeled = countLabeledChromosomes(xml);
              const payload: { xml: string; pair_note_overrides: PairNoteMap; annotation_complete?: boolean } = {
                xml,
                pair_note_overrides: pairNoteOverrides,
              };
              if (labeled === 0) payload.annotation_complete = false;

              const { error } = await supabase
                .from('samples')
                .update(payload)
                .eq('id', annotateImageId);
              
              if (error) throw error;
              setImages(prev => prev.map(img => img.id === annotateImageId
                ? { ...img, xml, pairNoteOverrides, ...(labeled === 0 ? { annotationComplete: false } : {}) }
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
          onSetDifficulty={async (difficulty) => {
            try {
              await persistSpreadDifficulty(annotateImageId, difficulty);
            } catch (err) {
              console.error('Failed to update spread difficulty:', err);
              alert('Failed to update difficulty.');
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
  loadError: string | null;
  progressBySample: Record<string, SampleLevelProgress>;
  onSelect: (img: AdminImage, extracted: ChromosomeData[]) => Promise<void>;
  onBack: () => void;
}

const SpreadSelectionScreen: React.FC<SpreadSelectionScreenProps> = ({ images, imagesLoaded, loadError, progressBySample, onSelect, onBack }) => {
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | SpreadDifficulty>('all');
  const difficultyCounts = useMemo(() => {
    const counts: Record<SpreadDifficulty, number> = { easy: 0, moderate: 0, hard: 0 };
    for (const img of images) {
      if (img.difficulty) counts[img.difficulty] += 1;
    }
    return counts;
  }, [images]);
  const visibleImages = difficultyFilter === 'all'
    ? images
    : images.filter(img => img.difficulty === difficultyFilter);

  const handleSelect = async (img: AdminImage) => {
    if (extractingId) return;
    setExtractingId(img.id);
    try {
      const sample = await sampleWithXml(img);
      const extracted = await extractChromosomes(sample);
      await onSelect(sample, extracted);
    } finally {
      setExtractingId(null);
    }
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
            <p className="text-slate-500 font-medium mt-2">Choose a metaphase spread to start a level</p>
          </div>
          <button onClick={onBack} className="p-3 hover:bg-slate-200 rounded-full transition-colors text-slate-500">
            <X className="w-6 h-6" />
          </button>
        </header>

        <div className="relative min-h-64 rounded-3xl overflow-hidden">
          {!imagesLoaded && !loadError ? (
            <div className="absolute inset-0 z-20 bg-slate-50 flex flex-col items-center justify-center">
              <Loader className="w-12 h-12 text-sky-500 animate-spin" />
              <p className="mt-4 text-sm font-bold text-slate-600">Loading metaphase spreads...</p>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white rounded-3xl border border-red-200 shadow-sm p-8 text-center">
              <p className="text-lg font-bold text-slate-700">Could not load metaphase spreads</p>
              <p className="text-sm mt-1 text-red-600">{loadError}</p>
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white rounded-3xl border border-slate-200 shadow-sm p-8 text-center">
              <ImageIcon className="w-12 h-12 mb-4 opacity-50 mx-auto" />
              <p className="text-lg font-bold text-slate-700">No metaphase spreads available</p>
              <p className="text-sm mt-1">Please ask the administrator to upload and annotate samples.</p>
            </div>
          ) : (
            <>
            <div className="flex flex-wrap items-center gap-2 mb-6">
              {(['all', ...DIFFICULTIES] as const).map(id => {
                const count = id === 'all' ? images.length : difficultyCounts[id];
                const selected = difficultyFilter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDifficultyFilter(id)}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-bold transition-colors',
                      selected
                        ? id === 'easy'
                          ? 'bg-emerald-500 text-white'
                          : id === 'moderate'
                            ? 'bg-amber-500 text-white'
                            : id === 'hard'
                              ? 'bg-rose-500 text-white'
                              : 'bg-slate-900 text-white'
                        : 'bg-white border border-slate-200 text-slate-500 hover:bg-slate-100'
                    )}
                  >
                    {id === 'all' ? 'All' : DIFFICULTY_LABELS[id]} {count}
                  </button>
                );
              })}
            </div>
            {visibleImages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white rounded-3xl border border-slate-200 shadow-sm p-8 text-center">
                <p className="text-lg font-bold text-slate-700">
                  No {difficultyFilter === 'all' ? '' : `${DIFFICULTY_LABELS[difficultyFilter].toLowerCase()} `}spreads
                </p>
              </div>
            ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {visibleImages.map(img => {
                const savedProgress = progressBySample[img.id];
                return (
                <div
                  key={img.id}
                  onClick={() => handleSelect(img)}
                  className={cn(
                    "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden cursor-pointer group hover:shadow-xl hover:border-sky-300 hover:-translate-y-1 transition-all flex flex-col relative",
                    extractingId === img.id && "pointer-events-none opacity-80"
                  )}
                >
                  {extractingId === img.id && (
                    <div className="absolute inset-0 z-10 bg-white/50 backdrop-blur-[2px] flex flex-col items-center justify-center">
                      <Loader className="w-8 h-8 text-sky-500 animate-spin mb-2" />
                      <span className="text-xs font-bold text-slate-700 bg-white px-2 py-1 rounded shadow-sm">Extracting...</span>
                    </div>
                  )}
                  <div className="relative h-40 bg-slate-100 overflow-hidden">
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
                      {img.difficulty && (
                        <div className="mt-1">
                          <DifficultyBadge difficulty={img.difficulty} />
                        </div>
                      )}
                      <div className="mt-1 space-y-0.5">
                        {LEVELS.map(level => {
                          if (level.id === LEARN_LEVEL) {
                            return (
                              <p key={level.id} className="text-[10px] font-bold text-slate-400">
                                {level.title}
                              </p>
                            );
                          }
                          const summary = savedProgress?.[level.id];
                          return (
                            <p
                              key={level.id}
                              className={cn(
                                "text-[10px] font-bold",
                                summary?.status === 'complete' ? "text-emerald-600" : summary ? "text-sky-600" : "text-slate-400"
                              )}
                            >
                              {level.label} {level.title} · {levelProgressLabel(summary)}
                            </p>
                          );
                        })}
                      </div>
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
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
};

function LevelSidebarButton({
  level,
  summary,
  current,
  busy,
  disabled,
  onStart,
}: {
  level: (typeof LEVELS)[number];
  summary?: KaryotypeProgressSummary;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <button
      type="button"
      title={level.description}
      disabled={disabled}
      onClick={onStart}
      className={cn(
        "shrink-0 text-left rounded-xl border px-3 py-2 min-w-36 lg:min-w-0 transition-colors",
        current
          ? "border-sky-400 bg-sky-50 disabled:opacity-100 cursor-default"
          : "border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40",
        disabled && !current && "opacity-70"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-mono font-bold tracking-widest text-slate-400">
          LEVEL {level.label}
        </p>
        {busy && <Loader className="w-3.5 h-3.5 text-sky-500 animate-spin shrink-0" />}
      </div>
      <p className="text-sm font-black text-slate-900">{level.title}</p>
      {level.id !== LEARN_LEVEL && (
        <p className={cn(
          "text-[10px] font-bold mt-0.5",
          summary?.status === 'complete' ? "text-emerald-600" : summary ? "text-sky-600" : "text-slate-400"
        )}>
          {levelProgressLabel(summary)}
        </p>
      )}
    </button>
  );
}

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

type AppScreen = 'welcome' | 'select' | 'levels' | 'learning' | 'playing' | 'admin';

interface ScreenHistoryEntry {
  screen: AppScreen;
  depth: number;
}

/** Steps above Welcome. Back jumps use this so they stop at the first in-app screen. */
const SCREEN_DEPTH: Record<AppScreen, number> = {
  welcome: 0,
  select: 1,
  admin: 1,
  levels: 2,
  learning: 2,
  playing: 2,
};

function isAppScreen(value: unknown): value is AppScreen {
  return value === 'welcome' || value === 'select' || value === 'levels'
    || value === 'learning' || value === 'playing' || value === 'admin';
}

function readScreenHistory(state: unknown): ScreenHistoryEntry | null {
  if (!state || typeof state !== 'object') return null;
  const entry = state as Partial<ScreenHistoryEntry>;
  if (!isAppScreen(entry.screen) || typeof entry.depth !== 'number') return null;
  return { screen: entry.screen, depth: entry.depth };
}

function LevelBriefModal({
  level,
  onClose,
}: {
  level: (typeof LEVELS)[number];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[460] flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="level-brief-title"
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="font-mono text-[10px] font-bold tracking-widest text-slate-400">LEVEL {level.label}</p>
        <h2 id="level-brief-title" className="mt-1 text-xl font-black text-slate-900">{level.title}</h2>
        <ul className="mt-4 space-y-2.5">
          {level.pointers.map((point) => (
            <li key={point} className="flex gap-2.5 text-sm leading-snug text-slate-600">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-slate-900 py-3 text-sm font-bold text-white transition-colors hover:bg-slate-800"
        >
          Start
        </button>
      </div>
    </div>
  );
}

function SourceSpreadModal({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const zoomRef = useRef(1);
  const panRef = useRef(pan);
  const panDrag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  zoomRef.current = zoom;
  panRef.current = pan;

  const applyZoom = (next: number) => {
    const clamped = Math.min(6, Math.max(1, next));
    zoomRef.current = clamped;
    setZoom(clamped);
    if (clamped <= 1) {
      panRef.current = { x: 0, y: 0 };
      setPan({ x: 0, y: 0 });
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom(zoomRef.current * Math.exp(-event.deltaY * 0.0015));
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoomRef.current <= 1) return;
    if ((event.target as HTMLElement).closest('button')) return;
    panDrag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = {
      x: drag.panX + event.clientX - drag.x,
      y: drag.panY + event.clientY - drag.y,
    };
    panRef.current = next;
    setPan(next);
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDrag.current?.pointerId !== event.pointerId) return;
    panDrag.current = null;
    setPanning(false);
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Metaphase spread"
    >
      <div
        className="relative w-full h-full max-w-6xl"
        onClick={event => event.stopPropagation()}
      >
        <div
          ref={frameRef}
          className={cn(
            'absolute inset-0 overflow-hidden rounded-2xl bg-slate-950 touch-none',
            zoom > 1 && (panning ? 'cursor-grabbing' : 'cursor-grab')
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <img
              src={imageUrl}
              alt="Metaphase spread"
              draggable={false}
              className="max-h-full max-w-full object-contain select-none"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            />
          </div>
          <p className="absolute bottom-3 left-4 text-[10px] font-bold tracking-wide text-white/70 pointer-events-none">
            Scroll to zoom{zoom > 1 ? ' · drag to pan' : ''}
          </p>
        </div>
        <div className="absolute top-3 right-3 flex items-center gap-1 rounded-xl bg-white/95 p-1 shadow-lg">
          <button
            type="button"
            onClick={() => applyZoom(zoom / 1.25)}
            disabled={zoom <= 1}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="w-12 text-center text-[10px] font-mono font-bold text-slate-500">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => applyZoom(zoom * 1.25)}
            disabled={zoom >= 6}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => applyZoom(1)}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100"
            title="Reset view"
            aria-label="Reset view"
          >
            <Maximize className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100"
            title="Close"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Chromy() {
  const [session, setSession] = useState<Session | null>(null);
  const [userRole, setUserRole] = useState<'SUPER ADMIN' | 'ADMIN' | 'USER' | null>(null);
  const [images, setImages] = useState<AdminImage[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const annotationSignatureCacheRef = useRef(new Map<string, { xml: string; signature: string }>());
  const [bucketPairDescriptions, setBucketPairDescriptions] = useState<Record<string, PairNoteMap>>({});
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [samplesLoadError, setSamplesLoadError] = useState<string | null>(null);
  const [gameState, setGameState] = useState<AppScreen>('welcome');
  const [selectedImage, setSelectedImage] = useState<AdminImage | null>(null);
  const [levelChromosomes, setLevelChromosomes] = useState<ChromosomeData[]>([]);
  const [startingLevel, setStartingLevel] = useState<number | null>(null);
  const [activeLevel, setActiveLevel] = useState<number>(ARRANGE_LEVEL);
  const [spreadBusy, setSpreadBusy] = useState(false);
  const [sourceImageLoaded, setSourceImageLoaded] = useState(false);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(false);
  const [levelBriefOpen, setLevelBriefOpen] = useState(false);
  const [originalExtracted, setOriginalExtracted] = useState<ChromosomeData[]>([]);
  const [jumbled, setJumbled] = useState<ChromosomeData[]>([]);
  const [placed, setPlaced] = useState<Record<string, ChromosomeData>>({});
  const [history, setHistory] = useState<{ jumbled: ChromosomeData[], placed: Record<string, ChromosomeData> }[]>([]);
  const [placements, setPlacements] = useState<NumberPlacement[]>([]);
  const [placementHistory, setPlacementHistory] = useState<NumberPlacement[][]>([]);
  const [isReviewingCertificate, setIsReviewingCertificate] = useState(false);
  const [certificateName, setCertificateName] = useState('');
  const [levelCompleteDismissed, setLevelCompleteDismissed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [progressBySample, setProgressBySample] = useState<Record<string, SampleLevelProgress>>({});
  const [progressReady, setProgressReady] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [showHints, setShowHints] = useState(false);
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const [hasUsedRowHighlight, setHasUsedRowHighlight] = useState(false);
  const progressSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const spreadBusyRef = useRef(false);
  const libraryLoadedForUserRef = useRef<string | null>(null);
  const previousUserIdRef = useRef<string | null>(null);
  const progressSignatureRef = useRef<Record<string, string>>({});
  const selectedImageRef = useRef<AdminImage | null>(null);
  const screenDepthRef = useRef(0);
  const historySeededRef = useRef(false);
  const fromHistoryRef = useRef(false);
  const showScreenFromHistoryRef = useRef<(screen: AppScreen) => void>(() => {});
  selectedImageRef.current = selectedImage;

  const showScreenFromHistory = (screen: AppScreen) => {
    const needsSample = screen === 'levels' || screen === 'learning' || screen === 'playing';
    if (needsSample && !selectedImageRef.current) {
      setGameState('select');
      return;
    }
    if (screen === 'learning' || screen === 'levels') {
      setActiveLevel(LEARN_LEVEL);
      setGameState('playing');
      if (screen === 'levels') {
        const depth = SCREEN_DEPTH.playing;
        window.history.replaceState({ screen: 'playing', depth }, '', window.location.href);
        screenDepthRef.current = depth;
      }
      return;
    }
    setGameState(screen);
  };
  showScreenFromHistoryRef.current = showScreenFromHistory;

  useLayoutEffect(() => {
    if (gameState !== 'levels') return;
    if (!selectedImageRef.current) {
      setGameState('select');
      return;
    }
    setActiveLevel(LEARN_LEVEL);
    setIsReviewingCertificate(false);
    setProgressReady(false);
    const depth = SCREEN_DEPTH.playing;
    window.history.replaceState({ screen: 'playing', depth }, '', window.location.href);
    screenDepthRef.current = depth;
    setGameState('playing');
  }, [gameState]);

  const pushScreen = (screen: AppScreen) => {
    const current = readScreenHistory(window.history.state);
    if (current?.screen === screen) {
      screenDepthRef.current = current.depth;
      setGameState(screen);
      return;
    }
    const depth = SCREEN_DEPTH[screen];
    window.history.pushState({ screen, depth }, '', window.location.href);
    screenDepthRef.current = depth;
    fromHistoryRef.current = false;
    setGameState(screen);
  };

  const backScreen = () => {
    fromHistoryRef.current = true;
    window.history.back();
  };

  const jumpToScreen = (screen: 'welcome' | 'select') => {
    const delta = SCREEN_DEPTH[screen] - screenDepthRef.current;
    if (delta >= 0) return;
    fromHistoryRef.current = true;
    window.history.go(delta);
  };

  useLayoutEffect(() => {
    if (!session || historySeededRef.current) return;
    historySeededRef.current = true;
    const current = readScreenHistory(window.history.state);
    if (current?.screen === 'welcome' && current.depth === 0) {
      screenDepthRef.current = 0;
      return;
    }
    window.history.replaceState({ screen: 'welcome', depth: 0 }, '', window.location.href);
    screenDepthRef.current = 0;
  }, [session]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      fromHistoryRef.current = true;
      const entry = readScreenHistory(event.state);
      const screen = entry?.screen ?? 'welcome';
      screenDepthRef.current = entry?.depth ?? SCREEN_DEPTH[screen];
      // Apply after the browser finishes this history event so the update
      // reaches the screen that is actually showing.
      window.setTimeout(() => {
        showScreenFromHistoryRef.current(screen);
      }, 0);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!fromHistoryRef.current) return;
    fromHistoryRef.current = false;
  }, [gameState]);

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
    const userId = session?.user?.id ?? null;
    if (previousUserIdRef.current && previousUserIdRef.current !== userId) {
      libraryLoadedForUserRef.current = null;
      progressSignatureRef.current = {};
      setImages([]);
      setBucketPairDescriptions({});
      setImagesLoaded(false);
      setSamplesLoadError(null);
      setProgressBySample({});
    }
    previousUserIdRef.current = userId;

    if (!userId) return;
    if (gameState !== 'select' && gameState !== 'admin') return;
    if (libraryLoadedForUserRef.current === userId) return;

    let cancelled = false;
    setImagesLoaded(false);
    setSamplesLoadError(null);

    const loadLibrary = async () => {
      try {
        const [samplesResult, progressResult, descriptionsResult] = await Promise.all([
          supabase
            .from('samples')
            .select(SAMPLE_LIST_COLUMNS)
            .order('created_at', { ascending: false }),
          supabase
            .from('karyotype_progress')
            .select('sample_id, level, annotation_signature, status, correct_count, total_count')
            .eq('user_id', userId),
          supabase
            .from('bucket_pair_descriptions')
            .select('bucket_id, pair_id, description'),
        ]);

        if (cancelled) return;
        if (samplesResult.error) throw samplesResult.error;

        const loadedImages: AdminImage[] = (samplesResult.data ?? []).map(row => ({
          id: row.id,
          originalUrl: row.original_url,
          userId: row.user_id,
          uploaderEmail: row.uploader_email,
          bucketId: row.bucket_id ?? null,
          karyotype: row.karyotype ?? undefined,
          annotationComplete: row.annotation_complete === true,
          pairNoteOverrides: parsePairNoteOverrides(row.pair_note_overrides),
          difficulty: parseSpreadDifficulty(row.difficulty),
        }));

        const signatures: Record<string, string> = {};
        const summaries: Record<string, SampleLevelProgress> = {};
        if (progressResult.error) {
          console.error('Failed to load karyotyping progress summaries', progressResult.error);
        } else {
          const imageIds = new Set(loadedImages.map(image => image.id));
          for (const row of progressResult.data ?? []) {
            if (!imageIds.has(row.sample_id)) continue;
            const level = Number(row.level);
            if (!isGameplayLevel(level)) continue;
            signatures[`${row.sample_id}:${level}`] = row.annotation_signature ?? '';
            const sample = summaries[row.sample_id] ?? {};
            sample[level] = {
              status: row.status === 'complete' ? 'complete' : 'in_progress',
              correctCount: row.correct_count ?? 0,
              totalCount: row.total_count ?? 0,
            };
            summaries[row.sample_id] = sample;
          }
        }

        if (cancelled) return;
        progressSignatureRef.current = signatures;
        setImages(loadedImages);
        setProgressBySample(summaries);
        if (descriptionsResult.error) {
          console.error('Failed to load bucket pair descriptions', descriptionsResult.error);
          setBucketPairDescriptions({});
        } else {
          const byBucket: Record<string, PairNoteMap> = {};
          for (const row of descriptionsResult.data ?? []) {
            const pairId = normalizeCsvPairId(String(row.pair_id ?? ''));
            const description = String(row.description ?? '').trim();
            if (!pairId || !description || !row.bucket_id) continue;
            const notes = byBucket[row.bucket_id] ?? {};
            notes[pairId] = description;
            byBucket[row.bucket_id] = notes;
          }
          setBucketPairDescriptions(byBucket);
        }
        setSamplesLoadError(null);
        setImagesLoaded(true);
        libraryLoadedForUserRef.current = userId;
      } catch (e: any) {
        if (cancelled) return;
        console.error('Failed to load images from Supabase', e);
        setSamplesLoadError(e?.message || 'The sample library could not be loaded.');
        setImagesLoaded(true);
      }
    };

    void loadLibrary();
    return () => {
      cancelled = true;
    };
  }, [gameState, session?.user?.id]);

  // The sample list omits annotation XML. Load each spread's XML on its own
  // so completion outlines and chromosome counts appear without opening a spread.
  // This must not restart when `images` updates, or the first result cancels the rest.
  useEffect(() => {
    if (!imagesLoaded) return;
    if (gameState !== 'admin' && gameState !== 'select') return;

    let cancelled = false;
    const claimed = new Set<string>();
    const pending = new Map<string, string>();
    let flushTimer = 0;
    const flush = () => {
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = 0;
      }
      if (cancelled || pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setImages(prev => {
        let changed = false;
        const next = prev.map(img => {
          const xml = batch.get(img.id);
          if (xml === undefined || img.xml !== undefined) return img;
          changed = true;
          return { ...img, xml };
        });
        return changed ? next : prev;
      });
    };
    const queueXml = (id: string, xml: string) => {
      pending.set(id, xml);
      if (pending.size >= 12) flush();
      else if (!flushTimer) flushTimer = window.setTimeout(flush, 120);
    };
    const claimNext = () => {
      const image = imagesRef.current.find(item => item.xml === undefined && !claimed.has(item.id));
      if (!image) return null;
      claimed.add(image.id);
      return image.id;
    };
    const worker = async () => {
      while (!cancelled) {
        const id = claimNext();
        if (!id) return;
        try {
          const xml = (await fetchSampleXml(id)) ?? '';
          if (cancelled) return;
          queueXml(id, xml);
        } catch (error) {
          console.error('Failed to load annotation status', error);
        }
      }
    };

    const pendingCount = imagesRef.current.filter(img => img.xml === undefined).length;
    const workerCount = Math.min(4, pendingCount);
    if (workerCount > 0) {
      void Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => {
        if (!cancelled) flush();
      });
    }

    return () => {
      cancelled = true;
      if (flushTimer) window.clearTimeout(flushTimer);
    };
  }, [gameState, imagesLoaded]);

  useEffect(() => {
    const stale = images.flatMap(image => {
      if (image.xml === undefined) return [];
      const cached = annotationSignatureCacheRef.current.get(image.id);
      const current = cached && cached.xml === image.xml
        ? cached.signature
        : annotationSignature(image.xml);
      if (!cached || cached.xml !== image.xml) {
        annotationSignatureCacheRef.current.set(image.id, { xml: image.xml, signature: current });
      }
      return GAMEPLAY_LEVELS.flatMap(levelId => {
        const signature = progressSignatureRef.current[`${image.id}:${levelId}`];
        if (signature === undefined || signature === current) return [];
        return [{ id: image.id, levelId }];
      });
    });
    if (stale.length === 0) return;
    for (const entry of stale) delete progressSignatureRef.current[`${entry.id}:${entry.levelId}`];
    setProgressBySample(prev => {
      let changed = false;
      const next: Record<string, SampleLevelProgress> = { ...prev };
      for (const entry of stale) {
        const sample = next[entry.id];
        if (!sample?.[entry.levelId]) continue;
        changed = true;
        const rest = { ...sample };
        delete rest[entry.levelId];
        next[entry.id] = rest;
      }
      return changed ? next : prev;
    });
  }, [images]);

  useEffect(() => {
    setSourceImageLoaded(false);
    setSourcePreviewOpen(false);
  }, [selectedImage?.id]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over, active } = event;
    setActiveId(null);

    const chromosome = active.data.current as ChromosomeData;
    if (!chromosome || lockedChromosomeIds.has(chromosome.id)) return;

    const slotId = over && over.id !== 'raw-sample-panel' ? String(over.id) : null;
    if (slotId) {
      const occupant = placed[slotId];
      if (occupant && lockedChromosomeIds.has(occupant.id)) return;
    }

    setProgressReady(true);

    // Handle dropping back to "Raw Sample" panel
    if (!slotId) {
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

  const commitPlacements = (next: NumberPlacement[]) => {
    setProgressReady(true);
    setPlacementHistory(prev => [...prev.slice(-19), placements]);
    setPlacements(next);
  };

  const undo = () => {
    if (isLabelLevel(activeLevel)) {
      if (placementHistory.length === 0) return;
      setProgressReady(true);
      setPlacements(placementHistory[placementHistory.length - 1]);
      setPlacementHistory(prev => prev.slice(0, -1));
      return;
    }
    if (history.length === 0) return;
    setProgressReady(true);
    const lastState = history[history.length - 1];
    setJumbled(lastState.jumbled);
    setPlaced(lastState.placed);
    setHistory(prev => prev.slice(0, -1));
  };

  const resetGame = () => {
    setProgressReady(false);
    const source = originalExtracted.length > 0 ? originalExtracted : createInitialChromosomes();
    if (originalExtracted.length === 0) setOriginalExtracted(source);
    if (isLabelLevel(activeLevel)) {
      setPlacements([]);
      setPlacementHistory([]);
    } else {
      const seed = selectedImage?.id ?? 'default';
      const board = buildFreshBoard(activeLevel, source, seed);
      setJumbled(board.jumbled);
      setPlaced(board.placed);
    }
    setHistory([]);
    setGameState('playing');

    if (session?.user && selectedImage) {
      const sampleId = selectedImage.id;
      const userId = session.user.id;
      const levelId = activeLevel;
      delete progressSignatureRef.current[`${sampleId}:${levelId}`];
      setProgressBySample(prev => {
        const sample = prev[sampleId];
        if (!sample) return prev;
        const nextSample = { ...sample };
        delete nextSample[levelId];
        return { ...prev, [sampleId]: nextSample };
      });
      progressSaveQueueRef.current = progressSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const { error } = await supabase
            .from('karyotype_progress')
            .delete()
            .eq('user_id', userId)
            .eq('sample_id', sampleId)
            .eq('level', levelId);
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
    const message = isLabelLevel(activeLevel)
      ? 'Reset this level? Your current progress will be cleared.'
      : 'Reset this karyotype? Your current progress will be cleared.';
    if (window.confirm(message)) {
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
  const pairGroups = useMemo(
    () => pairSlotGroups(originalExtracted).map(({ pairId, slotIds }) => ({ pairId, slotIds })),
    [originalExtracted]
  );

  const lockedChromosomeIds = useMemo(
    () => activeLevel === MATCH_LEVEL ? scaffoldChromosomeIds(originalExtracted) : new Set<string>(),
    [activeLevel, originalExtracted]
  );

  const labelScaffoldIds = useMemo(
    () => activeLevel === LABEL_MATE_LEVEL ? scaffoldChromosomeIds(originalExtracted) : new Set<string>(),
    [activeLevel, originalExtracted]
  );

  const orientationPreset = isPresetOrientationLevel(activeLevel);
  const rowHighlightEnabled = orientationPreset || activeLevel === ARRANGE_LEVEL;

  const highlightedPairIds = useMemo(() => {
    if (!rowHighlightEnabled || !highlightedRowId) return null;
    return new Set(pairIdsForMatchRow(highlightedRowId));
  }, [rowHighlightEnabled, highlightedRowId]);

  useLayoutEffect(() => {
    if (!highlightedRowId) return;
    const timer = window.setTimeout(() => setHighlightedRowId(null), 3000);
    document.querySelector('[data-row-match="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => window.clearTimeout(timer);
  }, [highlightedRowId]);

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
  // Mate and Label count every numbered chromosome, including ones given at the start.
  useEffect(() => {
    if (isLabelLevel(activeLevel)) {
      const given = activeLevel === LABEL_MATE_LEVEL ? scaffoldChromosomeIds(originalExtracted) : new Set<string>();
      const correctCount = countCorrectLabels(originalExtracted, placements, given);
      setScore(prev => prev.correct === correctCount ? prev : { ...prev, correct: correctCount });
      return;
    }
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
  }, [placed, slotPairMap, activeLevel, placements, originalExtracted]);

  const progress = (score.correct / score.total) * 100;
  const isComplete = progress === 100 && score.total > 0;
  const spreadComplete = !!selectedImage && GAMEPLAY_LEVELS.every(levelId => (
    levelId === activeLevel
      ? isComplete
      : progressBySample[selectedImage.id]?.[levelId]?.status === 'complete'
  ));
  const finishedLevel = LEVELS.find(level => level.id === activeLevel);

  useEffect(() => {
    if (!isComplete) setLevelCompleteDismissed(false);
  }, [isComplete, activeLevel, selectedImage?.id]);

  useEffect(() => {
    if (
      gameState !== 'playing' ||
      !progressReady ||
      !session?.user ||
      !selectedImage ||
      score.total === 0
    ) return;

    const status: KaryotypeProgressSummary['status'] = isComplete ? 'complete' : 'in_progress';
    const savedState = isLabelLevel(activeLevel)
      ? { placements }
      : serializeKaryotypeState(jumbled, placed);
    const now = new Date().toISOString();
    const userId = session.user.id;
    const sampleId = selectedImage.id;
    progressSignatureRef.current[`${sampleId}:${activeLevel}`] = annotationSignature(selectedImage.xml);

    setProgressBySample(prev => ({
      ...prev,
      [sampleId]: {
        ...prev[sampleId],
        [activeLevel]: {
          status,
          correctCount: score.correct,
          totalCount: score.total,
        },
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
            level: activeLevel,
            state: savedState,
            annotation_signature: annotationSignature(selectedImage.xml),
            status,
            correct_count: score.correct,
            total_count: score.total,
            completed_at: isComplete ? now : null,
            updated_at: now,
          }, { onConflict: 'user_id,sample_id,level' });

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
    placements,
    placed,
    progressReady,
    score.correct,
    score.total,
    selectedImage,
    session?.user,
    activeLevel,
  ]);

  const annotatedSpreads = useMemo(
    () => images.filter(img => hasAnnotations(img.xml)),
    [images]
  );
  const learnSpreadIndex = selectedImage
    ? annotatedSpreads.findIndex(img => img.id === selectedImage.id)
    : -1;
  const learnChromosomes = useMemo(() => {
    if (!selectedImage) return levelChromosomes;
    const latest = images.find(image => image.id === selectedImage.id) ?? selectedImage;
    const bucketNotes = latest.bucketId ? bucketPairDescriptions[latest.bucketId] : undefined;
    return withResolvedPairSentences(levelChromosomes, latest.pairNoteOverrides, bucketNotes);
  }, [bucketPairDescriptions, images, levelChromosomes, selectedImage]);

  const openPlayLevel = async (levelId: number) => {
    if (!selectedImage) return;
    setProgressReady(false);
    const playableChromosomes = levelChromosomes.length > 0
      ? levelChromosomes
      : createInitialChromosomes();
    const labeling = isLabelLevel(levelId);
    const labelScaffold = levelId === LABEL_MATE_LEVEL
      ? scaffoldChromosomeIds(playableChromosomes)
      : new Set<string>();
    let restored: { jumbled: ChromosomeData[]; placed: Record<string, ChromosomeData> } | null = null;
    let restoredPlacements: NumberPlacement[] | null = null;
    let restoredCorrectCount = 0;

    if (session?.user) {
      await progressSaveQueueRef.current.catch(() => undefined);
      const { data, error } = await supabase
        .from('karyotype_progress')
        .select('state, annotation_signature, correct_count')
        .eq('user_id', session.user.id)
        .eq('sample_id', selectedImage.id)
        .eq('level', levelId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load karyotyping progress', error);
        setProgressError('Saved progress could not be loaded. A new board was started instead.');
      } else if (data?.annotation_signature === annotationSignature(selectedImage.xml)) {
        progressSignatureRef.current[`${selectedImage.id}:${levelId}`] = data.annotation_signature ?? '';
        if (labeling) {
          restoredPlacements = hydrateLabelState(playableChromosomes, data.state, labelScaffold);
          if (restoredPlacements) {
            restoredCorrectCount = Math.min(
              playableChromosomes.length,
              countCorrectLabels(playableChromosomes, restoredPlacements, labelScaffold)
            );
          }
        } else {
          restored = hydrateKaryotypeState(playableChromosomes, data.state);
          if (restored) {
            restoredCorrectCount = Math.max(
              0,
              Math.min(Number(data.correct_count) || 0, playableChromosomes.length)
            );
          }
        }
      } else if (data) {
        const sampleId = selectedImage.id;
        delete progressSignatureRef.current[`${sampleId}:${levelId}`];
        setProgressBySample(prev => {
          const sample = prev[sampleId];
          if (!sample?.[levelId]) return prev;
          const nextSample = { ...sample };
          delete nextSample[levelId];
          return { ...prev, [sampleId]: nextSample };
        });
      }
    }

    const fresh = buildFreshBoard(levelId, playableChromosomes, selectedImage.id);

    setActiveLevel(levelId);
    setLevelBriefOpen(true);
    setHighlightedRowId(null);
    setOriginalExtracted(playableChromosomes);
    setJumbled(restored?.jumbled ?? fresh.jumbled);
    setPlaced(restored?.placed ?? fresh.placed);
    setPlacements(restoredPlacements ?? []);
    setPlacementHistory([]);
    setScore({
      correct: labeling
        ? (restoredPlacements ? restoredCorrectCount : labelScaffold.size)
        : (restored ? restoredCorrectCount : Object.keys(fresh.placed).length),
      total: playableChromosomes.length,
    });
    setHistory([]);
    setCertificateName('');
    setIsReviewingCertificate(false);
    setProgressReady(false);
    pushScreen('playing');
  };

  const openLearnLevel = async () => {
    if (!selectedImageRef.current) return;
    await progressSaveQueueRef.current.catch(() => undefined);
    setProgressReady(false);
    setIsReviewingCertificate(false);
    setActiveLevel(LEARN_LEVEL);
    setLevelBriefOpen(true);
    pushScreen('playing');
  };

  const switchLearnSpread = async (image: AdminImage) => {
    if (spreadBusyRef.current || image.id === selectedImage?.id) return;
    spreadBusyRef.current = true;
    setSpreadBusy(true);
    setProgressError(null);
    try {
      const sample = await sampleWithXml(image);
      const extracted = await extractChromosomes(sample);
      if (extracted.length === 0) {
        setProgressError('That metaphase spread could not be opened.');
        return;
      }
      setSelectedImage(sample);
      setImages(prev => {
        if (sample.xml === undefined) return prev;
        const index = prev.findIndex(item => item.id === sample.id);
        if (index < 0 || prev[index].xml === sample.xml) return prev;
        const next = prev.slice();
        next[index] = { ...prev[index], xml: sample.xml };
        return next;
      });
      setLevelChromosomes(extracted);
      setActiveLevel(LEARN_LEVEL);
      setGameState('playing');
    } catch (error) {
      console.error('Failed to open spread', error);
      setProgressError('That metaphase spread could not be opened.');
    } finally {
      spreadBusyRef.current = false;
      setSpreadBusy(false);
    }
  };

  const openLevel = async (levelId: number) => {
    if (startingLevel !== null) return;
    if (levelId === activeLevel && gameState === 'playing') return;
    setShowHints(false);
    setStartingLevel(levelId);
    setProgressError(null);
    try {
      if (levelId === LEARN_LEVEL) await openLearnLevel();
      else await openPlayLevel(levelId);
    } finally {
      setStartingLevel(null);
    }
  };

  const finishLearn = () => {
    backScreen();
  };

  const finishLearnAndOpenNext = () => {
    const next = annotatedSpreads[learnSpreadIndex + 1];
    if (!next) {
      finishLearn();
      return;
    }
    void switchLearnSpread(next);
  };

  const toggleRowHighlight = (rowId: string) => {
    setHasUsedRowHighlight(true);
    setHighlightedRowId(current => current === rowId ? null : rowId);
  };

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
            onStart={() => pushScreen('select')} 
            onAdmin={() => pushScreen('admin')} 
            onSignOut={async () => {
              await supabase.auth.signOut();
            }}
            userRole={userRole}
          />
        )}
        {gameState === 'select' && (
          <SpreadSelectionScreen
            key="select"
            images={images}
            imagesLoaded={imagesLoaded}
            loadError={samplesLoadError}
            progressBySample={progressBySample}
            onBack={() => backScreen()}
            onSelect={async (img, extracted) => {
              const playableChromosomes = extracted.length > 0
                ? extracted
                : createInitialChromosomes();
              setProgressError(null);
              setSelectedImage(img);
              if (img.xml !== undefined) {
                setImages(prev => {
                  const index = prev.findIndex(item => item.id === img.id);
                  if (index < 0 || prev[index].xml === img.xml) return prev;
                  const next = prev.slice();
                  next[index] = { ...prev[index], xml: img.xml };
                  return next;
                });
              }
              setLevelChromosomes(playableChromosomes);
              selectedImageRef.current = img;
              void openLearnLevel();
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
            bucketPairDescriptions={bucketPairDescriptions}
            onBucketPairDescriptionsChange={(bucketId, notes) => {
              setBucketPairDescriptions(prev => ({ ...prev, [bucketId]: notes }));
            }}
            onClose={() => backScreen()} 
          />
        )}
      </AnimatePresence>

      {gameState === 'playing' && (
      <div>
        <DndContext
          sensors={sensors}
          autoScroll={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {/* Header */}
        <header className={cn("fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-200 z-50 px-6 flex items-center justify-between print:hidden", isReviewingCertificate && "hidden")}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => backScreen()}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500 hover:text-slate-900"
              title="Back to samples"
              aria-label="Back to samples"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => jumpToScreen('welcome')}>
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

          {activeLevel !== LEARN_LEVEL && (
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
               {!isLabelLevel(activeLevel) && (
               <button
                  onClick={() => setShowHints(true)}
                  className="px-3 py-2 hover:bg-amber-50 rounded-lg transition-colors text-xs font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1.5"
                  title="Get a chromosome hint"
                >
                  <Lightbulb className="w-4 h-4" />
                  HINT
               </button>
               )}

               <button 
                  onClick={undo}
                  disabled={isLabelLevel(activeLevel) ? placementHistory.length === 0 : history.length === 0}
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
          )}
        </header>

        {gameState === 'playing' && progressError && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-700 shadow-lg print:hidden">
            {progressError}
          </div>
        )}

        {!isReviewingCertificate && activeLevel !== LEARN_LEVEL && selectedImage?.karyotype && (
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
          "px-6 grid gap-4 overflow-hidden print:h-auto print:overflow-visible print:block",
          isReviewingCertificate
            ? "pt-6 h-screen grid-cols-1"
            : cn(
                "pt-16 pb-4 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]",
                selectedImage?.karyotype && activeLevel !== LEARN_LEVEL ? "h-[calc(100vh-2.5rem)]" : "h-screen"
              )
        )}>

          {!isReviewingCertificate && selectedImage && (
            <aside className="min-h-0 h-full flex flex-row lg:flex-col gap-3 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto print:hidden lg:col-start-1 lg:row-start-1">
              <div className="w-28 lg:w-full h-20 lg:h-28 shrink-0 rounded-xl overflow-hidden border border-slate-200 relative shadow-sm bg-black group/source">
                {!sourceImageLoaded && (
                  <div className="absolute inset-0 z-10 bg-slate-100 flex items-center justify-center">
                    <Loader className="w-6 h-6 text-sky-500 animate-spin" />
                  </div>
                )}
                <img
                  src={selectedImage.originalUrl}
                  alt="Selected metaphase spread"
                  onLoad={() => setSourceImageLoaded(true)}
                  onError={() => setSourceImageLoaded(true)}
                  className={cn(
                    "w-full h-full object-cover",
                    sourceImageLoaded ? "opacity-100" : "opacity-0"
                  )}
                />
                <div className="absolute top-1.5 left-1.5 bg-slate-900/80 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                  SOURCE
                </div>
                <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 group-hover/source:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setSourcePreviewOpen(true)}
                    className="w-7 h-7 rounded-lg bg-white text-slate-900 hover:bg-sky-50 flex items-center justify-center"
                    title="Expand metaphase spread"
                    aria-label="Expand metaphase spread"
                  >
                    <Expand className="w-3.5 h-3.5" />
                  </button>
                  {(userRole === 'ADMIN' || userRole === 'SUPER ADMIN') && (
                    <a
                      href={selectedImage.originalUrl}
                      download={`chromy-sample-${selectedImage.id}.png`}
                      className="w-7 h-7 rounded-lg bg-white text-slate-900 hover:bg-sky-50 flex items-center justify-center"
                      title="Download source image"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex flex-row lg:flex-col gap-2 min-w-0">
                <h2 className="hidden lg:block text-sm font-bold uppercase tracking-wider text-slate-400">
                  Levels
                </h2>
                <LevelSidebarButton
                  level={LEVELS.find(level => level.id === LEARN_LEVEL)!}
                  summary={progressBySample[selectedImage.id]?.[LEARN_LEVEL]}
                  current={activeLevel === LEARN_LEVEL}
                  busy={startingLevel === LEARN_LEVEL}
                  disabled={startingLevel !== null || activeLevel === LEARN_LEVEL}
                  onStart={() => { void openLevel(LEARN_LEVEL); }}
                />
                <div className="flex flex-row lg:flex-col gap-2 min-w-0">
                  <p className={cn(
                    "shrink-0 self-center lg:self-start px-1 text-[10px] font-mono font-bold tracking-widest",
                    activeLevel === MATCH_LEVEL || activeLevel === PAIR_LEVEL || activeLevel === ARRANGE_LEVEL ? "text-sky-600" : "text-slate-400"
                  )}>
                    LEVEL 2
                  </p>
                  <div className="flex flex-row lg:flex-col gap-2 min-w-0 lg:ml-2 lg:pl-3 lg:border-l lg:border-slate-200">
                    {LEVELS.filter(level => level.id === MATCH_LEVEL || level.id === PAIR_LEVEL || level.id === ARRANGE_LEVEL).map(level => (
                      <LevelSidebarButton
                        key={level.id}
                        level={level}
                        summary={progressBySample[selectedImage.id]?.[level.id]}
                        current={activeLevel === level.id}
                        busy={startingLevel === level.id}
                        disabled={startingLevel !== null || activeLevel === level.id}
                        onStart={() => { void openLevel(level.id); }}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-row lg:flex-col gap-2 min-w-0">
                  <p className={cn(
                    "shrink-0 self-center lg:self-start px-1 text-[10px] font-mono font-bold tracking-widest",
                    activeLevel === LABEL_MATE_LEVEL || activeLevel === LABEL_ALL_LEVEL ? "text-sky-600" : "text-slate-400"
                  )}>
                    LEVEL 3
                  </p>
                  <div className="flex flex-row lg:flex-col gap-2 min-w-0 lg:ml-2 lg:pl-3 lg:border-l lg:border-slate-200">
                    {LEVELS.filter(level => level.id === LABEL_MATE_LEVEL || level.id === LABEL_ALL_LEVEL).map(level => (
                      <LevelSidebarButton
                        key={level.id}
                        level={level}
                        summary={progressBySample[selectedImage.id]?.[level.id]}
                        current={activeLevel === level.id}
                        busy={startingLevel === level.id}
                        disabled={startingLevel !== null || activeLevel === level.id}
                        onStart={() => { void openLevel(level.id); }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </aside>
          )}

          <div className={cn(
            "min-h-0 min-w-0 h-full flex flex-col gap-4",
            !isReviewingCertificate && "lg:col-start-2 lg:row-start-1"
          )}>
          {activeLevel === LEARN_LEVEL && selectedImage ? (
            <LearnLevel
              key={selectedImage.id}
              embedded
              chromosomes={learnChromosomes}
              karyotype={selectedImage.karyotype}
              spreadIndex={learnSpreadIndex}
              spreadCount={annotatedSpreads.length}
              spreadBusy={spreadBusy}
              onPreviousSpread={() => {
                const previous = annotatedSpreads[learnSpreadIndex - 1];
                if (previous) void switchLearnSpread(previous);
              }}
              onNextSpread={() => {
                const next = annotatedSpreads[learnSpreadIndex + 1];
                if (next) void switchLearnSpread(next);
              }}
              onFinishSpread={
                learnSpreadIndex >= 0 && learnSpreadIndex < annotatedSpreads.length - 1
                  ? finishLearnAndOpenNext
                  : undefined
              }
              onBack={() => backScreen()}
              onFinish={finishLearn}
            />
          ) : isLabelLevel(activeLevel) && selectedImage ? (
            <>
            {isReviewingCertificate && (
              <div className="text-center mb-4 shrink-0">
                <h1 className="text-4xl font-black text-slate-900 tracking-tighter mb-2">KARYOTYPE DIAGNOSTIC CERTIFICATE</h1>
                <p className="text-lg text-slate-500 font-medium">Assembled and verified by <span className="font-black text-slate-800">{certificateName}</span></p>
                {selectedImage.karyotype && (
                  <p className="text-sm font-mono font-bold text-slate-700 mt-2">
                    ISCN: {selectedImage.karyotype}
                  </p>
                )}
                <div className="w-24 h-1 bg-slate-200 mx-auto mt-4 rounded-full" />
              </div>
            )}
            <LabelSpreadLevel
              key={`${selectedImage.id}:${activeLevel}`}
              imageUrl={selectedImage.originalUrl}
              chromosomes={originalExtracted}
              placements={placements}
              scaffoldIds={labelScaffoldIds}
              assisted={activeLevel === LABEL_MATE_LEVEL}
              onPlacementsChange={commitPlacements}
            />
            </>
          ) : (
          <>
          {/* Diagnostic Board */}
          <div className={cn(
            "bg-white rounded-2xl border border-slate-200 p-4 lg:p-6 shadow-sm overflow-y-auto print:border-none print:shadow-none print:p-0 flex flex-col print:overflow-visible print:h-auto min-h-0 flex-1",
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

             {rowHighlightEnabled && !isReviewingCertificate && (
               <p className="shrink-0 text-center text-xs font-medium text-slate-500 mb-2 print:hidden">
                 Click a row to highlight its chromosomes in the tray.
               </p>
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
                       const rowHighlight = rowHighlightEnabled && !isReviewingCertificate
                         ? matchRowHighlightForGroup(group.id)
                         : null;
                       const firstVisibleGroupId = rowHighlight
                         ? row.find(candidate =>
                             rowHighlight.groupIds.includes(candidate.id) &&
                             candidate.pairIds.some(pairId => pairGroupsById.has(pairId))
                           )?.id
                         : null;
                       const showRowButton = rowHighlight != null && firstVisibleGroupId === group.id;
                       const rowActive = rowHighlight != null && highlightedRowId === rowHighlight.id;
                       return (
                         <div key={group.id} className="flex items-end gap-2">
                           {showRowButton && rowHighlight ? (
                             <button
                               type="button"
                               onClick={() => toggleRowHighlight(rowHighlight.id)}
                               aria-pressed={rowActive}
                               title={`Show chromosomes still in the tray for ${rowHighlight.label}`}
                               className={cn(
                                 'mb-4 px-1.5 py-1 rounded-md border text-[10px] font-black tracking-wide whitespace-nowrap transition-colors print:hidden',
                                 rowActive
                                   ? 'bg-sky-500 border-sky-500 text-white'
                                   : 'bg-white border-slate-200 text-slate-600 shadow-sm hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700',
                                 !rowActive && !hasUsedRowHighlight && 'row-hint-pulse border-sky-300 text-sky-700'
                               )}
                             >
                               {rowHighlight.label}
                             </button>
                           ) : rowHighlight ? null : (
                             <span className="text-[10px] font-black text-slate-300 w-4 mb-5 select-none">
                               {group.id}
                             </span>
                           )}
                           {visibleGroups.map(pairGroup => (
                             <div key={pairGroup.pairId} className="flex-shrink-0">
                               <KaryotypePair
                                 pairId={pairGroup.pairId}
                                 slotIds={pairGroup.slotIds}
                                 placedChromosomes={placed}
                                 onUpdateChromosome={updatePlaced}
                                 isReviewing={isReviewingCertificate}
                                 displayScale={chromosomeDisplayScale}
                                 lockedIds={lockedChromosomeIds}
                                 allowOrientation={!orientationPreset}
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
                           lockedIds={lockedChromosomeIds}
                           allowOrientation={!orientationPreset}
                         />
                       </div>
                     ))}
                   </div>
                 )}
               </div>
             </div>

          </div>

          {!isReviewingCertificate && (
            <RawSampleDroppable id="raw-sample-panel" className="shrink-0 h-auto print:hidden">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]">
                <div className="flex items-center justify-between px-4 pt-3 pb-1 shrink-0">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                    <Info className="w-4 h-4" />
                    Chromosomes
                  </h2>
                  <span className="text-xs font-mono text-slate-400">
                    {jumbled.length} REMAINING
                  </span>
                </div>
                <div className="px-4 pb-4">
                  <div className="flex flex-wrap gap-x-3 gap-y-4 items-end justify-center">
                    {jumbled.length > 0 ? (
                      jumbled.map((chrom) => {
                        const lit = highlightedPairIds?.has(chrom.type) ?? false;
                        const dimmed = highlightedPairIds != null && !lit;
                        return (
                          <div
                            key={chrom.id}
                            data-row-match={lit ? 'true' : undefined}
                            className={cn(
                              'rounded-xl transition-opacity duration-300',
                              lit && 'bg-sky-100/90',
                              dimmed && 'opacity-25'
                            )}
                          >
                            <DraggableChromosome
                              id={chrom.id}
                              chromosome={chrom}
                              displayScale={chromosomeDisplayScale}
                              locked={lockedChromosomeIds.has(chrom.id)}
                              allowOrientation={!orientationPreset}
                              highlighted={lit}
                            />
                          </div>
                        );
                      })
                    ) : (
                      <div className="w-full flex items-center justify-center gap-2 py-4 text-slate-300">
                        <CheckCircle2 className="w-5 h-5 opacity-40" />
                        <p className="text-sm font-medium">Sample fully processed</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </RawSampleDroppable>
          )}
          </>
          )}
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
          {isComplete && !isReviewingCertificate && activeLevel !== LEARN_LEVEL && (spreadComplete || !levelCompleteDismissed) && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed top-16 bottom-0 right-0 left-0 lg:left-[18.5rem] z-[400] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 print:hidden"
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
                
                <h3 className="text-3xl font-black text-emerald-900 mt-10 mb-3">
                  {spreadComplete ? successPhrase : 'Level complete'}
                </h3>
                <p className="text-slate-500 text-lg mb-6 leading-relaxed font-medium">
                  {spreadComplete
                    ? 'Every level on this metaphase spread is complete.'
                    : `${finishedLevel ? `${finishedLevel.label} ${finishedLevel.title}` : 'This level'} is finished. The certificate is ready after every level on this spread.`}
                </p>

                {spreadComplete && (
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
                )}
                
                <div className="flex gap-4 w-full">
                  <button 
                    onClick={() => jumpToScreen('select')}
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
                  {spreadComplete ? (
                  <button 
                    onClick={() => setIsReviewingCertificate(true)}
                    disabled={!certificateName.trim()}
                    className="flex-[1.5] flex items-center justify-center gap-2 bg-emerald-500 text-white px-4 py-4 rounded-xl font-bold hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/30 text-sm disabled:opacity-50 disabled:hover:bg-emerald-500 disabled:shadow-none"
                  >
                    REVIEW & PRINT
                  </button>
                  ) : (
                  <button
                    onClick={() => setLevelCompleteDismissed(true)}
                    className="flex-[1.5] flex items-center justify-center gap-2 bg-emerald-500 text-white px-4 py-4 rounded-xl font-bold hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/30 text-sm"
                  >
                    CONTINUE
                  </button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

          <DragOverlay dropAnimation={null}>
            {activeId && currentActiveChromosome ? (
              <div className="z-50 pointer-events-none drop-shadow-2xl">
                <ChromosomeVisual
                  chromosome={currentActiveChromosome}
                  displayScale={chromosomeDisplayScale}
                  highlighted={highlightedPairIds?.has(currentActiveChromosome.type) ?? false}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {levelBriefOpen && finishedLevel && createPortal(
          <LevelBriefModal level={finishedLevel} onClose={() => setLevelBriefOpen(false)} />,
          document.body
        )}
        {sourcePreviewOpen && selectedImage && createPortal(
          <SourceSpreadModal
            imageUrl={selectedImage.originalUrl}
            onClose={() => setSourcePreviewOpen(false)}
          />,
          document.body
        )}
      </div>
      )}

      <style>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        @keyframes row-hint-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.45); }
          70% { box-shadow: 0 0 0 5px rgba(14, 165, 233, 0); }
        }
        .row-hint-pulse {
          animation: row-hint-pulse 1.8s ease-out infinite;
        }
      `}</style>
    </div>
      )}
    </>
  );
}

