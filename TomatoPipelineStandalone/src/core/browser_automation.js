import { BrowserWindow, session } from 'electron';
import { sleep } from './utils.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function createIsolatedSession(partitionName) {
  const part = `persist:${partitionName}`;
  const ses = session.fromPartition(part, { cache: true });

  // reduce surface area
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setSpellCheckerEnabled(false);

  return ses;
}

export async function createHiddenWindow({ show = false, partition = 'persist:tp', userAgent = DEFAULT_UA } = {}) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !!show,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setUserAgent(userAgent);

  return win;
}

export async function waitForSelector(
  webContents,
  selector,
  { timeoutMs = 30_000, pollMs = 200, jsTimeoutMs = 2_000 } = {}
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (webContents.isDestroyed()) throw new Error('WebContents destroyed');

    const code = `Boolean(document && document.querySelector(${JSON.stringify(selector)}))`;

    let ok = false;
    try {
      ok = await Promise.race([
        webContents.executeJavaScript(code, true),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeJavaScript timeout')), jsTimeoutMs))
      ]);
    } catch {
      // Treat per-call JS stalls as a transient condition; keep looping until overall timeout.
      ok = false;
    }

    if (ok) return;
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

export async function evalInPage(webContents, js, { timeoutMs = 60_000 } = {}) {
  // executeJavaScript itself has no built-in timeout; enforce outside.
  const p = webContents.executeJavaScript(js, true);
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error('Page eval timeout')), timeoutMs));
  return await Promise.race([p, t]);
}
