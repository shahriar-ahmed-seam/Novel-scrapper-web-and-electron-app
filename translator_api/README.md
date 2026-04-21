# Tomato Translator API (local)

Local-only API + batch translator that automates https://tomatomtl.com/translate via Playwright.

## Run API

```powershell
cd translator_api
npm install
npm run dev
```

API endpoints:
- `GET /health`
- `POST /translate` body: `{ "text": "..." }`

## Batch translate an exported novel

```powershell
cd translator_api
npm run batch:translate -- --novelDir "../Novels/<Novel Name>" --delayMs 1500
npm run verify -- --novelDir "../Novels/<Novel Name>"
```

Outputs:
- `../Novels/<Novel Name>/translated/txt/*.txt`
- Job state: `translator_api/jobs/*.json`
