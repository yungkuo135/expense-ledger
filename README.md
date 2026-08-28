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

接著開啟終端機顯示的網址（預設為
`http://127.0.0.1:8000/?storage=file`）。此開發模式會將測試狀態寫入
`test-fixtures/private/state`；整個 `test-fixtures/private` 目錄已由
`.gitignore` 排除。

也可以直接以瀏覽器開啟 `index.html`。一般模式優先相容既有的 `window.storage`，
否則使用標準 `localStorage` 保存資料；若兩者都無法使用，應用程式會停止資料操作，
避免畫面顯示成功但實際沒有保存。

## 測試

```bash
deno task test
```

公開測試不需要私人帳務資料。若本機存在 `test-fixtures/private` 下的測試 CSV
與預期結果，測試套件會額外執行真實資料的匯入與對帳回歸測試。

## 資料安全

- `test-fixtures/private/`、`.env*`、日誌與建置輸出不會納入版本控制。
- 提交前請執行 `git status --short --ignored`，確認帳務檔案顯示為 ignored。
- 瀏覽器端只能使用可公開的設定。未來串接 Supabase 時，禁止將 service-role key
  或其他 secret 放進前端程式碼。
- 建議定期使用應用程式內的「匯出完整備份」，並將備份保存在 repository 之外。

## 專案結構

```text
index.html        應用程式入口
css/              畫面樣式
js/               儲存、匯入、對帳與 UI 邏輯
scripts/          本機開發伺服器與測試資料輔助工具
tests/            Deno 測試
```

## 發展方向

目前仍是單頁原生 JavaScript 應用程式，資料主要保存在本機。後續規劃以 Supabase
Auth 與 PostgreSQL 支援同一使用者跨裝置同步，同時保留既有 JSON
備份格式與匯入／對帳行為。

## 授權

目前未附開源授權。除非另行加入 LICENSE，程式碼著作權仍由作者保留。
