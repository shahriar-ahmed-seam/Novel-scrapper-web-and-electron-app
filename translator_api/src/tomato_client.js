import { chromium } from 'playwright';
import { sleep } from './utils.js';

const TOMATO_URL = 'https://tomatomtl.com/translate';

export class TomatoMtlClient {
  constructor({ headless = true } = {}) {
    this.headless = headless;
    this.browser = null;
    this.context = null;
    this.page = null;
    this._busy = false;
  }

  async init() {
    if (this.page) return;

    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    this.page = await this.context.newPage();
    await this.page.goto(TOMATO_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await this.page.waitForSelector('#inputText', { timeout: 90_000 });
    await this.page.waitForSelector('#btnTranslate', { timeout: 90_000 });
    await this.page.waitForSelector('#translationResult', { timeout: 90_000 });
  }

  async close() {
    try {
      await this.page?.close();
    } catch {}
    try {
      await this.context?.close();
    } catch {}
    try {
      await this.browser?.close();
    } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async _translateOnce(text, { timeoutMs = 180_000 } = {}) {
    await this.init();

    const page = this.page;

    // Clear old output so we never get stuck waiting for a "change" when the
    // website fails to update the box (it can keep the previous translation).
    await page.evaluate(() => {
      const el = document.querySelector('#translationResult');
      if (el) el.innerText = '';
    });

    await page.fill('#inputText', text);
    await page.click('#btnTranslate');

    await page.waitForFunction(
      () => {
        const el = document.querySelector('#translationResult');
        if (!el) return false;
        const t = (el.innerText || '').trim();
        if (!t) return false;
        if (t.includes('Translation results will appear here')) return false;
        return true;
      },
      { timeout: timeoutMs }
    );

    const after = (await page.$eval('#translationResult', (el) => el.innerText)).trim();
    return after;
  }

  async translateText(text, { timeoutMs = 180_000, retry = 2 } = {}) {
    // serialize in-process usage (one page)
    while (this._busy) await sleep(50);
    this._busy = true;
    try {
      let lastErr;
      for (let attempt = 0; attempt <= retry; attempt++) {
        try {
          return await this._translateOnce(text, { timeoutMs });
        } catch (err) {
          lastErr = err;
          // Reload and retry
          try {
            await this.page?.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
          } catch {}
          await sleep(800 + attempt * 800);
        }
      }
      throw lastErr;
    } finally {
      this._busy = false;
    }
  }
}
