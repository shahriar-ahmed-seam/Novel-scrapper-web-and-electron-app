# Novel Scrapper Web and Electron App

GitHub repo: https://github.com/shahriar-ahmed-seam/Novel-scrapper-web-and-electron-app

Windows release download: https://github.com/shahriar-ahmed-seam/Novel-scrapper-web-and-electron-app/releases/download/v1.0.0/TomatoPipelineStandalone.exe

Local API + parser for `https://**.****.cn/api/raw_full?item_id=...` and a minimal chapter reader UI.

## Run

1. Install deps:

   - `npm install`

2. Start server:

   - `npm run dev`

3. Open UI:

   - http://localhost:3000

## API

- `GET /api/chapter/:itemId`
  - Fetches upstream JSON (or local mock on failure), parses `<p idx="...">...</p>` into a DB-friendly structure.
  - Query: `?mode=mock` forces using local `raw_full.json`.

## Parse local file (CLI)

- `npm run parse:local`

Outputs the normalized JSON to stdout.
