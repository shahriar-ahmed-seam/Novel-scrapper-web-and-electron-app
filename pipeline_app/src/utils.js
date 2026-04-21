import fs from 'node:fs/promises';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
