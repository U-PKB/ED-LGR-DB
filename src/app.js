import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAnalysisConfigured } from './analyse.js';
import { CATEGORIES, REGIONS, RELEVANCE_LEVELS } from './constants.js';
import { openDatabase } from './db.js';
import { createAnalysisQueue } from './queue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export function createApp({ dataDir, analyse } = {}) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const db = openDatabase(dataDir);
  const queue = createAnalysisQueue(db, uploadsDir, analyse ? { analyse } : undefined);

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) =>
        cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(here, '..', 'public')));

  app.get('/api/options', (_req, res) => {
    res.json({
      categories: CATEGORIES,
      regions: REGIONS,
      relevanceLevels: RELEVANCE_LEVELS,
      analysisEnabled: isAnalysisConfigured() || Boolean(analyse),
    });
  });

  app.get('/api/entries', (_req, res) => res.json(db.list()));

  app.get('/api/entries/:id', (req, res) => {
    const entry = db.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    res.json(entry);
  });

  app.post('/api/entries', upload.single('attachment'), (req, res) => {
    const { data, errors } = validate(req.body, { file: req.file });
    if (errors.length) {
      removeUpload(uploadsDir, req.file?.filename);
      return res.status(400).json({ error: errors.join(' ') });
    }
    if (req.file) {
      Object.assign(data, {
        attachment_path: req.file.filename,
        attachment_name: req.file.originalname,
        attachment_type: req.file.mimetype,
      });
    }
    const entry = db.create({ ...data, analysis_status: 'pending' });
    queue.enqueue(entry.id);
    res.status(201).json(db.get(entry.id));
  });

  app.put('/api/entries/:id', upload.single('attachment'), (req, res) => {
    const existing = db.get(req.params.id);
    if (!existing) {
      removeUpload(uploadsDir, req.file?.filename);
      return res.status(404).json({ error: 'Entry not found.' });
    }
    const removeAttachment = req.body.remove_attachment === 'true';
    const keepsAttachment = Boolean(existing.attachment_path) && !removeAttachment;
    const { data, errors } = validate(req.body, { file: req.file, keepsAttachment });
    if (errors.length) {
      removeUpload(uploadsDir, req.file?.filename);
      return res.status(400).json({ error: errors.join(' ') });
    }

    if (req.file || removeAttachment) {
      removeUpload(uploadsDir, existing.attachment_path);
      Object.assign(data, {
        attachment_path: req.file?.filename ?? null,
        attachment_name: req.file?.originalname ?? null,
        attachment_type: req.file?.mimetype ?? null,
      });
    }

    // Re-run the analysis when what it is based on has changed.
    const sourceChanged =
      Boolean(req.file) ||
      removeAttachment ||
      (data.link ?? null) !== (existing.link ?? null) ||
      data.title !== existing.title ||
      data.notes !== existing.notes;
    const entry = db.update(existing.id, data);
    if (sourceChanged || req.body.reanalyse === 'true') queue.enqueue(entry.id);
    res.json(db.get(entry.id));
  });

  app.post('/api/entries/:id/analyse', (req, res) => {
    const entry = db.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    queue.enqueue(entry.id);
    res.json(db.get(entry.id));
  });

  app.delete('/api/entries/:id', (req, res) => {
    const entry = db.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    db.remove(entry.id);
    removeUpload(uploadsDir, entry.attachment_path);
    res.status(204).end();
  });

  app.get('/api/entries/:id/attachment', (req, res) => {
    const entry = db.get(req.params.id);
    if (!entry?.attachment_path) return res.status(404).json({ error: 'No document attached.' });
    res.download(path.join(uploadsDir, entry.attachment_path), entry.attachment_name);
  });

  app.get('/api/export.csv', (_req, res) => {
    const columns = [
      ['ID', (e) => e.id],
      ['Date entered', (e) => e.date_entered],
      ['Category', (e) => e.category],
      ['Title or question', (e) => e.title],
      ['Link', (e) => e.link],
      ['Document', (e) => e.attachment_name],
      ['UNISON region', (e) => e.region],
      ['Council or strategic authority', (e) => e.authority],
      ['Keywords', (e) => e.keywords],
      ['Notes', (e) => e.notes],
      ['Relevance', (e) => e.relevance],
      ['Briefing', (e) => e.briefing],
      ['Key messages', (e) => e.key_messages.map((m) => `• ${m}`).join('\n')],
    ];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [columns.map(([h]) => cell(h)).join(',')].concat(
      db.list().map((e) => columns.map(([, get]) => cell(get(e))).join(',')),
    );
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ed-lgr-database-${date}.csv"`);
    res.send('﻿' + rows.join('\r\n'));
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'The document is too large (maximum 30 MB).' : err.message;
      return res.status(400).json({ error: message });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return { app, db, queue };
}

function validate(body, { file, keepsAttachment = false }) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');

  const data = {
    title: text(body.title),
    link: text(body.link) || null,
    category: text(body.category).toUpperCase(),
    notes: text(body.notes),
    keywords: text(body.keywords)
      .split(/[,;\n]/)
      .map((k) => k.trim())
      .filter(Boolean)
      .join(', '),
    date_entered: text(body.date_entered) || new Date().toISOString().slice(0, 10),
    region: text(body.region),
    authority: text(body.authority),
  };

  if (!(data.category in CATEGORIES)) errors.push('Choose a category of LGR or ED.');
  if (!REGIONS.includes(data.region)) errors.push('Choose a UNISON region or National.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date_entered) || Number.isNaN(Date.parse(data.date_entered))) {
    errors.push('The date entered is not a valid date.');
  }
  if (data.link) {
    try {
      const url = new URL(data.link);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      errors.push('The link must be a full web address starting with http:// or https://.');
    }
  }
  if (!data.link && !file && !keepsAttachment && !data.title && !data.notes) {
    errors.push('Add a link, attach a document, or type a question or note.');
  }
  return { data, errors };
}

function removeUpload(uploadsDir, filename) {
  if (!filename) return;
  fs.rm(path.join(uploadsDir, path.basename(filename)), { force: true }, () => {});
}
