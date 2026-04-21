import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, makeId } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jobsDir = path.resolve(__dirname, '..', 'jobs');

async function ensureJobsDir() {
  await fs.mkdir(jobsDir, { recursive: true });
}

export async function createJob(initial = {}) {
  await ensureJobsDir();
  const id = makeId('translate');
  const job = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'queued',
    progress: {
      totalFiles: 0,
      doneFiles: 0,
      failedFiles: 0,
      currentFile: null,
      totalChunks: 0,
      doneChunks: 0
    },
    errors: [],
    ...initial
  };
  await saveJob(job);
  return job;
}

export async function loadJob(id) {
  await ensureJobsDir();
  const p = path.join(jobsDir, `${id}.json`);
  const txt = await fs.readFile(p, 'utf8');
  return JSON.parse(txt);
}

export async function saveJob(job) {
  await ensureJobsDir();
  const p = path.join(jobsDir, `${job.id}.json`);
  const next = { ...job, updatedAt: nowIso() };
  await fs.writeFile(p, JSON.stringify(next, null, 2), { encoding: 'utf8' });
  return next;
}

export async function appendJobError(job, error) {
  const e = {
    at: nowIso(),
    ...error
  };
  const next = { ...job, errors: [...(job.errors ?? []), e] };
  return await saveJob(next);
}
