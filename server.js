
// server.js (ESM, drop-in)
import express from 'express';
import path from 'path';
import fs from 'fs';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import multer from 'multer';
import mime from 'mime-types';
import { moderateText, validateGeo } from './src/moderation/bouncer.js';
import { getSubscription } from './src/payments/paypal.js';

// --- NEW: video transcription/extract (you already added these files)
import transcribeMedia from './src/inference/transcribe.js';
import { extractFieldsFromTranscript } from './src/inference/extract-estimate.js';

dotenv.config();

// ----- paths & env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGIN_ALLOWLIST = (process.env.ORIGIN_ALLOWLIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '7', 10);
const ALLOWED_MIME = (process.env.ALLOWED_MIME || 'image/jpeg,image/png,image/webp').split(',').map(s=>s.trim());
const INFER_PROVIDER = process.env.INFER_PROVIDER || 'stub';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const MAINTENANCE = (process.env.MAINTENANCE || 'false').toLowerCase() === 'true';
const PAYWALL_DISABLED = (process.env.PAYWALL_DISABLED || 'false').toLowerCase() === 'true';
const PREVIEW_DEVICE = process.env.PREVIEW_DEVICE || null; // only sets an X-Preview header

// ----- helpers
function isWritableDir(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}
function readJSON(file, fb) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
function writeJSON(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).send('unauthorized');
  next();
}

// ----- prepare data dirs (lazy if /data not mounted yet)
const subDirs = ['uploads', 'devices', 'payments', 'analytics', 'library', 'submissions'];
if (isWritableDir(DATA_DIR)) {
  subDirs.forEach(d => { try { fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true }); } catch {} });
} else {
  console.log('DATA_DIR not writable or not mounted yet; will create lazily.');
}

// ----- logging (Render-safe: file if /data usable, else console)
const logDir = path.join(DATA_DIR, 'logs');
let accessLogStream = process.stdout;
try {
  if (isWritableDir(DATA_DIR)) {
    fs.mkdirSync(logDir, { recursive: true });
    accessLogStream = fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' });
    console.log('Logging to /data/logs/app.log');
  } else {
    console.log('No /data mount detected; logging to console only');
  }
} catch (err) {
  console.log('File logging unavailable:', err.message, '— falling back to console.');
  accessLogStream = process.stdout;
}
app.use(morgan('combined', { stream: accessLogStream }));

// ----- security, CORS, parsers
app.use(helmet({ contentSecurityPolicy: false }));
if (ORIGIN_ALLOWLIST.length) {
  app.use(cors({
    origin: (origin, cb) => (!origin || ORIGIN_ALLOWLIST.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS: '+origin)),
    credentials: true
  }));
} else {
  app.use(cors({ origin: true, credentials: true }));
}
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ----- device cookie
const COOKIE_NAME = 'wa_device';
app.use((req, res, next) => {
  let device = req.cookies[COOKIE_NAME];
  if (!device) {
    device = 'd_' + uuidv4();
    const isProd = (process.env.NODE_ENV === 'production');
    res.cookie(COOKIE_NAME, device, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*365*5 });
  }
  req.deviceId = device;
  if (PREVIEW_DEVICE && req.deviceId === PREVIEW_DEVICE) res.setHeader('X-Preview', 'true');
  next();
});

// ----- static assets
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
  setHeaders: (res) => { res.setHeader('Cache-Control','public, max-age=31536000, immutable'); res.setHeader('X-Content-Type-Options','nosniff'); }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ----- simple in-memory rate limiter (soft)
const hits = new Map(); // ip -> { count, ts }
const WINDOW_MS = 60_000, MAX_HITS = 120;
function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count:0, ts: now };
  if (now - rec.ts > WINDOW_MS) { rec.count = 0; rec.ts = now; }
  rec.count++; hits.set(ip, rec);
  return rec.count <= MAX_HITS;
}

// ----- device-scoped paths
const deviceDir = (deviceId) => path.join(DATA_DIR, 'devices', deviceId);
const deviceCardsPath = (deviceId) => path.join(deviceDir(deviceId), 'cards.json');
const deviceMetaPath = (deviceId) => path.join(deviceDir(deviceId), 'device.json');

// ----- upload/inference (photo)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
async function inferFromImage(filePath, opts={}) {
  if (INFER_PROVIDER === 'openai') return (await import('./src/inference/openai.js')).default(filePath, opts);
  return (await import('./src/inference/stub.js')).default(filePath, opts);
}

// ----- funnel events
const EVENTS_PATH = path.join(DATA_DIR, 'analytics', 'events.ndjson');
function logEvent(name, props={}, req) {
  try {
    const row = { ts: new Date().toISOString(), name, deviceId: req?.deviceId || null, props };
    if (isWritableDir(DATA_DIR)) {
      fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
      fs.appendFileSync(EVENTS_PATH, JSON.stringify(row) + '\n');
    } else {
      console.log('event', row);
    }
  } catch {}
}

// ---- AI estimate result logger (exportable)
const ESTIMATES_FILE = path.join(DATA_DIR, 'analytics', 'estimates.ndjson');
function logEstimateRow(row) {
  try {
    const out = {
      ts: new Date().toISOString(),
      deviceId: row.deviceId || null,
      scope: row.scope || null,       // 'site-scope' | 'full-scope' | null
      source: row.source || 'photo',  // 'photo' | 'video'
      cardId: row.cardId || null,
      label: row.label || null,
      aiLow: Number.isFinite(row.aiLow) ? row.aiLow : null,
      aiHigh: Number.isFinite(row.aiHigh) ? row.aiHigh : null,
      notes: row.notes || null,
      userPrice: Number.isFinite(row.userPrice) ? row.userPrice : null,
      transcript: row.transcript || null,
      fields: row.fields || null
    };
    if (isWritableDir(DATA_DIR)) {
      fs.mkdirSync(path.dirname(ESTIMATES_FILE), { recursive: true });
      fs.appendFileSync(ESTIMATES_FILE, JSON.stringify(out) + '\n');
    } else {
      console.log('estimate', out);
    }
  } catch (e) {
    console.log('estimate_log_failed', e.message);
  }
}

// ===================== CAPTURE CONFIG (for designer buttons) =====================
app.get('/api/capture-config', (req, res) => {
  res.json({
    version: 1,
    endpoints: {
      photo: { url: '/api/jobs/upload', method: 'POST', field: 'media', accept: 'image/*' },
      'site-scope': { url: '/api/video/estimate?scope=site-scope', method: 'POST', field: 'media', accept: 'video/*,audio/*' },
      'full-scope': { url: '/api/video/estimate?scope=full-scope', method: 'POST', field: 'media', accept: 'video/*,audio/*' }
    }
  });
});

// ===================== CORE API =====================

// upload + infer (PHOTO)
app.post('/api/jobs/upload', upload.single('media'), async (req, res) => {
  try {
    if (!rateLimit(req.ip || '')) return res.status(429).json({ error:'rate_limited' });
    if (MAINTENANCE) return res.status(503).json({ error:'maintenance', msg:'Uploads temporarily paused; please try again soon.' });

    if (!req.file) return res.status(400).json({ error: 'media file required' });
    if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(415).json({ error: 'unsupported type', allowed: ALLOWED_MIME });

    const ext = mime.extension(req.file.mimetype) || 'bin';
    const cardId = 'c_' + uuidv4();
    const deviceId = req.deviceId;
    const deviceUploadsDir = path.join(DATA_DIR, 'uploads', deviceId);
    fs.mkdirSync(deviceUploadsDir, { recursive: true });
    const absPath = path.join(deviceUploadsDir, `${cardId}.${ext}`);
    fs.writeFileSync(absPath, req.file.buffer);

    const userPrice = req.body.userPrice ? Number(req.body.userPrice) : null;
    const isPreview = PREVIEW_DEVICE && req.deviceId === PREVIEW_DEVICE;
    const infer = await inferFromImage(absPath, { userPrice, preview: isPreview });
    const now = new Date().toISOString();

    let agreementVerdict = null;
    if (Number.isFinite(userPrice)) {
      const { aiLow: low, aiHigh: high } = infer;
      if (userPrice >= low && userPrice <= high) agreementVerdict = 'AGREE';
      else if ((userPrice < low && userPrice >= low*0.9) || (userPrice > high && userPrice <= high*1.1)) agreementVerdict = 'WITHIN';
      else if (userPrice < low) agreementVerdict = 'BELOW';
      else agreementVerdict = 'ABOVE';
    }

    const publicUrl = `/uploads/${deviceId}/${cardId}.${ext}`;
    const card = {
      id: cardId, deviceId, createdAt: now,
      label: infer.label, aiLow: infer.aiLow, aiHigh: infer.aiHigh,
      notes: infer.notes, agreementVerdict,
      media: { url: publicUrl, mimetype: req.file.mimetype, kind: 'image' },
      pro: PAYWALL_DISABLED ? true : false,
      proPreview: !PAYWALL_DISABLED
    };

    const cardsPath = deviceCardsPath(deviceId);
    const cards = readJSON(cardsPath, []); cards.push(card); writeJSON(cardsPath, cards);

    const metaPath = deviceMetaPath(deviceId);
    const meta = readJSON(metaPath, { deviceId, pro:false, uploads:0, subscription: { provider:'paypal', status:'INACTIVE', updatedAt: now } });
    meta.uploads = (meta.uploads || 0) + 1; if (PAYWALL_DISABLED) meta.pro = true; writeJSON(metaPath, meta);

    logEvent('upload_success', { cardId }, req);

    // --- NEW: log estimate
    logEstimateRow({
      deviceId, source: 'photo', scope: null,
      cardId: card.id, label: card.label, aiLow: card.aiLow, aiHigh: card.aiHigh,
      notes: card.notes, userPrice
    });

    if (isPreview) res.setHeader('X-Preview', 'true');
    res.json(card);
  } catch (e) {
    console.error('upload_failed', e);
    logEvent('upload_failed', { reason: e?.message }, req);
    res.status(500).json({ error: 'upload_failed' });
  }
});

// list
app.get('/api/jobs/list', (req, res) => {
  const cards = readJSON(deviceCardsPath(req.deviceId), []).sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
  res.json({ deviceId: req.deviceId, items: cards });
});

// me
app.get('/api/me', (req, res) => {
  const meta = readJSON(
    deviceMetaPath(req.deviceId),
    { deviceId: req.deviceId, pro: false, uploads: 0,
      subscription: { provider: 'paypal', status: 'INACTIVE', updatedAt: new Date().toISOString() } }
  );
  res.json(meta);
});

// paypal verify (flip pro)
app.post('/api/paypal/verify-subscription', express.json(), async (req, res) => {
  try {
    const deviceId = req.deviceId;
    const subscriptionId = req.body?.subscriptionId;
    if (!subscriptionId) return res.status(400).json({ ok:false, error:'missing_subscriptionId' });

    const sub = await getSubscription(subscriptionId);
    if (sub.status !== 'ACTIVE') return res.status(400).json({ ok:false, error:'not_active', status: sub.status });

    const now = new Date().toISOString();
    const metaPath = deviceMetaPath(deviceId);
    const meta = readJSON(metaPath, { deviceId, pro:false, uploads:0, subscription: { provider:'paypal', status:'INACTIVE', updatedAt: now } });
    meta.pro = true;
    meta.subscription = { provider:'paypal', status:'ACTIVE', updatedAt: now, externalId: subscriptionId };
    writeJSON(metaPath, meta);

    const receiptPath = path.join(DATA_DIR, 'payments', 'paypal', `${subscriptionId}.json`);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeJSON(receiptPath, { deviceId, subscriptionId, status:'ACTIVE', at: now });

    logEvent('subscribe_success', { deviceId }, req);
    res.json({ ok:true });
  } catch (e) {
    console.error('verify-subscription error', e);
    logEvent('subscribe_failed', { reason: e?.message }, req);
    res.status(500).json({ ok:false, error:'verify_failed' });
  }
});

// ===================== VIDEO/AUDIO → ESTIMATE =====================

// Accept larger media for video:
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (MAX_UPLOAD_MB * 1024 * 1024) * 3 } // 3x photo size
});

// Unified handler; scope: 'site-scope' | 'full-scope' | undefined
async function handleVideoEstimate(req, res, scope) {
  try {
    if (!rateLimit(req.ip || '')) return res.status(429).json({ error:'rate_limited' });
    if (MAINTENANCE) return res.status(503).json({ error:'maintenance', msg:'Uploads temporarily paused; please try again soon.' });

    if (!req.file) return res.status(400).json({ error: 'media required' });
    const mt = req.file.mimetype || '';
    if (!/^video\/|^audio\//.test(mt)) return res.status(415).json({ error: 'unsupported type (expect audio/* or video/*)' });

    // store original
    const deviceId = req.deviceId;
    const id = 'v_' + uuidv4();
    const ext = (mt.split('/')[1] || 'bin').toLowerCase();
    const dir = path.join(DATA_DIR, 'uploads', deviceId);
    fs.mkdirSync(dir, { recursive: true });
    const absPath = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(absPath, req.file.buffer);

    // 1) transcribe (your module)
    const { text: rawText } = await transcribeMedia(absPath);

    // 1b) optional redact
    const text = rawText
      .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '[PHONE]')
      .replace(/\b\d{1,5}\s+\w+(\s+\w+){0,3}\b/g, '[ADDRESS]');

    // 2) extract fields
    const fields = extractFieldsFromTranscript(text);

    // 3) estimate via existing logic
    const userPrice = fields?.budgetHintUSD ?? null;
    const isPreview = PREVIEW_DEVICE && req.deviceId === PREVIEW_DEVICE;
    const infer = await inferFromImage(absPath, {
      userPrice,
      preview: isPreview,
      transcript: text,
      fields,
      scope
    });

    const now = new Date().toISOString();
    const cardId = 'c_' + uuidv4();
    const publicUrl = `/uploads/${deviceId}/${id}.${ext}`;
    const card = {
      id: cardId,
      deviceId,
      createdAt: now,
      label: infer.label || fields.label || 'Service estimate',
      aiLow: infer.aiLow,
      aiHigh: infer.aiHigh,
      notes: infer.notes || 'Based on walkthrough notes.',
      media: { url: publicUrl, mimetype: mt, kind: 'video' },
      source: { type: 'transcript' }
    };

    // persist like normal cards
    const cardsPath = deviceCardsPath(deviceId);
    const cards = readJSON(cardsPath, []); cards.push(card); writeJSON(cardsPath, cards);

    // --- NEW: log estimate row
    logEstimateRow({
      deviceId, source:'video', scope,
      cardId: card.id, label: card.label, aiLow: card.aiLow, aiHigh: card.aiHigh,
      notes: card.notes, userPrice, transcript: text, fields
    });

    res.json({
      card,
      formData: {
        label: card.label,
        sqft: fields.sqft || null,
        materials: fields.materials || null,
        urgency: fields.urgency || null,
        issues: fields.issues || null,
        budgetHintUSD: fields.budgetHintUSD || null
      }
    });
  } catch (e) {
    console.error('video_estimate_failed', e);
    res.status(500).json({ error: 'video_estimate_failed' });
  }
}

// Single endpoint with scope query (designer-friendly)
app.post('/api/video/estimate', videoUpload.single('media'), async (req, res) => {
  const scope = (req.query.scope === 'full-scope') ? 'full-scope'
              : (req.query.scope === 'site-scope') ? 'site-scope'
              : undefined;
  await handleVideoEstimate(req, res, scope);
});

// Convenience aliases (if designer prefers distinct URLs)
app.post('/api/video/site-scope',  videoUpload.single('media'), (req, res)=> handleVideoEstimate(req, res, 'site-scope'));
app.post('/api/video/full-scope',  videoUpload.single('media'), (req, res)=> handleVideoEstimate(req, res, 'full-scope'));

// ===================== COMMUNITY SUBMISSIONS (auto-approve) =====================
const SUB_DIR = path.join(DATA_DIR, 'submissions');
const GEO_PATH = path.join(DATA_DIR, 'geo', 'index.json');
const ANALYTICS_DIR = path.join(DATA_DIR, 'analytics');

function geoIndexFor(state, city) {
  const geo = readJSON(GEO_PATH, { baseline:1.0, states:{}, metros:{} });
  const key = (city && state) ? (city+','+state) : null;
  return (key && geo.metros[key]) || geo.states[state] || geo.baseline || 1.0;
}
function listSubmissions(filter = {}) {
  const items = [];
  if (fs.existsSync(SUB_DIR)) {
    for (const f of fs.readdirSync(SUB_DIR)) {
      if (!f.endsWith('.json')) continue;
      const sub = readJSON(path.join(SUB_DIR, f), null);
      if (!sub) continue;
      if (filter.status && sub.moderation?.status !== filter.status) continue;
      if (filter.state && sub.geo?.state !== filter.state) continue;
      if (filter.label && sub.label !== filter.label) continue;
      items.push(sub);
    }
  }
  return items.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
}
function rollupAnalytics() {
  const items = listSubmissions({ status:'APPROVED' });
  const byKey = {};
  for (const s of items) {
    const key = `${s.label}::${s.geo?.state || 'NA'}`;
    const idx = geoIndexFor(s.geo?.state, s.geo?.city);
    const normalized = s.chargedPriceUSD / (idx || 1.0);
    if (!byKey[key]) byKey[key] = { count:0, sum:0, min:Infinity, max:0 };
    const b = byKey[key];
    b.count++; b.sum += normalized; b.min = Math.min(b.min, normalized); b.max = Math.max(b.max, normalized);
  }
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  writeJSON(path.join(ANALYTICS_DIR, 'rollup.json'), byKey);
}

app.post('/api/submissions', upload.single('media'), async (req, res) => {
  try {
    if (!req.body.consent) return res.status(400).json({ error:'consent_required' });
    if (!req.file) return res.status(400).json({ error:'media_required' });
    const m = moderateText(String(req.body.description||''));
    if (!m.ok) return res.status(400).json({ error:'moderation_failed', flags:m.flags });

    const state = String(req.body.state||'').toUpperCase();
    const city = req.body.city ? String(req.body.city).trim() : '';
    if (!validateGeo(state, city)) return res.status(400).json({ error:'invalid_geo' });

    const label = String(req.body.label||'').slice(0,64).trim();
    if (!label) return res.status(400).json({ error:'label_required' });
    const charged = Number(req.body.chargedPriceUSD);
    if (!Number.isFinite(charged) || charged <= 0) return res.status(400).json({ error:'invalid_price' });

    if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(415).json({ error:'unsupported_type' });
    const ext = mime.extension(req.file.mimetype) || 'bin';

    const id = 's_' + uuidv4();
    const deviceId = req.deviceId;
    const dir = path.join(DATA_DIR, 'uploads', deviceId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(filePath, req.file.buffer);

    const now = new Date().toISOString();
    const sub = {
      id, deviceId, createdAt: now,
      label, description: String(req.body.description||'').slice(0,500),
      chargedPriceUSD: Math.round(charged),
      geo: { state, city: city || undefined, zip: req.body.zip ? String(req.body.zip).slice(0,10) : undefined },
      media: { url: `/uploads/${deviceId}/${id}.${ext}`, mimetype: req.file.mimetype },
      moderation: { status:'APPROVED', flags: m.flags }
    };
    fs.mkdirSync(SUB_DIR, { recursive: true });
    writeJSON(path.join(SUB_DIR, id + '.json'), sub);
    rollupAnalytics();

    res.status(202).json({ id, status: 'APPROVED' });
  } catch (e) {
    console.error('submission error', e);
    res.status(500).json({ error:'submission_failed' });
  }
});

app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const { status, state, label } = req.query;
  const items = listSubmissions({ status: status || 'APPROVED', state, label });
  res.json({ items });
});

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const roll = readJSON(path.join(ANALYTICS_DIR, 'rollup.json'), {});
  if ((req.query.format||'').toLowerCase() === 'csv') {
    let csv = 'label_state,count,sum,min,max\n';
    for (const [k,v] of Object.entries(roll)) csv += `${k},${v.count},${v.sum},${v.min},${v.max}\n`;
    res.setHeader('Content-Type', 'text/csv');
    return res.send(csv);
  }
  res.json(roll);
});

// ---- Admin exports: AI estimates
app.get('/api/admin/estimates.json', requireAdmin, (req, res) => {
  const items = [];
  try {
    if (fs.existsSync(ESTIMATES_FILE)) {
      const lines = fs.readFileSync(ESTIMATES_FILE, 'utf8').trim().split(/\n+/);
      for (const line of lines) { try { items.push(JSON.parse(line)); } catch {} }
    }
  } catch {}
  res.json({ items });
});

app.get('/api/admin/estimates.csv', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="estimates.csv"');
  const headers = ['ts','deviceId','scope','source','cardId','label','aiLow','aiHigh','userPrice','notes'];
  let csv = headers.join(',') + '\n';
  try {
    if (fs.existsSync(ESTIMATES_FILE)) {
      const lines = fs.readFileSync(ESTIMATES_FILE, 'utf8').trim().split(/\n+/);
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          const row = headers.map(h => {
            const v = j[h] == null ? '' : String(j[h]).replace(/"/g, '""');
            return /[",\n]/.test(v) ? `"${v}"` : v;
          }).join(',');
          csv += row + '\n';
        } catch {}
      }
    }
  } catch {}
  res.send(csv);
});

// ===================== ADMIN SUMMARY PAGE =====================
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const base = path.join(DATA_DIR, 'devices');
  const devices = [];
  if (fs.existsSync(base)) {
    for (const dev of fs.readdirSync(base)) {
      const devDir = path.join(base, dev);
      if (!fs.statSync(devDir).isDirectory()) continue;
      const cards = readJSON(path.join(devDir, 'cards.json'), []);
      const meta = readJSON(path.join(devDir, 'device.json'), { deviceId: dev, pro:false, uploads: 0, subscription: { status: 'INACTIVE' }});
      devices.push({
        deviceId: dev,
        pro: !!meta.pro,
        uploads: meta.uploads || cards.length,
        subscription: meta.subscription || { status: 'INACTIVE' },
        cards: cards.length,
        last: cards.length ? cards[cards.length - 1].createdAt : null
      });
    }
  }
  const totalCards = devices.reduce((a,b)=>a+b.cards,0);
  const proDevices = devices.filter(d=>d.pro).length;
  res.json({ devicesCount: devices.length, proDevices, totalCards, devices });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Cardinal GaragePro</title>
<link rel="stylesheet" href="/styles.css"></head>
<body class="container">
  <h1>Admin Dashboard</h1>
  <p class="notes">Read-only diagnostic (data diode). Use token via ?token=... or X-Admin-Token header.</p>
  <div id="summary" class="uploader"></div>
  <script>
    async function load() {
      const res = await fetch('/api/admin/summary' + (location.search || ''));
      if (!res.ok) { document.getElementById('summary').textContent = 'Unauthorized'; return; }
      const j = await res.json();
      const wrap = document.getElementById('summary');
      wrap.innerHTML = '<div><b>Devices:</b> '+j.devicesCount+' · <b>Pro:</b> '+j.proDevices+' · <b>Cards:</b> '+j.totalCards+'</div>';
      const table = document.createElement('table');
      table.style.width='100%'; table.style.marginTop='12px'; table.style.borderCollapse='collapse';
      table.innerHTML = '<thead><tr><th align="left">Device</th><th>Pro</th><th>Cards</th><th>Uploads</th><th>Sub</th><th align="right">Last</th></tr></thead><tbody></tbody>';
      const tb = table.querySelector('tbody');
      j.devices.sort((a,b)=> (b.last||'').localeCompare(a.last||''));
      for (const d of j.devices) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+d.deviceId+'</td><td style="text-align:center">'+(d.pro?'✓':'')+'</td><td style="text-align:center">'+d.cards+'</td><td style="text-align:center">'+d.uploads+'</td><td style="text-align:center">'+(d.subscription && d.subscription.status || 'INACTIVE')+'</td><td style="text-align:right">'+(d.last||'')+'</td>';
        tb.appendChild(tr);
      }
      wrap.appendChild(table);
    }
    load();
  </script>
</body></html>`);
});

// ===================== HEALTH & FALLBACKS =====================
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/readyz', (req, res) => res.status(isWritableDir(DATA_DIR) ? 200 : 503).json({ dataDir: DATA_DIR, writable: isWritableDir(DATA_DIR) }));

// multer errors
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error:'file_too_large' });
  if (err && err.code?.startsWith('LIMIT_')) return res.status(400).json({ error:'upload_rejected', code: err.code });
  return next(err);
});

// final error guard
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error:'server_error' });
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// start & graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT} (DATA_DIR=${DATA_DIR})`);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server...');
  server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
});
