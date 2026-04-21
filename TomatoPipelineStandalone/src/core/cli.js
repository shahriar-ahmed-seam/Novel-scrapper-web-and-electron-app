import path from 'node:path';
import { createPipelineRuntime } from './runtime.js';
import { sleep } from './utils.js';

function getOpt(ctx, name, def = null) {
  const fromArgv = () => {
    const flag = `--${name}`;
    const idx = ctx.argv.indexOf(flag);
    if (idx < 0) return def;
    const v = ctx.argv[idx + 1];
    return v == null ? def : v;
  };

  if (typeof ctx.getSwitchValue === 'function') {
    // Some Electron/Chromium builds normalize switch names; fall back to argv parsing.
    const v1 = ctx.getSwitchValue(name);
    if (v1 != null && String(v1).length) return String(v1);

    const v2 = ctx.getSwitchValue(String(name).toLowerCase());
    if (v2 != null && String(v2).length) return String(v2);

    return fromArgv();
  }

  return fromArgv();
}

function hasOpt(ctx, name) {
  const flag1 = `--${name}`;
  const flag2 = `--${String(name).toLowerCase()}`;

  if (typeof ctx.hasSwitch === 'function') {
    return !!(ctx.hasSwitch(name) || ctx.hasSwitch(String(name).toLowerCase()) || ctx.argv.includes(flag1) || ctx.argv.includes(flag2));
  }

  return ctx.argv.includes(flag1) || ctx.argv.includes(flag2);
}

export async function runCli({ argv, userDataDir, getSwitchValue, hasSwitch }) {
  const ctx = { argv, getSwitchValue, hasSwitch };
  const rt = await createPipelineRuntime({ userDataDir });

  const cmd = argv.find((a) => ['run', 'resume', 'pause', 'stop', 'status', 'jobs', 'load'].includes(a));
  const cmdIdx = argv.findIndex((a) => ['run', 'resume', 'pause', 'stop', 'status', 'jobs', 'load'].includes(a));
  const afterCmd = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : [];

  if (!cmd) {
    console.log('Usage: TomatoPipelineStandalone.exe cli <run|resume|pause|stop|status|jobs|load> [args]');
    return 2;
  }

  try {
    if (cmd === 'load') {
      let novelId = getOpt(ctx, 'novelId');
      const showBrowser = hasOpt(ctx, 'showBrowser');
      if (!novelId && afterCmd[0]) novelId = String(afterCmd[0]);
      if (!novelId) throw new Error('--novelId required (or positional: load <novelId>)');
      const data = await rt.loadNovel({ novelId, showBrowser });
      console.log(`${data.meta.title} :: chapters=${data.chapters.length}`);
      return 0;
    }

    if (cmd === 'jobs') {
      const novelId = getOpt(ctx, 'novelId', '');
      const out = await rt.listJobs({ novelId });
      console.log(JSON.stringify(out.jobs, null, 2));
      return 0;
    }

    if (cmd === 'run') {
      let novelId = getOpt(ctx, 'novelId');
      let outputPath = getOpt(ctx, 'out');

      const startFromFlag = hasOpt(ctx, 'start');
      const endFromFlag = hasOpt(ctx, 'end');

      let start = Number(getOpt(ctx, 'start', '1'));
      let end = Number(getOpt(ctx, 'end', '1'));

      // Positional fallback: run <novelId> <out> <start> <end>
      if (!novelId && afterCmd[0]) novelId = String(afterCmd[0]);
      if (!outputPath && afterCmd[1]) outputPath = String(afterCmd[1]);
      if (!startFromFlag && afterCmd[2] != null) start = Number(afterCmd[2]);
      if (!endFromFlag && afterCmd[3] != null) end = Number(afterCmd[3]);

      const customTitle = getOpt(ctx, 'title', '');
      const downloadDelayMs = Number(getOpt(ctx, 'downloadDelayMs', '150'));
      const translateDelayMs = Number(getOpt(ctx, 'translateDelayMs', '600'));
      const chunkChars = Number(getOpt(ctx, 'chunkChars', '4800'));
      const showBrowser = hasOpt(ctx, 'showBrowser');
      const wait = hasOpt(ctx, 'wait');
      const pollMs = Number(getOpt(ctx, 'pollMs', '1200'));


      if (!novelId) throw new Error('--novelId required (or positional: run <novelId> <out> <start> <end>)');
      if (!outputPath) throw new Error('--out required (or positional: run <novelId> <out> <start> <end>)');

      const { jobId } = await rt.startRun({
        novelId,
        outputPath: path.resolve(outputPath),
        customTitle,
        startChapter: start,
        endChapter: end,
        downloadDelayMs,
        translateDelayMs,
        chunkChars,
        showBrowser
      });

      console.log(jobId);

      if (!wait) return 0;

      // Wait until the job is finished (so CLI can be used for demos / automation).
      let sinceSeq = 0;
      while (true) {
        const st = await rt.getStatus({ jobId, sinceSeq });
        for (const line of st.newLogs || []) console.log(line);

        if (typeof st.chapterSeq === 'number') sinceSeq = st.chapterSeq;

        const s = st?.job?.status || '';
        if (s === 'done') return 0;
        if (s === 'failed') return 1;
        if (s === 'stopped') return 4;
        if (s === 'paused') return 3;

        await sleep(Number.isFinite(pollMs) ? pollMs : 1200);
      }
    }

    if (cmd === 'resume') {
      let jobId = getOpt(ctx, 'jobId');
      if (!jobId && afterCmd[0]) jobId = String(afterCmd[0]);
      if (!jobId) throw new Error('--jobId required (or positional: resume <jobId>)');
      await rt.resumeRun({ jobId });
      console.log('ok');
      return 0;
    }

    if (cmd === 'pause') {
      let jobId = getOpt(ctx, 'jobId');
      let reason = getOpt(ctx, 'reason', 'user');
      if (!jobId && afterCmd[0]) jobId = String(afterCmd[0]);
      if (reason === 'user' && afterCmd[1]) reason = String(afterCmd[1]);
      if (!jobId) throw new Error('--jobId required (or positional: pause <jobId> [reason])');
      await rt.pauseRun({ jobId, reason });
      console.log('ok');
      return 0;
    }

    if (cmd === 'stop') {
      let jobId = getOpt(ctx, 'jobId');
      if (!jobId && afterCmd[0]) jobId = String(afterCmd[0]);
      if (!jobId) throw new Error('--jobId required (or positional: stop <jobId>)');
      await rt.stopRun({ jobId });
      console.log('ok');
      return 0;
    }

    if (cmd === 'status') {
      let jobId = getOpt(ctx, 'jobId');
      if (!jobId && afterCmd[0]) jobId = String(afterCmd[0]);
      if (!jobId) throw new Error('--jobId required (or positional: status <jobId>)');
      const out = await rt.getStatus({ jobId, sinceSeq: 0 });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    throw new Error('Unknown command');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
