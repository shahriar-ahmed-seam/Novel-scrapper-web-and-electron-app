const els = {
  itemId: document.getElementById('itemId'),
  loadBtn: document.getElementById('loadBtn'),
  mockMode: document.getElementById('mockMode'),
  metaTitle: document.getElementById('metaTitle'),
  metaSub: document.getElementById('metaSub'),
  metaInfo: document.getElementById('metaInfo'),
  lines: document.getElementById('lines'),
  selectedLine: document.getElementById('selectedLine'),
  commentList: document.getElementById('commentList'),
  commentText: document.getElementById('commentText'),
  addCommentBtn: document.getElementById('addCommentBtn')
};

/** @type {{chapter: any, selectedIdx: number|null, comments: Record<string, Array<{at: string, text: string}>>}} */
const state = {
  chapter: null,
  selectedIdx: null,
  comments: {}
};

function setStatusTitle(text) {
  els.metaTitle.textContent = text;
}

function clearChapter() {
  state.chapter = null;
  state.selectedIdx = null;
  els.metaSub.textContent = '';
  els.metaInfo.textContent = '';
  els.lines.innerHTML = '';
  els.selectedLine.textContent = 'Select a line';
  els.commentList.innerHTML = '';
  els.commentText.value = '';
  els.addCommentBtn.disabled = true;
}

function renderMeta(ch) {
  const book = ch.book ?? {};
  const chapter = ch.chapter ?? {};

  const title = chapter.title || 'Untitled';
  const bookName = book.bookName || 'Unknown Book';
  const bookId = book.bookId || '';

  setStatusTitle(title);
  els.metaSub.textContent = `${bookName}${bookId ? ` (book_id: ${bookId})` : ''}`;

  const parts = [];
  if (chapter.chapterNumber != null) parts.push(`chapterNumber: ${chapter.chapterNumber}`);
  if (chapter.realChapterOrder != null) parts.push(`realChapterOrder: ${chapter.realChapterOrder}`);
  if (chapter.contentChapterNumber != null) parts.push(`contentChapterNumber: ${chapter.contentChapterNumber}`);
  parts.push(`lines: ${Array.isArray(ch.lines) ? ch.lines.length : 0}`);

  els.metaInfo.textContent = parts.join(' · ');
}

function renderLines(ch) {
  els.lines.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const line of ch.lines ?? []) {
    const row = document.createElement('div');
    row.className = 'line';
    row.dataset.idx = String(line.idx);

    const idx = document.createElement('div');
    idx.className = 'line__idx';
    idx.textContent = String(line.idx);

    const text = document.createElement('div');
    text.className = 'line__text';
    text.textContent = line.text ?? '';

    row.appendChild(idx);
    row.appendChild(text);

    row.addEventListener('click', () => {
      selectLine(line.idx);
    });

    frag.appendChild(row);
  }

  els.lines.appendChild(frag);
}

function selectLine(idx) {
  state.selectedIdx = idx;
  els.selectedLine.textContent = `Line idx="${idx}"`;
  els.addCommentBtn.disabled = false;

  // highlight
  for (const el of els.lines.querySelectorAll('.line')) {
    el.classList.toggle('line--selected', el.dataset.idx === String(idx));
  }

  renderComments();
}

function renderComments() {
  const idx = state.selectedIdx;
  els.commentList.innerHTML = '';

  if (idx == null) {
    els.commentList.textContent = 'Select a line to view comments.';
    return;
  }

  const key = String(idx);
  const items = state.comments[key] ?? [];

  if (items.length === 0) {
    els.commentList.textContent = 'No comments yet for this line.';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const c of items) {
    const box = document.createElement('div');
    box.className = 'comment';

    const meta = document.createElement('div');
    meta.className = 'comment__meta';
    meta.textContent = c.at;

    const text = document.createElement('div');
    text.className = 'comment__text';
    text.textContent = c.text;

    box.appendChild(meta);
    box.appendChild(text);
    frag.appendChild(box);
  }
  els.commentList.appendChild(frag);
}

async function loadChapter() {
  const itemId = (els.itemId.value || '').trim();
  if (!itemId) {
    setStatusTitle('Enter a chapter ID');
    return;
  }

  clearChapter();
  setStatusTitle('Loading...');

  const qs = new URLSearchParams();
  if (els.mockMode.checked) qs.set('mode', 'mock');

  const url = `/api/chapter/${encodeURIComponent(itemId)}${qs.toString() ? `?${qs.toString()}` : ''}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!json?.ok) {
    setStatusTitle('Failed to load');
    els.metaInfo.textContent = json?.error ? String(json.error) : 'Unknown error';
    return;
  }

  state.chapter = json.data;
  renderMeta(state.chapter);
  renderLines(state.chapter);

  // auto select first line
  const first = state.chapter.lines?.[0]?.idx;
  if (typeof first === 'number') {
    selectLine(first);
  }

  if (json.fallbackMock) {
    els.metaInfo.textContent = `${els.metaInfo.textContent} · upstreamError: ${json.upstreamError}`;
  }

  if (json.mismatch) {
    els.metaInfo.textContent = `${els.metaInfo.textContent} · mockMismatch: requested ${itemId}, got ${json.data.itemId}`;
  }
}

els.loadBtn.addEventListener('click', loadChapter);
els.itemId.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadChapter();
});

els.addCommentBtn.addEventListener('click', () => {
  const idx = state.selectedIdx;
  if (idx == null) return;

  const text = (els.commentText.value || '').trim();
  if (!text) return;

  const key = String(idx);
  const at = new Date().toLocaleString();
  state.comments[key] = state.comments[key] ?? [];
  state.comments[key].push({ at, text });

  els.commentText.value = '';
  renderComments();
});

// Prefill example
els.itemId.value = '7601844263415988760';
