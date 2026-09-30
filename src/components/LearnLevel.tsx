import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { CLINICAL_KARYOTYPE_ROWS, isStandardPairId } from '../lib/chromosomePairs';
import { uniformDisplayScale } from '../lib/chromosomeCrop';
import { chromosomeTransform } from '../lib/orientation';
import { LOREM_IPSUM_SENTENCE, orderChromosomesForLesson, orderPairIdsForLesson } from '../lib/levels';
import { cn } from '../lib/utils';

/** Unscaled size of the longest chromosome. The board is then scaled to the viewport. */
const BOARD_MAX_EDGE = 120;
const CARD_CHROMOSOME_EDGE = 200;
const CARD_WIDTH = 560;
const CARD_HEIGHT = 420;

export interface LessonChromosome {
  id: string;
  type: string;
  ordinal: number;
  imageUrl?: string;
  width?: number;
  height?: number;
  expectedRotation?: number;
  expectedFlipX?: boolean;
  expectedFlipY?: boolean;
  info?: string;
}

interface LearnLevelProps {
  chromosomes: LessonChromosome[];
  karyotype?: string;
  spreadIndex: number;
  spreadCount: number;
  spreadBusy: boolean;
  onPreviousSpread: () => void;
  onNextSpread: () => void;
  onFinishSpread?: () => void;
  onBack: () => void;
  onFinish: () => void;
  embedded?: boolean;
}

function pairNote(chromosomes: LessonChromosome[]): string {
  return chromosomes.map(chromosome => chromosome.info?.trim()).find(Boolean) || LOREM_IPSUM_SENTENCE;
}

function rotatedBox(width: number, height: number, rotation: number | undefined) {
  const rad = ((rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

function ChromosomeImage({
  chromosome,
  scale,
  className,
  fitRotation = false,
}: {
  chromosome: LessonChromosome;
  scale: number;
  className?: string;
  fitRotation?: boolean;
}) {
  const displayWidth = (chromosome.width ?? 0) * scale;
  const displayHeight = (chromosome.height ?? 0) * scale;
  const sized = displayWidth > 0 && displayHeight > 0;
  const image = !chromosome.imageUrl ? (
    <div
      className={cn('w-4 rounded-full bg-slate-200 border border-slate-300', className)}
      style={{ height: 72 * Math.max(scale, 0.4) }}
    />
  ) : (
    <img
      src={chromosome.imageUrl}
      alt=""
      draggable={false}
      className={cn('block object-contain', !sized && 'max-h-16 max-w-8', className)}
      style={{
        width: sized ? displayWidth : undefined,
        height: sized ? displayHeight : undefined,
        transform: chromosomeTransform(
          chromosome.expectedRotation,
          chromosome.expectedFlipX,
          chromosome.expectedFlipY
        ),
      }}
    />
  );

  if (!fitRotation || !sized) return image;
  const box = rotatedBox(displayWidth, displayHeight, chromosome.expectedRotation);
  return (
    <span className="inline-flex items-center justify-center" style={{ width: box.width, height: box.height }}>
      {image}
    </span>
  );
}

function Keycap({
  children,
  onClick,
  disabled = false,
  label,
  wide = false,
  glow = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  wide?: boolean;
  glow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center rounded-md border bg-white active:translate-y-px disabled:opacity-40 disabled:active:translate-y-0',
        glow
          ? 'spacebar-glow border-sky-300 text-slate-600 hover:bg-slate-50'
          : 'border-slate-300 text-slate-700 shadow-[0_2px_0_0_rgb(203,213,225)] hover:bg-slate-50 active:shadow-none',
        wide ? 'h-8 min-w-[5.5rem] px-3' : 'h-8 w-8'
      )}
    >
      {glow && (
        <style>{`
          @keyframes spacebar-glow {
            0%, 100% {
              box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.35), 0 0 6px rgba(14, 165, 233, 0.28);
            }
            50% {
              box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.7), 0 0 10px rgba(14, 165, 233, 0.45);
            }
          }
          .spacebar-glow {
            animation: spacebar-glow 1.8s ease-in-out infinite;
          }
        `}</style>
      )}
      {children}
    </button>
  );
}

function PairFlashcard({
  pairId,
  members,
  note,
  scale,
  anchor,
  face,
  dismissing,
  onFlip,
  onClosed,
  onPrevious,
  onNext,
  previousDisabled,
  nextLabel,
}: {
  pairId: string;
  members: LessonChromosome[];
  note: string;
  scale: number;
  anchor: { left: number; top: number; width: number; height: number };
  face: 'note' | 'pair';
  dismissing: boolean;
  onFlip: () => void;
  onClosed: () => void;
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled: boolean;
  nextLabel: string;
}) {
  const showingNote = face === 'note';
  return (
    <div
      className="fixed z-[200]"
      style={{
        left: anchor.left,
        top: anchor.top,
        width: anchor.width,
        height: anchor.height,
        transform: 'translate(-50%, -50%)',
        perspective: 1200,
      }}
      onClick={event => event.stopPropagation()}
    >
      <motion.div
        className="relative h-full w-full"
        initial={{ rotateY: 0, scale: 0.35 }}
        animate={{ rotateY: showingNote ? 180 : 0, scale: dismissing ? 0.35 : 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        onAnimationComplete={() => {
          if (dismissing) onClosed();
        }}
        style={{ transformStyle: 'preserve-3d' }}
      >
        <div
          className="absolute inset-0 flex flex-col rounded-2xl border border-sky-200 bg-sky-50 shadow-2xl"
          style={{ backfaceVisibility: 'hidden' }}
        >
          <div className="flex flex-1 items-end justify-center gap-2 px-4 pt-4">
            {members.map(chromosome => (
              <span key={chromosome.id} className="inline-flex items-end">
                <ChromosomeImage chromosome={chromosome} scale={scale} fitRotation />
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 px-4 pb-4 pt-3">
            <span className="text-sm font-black font-mono text-sky-700">{pairId}</span>
            <Keycap wide glow onClick={onFlip} label="Space, show the note">
              <span className="text-[10px] font-medium lowercase tracking-wide text-slate-600 whitespace-nowrap">space bar</span>
            </Keycap>
          </div>
        </div>
        <div
          className="absolute inset-0 flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        >
          <div className="min-h-0 flex-1 flex flex-col text-left">
            <p className="text-[10px] font-mono font-bold tracking-widest text-slate-400 shrink-0">
              Chromosome {pairId}
            </p>
            <p className="mt-3 min-h-0 flex-1 overflow-y-auto text-base leading-relaxed text-slate-700">
              {note}
            </p>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 shrink-0">
            <Keycap wide glow onClick={onFlip} label="Space, show the pair">
              <span className="text-[10px] font-medium lowercase tracking-wide text-slate-600 whitespace-nowrap">space bar</span>
            </Keycap>
            <div className="flex items-center gap-2">
              <Keycap onClick={onPrevious} disabled={previousDisabled} label="Left arrow, previous pair">
                <span className="text-sm font-bold leading-none">←</span>
              </Keycap>
              <Keycap onClick={onNext} label={nextLabel === 'Next' ? 'Right arrow, next pair' : nextLabel}>
                <span className="text-sm font-bold leading-none">→</span>
              </Keycap>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function LearnLevel({
  chromosomes,
  karyotype,
  spreadIndex,
  spreadCount,
  spreadBusy,
  onPreviousSpread,
  onNextSpread,
  onFinishSpread,
  onBack,
  onFinish,
  embedded = false,
}: LearnLevelProps) {
  const ordered = useMemo(() => orderChromosomesForLesson(chromosomes), [chromosomes]);
  const pairIds = useMemo(() => orderPairIdsForLesson(chromosomes), [chromosomes]);
  const [cardIndex, setCardIndex] = useState(0);
  const [openPairId, setOpenPairId] = useState<string | null>(null);
  const [hasFlippedCard, setHasFlippedCard] = useState(false);
  const [cardPhase, setCardPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const [cardFace, setCardFace] = useState<'note' | 'pair'>('note');
  const boardFrameRef = useRef<HTMLDivElement | null>(null);
  const boardContentRef = useRef<HTMLDivElement | null>(null);
  const pairButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [fitScale, setFitScale] = useState<number | null>(null);
  const [cardAnchor, setCardAnchor] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const currentPair = pairIds[cardIndex] ?? null;
  const isLast = pairIds.length > 0 && cardIndex === pairIds.length - 1;
  const boardScale = useMemo(() => uniformDisplayScale(ordered, BOARD_MAX_EDGE), [ordered]);

  const byPair = useMemo(() => {
    const map = new Map<string, LessonChromosome[]>();
    for (const chromosome of ordered) {
      const list = map.get(chromosome.type);
      if (list) list.push(chromosome);
      else map.set(chromosome.type, [chromosome]);
    }
    return map;
  }, [ordered]);

  const openMembers = openPairId ? (byPair.get(openPairId) ?? []) : [];
  const cardScale = uniformDisplayScale(
    openMembers.length > 0 ? openMembers : ordered,
    CARD_CHROMOSOME_EDGE
  );

  const customPairIds = useMemo(
    () => ordered.map(chromosome => chromosome.type).filter((id, index, all) => !isStandardPairId(id) && all.indexOf(id) === index),
    [ordered]
  );

  useLayoutEffect(() => {
    const frame = boardFrameRef.current;
    const content = boardContentRef.current;
    if (!frame || !content) return;

    let frameId = 0;
    const update = () => {
      const availableW = frame.clientWidth;
      const availableH = frame.clientHeight;
      const contentW = content.offsetWidth;
      const contentH = content.offsetHeight;
      if (availableW <= 0 || availableH <= 0 || contentW <= 0 || contentH <= 0) return;
      const next = Math.min(availableW / contentW, availableH / contentH) * 0.98;
      setFitScale(prev => (prev != null && Math.abs(prev - next) < 0.005 ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(update);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [ordered, customPairIds.length]);

  const openPair = (pairId: string, index: number) => {
    setHasFlippedCard(true);
    setCardIndex(index);
    setOpenPairId(pairId);
    setCardFace('note');
    setCardPhase('open');
  };

  const goTo = (index: number) => {
    if (pairIds.length === 0) return;
    const next = Math.max(0, Math.min(index, pairIds.length - 1));
    const pairId = pairIds[next];
    if (!pairId) return;
    openPair(pairId, next);
  };

  const selectPair = (pairId: string, index: number) => {
    if (openPairId === pairId && cardPhase === 'open') {
      setCardPhase('closing');
      return;
    }
    openPair(pairId, index);
  };

  useLayoutEffect(() => {
    if (!openPairId || cardPhase === 'closed') {
      setCardAnchor(null);
      return;
    }
    const frame = boardFrameRef.current;
    const pair = pairButtonRefs.current.get(openPairId);
    if (!frame || !pair) return;

    const measure = () => {
      const frameRect = frame.getBoundingClientRect();
      const rect = pair.getBoundingClientRect();
      const width = Math.min(CARD_WIDTH, Math.max(180, frameRect.width - 24));
      const height = Math.min(CARD_HEIGHT, Math.max(160, frameRect.height - 24));
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      setCardAnchor({
        width,
        height,
        left: Math.min(Math.max(centerX, frameRect.left + width / 2 + 8), frameRect.right - width / 2 - 8),
        top: Math.min(Math.max(centerY, frameRect.top + height / 2 + 8), frameRect.bottom - height / 2 - 8),
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [openPairId, cardPhase, fitScale]);

  const renderPair = (pairId: string) => {
    const members = byPair.get(pairId);
    if (!members || members.length === 0) return null;
    const flipped = pairId === openPairId && cardPhase !== 'closed';
    const index = pairIds.indexOf(pairId);
    const glow = !hasFlippedCard && pairId === pairIds[0];
    return (
      <div key={pairId} className="flex flex-col items-center gap-1 min-w-[3rem]">
        <button
          type="button"
          ref={node => {
            if (node) pairButtonRefs.current.set(pairId, node);
            else pairButtonRefs.current.delete(pairId);
          }}
          onClick={event => {
            event.stopPropagation();
            selectPair(pairId, index);
          }}
          className={cn(
            'flex items-end justify-center gap-1 rounded-md p-0.5 transition-all',
            flipped ? 'ring-2 ring-sky-500 bg-sky-50' : 'hover:bg-slate-100',
            glow && 'first-pair-glow'
          )}
          aria-pressed={flipped}
          aria-label={flipped ? `Flip chromosome ${pairId} back` : `Flip chromosome ${pairId}`}
        >
          {members.map(chromosome => (
            <span key={chromosome.id} className="inline-flex items-end">
              <ChromosomeImage chromosome={chromosome} scale={boardScale} fitRotation />
            </span>
          ))}
        </button>
        <span className={cn(
          'text-xs font-bold font-mono',
          flipped ? 'text-sky-600' : 'text-slate-500'
        )}>
          {pairId}
        </span>
      </div>
    );
  };

  const nextLabel = isLast
    ? (onFinishSpread ? 'Next spread' : 'Finish')
    : 'Next';

  const goNext = () => {
    if (isLast) {
      if (onFinishSpread) onFinishSpread();
      else onFinish();
      return;
    }
    goTo(cardIndex + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (event.key === 'Escape') {
        if (!openPairId || cardPhase !== 'open') return;
        event.preventDefault();
        setCardPhase('closing');
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        if (!openPairId || cardPhase !== 'open') return;
        event.preventDefault();
        setCardFace(current => current === 'note' ? 'pair' : 'note');
        return;
      }
      if (event.key === 'ArrowLeft') {
        if (cardIndex <= 0) return;
        event.preventDefault();
        goTo(cardIndex - 1);
        return;
      }
      if (event.key === 'ArrowRight') {
        if (pairIds.length === 0) return;
        event.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cardIndex, cardPhase, goNext, goTo, openPairId, pairIds.length]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={embedded
        ? "h-full min-h-0 flex flex-col overflow-hidden bg-white rounded-2xl border border-slate-200 shadow-sm"
        : "fixed inset-0 z-[100] bg-slate-50 flex flex-col overflow-hidden"}
    >
      <header className="h-16 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {!embedded && (
          <button
            type="button"
            onClick={onBack}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500 hover:text-slate-900"
            title="Back to samples"
            aria-label="Back to samples"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-black tracking-tight text-slate-900 leading-tight">Level 1 · Learn</h1>
            <p className="text-[10px] font-mono text-slate-400 truncate">
              {karyotype ? `ISCN ${karyotype}` : 'Chromosomes in clinical order'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {spreadCount > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onPreviousSpread}
                disabled={spreadBusy || spreadIndex <= 0}
                className="p-2 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-transparent"
                title="Previous spread"
                aria-label="Previous spread"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-[10px] font-mono font-bold text-slate-500 min-w-[5.5rem] text-center">
                {spreadBusy ? 'Loading…' : `Spread ${Math.max(spreadIndex, 0) + 1} / ${spreadCount}`}
              </span>
              <button
                type="button"
                onClick={onNextSpread}
                disabled={spreadBusy || spreadIndex < 0 || spreadIndex >= spreadCount - 1}
                className="p-2 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-transparent"
                title="Next spread"
                aria-label="Next spread"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </header>

      {pairIds.length === 0 || !currentPair ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <p className="text-slate-500 font-medium">This spread has no annotated chromosomes to review.</p>
        </div>
      ) : (
        <>
        <div
          ref={boardFrameRef}
          className="relative flex-1 min-h-0 min-w-0 overflow-hidden"
          onClick={() => {
            if (cardPhase === 'open') setCardPhase('closing');
          }}
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `translate(-50%, -50%) scale(${fitScale ?? 1})`,
              visibility: fitScale == null ? 'hidden' : 'visible',
            }}
          >
            <div ref={boardContentRef} className="flex flex-col gap-4 items-center p-3">
              {CLINICAL_KARYOTYPE_ROWS.map((row, rowIndex) => {
                const groups = row
                  .map(group => ({
                    ...group,
                    pairIds: group.pairIds.filter(pairId => (byPair.get(pairId)?.length ?? 0) > 0),
                  }))
                  .filter(group => group.pairIds.length > 0);
                if (groups.length === 0) return null;
                return (
                  <div key={rowIndex} className="flex items-end justify-center gap-6">
                    {groups.map(group => (
                      <div key={group.id} className="flex items-end gap-2">
                        <span className="text-[10px] font-black text-slate-300 w-3 mb-6 select-none">{group.id}</span>
                        {group.pairIds.map(pairId => renderPair(pairId))}
                      </div>
                    ))}
                  </div>
                );
              })}
              {customPairIds.length > 0 && (
                <div className="flex items-end justify-center gap-2 pt-2 border-t border-dashed border-slate-200">
                  <span className="text-[10px] font-black text-slate-300 w-3 mb-6 select-none">+</span>
                  {customPairIds.map(pairId => renderPair(pairId))}
                </div>
              )}
            </div>
          </div>
          {!hasFlippedCard && (
            <style>{`
              @keyframes first-pair-glow {
                0%, 100% {
                  box-shadow: 0 0 0 0 rgba(14, 165, 233, 0);
                }
                50% {
                  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.35), 0 0 14px rgba(14, 165, 233, 0.75);
                }
              }
              .first-pair-glow {
                animation: first-pair-glow 2s ease-in-out infinite;
              }
            `}</style>
          )}
          {!openPairId && (
            <p className="pointer-events-none absolute top-3 left-0 right-0 text-center text-xs font-medium text-slate-400">
              Click a pair to flip it
            </p>
          )}
          {openPairId && cardAnchor && cardPhase !== 'closed' && createPortal(
            <PairFlashcard
              key={openPairId}
              pairId={openPairId}
              members={openMembers}
              note={pairNote(openMembers)}
              scale={cardScale}
              anchor={cardAnchor}
              face={cardFace}
              dismissing={cardPhase === 'closing'}
              onFlip={() => setCardFace(current => current === 'note' ? 'pair' : 'note')}
              onClosed={() => {
                setOpenPairId(current => current === openPairId ? null : current);
                setCardPhase(current => current === 'closing' ? 'closed' : current);
              }}
              onPrevious={() => goTo(cardIndex - 1)}
              onNext={goNext}
              previousDisabled={cardIndex === 0}
              nextLabel={nextLabel}
            />,
            document.body
          )}
        </div>
        </>
      )}
    </motion.div>
  );
}
