# 技術決策紀錄

## 保留原生 JavaScript 前端

目前功能已穩定且包含大量匯入、對帳與編輯邏輯。除非有明確需求，不改寫成 React、
Next.js 或其他框架，以避免無關重寫造成資料行為退化。

## Supabase 是正式帳本唯一來源

正式模式登入後只讀寫 Supabase，不再讀寫 localStorage，也不在登出後顯示本機帳務
資料。使用者自行匯出的 JSON 備份是主要後備方案。這可避免不同裝置、本機舊資料與
雲端資料之間產生不明確的合併或覆蓋。

## 使用相容既有模型的 key/value 資料表

第一階段使用 `ledger_storage` 儲存 JSON snapshot，而不是立即把每個 entry
正規化成
多張關聯式資料表。這能保留既有資料模型、備份格式及對帳行為，降低遷移風險。資料表
以 `user_id` 和 `storage_key` 為主鍵，並以 RLS 隔離使用者。

## 記帳資料按月份分割

entry 使用 `expense-entries-YYYY-MM`
儲存。單筆新增或編輯通常只寫入該月份，避免每次
操作覆寫整份歷史。啟動階段目前仍載入所有月份，因為跨月搜尋、分析、備份、匯入去重
及信用卡對帳都依賴完整 entries 陣列。

## 原始金額與個人支出分離

分帳時允許將 `amount` 改成個人負擔，甚至設為 0；`originalAmount` 必須保留發票或
信用卡原始金額。對帳使用 `originalAmount`，統計則使用調整後的個人支出金額。這能
避免先編輯發票後，月底信用卡帳單無法配對。

## JSON 還原採合併策略

還原備份按 entry ID 去重並合併，避免舊備份覆蓋較新的雲端資料。完整取代或破壞性
清理必須另做明確操作、先備份並取得使用者確認。

## publishable key 可以存在前端

Supabase Project URL 與 `sb_publishable_...`
是設計給瀏覽器使用的公開設定，安全性 由 Auth、table grants 與 RLS 保證。任何
service-role key、secret key 和資料庫 密碼都不可加入前端。

## 測試模式與正式模式隔離

`?storage=file` 只在 `127.0.0.1` 啟用，使用 ignored 的私人狀態目錄。正式模式沒有
自動本機 fallback；雲端失敗時應停止資料操作並清楚提示，不能悄悄寫到另一份資料。
