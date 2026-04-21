import fs from 'node:fs/promises';
import path from 'node:path';

async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Windows may fail to rename over an existing file.
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
    await fs.rename(tmp, filePath);
  }
}

export function createJobStore({ jobsDir }) {
  if (!jobsDir) throw new Error('jobsDir required');

  const dir = jobsDir;

  async function ensure() {
    await fs.mkdir(dir, { recursive: true });
  }

  function jobPath(jobId) {
    return path.join(dir, `${jobId}.json`);
  }

  return {
    jobsDir: dir,

    async create(job) {
      await ensure();
      await atomicWrite(jobPath(job.id), JSON.stringify(job, null, 2));
    },

    async save(job) {
      await ensure();
      job.savedAt = new Date().toISOString();
      await atomicWrite(jobPath(job.id), JSON.stringify(job, null, 2));
    },

    async exists(jobId) {
      try {
        await fs.access(jobPath(jobId));
        return true;
      } catch {
        return false;
      }
    },

    async load(jobId) {
      const raw = await fs.readFile(jobPath(jobId), 'utf8');
      return JSON.parse(raw);
    },

    async list() {
      await ensure();
      const items = await fs.readdir(dir);
      return items
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .map((f) => f.replace(/\.json$/i, ''))
        .sort();
    }
  };
}
