import {
  createRequestHandler,
  storageStateFromBackup,
  validateStorageKey,
} from "../scripts/dev-server.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("本機測試伺服器：完整備份轉成分月 storage state", () => {
  const backup = {
    format: "expense-ledger-backup",
    version: 2,
    entries: [
      { id: "e1", date: "2026-07-31", amount: 10 },
      { id: "e2", date: "2026-08-01", amount: 20 },
      { id: "e3", date: "2026-08-02", amount: 30 },
    ],
    vendorAliases: ["a␟b"],
    importBatches: [{ id: "b1" }],
  };
  const state = storageStateFromBackup(
    backup,
    new Date("2026-08-28T00:00:00.000Z"),
  );
  assert(state.format === "expense-ledger-file-storage", "state 格式錯誤");
  assert(
    JSON.parse(state.values["expense-entries-2026-07"]).length === 1,
    "七月分組錯誤",
  );
  assert(
    JSON.parse(state.values["expense-entries-2026-08"]).length === 2,
    "八月分組錯誤",
  );
  assert(
    JSON.parse(state.values["vendor-aliases"]).length === 1,
    "店家別名轉換錯誤",
  );
});

Deno.test("本機測試伺服器：只接受帳本使用的固定 storage key", () => {
  assert(validateStorageKey("expense-entries-2026-08"), "月份 key 被拒絕");
  assert(validateStorageKey("vendor-aliases"), "別名 key 被拒絕");
  assert(
    validateStorageKey("ledger-migration-entries-v1"),
    "遷移標記 key 被拒絕",
  );
  assert(!validateStorageKey("../../secret"), "路徑穿越 key 未被拒絕");
  assert(!validateStorageKey("unrelated-data"), "任意 key 未被拒絕");
});

Deno.test("本機測試伺服器：API 支援 get/set/list/delete 且拒絕跨來源", async () => {
  const values = {};
  const store = {
    get(key) {
      return Object.hasOwn(values, key) ? { value: values[key] } : null;
    },
    list(prefix) {
      return {
        keys: Object.keys(values).filter((key) => key.startsWith(prefix)),
      };
    },
    set(key, value) {
      values[key] = value;
    },
    delete(key) {
      delete values[key];
    },
  };
  const handler = createRequestHandler(store);
  const origin = "http://127.0.0.1:8000";

  const scriptResponse = await handler(
    new Request(`${origin}/js/storage.js`, {
      headers: { Origin: origin },
    }),
  );
  assert(scriptResponse.status === 200, "拆分後的 JavaScript 無法提供");
  assert(
    scriptResponse.headers.get("Content-Type")?.startsWith("text/javascript"),
    "JavaScript Content-Type 錯誤",
  );
  const uiResponse = await handler(
    new Request(`${origin}/js/ui.js`, { headers: { Origin: origin } }),
  );
  assert(uiResponse.status === 200, "UI 模組無法由本機測試伺服器提供");

  const setResponse = await handler(
    new Request(`${origin}/api/storage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ key: "vendor-aliases", value: "[]" }),
    }),
  );
  assert(setResponse.status === 200, "set 失敗");

  const getResponse = await handler(
    new Request(`${origin}/api/storage?key=vendor-aliases`, {
      headers: { Origin: origin },
    }),
  );
  assert((await getResponse.json()).value === "[]", "get 結果錯誤");

  const listResponse = await handler(
    new Request(`${origin}/api/storage/list?prefix=vendor`, {
      headers: { Origin: origin },
    }),
  );
  assert((await listResponse.json()).keys.length === 1, "list 結果錯誤");

  const crossOriginResponse = await handler(
    new Request(`${origin}/api/storage?key=vendor-aliases`, {
      headers: { Origin: "https://example.com" },
    }),
  );
  assert(crossOriginResponse.status === 403, "跨來源請求未被拒絕");

  const deleteResponse = await handler(
    new Request(`${origin}/api/storage?key=vendor-aliases`, {
      method: "DELETE",
      headers: { Origin: origin },
    }),
  );
  assert(
    deleteResponse.status === 200 && !Object.hasOwn(values, "vendor-aliases"),
    "delete 失敗",
  );
});
