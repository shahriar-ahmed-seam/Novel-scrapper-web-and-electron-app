const qs = (s) => document.querySelector(s);

const state = {
  meta: null,
  chapters: [],
  chapterStatus: new Map(),
  jobId: null,
  pollTimer: null,
  lastSeq: 0
};

function logLine(line) {
  const el = qs('#logBody');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function setDisabled(sel, v) {
  const el = qs(sel);
  if (el) el.disabled = !!v;
}

function setText(sel, text) {
  const el = qs(sel);
  if (el) el.textContent = String(text ?? '');
}

function setStatus(text) {
  setText('#status', text);
}

function setCounts(done, total) {
  setText('#counts', `${done} / ${total}`);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  qs('#barFill').style.width = `${pct}%`;
}

function chapterClassFromStatus(st) {
  const downloadStatus = st?.download?.status || '';
  const translateStatus = st?.translate?.status || '';
  const error = st?.error || '';

  if (translateStatus === 'ok') return 'chapter--translate-ok';
  if (translateStatus === 'failed' || downloadStatus === 'failed' || downloadStatus === 'paused-offline' || error) return 'chapter--failed';
  if (downloadStatus === 'ok') return 'chapter--download-ok';
  return '';
}

function applyChapterClass(el, st) {
  el.classList.remove('chapter--download-ok', 'chapter--translate-ok', 'chapter--failed');
  const cls = chapterClassFromStatus(st);
  if (cls) el.classList.add(cls);
}

function saveOutputPath() {
  const p = qs('#outputPath').value.trim();
  if (p) localStorage.setItem('tomatoPipeline:outputPath', p);
}

function restoreOutputPath() {
  const p = localStorage.getItem('tomatoPipeline:outputPath');
  if (p) qs('#outputPath').value = p;
}

function renderChapters(chapters) {
  const list = qs('#chapterList');
  list.innerHTML = '';
  for (const c of chapters) {
    const div = document.createElement('div');
    div.className = 'chapter';
    div.dataset.number = String(c.number);

    const st = state.chapterStatus.get(c.number);
    applyChapterClass(div, st);

    const t = document.createElement('div');
    t.className = 'c-title';
    t.textContent = `${c.number}. ${c.title}`;
    const sub = document.createElement('div');
    sub.className = 'c-sub';
    sub.textContent = c.url;
    div.appendChild(t);
    div.appendChild(sub);
    list.appendChild(div);
  }
}

function fillChapterSelects(chapters) {
  const startSel = qs('#startChapter');
  const endSel = qs('#endChapter');
  startSel.innerHTML = '';
  endSel.innerHTML = '';

  for (const c of chapters) {
    const opt1 = document.createElement('option');
    opt1.value = String(c.number);
    opt1.textContent = `${c.number}. ${c.title}`;
    const opt2 = opt1.cloneNode(true);
    startSel.appendChild(opt1);
    endSel.appendChild(opt2);
  }

  startSel.value = '1';
  endSel.value = String(chapters.length);

  startSel.disabled = false;
  endSel.disabled = false;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

async function loadNovel() {
  const novelId = qs('#novelId').value.trim();
  if (!novelId) return alert('Enter novel ID');

  setStatus('Loading metadata…');
  setDisabled('#loadBtn', true);
  setDisabled('#runBtn', true);
  logLine(`Loading novel ${novelId}…`);

  try {
    const { data } = await api('/api/novel/load', { novelId });
    state.meta = data.meta;
    state.chapters = data.chapters;
    state.chapterStatus = new Map();

    qs('#novelTitle').textContent = state.meta.title;
    qs('#description').textContent = state.meta.description || '';
    qs('#cover').src = state.meta.coverUrl || '';

    renderChapters(state.chapters);
    fillChapterSelects(state.chapters);

    setDisabled('#runBtn', false);
    setStatus('Ready');
    logLine(`Loaded ${state.chapters.length} chapters.`);

    localStorage.setItem('tomatoPipeline:lastNovelId', novelId);
  } catch (e) {
    setStatus('Failed');
    logLine(`ERROR: ${e.message}`);
    alert(e.message);
  } finally {
    setDisabled('#loadBtn', false);
  }
}

async function startRun() {
  if (!state.meta || !state.chapters.length) return alert('Load a novel first');

  const novelId = qs('#novelId').value.trim();
  const customTitle = qs('#customTitle').value.trim();
  const startChapter = Number(qs('#startChapter').value);
  const endChapter = Number(qs('#endChapter').value);
  const outputPath = qs('#outputPath').value.trim();
  const downloadDelayMs = Number(qs('#downloadDelayMs').value);
  const translateDelayMs = Number(qs('#translateDelayMs').value);
  const chunkChars = Number(qs('#chunkChars').value);

  if (!outputPath) return alert('Output path is required');
  if (!Number.isFinite(startChapter) || !Number.isFinite(endChapter) || startChapter > endChapter) {
    return alert('Invalid start/end chapter');
  }

  saveOutputPath();

  setDisabled('#runBtn', true);
  setDisabled('#stopBtn', false);
  setDisabled('#pauseBtn', false);
  setStatus('Starting…');
  setCounts(0, endChapter - startChapter + 1);

  logLine('Starting pipeline…');

  try {
    const { jobId } = await api('/api/run/start', {
      novelId,
      customTitle,
      startChapter,
      endChapter,
      outputPath,
      downloadDelayMs,
      translateDelayMs,
      chunkChars
    });

    state.jobId = jobId;
    state.lastSeq = 0;
    localStorage.setItem('tomatoPipeline:lastJobId', jobId);
    localStorage.setItem('tomatoPipeline:lastNovelId', novelId);
    pollJob();
    state.pollTimer = setInterval(pollJob, 1500);
  } catch (e) {
    setStatus('Failed');
    logLine(`ERROR: ${e.message}`);
    alert(e.message);
    setDisabled('#runBtn', false);
    setDisabled('#stopBtn', true);
  }
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const since = Number(state.lastSeq || 0);
    const res = await fetch(`/api/run/status?jobId=${encodeURIComponent(state.jobId)}&sinceSeq=${encodeURIComponent(String(since))}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'status failed');

    const j = json.job;
    setStatus(j.status + (j.pauseReason ? ` (${j.pauseReason})` : ''));
    setCounts(j.progress.done, j.progress.total);
    setText('#analytics', j.progress.phase || '');

    // Toggle pause button label/state
    const pauseBtn = qs('#pauseBtn');
    if (pauseBtn) {
      pauseBtn.disabled = !(j.status === 'running' || j.status === 'paused');
      pauseBtn.textContent = j.status === 'paused' ? 'Resume' : 'Pause';
    }

    if (Array.isArray(j.newLogs)) {
      for (const line of j.newLogs) logLine(line);
    }

    if (Array.isArray(json.chapterUpdates) && json.chapterUpdates.length) {
      for (const up of json.chapterUpdates) {
        if (!up || typeof up.number !== 'number') continue;
        state.chapterStatus.set(up.number, up);
        const el = qs(`.chapter[data-number="${up.number}"]`);
        if (el) applyChapterClass(el, up);
      }
    }
    if (typeof json.chapterSeq === 'number') state.lastSeq = json.chapterSeq;

    if (j.status === 'done' || j.status === 'failed' || j.status === 'stopped') {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      setDisabled('#runBtn', false);
      setDisabled('#stopBtn', true);
      setDisabled('#pauseBtn', true);
      logLine(`Finished with status: ${j.status}`);
    }
  } catch (e) {
    logLine(`WARN: ${e.message}`);
  }
}

async function pauseOrResume() {
  if (!state.jobId) return;
  const pauseBtn = qs('#pauseBtn');
  const wantResume = (pauseBtn?.textContent || '').toLowerCase().includes('resume');
  try {
    if (wantResume) {
      await api('/api/run/resume', { jobId: state.jobId });
      logLine('Resume requested.');
    } else {
      await api('/api/run/pause', { jobId: state.jobId, reason: 'user' });
      logLine('Pause requested.');
    }
  } catch (e) {
    logLine(`ERROR pause/resume: ${e.message}`);
  }
}

async function stopRun() {
  if (!state.jobId) return;
  setDisabled('#stopBtn', true);
  setDisabled('#pauseBtn', true);
  try {
    await api('/api/run/stop', { jobId: state.jobId });
    logLine('Stop requested.');
  } catch (e) {
    logLine(`ERROR stopping: ${e.message}`);
  }
}

async function tryRestoreLastJob() {
  const lastJobId = localStorage.getItem('tomatoPipeline:lastJobId');
  if (!lastJobId) return;

  try {
    const res = await fetch(`/api/run/details?jobId=${encodeURIComponent(lastJobId)}`);
    const json = await res.json();
    if (!json.ok) return;

    state.jobId = json.data.job.id;
    state.lastSeq = 0;
    state.meta = json.data.meta;
    state.chapters = (json.data.chapters || []).map((c, idx) => ({
      number: c.number ?? (idx + 1),
      title: c.title ?? '',
      url: c.url ?? ''
    }));

    state.chapterStatus = new Map();
    for (const c of json.data.chapters || []) {
      if (typeof c.number === 'number') state.chapterStatus.set(c.number, c);
    }

    // Populate UI
    qs('#novelTitle').textContent = state.meta?.title || 'Tomato Pipeline';
    qs('#description').textContent = state.meta?.description || '';
    qs('#cover').src = state.meta?.coverUrl || '';
    renderChapters(state.chapters);
    fillChapterSelects(state.chapters);

    setDisabled('#runBtn', false);
    setDisabled('#stopBtn', false);
    setDisabled('#pauseBtn', false);

    logLine(`Restored job ${state.jobId} from disk.`);
    pollJob();
    state.pollTimer = setInterval(pollJob, 1500);
  } catch {
    // ignore
  }
}

function init() {
  restoreOutputPath();
  const lastNovelId = localStorage.getItem('tomatoPipeline:lastNovelId');
  if (lastNovelId) qs('#novelId').value = lastNovelId;
  qs('#novelTitle').textContent = 'Tomato Pipeline';
  setStatus('Idle');
  setCounts(0, 0);

  qs('#loadBtn').addEventListener('click', loadNovel);
  qs('#runBtn').addEventListener('click', startRun);
  qs('#pauseBtn').addEventListener('click', pauseOrResume);
  qs('#stopBtn').addEventListener('click', stopRun);

  qs('#logToggle').addEventListener('click', () => {
    const panel = qs('#logPanel');
    const open = panel.getAttribute('data-open') === '1';
    panel.setAttribute('data-open', open ? '0' : '1');
    qs('#logToggle').textContent = open ? 'Open' : 'Close';
  });

  qs('#outputPath').addEventListener('change', saveOutputPath);

  // If there was a previous job, restore it (survives localhost restarts)
  tryRestoreLastJob();
}

init();
