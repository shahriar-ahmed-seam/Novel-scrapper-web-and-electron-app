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

function saveOutputPath() {
  const p = qs('#outputPath').value.trim();
  if (p) localStorage.setItem('tp:outputPath', p);
}

function restoreOutputPath() {
  const p = localStorage.getItem('tp:outputPath');
  if (p) qs('#outputPath').value = p;
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

async function loadNovel() {
  const novelId = qs('#novelId').value.trim();
  if (!novelId) return alert('Enter novel ID');

  const showBrowser = qs('#showBrowser').value === '1';

  setStatus('Loading metadata…');
  setDisabled('#loadBtn', true);
  setDisabled('#runBtn', true);
  logLine(`Loading novel ${novelId}…`);

  try {
    const data = await window.tp.loadNovel(novelId, showBrowser);
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

    localStorage.setItem('tp:lastNovelId', novelId);
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

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  const novelId = qs('#novelId').value.trim();
  const customTitle = qs('#customTitle').value.trim();
  const startChapter = Number(qs('#startChapter').value);
  const endChapter = Number(qs('#endChapter').value);
  const outputPath = qs('#outputPath').value.trim();
  const downloadDelayMs = Number(qs('#downloadDelayMs').value);
  const translateDelayMs = Number(qs('#translateDelayMs').value);
  const chunkChars = Number(qs('#chunkChars').value);
  const showBrowser = qs('#showBrowser').value === '1';

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
    const { jobId } = await window.tp.runStart({
      novelId,
      customTitle,
      startChapter,
      endChapter,
      outputPath,
      downloadDelayMs,
      translateDelayMs,
      chunkChars,
      showBrowser
    });

    state.jobId = jobId;
    state.lastSeq = 0;
    localStorage.setItem('tp:lastJobId', jobId);
    pollJob();
    state.pollTimer = setInterval(pollJob, 1200);
  } catch (e) {
    setStatus('Failed');
    logLine(`ERROR: ${e.message}`);
    alert(e.message);
    setDisabled('#runBtn', false);
    setDisabled('#stopBtn', true);
    setDisabled('#pauseBtn', true);
  }
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const since = Number(state.lastSeq || 0);
    const json = await window.tp.runStatus(state.jobId, since);

    const j = json.job;
    setStatus(j.status + (j.pauseReason ? ` (${j.pauseReason})` : ''));
    setCounts(j.progress.done, j.progress.total);
    setText('#analytics', j.progress.phase || '');

    const pauseBtn = qs('#pauseBtn');
    if (pauseBtn) {
      pauseBtn.disabled = !(j.status === 'running' || j.status === 'paused');
      pauseBtn.textContent = j.status === 'paused' ? 'Resume' : 'Pause';
    }

    if (Array.isArray(json.newLogs)) {
      for (const line of json.newLogs) logLine(line);
    }

    if (Array.isArray(json.chapterUpdates) && json.chapterUpdates.length) {
      for (const up of json.chapterUpdates) {
        if (!up || typeof up.number !== 'number') continue;
        state.chapterStatus.set(up.number, up);
        const el = qs(`.chapter[data-number=\"${up.number}\"]`);
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
      const showBrowser = qs('#showBrowser').value === '1';
      const translateDelayMs = Number(qs('#translateDelayMs').value);
      const chunkChars = Number(qs('#chunkChars').value);

      await window.tp.runResume(state.jobId, { showBrowser, translateDelayMs, chunkChars });
      logLine('Resume requested.');
    } else {
      await window.tp.runPause(state.jobId, 'user');
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
    await window.tp.runStop(state.jobId);
    logLine('Stop requested.');
  } catch (e) {
    logLine(`ERROR stopping: ${e.message}`);
  }
}

async function tryRestoreLastJob() {
  const lastJobId = localStorage.getItem('tp:lastJobId');
  if (!lastJobId) return;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  try {
    const json = await window.tp.runDetails(lastJobId);

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

    qs('#novelTitle').textContent = state.meta?.title || 'Tomato Pipeline';
    qs('#description').textContent = state.meta?.description || '';
    qs('#cover').src = state.meta?.coverUrl || '';

    renderChapters(state.chapters);
    fillChapterSelects(state.chapters);

    setDisabled('#runBtn', false);
    setDisabled('#stopBtn', false);
    setDisabled('#pauseBtn', false);

    logLine(`Restored job ${state.jobId}.`);
    pollJob();
    state.pollTimer = setInterval(pollJob, 1200);
  } catch {
    // ignore
  }
}

function init() {
  restoreOutputPath();
  const lastNovelId = localStorage.getItem('tp:lastNovelId');
  if (lastNovelId) qs('#novelId').value = lastNovelId;

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
  tryRestoreLastJob();
}

init();
