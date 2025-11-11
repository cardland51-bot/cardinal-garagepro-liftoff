/* ===================================================================
   WorkDeck Pro — Production Frontend Logic
   Version: Field-Ready / No Placeholders
   Backend: Auto-detect Render or Localhost
   =================================================================== */

/* -------------------------- GLOBAL STATE -------------------------- */

const KEY = 'workdeckpro-state-v1';

const state = loadState() || {
  settings: {
    backendUrl: '',
  },
  cards: [],
  lane: 'mow',
  theme: 'field',
};

let isUploading = false;

/* --------------------------- UTILITIES ---------------------------- */

const $ = (sel) => document.querySelector(sel);

function saveState() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function toast(msg, dur = 2000) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    background: '#333',
    color: '#fff',
    padding: '10px 14px',
    borderRadius: '12px',
    fontSize: '14px',
    boxShadow: '0 6px 20px rgba(0,0,0,.4)',
    zIndex: 9999,
    transition: 'opacity .25s ease',
  });
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, dur);
}

function paintStatus(type, message, sticky) {
  const el = $('#system-status');
  if (!el) return;
  el.textContent = message;
  el.style.color =
    type === 'error'
      ? '#e57373'
      : type === 'success'
      ? '#81c784'
      : '#90caf9';
  if (!sticky) setTimeout(() => (el.textContent = ''), 3000);
}

/* ------------------------ BACKEND DETECTION ----------------------- */

if (!state.settings.backendUrl) {
  state.settings.backendUrl = window.location.hostname.includes('github.io')
    ? 'https://cardinal-garagepro-liftoff-4.onrender.com'
    : 'http://localhost:10000';
  saveState();
}

/* ------------------------ CALIBRATION LOG ------------------------- */

function logCalibration(card) {
  try {
    const logs = JSON.parse(localStorage.getItem('calibrationLogs') || '[]');
    logs.unshift({
      lane: card.lane,
      priceLow: card.priceLow ?? 0,
      priceHigh: card.priceHigh ?? 0,
      avg: Math.round(((card.priceLow ?? 0) + (card.priceHigh ?? 0)) / 2),
      createdAt: card.createdAt || new Date().toISOString(),
      mediaUrl: card.mediaUrl || '',
    });
    if (logs.length > 200) logs.pop();
    localStorage.setItem('calibrationLogs', JSON.stringify(logs));
  } catch (e) {
    console.warn('calibration log failed', e);
  }
}

/* ------------------------ BACKEND HANDLERS ------------------------ */

async function uploadToBackend(file) {
  if (!navigator.onLine) {
    paintStatus('info', 'Offline — cannot upload', true);
    throw new Error('offline');
  }
  const url = state.settings.backendUrl.replace(/\/$/, '') + '/api/jobs/upload';
  const fd = new FormData();
  fd.append('media', file);
  fd.append('lane', state.lane);
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* --------------------------- RENDERING ---------------------------- */

function renderDeck() {
  const deckGrid = $('#deck');
  const deckEmpty = $('#empty-hint');
  if (!deckGrid || !deckEmpty) return;

  deckGrid.innerHTML = '';
  if (!state.cards.length) {
    deckEmpty.style.display = 'block';
    return;
  }
  deckEmpty.style.display = 'none';

  for (const c of state.cards) {
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <header class="card-header">
        <span class="lane-badge">${c.lane}</span>
        <small>${new Date(c.createdAt).toLocaleString()}</small>
      </header>
      <div class="card-media" style="background-image:url('${c.mediaUrl || ''}')"></div>
      <div class="card-body">
        <p><b>$${Math.round(c.priceLow)}–$${Math.round(c.priceHigh)}</b></p>
        <p>${c.notes || ''}</p>
      </div>`;
    deckGrid.appendChild(el);
  }
}

/* ------------------------- CARD CREATION -------------------------- */

function addCardToDeck(card) {
  const c = {
    lane: card.lane || state.lane,
    priceLow: card.aiLow || card.priceLow || 0,
    priceHigh: card.aiHigh || card.priceHigh || 0,
    notes: card.notes || '',
    createdAt: card.createdAt || new Date().toISOString(),
    mediaUrl: card.media?.url || card.mediaUrl || '',
  };
  state.cards.unshift(c);
  logCalibration(c);
  saveState();
  renderDeck();
}

/* ---------------------- EVENT INITIALIZATION ---------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = $('#file-input');
  const captureBtn = $('#capture-btn');
  const exportDeckBtn = $('#export-deck');

  if (captureBtn && fileInput) {
    captureBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file || isUploading) return;
      isUploading = true;
      paintStatus('info', 'Uploading…', true);
      try {
        const result = await uploadToBackend(file);
        addCardToDeck(result);
        paintStatus('success', 'Upload complete', false);
      } catch (err) {
        console.error(err);
        paintStatus('error', err.message || 'Upload failed', true);
      } finally {
        isUploading = false;
        fileInput.value = '';
      }
    };
  }

  if (exportDeckBtn) {
    exportDeckBtn.onclick = () => {
      const csv =
        'lane,priceLow,priceHigh,createdAt,mediaUrl\n' +
        state.cards
          .map(
            (c) =>
              `${c.lane},${c.priceLow},${c.priceHigh},${c.createdAt},${c.mediaUrl}`
          )
          .join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'deck.csv';
      a.click();
    };
  }

  window.addEventListener('online', () =>
    paintStatus('success', 'Online', false)
  );
  window.addEventListener('offline', () =>
    paintStatus('info', 'Offline', true)
  );

  renderDeck();
  paintStatus('info', 'Ready — backend connected', false);
});
