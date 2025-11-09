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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGIN_ALLOWLIST = (process.env.ORIGIN_ALLOWLIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '7', 10);
const ALLOWED_MIME = (process.env.ALLOWED_MIME || 'image/jpeg,image/png,image/webp').split(',').map(s=>s.trim());
const INFER_PROVIDER = process.env.INFER_PROVIDER || 'stub';

['', '/uploads', '/devices', '/payments', '/logs', '/submissions', '/analytics', '/geo'].forEach(d => {
  const p = path.join(DATA_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const logStream = fs.createWriteStream(path.join(DATA_DIR, 'logs', 'app.log'), { flags: 'a' });
app.use(morgan('combined', { stream: logStream }));
app.use(morgan('dev'));

app.use(helmet({ contentSecurityPolicy: false }));

if (ORIGIN_ALLOWLIST.length) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ORIGIN_ALLOWLIST.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS: ' + origin));
    },
    credentials: true
  }));
} else {
  app.use(cors({ credentials: true, origin: true }));
}

app.use(express.json());
app.use(cookieParser());

const COOKIE_NAME = 'wa_device';
app.use((req, res, next) => {
  let device = req.cookies[COOKIE_NAME];
  if (!device) {
    device = 'd_' + uuidv4();
    const isProd = (process.env.NODE_ENV === 'production');
    res.cookie(COOKIE_NAME, device, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5
    });
  }
  req.deviceId = device;
  next();
});

app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).send('unauthorized');
  next();
}


const deviceDir = (deviceId) => path.join(DATA_DIR, 'devices', deviceId);
const deviceCardsPath = (deviceId) => path.join(deviceDir(deviceId), 'cards.json');
const deviceMetaPath = (deviceId) => path.join(deviceDir(deviceId), 'device.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

async function inferFromImage(filePath, opts={}) {
  if (INFER_PROVIDER === 'openai') {
    return await import('./src/inference/openai.js').then(m => m.default(filePath, opts));
  }
  return await import('./src/inference/stub.js').then(m => m.default(filePath, opts));
}

app.post('/api/jobs/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'media file required' });
    const mimetype = req.file.mimetype;
    if (!ALLOWED_MIME.includes(mimetype)) {
      return res.status(415).json({ error: 'unsupported type', allowed: ALLOWED_MIME });
    }
    const ext = mime.extension(mimetype) || 'bin';
    const cardId = 'c_' + uuidv4();
    const deviceId = req.deviceId;
    const deviceUploadsDir = path.join(DATA_DIR, 'uploads', deviceId);
    fs.mkdirSync(deviceUploadsDir, { recursive: true });
    const filePath = path.join(deviceUploadsDir, `${cardId}.${ext}`);
    fs.writeFileSync(filePath, req.file.buffer);

    const userPrice = req.body.userPrice ? Number(req.body.userPrice) : null;

    const infer = await inferFromImage(filePath, { userPrice });
    const now = new Date().toISOString();

    let agreementVerdict = null;
    if (userPrice != null && Number.isFinite(userPrice)) {
      const low = infer.aiLow, high = infer.aiHigh;
      if (userPrice >= low && userPrice <= high) agreementVerdict = 'AGREE';
      else if ((userPrice < low && userPrice >= low * 0.9) || (userPrice > high && userPrice <= high * 1.1)) agreementVerdict = 'WITHIN';
      else if (userPrice < low) agreementVerdict = 'BELOW';
      else agreementVerdict = 'ABOVE';
    }

    const publicUrl = `/uploads/${deviceId}/${cardId}.${ext}`;
    const card = {
      id: cardId,
      deviceId,
      createdAt: now,
      label: infer.label,
      aiLow: infer.aiLow,
      aiHigh: infer.aiHigh,
      notes: infer.notes,
      agreementVerdict,
      media: { url: publicUrl, mimetype },
      pro: false,
      proPreview: true
    };

    const cardsPath = deviceCardsPath(deviceId);
    const cards = readJSON(cardsPath, []);
    cards.push(card);
    writeJSON(cardsPath, cards);

    const metaPath = deviceMetaPath(deviceId);
    const meta = readJSON(metaPath, { deviceId, pro: false, uploads: 0, subscription: { provider: 'paypal', status: 'INACTIVE', updatedAt: now } });
    meta.uploads = (meta.uploads || 0) + 1;
    writeJSON(metaPath, meta);

    res.json(card);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'upload_failed' });
  }
});

app.get('/api/jobs/list', (req, res) => {
  const cards = readJSON(deviceCardsPath(req.deviceId), []).sort((a,b)=> (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ deviceId: req.deviceId, items: cards });
});

app.get('/api/me', (req, res) => {
  const meta = readJSON(deviceMetaPath(req.deviceId), { deviceId: req.deviceId, pro: false, uploads: 0, subscription: { provider: 'paypal', status: 'INACTIVE', updatedAt: new Date().toISOString() } });
app.post('/api/paypal/verify-subscription', express.json(), async (req, res) => {
  try {
    const deviceId = req.deviceId; // trust cookie
    const subscriptionId = (req.body && req.body.subscriptionId);
    if (!subscriptionId) return res.status(400).json({ ok:false, error:'missing_subscriptionId' });

    const sub = await getSubscription(subscriptionId);
    const isActive = sub.status === 'ACTIVE';
    if (!isActive) return res.status(400).json({ ok:false, error:'not_active', status: sub.status });

    const now = new Date().toISOString();
    const metaPath = deviceMetaPath(deviceId);
    const meta = readJSON(metaPath, { deviceId, pro:false, uploads:0, subscription: { provider:'paypal', status:'INACTIVE', updatedAt: now } });
    meta.pro = true;
    meta.subscription = { provider:'paypal', status:'ACTIVE', updatedAt: now, externalId: subscriptionId };
    writeJSON(metaPath, meta);

    // receipt
    const receiptPath = path.join(DATA_DIR, 'payments', 'paypal', `${subscriptionId}.json`);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeJSON(receiptPath, { deviceId, subscriptionId, status:'ACTIVE', at: now });

    res.json({ ok:true });
  } catch (e) {
    console.error('verify-subscription error', e);
    res.status(500).json({ ok:false, error:'verify_failed' });
  }
});

  res.json(meta);
});

app.post('/api/cards/:id/upgrade', (req, res) => {
  const mode = (req.body && req.body.mode === 'subscription') ? 'subscription' : 'per_card';
  const checkoutUrl = `/pro/checkout.html?mode=${mode}&card=${encodeURIComponent(req.params.id)}`;
  res.json({ checkoutUrl });
});

app.post('/api/payments/webhook', express.json({ type: '*/*' }), (req, res) => {
  const event = req.body;
  try {
    const { deviceId, cardId, mode } = event.data || {};
    if (!deviceId) throw new Error('no deviceId');
    const metaPath = deviceMetaPath(deviceId);
    const meta = readJSON(metaPath, { deviceId, pro: false, uploads: 0, subscription: { provider: 'paypal', status: 'INACTIVE', updatedAt: new Date().toISOString() } });
    if (mode === 'subscription') {
      meta.pro = true;
      meta.subscription = { provider: 'paypal', status: 'ACTIVE', updatedAt: new Date().toISOString() };
      writeJSON(metaPath, meta);
    } else if (mode === 'per_card' && cardId) {
      const cardsPath = deviceCardsPath(deviceId);
      const cards = readJSON(cardsPath, []);
      const idx = cards.findIndex(c => c.id === cardId);
      if (idx >= 0) {
        cards[idx].pro = true;
        cards[idx].proPreview = false;
        writeJSON(cardsPath, cards);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(400).json({ error: 'bad_event' });
  }
});

app.delete('/api/account/delete', (req, res) => {
  const dir = deviceDir(req.deviceId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const up = path.join(DATA_DIR, 'uploads', req.deviceId);
    if (fs.existsSync(up)) fs.rmSync(up, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'delete_failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT} (DATA_DIR=${DATA_DIR})`);
});


/**
 * Admin summary (read-only): requires ADMIN_TOKEN via X-Admin-Token header or ?token=
 * Scans device directories and aggregates counts. This is a one-way diagnostic "diode" view (no mutations).
 */
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

// simple admin page
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


// ---------- Submissions & Analytics ----------
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

    const mimetype = req.file.mimetype;
    const ALLOWED_MIME = (process.env.ALLOWED_MIME || 'image/jpeg,image/png,image/webp').split(',').map(s=>s.trim());
    if (!ALLOWED_MIME.includes(mimetype)) return res.status(415).json({ error:'unsupported_type' });
    const ext = mime.extension(mimetype) || 'bin';

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
      media: { url: `/uploads/${deviceId}/${id}.${ext}`, mimetype },
      moderation: { status:'PENDING', flags: m.flags }
    };
    fs.mkdirSync(SUB_DIR, { recursive: true });
    writeJSON(path.join(SUB_DIR, id + '.json'), sub);

    res.status(202).json({ id, status: 'PENDING' });
  } catch (e) {
    console.error('submission error', e);
    res.status(500).json({ error:'submission_failed' });
  }
});

app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const { status, state, label } = req.query;
  const items = listSubmissions({ status: status || 'PENDING', state, label });
  res.json({ items });
});

app.post('/api/admin/submissions/:id/approve', requireAdmin, (req, res) => {
  const p = path.join(SUB_DIR, req.params.id + '.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error:'not_found' });
  const sub = readJSON(p, null); if (!sub) return res.status(500).json({ error:'corrupt' });
  sub.moderation = { status:'APPROVED', flags: sub.moderation?.flags || [] };
  writeJSON(p, sub);
  rollupAnalytics();
  res.json({ ok:true });
});

app.post('/api/admin/submissions/:id/reject', requireAdmin, (req, res) => {
  const p = path.join(SUB_DIR, req.params.id + '.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error:'not_found' });
  const sub = readJSON(p, null); if (!sub) return res.status(500).json({ error:'corrupt' });
  sub.moderation = { status:'REJECTED', flags: sub.moderation?.flags || [], reason: req.body?.reason || 'manual' };
  writeJSON(p, sub);
  res.json({ ok:true });
});

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const roll = readJSON(path.join(ANALYTICS_DIR, 'rollup.json'), {});
  if ((req.query.format||'').toLowerCase() === 'csv') {
    let csv = 'label_state,count,sum,min,max\n';
    for (const [k,v] of Object.entries(roll)) {
      csv += `${k},${v.count},${v.sum},${v.min},${v.max}\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    return res.send(csv);
  }
  res.json(roll);
});
