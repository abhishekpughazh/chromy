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
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
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
  MouseSensor
} from '@dnd-kit/core';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Info, RotateCcw, CheckCircle2, ChevronRight, Dna, Undo2, 
  ShieldCheck, Upload, Play, Beaker, X, Loader, ImageIcon, Zap, Pencil, Trash2, RotateCw, FlipHorizontal, FlipVertical, Expand, Download
} from 'lucide-react';

// --- Types ---

type ChromosomeType = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '19' | '20' | '21' | '22' | 'X' | 'Y';

interface ChromosomeData {
  id: string;
  type: ChromosomeType;
  indexInPair: number; // 0 or 1
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

const CHROMOSOME_TYPES: ChromosomeType[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 
  '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', 'X', 'Y'
];

// Mock sizes (Chromosomes are generally ordered from largest to smallest, 1 is biggest, 22 smallest)
const SIZE_MAP: Record<ChromosomeType, number> = {
  '1': 1.0, '2': 0.95, '3': 0.85, '4': 0.82, '5': 0.8, '6': 0.75, '7': 0.72, '8': 0.68,
  '9': 0.65, '10': 0.63, '11': 0.62, '12': 0.6, '13': 0.55, '14': 0.52, '15': 0.5,
  '16': 0.48, '17': 0.45, '18': 0.42, '19': 0.35, '20': 0.33, '21': 0.28, '22': 0.25,
  'X': 0.7, 'Y': 0.3
};

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
          indexInPair: i,
          size: SIZE_MAP[type],
          banding: generateBanding(type + i)
        });
    }
  });
  return chromosomes;
};

// --- Components ---

const ChromosomeVisual = ({ chromosome, className, isDragging = false, isReviewing = false }: { chromosome: ChromosomeData, className?: string, isDragging?: boolean, isReviewing?: boolean }) => {
  if (chromosome.imageUrl) {
    const rot = chromosome.userRotation || 0;
    const fx = chromosome.userFlipX ? -1 : 1;
    const fy = chromosome.userFlipY ? -1 : 1;

    return (
      <div 
        className={cn(
          "relative flex flex-col items-center justify-center p-1 cursor-grab active:cursor-grabbing group",
          isDragging && "opacity-50",
          className
        )}
        style={{ height: '80px', width: 'auto' }}
      >
        <img 
          src={chromosome.imageUrl} 
          className={cn(
            "max-h-full max-w-[40px] object-contain transition-all print:!drop-shadow-none print:!filter-none",
            !isReviewing && "drop-shadow-md filter group-hover:drop-shadow-lg"
          )}
          draggable={false}
          alt={chromosome.type}
          style={{ transform: `rotate(${rot}deg) scaleX(${fx}) scaleY(${fy})` }}
        />
        {!isDragging && !isReviewing && (
          <div className="absolute -bottom-5 text-[10px] font-mono text-slate-400 opacity-0 hover:opacity-100 transition-opacity print:hidden">
            {chromosome.type + (chromosome.indexInPair === 0 ? 'L' : 'R')}
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

const DraggableChromosome = ({ id, chromosome, onUpdate, isReviewing }: { id: string, chromosome: ChromosomeData, onUpdate?: (id: string, updates: Partial<ChromosomeData>) => void, isReviewing?: boolean }) => {
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
        <ChromosomeVisual chromosome={chromosome} isDragging={isDragging} isReviewing={isReviewing} />
      </div>
      {onUpdate && chromosome.imageUrl && !isDragging && !isReviewing && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white border border-slate-200 shadow-lg rounded-lg p-1 flex gap-1 z-50 opacity-0 group-hover/chrom:opacity-100 transition-opacity cursor-default print:hidden">
          <button onClick={(e) => { e.stopPropagation(); onUpdate(id, { userRotation: ((chromosome.userRotation || 0) + 45) % 360 }) }} className="p-1 hover:bg-slate-100 rounded text-slate-600"><RotateCw className="w-3 h-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onUpdate(id, { userFlipX: !chromosome.userFlipX }) }} className="p-1 hover:bg-slate-100 rounded text-slate-600"><FlipHorizontal className="w-3 h-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onUpdate(id, { userFlipY: !chromosome.userFlipY }) }} className="p-1 hover:bg-slate-100 rounded text-slate-600"><FlipVertical className="w-3 h-3" /></button>
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
        "w-8 h-24 flex items-center justify-center transition-all duration-200 relative group/slot print:!border-none print:!bg-transparent print:!shadow-none",
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
  return <div ref={setNodeRef} className="h-full">{children}</div>;
};

interface KaryotypePairProps {
  type: ChromosomeType;
  placedChromosomes: Record<string, ChromosomeData>;
  onUpdateChromosome: (slotId: string, updates: Partial<ChromosomeData>) => void;
  isReviewing?: boolean;
}

const KaryotypePair: React.FC<KaryotypePairProps> = ({ type, placedChromosomes, onUpdateChromosome, isReviewing }) => {
  const slot1Id = `slot-${type}-0`;
  const slot2Id = `slot-${type}-1`;
  
  const chrom1 = placedChromosomes[slot1Id];
  const chrom2 = placedChromosomes[slot2Id];

  const getSlotState = (chrom: ChromosomeData | undefined, expectedIndex: number) => {
    if (!chrom) return 'empty';
    if (chrom.type !== type || chrom.indexInPair !== expectedIndex) return 'wrong';
    
    if (chrom.imageUrl) {
      if (chrom.userRotation === chrom.expectedRotation && 
          chrom.userFlipX === chrom.expectedFlipX && 
          chrom.userFlipY === chrom.expectedFlipY) {
        return 'fully-correct';
      }
      return 'type-correct';
    }
    // Mock data is always fully correct if type matches
    return 'fully-correct';
  };

  const isOccupied1 = !!chrom1;
  const isOccupied2 = !!chrom2;

  const state1 = getSlotState(chrom1, 0);
  const state2 = getSlotState(chrom2, 1);

  return (
    <div className={cn("flex flex-col items-center gap-2 p-3 rounded-xl transition-colors group", !isReviewing && "hover:bg-slate-100/50")}>
      <div className="flex gap-1">
        <DroppableSlot id={slot1Id} acceptType={type} isOccupied={isOccupied1} state={state1} isReviewing={isReviewing}>
          {chrom1 && <DraggableChromosome id={chrom1.id} chromosome={chrom1} onUpdate={(id, updates) => onUpdateChromosome(slot1Id, updates)} isReviewing={isReviewing} />}
        </DroppableSlot>
        <DroppableSlot id={slot2Id} acceptType={type} isOccupied={isOccupied2} state={state2} isReviewing={isReviewing}>
          {chrom2 && <DraggableChromosome id={chrom2.id} chromosome={chrom2} onUpdate={(id, updates) => onUpdateChromosome(slot2Id, updates)} isReviewing={isReviewing} />}
        </DroppableSlot>
      </div>
      <span className={cn(
        "text-xs font-bold font-mono transition-colors print:!text-slate-900",
        !isReviewing && (isOccupied1 && state1 === 'fully-correct' && isOccupied2 && state2 === 'fully-correct') ? "text-emerald-600" : (!isReviewing ? "text-slate-500 group-hover:text-sky-600" : "text-slate-900")
      )}>
        {type}
      </span>
    </div>
  );
};

interface WelcomeScreenProps {
  onStart: () => void;
  onAdmin: () => void;
  onSignOut?: () => void;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onStart, onAdmin, onSignOut }) => (
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

      <button 
        onClick={onAdmin}
        className="mt-8 text-slate-300 hover:text-slate-900 transition-colors text-xs font-mono tracking-widest uppercase flex items-center gap-2 mx-auto"
      >
        <ShieldCheck className="w-3.5 h-3.5" /> ADMIN ACCESS
      </button>
    </div>
  </motion.div>
);

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
    
    strokeEls.forEach((el, idx) => {
      const label = el.getAttribute('label') || 'Unassigned';
      if (label === 'Unassigned') return;
      let baseLabel = '';
      let indexInPair = 0;
      
      if (label.includes('-')) {
        baseLabel = label.split('-')[0];
        indexInPair = label.split('-')[1] === '2' ? 1 : 0;
      } else {
        baseLabel = label.slice(0, -1);
        indexInPair = label.slice(-1) === 'R' ? 1 : 0;
      }
      
      if (!CHROMOSOME_TYPES.includes(baseLabel as ChromosomeType)) return;
      
      const rotation = parseFloat(el.getAttribute('rotation') || '0');
      const flipX = el.getAttribute('flipX') === 'true';
      const flipY = el.getAttribute('flipY') === 'true';

      const pointEls = el.querySelectorAll('point');
      if (pointEls.length < 3) return;
      
      const points = Array.from(pointEls).map(p => ({
        x: parseFloat(p.getAttribute('x') || '0'),
        y: parseFloat(p.getAttribute('y') || '0')
      }));
      
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      points.forEach(p => {
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

      ctx.beginPath();
      ctx.moveTo(points[0].x - minX, points[0].y - minY);
      for(let i=1; i<points.length; i++) {
        ctx.lineTo(points[i].x - minX, points[i].y - minY);
      }
      ctx.closePath();
      ctx.clip();
      
      ctx.drawImage(img, minX, minY, w, h, 0, 0, w, h);
      
      extracted.push({
        id: `chrom-${label}-${idx}-${Date.now()}`,
        type: baseLabel as ChromosomeType,
        indexInPair: indexInPair,
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
    
    return extracted;
  } catch (e) {
    console.error("Failed to extract chromosomes", e);
    return [];
  }
};

interface AdminImage {
  id: string;
  originalUrl: string;
  xml?: string;
}

import ImageAnnotationModal from './components/ImageAnnotationModal';

interface AdminPanelProps {
  onClose: () => void;
  images: AdminImage[];
  setImages: React.Dispatch<React.SetStateAction<AdminImage[]>>;
  session: Session | null;
}

const AdminPanel: React.FC<AdminPanelProps> = ({ onClose, images, setImages, session }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<AdminImage | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [annotateImageUrl, setAnnotateImageUrl] = useState<string | null>(null);
  const [annotateImageId, setAnnotateImageId] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleUpload(file);
    e.target.value = '';
  };

  const handleUpload = async (file: File) => {
    if (!session?.user) return;
    setUploading(true);
    setUploadError(null);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${session.user.id}/${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
      
      const { error: uploadError, data: uploadData } = await supabase.storage
        .from('images')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('images')
        .getPublicUrl(fileName);

      const { data: dbData, error: dbError } = await supabase
        .from('samples')
        .insert({
          user_id: session.user.id,
          original_url: publicUrl,
          xml: ''
        })
        .select()
        .single();

      if (dbError) throw dbError;

      const newImage: AdminImage = {
        id: dbData.id,
        originalUrl: publicUrl,
        xml: ''
      };
      
      setImages(prev => [newImage, ...prev]);
      setLastUpload(newImage);
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const deleteImage = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this sample?')) return;
    
    const img = images.find(i => i.id === id);
    if (!img) return;

    try {
      const fileName = img.originalUrl.split('/').slice(-2).join('/');
      await supabase.storage.from('images').remove([fileName]);
      await supabase.from('samples').delete().eq('id', id);

      setImages(prev => prev.filter(i => i.id !== id));
      if (lastUpload?.id === id) setLastUpload(null);
    } catch (err) {
      console.error('Failed to delete image:', err);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="fixed inset-0 z-[100] bg-white flex flex-col p-8"
    >
      <header className="flex items-center justify-between mb-12">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-slate-900" />
          <h2 className="text-2xl font-black">Admin Console</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
          <X className="w-6 h-6" />
        </button>
      </header>

        <div className="flex-1 max-w-4xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-6">
            <h3 className="text-xl font-black">Upload Metaphase Spread</h3>

            <input
              type="file"
              accept=".jpg,.jpeg,.png"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
            />

              <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) handleUpload(file);
              }}
              className={cn(
                "p-12 border-4 border-dashed rounded-3xl flex flex-col items-center justify-center text-center group transition-colors cursor-pointer bg-slate-50/50",
                uploading ? "border-sky-300 bg-sky-50/50" : "border-slate-100 hover:border-slate-300"
              )}
            >
              {uploading ? (
                <Loader className="w-12 h-12 text-sky-500 animate-spin mb-4" />
              ) : (
                <Upload className="w-12 h-12 text-slate-300 group-hover:text-slate-900 transition-colors mb-4" />
              )}
              <p className="font-bold text-slate-400 group-hover:text-slate-900">
                {uploading ? 'Processing...' : 'Upload JPG, JPEG or PNG'}
              </p>
              <p className="text-sm text-slate-300">Click or drag & drop</p>
              {uploadError && (
                <p className="mt-2 text-sm text-red-500 font-medium">{uploadError}</p>
              )}
            </div>

            {lastUpload && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
                <p className="text-xs font-mono text-slate-400">
                  IMAGE PREVIEW
                </p>
                <img
                  src={lastUpload.originalUrl}
                  alt="Uploaded"
                  className="w-full rounded-xl border border-slate-100"
                />
              </div>
            )}

            <div className="bg-slate-900 text-white p-6 rounded-2xl shadow-xl">
               <h4 className="flex items-center gap-2 font-bold mb-4">
                 <Info className="w-5 h-5 text-sky-400" />
                 Instructions
               </h4>
               <ul className="space-y-4 text-sm text-slate-300">
                 <li className="flex items-start gap-3">
                   <div className="w-5 h-5 rounded bg-white/10 flex items-center justify-center text-[10px] font-bold shrink-0">1</div>
                   Upload a metaphase spread image.
                 </li>
                 <li className="flex items-start gap-3">
                   <div className="w-5 h-5 rounded bg-white/10 flex items-center justify-center text-[10px] font-bold shrink-0">2</div>
                   Click on the uploaded sample in the gallery to open the annotation tool and outline individual chromosomes.
                 </li>
               </ul>
            </div>
          </div>

          <div className="bg-slate-50 rounded-3xl p-8 border border-slate-100 flex flex-col h-full max-h-[800px]">
             <div className="flex items-center justify-between mb-6 shrink-0">
               <h3 className="text-xl font-black">Available Dataset</h3>
               <span className="text-xs font-mono font-bold text-slate-400 bg-slate-200 px-2 py-1 rounded-md">{images.length} SAMPLES</span>
             </div>
             
             <div className="flex-1 overflow-y-auto pr-2 pb-4 scrollbar-hide">
               {images.length === 0 ? (
                 <div className="h-full flex flex-col items-center justify-center text-center text-slate-300">
                   <p className="text-sm font-medium">No samples uploaded yet</p>
                 </div>
               ) : (
                 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                   {images.map((img) => (
                     <div
                       key={img.id}
                       className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden cursor-pointer group relative aspect-square flex flex-col"
                       onClick={() => {
                         const url = img.originalUrl;
                         if (!url) return;
                         setAnnotateImageUrl(url);
                         setAnnotateImageId(img.id);
                       }}
                     >
                       {/* Delete Button */}
                       <button
                         onClick={(e) => deleteImage(img.id, e)}
                         className="absolute top-2 right-2 z-10 w-7 h-7 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                         title="Delete Sample"
                       >
                         <Trash2 className="w-3.5 h-3.5" />
                       </button>

                       {/* Status Tag */}
                       <div className="absolute top-2 left-2 z-10">
                         <span className={cn(
                           "text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm uppercase backdrop-blur-md",
                           "bg-slate-900/80 text-white"
                         )}>
                           RAW
                         </span>
                       </div>

                       <div className="relative flex-1 bg-slate-100 overflow-hidden">
                         <img
                           src={img.originalUrl}
                           alt="Sample"
                           className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                         />
                         <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center">
                           <div className="opacity-0 group-hover:opacity-100 transition-opacity transform translate-y-2 group-hover:translate-y-0 flex items-center gap-2 bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-lg shadow-xl">
                             <Pencil className="w-3.5 h-3.5 text-slate-900" />
                             <span className="text-[10px] font-bold text-slate-900">Annotate</span>
                           </div>
                         </div>
                       </div>
                     </div>
                   ))}
                 </div>
               )}
             </div>
          </div>
        </div>
      {annotateImageUrl && annotateImageId && (
        <ImageAnnotationModal
          imageUrl={annotateImageUrl}
          imageId={annotateImageId}
          initialXml={images.find(img => img.id === annotateImageId)?.xml}
          onSave={async (xml) => {
            try {
              const { error } = await supabase
                .from('samples')
                .update({ xml })
                .eq('id', annotateImageId);
              
              if (error) throw error;
              setImages(prev => prev.map(img => img.id === annotateImageId ? { ...img, xml } : img));
            } catch (err) {
              console.error('Failed to save annotations to DB:', err);
              alert('Failed to save annotations to database.');
            }
          }}
          onClose={() => {
            setAnnotateImageUrl(null);
            setAnnotateImageId(null);
          }}
        />
      )}
    </motion.div>
  );
};

interface SpreadSelectionScreenProps {
  images: AdminImage[];
  onSelect: (img: AdminImage, extracted: ChromosomeData[]) => void;
  onBack: () => void;
}

const SpreadSelectionScreen: React.FC<SpreadSelectionScreenProps> = ({ images, onSelect, onBack }) => {
  const [extractingId, setExtractingId] = useState<string | null>(null);

  const handleSelect = async (img: AdminImage) => {
    if (extractingId) return;
    setExtractingId(img.id);
    const extracted = await extractChromosomes(img);
    onSelect(img, extracted);
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

        {images.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white rounded-3xl border border-slate-200 shadow-sm p-8 text-center">
            <ImageIcon className="w-12 h-12 mb-4 opacity-50 mx-auto" />
            <p className="text-lg font-bold text-slate-700">No metaphase spreads available</p>
            <p className="text-sm mt-1">Please ask the administrator to upload and annotate samples.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {images.map(img => (
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
                  <img
                    src={img.originalUrl}
                    alt="Spread"
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                  />
                  <div className="absolute inset-0 bg-sky-900/0 group-hover:bg-sky-900/10 transition-colors" />
                </div>
                <div className="p-4 border-t border-slate-100 flex items-center justify-between bg-white shrink-0">
                  <div>
                    <p className="text-[10px] font-mono text-slate-400 font-bold">SAMPLE ID</p>
                    <p className="font-bold text-sm text-slate-700 truncate w-32">{img.id.slice(0, 12)}</p>
                  </div>
                  <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-sky-50 transition-colors">
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-sky-500" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
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

export default function Chromy() {
  const [session, setSession] = useState<Session | null>(null);
  const [images, setImages] = useState<AdminImage[]>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [gameState, setGameState] = useState<'welcome' | 'select' | 'playing' | 'admin'>('welcome');
  const [selectedImage, setSelectedImage] = useState<AdminImage | null>(null);
  const [originalExtracted, setOriginalExtracted] = useState<ChromosomeData[]>([]);
  const [jumbled, setJumbled] = useState<ChromosomeData[]>([]);
  const [placed, setPlaced] = useState<Record<string, ChromosomeData>>({});
  const [history, setHistory] = useState<{ jumbled: ChromosomeData[], placed: Record<string, ChromosomeData> }[]>([]);
  const [isReviewingCertificate, setIsReviewingCertificate] = useState(false);
  const [certificateName, setCertificateName] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(MouseSensor),
    useSensor(TouchSensor)
  );

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
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
            xml: row.xml
          })));
        }
      } catch (e) {
        console.error('Failed to load images from Supabase', e);
      } finally {
        setImagesLoaded(true);
      }
    };
    loadFromDb();
  }, [session]);

  useEffect(() => {
    const initial = createInitialChromosomes();
    setJumbled(initial.sort(() => Math.random() - 0.5));
    setScore({ correct: 0, total: initial.length });
  }, []);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { over, active } = event;
    setActiveId(null);

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

  const updateJumbled = (id: string, updates: Partial<ChromosomeData>) => {
    setJumbled(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const updatePlaced = (slotId: string, updates: Partial<ChromosomeData>) => {
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
    const lastState = history[history.length - 1];
    setJumbled(lastState.jumbled);
    setPlaced(lastState.placed);
    setHistory(prev => prev.slice(0, -1));
  };

  const resetGame = () => {
    if (originalExtracted.length > 0) {
      setJumbled([...originalExtracted].sort(() => Math.random() - 0.5));
    } else {
      const initial = createInitialChromosomes();
      setJumbled(initial.sort(() => Math.random() - 0.5));
    }
    setPlaced({});
    setHistory([]);
    setGameState('playing');
  };


  const currentActiveChromosome = useMemo(() => {
    if (!activeId) return null;
    return (jumbled.find(c => c.id === activeId) || Object.values(placed).find((c: ChromosomeData) => c.id === activeId)) as ChromosomeData | undefined;
  }, [activeId, jumbled, placed]);

  // Calculate score: chromosomes placed in slots that match their type and pair index
  useEffect(() => {
    let correctCount = 0;
    Object.entries(placed).forEach(([slotId, chrom]: [string, ChromosomeData]) => {
      const parts = slotId.split('-');
      const expectedType = parts[1];
      const expectedIndex = parseInt(parts[2], 10);
      
      if (chrom.type === expectedType && chrom.indexInPair === expectedIndex) {
        if (chrom.imageUrl) {
          if (chrom.userRotation === chrom.expectedRotation && 
              chrom.userFlipX === chrom.expectedFlipX && 
              chrom.userFlipY === chrom.expectedFlipY) {
            correctCount++;
          }
        } else {
          correctCount++;
        }
      }
    });
    setScore(prev => ({ ...prev, correct: correctCount }));
  }, [placed]);

  const progress = (score.correct / score.total) * 100;
  const isComplete = progress === 100 && score.total > 0;

  const successPhrase = useMemo(() => {
    if (isComplete) {
      return SUCCESS_PHRASES[Math.floor(Math.random() * SUCCESS_PHRASES.length)];
    }
    return "DIAGNOSIS COMPLETE";
  }, [isComplete]);

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-200">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center text-white">
              <Dna className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-900">CHROMY</h1>
              <p className="text-[10px] text-slate-400 font-mono tracking-widest uppercase">Login to continue</p>
            </div>
          </div>
          <Auth 
            supabaseClient={supabase} 
            appearance={{ theme: ThemeSupa }} 
            providers={['google']}
            magicLink={true}
          />
        </div>
      </div>
    );
  }

  return (
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
          />
        )}
        {gameState === 'select' && (
          <SpreadSelectionScreen
            key="select"
            images={images}
            onBack={() => setGameState('welcome')}
            onSelect={(img, extracted) => {
              setSelectedImage(img);
              setOriginalExtracted(extracted);
              
              if (extracted.length > 0) {
                setJumbled([...extracted].sort(() => Math.random() - 0.5));
                setScore({ correct: 0, total: extracted.length });
              } else {
                // Fallback to mock data if no annotations were found
                const initial = createInitialChromosomes();
                setJumbled(initial.sort(() => Math.random() - 0.5));
                setScore({ correct: 0, total: initial.length });
              }
              
              setPlaced({});
              setHistory([]);
              setGameState('playing');
            }}
          />
        )}
        {gameState === 'admin' && (
          <AdminPanel 
            key="admin" 
            images={images}
            setImages={setImages}
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

          <div className="flex items-center gap-6">
             <div className="flex flex-col items-end">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-400">ACCURACY</span>
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
                  onClick={undo}
                  disabled={history.length === 0}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-900 disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Undo last placement"
                >
                  <Undo2 className="w-5 h-5" />
               </button>

               <button 
                  onClick={resetGame}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-900"
                  title="Reset Karyogram"
                >
                  <RotateCcw className="w-5 h-5" />
               </button>
             </div>
          </div>
        </header>

        <main className={cn(
          "px-6 pb-6 grid gap-6 overflow-hidden print:h-auto print:overflow-visible print:block",
          isReviewingCertificate ? "pt-6 h-screen grid-cols-1" : "pt-20 h-[calc(100vh-80px)] grid-cols-1 lg:grid-cols-[1fr_3fr]"
        )}>
          
          {/* Left Panel: Jumbled Source */}
          {!isReviewingCertificate && (
            <RawSampleDroppable id="raw-sample-panel">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col shadow-sm overflow-hidden bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] h-full">
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
                  <img 
                    src={selectedImage.originalUrl} 
                    alt="Selected Metaphase Spread"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover/source:scale-105"
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
                            <DraggableChromosome id={chrom.id} chromosome={chrom} onUpdate={updateJumbled} />
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
            "bg-white rounded-2xl border border-slate-200 p-8 shadow-sm overflow-y-auto print:border-none print:shadow-none print:p-0 flex flex-col print:overflow-visible print:h-auto min-h-0", 
            isReviewingCertificate && "col-span-full border-none shadow-none h-full pb-20"
          )}>
             {isReviewingCertificate && (
               <div className="text-center mb-4 hidden print:block !block shrink-0">
                 <h1 className="text-4xl font-black text-slate-900 tracking-tighter mb-2">KARYOTYPE DIAGNOSTIC CERTIFICATE</h1>
                 <p className="text-lg text-slate-500 font-medium">Assembled and verified by <span className="font-black text-slate-800">{certificateName}</span></p>
                 <div className="w-24 h-1 bg-slate-200 mx-auto mt-4 rounded-full" />
               </div>
             )}

             <div className="flex flex-col justify-between flex-1 w-full max-w-6xl mx-auto h-full min-h-0 gap-4 md:gap-6">
               {[
                 [['1', '2', '3'], ['4', '5']],
                 [['6', '7', '8', '9', '10', '11', '12']],
                 [['13', '14', '15'], ['16', '17', '18']],
                 [['19', '20'], ['21', '22'], ['X', 'Y']]
               ].map((rowGroups, rowIdx) => (
                 <div key={rowIdx} className="flex w-full justify-center items-start gap-8 md:gap-16">
                   {rowGroups.map((group, groupIdx) => (
                     <div 
                       key={groupIdx} 
                       className="flex gap-2 md:gap-4"
                     >
                       {group.map((type: string) => (
                         <div key={type} className="flex-shrink-0">
                           <KaryotypePair 
                             type={type as ChromosomeType} 
                             placedChromosomes={placed} 
                             onUpdateChromosome={updatePlaced}
                             isReviewing={isReviewingCertificate}
                           />
                         </div>
                       ))}
                     </div>
                   ))}
                 </div>
               ))}
             </div>

          </div>
        </main>

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
                <ChromosomeVisual chromosome={currentActiveChromosome} />
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
  );
}

