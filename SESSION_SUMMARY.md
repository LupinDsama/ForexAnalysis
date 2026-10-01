# Tổng kết phiên làm việc — XAUUSD AI Analyzer

Ngày: 28–30/09/2026. Từ project Vite trắng đến web live có AI + trí nhớ + backtest.

## 1. Đã làm gì

| # | Việc | Kết quả |
|---|---|---|
| 1 | Đọc spec từ link share ChatGPT | Trích được kiến trúc Phase 1 (Pages + Worker + Twelve + Gemini + chart) |
| 2 | Dựng Full Phase 1 | React + Lightweight Charts + Worker (`/api/xauusd`, `/api/chat`) + Actions workflows |
| 3 | Git + push | Repo `LupinDsama/ForexAnalysis`, branch `main` |
| 4 | API keys | KHÔNG hardcode: keys chỉ trong Worker secrets + `.env` local (gitignored) |
| 5 | Nâng Node 20 → 22 | Installer MSI kẹt UAC → cài portable `%LOCALAPPDATA%\nodejs-22`, sửa PATH, gọi `npm.cmd`/`npx.cmd` |
| 6 | Cloudflare Worker | Login, `secret put` 2 keys, đăng ký subdomain `lupindsama`, deploy |
| 7 | Sửa chat AI (3 vòng) | `gemini-2.0-flash` bị khai tử → `gemini-3.8-flash` → Google chặn IP egress CF (HKG) → thử Smart Placement + Durable Object ghim Mỹ vẫn bị chặn → chốt **Workers AI** (`llama-3.1-8b` cũng bị khai tử → `@cf/qwen/qwen3-30b-a3b-fp8`) |
| 8 | D1 `xau-memory` | Bảng `memories/snapshots/news_cache/meta/setups/scores` (+`activated_ts` migrate sau) |
| 9 | Đa khung | 1m/5m/15m/1h/4h/1D, outputsize 500 (intraday) / 365 (daily), on-demand + Super Boost |
| 10 | Tin vĩ mô | Lịch ForexFactory qua feed Faireconomy (cache 60'), headlines bị FF chặn bot |
| 11 | Backtest + điểm | Chấm TP/SL theo biên, scalp +1 / swing +3 / thua -1, bài học + digest tri thức |
| 12 | Lệnh chờ | PENDING kích hoạt khi chạm entry (chat/fetch + tick live 30s), AI hủy/mở/đóng/xóa bằng cú pháp |
| 13 | Live price | TV WebSocket test thật: local qua, github.io bị chặn origin → Yahoo (delay, lệch) → chốt **Swissquote** sát spot ±0.2 |
| 14 | Sửa lệch múi giờ verdict | Twelve ép `timezone=UTC` + parse UTC tường minh; reset toàn bộ verdict cũ |
| 15 | UI | iOS/Terminal/Huawei + sáng/tối (tasteskill), markdown + thẻ Setup + ảnh chart + RSI-14 + markers lệnh + dropdowns + dọn kho (cổng pass) + footer Fexxwer/LupinDsama |
| 16 | Docs | `ARCHITECTURE.md` (kiến trúc) + file này |

## 2. Sự cố đáng nhớ và cách xử lý

- **Build fail rolldown binding**: `node_modules` cài bằng Node 20 → xóa cài lại bằng Node 22.
- **Đẩy nhầm key lên GitHub**: push protection chặn (GCP key trong bundle) → chuyển sang Worker-proxy, bundle sạch key mới được push.
- **AI cùng 1 kiểu trả lời**: prompt rập khuôn + model 8B yếu → prompt suy luận + Qwen3-30B.
- **Entry lệch giá ($38)**: chat không fetch 1m + AI dùng số cũ → luôn fetch tươi 1m + ghim dòng GIÁ HIỆN TẠI + badge trạng thái lệnh.
- **Verdict thua oan hàng loạt**: Twelve trả giờ không UTC + parse local → ép UTC 2 đầu + reset 15 verdict cũ.
- **Đồng hồ máy nhanh ~7 tiếng**: dùng giờ Cloudflare/`performance.now()` làm chuẩn, không tin wall-clock.
- **Bundle cũ cứ hiện mãi**: footer in mã bản build để đối chiếu, Ctrl+Shift+R.

## 3. Trạng thái hiện tại

- Web: `https://lupindsama.github.io/ForexAnalysis/` (branch-deploy, root `index.html`)
- Worker: `https://xau-ai-backend.lupindsama.workers.dev` (bindings AI + D1)
- Secrets trên Cloudflare: `TWELVE_DATA_API_KEY` (dùng), `GEMINI_API_KEY` (thừa, chưa xóa)
- D1 `xau-memory`: memories (~40+, gồm 25 kb + rules + analyses), setups (backtest), scores, news_cache
- Tính năng: 6 khung chart + live 30s + chat AI (thường/boost) + memory + tin macro + backtest + điểm pattern + lệnh chờ/mở/đóng/hủy + markers + RSI + 3 themes + dọn kho

## 4. Lệnh publish chuẩn (copy-paste)

```powershell
$env:Path = "$env:LOCALAPPDATA\nodejs-22;" + $env:Path
cd D:\Nhan\Tech\Visual Studio Code\Web\ForexAnalysis\xau-ai-dashboard\worker
npx.cmd wrangler deploy                      # sau khi sửa worker
cd ..
$env:VITE_WORKER_URL = "https://xau-ai-backend.lupindsama.workers.dev"
$env:VITE_BUILD_ID = (git rev-parse --short HEAD)
npm.cmd run lint; npm.cmd run build
Remove-Item ..\assets, ..\index.html, ..\favicon.svg, ..\icons.svg -Recurse -Force
Copy-Item dist/index.html .. ; Copy-Item dist/favicon.svg .. ; Copy-Item dist/icons.svg ..
Copy-Item dist/assets ..\assets -Recurse
cd ..; git add -A; git commit -m "..."; git push origin main
```

## 5. Việc có thể làm tiếp

- Xóa secret `GEMINI_API_KEY` thừa (`wrangler secret delete`).
- Thêm chỉ báo (EMA/MACD) theo mẫu RsiPanel.
- Private repo nếu không muốn key cũ lộ thêm (keys đã regenerate 1 lần).
- Theo dõi hóa đơn Cloudflare (hiện tại free tier dư xa).
