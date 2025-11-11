/* ===================================================================
   WorkDeck Pro — Production Frontend Logic
   Version: Stable Release
   Scope: Field-ready UI for photo capture, deck management, and calibration logging
   Author: Cardinal GaragePro Liftoff Build
   =================================================================== */

/* -------------------------- GLOBAL STATE -------------------------- */

const KEY = 'workdeckpro-state-v1';

const state = loadState() || {
  settings: {
    laborRate: 45,
    materialsMarkup: 20,
    regionFactor: 1.0,
    backendUrl: '',
  },
  cards: [],
  lane: 'mow',
  theme: 'field',
};

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
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    background: 'var(--panel-2)',
    color: 'var(--text)',
    padding: '10px 14px',
    borderRadius: '12px',
    border: '1px solid rgba(255,255,255,0.08)',
    boxShadow: '0 10px 30px rgba(0,0,0,.5)',
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
  const systemStatus = $('#system-status');
  if (!systemStatus) return;
  systemStatus.innerHTML = '';

  const span = document.createElement('span');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.backgroundColor =
    type === 'success'
      ? 'var(--success)'
      : type === 'error'
      ? 'var(--error)'
      : type === 'info'
      ? 'var(--info)'
      : 'var(--accent)';

  span.appendChild(dot);
  span.appendChild(document.createTextNode(message));
  systemStatus.appendChild(span);

  if (!sticky) {
    setTimeout(() => {
      if (systemStatus.contains(span)) {
        span.style.opacity = '0';
        setTimeout(() => span.remove(), 160);
      }
    }, 2600);
  }
}

/* ------------------------ BACKEND URL SETUP ----------------------- */

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

/* ---------------------- BAND PRECISION HOOK ----------------------- */

function adjustBandPrecision(card) {
  return card;
}

/* -------------------------- THEME LOGIC --------------------------- */

function applyTheme() {
  document.documentElement.classList.remove('theme-field', 'theme-steel', 'theme-sage');
  document.documentElement.classList.add(`theme-${state.theme}`);
}

/* ------------------------ BACKEND HANDLERS ------------------------ */

async function uploadToBackend(file) {
  if (!navigator.onLine) {
    toast('Offline — upload disabled');
    throw new Error('offline');
  }
  if (!state.settings.backendUrl) {
    toast('No backend configured');
    throw new Error('no_backend');
  }
  const endpoint = state.settings.backendUrl.replace(/\/$/, '') + '/api/jobs/upload';
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
  if (!navigator.onLine) throw new Error('offline');
  const endpoint = state.settings.backendUrl.replace(/\/$/, '') + '/api/jobs/list';
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error('sync_failed');
  const data = await res.json();
  return data.items || [];
}

/* --------------------------- RENDERING ---------------------------- */

function renderDeck() {
  const deckGrid = $('#deck');
  const deckEmpty = $('#empty-hint');
  if (!deckGrid || !deckEmpty) return;

  deckGrid.innerHTML = '';
  const cards = state.cards.map(adjustBandPrecision);
  if (!cards.length) {
    deckEmpty.style.display = 'block';
    return;
  }
  deckEmpty.style.display = 'none';

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
    note: card.notes || '',
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
  const themeSel = $('#theme-select');
  const openSettings = $('#open-settings');
  const saveSettings = $('#save-settings');
  const exportDeckBtn = $('#export-deck');
  const captureBtn = $('#capture-btn');
  const fileInput = $('#file-input');
  const spawnDemo = $('#spawn-demo');

  // theme
// theme (safe guard)
if (themeSel) {
  themeSel.value = state.theme;
  applyTheme();
  themeSel.onchange = () => {
    state.theme = themeSel.value;
    applyTheme();
    saveState();
  };
} else {
  applyTheme(); // ensure default theme still applies
}

  // settings dialog
  const settingsDialog = $('#settings-dialog');
  const laborRate = $('#laborRate');
  const materialsMarkup = $('#materialsMarkup');
  const regionFactor = $('#regionFactor');
  const backendUrl = $('#backendUrl');

  openSettings.onclick = () => {
    laborRate.value = state.settings.laborRate;
    materialsMarkup.value = state.settings.materialsMarkup;
    regionFactor.value = state.settings.regionFactor;
    backendUrl.value = state.settings.backendUrl;
    settingsDialog.showModal();
  };

  saveSettings.onclick = (e) => {
    e.preventDefault();
    state.settings.laborRate = Number(laborRate.value) || 0;
    state.settings.materialsMarkup = Number(materialsMarkup.value) || 0;
    state.settings.regionFactor = Number(regionFactor.value) || 1;
    state.settings.backendUrl = backendUrl.value.trim();
    saveState();
    settingsDialog.close();
    toast('Settings saved.');
  };

  // export deck
  exportDeckBtn.onclick = () => {
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

  // capture/upload
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

  // demo cards
  spawnDemo.onclick = () => {
    const sample = [
      { lane: 'mow', priceLow: 50, priceHigh: 70, note: 'Demo mow', createdAt: new Date().toISOString(), mediaUrl: 'https://picsum.photos/seed/mow/400/250' },
      { lane: 'wash', priceLow: 120, priceHigh: 160, note: 'Demo wash', createdAt: new Date().toISOString(), mediaUrl: 'https://picsum.photos/seed/wash/400/250' },
    ];
    state.cards.unshift(...sample);
    saveState();
    renderDeck();
    toast('Demo cards added.');
  };

  // offline indicators
  window.addEventListener('online', () => paintStatus('success', 'Back online', false));
  window.addEventListener('offline', () => paintStatus('info', 'Offline mode', true));

  // first render
  renderDeck();
  paintStatus('info', 'Ready — connected to backend.', false);
});
