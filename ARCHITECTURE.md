# ForexAnalysis — XAUUSD AI Analyzer

Dashboard phân tích vàng (XAU/USD) cho 1 người dùng: chart đa khung,
chat AI có trí nhớ dài hạn, tin vĩ mô ForexFactory.
Live: `https://lupindsama.github.io/ForexAnalysis/`

## 1. Tech stack

| Lớp | Công nghệ |
|---|---|
| Frontend | Vite 8 + React 19, `lightweight-charts` v5 (vẽ nến), `react-markdown` + `remark-gfm` (hiển thị chat) |
| Backend | Cloudflare Worker `xau-ai-backend` (`https://xau-ai-backend.lupindsama.workers.dev`) |
| AI | Cloudflare Workers AI, model `@cf/qwen/qwen3-30b-a3b-fp8` (temperature 0.7, max 1500 tokens) |
| Dữ liệu nến | Twelve Data `/time_series` (qua Worker, key nằm server-side) |
| Tin vĩ mô | Lịch ForexFactory (feed XML Faireconomy) + headlines trang Gold/USD |
| Bộ nhớ dài hạn | Cloudflare D1 `xau-memory` (SQLite ~5GB free) |
| Deploy web | File build (`index.html` + `assets/`) commit thẳng root branch `main`, Pages serve từ branch |
| Deploy Worker | `wrangler deploy` |

## 2. Cấu trúc dự án

```text
ForexAnalysis/                      # repo root = site Pages (branch deploy)
├── index.html                      # bản build (không sửa tay — copy từ dist)
├── assets/                         # JS/CSS build (không sửa tay)
├── ARCHITECTURE.md                 # file này
└── xau-ai-dashboard/               # source code
    ├── package.json                # react, lightweight-charts, react-markdown...
    ├── vite.config.js              # base './' để chạy dưới sub-path Pages
    ├── .env.example                # mẫu biến môi trường (KHÔNG chứa key thật)
    ├── .env                        # local, gitignored — VITE_WORKER_URL (+ key cũ đã bỏ)
    ├── src/
    │   ├── main.jsx                # entry point
    │   ├── App.jsx                 # state trung tâm: data 4 khung, chat, theme, quota
    │   ├── App.css                 # theme sáng/tối (biến CSS), layout, responsive
    │   ├── components/
    │   │   ├── Chart.jsx           # wrapper Lightweight Charts (candlestick, screenshot)
    │   │   ├── Controls.jsx        # nút Chart ON/OFF + quota Twelve Data
    │   │   ├── Analysis.jsx        # giá/change 4 khung + giờ cập nhật
    │   │   ├── Chat.jsx            # bóng chat, markdown, thẻ Setup, ảnh chart
    │   │   ├── News.jsx            # list tin vĩ mô + refresh
    │   │   └── Memory.jsx          # thanh dung lượng D1 + lưu quy tắc/ghi chú
    │   └── services/
    │       └── api.js              # gọi Worker, convert nến, quota localStorage
    ├── worker/
    │   ├── index.js                # toàn bộ backend (endpoints + AI + D1)
    │   ├── wrangler.toml           # tên, bindings AI/DB, placement, secrets khai báo
    │   ├── schema.sql              # DDL 3 bảng (memories, snapshots, meta)
    │   └── .dev.vars.example       # mẫu secrets local (gitignored)
    └── .github/workflows/
        ├── pages.yml               # (dự phòng) build + deploy Pages qua Actions
        └── worker.yml              # deploy Worker qua Actions (cần secrets CF)
```

## 3. Kiến trúc tổng thể

```text
                    ┌──────────────────────────────┐
                    │  GitHub Pages (branch main)  │
                    │  index.html + assets/ (tĩnh) │
                    └──────────────┬───────────────┘
                                   │  fetch
                    ┌──────────────▼───────────────┐
                    │  Cloudflare Worker           │
                    │  xau-ai-backend              │
                    │  ┌────────┬────────┬───────┐ │
                    │  │Twelve  │Workers │  D1   │ │
                    │  │Data API│AI      │ SQLite│ │
                    │  └────────┴────────┴───────┘ │
                    └──────────┬────────┬─────────┘
                               │        │     (cùng Worker)
                               ▼        ▼        ▼
                   Nến 1m   Qwen3   memories/
                   5m 1H   30B     snapshots/
                   4H               news_cache/meta
```

> Lịch sử: từng dùng Gemini qua Worker nhưng IP egress của Cloudflare bị
> Google chặn theo vùng (`User location is not supported`) — đã chuyển sang
> Workers AI, không key, không chặn vùng. Chi tiết xem mục 7.

## 4. Data flow

### 4.1. Nến → chart (on-demand, không auto-refresh)

```text
Mở trang ──► GET /api/xauusd?interval=1min ──► chart 1m
Chuyển tab ──► vẽ cache (trống thì gợi ý bấm ⟳, KHÔNG tự fetch)
Bấm ⟳ ──► GET /api/xauusd?interval=<khung đang xem>
Chat ──► fetch lại các khung ĐÃ CŨ (1m>90s, 5m>6', 1H>20', 4H>40')
```

- Worker validate `interval ∈ {1min,5min,1h,4h}`, sai → về `1min`; `outputsize=200`.
- Frontend convert `datetime/open/high/low/close` (string) → `{time (unix), o/h/l/c}` cho chart.
- Mỗi request Twelve = 1 credit. Free ~800/ngày; app đếm trong `localStorage`
  (`xau_req_count_YYYY-MM-DD`), chạm ~750 thì dừng request và báo.

### 4.2. Chat với AI (mỗi câu hỏi)

Chế độ thường: chỉ dùng 4h/1h/5m (nến ít). **Super Boost** (nút ⚡): lấy tươi
cả 5 khung (4h/1h/15m/5m/1m), nến sâu (60 active + 30 các khung), AI 2500 tokens.

```text
User hỏi (+ boost?)
  │  1. Chụp ảnh chart đang xem
  │  2. Fetch tươi các khung (thường: khung cũ trong 5m/1h/4h · boost: cả 5)
  ▼
POST /api/chat { prompt, marketData, boost }
  │  3. Chấm backtest: setup OPEN cũ so với nến mới → chạm TP trước THẮNG,
  │     chạm SL trước THUA (mọi trend tính theo biên, cùng nến tính THUA),
  │     + điểm pattern (thắng +1, thua -1). Mỗi request /api/xauusd cũng chấm.
  │  4. Nạp context D1: điểm pattern + track record + 15 memories + snapshot + macro
  │  5. Lưu snapshot nến hiện tại
  │  6. Gọi Workers AI (Qwen3-30B)
  │  7. Lưu chọn lọc: setup số học được → bảng setups (OPEN, kèm created_ts
  │     là thời điểm AI trả lời để lần fetch sau đối chiếu chạm TP/SL trước);
  │     prompt có [phân tích] → lesson full; setup đủ số → analysis gọn;
  │     chat xã giao → không lưu gì
  ▼
Frontend: markdown + thẻ Setup (Xu hướng/Kiểu/Entry/TP/SL/Lệnh chờ/Scalp/Swing)
```

- Response Worker giữ shape kiểu Gemini (`candidates[0].content.parts[0].text`)
  để frontend không phải đổi.
- Giới hạn prompt: memory ≤6000 ký tự, macro ≤3200, market object ≤4000.

### 4.3. Tin vĩ mô

```text
GET /api/news ──► D1 news_cache còn tươi (<60') ? trả cache : fetch mới
fetch mới = XML lịch tuần Faireconomy (USD High/Medium + High khác, tối đa 15)
          + headlines trang FF Gold/USD (best-effort, hay bị chặn bot → có thể rỗng)
```

- Panel Tin vĩ mô hiện events (badge High/Medium) + giờ cập nhật + link gốc FF.

### 4.4. Bộ nhớ dài hạn (D1 `xau-memory`)

| Bảng | Nội dung |
|---|---|
| `memories` | `analysis` (setup đủ số, gọn; chỉ tỉa loại này khi quá 500), `lesson` ([phân tích] full + bài học backtest), `rule`/`note` (lưu tay, KHÔNG bao giờ bị dọn), `knowledge` (digest nén từ stats + bài học, rebuild mỗi lần dọn/có verdict mới) |
| `setups` | setup số học được từ mỗi câu trả lời (trend/style/entry/tp/sl + `created_ts` ghi thời điểm AI trả lời, status OPEN→WON/LOST) — chấm tự động bằng nến mới |
| `scores` | điểm từng pattern (`SCALPING LONG`...): thắng +1, thua -1, kèm won/lost — nạp vào prompt để AI ưu tiên pattern điểm cao, học lại từ điểm âm |
| `snapshots` | nến gọn `[[t,o,h,l,c],...]` mỗi lần chat |
| `news_cache` | payload tin vĩ mô + `updated_at` |
| `meta` | `usage_bytes` — byte tích lũy để hiển thị (ước tính, không trừ khi tỉa) |

Panel Bộ nhớ D1 hiện `đã dùng / 5GB`, số dòng từng bảng, 5 mục gần nhất.

## 5. API Worker

| Endpoint | Method | Vào | Ra |
|---|---|---|---|
| `/api/xauusd?interval=` | GET | `1min/5min/15min/1h/4h/1day`, outputsize 500 (intraday) / 365 daily (~1 năm), cùng 1 credit | JSON Twelve (`values[]`) |
| `/api/chat` | POST | `{prompt, marketData}` | `{candidates:[...], storage}` |
| `/api/memory` | POST | `{kind: rule/note, content}` | `{ok, storage}` |
| `/api/storage` | GET | — | `{used_bytes, limit_bytes, tables, recent[10]}` |
| `/api/storage/clean` | POST | `{password}` — cổng chống bấm nhầm (KHÔNG phải bảo mật thật, key nằm public) | `{ok, stats, storage}` — xóa snapshot >7 ngày (giữ 10 mới nhất), nén snapshot >3 ngày còn 50 nến cuối, analyses giữ 100 mới nhất (giữ hết lesson/rule/note), setups đã chấm >30 ngày; recompute usage |
| `/api/news[?refresh=1]` | GET | — | `{events[≤15], headlines[≤8], updated_at}` |
| `/api/whereami` | GET | — | debug egress (trace Cloudflare) |

## 6. Workflow vận hành

### Chạy local

```powershell
$env:Path = "$env:LOCALAPPDATA\nodejs-22;" + $env:Path  # Node 22 portable
cd xau-ai-dashboard
copy .env.example .env   # điền VITE_WORKER_URL (dev: http://localhost:8787)
npm.cmd run dev          # frontend :5173
cd worker; npx.cmd wrangler dev   # worker :8787 (đọc .dev.vars)
```

### Publish (web + worker)

```powershell
cd xau-ai-dashboard/worker
npx.cmd wrangler secret put TWELVE_DATA_API_KEY   # 1 lần (đã làm)
npx.cmd wrangler deploy                           # sau mỗi lần sửa worker

cd ..
$env:VITE_WORKER_URL = "https://xau-ai-backend.lupindsama.workers.dev"
npm.cmd run lint; npm.cmd run build
# copy dist ra root repo rồi push (Pages serve từ branch main / root)
```

### D1

```powershell
npx.cmd wrangler d1 execute xau-memory --remote --command "SELECT ...;"
npx.cmd wrangler d1 execute xau-memory --remote --file=schema.sql
```

### Quy ước an toàn

- Key KHÔNG bao giờ vào git: secrets ở Cloudflare, `.env`/`.dev.vars` gitignored.
- Bundle root (`assets/*.js`) luôn quét `twelvedata|generativelanguage|x-goog-api-key`
  trước push — GitHub push protection chặn nếu lọt key.
- Model AI đổi tên theo thời gian (đã gặp `gemini-2.0-flash`, `llama-3.1-8b`
  bị khai tử) — kiểm tra `https://developers.cloudflare.com/workers-ai/models/`.

## 7. Quyết định kiến trúc đã chốt

1. **On-demand thay vì polling**: Twelve Free 800 req/ngày không chịu nổi
   refresh liên tục (10s/lần ≈ 8640 req/ngày) — fetch lúc mở/chuyển khung/⟳/chat.
2. **Workers AI thay Gemini**: egress Cloudflare bị Google định vị sai vùng,
   đã thử Smart Placement + Durable Object ghim Mỹ vẫn bị chặn.
3. **D1 trước, Supabase sau**: 1 user thì D1 (~5GB, không pause) đủ cho
   nến/log/memory; Supabase + pgvector để dành khi cần RAG ngữ nghĩa.
4. **Trí nhớ = RAG đơn giản** (không phải fine-tune): nạp memories + snapshot +
   macro vào prompt mỗi câu chat.
5. **Branch-deploy thay vì Actions**: `index.html` nằm root `main` cho đơn giản;
   giữ `pages.yml`/`worker.yml` dự phòng.
