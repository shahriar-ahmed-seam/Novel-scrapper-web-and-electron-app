# novel-scraper-proxy

Local API + parser for `https://tt.sjmyzq.cn/api/raw_full?item_id=...` and a minimal chapter reader UI.

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
