const PROJECT_ROOT = new URL("../", import.meta.url);
const INDEX_URL = new URL("index.html", PROJECT_ROOT);
const INVOICE_FIXTURES_URL = new URL(
  "test-fixtures/private/invoices/",
  PROJECT_ROOT,
);
const CREDIT_CARD_FIXTURES_URL = new URL(
  "test-fixtures/private/credit-card/",
  PROJECT_ROOT,
);
const RECONCILIATION_EXPECTATIONS_URL = new URL(
  "test-fixtures/private/reconciliation-expectations.json",
  PROJECT_ROOT,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listCsvFiles(directoryUrl) {
  const files = [];
  try {
    for await (const entry of Deno.readDir(directoryUrl)) {
      if (entry.isFile && entry.name.toLowerCase().endsWith(".csv")) {
        files.push({
          name: entry.name,
          url: new URL(entry.name, directoryUrl),
        });
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

function makeFakeElement() {
  const attributes = new Map();
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    appendChild() {},
    removeChild() {},
    replaceWith() {},
    focus() {},
    select() {},
    click() {},
    scrollIntoView() {},
    querySelector() {
      return makeFakeElement();
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
  };
}

function makeFakeDocument() {
  const elements = new Map();
  return {
    body: makeFakeElement(),
    createElement() {
      return makeFakeElement();
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeFakeElement());
      return elements.get(id);
    },
  };
}

async function loadLedgerApp() {
  const html = await Deno.readTextFile(INDEX_URL);
  const scriptPaths = [...html.matchAll(/<script src="([^"]+)"\s*><\/script>/g)]
    .map((match) => match[1]);
  assert(scriptPaths.length > 0, "index.html 裡找不到應用程式 JavaScript");
  let source = (
    await Promise.all(
      scriptPaths.map((path) => Deno.readTextFile(new URL(path, INDEX_URL))),
    )
  ).join("\n");
  const initMatch = source.match(/\(async function init\(\)\s*\{/);
  const initStart = initMatch ? initMatch.index : -1;
  assert(initStart !== -1, "找不到應用程式初始化區塊");
  const initEnd = source.indexOf("})();", initStart);
  assert(initEnd !== -1, "應用程式初始化區塊不完整");
  source = source.slice(0, initStart) + source.slice(initEnd + 5);
  source += `
    return {
      reset(){ entries=[]; vendorAliases=[]; importBatches=[]; knownMonthKeys=new Set(); },
      setEntries(value){ entries=value; dataLoaded=true; },
      getEntries(){ return entries; },
      getVendorAliases(){ return vendorAliases; },
      LedgerRepository,
      LocalStorageAdapter,
      STORAGE_KEYS,
      genericImportRows,
      validateBackupData,
      escapeAttribute,
      importOneInvoiceFile,
      importOneCreditCardFile,
      prepareImportPreview,
      reconcile,
      relationIntegrityIssues,
      qualityBuckets,
      getUnclassifiedNames,
      parseAiClassifyResult,
      applyAiClassificationPairs,
      autoReviewHighConfidenceCreditCards,
      learnVendorAlias,
      unmatchReconciliation
    };
  `;

  const storage = {
    get() {
      return null;
    },
    set() {},
    delete() {},
    list() {
      return { keys: [] };
    },
  };
  const fakeWindow = { storage };
  const fakeDocument = makeFakeDocument();
  const fakeNavigator = { clipboard: { async writeText() {} } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const factory = new AsyncFunction("window", "document", "navigator", source);
  return await factory(fakeWindow, fakeDocument, fakeNavigator);
}

function fixtureFile(fixture) {
  return {
    name: fixture.name,
    async text() {
      return await Deno.readTextFile(fixture.url);
    },
  };
}

function assertCommonEntryFields(entry, expectedSource, fixtureNumber) {
  const label = `${expectedSource} 測試檔 #${fixtureNumber}`;
  assert(entry && typeof entry === "object", `${label} 產生了非物件紀錄`);
  assert(
    typeof entry.id === "string" && entry.id.length > 1,
    `${label} 的紀錄缺少 id`,
  );
  assert(entry.source === expectedSource, `${label} 的 source 錯誤`);
  assert(Number.isFinite(entry.amount), `${label} 包含無效金額`);
  assert(Number.isFinite(entry.originalAmount), `${label} 包含無效原始金額`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), `${label} 包含無效日期`);
  assert(Number.isFinite(entry.ts), `${label} 包含無效時間戳記`);
  assert(typeof entry.category === "string", `${label} 的分類不是字串`);
}

async function fileExists(url) {
  try {
    return (await Deno.stat(url)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function hashText(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function currentReconciliationPairs(entries) {
  const invoiceNumbers = new Set(
    entries.filter((entry) => entry.source === "invoice" && entry.invoiceNo)
      .map((entry) => entry.invoiceNo),
  );
  const occurrenceCounts = new Map();
  const pairs = [];
  for (const entry of entries.filter((item) => item.source === "creditcard")) {
    const invoiceNo = entry.matchedId || entry.suggestedInvoiceNo;
    if (!invoiceNo || !invoiceNumbers.has(invoiceNo)) continue;
    const signature = [
      entry.bank || "",
      entry.date,
      Number(entry.amount).toFixed(2),
      entry.vendor || "",
    ].join("␟");
    const occurrence = (occurrenceCounts.get(signature) || 0) + 1;
    occurrenceCounts.set(signature, occurrence);
    const pairId = await hashText(
      signature + "␟" + occurrence + "␟" + invoiceNo,
    );
    pairs.push({
      pairId,
      type: entry.matchedId ? "automatic" : "suggested",
      entryId: entry.id,
      invoiceNo,
    });
  }
  return pairs;
}

const invoiceFixtures = await listCsvFiles(INVOICE_FIXTURES_URL);
const creditCardFixtures = await listCsvFiles(CREDIT_CARD_FIXTURES_URL);
const hasPrivateFixtures = invoiceFixtures.length > 0 ||
  creditCardFixtures.length > 0;
const hasReconciliationExpectations = await fileExists(
  RECONCILIATION_EXPECTATIONS_URL,
);

Deno.test("LedgerRepository：分月儲存、刪除空月份與舊版遷移", async () => {
  const app = await loadLedgerApp();
  function memoryStorage(initial = {}) {
    const values = { ...initial };
    return {
      values,
      failClosed: true,
      get(key) {
        return Object.hasOwn(values, key) ? { value: values[key] } : null;
      },
      set(key, value) {
        values[key] = value;
        return { ok: true };
      },
      delete(key) {
        delete values[key];
        return { ok: true };
      },
      list(prefix) {
        return {
          keys: Object.keys(values).filter((key) => key.startsWith(prefix)),
        };
      },
    };
  }

  const storage = memoryStorage();
  const repository = new app.LedgerRepository(storage);
  const sampleEntries = [
    { id: "e1", date: "2026-07-31" },
    { id: "e2", date: "2026-08-01" },
  ];
  let saved = await repository.saveEntries(sampleEntries, new Set());
  assert(saved.knownMonthKeys.size === 2, "分月儲存沒有記錄兩個月份");
  assert(
    Object.hasOwn(storage.values, "expense-entries-2026-07") &&
      Object.hasOwn(storage.values, "expense-entries-2026-08"),
    "分月 storage key 不完整",
  );
  saved = await repository.saveEntries(
    sampleEntries.filter((entry) => entry.id !== "e1"),
    saved.knownMonthKeys,
  );
  assert(
    !Object.hasOwn(storage.values, "expense-entries-2026-07") &&
      saved.knownMonthKeys.size === 1,
    "空月份沒有從 storage 移除",
  );

  const legacyStorage = memoryStorage({
    [app.STORAGE_KEYS.legacyEntries]: JSON.stringify(sampleEntries),
  });
  const legacyRepository = new app.LedgerRepository(legacyStorage);
  const migrated = await legacyRepository.loadEntries();
  assert(migrated.entries.length === 2, "舊版資料遷移後筆數錯誤");
  assert(
    !Object.hasOwn(legacyStorage.values, app.STORAGE_KEYS.legacyEntries),
    "舊版 key 在成功遷移後未刪除",
  );
  assert(
    Object.hasOwn(legacyStorage.values, "expense-entries-2026-07") &&
      Object.hasOwn(legacyStorage.values, "expense-entries-2026-08"),
    "舊版資料未正確拆成月份 key",
  );

  const cleanupFailureStorage = memoryStorage({
    [app.STORAGE_KEYS.legacyEntries]: JSON.stringify(sampleEntries),
  });
  const originalDelete = cleanupFailureStorage.delete;
  cleanupFailureStorage.delete = (key) => {
    if (key === app.STORAGE_KEYS.legacyEntries) {
      throw new Error("simulated cleanup failure");
    }
    return originalDelete(key);
  };
  const cleanupFailureRepository = new app.LedgerRepository(
    cleanupFailureStorage,
  );
  const firstLoad = await cleanupFailureRepository.loadEntries();
  assert(firstLoad.migrationCleanupFailed, "舊版 key 清理失敗沒有被回報");
  assert(
    Object.hasOwn(
      cleanupFailureStorage.values,
      app.STORAGE_KEYS.legacyMigration,
    ),
    "清理舊 key 前沒有寫入遷移完成標記",
  );

  const newerEntries = [
    { id: "e2", date: "2026-08-01", note: "newer" },
    { id: "e3", date: "2026-08-02" },
  ];
  await cleanupFailureRepository.saveEntries(
    newerEntries,
    firstLoad.knownMonthKeys,
  );
  const secondLoad = await cleanupFailureRepository.loadEntries();
  assert(
    secondLoad.entries.length === 2 &&
      !secondLoad.entries.some((entry) => entry.id === "e1") &&
      secondLoad.entries.some((entry) => entry.note === "newer"),
    "清理失敗後，舊資料覆蓋或復活了新版月份資料",
  );

  const partiallyMigratedStorage = memoryStorage({
    [app.STORAGE_KEYS.legacyEntries]: JSON.stringify(sampleEntries),
    "expense-entries-2026-08": JSON.stringify([
      { id: "e2", date: "2026-08-01", note: "monthly-wins" },
      { id: "e3", date: "2026-08-02" },
    ]),
  });
  const partialLoad = await new app.LedgerRepository(partiallyMigratedStorage)
    .loadEntries();
  assert(
    partialLoad.entries.length === 3 &&
      partialLoad.entries.some((entry) => entry.id === "e1") &&
      partialLoad.entries.some((entry) => entry.note === "monthly-wins"),
    "部分遷移時沒有保留新版月份並補回缺少月份",
  );
});

Deno.test("瀏覽器儲存：localStorage adapter 相容且寫入失敗會向上回報", async () => {
  const app = await loadLedgerApp();
  const values = new Map();
  const localStorage = {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const adapter = new app.LocalStorageAdapter(localStorage);
  adapter.set("expense-entries-2026-08", "[]");
  assert(
    adapter.get("expense-entries-2026-08").value === "[]" &&
      adapter.list("expense-entries-").keys.length === 1,
    "localStorage adapter 的 get/set/list 不相容",
  );
  adapter.delete("expense-entries-2026-08");
  assert(
    adapter.get("expense-entries-2026-08") === null,
    "localStorage adapter 刪除失敗",
  );

  const failingStorage = {
    get() {
      return null;
    },
    list() {
      return { keys: [] };
    },
    set() {
      throw new Error("quota exceeded");
    },
    delete() {},
  };
  let failed = false;
  try {
    await new app.LedgerRepository(failingStorage).saveEntries(
      [{ id: "e1", date: "2026-08-01" }],
      new Set(),
    );
  } catch (_) {
    failed = true;
  }
  assert(failed, "儲存失敗仍被 repository 當成成功");
});

Deno.test("信用卡去重：相同交易在不同銀行不得互相略過", async () => {
  const app = await loadLedgerApp();
  app.setEntries([{
    id: "bank-a",
    source: "creditcard",
    date: "2026-08-01",
    ts: new Date("2026-08-01T00:00:00").getTime(),
    amount: 100,
    vendor: "同一商店",
    bank: "銀行 A",
    category: "其他",
  }]);
  const rows = [
    ["日期", "金額", "店家"],
    ["2026-08-01", "100", "同一商店"],
  ];
  const otherBank = app.genericImportRows(rows, "creditcard", "銀行 B");
  assert(
    otherBank.added === 1 && otherBank.skipped === 0,
    "不同銀行被誤判為重複交易",
  );
  const sameBank = app.genericImportRows(rows, "creditcard", "銀行 B");
  assert(
    sameBank.added === 0 && sameBank.skipped === 1,
    "同銀行重新匯入沒有被略過",
  );
});

Deno.test("備份驗證與屬性跳脫：拒絕壞資料並安全處理 ID", async () => {
  const app = await loadLedgerApp();
  const validEntry = {
    id: "e1",
    source: "cash",
    amount: 100,
    category: "餐飲",
    date: "2026-08-01",
    ts: new Date("2026-08-01T12:00:00").getTime(),
  };
  app.validateBackupData({ entries: [validEntry] });

  let rejected = false;
  try {
    app.validateBackupData({
      entries: [{ ...validEntry, date: "2026-02-30" }],
    });
  } catch (_) {
    rejected = true;
  }
  assert(rejected, "不合法日期沒有被備份驗證拒絕");

  const escaped = app.escapeAttribute('x" onmouseover="alert(1)');
  assert(
    !escaped.includes('"') && escaped.includes("&quot;"),
    "HTML 屬性值沒有安全跳脫",
  );
});

Deno.test("分類審核：AI 確認為其他後不再列入未分類", async () => {
  const app = await loadLedgerApp();
  app.setEntries([
    {
      id: "other-reviewed",
      source: "invoice",
      note: "刻意保留其他",
      category: "其他",
    },
    {
      id: "food-reviewed",
      source: "invoice",
      note: "便當",
      category: "其他",
    },
    {
      id: "still-pending",
      source: "invoice",
      note: "仍待判定",
      category: "其他",
    },
    {
      id: "legacy-manual",
      source: "invoice",
      note: "舊備份手動其他",
      category: "其他",
      categoryManual: true,
    },
  ]);

  const result = app.applyAiClassificationPairs([
    { keyword: "刻意保留其他", category: "其他" },
    { keyword: "便當", category: "餐飲" },
  ]);
  const entries = app.getEntries();
  const reviewedOther = entries.find((entry) => entry.id === "other-reviewed");
  const reviewedFood = entries.find((entry) => entry.id === "food-reviewed");

  assert(result.applied === 2, "AI 結果沒有套用到兩筆紀錄");
  assert(result.changed === 1, "只有餐飲分類應改變原分類值");
  assert(
    reviewedOther.category === "其他" &&
      reviewedOther.categoryReviewed === true,
    "確認為其他的紀錄沒有保存 categoryReviewed",
  );
  assert(
    reviewedFood.category === "餐飲" && reviewedFood.categoryReviewed === true,
    "AI 明確分類沒有保存 categoryReviewed",
  );
  assert(
    JSON.stringify(app.getUnclassifiedNames()) === JSON.stringify(["仍待判定"]),
    "待分類清單沒有正確排除已審核與舊版手動分類",
  );
  assert(
    app.qualityBuckets().unclassified.length === 1,
    "資料品質篩選的未分類數量錯誤",
  );
});

Deno.test("AI 分類解析：品名內含逗號與冒號時使用最右側分類", async () => {
  const app = await loadLedgerApp();
  app.reset();
  const input = [
    "---",
    "1號餐:涼拌青木瓜(大）+湯．牛肉河粉+蜂蜜檸檬,餐飲\\",
    "Kinyo 快煮壺, KIHP-1157,日用\\",
    "POLYWELL 寶利威爾 Type-C磁吸無線手錶充電盤 + 編織線 PW15-T65-0640, Apple Watch, 白色, 1條,日用\\",
    "招牌雙雞:不需加購(A套餐)+不需加購(B套餐)+全麥麵+糙米+無+無+無特別需求(醬),餐飲\\",
    "每朝健康 雙纖綠茶, 650ml, 48瓶,飲料\\",
    "鹽麴雞排炒麵-+麵:不加購,餐飲",
  ].join("\n");
  const expected = [
    ["1號餐:涼拌青木瓜(大）+湯．牛肉河粉+蜂蜜檸檬", "餐飲"],
    ["Kinyo 快煮壺, KIHP-1157", "日用"],
    [
      "POLYWELL 寶利威爾 Type-C磁吸無線手錶充電盤 + 編織線 PW15-T65-0640, Apple Watch, 白色, 1條",
      "日用",
    ],
    [
      "招牌雙雞:不需加購(A套餐)+不需加購(B套餐)+全麥麵+糙米+無+無+無特別需求(醬)",
      "餐飲",
    ],
    ["每朝健康 雙纖綠茶, 650ml, 48瓶", "飲料"],
    ["鹽麴雞排炒麵-+麵:不加購", "餐飲"],
  ];

  const pairs = app.parseAiClassifyResult(input);
  assert(
    pairs.length === expected.length,
    `預期解析 ${expected.length} 筆，實際 ${pairs.length} 筆`,
  );
  assert(
    JSON.stringify(pairs.map((pair) => [pair.keyword, pair.category])) ===
      JSON.stringify(expected),
    "含逗號或冒號的完整品名被截斷",
  );

  app.setEntries(expected.map(([name], index) => ({
    id: `complex-name-${index}`,
    source: "invoice",
    note: name,
    category: "其他",
  })));
  const result = app.applyAiClassificationPairs(pairs);
  assert(
    result.applied === expected.length,
    "解析後的分類沒有套用到所有完整品名",
  );
});

Deno.test({
  name: "匯入預覽：解析後不會修改現有帳本",
  ignore: !hasPrivateFixtures,
  async fn() {
    const app = await loadLedgerApp();
    app.reset();
    const original = [{
      id: "existing-entry",
      amount: 120,
      originalAmount: 120,
      category: "餐飲",
      note: "既有資料",
      originalNote: "既有資料",
      date: "2026-08-01",
      ts: new Date("2026-08-01T12:00:00").getTime(),
      source: "cash",
      vendor: "",
      originalVendor: "",
      bank: "",
      originalBank: "",
      matchedId: null,
      reviewed: true,
      categoryReviewed: true,
    }];
    app.setEntries(structuredClone(original));

    const preview = await app.prepareImportPreview(
      "invoice",
      [fixtureFile(invoiceFixtures[0])],
      "",
    );

    assert(preview.fileCount === 1, "預覽沒有保留所選檔案數量");
    assert(preview.totals.added > 0, "預覽沒有解析出可匯入資料");
    assert(
      JSON.stringify(app.getEntries()) === JSON.stringify(original),
      "產生匯入預覽後，現有帳本內容被修改",
    );
  },
});

Deno.test({
  name: "真實測試資料：每個發票 CSV 都可由現有匯入器解析",
  ignore: invoiceFixtures.length === 0,
  async fn() {
    const app = await loadLedgerApp();
    for (let i = 0; i < invoiceFixtures.length; i++) {
      app.reset();
      const result = await app.importOneInvoiceFile(
        fixtureFile(invoiceFixtures[i]),
      );
      assert(!result.unrecognized, `發票測試檔 #${i + 1} 無法辨識欄位`);
      assert(!result.empty, `發票測試檔 #${i + 1} 被判定為空檔`);
      assert(result.added > 0, `發票測試檔 #${i + 1} 沒有匯入任何紀錄`);
      const entries = app.getEntries();
      assert(
        entries.length === result.added,
        `發票測試檔 #${i + 1} 的新增數與實際紀錄數不符`,
      );
      entries.forEach((entry) => {
        assertCommonEntryFields(entry, "invoice", i + 1);
        assert(
          typeof entry.invoiceNo === "string" && entry.invoiceNo.length > 0,
          `發票測試檔 #${i + 1} 缺少發票號碼`,
        );
      });
      assert(
        new Set(entries.map((entry) => entry.id)).size === entries.length,
        `發票測試檔 #${i + 1} 產生重複 id`,
      );
    }
  },
});

Deno.test({
  name: "真實測試資料：人工確認的對帳結果維持不變",
  ignore: !hasPrivateFixtures || !hasReconciliationExpectations,
  async fn() {
    const expectationsDocument = JSON.parse(
      await Deno.readTextFile(RECONCILIATION_EXPECTATIONS_URL),
    );
    assert(
      expectationsDocument?.format ===
        "expense-ledger-reconciliation-expectations",
      "對帳期望檔格式不符",
    );
    const expectations = new Map(
      expectationsDocument.expectations.map((item) => [item.pairId, item]),
    );

    const app = await loadLedgerApp();
    app.reset();
    for (const fixture of invoiceFixtures) {
      await app.importOneInvoiceFile(fixtureFile(fixture));
    }
    for (const fixture of creditCardFixtures) {
      await app.importOneCreditCardFile(fixtureFile(fixture), "");
    }
    app.reconcile();
    const currentPairs = await currentReconciliationPairs(app.getEntries());
    const currentById = new Map(
      currentPairs.map((pair) => [pair.pairId, pair]),
    );

    for (const expected of expectations.values()) {
      const current = currentById.get(expected.pairId);
      if (expected.decision === "correct") {
        assert(current, `已確認正確的配對消失：${expected.pairId}`);
      } else if (expected.decision === "wrong" && current) {
        assert(
          current.type !== "automatic",
          `已知錯誤配對被升級成自動合併：${expected.pairId}`,
        );
      }
    }
    for (const current of currentPairs) {
      assert(
        expectations.has(current.pairId),
        `出現尚未人工審核的新配對：${current.pairId}`,
      );
    }

    const correctPresent = [...expectations.values()].filter((item) =>
      item.decision === "correct" && currentById.has(item.pairId)
    ).length;
    const knownWrongStillSuggested = [...expectations.values()].filter((item) =>
      item.decision === "wrong" &&
      currentById.get(item.pairId)?.type === "suggested"
    ).length;
    console.log(JSON.stringify({
      expectedCorrectPairs: correctPresent,
      knownWrongStillSuggested,
      currentPairs: currentPairs.length,
    }));
  },
});

Deno.test({
  name: "真實測試資料：高信心信用卡自動確認且拒絕配對不再出現",
  ignore: !hasPrivateFixtures || !hasReconciliationExpectations,
  async fn() {
    const expectationsDocument = JSON.parse(
      await Deno.readTextFile(RECONCILIATION_EXPECTATIONS_URL),
    );
    const knownWrong = expectationsDocument.expectations.find((item) =>
      item.decision === "wrong"
    );
    assert(knownWrong, "對帳期望中找不到已知錯誤配對");

    const app = await loadLedgerApp();
    app.reset();
    for (const fixture of invoiceFixtures) {
      await app.importOneInvoiceFile(fixtureFile(fixture));
    }
    for (const fixture of creditCardFixtures) {
      await app.importOneCreditCardFile(fixtureFile(fixture), "");
    }
    app.reconcile();

    const entries = app.getEntries();
    const creditCardIds = entries.filter((entry) =>
      entry.source === "creditcard"
    ).map((entry) => entry.id);
    const autoReviewed = app.autoReviewHighConfidenceCreditCards(creditCardIds);
    const pending = entries.filter((entry) =>
      entry.source === "creditcard" && !entry.matchedId && !entry.reviewed
    );
    assert(autoReviewed > 0, "沒有任何完整且無配對疑慮的信用卡被自動確認");
    assert(
      pending.every((entry) =>
        entry.suggestedInvoiceNo || !(entry.vendor || "").trim() ||
        !(entry.bank || "").trim()
      ),
      "仍有高信心信用卡留在待確認清單",
    );

    const currentPairs = await currentReconciliationPairs(entries);
    const wrongPair = currentPairs.find((pair) =>
      pair.pairId === knownWrong.pairId
    );
    assert(wrongPair?.type === "suggested", "已知錯誤配對目前不是建議配對");
    const card = entries.find((entry) => entry.id === wrongPair.entryId);
    assert(card, "找不到已知錯誤配對的信用卡紀錄");
    const invoiceItems = entries.filter((entry) =>
      entry.source === "invoice" && entry.invoiceNo === wrongPair.invoiceNo
    );
    assert(invoiceItems.length > 0, "找不到已知錯誤配對的發票品項");
    invoiceItems.forEach((entry) => entry.matchedId = card.id);
    card.matchedId = wrongPair.invoiceNo;
    card.suggestedInvoiceNo = null;
    card.reviewed = true;
    app.learnVendorAlias(card.vendor, invoiceItems[0].vendor);
    assert(app.getVendorAliases().length === 1, "測試用錯誤店家別名未建立");
    const unmatchResult = app.unmatchReconciliation(
      card.id,
      wrongPair.invoiceNo,
    );
    assert(unmatchResult, "解除配對失敗");
    assert(app.getVendorAliases().length === 0, "解除配對後仍保留錯誤店家別名");
    assert(
      invoiceItems.every((entry) => entry.matchedId === null) &&
        card.matchedId === null &&
        card.rejectedInvoiceNos.includes(wrongPair.invoiceNo),
      "解除配對沒有完整清除雙向關聯或保存拒絕記憶",
    );
    app.reconcile();
    assert(
      card.suggestedInvoiceNo === null && card.reviewed === true,
      "已拒絕的配對在再次對帳後重新出現",
    );

    console.log(JSON.stringify({ autoReviewed, pending: pending.length }));
  },
});

Deno.test({
  name: "真實測試資料：每個信用卡 CSV 都可由現有匯入器解析",
  ignore: creditCardFixtures.length === 0,
  async fn() {
    const app = await loadLedgerApp();
    for (let i = 0; i < creditCardFixtures.length; i++) {
      app.reset();
      const result = await app.importOneCreditCardFile(
        fixtureFile(creditCardFixtures[i]),
        "",
      );
      assert(!result.unrecognized, `信用卡測試檔 #${i + 1} 無法辨識欄位`);
      assert(!result.empty, `信用卡測試檔 #${i + 1} 被判定為空檔`);
      assert(result.added > 0, `信用卡測試檔 #${i + 1} 沒有匯入任何紀錄`);
      assert(
        result.unparseable === 0,
        `信用卡測試檔 #${i + 1} 含有無法解析的日期`,
      );
      const entries = app.getEntries();
      assert(
        entries.length === result.added,
        `信用卡測試檔 #${i + 1} 的新增數與實際紀錄數不符`,
      );
      entries.forEach((entry) =>
        assertCommonEntryFields(entry, "creditcard", i + 1)
      );
      assert(
        new Set(entries.map((entry) => entry.id)).size === entries.length,
        `信用卡測試檔 #${i + 1} 產生重複 id`,
      );
    }
  },
});

Deno.test({
  name: "真實測試資料：重複匯入不會增加第二份紀錄",
  ignore: !hasPrivateFixtures,
  async fn() {
    const app = await loadLedgerApp();
    app.reset();

    for (const fixture of invoiceFixtures) {
      await app.importOneInvoiceFile(fixtureFile(fixture));
    }
    for (const fixture of creditCardFixtures) {
      await app.importOneCreditCardFile(fixtureFile(fixture), "");
    }
    const countAfterFirstImport = app.getEntries().length;
    assert(countAfterFirstImport > 0, "第一次匯入後沒有任何紀錄");

    let addedOnSecondImport = 0;
    for (const fixture of invoiceFixtures) {
      const result = await app.importOneInvoiceFile(fixtureFile(fixture));
      addedOnSecondImport += result.added || 0;
    }
    for (const fixture of creditCardFixtures) {
      const result = await app.importOneCreditCardFile(
        fixtureFile(fixture),
        "",
      );
      addedOnSecondImport += result.added || 0;
    }

    assert(
      addedOnSecondImport === 0,
      `第二次匯入意外新增 ${addedOnSecondImport} 筆紀錄`,
    );
    assert(
      app.getEntries().length === countAfterFirstImport,
      "第二次匯入後總紀錄數發生變化",
    );
  },
});

Deno.test({
  name: "真實測試資料：合併匯入、對帳與關聯完整性",
  ignore: !hasPrivateFixtures,
  async fn() {
    const app = await loadLedgerApp();
    app.reset();
    const totals = {
      invoiceAdded: 0,
      creditCardAdded: 0,
      duplicatesSkipped: 0,
      unparseable: 0,
    };

    for (const fixture of invoiceFixtures) {
      const result = await app.importOneInvoiceFile(fixtureFile(fixture));
      totals.invoiceAdded += result.added || 0;
      totals.duplicatesSkipped += result.skipped || 0;
      totals.unparseable += result.unparseable || 0;
    }
    for (const fixture of creditCardFixtures) {
      const result = await app.importOneCreditCardFile(
        fixtureFile(fixture),
        "",
      );
      totals.creditCardAdded += result.added || 0;
      totals.duplicatesSkipped += result.skipped || 0;
      totals.unparseable += result.unparseable || 0;
    }

    const automaticMatches = app.reconcile();
    const entries = app.getEntries();
    const suggestedMatches = entries.filter((entry) =>
      entry.source === "creditcard" && entry.suggestedInvoiceNo
    ).length;
    const integrityIssues = app.relationIntegrityIssues();

    assert(
      totals.unparseable === 0,
      `合併匯入共有 ${totals.unparseable} 筆日期無法解析`,
    );
    assert(
      integrityIssues.length === 0,
      `對帳後出現 ${integrityIssues.length} 筆無效關聯`,
    );
    assert(
      new Set(entries.map((entry) =>
        entry.id
      )).size === entries.length,
      "合併匯入後出現重複 id",
    );

    console.log(JSON.stringify({
      fixtureCounts: {
        invoices: invoiceFixtures.length,
        creditCards: creditCardFixtures.length,
      },
      ...totals,
      totalEntries: entries.length,
      automaticMatches,
      suggestedMatches,
      integrityIssues: integrityIssues.length,
    }));
  },
});
