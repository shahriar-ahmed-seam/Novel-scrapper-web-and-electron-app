import { chromium } from 'playwright';

const BOOK_URL = (novelId) => `https://tomatomtl.com/book/${encodeURIComponent(novelId)}`;

export async function scrapeTomatoBook(novelId, { headless = true } = {}) {
  const browser = await chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    const page = await ctx.newPage();
    await page.goto(BOOK_URL(novelId), { waitUntil: 'domcontentloaded', timeout: 90_000 });

    // Wait for meta.
    await page.waitForSelector('#book_name', { timeout: 30_000 });

    // Expand accordions to load all chapters.
    const expandButtons = await page.$$('.accordion-button');
    for (const btn of expandButtons) {
      const expanded = await btn.getAttribute('aria-expanded');
      if (expanded === 'false') await btn.click().catch(() => {});
    }

    // Wait until chapter links stabilize.
    await page.waitForFunction(() => {
      const links = document.querySelectorAll('a.chapter-link');
      return links && links.length > 0;
    }, null, { timeout: 30_000 });

    // Stabilize for ~800ms.
    await page.waitForFunction(() => {
      const w = window;
      const count = document.querySelectorAll('a.chapter-link').length;
      if (!w.__chapCount) {
        w.__chapCount = count;
        w.__chapStable = 0;
        w.__chapLast = Date.now();
        return false;
      }
      if (count === w.__chapCount) {
        w.__chapStable += (Date.now() - w.__chapLast);
      } else {
        w.__chapCount = count;
        w.__chapStable = 0;
      }
      w.__chapLast = Date.now();
      return w.__chapStable >= 800;
    }, null, { timeout: 30_000 });

    const data = await page.evaluate(() => {
      const getText = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
      const title = getText(document.querySelector('#book_name')) || 'Unknown Novel';
      const description = getText(document.querySelector('#description')) || '';
      const coverEl = document.querySelector('#book_cover');
      const coverUrl = coverEl?.getAttribute('data-src') || coverEl?.src || '';

      const links = Array.from(document.querySelectorAll('a.chapter-link'));
      const chapters = links.map((a, idx) => {
        const url = new URL(a.getAttribute('href') || a.href || '', location.href).href;
        const t = getText(a) || url;
        return { number: idx + 1, title: t, url };
      });

      // De-dupe by url while preserving order
      const seen = new Set();
      const uniq = [];
      for (const c of chapters) {
        if (!c.url || seen.has(c.url)) continue;
        seen.add(c.url);
        uniq.push(c);
      }

      const cleaned = uniq.map((c, i) => ({ ...c, number: i + 1 }));

      return {
        meta: { title, description, coverUrl, sourceUrl: location.href },
        chapters: cleaned
      };
    });

    await ctx.close();

    if (!data?.chapters?.length) throw new Error('No chapters found');
    return data;
  } finally {
    await browser.close();
  }
}
