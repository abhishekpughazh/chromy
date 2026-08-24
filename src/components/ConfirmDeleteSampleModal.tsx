import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { LazyThumb } from './LazyThumb';

export const DELETE_CONFIRMATION_WORD = 'DELETE';

type ConfirmDeleteSampleModalProps = {
  originalUrl: string;
  karyotype?: string;
  labeledCount: number;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export const ConfirmDeleteSampleModal: React.FC<ConfirmDeleteSampleModalProps> = ({
  originalUrl,
  karyotype,
  labeledCount,
  deleting,
  error,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  const canConfirm = typed.trim() === DELETE_CONFIRMATION_WORD && !deleting;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (!deleting && e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-black text-slate-900">
                Delete this metaphase spread?
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                This permanently removes the image and all chromosome annotations. It cannot be undone.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="p-1.5 rounded-full hover:bg-slate-100 text-slate-400 disabled:opacity-40"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canConfirm) onConfirm();
          }}
        >
          <div className="px-5 py-4 space-y-4">
            <div className="rounded-xl overflow-hidden border border-slate-200 bg-slate-100 aspect-[4/3]">
              <LazyThumb
                src={originalUrl}
                alt="Spread to delete"
                width={480}
                height={360}
                resize="cover"
                className="w-full h-full object-cover"
              />
            </div>
            <dl className="text-xs space-y-1.5">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400 font-bold uppercase">Karyotype</dt>
                <dd className="font-mono font-bold text-slate-800 truncate">
                  {karyotype || 'Not set'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-400 font-bold uppercase">Annotated</dt>
                <dd className="font-mono font-bold text-slate-800">
                  {labeledCount} chromosome{labeledCount === 1 ? '' : 's'}
                </dd>
              </div>
            </dl>

            <label className="block">
              <span className="text-xs font-bold text-slate-600">
                Type {DELETE_CONFIRMATION_WORD} to confirm
              </span>
              <input
                value={typed}
                disabled={deleting}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={DELETE_CONFIRMATION_WORD}
                className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50"
              />
            </label>

            {error && (
              <p className="text-sm text-red-600 font-medium">{error}</p>
            )}
          </div>

          <div className="px-5 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              disabled={deleting}
              onClick={onCancel}
              className="px-4 py-2 rounded-xl text-sm font-bold text-slate-600 hover:bg-white disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canConfirm}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-red-600 hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
            >
              {deleting ? 'Deleting…' : 'Permanently delete'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
