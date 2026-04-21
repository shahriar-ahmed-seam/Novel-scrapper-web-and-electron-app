import { createHiddenWindow, waitForSelector, evalInPage } from './browser_automation.js';
import { chunkTextByLines, sleep } from './utils.js';

const TRANSLATE_URL = 'https://tomatomtl.com/translate';

export class TomatoTranslator {
  constructor({ showBrowser = false, partition = 'persist:tp', delayMs = 600, maxChunkChars = 4800 } = {}) {
    this.showBrowser = !!showBrowser;
    this.partition = partition;
    this.delayMs = delayMs;
    this.maxChunkChars = maxChunkChars;
    this.win = null;
    this._busy = false;
  }

  async init() {
    if (this.win) return;
    this.win = await createHiddenWindow({ show: this.showBrowser, partition: this.partition });

    try {
      await Promise.race([
        this.win.loadURL(TRANSLATE_URL, { waitUntil: 'domcontentloaded' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Load translate page timeout')), 90_000))
      ]);
      await waitForSelector(this.win.webContents, '#inputText', { timeoutMs: 90_000 });
      await waitForSelector(this.win.webContents, '#btnTranslate', { timeoutMs: 90_000 });
      await waitForSelector(this.win.webContents, '#translationResult', { timeoutMs: 90_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to open translator. Try setting "Show browser" to On (login/captcha). (${msg})`);
    }
  }

  async close() {
    if (!this.win) return;
    try { this.win.close(); } catch {}
    this.win = null;
  }

  async translateChunk(text, { timeoutMs = 180_000 } = {}) {
    await this.init();

    // serialize one window
    while (this._busy) await sleep(50);
    this._busy = true;

    try {
      if (this.showBrowser && this.win && !this.win.isDestroyed()) {
        try { this.win.show(); } catch {}
        try { this.win.focus(); } catch {}
      }

      const wc = this.win.webContents;
      try { wc.focus(); } catch {}

      // Some sites ignore programmatic .click() until the first real user gesture.
      // Drive a "trusted" interaction via sendInputEvent (mouse + keyboard), and keep nudging
      // periodically in case the page drops the first event.
      // Guard against a common failure mode:
      // - we click translate
      // - the page re-renders and briefly shows the *previous* result
      // - our poller returns that stale result, causing chapter N to be saved as chapter N-1
      // To prevent this, we capture prev output, clear it, and only accept output that
      // (a) is different from prev output and (b) stays stable briefly.
      const reqId = `tp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const wrappedText = `[[${reqId}:START]]\n${String(text)}\n[[${reqId}:END]]`;

      const pos = await evalInPage(
        wc,
        `(() => {
          const input = document.querySelector('#inputText');
          const btn = document.querySelector('#btnTranslate');
          const out = document.querySelector('#translationResult');
          if (!input || !btn || !out) throw new Error('Missing translate DOM');

          const prev = String(out.textContent || '').trim();

          // Try to clear any prior result in a way that survives framework re-renders.
          try { out.textContent = ''; } catch {}
          try { out.innerText = ''; } catch {}
          try { out.innerHTML = ''; } catch {}

          // Some pages also keep a separate state; click a clear button if present.
          const clearBtn = document.querySelector('#btnClear, .btn-clear, button[aria-label="Clear"], button[title="Clear"]');
          if (clearBtn && typeof clearBtn.click === 'function') {
            try { clearBtn.click(); } catch {}
          }

          input.focus();

          // Use native setter so framework-managed inputs (React/Vue) always notice updates.
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

          if (desc && typeof desc.set === 'function') {
            desc.set.call(input, ${JSON.stringify(String(wrappedText))});
          } else {
            input.value = ${JSON.stringify(String(wrappedText))};
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { btn.focus(); } catch {}

          const r = btn.getBoundingClientRect();
          const x = Math.floor(r.left + r.width / 2);
          const y = Math.floor(r.top + r.height / 2);
          const dpr = Number(window.devicePixelRatio || 1);
          return { x, y, dpr, prev };
        })()`,
        { timeoutMs: 10_000 }
      );

      const clickAt = (x, y) => {
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      };

      const pressKey = (keyCode, modifiers = []) => {
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };

      const x = Number(pos?.x);
      const y = Number(pos?.y);
      const dpr = Number(pos?.dpr || 1);
      const prevOut = String(pos?.prev || '').trim();
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Missing translate DOM');

      const kick = () => {
        // Try both coordinate spaces to survive DPI/zoom quirks.
        clickAt(x, y);
        if (Number.isFinite(dpr) && dpr > 1.01) clickAt(Math.round(x * dpr), Math.round(y * dpr));
        pressKey('Enter');
        pressKey('Enter', ['control']);
        pressKey('Space');
      };

      const start = Date.now();
      let kickCount = 0;
      let nextKickAt = start + 1500;

      let lastText = '';
      let lastChangedAt = 0;

      kick();
      kickCount += 1;

      while (Date.now() - start < timeoutMs) {
        const snap = await Promise.race([
          wc.executeJavaScript(
            `(() => {
              const out = document.querySelector('#translationResult');
              const btn = document.querySelector('#btnTranslate');
              return {
                text: out ? (out.innerText || out.textContent || '') : '',
                btnDisabled: !!(btn && btn.disabled)
              };
            })()`,
            true
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Page eval timeout')), 2_000))
        ]).catch(() => ({ text: '', btnDisabled: false }));

        const t = String(snap?.text || '').trim();
        const btnDisabled = !!snap?.btnDisabled;

        // Ignore placeholders and stale previous output.
        if (!t) {
          const now0 = Date.now();
          if (!btnDisabled && now0 >= nextKickAt && kickCount < 30) {
            kick();
            kickCount += 1;
            nextKickAt = now0 + 3000;
          }
          await sleep(200);
          continue;
        }
        if (t.includes('Translation results will appear here')) {
          const now1 = Date.now();
          if (!btnDisabled && now1 >= nextKickAt && kickCount < 30) {
            kick();
            kickCount += 1;
            nextKickAt = now1 + 3000;
          }
          await sleep(200);
          continue;
        }
        if (prevOut && t === prevOut) {
          const now2 = Date.now();
          if (!btnDisabled && now2 >= nextKickAt && kickCount < 30) {
            kick();
            kickCount += 1;
            nextKickAt = now2 + 3000;
          }
          await sleep(200);
          continue;
        }

        // Require stability: only accept text that hasn't changed for a short window.
        const now = Date.now();
        if (t !== lastText) {
          lastText = t;
          lastChangedAt = now;
        }

        const stableForMs = now - (lastChangedAt || now);
        if (stableForMs < 800) {
          // still changing
          await sleep(200);
          continue;
        }

        // Prefer a marker match when possible; strip markers out of the returned text.
        if (t.includes(reqId)) {
          const cleaned = t
            .replace(new RegExp(`\\[\\[${reqId}:START\\]\\]\\s*`, 'g'), '')
            .replace(new RegExp(`\\s*\\[\\[${reqId}:END\\]\\]`, 'g'), '')
            .trim();
          if (cleaned) return cleaned;
          // If markers present but cleaned empty, keep waiting.
          await sleep(200);
          continue;
        }

        // Marker got translated/removed: accept stable non-stale output.
        return t;
      }

      throw new Error('Translate timeout');
    } finally {
      this._busy = false;
    }
  }

  async translateLongText(text, { onChunk, timeoutMs } = {}) {
    const chunks = chunkTextByLines(text, this.maxChunkChars);
    const out = [];

    for (let i = 0; i < chunks.length; i++) {
      if (onChunk) await onChunk({ index: i, total: chunks.length, chunkChars: chunks[i].length });
      const tr = await this.translateChunk(chunks[i], timeoutMs != null ? { timeoutMs } : {});
      out.push(tr);
      if (this.delayMs > 0 && i !== chunks.length - 1) await sleep(this.delayMs);
    }

    return out.join('\n');
  }
}
