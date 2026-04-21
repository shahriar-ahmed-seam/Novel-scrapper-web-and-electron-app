import fs from 'node:fs/promises';
import { parseRawFullPayload } from './parser.js';

const filePath = process.argv[2];
const outPath = process.argv[3];
if (!filePath) {
  console.error('Usage: node src/parse_local.js <raw_full.json> [out.json]');
  process.exit(1);
}

const rawText = await fs.readFile(filePath, 'utf8');
const raw = JSON.parse(rawText);
const parsed = parseRawFullPayload(raw, { itemIdHint: 'local-file' });

const json = JSON.stringify(parsed, null, 2);

if (outPath) {
  await fs.writeFile(outPath, json, { encoding: 'utf8' });
} else {
  process.stdout.write(json);
}
