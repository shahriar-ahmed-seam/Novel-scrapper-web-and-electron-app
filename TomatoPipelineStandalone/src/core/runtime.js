import path from 'node:path';
import fs from 'node:fs/promises';

import { createJobStore } from './job_store.js';
import { scrapeTomatoBook } from './tomato_scrape.js';
import { parseRawFullPayload } from './parser.js';
import { TomatoTranslator } from './tomato_translate.js';
import { buildEpub, buildBundleZip } from './epub.js';
import { ensureDir, extractChapterIdFromUrl, fileExists, sanitizePathSegment, sleep } from './utils.js';
import { isLikelyOfflineError } from './net.js';

function padIndex(index, width) {
  return String(index).padStart(width, '0');
}

function chapterTxt(title, lines) {
  const body = (lines ?? []).map((l) => (l?.text ?? '')).join('\n');
  return title ? `${title}\n\n${body}\n` : `${body}\n`;
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'TomatoPipelineStandalone/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return { buf, contentType: ct };
}

function guessImageName(contentType, fallback = 'cover.jpg') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'cover.png';
  if (ct.includes('webp')) return 'cover.webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'cover.jpg';
  return fallback;
}

export async function createPipelineRuntime({ userDataDir }) {
  const jobsDir = path.join(userDataDir, 'jobs');
  const store = createJobStore({ jobsDir });

  const jobs = new Map();
  const activeRuns = new Set();

  function pushLog(job, line) {
    job.logs = job.logs || [];
    job.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (job.logs.length > 4000) job.logs.splice(0, job.logs.length - 4000);
  }

  function bumpChapter(job, chapNumber, patch) {
    const idx = job.chapters.findIndex((c) => c.number === chapNumber);
    if (idx < 0) return;
    job.chapterSeq = (job.chapterSeq || 0) + 1;
    job.chapters[idx] = { ...job.chapters[idx], ...patch, seq: job.chapterSeq, updatedAt: new Date().toISOString() };
  }

  function consumeNewLogs(job) {
    const cur = Number(job.logCursor || 0);
    const all = Array.isArray(job.logs) ? job.logs : [];
    const out = all.slice(cur);
    job.logCursor = all.length;
    return out;
  }

  function consumeChapterUpdates(job, sinceSeq) {
    const seqNow = Number(job.chapterSeq || 0);
    const updates = Array.isArray(job.chapters) ? job.chapters.filter((c) => Number(c.seq || 0) > sinceSeq) : [];
    return { seqNow, updates };
  }

  async function loadJobsFromDisk() {
    const ids = await store.list();
    for (const id of ids) {
      const j = await store.load(id);
      if (j.status === 'running' || j.status === 'stopping') {
        j.status = 'paused';
        j.pauseReason = j.pauseReason || 'app-restarted';
        j.pausedAt = j.pausedAt || new Date().toISOString();
      }
      jobs.set(id, j);
    }
  }

  await loadJobsFromDisk();

  async function loadNovel({ novelId, showBrowser = false } = {}) {
    const data = await scrapeTomatoBook(novelId, { showBrowser, partition: 'persist:tp' });
    return data;
  }

  function createJobId() {
    return `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  async function startRun(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('Options are required');

    const novelId = String(opts.novelId ?? '').trim();
    const outputPath = String(opts.outputPath ?? '').trim();
    const startChapter = Number(opts.startChapter);
    const endChapter = Number(opts.endChapter);

    if (!novelId) throw new Error('novelId is required');
    if (!outputPath) throw new Error('outputPath is required');
    if (!Number.isFinite(startChapter) || !Number.isFinite(endChapter) || startChapter < 1 || endChapter < startChapter) {
      throw new Error('Invalid start/end chapter');
    }

    const jobId = createJobId();

    const normalizedOpts = {
      ...opts,
      novelId,
      outputPath,
      customTitle: String(opts.customTitle ?? '').trim(),
      startChapter,
      endChapter,
      downloadDelayMs: Number.isFinite(Number(opts.downloadDelayMs)) ? Number(opts.downloadDelayMs) : 150,
      translateDelayMs: Number.isFinite(Number(opts.translateDelayMs)) ? Number(opts.translateDelayMs) : 600,
      chunkChars: Number.isFinite(Number(opts.chunkChars)) ? Number(opts.chunkChars) : 4800,
      showBrowser: !!opts.showBrowser
    };

    const job = {
      id: jobId,
      createdAt: new Date().toISOString(),
      savedAt: null,
      status: 'queued',
      pauseReason: '',
      pausedAt: null,
      stopRequested: false,
      pauseRequested: false,
      resumeRequested: false,
      logs: [],
      logCursor: 0,
      progress: { phase: '', done: 0, total: 0 },
      chapterSeq: 0,
      chapters: [],
      opts: normalizedOpts,
      book: null
    };

    pushLog(job, 'Job created');
    jobs.set(jobId, job);
    await store.create(job);

    runJob(jobId).catch((err) => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = 'failed';
      pushLog(j, `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      store.save(j).catch(() => {});
    });

    return { jobId };
  }

  async function runJob(jobId) {
    if (activeRuns.has(jobId)) return;
    activeRuns.add(jobId);

    try {
      const job = jobs.get(jobId) || (await store.load(jobId));
      jobs.set(jobId, job);

      job.status = 'running';
      if (!job.opts) throw new Error('Missing job opts');
      await store.save(job);

      const {
        novelId,
        customTitle,
        startChapter,
        endChapter,
        outputPath,
        downloadDelayMs = 150,
        translateDelayMs = 600,
        chunkChars = 4800,
        showBrowser = false
      } = job.opts;

      let book = job.book;
      if (!book) {
        book = await scrapeTomatoBook(novelId, { showBrowser, partition: 'persist:tp' });
        job.book = book;
        await store.save(job);
      }

      const novelTitle = sanitizePathSegment(customTitle || book.meta.title, { maxLen: 120 });
      const outRoot = path.join(outputPath, novelTitle);
      const cnTxtDir = path.join(outRoot, 'txt');
      const cnJsonDir = path.join(outRoot, 'json');
      const trTxtDir = path.join(outRoot, 'translated', 'txt');

      await ensureDir(cnTxtDir);
      await ensureDir(cnJsonDir);
      await ensureDir(trTxtDir);

      const width = String(book.chapters.length).length;
      const slice = book.chapters.filter((c) => c.number >= startChapter && c.number <= endChapter);

      job.progress.total = slice.length;
      job.progress.done = 0;

      pushLog(job, `Novel: ${novelTitle}`);
      pushLog(job, `Chapters: ${slice.length} (${startChapter}..${endChapter})`);
      pushLog(job, `Output: ${outRoot}`);

      if (!Array.isArray(job.chapters) || job.chapters.length === 0) {
        job.chapters = slice.map((c) => {
          const chapterId = extractChapterIdFromUrl(c.url);
          return {
            number: c.number,
            title: c.title,
            url: c.url,
            chapterId,
            download: { status: 'pending' },
            translate: { status: 'pending' },
            error: '',
            seq: 0,
            updatedAt: null
          };
        });
        await store.save(job);
      }

      const checkPauseStop = async () => {
        if (job.stopRequested) {
          job.status = 'stopped';
          await store.save(job);
          return 'stopped';
        }
        if (job.pauseRequested) {
          job.status = 'paused';
          job.pausedAt = new Date().toISOString();
          await store.save(job);
          return 'paused';
        }
        return null;
      };

      // Download
      job.progress.phase = 'download';
      await store.save(job);

      for (let i = 0; i < slice.length; i++) {
        const pauseStop = await checkPauseStop();
        if (pauseStop) return;

        const c = slice[i];
        const idxPrefix = padIndex(c.number, width);
        const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
        const stem = `${idxPrefix} - ${safeTitle}`;

        const chapterId = extractChapterIdFromUrl(c.url);
        if (!chapterId) {
          pushLog(job, `WARN: cannot extract chapterId from ${c.url}`);
          bumpChapter(job, c.number, { download: { status: 'failed' }, error: 'Cannot extract chapterId' });
          await store.save(job);
          continue;
        }

        const jsonPath = path.join(cnJsonDir, `${stem}.json`);
        const txtPath = path.join(cnTxtDir, `${stem}.txt`);

        if ((await fileExists(jsonPath)) && (await fileExists(txtPath))) {
          bumpChapter(job, c.number, { download: { status: 'ok' }, error: '' });
          job.progress.done = i + 1;
          await store.save(job);
          continue;
        }

        try {
          pushLog(job, `Downloading ${stem}`);
          const url = new URL('https://tt.sjmyzq.cn/api/raw_full');
          url.searchParams.set('item_id', String(chapterId));

          const res = await fetch(url, { headers: { 'user-agent': 'TomatoPipelineStandalone/1.0' } });
          if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
          const raw = await res.json();
          if (raw?.code != null && Number(raw.code) !== 200) throw new Error(`Upstream code=${raw.code}`);

          const parsed = parseRawFullPayload(raw, { itemIdHint: chapterId });
          await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8');
          await fs.writeFile(txtPath, chapterTxt(c.title, parsed.lines), 'utf8');

          bumpChapter(job, c.number, { download: { status: 'ok' }, error: '' });
        } catch (err) {
          const offline = isLikelyOfflineError(err);
          bumpChapter(job, c.number, { download: { status: offline ? 'paused-offline' : 'failed' }, error: err instanceof Error ? err.message : String(err) });
          await store.save(job);

          if (offline) {
            job.pauseRequested = true;
            job.pauseReason = 'offline';
            job.status = 'paused';
            job.pausedAt = new Date().toISOString();
            pushLog(job, 'Paused: internet appears offline (download).');
            await store.save(job);
            return;
          }

          pushLog(job, `ERROR downloading ${stem}: ${err instanceof Error ? err.message : String(err)}`);
        }

        job.progress.done = i + 1;
        await store.save(job);
        if (downloadDelayMs > 0) await sleep(downloadDelayMs);
      }

      // Translate
      job.progress.phase = 'translate';
      job.progress.done = 0;
      await store.save(job);

      const translator = new TomatoTranslator({
        showBrowser,
        partition: 'persist:tp_translate',
        delayMs: translateDelayMs,
        maxChunkChars: chunkChars
      });

      let translatedSinceReset = 0;

      try {
        for (let i = 0; i < slice.length; i++) {
          const pauseStop = await checkPauseStop();
          if (pauseStop) return;

          const c = slice[i];
          const idxPrefix = padIndex(c.number, width);
          const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
          const stem = `${idxPrefix} - ${safeTitle}`;

          const cnPath = path.join(cnTxtDir, `${stem}.txt`);
          const trPath = path.join(trTxtDir, `${stem}.txt`);

          if (await fileExists(trPath)) {
            bumpChapter(job, c.number, { translate: { status: 'ok' }, error: '' });
            job.progress.done = i + 1;
            await store.save(job);
            continue;
          }

          pushLog(job, `Translating ${stem}`);
          try {
            const src = await fs.readFile(cnPath, 'utf8');

            const perChunkTimeoutMs = 180_000;
            const startedAt = Date.now();
            const heartbeat = setInterval(() => {
              const sec = Math.floor((Date.now() - startedAt) / 1000);
              pushLog(job, `  ...waiting (${sec}s)`);
            }, 20_000);

            try {
              const tryTranslate = async () => {
                return await translator.translateLongText(src, {
                  timeoutMs: perChunkTimeoutMs,
                  onChunk: async ({ index, total }) => pushLog(job, `  chunk ${index + 1}/${total}`)
                });
              };

              let out;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  if (attempt > 1) {
                    pushLog(job, `  retrying attempt ${attempt}/3`);
                    await translator.close();
                    await sleep(1000);
                  }
                  out = await tryTranslate();
                  break;
                } catch (err1) {
                  const msg1 = err1 instanceof Error ? err1.message : String(err1);
                  const retryable = /timeout|eval timeout|missing translate dom/i.test(msg1);
                  if (!retryable || attempt === 3) throw err1;
                  pushLog(job, `  retrying (reason: ${msg1})`);
                  if (!showBrowser && attempt === 1) {
                    pushLog(job, '  hint: enable Show Browser and Resume if this keeps timing out (login/captcha).');
                  }
                }
              }

              await fs.writeFile(trPath, out + (out.endsWith('\n') ? '' : '\n'), 'utf8');
              bumpChapter(job, c.number, { translate: { status: 'ok' }, error: '' });

              translatedSinceReset += 1;
              if (translatedSinceReset >= 5) {
                pushLog(job, '  refreshing translator session...');
                await translator.close();
                translatedSinceReset = 0;
                await sleep(500);
              }
            } finally {
              clearInterval(heartbeat);
            }
          } catch (err) {
            const offline = isLikelyOfflineError(err);
            bumpChapter(job, c.number, {
              translate: { status: offline ? 'paused-offline' : 'failed' },
              error: err instanceof Error ? err.message : String(err)
            });

            if (offline) {
              job.pauseRequested = true;
              job.pauseReason = 'offline';
              job.status = 'paused';
              job.pausedAt = new Date().toISOString();
              pushLog(job, 'Paused: internet appears offline (translate).');
              await store.save(job);
              return;
            }

            pushLog(job, `ERROR translating ${stem}: ${err instanceof Error ? err.message : String(err)}`);
          }

          job.progress.done = i + 1;
          await store.save(job);
        }
      } finally {
        await translator.close();
      }

      // If any requested chapter is still missing a translated file, pause instead of packaging an incomplete EPUB.
      const missingTr = [];
      for (const c of slice) {
        const idxPrefix = padIndex(c.number, width);
        const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
        const stem = `${idxPrefix} - ${safeTitle}`;
        const trPath = path.join(trTxtDir, `${stem}.txt`);
        if (!(await fileExists(trPath))) missingTr.push(stem);
      }

      if (missingTr.length) {
        pushLog(job, `Translate incomplete: missing ${missingTr.length} chapter(s).`);
        pushLog(job, 'Paused so you can Resume (optionally turn on Show Browser to handle login/captcha).');
        job.status = 'paused';
        job.pauseReason = 'translate-incomplete';
        job.pausedAt = new Date().toISOString();
        await store.save(job);
        return;
      }

      // Package
      job.progress.phase = 'package';
      await store.save(job);

      // Cover fetch
      let cover = null;
      if (book.meta.coverUrl) {
        try {
          const { buf, contentType } = await fetchBytes(book.meta.coverUrl);
          cover = { bytes: buf, mediaType: contentType || 'image/jpeg', fileName: guessImageName(contentType) };
        } catch {
          // ignore cover failures
        }
      }

      const trFiles = (await fs.readdir(trTxtDir)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
      const chaptersForEpub = [];
      for (const f of trFiles) {
        const title = f.replace(/\.txt$/i, '');
        const content = await fs.readFile(path.join(trTxtDir, f), 'utf8');
        chaptersForEpub.push({ number: null, title, content });
      }

      const epubPath = path.join(outRoot, `${novelTitle}.epub`);
      await buildEpub({ outPath: epubPath, novelTitle, novelDescription: book.meta.description, cover, chapters: chaptersForEpub });
      pushLog(job, `Wrote EPUB: ${epubPath}`);

      const bundlePath = path.join(outRoot, `${novelTitle}.zip`);
      await buildBundleZip({ outPath: bundlePath, rootDir: outRoot });
      pushLog(job, `Wrote bundle: ${bundlePath}`);

      job.progress.phase = 'done';
      job.status = 'done';
      await store.save(job);
    } finally {
      activeRuns.delete(jobId);
    }
  }

  async function pauseRun({ jobId, reason = 'user' }) {
    const job = jobs.get(jobId) || (await store.load(jobId));
    jobs.set(jobId, job);
    job.pauseRequested = true;
    job.pauseReason = String(reason || 'user');
    pushLog(job, `Pause requested (${job.pauseReason})`);
    await store.save(job);
    return { ok: true };
  }

  async function resumeRun({ jobId, overrides } = {}) {
    const job = jobs.get(jobId) || (await store.load(jobId));
    jobs.set(jobId, job);

    if (overrides && typeof overrides === 'object' && job.opts && typeof job.opts === 'object') {
      if (Object.prototype.hasOwnProperty.call(overrides, 'showBrowser')) {
        job.opts.showBrowser = !!overrides.showBrowser;
      }
      if (Object.prototype.hasOwnProperty.call(overrides, 'translateDelayMs')) {
        const v = Number(overrides.translateDelayMs);
        if (Number.isFinite(v) && v >= 0 && v <= 60_000) job.opts.translateDelayMs = v;
      }
      if (Object.prototype.hasOwnProperty.call(overrides, 'chunkChars')) {
        const v = Number(overrides.chunkChars);
        if (Number.isFinite(v) && v >= 300 && v <= 10_000) job.opts.chunkChars = v;
      }
    }

    job.pauseRequested = false;
    job.resumeRequested = true;
    job.pauseReason = '';
    job.pausedAt = null;
    job.status = 'running';
    pushLog(job, 'Resume requested');
    await store.save(job);

    runJob(jobId).catch((err) => {
      const j = jobs.get(jobId);
      if (!j) return;
      j.status = 'failed';
      pushLog(j, `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      store.save(j).catch(() => {});
    });

    return { ok: true };
  }

  async function stopRun({ jobId }) {
    const job = jobs.get(jobId) || (await store.load(jobId));
    jobs.set(jobId, job);
    job.stopRequested = true;
    pushLog(job, 'Stop requested');
    if (job.status === 'running') job.status = 'stopping';
    await store.save(job);
    return { ok: true };
  }

  async function getStatus({ jobId, sinceSeq = 0 }) {
    const job = jobs.get(jobId) || (await store.load(jobId));
    jobs.set(jobId, job);

    const newLogs = consumeNewLogs(job);
    const { seqNow, updates } = consumeChapterUpdates(job, Number(sinceSeq || 0));

    return {
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        pauseReason: job.pauseReason || '',
        progress: job.progress
      },
      newLogs,
      chapterSeq: seqNow,
      chapterUpdates: updates
    };
  }

  async function getDetails({ jobId }) {
    const job = jobs.get(jobId) || (await store.load(jobId));
    jobs.set(jobId, job);

    return {
      ok: true,
      data: {
        job: { id: job.id, status: job.status, pauseReason: job.pauseReason || '', opts: job.opts || null },
        meta: job.book?.meta || null,
        chapters: job.chapters || []
      }
    };
  }

  async function listJobs({ novelId = '' } = {}) {
    const ids = await store.list();
    const out = [];

    for (const id of ids) {
      const job = jobs.get(id) || (await store.load(id));
      jobs.set(id, job);
      if (novelId && String(job?.opts?.novelId ?? '') !== String(novelId)) continue;
      out.push({
        id,
        status: job.status,
        pauseReason: job.pauseReason || '',
        novelId: job?.opts?.novelId || '',
        createdAt: job.createdAt || '',
        savedAt: job.savedAt || ''
      });
    }

    return { ok: true, jobs: out };
  }

  return {
    loadNovel,
    startRun,
    pauseRun,
    resumeRun,
    stopRun,
    getStatus,
    getDetails,
    listJobs
  };
}
