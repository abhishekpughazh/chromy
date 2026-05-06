import express from 'express';
import multer from 'multer';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure dirs exist
const uploadsDir = path.join(__dirname, 'uploads');
const originalsDir = path.join(__dirname, 'preserved', 'originals');
const upscaledDir = path.join(__dirname, 'preserved', 'upscaled');
const annotationsDir = path.join(__dirname, 'annotations');
for (const d of [uploadsDir, originalsDir, upscaledDir, annotationsDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use(express.json());
app.use(express.text({ type: 'application/xml', limit: '50mb' }));
app.use(express.text({ type: 'text/xml', limit: '50mb' }));

// Multer config: store in server/uploads/
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const allowed = /jpg|jpeg|png/i;
    const ext = allowed.test(path.extname(file.originalname));
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    return cb(new Error('Only JPG, JPEG, and PNG files are allowed'));
  }
});

// CORS for Vite dev server
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use('/originals', express.static(originalsDir));
app.use('/upscaled', express.static(upscaledDir));

app.get('/health', (_req, res) => res.json({ ok: true }));

// DELETE /api/images/:id
app.delete('/api/images/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'No ID provided' });

  let deleted = false;

  // Find and delete originals
  const originals = fs.readdirSync(originalsDir).filter(f => f.startsWith(id));
  for (const f of originals) {
    try { fs.unlinkSync(path.join(originalsDir, f)); deleted = true; } catch (_) {}
  }

  // Find and delete upscaled
  const upscaled = fs.readdirSync(upscaledDir).filter(f => f.startsWith(id));
  for (const f of upscaled) {
    try { fs.unlinkSync(path.join(upscaledDir, f)); deleted = true; } catch (_) {}
  }

  // Delete annotations
  const annFile = toAnnotationFile(id);
  if (fs.existsSync(annFile)) {
    try { fs.unlinkSync(annFile); } catch (_) {}
  }

  if (deleted) {
    return res.json({ ok: true, id });
  } else {
    return res.status(404).json({ error: 'Image not found' });
  }
});

// GET /api/images — list all preserved images
app.get('/api/images', (_req, res) => {
  const originals = fs.readdirSync(originalsDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  const upscaled = fs.readdirSync(upscaledDir).filter(f => /_4k\.png$/i.test(f));

  const map = new Map();
  for (const f of originals) {
    const id = f.replace(/\.[^.]+$/, '');
    map.set(id, { id, originalName: f, originalUrl: `/originals/${f}`, upscaledUrl: null });
  }
  for (const f of upscaled) {
    const id = f.replace(/_4k\.png$/, '');
    const entry = map.get(id);
    if (entry) {
      entry.upscaledUrl = `/upscaled/${f}`;
    } else {
      map.set(id, { id, originalName: null, originalUrl: null, upscaledUrl: `/upscaled/${f}` });
    }
  }

  return res.json({ ok: true, images: Array.from(map.values()) });
});

// POST /api/upload (with optional upscale)
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const doUpscale = req.body.upscale === 'true';
  const inputPath = req.file.path;
  const baseName = path.basename(req.file.filename, path.extname(req.file.filename));
  const ext = path.extname(req.file.filename);

  // Preserve original
  const originalDest = path.join(originalsDir, `${baseName}${ext}`);
  fs.copyFileSync(inputPath, originalDest);

  if (!doUpscale) {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    return res.json({
      ok: true,
      originalUrl: `/originals/${baseName}${ext}`,
      upscaledUrl: null,
      id: baseName,
    });
  }

  // Upscale
  const upscaledName = `${baseName}_4k.png`;
  const upscaledPath = path.join(upscaledDir, upscaledName);
  const weightsPath = path.join(__dirname, 'scripts', 'RealESRGAN_x4plus.pth');

  if (!fs.existsSync(weightsPath)) {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    return res.status(500).json({ error: 'RealESRGAN weights not found on server' });
  }

  const python = path.join(__dirname, '..', '.venv', 'bin', 'python');
  const script = path.join(__dirname, 'scripts', 'upscale_single.py');

  const child = spawn(python, [script, inputPath, upscaledPath, weightsPath]);

  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });

  child.on('close', (code) => {
    try { fs.unlinkSync(inputPath); } catch (_) {}

    if (code !== 0 || !fs.existsSync(upscaledPath)) {
      return res.status(500).json({ error: 'Upscaling failed', detail: stderr || `exit code ${code}` });
    }

    return res.json({
      ok: true,
      originalUrl: `/originals/${baseName}${ext}`,
      upscaledUrl: `/upscaled/${upscaledName}`,
      id: baseName,
    });
  });
});

const toAnnotationFile = (id) => path.join(annotationsDir, `${id}.annotations.xml`);

// GET /api/annotations/:id
app.get('/api/annotations/:id', (req, res) => {
  const file = toAnnotationFile(req.params.id);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: true, xml: null });
  }
  return res.type('application/xml').send(fs.readFileSync(file, 'utf-8'));
});

// POST /api/annotations/:id
app.post('/api/annotations/:id', (req, res) => {
  const file = toAnnotationFile(req.params.id);
  fs.writeFileSync(file, req.body, 'utf-8');
  return res.json({ ok: true, id: req.params.id });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
