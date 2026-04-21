import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRawFullPayload } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function usageAndExit(code = 1) {
  console.error(
    [
      'Usage:',
      '  node src/batch_download.js <metadata.json> [--mode local|upstream] [--base <url>] [--overwrite] [--limit <n>] [--start <index>] [--end <index>]',
      '',
      'Defaults:',
      '  --mode local',
      '  --base http://localhost:3000/api/chapter',
      '  --limit 0 (no limit)',
      '',
      'Examples:',
      '  node src/batch_download.js meta_data_novels\\my_novel_metadata.json',
      '  node src/batch_download.js meta.json --mode upstream --base https://tt.sjmyzq.cn/api/raw_full'
    ].join('\n')
  );
  process.exit(code);
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function sanitizePathSegment(input, { maxLen = 140 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return 'Untitled';

  // Windows forbidden chars: < > : " / \ | ? * and control chars
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Avoid trailing dot/space which Windows dislikes
  let safe = cleaned.replace(/[. ]+$/g, '').trim();
  if (!safe) safe = 'Untitled';

  if (safe.length > maxLen) safe = safe.slice(0, maxLen).trim();
  safe = safe.replace(/[. ]+$/g, '').trim();
  return safe || 'Untitled';
}

function padIndex(index, width) {
  return String(index).padStart(width, '0');
}

function extractChapterIdFromUrl(url) {
  const s = String(url ?? '');
  // Expect: .../book/<bookId>/<chapterId>
  const m = s.match(/\/book\/(\d+)\/(\d+)/);
  if (m) return m[2];

  // Fallback: last numeric segment
  const tail = s.split('/').filter(Boolean).pop() ?? '';
  if (/^\d+$/.test(tail)) return tail;

  return null;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const txt = await fs.readFile(p, 'utf8');
  return JSON.parse(txt);
}

async function writeJsonPretty(p, obj) {
  const txt = JSON.stringify(obj, null, 2);
  await fs.writeFile(p, txt, { encoding: 'utf8' });
}

async function writeText(p, text) {
  await fs.writeFile(p, text, { encoding: 'utf8' });
}

async function fetchFromLocalApi(base, chapterId) {
  const url = new URL(`${String(base).replace(/\/$/, '')}/${encodeURIComponent(chapterId)}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Local API HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.ok) throw new Error(`Local API error: ${json?.error ?? 'unknown'}`);
    if (!json?.data) throw new Error('Local API returned ok but missing data');
    return json.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg} (is the local server running at ${url.origin}?)`);
  }
}

async function fetchFromUpstreamRaw(base, chapterId) {
  const url = new URL(String(base));
  url.searchParams.set('item_id', String(chapterId));

  const res = await fetch(url, {
    headers: {
      'user-agent': 'novel-scraper-proxy/1.0 (+batch downloader)'
    }
  });
  if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
  const raw = await res.json();

  if (!raw || typeof raw !== 'object') throw new Error('Upstream returned non-object JSON');
  if (raw.code != null && Number(raw.code) !== 200) throw new Error(`Upstream returned code=${raw.code}`);

  return parseRawFullPayload(raw, { itemIdHint: chapterId });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, { retries = 4, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const backoff = baseDelayMs * Math.pow(2, attempt);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function chapterTxtFromParsed(parsed, chapterTitleForFile) {
  const title = String(chapterTitleForFile ?? parsed?.chapter?.title ?? '').trim();
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const body = lines.map((l) => (l?.text ?? '')).join('\n');
  return title ? `${title}\n\n${body}\n` : `${body}\n`;
}

async function main() {
  const metadataPathArg = process.argv[2];
  if (!metadataPathArg || metadataPathArg.startsWith('--')) usageAndExit(1);

  const mode = (getArgValue('--mode') ?? 'local').toLowerCase();
  const overwrite = hasFlag('--overwrite');
  const limit = toInt(getArgValue('--limit')) ?? 0;
  const delayMs = Math.max(0, toInt(getArgValue('--delay')) ?? 150);
  const startIndex = toInt(getArgValue('--start')) ?? null;
  const endIndex = toInt(getArgValue('--end')) ?? null;

  const baseDefault = mode === 'upstream' ? 'https://tt.sjmyzq.cn/api/raw_full' : 'http://localhost:3000/api/chapter';
  const base = getArgValue('--base') ?? baseDefault;

  const metadataPath = path.isAbsolute(metadataPathArg)
    ? metadataPathArg
    : path.join(rootDir, metadataPathArg);

  const metadata = await readJson(metadataPath);
  const novelTitle = sanitizePathSegment(metadata.title ?? 'Unknown Novel', { maxLen: 120 });

  const chapters = Array.isArray(metadata.chapters) ? metadata.chapters : [];
  if (chapters.length === 0) {
    throw new Error('metadata.chapters is empty or missing');
  }

  const width = String(metadata.total ?? chapters.length).length;

  const novelsDir = path.join(rootDir, 'Novels');
  const novelDir = path.join(novelsDir, novelTitle);
  const jsonDir = path.join(novelDir, 'json');
  const txtDir = path.join(novelDir, 'txt');

  await ensureDir(jsonDir);
  await ensureDir(txtDir);

  // Extract chapter IDs and write a temporary listing.
  const extracted = chapters
    .map((c) => {
      const id = extractChapterIdFromUrl(c?.url);
      return {
        index: c?.index,
        title: c?.title,
        url: c?.url,
        chapterId: id
      };
    })
    .filter((x) => x.chapterId);

  if (extracted.length === 0) {
    throw new Error('No chapter IDs could be extracted from metadata URLs');
  }

  await writeText(
    path.join(novelDir, 'chapter_ids.txt'),
    extracted.map((x) => `${x.index}\t${x.chapterId}\t${x.title}`).join('\n') + '\n'
  );

  const errorsLogPath = path.join(novelDir, 'errors.log');
  await writeText(errorsLogPath, '');

  const seenFileStems = new Map();

  const filtered = extracted.filter((c) => {
    const idx = toInt(c.index);
    if (startIndex != null && idx != null && idx < startIndex) return false;
    if (endIndex != null && idx != null && idx > endIndex) return false;
    return true;
  });

  const runList = limit > 0 ? filtered.slice(0, limit) : filtered;

  console.log(`Novel: ${novelTitle}`);
  console.log(`Chapters in metadata: ${chapters.length}`);
  console.log(`Chapters extracted: ${extracted.length}`);
  console.log(`Chapters to process now: ${runList.length}`);
  console.log(`Mode: ${mode} | Base: ${base}`);
  console.log(`Output: ${novelDir}`);
  console.log(`Delay: ${delayMs}ms between requests`);

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < runList.length; i++) {
    const c = runList[i];
    const idx = toInt(c.index) ?? (i + 1);
    const idxPrefix = padIndex(idx, width);
    const safeChapterTitle = sanitizePathSegment(c.title ?? `Chapter ${idx}`, { maxLen: 140 });

    // Ensure uniqueness even if titles repeat.
    const baseStem = `${idxPrefix} - ${safeChapterTitle}`;
    const existing = seenFileStems.get(baseStem) ?? 0;
    seenFileStems.set(baseStem, existing + 1);
    const stem = existing === 0 ? baseStem : `${baseStem} (${existing + 1})`;

    const jsonPath = path.join(jsonDir, `${stem}.json`);
    const txtPath = path.join(txtDir, `${stem}.txt`);

    const jsonExists = await fileExists(jsonPath);
    const txtExists = await fileExists(txtPath);

    if (!overwrite && jsonExists && txtExists) {
      skipCount++;
      if ((skipCount % 25) === 0) {
        console.log(`[skip] ${skipCount} skipped so far...`);
      }
      continue;
    }

    process.stdout.write(`[${i + 1}/${runList.length}] ${stem} ... `);

    try {
      const parsed = await withRetries(async () => {
        return mode === 'upstream'
          ? await fetchFromUpstreamRaw(base, c.chapterId)
          : await fetchFromLocalApi(base, c.chapterId);
      });

      // Minimal sanity checks
      if (!parsed || typeof parsed !== 'object') throw new Error('Parsed payload is not an object');
      if (!Array.isArray(parsed.lines)) throw new Error('Parsed payload missing lines[]');

      await writeJsonPretty(jsonPath, parsed);
      const txt = chapterTxtFromParsed(parsed, c.title);
      await writeText(txtPath, txt);

      okCount++;
      console.log('OK');
    } catch (err) {
      failCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log('FAIL');
      await fs.appendFile(
        errorsLogPath,
        `${new Date().toISOString()}\tindex=${c.index}\tchapterId=${c.chapterId}\t${c.title}\t${msg}\n`,
        { encoding: 'utf8' }
      );
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  console.log('---');
  console.log(`Done. OK=${okCount} SKIP=${skipCount} FAIL=${failCount}`);

  // Verification pass (only for chapters attempted/expected in this run window)
  console.log('Verifying output files...');
  const jsonFiles = await fs.readdir(jsonDir);
  const txtFiles = await fs.readdir(txtDir);

  const jsonSet = new Set(jsonFiles.filter((f) => f.toLowerCase().endsWith('.json')));
  const txtSet = new Set(txtFiles.filter((f) => f.toLowerCase().endsWith('.txt')));

  let verifyOk = 0;
  let verifyBad = 0;

  for (const f of jsonSet) {
    const twin = f.replace(/\.json$/i, '.txt');
    if (!txtSet.has(twin)) {
      verifyBad++;
      await fs.appendFile(errorsLogPath, `${new Date().toISOString()}\tmissing_txt\t${f}\n`, { encoding: 'utf8' });
      continue;
    }

    try {
      const p = path.join(jsonDir, f);
      const parsed = await readJson(p);
      if (!Array.isArray(parsed?.lines) || parsed.lines.length === 0) {
        throw new Error('lines[] missing or empty');
      }
      verifyOk++;
    } catch (err) {
      verifyBad++;
      const msg = err instanceof Error ? err.message : String(err);
      await fs.appendFile(errorsLogPath, `${new Date().toISOString()}\tbad_json\t${f}\t${msg}\n`, { encoding: 'utf8' });
    }
  }

  console.log(`Verification: OK=${verifyOk} BAD=${verifyBad}`);
  console.log(`Errors log: ${errorsLogPath}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
