import express from 'express';
import cors from 'cors';
import { TomatoMtlClient } from './tomato_client.js';
import { ChapterTranslator } from './translator.js';
import { createJob, saveJob, appendJobError } from './job_store.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const port = Number(process.env.PORT ?? 4000);

const client = new TomatoMtlClient({ headless: true });
const translator = new ChapterTranslator({ client, maxChunkChars: 4800, delayMs: 1500 });

app.get('/health', async (_req, res) => {
  res.json({ ok: true, service: 'tomato-translator-api', port });
});

app.post('/translate', async (req, res) => {
  const text = req.body?.text;
  const delayMs = req.body?.delayMs;
  const maxChunkChars = req.body?.maxChunkChars;

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing body.text' });
  }

  const job = await createJob({
    status: 'running',
    kind: 'single',
    progress: {
      totalFiles: 1,
      doneFiles: 0,
      failedFiles: 0,
      currentFile: 'inline',
      totalChunks: 0,
      doneChunks: 0
    }
  });

  try {
    const tmpTranslator = new ChapterTranslator({
      client,
      maxChunkChars: Number.isFinite(Number(maxChunkChars)) ? Number(maxChunkChars) : 4800,
      delayMs: Number.isFinite(Number(delayMs)) ? Number(delayMs) : 1500
    });

    const translatedText = await tmpTranslator.translateLongText(text, {
      onChunk: async ({ index, total }) => {
        job.progress.totalChunks = total;
        job.progress.doneChunks = index;
        await saveJob(job);
      }
    });

    job.status = 'done';
    job.progress.doneFiles = 1;
    job.progress.doneChunks = job.progress.totalChunks;
    await saveJob(job);

    res.json({ ok: true, jobId: job.id, translatedText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.status = 'failed';
    job.progress.failedFiles = 1;
    await appendJobError(job, { message: msg });
    res.status(500).json({ ok: false, jobId: job.id, error: msg });
  }
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const { loadJob } = await import('./job_store.js');
    const job = await loadJob(req.params.id);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(404).json({ ok: false, error: 'Job not found' });
  }
});

process.on('SIGINT', async () => {
  await client.close();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Tomato Translator API listening on http://localhost:${port}`);
});
