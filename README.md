# Expense Ledger（記帳本）

以原生 HTML、CSS 與 JavaScript
製作的個人消費記帳工具。支援現金記帳、政府電子發票與信用卡 CSV
匯入、重複偵測、發票／信用卡對帳、分類學習、批次回滾，以及 JSON 備份與還原。

> [!IMPORTANT]
> 此 repository 僅存放程式碼。真實帳務
> CSV、本機儲存狀態與備份檔可能包含敏感財務資料，請勿提交到 Git。

## 本機執行

需求：[Deno 2](https://docs.deno.com/runtime/)

```bash
deno task dev
```

正式雲端帳本請開啟 `http://127.0.0.1:8000/` 並登入。終端機另外顯示的
`http://127.0.0.1:8000/?storage=file` 僅供本機測試，會將測試狀態寫入
`test-fixtures/private/state`；整個 `test-fixtures/private` 目錄已由
`.gitignore` 排除。

一般模式使用 Supabase 雲端帳本；未登入時不會載入或顯示帳務資料。

## 安裝到手機

正式部署使用 HTTPS 後，可透過手機瀏覽器的「加入主畫面」安裝為 PWA。PWA 會快取
應用程式的靜態外殼，但帳務資料仍只讀寫 Supabase；離線時不可新增、編輯、匯入或
還原資料。`?storage=file` 測試模式不使用 Service Worker。 Manifest、Service
Worker 與靜態快取使用相對 scope，可部署在 GitHub Pages 的 `/expense-ledger/` 等
repository 子路徑。

## 測試

```bash
deno task test
```

公開測試不需要私人帳務資料。若本機存在 `test-fixtures/private` 下的測試 CSV
與預期結果，測試套件會額外執行真實資料的匯入與對帳回歸測試。

## 資料安全

- `test-fixtures/private/`、`.env*`、日誌與建置輸出不會納入版本控制。
- 提交前請執行 `git status --short --ignored`，確認帳務檔案顯示為 ignored。
- 瀏覽器端只能使用可公開的 Supabase Project URL 與 publishable key，禁止將
  service-role key、資料庫密碼或其他 secret 放進前端程式碼。
- 建議定期使用應用程式內的「匯出完整備份」，並將備份保存在 repository 之外。

## 專案結構

```text
index.html        應用程式入口
css/              畫面樣式
js/               儲存、匯入、對帳與 UI 邏輯
scripts/          本機開發伺服器與測試資料輔助工具
tests/            Deno 測試
docs/             專案狀態、技術決策與後續待辦
```

## 專案交接文件

- [目前狀態](docs/PROJECT_STATUS.md)
- [技術決策](docs/DECISIONS.md)
- [後續待辦](docs/BACKLOG.md)

開始新的開發對話前，請先閱讀上述文件、`AGENTS.md` 與 `git status`。

## 發展方向

目前仍是單頁原生 JavaScript 應用程式，以 Supabase Auth 與 PostgreSQL
支援同一使用者跨裝置使用，同時保留既有 JSON 備份格式與匯入／對帳行為。

## Supabase 雲端模式（第一階段）

雲端模式以相容既有 storage key/value 格式為優先，Supabase
是正式帳本的唯一資料來源。瀏覽器過去留下的 localStorage 不會自動刪除，
但應用程式不再讀寫它。

1. 在 Supabase SQL Editor 執行
   `supabase/migrations/202608280001_create_ledger_storage.sql`。
2. 將 Project URL 與 `sb_publishable_...` 填入
   `js/supabase-config.js`。這兩項是瀏覽器可公開設定；禁止填入
   secret、service-role key 或資料庫密碼。
3. 先在 Supabase Authentication 建立個人帳號，完成後關閉新使用者註冊。
4. 以 `deno task dev` 啟動後，在帳號登入畫面登入；登入後右上方會顯示
   「雲端已同步」。
5. 若需將既有本機帳本遷移到全新的空白雲端，可先匯出完整 JSON
   備份，再於雲端模式使用「還原備份」。

資料表已啟用 Row Level Security；登入者只能讀寫 `user_id` 等於自己 Auth ID
的資料。JSON 還原會依紀錄 ID 合併，不會清空既有帳本。

## 授權

目前未附開源授權。除非另行加入 LICENSE，程式碼著作權仍由作者保留。
