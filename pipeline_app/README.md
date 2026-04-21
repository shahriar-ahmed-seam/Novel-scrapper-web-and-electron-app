# Tomato Pipeline App (local)

Local web app that simulates the whole process:
1) user enters TomatoMTL novel ID
2) app extracts metadata + chapter list from `https://tomatomtl.com/book/<id>`
3) app downloads CN chapters via `https://tt.sjmyzq.cn/api/raw_full?item_id=`
4) app translates chapters via TomatoMTL translate automation
5) app writes outputs to a chosen output path and packages EPUB/ZIP

## Run

```powershell
cd pipeline_app
npm install
npx playwright install chromium
npm run dev
```

Open: http://localhost:5000
