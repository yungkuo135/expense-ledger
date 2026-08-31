# 專案目前狀態

更新日期：2026-08-31\
基準 commit：`0b07bc4`

## 產品狀態

Expense Ledger 是原生 HTML、CSS、JavaScript 的單頁個人記帳工具。目前第一階段
Supabase 遷移已完成，正式模式以 Supabase Auth 登入，並以 PostgreSQL 作為唯一
帳本資料來源。瀏覽器 localStorage 不再作為帳本來源或救援副本。

目前保留的主要功能：

- 現金消費輸入與編輯。
- 政府電子發票 CSV、信用卡 CSV 匯入及預覽。
- 重複偵測、發票／信用卡配對與人工解除配對。
- 店家別名學習、歷史分類及 AI 輔助分類流程。
- 匯入批次回滾、資料品質工作箱與統計。
- CSV 匯出、完整 JSON 備份及合併式還原。

首頁目前以消費明細為主；搜尋、篩選、匯入及備份集中在可收合的工具區。發票細項
預設收合，使用者調整分帳金額後，畫面仍顯示原始金額。

## 執行模式

### 正式雲端模式

- 網址：`http://127.0.0.1:8000/`（本機開發時）。
- 未登入時不載入或顯示帳務資料。
- 重整時先確認 Supabase session，再顯示登入表單或帳本，避免登入畫面閃爍。
- 登入後右上方顯示「雲端已同步」，可展開查看帳號及登出。

### 本機檔案測試模式

- 網址：`http://127.0.0.1:8000/?storage=file`。
- 僅允許 `127.0.0.1`，資料寫入 `test-fixtures/private/state`。
- 此模式只供回歸測試，不是正式資料的備援或離線模式。

## Supabase 架構

- 前端設定：`js/supabase-config.js`，只允許 Project URL 與 publishable key。
- Auth／adapter：`js/cloud.js`。
- migration：`supabase/migrations/202608280001_create_ledger_storage.sql`。
- 資料表：`public.ledger_storage`。
- 主鍵：`(user_id, storage_key)`。
- RLS：authenticated 使用者只能 CRUD 自己 `user_id` 的資料。
- `anon` 沒有資料表權限。

主要 storage key：

| Key                           | 內容                       |
| ----------------------------- | -------------------------- |
| `expense-entries-YYYY-MM`     | 該月份完整 entry JSON 陣列 |
| `vendor-aliases`              | 店家對應學習資料           |
| `import-batches-v1`           | 最近匯入批次與回滾資訊     |
| `ledger-meta`                 | 相容用帳本 metadata        |
| `ledger-migration-entries-v1` | 舊版分月遷移標記           |

目前重新整理會列出並載入所有月份，再由 UI 預設只展開最新月份。現階段資料量小，
暫無效能問題；延遲載入的相依範圍記錄在 `BACKLOG.md`。

## 資料完整性重點

- 使用者修改分帳後的 `amount` 是個人實際支出。
- `originalAmount` 保留原始交易金額，發票／信用卡配對使用此值。
- 舊備份沒有 `originalAmount` 時，沿用 `amount`，維持向後相容。
- JSON 還原依 entry ID 合併，不會先清空現有雲端帳本。
- 店家學習資料獨立儲存，不應隨月份紀錄刪除。
- 一般單筆操作只寫入受影響月份；大量匯入、還原或清空才會做完整月份同步。

## 驗證方式

```bash
deno task test
git diff --check
git status --short --ignored
```

測試包含公開單元測試；若本機具有 ignored 的
`test-fixtures/private`，還會執行真實 CSV
匯入、去重、配對與關聯完整性回歸測試。私人 fixture 與下載的備份不得提交。

## 外部設定（repository 無法驗證）

Supabase 後台應維持：

- 公開註冊關閉，只保留既有個人帳號。
- Site URL 與 Redirect URLs 對應實際部署網址。
- migration 已執行且 RLS policies 存在。
- service-role key、資料庫密碼未出現在前端或 Git 歷史。
