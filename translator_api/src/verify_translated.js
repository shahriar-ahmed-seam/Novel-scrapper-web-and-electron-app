import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function usageAndExit(code = 1) {
  console.error('Usage: node src/verify_translated.js --novelDir <path>');
  process.exit(code);
}

async function main() {
  const novelDirArg = getArgValue('--novelDir');
  if (!novelDirArg) usageAndExit(1);

  const novelDir = path.isAbsolute(novelDirArg) ? novelDirArg : path.resolve(process.cwd(), novelDirArg);
  const inputDir = path.join(novelDir, 'txt');
  const outputDir = path.join(novelDir, 'translated', 'txt');

  const inputFiles = (await fs.readdir(inputDir)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
  const outFiles = (await fs.readdir(outputDir)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();

  const outSet = new Set(outFiles);

  let missing = 0;
  let empty = 0;
  let identical = 0;

  for (const f of inputFiles) {
    if (!outSet.has(f)) {
      missing++;
      continue;
    }

    const src = await fs.readFile(path.join(inputDir, f), 'utf8');
    const dst = await fs.readFile(path.join(outputDir, f), 'utf8');

    if (!dst.trim()) empty++;
    if (dst.trim() === src.trim()) identical++;
  }

  console.log(`Input files: ${inputFiles.length}`);
  console.log(`Output files: ${outFiles.length}`);
  console.log(`Missing outputs: ${missing}`);
  console.log(`Empty outputs: ${empty}`);
  console.log(`Identical outputs (suspicious): ${identical}`);

  if (missing || empty) process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
