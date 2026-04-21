import crypto from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toInt(v) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = 'job') {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${rand}`;
}

export function chunkTextByLines(text, maxChars) {
  const src = String(text ?? '');
  if (src.length <= maxChars) return [src];

  const lines = src.split(/\r?\n/);
  const chunks = [];
  let buf = '';

  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }

    if (buf) {
      chunks.push(buf);
      buf = '';
    }

    if (line.length <= maxChars) {
      buf = line;
      continue;
    }

    // Hard split extremely long lines
    for (let i = 0; i < line.length; i += maxChars) {
      chunks.push(line.slice(i, i + maxChars));
    }
  }

  if (buf) chunks.push(buf);
  return chunks;
}

export function safeRel(p) {
  return String(p ?? '').replaceAll('\\', '/');
}
