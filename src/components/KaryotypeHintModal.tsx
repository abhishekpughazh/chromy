import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, Lightbulb, X } from 'lucide-react';
import { motion } from 'motion/react';
import { CLINICAL_KARYOTYPE_ROWS, STANDARD_PAIR_IDS } from '../lib/chromosomePairs';
import { chromosomeTransform, normalizeRotation, rotationsMatch } from '../lib/orientation';
import { uniformDisplayScale } from '../lib/chromosomeCrop';
import { cn } from '../lib/utils';

const ANSWER_SHEET_MAX_EDGE = 64;

export interface KaryotypeHintChromosome {
  id: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  targetPair: string;
  currentPair: string | null;
  currentRotation: number;
  currentFlipX: boolean;
  currentFlipY: boolean;
  expectedRotation: number;
  expectedFlipX: boolean;
  expectedFlipY: boolean;
}

interface HintStep {
  title: string;
  instructions: string[];
}

export function buildHintSteps(chromosome: KaryotypeHintChromosome): HintStep[] {
  const placementInstruction = chromosome.currentPair === null
    ? `Drag this chromosome from the raw sample into either open slot under pair ${chromosome.targetPair}.`
    : chromosome.currentPair === chromosome.targetPair
      ? `This chromosome is already under pair ${chromosome.targetPair}; keep it there.`
      : `Move this chromosome from pair ${chromosome.currentPair} to an open slot under pair ${chromosome.targetPair}.`;

  const orientationInstructions: string[] = [];
  if (chromosome.currentFlipX !== chromosome.expectedFlipX) {
    orientationInstructions.push(`Turn Flip X ${chromosome.expectedFlipX ? 'ON' : 'OFF'}.`);
  }
  if (chromosome.currentFlipY !== chromosome.expectedFlipY) {
    orientationInstructions.push(`Turn Flip Y ${chromosome.expectedFlipY ? 'ON' : 'OFF'}.`);
  }
  if (!rotationsMatch(chromosome.currentRotation, chromosome.expectedRotation)) {
    orientationInstructions.push(`Then set rotation to about ${chromosome.expectedRotation}°.`);
  }
  if (orientationInstructions.length === 0) {
    orientationInstructions.push('The orientation is already correct.');
  }

  return [
    {
      title: 'Find the pair',
      instructions: [
        `This chromosome belongs in pair ${chromosome.targetPair}.`,
      ],
    },
    {
      title: 'Place the chromosome',
      instructions: [placementInstruction],
    },
    {
      title: 'Set the orientation',
      instructions: orientationInstructions,
    },
  ];
}

function AnswerChromosome({
  chromosome,
  displayScale,
}: {
  chromosome: KaryotypeHintChromosome;
  displayScale: number;
}) {
  if (!chromosome.imageUrl) return null;
  const width = (chromosome.width ?? 0) * displayScale;
  const height = (chromosome.height ?? 0) * displayScale;
  const sized = width > 0 && height > 0;
  return (
    <img
      src={chromosome.imageUrl}
      alt=""
      draggable={false}
      className={cn('block', !sized && 'max-h-16 max-w-7 object-contain')}
      style={{
        width: sized ? width : undefined,
        height: sized ? height : undefined,
        transform: chromosomeTransform(
          chromosome.expectedRotation,
          chromosome.expectedFlipX,
          chromosome.expectedFlipY
        ),
      }}
    />
  );
}

export default function KaryotypeHintModal({
  chromosomes,
  fullKaryotype,
  onClose,
}: {
  chromosomes: KaryotypeHintChromosome[];
  fullKaryotype: KaryotypeHintChromosome[];
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealedStep, setRevealedStep] = useState(1);
  const [showFullKaryotype, setShowFullKaryotype] = useState(false);
  const [showEncouragement, setShowEncouragement] = useState(false);
  const selected = chromosomes.find(chromosome => chromosome.id === selectedId) ?? null;
  const steps = useMemo(() => selected ? buildHintSteps(selected) : [], [selected]);
  const fullKaryotypeByPair = useMemo(() => {
    const map = new Map<string, KaryotypeHintChromosome[]>();
    fullKaryotype.forEach(chromosome => {
      const pair = map.get(chromosome.targetPair);
      if (pair) pair.push(chromosome);
      else map.set(chromosome.targetPair, [chromosome]);
    });
    return map;
  }, [fullKaryotype]);
  const customPairIds = useMemo(
    () => [...fullKaryotypeByPair.keys()].filter(pairId => !STANDARD_PAIR_IDS.includes(pairId)),
    [fullKaryotypeByPair]
  );
  const answerDisplayScale = useMemo(
    () => uniformDisplayScale(fullKaryotype, ANSWER_SHEET_MAX_EDGE),
    [fullKaryotype]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[350] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 print:hidden"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-500 flex items-center justify-center">
              <Lightbulb className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900">Chromosome Hint</h2>
              <p className="text-xs text-slate-500">Choose a chromosome, then reveal guidance one step at a time.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!showEncouragement && (
              <button
                type="button"
                onClick={() => {
                  if (showFullKaryotype) {
                    setShowFullKaryotype(false);
                  } else {
                    setShowEncouragement(true);
                  }
                }}
                className={cn(
                  "px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors",
                  showFullKaryotype
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                )}
              >
                <Eye className="w-4 h-4" />
                {showFullKaryotype ? 'Back to hints' : 'View full karyotype'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-full text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              title="Close hints"
              aria-label="Close hints"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {showEncouragement ? (
          <div className="flex-1 min-h-[28rem] flex flex-col items-center justify-center text-center p-8 bg-gradient-to-b from-amber-50/70 to-white">
            <motion.div
              initial={{ scale: 0.7, rotate: -12 }}
              animate={{ scale: [1, 1.08, 1], rotate: [-5, 5, -5] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
              className="text-7xl leading-none"
            >
              <span role="img" aria-label="Strong">💪</span>
            </motion.div>
            <motion.h3
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-3xl font-black text-slate-900 mt-7"
            >
              You've got this!
            </motion.h3>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="text-slate-500 mt-3 max-w-md leading-relaxed"
            >
              Try the pair and orientation hints first. You may be closer than you think.
            </motion.p>
            <div className="flex flex-col sm:flex-row gap-3 mt-8">
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-3 rounded-xl bg-amber-500 text-white font-black hover:bg-amber-600 transition-colors"
              >
                Give it another shot
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowEncouragement(false);
                  setShowFullKaryotype(true);
                }}
                className="px-6 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-bold hover:bg-slate-50 transition-colors"
              >
                Show the answer sheet
              </button>
            </div>
          </div>
        ) : showFullKaryotype ? (
          <div className="flex-1 overflow-auto p-6">
            <div className="flex flex-col gap-5 items-center min-w-min mx-auto">
              {CLINICAL_KARYOTYPE_ROWS.map((row, rowIndex) => (
                <div key={rowIndex} className="flex items-end justify-center gap-10">
                  {row.map(group => (
                    <div key={group.id} className="flex items-end gap-4">
                      <span className="text-[10px] font-black text-slate-300 w-4 mb-5 select-none">
                        {group.id}
                      </span>
                      {group.pairIds.map(pairId => {
                        const pair = fullKaryotypeByPair.get(pairId) ?? [];
                        return (
                          <div key={pairId} className="flex flex-col items-center gap-1.5 min-w-[3.25rem]">
                            <div className="flex items-end justify-center gap-1">
                              {pair.map(chromosome => (
                                <div key={chromosome.id} className="flex items-end justify-center">
                                  <AnswerChromosome chromosome={chromosome} displayScale={answerDisplayScale} />
                                </div>
                              ))}
                            </div>
                            <span className="text-xs font-mono font-bold text-slate-700">{pairId}</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
              {customPairIds.length > 0 && (
                <div className="flex items-end justify-center gap-4 pt-2 border-t border-dashed border-slate-100">
                  {customPairIds.map(pairId => (
                    <div key={pairId} className="flex flex-col items-center gap-1.5 min-w-[3.25rem]">
                      <div className="flex items-end justify-center gap-1">
                        {(fullKaryotypeByPair.get(pairId) ?? []).map(chromosome => (
                          <div key={chromosome.id} className="flex items-end justify-center">
                            <AnswerChromosome chromosome={chromosome} displayScale={answerDisplayScale} />
                          </div>
                        ))}
                      </div>
                      <span className="text-xs font-mono font-bold text-slate-700">{pairId}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] flex-1 min-h-0">
          <section className="p-5 border-b lg:border-b-0 lg:border-r border-slate-100 flex flex-col min-h-0">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3 shrink-0">
              Select a chromosome
            </h3>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 overflow-y-auto pr-1">
              {chromosomes.map((chromosome) => (
                <button
                  key={chromosome.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(chromosome.id);
                    setRevealedStep(1);
                  }}
                  className={cn(
                    'h-24 rounded-xl border-2 flex flex-col items-center justify-center gap-1 transition-colors',
                    selectedId === chromosome.id
                      ? 'border-amber-400 bg-amber-50'
                      : 'border-slate-100 bg-slate-50 hover:border-amber-200 hover:bg-amber-50/40'
                  )}
                  aria-label="Select this chromosome"
                >
                  {chromosome.imageUrl ? (
                    <img
                      src={chromosome.imageUrl}
                      alt=""
                      draggable={false}
                      className="max-h-16 max-w-10 object-contain pointer-events-none"
                      style={{
                        transform: chromosomeTransform(
                          chromosome.currentRotation,
                          chromosome.currentFlipX,
                          chromosome.currentFlipY
                        ),
                      }}
                    />
                  ) : (
                    <div className="w-4 h-14 rounded-full bg-slate-300" />
                  )}
                </button>
              ))}
            </div>
          </section>

          <section className="p-6 overflow-y-auto min-h-[20rem]">
            {!selected ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-400">
                <Lightbulb className="w-10 h-10 mb-3 text-amber-300" />
                <p className="font-bold text-slate-600">Select a chromosome to begin</p>
                <p className="text-sm mt-1 max-w-xs">Labels stay hidden until you progressively reveal the hints.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {steps.slice(0, revealedStep).map((step, index) => (
                  <div
                    key={step.title}
                    className={cn(
                      'rounded-2xl border p-4',
                      index === revealedStep - 1
                        ? 'border-amber-200 bg-amber-50/60'
                        : 'border-slate-100 bg-slate-50'
                    )}
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600">
                      Step {index + 1}
                    </p>
                    <h4 className="font-black text-slate-900 mt-1">{step.title}</h4>
                    <ol className="mt-2 space-y-2">
                      {step.instructions.map((instruction, instructionIndex) => (
                        <li key={instruction} className="flex gap-2 text-sm text-slate-600 leading-relaxed">
                          <span className="font-mono font-bold text-slate-400">{instructionIndex + 1}.</span>
                          <span>{instruction}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}

                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setRevealedStep(step => Math.max(1, step - 1))}
                    disabled={revealedStep === 1}
                    className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-30 flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" /> Previous
                  </button>
                  {revealedStep < steps.length ? (
                    <button
                      type="button"
                      onClick={() => setRevealedStep(step => Math.min(steps.length, step + 1))}
                      className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 flex items-center gap-1 shadow-lg shadow-amber-500/20"
                    >
                      Reveal next hint <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <span className="text-xs font-bold text-emerald-600">All hints revealed</span>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
        )}
      </div>
    </div>
  );
}
