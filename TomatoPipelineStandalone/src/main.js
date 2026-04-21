import path from 'node:path';
import { fileURLToPath } from 'node:url';

console.error('[MAIN] Script started');

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createPipelineRuntime } from './core/runtime.js';
import { runCli } from './core/cli.js';

console.error('[MAIN] Imports done');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;

// Prevent multiple running instances from corrupting the persistent browser partition (LOCK/Access denied).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  process.stderr.write('Another instance is already running. Close it first.\n');
  app.exit(1);
  process.exit(1);
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const rendererPath = () => path.join(__dirname, '..', 'renderer', 'index.html');

const CLI_COMMANDS = ['run', 'resume', 'pause', 'stop', 'status', 'jobs', 'load'];

const cliRequested =
  process.argv.includes('cli') ||
  process.argv.includes('--cli') ||
  app.commandLine.hasSwitch('cli');

const hasCliCommand = process.argv.some((a) => CLI_COMMANDS.includes(a));

if (cliRequested && !hasCliCommand) {
  process.stdout.write(
    'Usage: TomatoPipelineStandalone.exe cli <run|resume|pause|stop|status|jobs|load> [args]\n'
  );
  process.exit(2);
}

// CLI mode: execute after app is ready (avoid top-level await deadlock under ESM)
if (cliRequested) {
  console.error('[MAIN] CLI mode');

  app
    .whenReady()
    .then(async () => {
      const code = await runCli({
        argv: process.argv,
        userDataDir: app.getPath('userData'),
        getSwitchValue: (name) => app.commandLine.getSwitchValue(name),
        hasSwitch: (name) => app.commandLine.hasSwitch(name)
      });
      app.exit(code);
      process.exit(code);
    })
    .catch((err) => {
      console.error('[MAIN] CLI fatal: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
      app.exit(1);
      process.exit(1);
    });
}

if (!cliRequested) {
  // GUI mode: use event-based pattern
  app.on('ready', async () => {
    console.error('[MAIN] App ready, creating window...');

    try {
      mainWindow = new BrowserWindow({
        width: 1200,
        height: 820,
        backgroundColor: '#0b1220',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });

      mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      const rt = await createPipelineRuntime({
        userDataDir: app.getPath('userData')
      });

      ipcMain.handle('tp:novel:load', async (_e, { novelId, showBrowser }) => rt.loadNovel({ novelId, showBrowser }));
      ipcMain.handle('tp:run:start', async (_e, opts) => rt.startRun(opts));
      ipcMain.handle('tp:run:pause', async (_e, { jobId, reason }) => rt.pauseRun({ jobId, reason }));
      ipcMain.handle('tp:run:resume', async (_e, { jobId, overrides }) => rt.resumeRun({ jobId, overrides }));
      ipcMain.handle('tp:run:stop', async (_e, { jobId }) => rt.stopRun({ jobId }));
      ipcMain.handle('tp:run:status', async (_e, { jobId, sinceSeq }) => rt.getStatus({ jobId, sinceSeq }));
      ipcMain.handle('tp:run:details', async (_e, { jobId }) => rt.getDetails({ jobId }));
      ipcMain.handle('tp:jobs:list', async (_e, { novelId }) => rt.listJobs({ novelId }));

      const htmlPath = rendererPath();
      console.error('[MAIN] Loading: ' + htmlPath);

      await mainWindow.loadFile(htmlPath);
      const bridgeOk = await mainWindow.webContents.executeJavaScript('Boolean(window.tp && typeof window.tp.loadNovel === "function")', true);
      console.error('[MAIN] Preload bridge ok=' + bridgeOk);
      console.error('[MAIN] Window loaded, showing...');
      mainWindow.show();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MAIN] ERROR: ' + msg);
      dialog.showErrorBox('Error', 'Failed to start app: ' + msg);
      app.exit(1);
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
