import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { PipelineJobManager } from './job_runner.js';
import { scrapeTomatoBook } from './tomato_book_scrape.js';
import { createJobOnDisk, jobExists, listJobsOnDisk, loadJobFromDisk, saveJobOnDisk } from './job_store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const jobs = new PipelineJobManager();

async function loadJobsIntoMemory() {
  try {
    const ids = await listJobsOnDisk();
    for (const id of ids) {
      const job = await loadJobFromDisk(id);
      // If the server died mid-run, come back paused.
      if (job.status === 'running' || job.status === 'stopping') {
        job.status = 'paused';
        job.pauseReason = job.pauseReason || 'server-restarted';
        job.pausedAt = job.pausedAt || new Date().toISOString();
      }
      jobs.jobs.set(id, job);
    }
  } catch (err) {
    console.warn('Failed to load jobs from disk:', err);
  }
}

await loadJobsIntoMemory();

app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.post('/api/novel/load', async (req, res) => {
  try {
    const novelId = String(req.body?.novelId ?? '').trim();
    if (!novelId) return res.status(400).json({ ok: false, error: 'novelId required' });
    const data = await scrapeTomatoBook(novelId, { headless: true });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/run/start', async (req, res) => {
  const novelId = String(req.body?.novelId ?? '').trim();
  const outputPath = String(req.body?.outputPath ?? '').trim();
  if (!novelId) return res.status(400).json({ ok: false, error: 'novelId required' });
  if (!outputPath) return res.status(400).json({ ok: false, error: 'outputPath required' });

  const jobId = jobs.createJob();
  await createJobOnDisk(jobs.getJob(jobId));
  jobs.pushLog(jobId, 'Job created');
  await saveJobOnDisk(jobs.getJob(jobId));

  jobs
    .run(jobId, {
      novelId,
      customTitle: req.body?.customTitle,
      startChapter: Number(req.body?.startChapter ?? 1),
      endChapter: Number(req.body?.endChapter ?? 1),
      outputPath,
      downloadDelayMs: Number(req.body?.downloadDelayMs ?? 150),
      translateDelayMs: Number(req.body?.translateDelayMs ?? 600),
      chunkChars: Number(req.body?.chunkChars ?? 4800)
    })
    .catch((err) => {
      const j = jobs.getJob(jobId);
      if (!j) return;
      j.status = 'failed';
      jobs.pushLog(jobId, `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      saveJobOnDisk(j).catch(() => {});
    });

  res.json({ ok: true, jobId });
});

app.get('/api/run/status', (req, res) => {
  const jobId = String(req.query.jobId ?? '');
  const j = jobs.getJob(jobId);
  if (!j) return res.status(404).json({ ok: false, error: 'job not found' });

  const newLogs = jobs.consumeNewLogs(jobId);
  const sinceSeq = Number(req.query.sinceSeq ?? 0);
  const { seqNow, updates } = jobs.consumeChapterUpdates(jobId, Number.isFinite(sinceSeq) ? sinceSeq : 0);
  res.json({
    ok: true,
    job: {
      id: j.id,
      status: j.status,
      pauseReason: j.pauseReason || '',
      progress: j.progress
    },
    newLogs,
    chapterSeq: seqNow,
    chapterUpdates: updates
  });
});

app.get('/api/run/details', async (req, res) => {
  try {
    const jobId = String(req.query.jobId ?? '');
    if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });

    let j = jobs.getJob(jobId);
    if (!j) {
      if (!(await jobExists(jobId))) return res.status(404).json({ ok: false, error: 'job not found' });
      j = await loadJobFromDisk(jobId);
      jobs.jobs.set(jobId, j);
    }

    res.json({
      ok: true,
      data: {
        job: {
          id: j.id,
          status: j.status,
          pauseReason: j.pauseReason || '',
          opts: j.opts || null
        },
        meta: j.book?.meta || null,
        chapters: j.chapters || []
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const novelId = String(req.query.novelId ?? '').trim();
    const ids = await listJobsOnDisk();
    const out = [];
    for (const id of ids) {
      let j = jobs.getJob(id);
      if (!j) {
        try {
          j = await loadJobFromDisk(id);
          jobs.jobs.set(id, j);
        } catch {
          continue;
        }
      }
      if (novelId && String(j?.opts?.novelId ?? '') !== novelId) continue;
      out.push({
        id,
        status: j.status,
        pauseReason: j.pauseReason || '',
        novelId: j?.opts?.novelId || '',
        createdAt: j?.createdAt || '',
        savedAt: j?.savedAt || ''
      });
    }
    res.json({ ok: true, jobs: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/run/pause', async (req, res) => {
  const jobId = String(req.body?.jobId ?? '');
  const reason = String(req.body?.reason ?? 'paused');
  const j = jobs.getJob(jobId);
  if (!j) return res.status(404).json({ ok: false, error: 'job not found' });
  jobs.pause(jobId, reason);
  jobs.pushLog(jobId, `Pause requested (${reason})`);
  await saveJobOnDisk(j);
  res.json({ ok: true });
});

app.post('/api/run/resume', async (req, res) => {
  const jobId = String(req.body?.jobId ?? '');
  let j = jobs.getJob(jobId);
  if (!j) {
    if (!(await jobExists(jobId))) return res.status(404).json({ ok: false, error: 'job not found' });
    j = await loadJobFromDisk(jobId);
    jobs.jobs.set(jobId, j);
  }

  jobs.resume(jobId);
  jobs.pushLog(jobId, 'Resume requested');
  j.status = 'running';
  await saveJobOnDisk(j);

  jobs
    .run(jobId, j.opts || {})
    .catch((err) => {
      const jj = jobs.getJob(jobId);
      if (!jj) return;
      jj.status = 'failed';
      jobs.pushLog(jobId, `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      saveJobOnDisk(jj).catch(() => {});
    });

  res.json({ ok: true });
});

app.post('/api/run/stop', (req, res) => {
  const jobId = String(req.body?.jobId ?? '');
  jobs.stop(jobId);
  jobs.pushLog(jobId, 'Stop requested');
  const j = jobs.getJob(jobId);
  if (j && j.status === 'running') j.status = 'stopping';
  if (j) saveJobOnDisk(j).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'tomato-pipeline-app' });
});

const port = Number(process.env.PORT ?? 5000);
app.listen(port, () => {
  console.log(`Tomato Pipeline App: http://localhost:${port}`);
});
