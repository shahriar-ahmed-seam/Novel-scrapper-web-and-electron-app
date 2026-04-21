import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TomatoMtlClient } from './tomato_client.js';
import { ChapterTranslator } from './translator.js';
import { createJob, saveJob, appendJobError } from './job_store.js';
import { sleep, toInt } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usageAndExit(code = 1) {
  console.error(
    [
      'Usage:',
      '  node src/batch_translate.js --novelDir <path> [--delayMs 1500] [--maxChunkChars 4800] [--overwrite] [--start 1] [--end 9999]',
      '  node src/batch_translate.js <novelDir> [delayMs]',
      '',
      'Example:',
      '  node src/batch_translate.js --novelDir "../Novels/I Dominate The Cultivation World With The Help Of A Beautiful Army Of Women" --delayMs 1500'
    ].join('\n')
  );
  process.exit(code);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const positionalNovelDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const positionalDelay = positionalNovelDir ? process.argv[3] : null;

  const novelDirArg = getArgValue('--novelDir') ?? positionalNovelDir;
  if (!novelDirArg) usageAndExit(1);

  const delayMs = Math.max(0, toInt(getArgValue('--delayMs') ?? positionalDelay) ?? 1500);
  const maxChunkChars = Math.max(1000, toInt(getArgValue('--maxChunkChars')) ?? 4800);
  const overwrite = hasFlag('--overwrite');
  const start = toInt(getArgValue('--start')) ?? null;
  const end = toInt(getArgValue('--end')) ?? null;

  const novelDir = path.isAbsolute(novelDirArg) ? novelDirArg : path.resolve(process.cwd(), novelDirArg);
  const inputDir = path.join(novelDir, 'txt');
  const outputDir = path.join(novelDir, 'translated', 'txt');

  await ensureDir(outputDir);

  const files = (await fs.readdir(inputDir)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
  if (files.length === 0) throw new Error(`No .txt files found in ${inputDir}`);

  const filtered = files.filter((f) => {
    const m = f.match(/^(\d+)/);
    const idx = m ? toInt(m[1]) : null;
    if (start != null && idx != null && idx < start) return false;
    if (end != null && idx != null && idx > end) return false;
    return true;
  });

  const job = await createJob({
    status: 'running',
    kind: 'batch',
    novelDir,
    progress: {
      totalFiles: filtered.length,
      doneFiles: 0,
      failedFiles: 0,
      currentFile: null,
      totalChunks: 0,
      doneChunks: 0
    }
  });

  console.log(`Job: ${job.id}`);
  console.log(`Input: ${inputDir}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Files: ${filtered.length} (from ${files.length})`);
  console.log(`Chunk: ${maxChunkChars} chars | Delay: ${delayMs}ms`);

  const client = new TomatoMtlClient({ headless: true });
  const translator = new ChapterTranslator({ client, maxChunkChars, delayMs });

  let done = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (let i = 0; i < filtered.length; i++) {
      const name = filtered[i];
      const inPath = path.join(inputDir, name);
      const outPath = path.join(outputDir, name);

      job.progress.currentFile = name;
      await saveJob(job);

      if (!overwrite && (await fileExists(outPath))) {
        skipped++;
        if ((skipped % 25) === 0) console.log(`[skip] ${skipped} skipped so far...`);
        continue;
      }

      const src = await fs.readFile(inPath, 'utf8');
      if (!src.trim()) {
        failed++;
        job.progress.failedFiles = failed;
        await appendJobError(job, { file: name, message: 'Input file is empty' });
        continue;
      }

      process.stdout.write(`[${i + 1}/${filtered.length}] ${name} ... `);

      try {
        let translatedText = '';
        translatedText = await translator.translateLongText(src, {
          onChunk: async ({ index, total }) => {
            job.progress.totalChunks = total;
            job.progress.doneChunks = index;
            await saveJob(job);
          }
        });

        // Basic guard: avoid writing placeholder-like output.
        if (!translatedText.trim()) throw new Error('Translated output is empty');
        if (translatedText.includes('Translation results will appear here')) {
          throw new Error('Translated output looks like placeholder');
        }

        await fs.writeFile(outPath, translatedText + (translatedText.endsWith('\n') ? '' : '\n'), { encoding: 'utf8' });

        done++;
        job.progress.doneFiles = done;
        job.progress.doneChunks = job.progress.totalChunks;
        await saveJob(job);
        console.log('OK');
      } catch (err) {
        failed++;
        job.progress.failedFiles = failed;
        await appendJobError(job, { file: name, message: err instanceof Error ? err.message : String(err) });
        await saveJob(job);
        console.log('FAIL');
        // Give the site a breather on failures too.
        await sleep(2000);
      }
    }

    job.status = failed === 0 ? 'done' : 'done_with_errors';
    await saveJob(job);
    console.log('---');
    console.log(`Finished. done=${done} skipped=${skipped} failed=${failed}`);
    console.log(`Job file: translator_api/jobs/${job.id}.json`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
