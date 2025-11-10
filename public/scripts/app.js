// =========
// WorkAI Deck Frontend Logic
// Path: /public/scripts/app.js
// =========

// Integration points (backend endpoints)
// Adjust ONLY if your backend routes differ.
const API_UPLOAD = '/api/jobs/upload';
const API_LIST = '/api/jobs/list';

const laneRow = document.getElementById('lane-row');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const analyzeBtn = document.getElementById('analyze-btn');
const clearLatestBtn = document.getElementById('clear-latest-btn');
const systemStatus = document.getElementById('system-status');
const deckGrid = document.getElementById('deck-grid');
const deckEmpty = document.getElementById('deck-empty');
const laneFilter = document.getElementById('lane-filter');
const sortOrder = document.getElementById('sort-order');
const reloadDeckBtn = document.getElementById('reload-deck-btn');
const tooltip = document.getElementById('tooltip');

let activeLane = 'mow';
let deck = [];

// Lane selection
laneRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.lane-pill');
  if (!btn) return;
  [...laneRow.querySelectorAll('.lane-pill')].forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  activeLane = btn.dataset.lane;
});

// Upload interactions
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('is-dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('is-dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('is-dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    fileInput.files = e.dataTransfer.files;
  }
});

// Analyze & build card
analyzeBtn.addEventListener('click', async () => {
  if (!fileInput.files || !fileInput.files[0]) {
    paintStatus('error', 'Load a job photo first. One shot, clear and honest.', true);
    return;
  }

  setLoading(true);

  try {
    const fd = new FormData();
    fd.append('media', fileInput.files[0]);
    fd.append('lane', activeLane);

    const res = await fetch(API_UPLOAD, {
      method: 'POST',
      body: fd
    });

    if (!res.ok) {
      const msg = await safeErrorMessage(res);
      throw new Error(msg || 'Unexpected response from pricing engine.');
    }

    const data = await res.json();
    // Expected backend response:
    // {
    //   id: string,
    //   lane: 'mow' | 'wash' | 'junk' | 'handyman',
    //   low: number,
    //   high: number,
    //   note: string,
    //   createdAt: string,
    //   thumbUrl?: string
    // }

    const card = normalizeCard(data);
    deck.unshift(card);
    renderDeck();
    paintStatus('success', 'Card created. Range logged to your deck.', false);
    fileInput.value = '';
  } catch (err) {
    console.error(err);
    paintStatus('error', err.message || 'Engine offline. Check backend or network.', true);
  } finally {
    setLoading(false);
  }
});

// Clear last card
clearLatestBtn.addEventListener('click', () => {
  if (!deck.length) return;
  deck.shift();
  renderDeck();
  paintStatus('info', 'Last card cleared. Remaining deck is untouched.', false);
});

// Filter & sort
laneFilter.addEventListener('change', renderDeck);
sortOrder.addEventListener('change', renderDeck);

// Reload deck from backend, if available
reloadDeckBtn.addEventListener('click', async () => {
  setLoading(true);
  try {
    const res = await fetch(API_LIST, { method: 'GET' });
    if (!res.ok) {
      throw new Error('Could not sync deck from backend.');
    }
    const list = await res.json();
    deck = Array.isArray(list) ? list.map(normalizeCard) : [];
    renderDeck();
    paintStatus('success', 'Deck synced from server.', false);
  } catch (err) {
    console.warn(err);
    paintStatus('info', 'Running local-only deck. Backend sync not required to operate.', false);
  } finally {
    setLoading(false);
  }
});

// Status helpers

function paintStatus(type, message, sticky) {
  systemStatus.innerHTML = '';
  if (!message) return;

  const span = document.createElement('span');
  const dot = document.createElement('span');
  dot.className = 'dot';

  switch (type) {
    case 'success':
      dot.style.backgroundColor = 'var(--success)';
      break;
    case 'error':
      dot.style.backgroundColor = 'var(--error)';
      break;
    case 'info':
      dot.style.backgroundColor = 'var(--info)';
      break;
    default:
      dot.style.backgroundColor = 'var(--accent)';
  }

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

function setLoading(isLoading) {
  analyzeBtn.disabled = isLoading;
  reloadDeckBtn.disabled = isLoading;
  clearLatestBtn.disabled = isLoading;
  analyzeBtn.textContent = isLoading ? 'Analyzing…' : 'Analyze & build card';

  if (isLoading) {
    paintStatus('info', 'Reading the job. No guessing.', true);
  }
}

// Normalize backend data

function normalizeCard(raw) {
  const lane = raw.lane || activeLane || 'mow';
  const low = Number(raw.low) || 40;
  const high = Number(raw.high) || Math.max(low + 10, low * 1.35);
  const now = raw.createdAt ? new Date(raw.createdAt) : new Date();
  const id = raw.id || `JOB-${now.getTime().toString(36).toUpperCase()}`;
  const safeNote = raw.note || defaultNoteForLane(lane);

  return {
    id,
    lane,
    low,
    high,
    note: safeNote,
    createdAt: now.toISOString(),
    thumbUrl: raw.thumbUrl || null
  };
}

function defaultNoteForLane(lane) {
  switch (lane) {
    case 'mow':
      return 'Standard cut, trim, and blow for typical residential turf. Adjust for slope and toys.';
    case 'wash':
      return 'Surface wash only. Excludes sealing and heavy oil remediation.';
    case 'junk':
      return 'Single trip. Standard load, normal access. Landfill fees included.';
    case 'handyman':
      return 'Minor punch list. Labor only unless otherwise specified.';
    default:
      return 'Range based on standard field conditions and time-on-site.';
  }
}

// Render deck

function renderDeck() {
  deckGrid.innerHTML = '';

  let cards = [...deck];

  const lane = laneFilter.value;
  if (lane !== 'all') {
    cards = cards.filter(c => c.lane === lane);
  }

  const sort = sortOrder.value;
  if (sort === 'lane') {
    cards.sort((a, b) => (a.lane > b.lane ? 1 : a.lane < b.lane ? -1 : (b.createdAt || '').localeCompare(a.createdAt || '')));
  } else {
    cards.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  if (!cards.length) {
    deckEmpty.style.display = 'block';
    return;
  }

  deckEmpty.style.display = 'none';

  cards.forEach((card) => {
    const el = document.createElement('article');
    el.className = 'card';

    const left = document.createElement('div');
    const right = document.createElement('div');

    // Header
    const header = document.createElement('div');
    header.className = 'card-header';

    const laneTag = document.createElement('span');
    laneTag.className = 'card-lane-tag';
    laneTag.textContent = laneLabel(card.lane);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = headlineForLane(card.lane);

    header.appendChild(laneTag);
    header.appendChild(title);

    // Price
    const price = document.createElement('div');
    price.className = 'card-price';
    price.textContent = formatRange(card.low, card.high);

    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = card.note;

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta-row';

    const idSpan = document.createElement('span');
    idSpan.className = 'card-id';
    idSpan.textContent = card.id;

    const tsSpan = document.createElement('span');
    tsSpan.className = 'card-timestamp';
    tsSpan.textContent = formatTime(card.createdAt);

    metaRow.appendChild(idSpan);
    metaRow.appendChild(tsSpan);

    left.appendChild(header);
    left.appendChild(price);
    left.appendChild(note);
    left.appendChild(metaRow);

    // Right side: thumb + status tags
    if (card.thumbUrl) {
      const img = document.createElement('img');
      img.src = card.thumbUrl;
      img.alt = 'Job photo';
      img.style.width = '100%';
      img.style.maxHeight = '96px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '8px';
      img.setAttribute('data-tooltip', 'Source frame from your upload. Keep them honest.');
      right.appendChild(img);
    }

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'card-meta-row';

    const guardTag = document.createElement('span');
    guardTag.className = 'tag tag-success';
    guardTag.textContent = 'Guardrail band';

    const opsTag = document.createElement('span');
    opsTag.className = 'tag tag-soft';
    opsTag.textContent = 'Edit logic in ops console';

    tagsWrap.appendChild(guardTag);
    tagsWrap.appendChild(opsTag);
    right.appendChild(tagsWrap);

    el.appendChild(left);
    el.appendChild(right);

    deckGrid.appendChild(el);
  });
}

// Helpers

function laneLabel(lane) {
  switch (lane) {
    case 'mow': return 'Mow';
    case 'wash': return 'Wash';
    case 'junk': return 'Junk';
    case 'handyman': return 'Handyman';
    default: return lane;
  }
}

function headlineForLane(lane) {
  switch (lane) {
    case 'mow':
      return 'Curb-ready cut, zero guesswork.';
    case 'wash':
      return 'Clean concrete, no soft spots.';
    case 'junk':
      return 'One haul, all above board.';
    case 'handyman':
      return 'Punch list handled like a pro.';
    default:
      return 'Defensible field price.';
  }
}

function formatRange(low, high) {
  const l = Math.round(low);
  const h = Math.round(high);
  return `$${l}–$${h}`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function safeErrorMessage(res) {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return json.error || json.message || text;
    } catch (_) {
      return text;
    }
  } catch {
    return null;
  }
}

// Simple tooltips for elements with data-tooltip
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-tooltip]');
  if (!target) {
    tooltip.style.opacity = '0';
    return;
  }
  tooltip.textContent = target.getAttribute('data-tooltip');
  const rect = target.getBoundingClientRect();
  tooltip.style.left = rect.left + window.scrollX + 'px';
  tooltip.style.top = rect.top + window.scrollY - 26 + 'px';
  tooltip.style.opacity = '1';
  tooltip.style.transform = 'translateY(0)';
});

document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-tooltip]')) return;
  tooltip.style.opacity = '0';
  tooltip.style.transform = 'translateY(4px)';
});

// Initial render: local empty deck
renderDeck();
paintStatus('info', 'Ready. Point this at your existing backend. No extra ceremony.', false);
