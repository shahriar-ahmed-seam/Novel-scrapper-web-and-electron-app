import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRawFullPayload } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const RAW_FULL_BASE = process.env.RAW_FULL_BASE ?? 'https://tt.sjmyzq.cn/api/raw_full';
const USE_MOCK = (process.env.NOVEL_API_MOCK ?? '').toLowerCase() === '1' || (process.env.NOVEL_API_MOCK ?? '').toLowerCase() === 'true';

const app = express();
app.use(cors());
app.use(express.static(path.join(rootDir, 'public')));

async function fetchRawFullJson(itemId) {
  const url = new URL(RAW_FULL_BASE);
  url.searchParams.set('item_id', String(itemId));

  const res = await fetch(url, {
    headers: {
      'user-agent': 'novel-scraper-proxy/1.0 (+local dev)'
    }
  });

  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }

  return await res.json();
}

async function readLocalRawFull() {
  const p = path.join(rootDir, 'raw_full.json');
  const text = await fs.readFile(p, 'utf8');
  return JSON.parse(text);
}

app.get('/api/chapter/:itemId', async (req, res) => {
  const itemId = String(req.params.itemId ?? '').trim();
  if (!itemId) {
    return res.status(400).json({ error: 'Missing itemId' });
  }

  const mode = String(req.query.mode ?? '').toLowerCase();
  const forceMock = mode === 'mock';

  try {
    const raw = (USE_MOCK || forceMock) ? await readLocalRawFull() : await fetchRawFullJson(itemId);
    if (!raw || typeof raw !== 'object') {
      throw new Error('Upstream returned non-object JSON');
    }
    if (raw.code != null && Number(raw.code) !== 200) {
      throw new Error(`Upstream returned code=${raw.code}`);
    }
    const parsed = parseRawFullPayload(raw, { itemIdHint: itemId });

    // If mock file is for a different chapter, still return it, but surface the mismatch.
    const mismatch = parsed.itemId && itemId && parsed.itemId !== itemId;

    return res.json({
      ok: true,
      mismatch,
      data: parsed
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Fallback to local mock when upstream fails.
    try {
      const raw = await readLocalRawFull();
      const parsed = parseRawFullPayload(raw, { itemIdHint: itemId });
      const mismatch = parsed.itemId && itemId && parsed.itemId !== itemId;
      return res.status(200).json({
        ok: true,
        fallbackMock: true,
        mismatch,
        upstreamError: message,
        data: parsed
      });
    } catch {
      return res.status(502).json({ ok: false, error: message });
    }
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running: http://localhost:${PORT}`);
});
