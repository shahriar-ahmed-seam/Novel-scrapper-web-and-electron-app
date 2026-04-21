import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// pipeline_app/src -> pipeline_app/jobs
const JOBS_DIR = path.join(__dirname, '..', 'jobs');

async function ensureJobsDir() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

function jobPath(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

export function getJobsDir() {
  return JOBS_DIR;
}

async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function createJobOnDisk(job) {
  await ensureJobsDir();
  await atomicWrite(jobPath(job.id), JSON.stringify(job, null, 2));
}

export async function saveJobOnDisk(job) {
  await ensureJobsDir();
  job.savedAt = new Date().toISOString();
  await atomicWrite(jobPath(job.id), JSON.stringify(job, null, 2));
}

export async function loadJobFromDisk(jobId) {
  const p = jobPath(jobId);
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

export async function jobExists(jobId) {
  try {
    await fs.access(jobPath(jobId));
    return true;
  } catch {
    return false;
  }
}

export async function listJobsOnDisk() {
  await ensureJobsDir();
  const items = await fs.readdir(JOBS_DIR);
  return items
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => f.replace(/\.json$/i, ''))
    .sort();
}
