/* ===================================================================
 /* ============================================================
   WorkDeck Pro — Production App.js
   Stable Field Console / Version 1.0.0
   ============================================================ */

/* -------------------------- GLOBAL STATE -------------------------- */
const KEY = 'workdeckpro-state-v1';

const state = loadState() || {
  settings: {
    laborRate: 45,
    materialsMarkup: 20,
    regionFactor: 1.0,
    backendUrl: 'https://cardinal-garagepro-liftoff-4.onrender.com'
  },
  cards: [],
  lane: 'mow',
  theme: 'field',
};

saveState();

let isUploading = false;

/* --------------------------- UTILITIES ---------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

function toast(msg, dur = 2200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, dur);
}

function paintStatus(type, message, sticky) {
  const el = $('#system-status');
  if (!el) return;
  el.innerHTML = `<span class="dot" style="background:${
    type === 'success'
      ? 'var(--success)'
      : type === 'error'
      ? 'var(--error)'
      : 'var(--info)'
  }"></span> ${message}`;
  if (!sticky) setTimeout(() => (el.innerHTML = ''), 2600);
}

/* ------------------------ CALIBRATION LOG ------------------------- */
function logCalibration(card) {
  try {
    const logs = JSON.parse(localStorage.getItem('calibrationLogs') || '[]');
    logs.unshift({
      lane: card.lane,
      priceLow: card.priceLow,
      priceHigh: card.priceHigh,
      avg: Math.round((card.priceLow + card.priceHigh) / 2),
      createdAt: card.createdAt || new Date().toISOString(),
      mediaUrl: card.mediaUrl || ''
    });
    if (logs.length > 200) logs.pop();
    localStorage.setItem('calibrationLogs', JSON.stringify(logs));
  } catch (e) {
    console.warn('logCalibration failed', e);
  }
}

/* ---------------------- BAND PRECISION HOOK ----------------------- */
function adjustBandPrecision(card) {
  return card;
}

/* ------------------------ BACKEND HANDLERS ------------------------ */
async function uploadToBackend(file) {
  if (!navigator.onLine) {
    paintStatus('error', 'Offline — upload disabled', true);
    throw new Error('offline');
  }

  const url = state.settings.backendUrl;
  if (!url) {
    paintStatus('error', 'No backend configured', true);
    throw new Error('no_backend');
  }

  const endpoint = url.replace(/\/$/, '') + '/api/jobs/upload';
  const fd = new FormData();
  fd.append('media', file);
  fd.append('lane', state.lane);

  const res = await fetch(endpoint, { method: 'POST', body: fd });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'upload_failed');
  }
  return res.json();
}

async function fetchDeckFromBackend() {
  const endpoint =
    state.settings.backendUrl.replace(/\/$/, '') + '/api/jobs/list';
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error('sync_failed');
  const data = await res.json();
  return data.items || [];
}

/* --------------------------- RENDERING ---------------------------- */
function renderDeck() {
  const deckGrid = $('#deck');
  const hint = $('#empty-hint');
  if (!deckGrid || !hint) return;

  deckGrid.innerHTML = '';
  let cards = state.cards.map(adjustBandPrecision);
  if (!cards.length) {
    hint.style.display = 'block';
    return;
  }
  hint.style.display = 'none';

  for (const c of cards) {
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <header class="card-header">
        <span class="lane-badge">${c.lane}</span>
        <small>${new Date(c.createdAt).toLocaleString()}</small>
      </header>
      <div class="card-media" style="background-image:url('${c.mediaUrl || ''}')"></div>
      <div class="card-body">
        <p>Band<br><b>$${Math.round(c.priceLow)}–$${Math.round(c.priceHigh)}</b></p>
        <p>Notes<br><b>${c.note || ''}</b></p>
      </div>
    `;
    deckGrid.appendChild(el);
  }
}

/* ------------------------- CARD CREATION -------------------------- */
function addCardToDeck(card) {
  const c = {
    lane: card.lane || state.lane,
    priceLow: card.low || card.priceLow || 0,
    priceHigh: card.high || card.priceHigh || 0,
    note: card.note || '',
    createdAt: card.createdAt || new Date().toISOString(),
    mediaUrl: card.media?.url || card.mediaUrl || ''
  };
  state.cards.unshift(c);
  logCalibration(c);
  saveState();
  renderDeck();
}

/* ---------------------- EVENT INITIALIZATION ---------------------- */
document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = $('#capture-btn');
  const fileInput = $('#file-input');
  const exportDeck = $('#export-deck');

  if (exportDeck) {
    exportDeck.onclick = () => {
      const csv =
        'lane,priceLow,priceHigh,note,createdAt,mediaUrl\n' +
        state.cards
          .map(
            (c) =>
              `${c.lane},${c.priceLow},${c.priceHigh},"${(c.note || '').replace(/"/g, '""')}",${c.createdAt},${c.mediaUrl}`
          )
          .join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'deck.csv';
      a.click();
    };
  }

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
        paintStatus('success', 'Card created successfully.', false);
      } catch (err) {
        console.error(err);
        paintStatus('error', err.message || 'Upload failed', true);
      } finally {
        isUploading = false;
        fileInput.value = '';
      }
    };
  }

  window.addEventListener('online', () =>
    paintStatus('success', 'Back online', false)
  );
  window.addEventListener('offline', () =>
    paintStatus('info', 'Offline mode', true)
  );

  renderDeck();
  paintStatus('info', 'Ready for capture.', false);
});

