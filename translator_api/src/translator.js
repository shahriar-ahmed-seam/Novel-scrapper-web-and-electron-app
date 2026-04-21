import { chunkTextByLines, sleep } from './utils.js';

export class ChapterTranslator {
  constructor({ client, maxChunkChars = 4800, delayMs = 1500 } = {}) {
    if (!client) throw new Error('ChapterTranslator requires a TomatoMtlClient instance');
    this.client = client;
    this.maxChunkChars = maxChunkChars;
    this.delayMs = delayMs;
  }

  async translateLongText(text, { onChunk, timeoutMsPerChunk = 180_000 } = {}) {
    const chunks = chunkTextByLines(text, this.maxChunkChars);
    const out = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (onChunk) await onChunk({ index: i, total: chunks.length, chunkChars: chunk.length });

      const translated = await this.client.translateText(chunk, { timeoutMs: timeoutMsPerChunk });
      out.push(translated);

      if (this.delayMs > 0 && i !== chunks.length - 1) {
        await sleep(this.delayMs);
      }
    }

    // Join with newlines to preserve rough paragraph structure.
    return out.join('\n');
  }
}
