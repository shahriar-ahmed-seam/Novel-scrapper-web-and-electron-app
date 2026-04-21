import { createHiddenWindow, waitForSelector, evalInPage } from './browser_automation.js';

const BOOK_URL = (novelId) => `https://tomatomtl.com/book/${encodeURIComponent(novelId)}`;

export async function scrapeTomatoBook(novelId, { showBrowser = false, partition = 'persist:tp' } = {}) {
  const win = await createHiddenWindow({ show: showBrowser, partition });

  try {
    await Promise.race([
      win.loadURL(BOOK_URL(novelId), { waitUntil: 'domcontentloaded' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Load book page timeout')), 90_000))
    ]);
    await waitForSelector(win.webContents, '#book_name', { timeoutMs: 60_000 });

    // expand accordions
    await evalInPage(
      win.webContents,
      `(() => {
        const btns = Array.from(document.querySelectorAll('.accordion-button'));
        for (const b of btns) {
          if (b.getAttribute('aria-expanded') === 'false') b.click();
        }
      })()`
    );

    // wait for chapter links
    await waitForSelector(win.webContents, 'a.chapter-link', { timeoutMs: 60_000 });

    // stabilize count
    await evalInPage(
      win.webContents,
      `(() => new Promise((resolve, reject) => {
        const start = Date.now();
        let last = -1;
        let stableMs = 0;
        let lastT = Date.now();
        const tick = () => {
          const now = Date.now();
          const count = document.querySelectorAll('a.chapter-link').length;
          if (count === last) stableMs += (now - lastT);
          else { last = count; stableMs = 0; }
          lastT = now;

          if (count > 0 && stableMs >= 800) return resolve(true);
          if (now - start > 30000) return resolve(true);
          setTimeout(tick, 150);
        };
        tick();
      }))()`
    );

    const data = await evalInPage(
      win.webContents,
      `(() => {
        const getText = (el) => (el?.innerText ?? el?.textContent ?? '').trim();
        const title = getText(document.querySelector('#book_name')) || 'Unknown Novel';
        const description = getText(document.querySelector('#description')) || '';
        const coverEl = document.querySelector('#book_cover');
        const coverUrl = coverEl?.getAttribute('data-src') || coverEl?.src || '';

        const links = Array.from(document.querySelectorAll('a.chapter-link'));
        const chapters = links.map((a, idx) => {
          const href = a.getAttribute('href') || a.href || '';
          const url = new URL(href, location.href).href;
          const t = getText(a) || url;
          return { number: idx + 1, title: t, url };
        });

        const seen = new Set();
        const uniq = [];
        for (const c of chapters) {
          if (!c.url || seen.has(c.url)) continue;
          seen.add(c.url);
          uniq.push(c);
        }

        return {
          meta: { title, description, coverUrl, sourceUrl: location.href },
          chapters: uniq.map((c, i) => ({ ...c, number: i + 1 }))
        };
      })()`
    );

    if (!data?.chapters?.length) throw new Error('No chapters found');
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load novel. Try setting "Show browser" to On (login/captcha). (${msg})`);
  } finally {
    try { win.close(); } catch {}
  }
}
