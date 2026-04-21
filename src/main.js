import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

console.error('[MAIN] Script started');

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createPipelineRuntime } from './core/runtime.js';
import { runCli } from './core/cli.js';

console.error('[MAIN] Imports done');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

console.error('[MAIN] isDev=' + isDev);

const rendererPath = () => {
  return path.join(__dirname, '..', 'renderer', 'index.html');
};

const CLI_COMMANDS = ['run', 'resume', 'pause', 'stop', 'status', 'jobs', 'load'];

const cliRequested =
  process.argv.includes('cli') ||
  process.argv.includes('--cli') ||
  app.commandLine.hasSwitch('cli');

const hasCliCommand = process.argv.some((a) => CLI_COMMANDS.includes(a));

if (cliRequested && !hasCliCommand) {
  process.stdout.write(
    'Usage: TomatoPipelineStandalone.exe cli <run|resume|pause|stop|status|jobs|load> [args]\n' +
      '   or: TomatoPipelineStandalone.exe --cli <run|resume|pause|stop|status|jobs|load> [args]\n'
  );
  process.exit(2);
}

// CLI mode
if (cliRequested) {
  console.error('[MAIN] CLI mode');
  await app.whenReady();
  const code = await runCli({
    argv: process.argv,
    userDataDir: app.getPath('userData'),
    getSwitchValue: (name) => app.commandLine.getSwitchValue(name),
    hasSwitch: (name) => app.commandLine.hasSwitch(name)
  });
  app.exit(code);
}

// GUI mode
app.on('ready', async () => {
  console.error('[MAIN] Creating window...');

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: '#0b1220',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const htmlPath = rendererPath();
  console.error('[MAIN] Loading: ' + htmlPath);

  try {
    await win.loadFile(htmlPath);
    console.error('[MAIN] Window loaded');
    win.show();
  } catch (err) {
    console.error('[MAIN] ERROR: ' + (err instanceof Error ? err.message : String(err)));
    dialog.showErrorBox('Error', 'Failed to load UI. Check console.');
    app.exit(1);
    return;
  }

  const rt = await createPipelineRuntime({
    userDataDir: app.getPath('userData')
  });

  ipcMain.handle('tp:novel:load', async (_e, { novelId, showBrowser }) => rt.loadNovel({ novelId, showBrowser }));
  ipcMain.handle('tp:run:start', async (_e, opts) => rt.startRun(opts));
  ipcMain.handle('tp:run:pause', async (_e, { jobId, reason }) => rt.pauseRun({ jobId, reason }));
  ipcMain.handle('tp:run:resume', async (_e, { jobId }) => rt.resumeRun({ jobId }));
  ipcMain.handle('tp:run:stop', async (_e, { jobId }) => rt.stopRun({ jobId }));
  ipcMain.handle('tp:run:status', async (_e, { jobId, sinceSeq }) => rt.getStatus({ jobId, sinceSeq }));
  ipcMain.handle('tp:run:details', async (_e, { jobId }) => rt.getDetails({ jobId }));
  ipcMain.handle('tp:jobs:list', async (_e, { novelId }) => rt.listJobs({ novelId }));
});

app.on('window-all-closed', () => {
  app.quit();
});
