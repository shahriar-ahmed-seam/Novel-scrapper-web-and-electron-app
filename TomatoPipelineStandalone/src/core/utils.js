import fs from 'node:fs/promises';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function sanitizePathSegment(input, { maxLen = 140 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return 'Untitled';
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let safe = cleaned.replace(/[. ]+$/g, '').trim();
  if (!safe) safe = 'Untitled';
  if (safe.length > maxLen) safe = safe.slice(0, maxLen).trim();
  safe = safe.replace(/[. ]+$/g, '').trim();
  return safe || 'Untitled';
}

export function extractChapterIdFromUrl(url) {
  const s = String(url ?? '');
  const m = s.match(/\/book\/(\d+)\/(\d+)/);
  if (m) return m[2];
  const tail = s.split('/').filter(Boolean).pop() ?? '';
  if (/^\d+$/.test(tail)) return tail;
  return null;
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function chunkTextByLines(text, maxChars) {
  const s = String(text ?? '');
  if (!s) return [''];

  const lines = s.split(/\n/);
  const out = [];
  let buf = '';

  for (const line of lines) {
    const add = (buf ? '\n' : '') + line;
    if ((buf + add).length > maxChars) {
      if (buf) out.push(buf);
      if (line.length > maxChars) {
        // hard split long lines
        let i = 0;
        while (i < line.length) {
          out.push(line.slice(i, i + maxChars));
          i += maxChars;
        }
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf += add;
    }
  }

  if (buf) out.push(buf);
  return out.length ? out : [''];
}
