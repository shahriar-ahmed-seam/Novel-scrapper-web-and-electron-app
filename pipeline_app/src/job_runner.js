import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parseRawFullPayload } from '../../src/parser.js';
import { TomatoMtlClient } from '../../translator_api/src/tomato_client.js';
import { ChapterTranslator } from '../../translator_api/src/translator.js';
import { sleep, sanitizePathSegment, extractChapterIdFromUrl, ensureDir, fileExists } from './utils.js';
import { scrapeTomatoBook } from './tomato_book_scrape.js';
import { saveJobOnDisk } from './job_store.js';
import { isLikelyOfflineError } from './net.js';

function padIndex(index, width) {
  return String(index).padStart(width, '0');
}

function chapterTxt(title, lines) {
  const body = (lines ?? []).map((l) => (l?.text ?? '')).join('\n');
  return title ? `${title}\n\n${body}\n` : `${body}\n`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textToXhtml(title, text) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
    `<head><meta charset="utf-8" /><title>${escapeXml(title)}</title></head>\n` +
    `<body><h1>${escapeXml(title)}</h1>\n${paras}\n</body></html>`;
}

async function buildEpub({ outPath, novelTitle, novelDescription, chapters }) {
  const zip = new JSZip();
  const uuid = `tomato-${Date.now()}`;

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.folder('META-INF').file(
    'container.xml',
    `<?xml version="1.0"?>\n` +
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
      `</container>`
  );

  const oebps = zip.folder('OEBPS');
  oebps.folder('Styles').file('style.css', 'body{font-family:serif;}');

  oebps.folder('Text').file(
    'meta.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
      `<head><meta charset="utf-8" /><title>Metadata</title></head>\n` +
      `<body><h1>${escapeXml(novelTitle)}</h1>` +
      (novelDescription ? `<p>${escapeXml(novelDescription).replace(/\n/g, '<br/>')}</p>` : '') +
      `</body></html>`
  );

  const chapterItems = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    const cNum = c.number || (i + 1);
    const file = `Text/chapter${String(cNum).padStart(4, '0')}.xhtml`;
    oebps.file(file, textToXhtml(c.title, c.content));
    chapterItems.push({ id: `chap${cNum}`, href: file, title: c.title });
  }

  oebps.file(
    'toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
      `<head>` +
      `<meta name="dtb:uid" content="${escapeXml(uuid)}"/>` +
      `<meta name="dtb:depth" content="1"/>` +
      `<meta name="dtb:totalPageCount" content="0"/>` +
      `<meta name="dtb:maxPageNumber" content="0"/>` +
      `</head>` +
      `<docTitle><text>${escapeXml(novelTitle)}</text></docTitle>` +
      `<navMap>` +
      chapterItems
        .map((it, idx) => {
          const order = idx + 1;
          return `<navPoint id="navPoint-${order}" playOrder="${order}">` +
            `<navLabel><text>${escapeXml(it.title)}</text></navLabel>` +
            `<content src="${escapeXml(it.href)}"/>` +
            `</navPoint>`;
        })
        .join('') +
      `</navMap>` +
      `</ncx>`
  );

  const manifestItems = [
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="style" href="Styles/style.css" media-type="text/css"/>`,
    `<item id="meta" href="Text/meta.xhtml" media-type="application/xhtml+xml"/>`,
    ...chapterItems.map((it) => `<item id="${escapeXml(it.id)}" href="${escapeXml(it.href)}" media-type="application/xhtml+xml"/>`)
  ];

  const spineItems = [`<itemref idref="meta"/>`, ...chapterItems.map((it) => `<itemref idref="${escapeXml(it.id)}"/>`)];

  oebps.file(
    'content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:identifier id="BookId">${escapeXml(uuid)}</dc:identifier>` +
      `<dc:title>${escapeXml(novelTitle)}</dc:title>` +
      `<dc:language>en</dc:language>` +
      `</metadata>` +
      `<manifest>${manifestItems.join('')}</manifest>` +
      `<spine toc="ncx">${spineItems.join('')}</spine>` +
      `</package>`
  );

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outPath, buf);
}

async function addDirToZip(zip, absDirPath, relPrefix, { excludeAbsPaths = new Set() } = {}) {
  const entries = await fs.readdir(absDirPath, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(absDirPath, ent.name);
    if (excludeAbsPaths.has(abs)) continue;
    const rel = relPrefix ? path.posix.join(relPrefix, ent.name) : ent.name;

    if (ent.isDirectory()) {
      await addDirToZip(zip, abs, rel, { excludeAbsPaths });
    } else if (ent.isFile()) {
      const data = await fs.readFile(abs);
      zip.file(rel, data);
    }
  }
}

async function buildBundleZip({ outPath, rootDir }) {
  const zip = new JSZip();
  await addDirToZip(zip, rootDir, '', { excludeAbsPaths: new Set([outPath]) });
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outPath, buf);
}

export class PipelineJobManager {
  constructor() {
    this.jobs = new Map();
    this.activeRuns = new Set();
  }

  createJob() {
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.jobs.set(id, {
      id,
      createdAt: new Date().toISOString(),
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
      opts: null,
      book: null
    });
    return id;
  }

  consumeChapterUpdates(jobId, sinceSeq = 0) {
    const j = this.getJob(jobId);
    if (!j) return { seqNow: sinceSeq, updates: [] };
    const seqNow = Number(j.chapterSeq || 0);
    const updates = Array.isArray(j.chapters)
      ? j.chapters.filter((c) => Number(c.seq || 0) > sinceSeq)
      : [];
    return { seqNow, updates };
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  stop(jobId) {
    const j = this.getJob(jobId);
    if (j) j.stopRequested = true;
  }

  pause(jobId, reason = 'paused') {
    const j = this.getJob(jobId);
    if (!j) return;
    j.pauseRequested = true;
    j.pauseReason = reason;
  }

  resume(jobId) {
    const j = this.getJob(jobId);
    if (!j) return;
    j.pauseRequested = false;
    j.resumeRequested = true;
    j.pauseReason = '';
    j.pausedAt = null;
    if (j.status === 'paused' || j.status === 'stopping') j.status = 'running';
  }

  pushLog(jobId, line) {
    const j = this.getJob(jobId);
    if (!j) return;
    j.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (j.logs.length > 4000) j.logs.splice(0, j.logs.length - 4000);
  }

  _bumpChapter(job, chapNumber, patch) {
    const idx = job.chapters.findIndex((c) => c.number === chapNumber);
    if (idx < 0) return;
    job.chapterSeq = (job.chapterSeq || 0) + 1;
    job.chapters[idx] = {
      ...job.chapters[idx],
      ...patch,
      seq: job.chapterSeq,
      updatedAt: new Date().toISOString()
    };
  }

  _checkPauseStop(job) {
    if (job.stopRequested) {
      job.status = 'stopped';
      return 'stopped';
    }
    if (job.pauseRequested) {
      job.status = 'paused';
      job.pausedAt = new Date().toISOString();
      return 'paused';
    }
    return null;
  }

  consumeNewLogs(jobId) {
    const j = this.getJob(jobId);
    if (!j) return [];
    const out = j.logs.slice(j.logCursor);
    j.logCursor = j.logs.length;
    return out;
  }

  async run(jobId, opts) {
    if (this.activeRuns.has(jobId)) {
      this.pushLog(jobId, 'Already running');
      return;
    }
    this.activeRuns.add(jobId);
    try {
      const j = this.getJob(jobId);
      if (!j) throw new Error('Job not found');

      j.status = 'running';

      // Persist opts for resume.
      if (!j.opts) j.opts = opts;
      await saveJobOnDisk(j);

      const {
        novelId,
        customTitle,
        startChapter,
        endChapter,
        outputPath,
        downloadDelayMs = 150,
        translateDelayMs = 600,
        chunkChars = 4800
      } = opts;

      let book = j.book;
      if (!book) {
        book = await scrapeTomatoBook(novelId, { headless: true });
        j.book = book;
        await saveJobOnDisk(j);
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
      j.progress.total = slice.length;
      if (!Number.isFinite(j.progress.done)) j.progress.done = 0;

      this.pushLog(jobId, `Novel: ${novelTitle}`);
      this.pushLog(jobId, `Chapters: ${slice.length} (${startChapter}..${endChapter})`);
      this.pushLog(jobId, `Output: ${outRoot}`);

      // Initialize per-chapter status list once.
      if (!Array.isArray(j.chapters) || j.chapters.length === 0) {
        j.chapters = slice.map((c) => {
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
        await saveJobOnDisk(j);
      }

      // Download CN chapters
      j.progress.phase = 'download';
      for (let i = 0; i < slice.length; i++) {
        const pauseStop = this._checkPauseStop(j);
        if (pauseStop) {
          await saveJobOnDisk(j);
          return;
        }

        const c = slice[i];
        const idxPrefix = padIndex(c.number, width);
        const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
        const stem = `${idxPrefix} - ${safeTitle}`;

        const chapterId = extractChapterIdFromUrl(c.url);
        if (!chapterId) {
          this.pushLog(jobId, `WARN: cannot extract chapterId from ${c.url}`);
          this._bumpChapter(j, c.number, {
            download: { status: 'failed' },
            error: 'Cannot extract chapterId'
          });
          await saveJobOnDisk(j);
          continue;
        }

        const jsonPath = path.join(cnJsonDir, `${stem}.json`);
        const txtPath = path.join(cnTxtDir, `${stem}.txt`);

        // Skip if already downloaded.
        if ((await fileExists(jsonPath)) && (await fileExists(txtPath))) {
          this._bumpChapter(j, c.number, { download: { status: 'ok' }, error: '' });
          j.progress.done = i + 1;
          await saveJobOnDisk(j);
          continue;
        }

        try {
          this.pushLog(jobId, `Downloading ${stem}`);
          const url = new URL('https://tt.sjmyzq.cn/api/raw_full');
          url.searchParams.set('item_id', String(chapterId));

          const res = await fetch(url, { headers: { 'user-agent': 'tomato-pipeline-app/1.0' } });
          if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
          const raw = await res.json();
          if (raw?.code != null && Number(raw.code) !== 200) throw new Error(`Upstream code=${raw.code}`);

          const parsed = parseRawFullPayload(raw, { itemIdHint: chapterId });
          await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8');
          await fs.writeFile(txtPath, chapterTxt(c.title, parsed.lines), 'utf8');

          this._bumpChapter(j, c.number, { download: { status: 'ok' }, error: '' });
        } catch (err) {
          const offline = isLikelyOfflineError(err);
          this._bumpChapter(j, c.number, {
            download: { status: offline ? 'paused-offline' : 'failed' },
            error: err instanceof Error ? err.message : String(err)
          });
          await saveJobOnDisk(j);

          if (offline) {
            j.pauseRequested = true;
            j.pauseReason = 'offline';
            j.status = 'paused';
            j.pausedAt = new Date().toISOString();
            this.pushLog(jobId, 'Paused: internet appears offline (download).');
            await saveJobOnDisk(j);
            return;
          }

          this.pushLog(jobId, `ERROR downloading ${stem}: ${err instanceof Error ? err.message : String(err)}`);
        }

        j.progress.done = i + 1;
        await saveJobOnDisk(j);
        if (downloadDelayMs > 0) await sleep(downloadDelayMs);
      }

      // Verify downloads
      this.pushLog(jobId, 'Verifying downloads…');
      {
        const missing = [];
        const empty = [];
        for (const c of slice) {
          const idxPrefix = padIndex(c.number, width);
          const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
          const stem = `${idxPrefix} - ${safeTitle}`;
          const jsonPath = path.join(cnJsonDir, `${stem}.json`);
          const txtPath = path.join(cnTxtDir, `${stem}.txt`);

          if (!(await fileExists(jsonPath)) || !(await fileExists(txtPath))) {
            missing.push(stem);
            continue;
          }

          const st = await fs.stat(txtPath);
          if (!st.size) empty.push(stem);
        }
        if (missing.length) throw new Error(`Missing downloaded chapters: ${missing.length}`);
        if (empty.length) throw new Error(`Empty downloaded chapters: ${empty.length}`);
        this.pushLog(jobId, `Download verify OK (${slice.length}/${slice.length})`);
      }

      // Translate
      const client = new TomatoMtlClient({ headless: true });
      const translator = new ChapterTranslator({ client, maxChunkChars: chunkChars, delayMs: translateDelayMs });

      try {
        for (let i = 0; i < slice.length; i++) {
          const pauseStop = this._checkPauseStop(j);
          if (pauseStop) {
            await saveJobOnDisk(j);
            return;
          }

          const c = slice[i];
          j.progress.phase = 'translate';

          const idxPrefix = padIndex(c.number, width);
          const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
          const stem = `${idxPrefix} - ${safeTitle}`;

          const cnPath = path.join(cnTxtDir, `${stem}.txt`);
          const trPath = path.join(trTxtDir, `${stem}.txt`);

          if (await fileExists(trPath)) {
            this._bumpChapter(j, c.number, { translate: { status: 'ok' }, error: '' });
            j.progress.done = i + 1;
            await saveJobOnDisk(j);
            continue;
          }

          this.pushLog(jobId, `Translating ${stem}`);
          try {
            const src = await fs.readFile(cnPath, 'utf8');
            const out = await translator.translateLongText(src, {
              onChunk: async ({ index, total }) => {
                this.pushLog(jobId, `  chunk ${index + 1}/${total}`);
              }
            });
            await fs.writeFile(trPath, out + (out.endsWith('\n') ? '' : '\n'), 'utf8');
            this._bumpChapter(j, c.number, { translate: { status: 'ok' }, error: '' });
          } catch (err) {
            this._bumpChapter(j, c.number, {
              translate: { status: 'failed' },
              error: err instanceof Error ? err.message : String(err)
            });
            this.pushLog(jobId, `ERROR translating ${stem}: ${err instanceof Error ? err.message : String(err)}`);
          }

          j.progress.done = i + 1;
          await saveJobOnDisk(j);
        }
      } finally {
        await client.close();
      }

      // Verify translations
      this.pushLog(jobId, 'Verifying translations…');
      {
        const missing = [];
        const empty = [];
        for (const c of slice) {
          const idxPrefix = padIndex(c.number, width);
          const safeTitle = sanitizePathSegment(c.title, { maxLen: 140 });
          const stem = `${idxPrefix} - ${safeTitle}`;
          const trPath = path.join(trTxtDir, `${stem}.txt`);
          if (!(await fileExists(trPath))) {
            missing.push(stem);
            continue;
          }
          const st = await fs.stat(trPath);
          if (!st.size) empty.push(stem);
        }
        if (missing.length) throw new Error(`Missing translated chapters: ${missing.length}`);
        if (empty.length) throw new Error(`Empty translated chapters: ${empty.length}`);
        this.pushLog(jobId, `Translation verify OK (${slice.length}/${slice.length})`);
      }

      // Package EPUB from translated txt
      const trFiles = (await fs.readdir(trTxtDir)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
      const chaptersForEpub = [];
      for (const f of trFiles) {
        const title = f.replace(/\.txt$/i, '');
        const content = await fs.readFile(path.join(trTxtDir, f), 'utf8');
        chaptersForEpub.push({ number: null, title, content });
      }

      const epubPath = path.join(outRoot, `${novelTitle}.epub`);
      await buildEpub({ outPath: epubPath, novelTitle, novelDescription: book.meta.description, chapters: chaptersForEpub });
      this.pushLog(jobId, `Wrote EPUB: ${epubPath}`);

      const bundlePath = path.join(outRoot, `${novelTitle}.zip`);
      await buildBundleZip({ outPath: bundlePath, rootDir: outRoot });
      this.pushLog(jobId, `Wrote bundle: ${bundlePath}`);

      j.progress.phase = 'done';
      j.progress.done = j.progress.total;
      j.status = 'done';
      await saveJobOnDisk(j);
    } finally {
      this.activeRuns.delete(jobId);
    }
  }
}
