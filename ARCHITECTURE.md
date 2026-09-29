# ForexAnalysis — XAUUSD AI Analyzer

Dashboard phân tích vàng (XAU/USD) cho 1 người dùng: chart đa khung,
chat AI có trí nhớ dài hạn, tin vĩ mô ForexFactory.
Live: `https://lupindsama.github.io/ForexAnalysis/`

## 1. Tech stack

| Lớp | Công nghệ |
|---|---|
| Frontend | Vite 8 + React 19, `lightweight-charts` v5 (vẽ nến), `react-markdown` + `remark-gfm` (hiển thị chat) |
| Backend | Cloudflare Worker `xau-ai-backend` (`https://xau-ai-backend.lupindsama.workers.dev`) |
| AI | Cloudflare Workers AI, model `@cf/qwen/qwen3-30b-a3b-fp8` (temperature 0.7, max 1500 tokens, boost 2500) |
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
    │   ├── App.jsx                 # state trung tâm: data 6 khung, chat, theme/style, quota, live
    │   ├── App.css                 # tokens sáng/tối + 3 style (ios/terminal/huawei), layout, responsive
    │   ├── components/
    │   │   ├── Chart.jsx           # wrapper Lightweight Charts (candlestick, screenshot, update live)
    │   │   ├── Controls.jsx        # nút Chart ON/OFF + quota Twelve Data
    │   │   ├── Analysis.jsx        # giá/change 6 khung + giờ cập nhật
    │   │   ├── Chat.jsx            # bóng chat, markdown, thẻ Setup, ảnh chart, Super Boost
    │   │   ├── Orders.jsx          # dropdown lệnh đang mở (scroll, tự refresh khi mở)
    │   │   ├── News.jsx            # list tin vĩ mô + refresh
    │   │   └── Memory.jsx          # dung lượng D1 + điểm pattern + lưu tay + dọn kho (cổng pass)
    │   └── services/
    │       └── api.js              # gọi Worker (market/chat/news/storage/live), convert nến, quota localStorage
    ├── worker/
    │   ├── index.js                # toàn bộ backend (endpoints + AI + D1 + live)
    │   ├── wrangler.toml           # tên, bindings AI/DB, placement, secrets khai báo
    │   ├── schema.sql              # DDL 6 bảng (memories, snapshots, news_cache, meta, setups, scores)
    │   ├── seed_kb.sql             # 15 kiến thức nền XAUUSD nạp 1 lần (kind kb)
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
                   Nến 1m     Qwen3   memories/ kb/
                   5m 15m     30B     snapshots/ setups/
                   1H 4H 1D           scores/ news_cache/meta
                   (+ live Yahoo GC=F qua /api/live, poll 30s)
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
Chat thường ──► fetch lại khung cũ trong 5m/1h/4h (1m>90s, 5m>6', 1H>20', 4H>40')
Chat boost ──► fetch tươi cả 6 khung (1m/5m/15m/1h/4h/1D)
```

- Worker validate `interval ∈ {1min,5min,15min,1h,4h,1day}`, sai → về `1min`.
- Frontend convert `datetime/open/high/low/close` (string) → `{time (unix), o/h/l/c}` cho chart.
- Mỗi request Twelve = 1 credit. Free ~800/ngày; app đếm trong `localStorage`
  (`xau_req_count_YYYY-MM-DD`), chạm ~750 thì dừng request và báo.

### 4.2. Chat với AI (mỗi câu hỏi)

Chế độ thường: chỉ dùng 4h/1h/5m (nến ít). **Super Boost**: lấy tươi
cả 6 khung (4h/1h/15m/5m/1m/1D), nến sâu (60 active + 30 các khung), AI 2500 tokens.

```text
User hỏi (+ boost?)
  │  1. Chụp ảnh chart đang xem
  │  2. Fetch tươi các khung (thường: khung cũ trong 5m/1h/4h · boost: cả 6)
  ▼
POST /api/chat { prompt, marketData, boost }
  │  3. Chấm backtest: setup OPEN cũ so với nến mới → chạm TP trước THẮNG,
  │     chạm SL trước THUA (mọi trend tính theo biên, cùng nến tính THUA),
  │     scalp thắng +1, swing thắng +3, thua -1. Mỗi request /api/xauusd cũng chấm.
  │  4. Nạp context D1: điểm pattern + track record + digest tri thức + 15 memories
  │     + snapshot + macro + kiến thức nền kb (luôn nạp) + digest kỹ thuật
  │     (RSI14, vị trí biên, ATR, chuỗi, swing H/L tính sẵn từng khung)
  │  5. Lưu snapshot nến hiện tại
  │  6. Gọi Workers AI (Qwen3-30B)
  │  7. Lưu chọn lọc: setup số học được → bảng setups (OPEN, kèm created_ts
  │     là thời điểm AI trả lời để lần fetch sau đối chiếu chạm TP/SL trước);
  │     prompt có [phân tích] → lesson full; setup đủ số → analysis gọn;
  │     chat xã giao → không lưu gì
  ▼
Frontend: markdown + thẻ Setup (Xu hướng/Kiểu/Entry/TP/SL/Lệnh chờ/Scalp/Swing)
+ ảnh chart + storage mới. Worker tự sửa nhãn trend nếu số mâu thuẫn
(TP dưới entry không thể là LONG).
```

- Response Worker giữ shape kiểu Gemini (`candidates[0].content.parts[0].text`)
  để frontend không phải đổi.
- Giới hạn prompt: kb + knowledge + memory ≤6000+6000 ký tự, macro ≤3200,
  market object ≤12000, snapshot ≤15000.

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
| `memories` | `analysis` (setup đủ số, gọn; chỉ tỉa loại này khi quá 500), `lesson` ([phân tích] full + bài học backtest), `rule`/`note` (lưu tay, KHÔNG bao giờ bị dọn), `kb` (15 kiến thức nền XAUUSD nạp sẵn, luôn nạp vào prompt), `knowledge` (digest nén từ stats + bài học, rebuild mỗi lần dọn/có verdict mới) |
| `setups` | setup số học được từ mỗi câu trả lời (trend/style/entry/tp/sl + `created_ts` ghi thời điểm AI trả lời, status OPEN→WON/LOST) — chấm tự động bằng nến mới |
| `scores` | điểm từng pattern (`SCALPING LONG`...): scalp thắng +1, swing thắng +3, thua -1, kèm won/lost — pattern điểm dương thành cơ sở trong digest, nạp vào prompt |
| `snapshots` | nến gọn `[[t,o,h,l,c],...]` mỗi lần chat |
| `news_cache` | payload tin vĩ mô + `updated_at` |
| `meta` | `usage_bytes` — byte tích lũy để hiển thị (ước tính, không trừ khi tỉa) |

Panel Bộ nhớ D1 hiện `đã dùng / 5GB`, số dòng từng bảng, 5 mục gần nhất.

### 4.5. Giá live (không tốn Twelve)

```text
Browser ──poll 30s──► GET /api/live ──► Yahoo GC=F (COMEX futures, cache 30s
ở Worker, fallback giá cũ khi Yahoo lỗi) ──► gộp tick thành nến đang hình
thành từng khung ──► series.update() tại chỗ
```
- Twelve chỉ còn: sử ban đầu, ⟳ tay, chat phân tích.
- TV WebSocket nối thẳng đã test: local qua, github.io bị từ chối origin.
  Yahoo thiếu CORS nên phải proxy qua Worker. Giá futures lệch spot vài đô:
  chart tham khảo OK, phân tích vẫn dùng nến Twelve.
- Nút Live ON/OFF; trạng thái hiện giá + giờ tick, quá 10' báo "giá cũ".

## 5. API Worker

| Endpoint | Method | Vào | Ra |
|---|---|---|---|
| `/api/xauusd?interval=` | GET | `1min/5min/15min/1h/4h/1day`, outputsize 500 (intraday) / 365 daily (~1 năm), cùng 1 credit | JSON Twelve (`values[]`) |
| `/api/chat` | POST | `{prompt, marketData, boost}` | `{candidates:[...], storage}` |
| `/api/memory` | POST | `{kind: rule/note, content}` | `{ok, storage}` |
| `/api/storage` | GET | — | `{used_bytes, limit_bytes, tables, scores, open_setups[≤20], recent[10]}` |
| `/api/storage/clean` | POST | `{password}` — cổng chống bấm nhầm (KHÔNG phải bảo mật thật, key nằm public) | `{ok, stats, storage}` — xóa snapshot >7 ngày (giữ 10 mới nhất), nén snapshot >3 ngày còn 50 nến cuối, analyses giữ 100 mới nhất (giữ hết lesson/rule/note), setups đã chấm >30 ngày; recompute usage |
| `/api/news[?refresh=1]` | GET | — | `{events[≤15], headlines[≤8], updated_at}` |
| `/api/live` | GET | — | `{price, time, source}` (+ `cached`/`stale` khi phù hợp) |
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
6. **Live qua Yahoo-proxy**: TV WebSocket bị chặn origin production, Yahoo
   thiếu CORS — proxy 30s qua Worker là đường duy nhất đã kiểm chứng.
7. **UI theo tasteskill** (`design-taste-frontend`, redesign-overhaul, dials
   5/3/7): chuyển style iOS/Terminal/Huawei + sáng/tối, footer credits
   Fexxwer/LupinDsama, không thêm dependency.
