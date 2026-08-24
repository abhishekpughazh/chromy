import React, { useMemo, useRef, useState } from 'react';
import { FlipHorizontal, FlipVertical, LayoutGrid, Trash2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { MAX_CHROMOSOMES_PER_PAIR, STANDARD_PAIR_IDS } from '../lib/chromosomePairs';
import { normalizeRotation, pointerAngleDeg, chromosomeTransform, toggleDisplayedFlipX, toggleDisplayedFlipY } from '../lib/orientation';

export interface KaryotypePreviewChromosome {
  strokeId: string;
  pairId: string;
  dataUrl: string | null;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

export interface KaryotypePreviewEdits {
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  label?: string;
}

/** Classic 4-row karyogram: A+B, C, D+E, F+G. Indices map into `pairOrder`. */
const KARYOTYPE_ROWS: { id: string; indices: number[] }[][] = [
  [
    { id: 'A', indices: [0, 1, 2] },
    { id: 'B', indices: [3, 4] },
  ],
  [{ id: 'C', indices: [5, 6, 7, 8, 9, 10, 11, 22] }],
  [
    { id: 'D', indices: [12, 13, 14] },
    { id: 'E', indices: [15, 16, 17] },
  ],
  [
    { id: 'F', indices: [18, 19] },
    { id: 'G', indices: [20, 21, 23] },
  ],
];

interface KaryotypePreviewProps {
  pairOrder: string[];
  customPairs: string[];
  chromosomes: KaryotypePreviewChromosome[];
  selectedStrokeId: string | null;
  karyotype?: string;
  labeledCount: number;
  expectedCount: number | null;
  onSelect: (strokeId: string) => void;
  onUpdate: (strokeId: string, updates: KaryotypePreviewEdits) => void;
  onDelete: (strokeId: string) => void;
  onClose: () => void;
}

interface PairColumnProps {
  pairId: string;
  chroms: KaryotypePreviewChromosome[];
  selectedStrokeId: string | null;
  onSelect: (strokeId: string) => void;
}

const PairColumn: React.FC<PairColumnProps> = ({
  pairId,
  chroms,
  selectedStrokeId,
  onSelect,
}) => {
  const emptySlots = chroms.length === 0 ? 2 : 0;

  return (
    <div className="flex flex-col items-center gap-1.5 min-w-[3.25rem]">
      <div className="flex items-center justify-center gap-1 h-[5.5rem]">
        {chroms.map((c) => {
          const selected = c.strokeId === selectedStrokeId;
          return (
            <button
              key={c.strokeId}
              type="button"
              onClick={() => onSelect(c.strokeId)}
              title="Edit this chromosome"
              className={cn(
                'relative w-8 h-full flex items-center justify-center rounded-md p-1 transition-all',
                selected ? 'ring-2 ring-sky-500 bg-sky-50' : 'hover:bg-slate-100'
              )}
            >
              {c.dataUrl ? (
                <img
                  src={c.dataUrl}
                  alt={pairId}
                  draggable={false}
                  className="max-h-16 max-w-[28px] object-contain pointer-events-none"
                  style={{
                    transform: chromosomeTransform(c.rotation, c.flipX, c.flipY),
                    transformOrigin: 'center center',
                  }}
                />
              ) : (
                <div className="w-6 h-14 rounded bg-slate-100 animate-pulse" />
              )}
            </button>
          );
        })}
        {Array.from({ length: emptySlots }, (_, i) => (
          <div
            key={`empty-${i}`}
            className="w-7 h-14 rounded border border-dashed border-slate-200 bg-slate-50/80"
          />
        ))}
      </div>
      <span
        className={cn(
          'text-xs font-mono font-bold leading-none truncate max-w-[5rem]',
          chroms.length > 0 ? 'text-slate-700' : 'text-slate-300'
        )}
        title={pairId}
      >
        {pairId}
      </span>
    </div>
  );
};

const ChromosomeEditor: React.FC<{
  chromosome: KaryotypePreviewChromosome;
  pairOrder: string[];
  customPairs: string[];
  pairCounts: Map<string, number>;
  onUpdate: (updates: KaryotypePreviewEdits) => void;
  onDelete: () => void;
}> = ({ chromosome, pairOrder, customPairs, pairCounts, onUpdate, onDelete }) => {
  const previewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startPointerAngle: number; startRotation: number } | null>(null);
  const [isDraggingRotation, setIsDraggingRotation] = useState(false);
  const rotation = normalizeRotation(chromosome.rotation);

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
    onUpdate({ rotation: normalizeRotation(drag.startRotation + (current - drag.startPointerAngle)) });
  };

  const endPreviewDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDraggingRotation(false);
    onUpdate({ rotation: normalizeRotation(chromosome.rotation) });
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already have been released
    }
  };

  return (
    <div className="w-80 shrink-0 border-l border-slate-100 bg-slate-50 flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 bg-white">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Editing</p>
        <h4 className="text-base font-black text-slate-900 truncate" title={chromosome.pairId}>
          Chromosome {chromosome.pairId}
        </h4>
      </div>

      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
        <div
          ref={previewRef}
          className="w-full aspect-square border-2 border-slate-100 bg-white rounded-2xl flex items-center justify-center overflow-hidden shadow-inner touch-none select-none"
          style={{ cursor: isDraggingRotation ? 'grabbing' : 'grab' }}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={endPreviewDrag}
          onPointerCancel={endPreviewDrag}
        >
          {chromosome.dataUrl ? (
            <img
              src={chromosome.dataUrl}
              alt={chromosome.pairId}
              draggable={false}
              className="max-w-[80%] max-h-[80%] object-contain pointer-events-none drop-shadow-md"
              style={{
                transform: chromosomeTransform(chromosome.rotation, chromosome.flipX, chromosome.flipY),
                transformOrigin: 'center center',
              }}
            />
          ) : (
            <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <p className="text-[11px] text-slate-400 text-center -mt-3">Drag to rotate. p-arm should point up.</p>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Rotation</span>
            <label className="flex items-center gap-1 text-sm font-mono font-bold text-slate-700">
              <input
                type="number"
                min={0}
                max={359}
                value={rotation}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) onUpdate({ rotation: normalizeRotation(n) });
                }}
                className="w-16 text-right px-2 py-1 border border-slate-200 rounded-lg text-sm font-mono font-bold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              °
            </label>
          </div>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={rotation}
            aria-label="Rotation in degrees"
            onChange={(e) => onUpdate({ rotation: Number(e.target.value) })}
            className="w-full accent-sky-500 cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onUpdate(toggleDisplayedFlipX(chromosome))}
            className={cn(
              'py-2.5 border-2 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all',
              chromosome.flipX
                ? 'border-sky-500 bg-sky-50 text-sky-700'
                : 'border-slate-200 bg-white text-slate-600 hover:border-sky-500 hover:bg-sky-50 hover:text-sky-600'
            )}
          >
            <FlipHorizontal className="w-4 h-4" /> Flip X
          </button>
          <button
            type="button"
            onClick={() => onUpdate(toggleDisplayedFlipY(chromosome))}
            className={cn(
              'py-2.5 border-2 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all',
              chromosome.flipY
                ? 'border-sky-500 bg-sky-50 text-sky-700'
                : 'border-slate-200 bg-white text-slate-600 hover:border-sky-500 hover:bg-sky-50 hover:text-sky-600'
            )}
          >
            <FlipVertical className="w-4 h-4" /> Flip Y
          </button>
        </div>

        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Assign pair</p>
          <div className="grid grid-cols-4 gap-1.5">
            {pairOrder.map((pairId) => {
              const count = pairCounts.get(pairId) || 0;
              const isCurrent = chromosome.pairId === pairId;
              const isFull = count >= MAX_CHROMOSOMES_PER_PAIR;
              return (
                <button
                  key={pairId}
                  type="button"
                  disabled={isFull && !isCurrent}
                  onClick={() => !isCurrent && onUpdate({ label: pairId })}
                  className={cn(
                    'aspect-square rounded-lg border-2 text-xs font-black transition-all truncate px-0.5',
                    isCurrent ? 'bg-sky-50 border-sky-500 text-sky-700' :
                    isFull ? 'bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed' :
                    'bg-white border-slate-200 text-slate-700 hover:border-sky-300'
                  )}
                  title={pairId}
                >
                  {pairId}
                </button>
              );
            })}
          </div>
          {customPairs.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-2">
              {customPairs.map((pairId) => {
                const count = pairCounts.get(pairId) || 0;
                const isCurrent = chromosome.pairId === pairId;
                const isFull = count >= MAX_CHROMOSOMES_PER_PAIR;
                return (
                  <button
                    key={pairId}
                    type="button"
                    disabled={isFull && !isCurrent}
                    onClick={() => !isCurrent && onUpdate({ label: pairId })}
                    className={cn(
                      'w-full py-2 px-3 rounded-lg border-2 text-left text-xs font-black truncate transition-all',
                      isCurrent ? 'bg-sky-50 border-sky-500 text-sky-700' :
                      isFull ? 'bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed' :
                      'bg-white border-slate-200 text-slate-700 hover:border-sky-300'
                    )}
                  >
                    {pairId}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border-t border-slate-100 bg-white">
        <button
          type="button"
          onClick={onDelete}
          className="w-full py-2.5 rounded-xl font-bold text-sm border-2 border-red-200 text-red-600 hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" /> Delete chromosome
        </button>
      </div>
    </div>
  );
};

export default function KaryotypePreview({
  pairOrder,
  customPairs,
  chromosomes,
  selectedStrokeId,
  karyotype,
  labeledCount,
  expectedCount,
  onSelect,
  onUpdate,
  onDelete,
  onClose,
}: KaryotypePreviewProps) {
  const byPair = useMemo(() => {
    const map = new Map<string, KaryotypePreviewChromosome[]>();
    for (const c of chromosomes) {
      const list = map.get(c.pairId);
      if (list) list.push(c);
      else map.set(c.pairId, [c]);
    }
    return map;
  }, [chromosomes]);

  const pairCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of chromosomes) {
      if (c.strokeId === selectedStrokeId) continue;
      map.set(c.pairId, (map.get(c.pairId) || 0) + 1);
    }
    return map;
  }, [chromosomes, selectedStrokeId]);

  const selected = chromosomes.find((c) => c.strokeId === selectedStrokeId) || null;
  const pairAt = (index: number) => pairOrder[index] ?? STANDARD_PAIR_IDS[index];

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-7xl max-h-[90vh] flex flex-col overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
              <LayoutGrid className="w-4 h-4 text-slate-600" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-black text-slate-900 leading-tight">Karyotype preview</h3>
              <p className="text-xs text-slate-500 font-medium truncate">
                {karyotype ? `ISCN ${karyotype}` : 'Click a chromosome to rotate, flip, or reassign it'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <span className="text-xs font-mono font-bold text-slate-500">
              {expectedCount != null ? `${labeledCount} / ${expectedCount} labeled` : `${labeledCount} labeled`}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors"
              title="Close preview"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="flex-1 overflow-auto p-6">
            <div className="flex flex-col gap-5 items-center min-w-min mx-auto">
              {KARYOTYPE_ROWS.map((row, rowIdx) => (
                <div key={rowIdx} className="flex items-end justify-center gap-10">
                  {row.map((group) => (
                    <div key={group.id} className="flex items-end gap-4">
                      <span className="text-[10px] font-black text-slate-300 w-3 mb-5 select-none">
                        {group.id}
                      </span>
                      {group.indices.map((index) => {
                        const pairId = pairAt(index);
                        return (
                          <PairColumn
                            key={`${index}-${pairId}`}
                            pairId={pairId}
                            chroms={byPair.get(pairId) || []}
                            selectedStrokeId={selectedStrokeId}
                            onSelect={onSelect}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
              {customPairs.length > 0 && (
                <div className="flex items-end justify-center gap-4 pt-2 border-t border-dashed border-slate-100">
                  <span className="text-[10px] font-black text-slate-300 w-3 mb-5 select-none">+</span>
                  {customPairs.map((pairId) => (
                    <PairColumn
                      key={pairId}
                      pairId={pairId}
                      chroms={byPair.get(pairId) || []}
                      selectedStrokeId={selectedStrokeId}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {selected ? (
            <ChromosomeEditor
              chromosome={selected}
              pairOrder={pairOrder}
              customPairs={customPairs}
              pairCounts={pairCounts}
              onUpdate={(updates) => onUpdate(selected.strokeId, updates)}
              onDelete={() => onDelete(selected.strokeId)}
            />
          ) : (
            <div className="w-80 shrink-0 border-l border-slate-100 bg-slate-50 flex items-center justify-center p-8 text-center">
              <p className="text-sm text-slate-400 font-medium leading-relaxed">
                Click a chromosome to rotate, flip, or reassign it here.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
